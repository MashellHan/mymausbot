"""Validate and atomically publish one generation of remote contribution sources."""

from contextlib import contextmanager
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import stat
import tempfile
import urllib.parse
from zoneinfo import ZoneInfo

MAX_BYTES = 32 * 1024 * 1024
MAX_SOURCES = 32
MAX_REPOSITORY_ROWS = 100_000
STATUS = {"ready", "partial", "stale", "unavailable"}
CATEGORY = {"work", "personal", "unclassified"}
DEFINITIONS = {"github": ("github-profile-beijing-v1", {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"}),
               "ado": ("ado-default-head-beijing-v1", {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"})}
LEGACY_DEFINITIONS = {"github": ("github-profile-v2", {"prs": "github-profile-day", "commits": "github-profile-day"}),
                      "ado": ("ado-default-head-v1", {"prs": "created-at/UTC", "commits": "author-at/UTC"})}
TZ = ZoneInfo("Asia/Shanghai")


def obj(value):
    if not isinstance(value, dict):
        raise ValueError("Invalid contribution object")
    return value


def word(value, size=256):
    if not isinstance(value, str) or not value or len(value) > size or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Invalid contribution text")
    return value


def number(value):
    if type(value) is not int or not 0 <= value <= 2**53 - 1:
        raise ValueError("Invalid contribution count")
    return value


def optional_number(value):
    return None if value is None else number(value)


def instant(value):
    word(value, 40)
    if not value.endswith("Z"):
        raise ValueError("Contribution instant must be UTC")
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("Invalid contribution instant") from None
    if result.utcoffset() != dt.timedelta():
        raise ValueError("Contribution instant must be UTC")
    return result


def day(value):
    word(value, 10)
    try:
        result = dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError("Invalid contribution day") from None
    if result.isoformat() != value:
        raise ValueError("Invalid contribution day")
    return result


def counts(row):
    values = {key: optional_number(row.get(key)) for key in ("prs", "knownPrs", "commits", "knownCommits")}
    for metric, subtotal in (("prs", "knownPrs"), ("commits", "knownCommits")):
        if values[metric] is not None and values[metric] != values[subtotal]:
            raise ValueError("Exact contribution differs from subtotal")
    return values


def envelope(raw, provider, legacy=False):
    raw = obj(raw)
    definition, basis = (LEGACY_DEFINITIONS if legacy else DEFINITIONS)[provider]
    if (raw.get("version") != 2 or raw.get("provider") != provider or raw.get("metricDefinition") != definition
            or raw.get("dateBasis") != basis):
        raise ValueError("Invalid contribution definition")
    cutoff, captured = instant(raw.get("asOfAt")), instant(raw.get("capturedAt"))
    if cutoff > captured:
        raise ValueError("Capture precedes cutoff")
    window = obj(raw.get("operationWindow"))
    first, last = day(window.get("startDay")), day(window.get("endDay"))
    if last - first != dt.timedelta(days=59) or window.get("todayPartial") is not True:
        raise ValueError("Invalid 60-day contribution window")
    if not legacy and last != cutoff.astimezone(TZ).date():
        raise ValueError("Contribution window does not match cutoff date basis")
    collection = obj(raw.get("collection"))
    if (type(collection.get("complete")) is not bool or type(collection.get("requestCount")) is not int
            or number(collection["requestCount"]) < 0 or type(collection.get("elapsedSeconds")) not in (int, float)
            or not 0 <= collection["elapsedSeconds"] < float("inf")):
        raise ValueError("Invalid contribution collection status")
    reasons = collection.get("reasons")
    if not isinstance(reasons, list) or len(reasons) > 32 or any(not isinstance(item, str) or not item or len(item) > 256 or
            any(ord(char) < 32 or ord(char) == 127 for char in item) for item in reasons):
        raise ValueError("Invalid contribution reasons")
    if "rateLimit" in collection:
        obj(collection["rateLimit"])
    sources, ids = raw.get("sources"), raw.get("activeSourceIds")
    if (not isinstance(sources, list) or len(sources) > MAX_SOURCES or not isinstance(ids, list)
            or len(ids) != len(sources) or len(set(map(word, ids))) != len(ids)):
        raise ValueError("Invalid contribution source set")
    found, accounts, repository_rows = set(), set(), 0
    for source in sources:
        source = obj(source)
        source_id = word(source.get("id"))
        if source_id in found or source_id not in ids or source.get("status") not in STATUS:
            raise ValueError("Contribution source identity or status mismatch")
        found.add(source_id)
        account = obj(source.get("account"))
        host, stable_id = word(account.get("host"), 128), word(account.get("stableId"))
        word(account.get("login"), 128)
        scope = source.get("scope")
        if provider == "ado" and scope is None:
            raise ValueError("ADO source scope is required")
        if scope is not None:
            scope = obj(scope)
            word(scope.get("organization"), 128)
            word(scope.get("project"), 128)
        account_key = (host.casefold(), stable_id.casefold() if provider == "ado" else stable_id,
                       scope["organization"].casefold() if scope else None,
                       scope["project"].casefold() if scope else None)
        if account_key in accounts:
            raise ValueError("Duplicate contribution account scope")
        accounts.add(account_key)
        coverage = obj(source.get("coverage"))
        if any(type(coverage.get(key)) is not bool for key in ("identityVerified", "paginationComplete", "visibilityComplete")):
            raise ValueError("Invalid contribution coverage")
        if source["status"] == "ready" and not all(coverage[key] for key in ("identityVerified", "paginationComplete", "visibilityComplete")):
            raise ValueError("Ready contribution source lacks verified coverage")
        reasons = coverage.get("reasons")
        if not isinstance(reasons, list) or len(reasons) > 32 or any(not isinstance(item, str) or not item or len(item) > 256 or
                any(ord(char) < 32 or ord(char) == 127 for char in item) for item in reasons):
            raise ValueError("Invalid contribution coverage reasons")
        days = source.get("days")
        if not isinstance(days, list) or len(days) > 60 or source["status"] == "ready" and len(days) != 60:
            raise ValueError("Invalid contribution day coverage")
        seen_days = set()
        for row in days:
            row = obj(row)
            date = day(row.get("day"))
            if date in seen_days or not first <= date <= last or instant(row.get("capturedAt")) > captured or row.get("status") not in STATUS:
                raise ValueError("Invalid contribution day")
            seen_days.add(date)
            totals = counts(row)
            if row["status"] == "ready" and (totals["prs"] is None or totals["commits"] is None):
                raise ValueError("Ready contribution day lacks exact counts")
            repos = row.get("repositories")
            if not isinstance(repos, list) or len(repos) > 5000:
                raise ValueError("Invalid contribution repositories")
            repository_rows += len(repos)
            seen_repos, subtotals = set(), {"knownPrs": 0, "knownCommits": 0}
            for repo in repos:
                repo = obj(repo)
                repo_id = word(repo.get("id"))
                if repo_id in seen_repos or repo.get("category") not in CATEGORY or repo.get("status") not in STATUS:
                    raise ValueError("Invalid repository identity or coverage")
                seen_repos.add(repo_id)
                word(repo.get("name"), 512)
                repo_counts = counts(repo)
                if repo["status"] == "ready" and (repo_counts["prs"] is None or repo_counts["commits"] is None):
                    raise ValueError("Ready repository lacks exact counts")
                for key in subtotals:
                    subtotals[key] += repo_counts[key] or 0
                if "provenance" in repo:
                    obj(repo["provenance"])
            for key, subtotal in subtotals.items():
                if subtotal and (totals[key] is None or subtotal > totals[key]):
                    raise ValueError("Repository subtotal exceeds source day")
        if "provenance" in source:
            obj(source["provenance"])
    if found != set(ids) or repository_rows > MAX_REPOSITORY_ROWS:
        raise ValueError("Contribution source set or size mismatch")
    if "state" in raw:
        obj(raw["state"])
    return raw


def snapshot(value, legacy=False):
    value = obj(value)
    if value.get("version") != 2:
        raise ValueError("Invalid contribution snapshot version")
    github, ado = envelope(value.get("github"), "github", legacy), envelope(value.get("ado"), "ado", legacy)
    if github["operationWindow"] != ado["operationWindow"]:
        raise ValueError("Contribution source windows do not align")
    return value


def _bindings(value, config):
    profiles = config.get("githubProfiles")
    if not isinstance(profiles, list) or not profiles:
        raise ValueError("Configured Profile source set is missing")
    expected_github = {(word(row["host"], 128).casefold(), word(row["login"], 128).casefold(), word(row["stableId"]))
                       for row in profiles}
    observed_github = {(row["account"]["host"].casefold(), row["account"]["login"].casefold(), row["account"]["stableId"])
                       for row in value["github"]["sources"]}
    if (len(expected_github) != len(profiles) or len(observed_github) != len(value["github"]["sources"])
            or observed_github != expected_github):
        raise ValueError("Profile snapshot omits or changes a configured account")
    projects = set()
    for raw in config.get("mergedAdoProjects", []) + config.get("adoRemotes", []):
        parsed = urllib.parse.urlsplit(raw)
        parts = parsed.path.strip("/").split("/")
        if parsed.scheme != "https" or parsed.hostname != "dev.azure.com" or len(parts) not in (2, 4):
            raise ValueError("Invalid configured ADO scope")
        projects.add((urllib.parse.unquote(parts[0]).casefold(), urllib.parse.unquote(parts[1]).casefold()))
    principals = config.get("adoPrincipals")
    if not projects or not isinstance(principals, dict):
        raise ValueError("Verified ADO scope is missing")
    expected_ado = {(org, project, principals[org]["stableId"].casefold(), principals[org]["alias"].casefold())
                    for org, project in projects}
    observed_ado = {(row["scope"]["organization"].casefold(), row["scope"]["project"].casefold(),
                     row["account"]["stableId"].casefold(), row["account"]["login"].casefold())
                    for row in value["ado"]["sources"]}
    if len(observed_ado) != len(value["ado"]["sources"]) or observed_ado != expected_ado:
        raise ValueError("ADO snapshot omits or changes a configured project")
    return value


def validate_bindings(value, config):
    return _bindings(snapshot(value), config)


def validate_seed_bindings(value, config):
    if not isinstance(value, dict):
        raise ValueError("Read-only contribution seed is missing")
    legacy = value.get("ado", {}).get("metricDefinition") == "ado-default-head-v1"
    checked = _bindings(snapshot(value, legacy=legacy), config)
    state = checked["ado"].get("state")
    if not isinstance(state, dict) or state.get("schema") != 3 or not isinstance(state.get("projects"), dict):
        raise ValueError("Read-only ADO raw continuation is unavailable")
    return checked


@contextmanager
def target_lock(file):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = file.with_suffix(".lock")
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Contribution writer lock is not a regular file")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        # A persistent inode prevents concurrent writers from locking different files.
        os.close(fd)


def load_previous(file):
    file = Path(file)
    try:
        file.lstat()
    except FileNotFoundError:
        return None
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > MAX_BYTES):
            raise ValueError("Existing contribution cache is unsafe")
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Existing contribution cache exceeds limit")
    value = json.loads(data)
    try:
        return snapshot(value)
    except ValueError:
        return snapshot(value, legacy=True)


def write_private(file, value):
    file = Path(file)
    if file.is_symlink():
        raise ValueError("Contribution target is a symlink")
    value = snapshot(value)
    data = (json.dumps(value, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
    if len(data) > MAX_BYTES:
        raise ValueError("Contribution cache exceeds 32 MiB")
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=file.name + ".", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, file)
        directory = os.open(file.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
