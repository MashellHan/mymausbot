"""Read the authenticated account's GitHub contribution source, without local Git fallback."""

import datetime as dt
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.parse
from zoneinfo import ZoneInfo

from local_usage_merged import previous_snapshot, write_private

DEFINITION = "github-profile-v1"
TZ = ZoneInfo("Asia/Shanghai")
MAX_PROFILES = 24
MAX_PAGES = 10
MAX_REPOSITORIES = 100
DATE_BASIS = {"prs": "created-at/Asia-Shanghai", "commits": "github-profile-day"}

QUERY = """query($from: DateTime!, $to: DateTime!, $after: String) {
  viewer {
    id login url
    contributionsCollection(from: $from, to: $to) {
      startedAt endedAt hasAnyRestrictedContributions restrictedContributionsCount
      totalCommitContributions totalRepositoriesWithContributedCommits
      totalPullRequestContributions(excludeFirst: false, excludePopular: false)
      commitContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner isFork isPrivate defaultBranchRef { name } }
        contributions(first: 100) {
          totalCount pageInfo { hasNextPage }
          nodes { occurredAt commitCount }
        }
      }
      pullRequestContributions(first: 100, after: $after, excludeFirst: false, excludePopular: false) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { occurredAt pullRequest { id createdAt author { login } repository { id nameWithOwner isFork isPrivate } } }
      }
    }
  }
}"""


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("Invalid contribution instant")
    value = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise ValueError("Contribution instant requires an offset")
    return value.astimezone(dt.timezone.utc)


def stamp(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def count(value):
    if type(value) is not int or value < 0 or value > 2**53 - 1:
        raise ValueError("Invalid contribution count")
    return value


def digest(*values):
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


def capture_window(at):
    if at.tzinfo is None:
        raise ValueError("Capture time requires an offset")
    end = at.astimezone(TZ).date()
    return end - dt.timedelta(days=6), end


def profile_identity(profile):
    host = profile["host"].lower()
    login = profile["login"]
    if (host != "github.com" and not re.fullmatch(r"[a-z0-9-]+\.ghe\.com", host)
            or not isinstance(login, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", login)):
        raise ValueError("Invalid configured contribution account")
    return digest(DEFINITION, host, login.casefold())


def query(config, profile, start, end, after, run):
    args = [sys.executable, config["githubHelper"], "gh", profile["profile"], "api", "graphql",
            "-f", "query=" + QUERY, "-f", "from=" + stamp(start), "-f", "to=" + stamp(end)]
    if after is not None:
        args += ["-f", "after=" + after]
    data = json.loads(run(args, timeout=30))
    if not isinstance(data, dict) or data.get("errors"):
        raise ValueError("Incomplete contribution API response")
    viewer = data["data"]["viewer"]
    if (viewer["login"].casefold() != profile["login"].casefold() or not viewer["id"]
            or urllib.parse.urlsplit(viewer["url"]).hostname != profile["host"].lower()):
        raise ValueError("Contribution account mismatch")
    return viewer


def collect_profile(config, profile, start, end, run, repository_category):
    profile_identity(profile)
    commits, prs, cursor, seen_cursors, baseline = [], {}, None, set(), None
    for _ in range(MAX_PAGES):
        viewer = query(config, profile, start, end, cursor, run)
        collection = viewer["contributionsCollection"]
        if (instant(collection["startedAt"]) != start or instant(collection["endedAt"]) != end
                or type(collection["hasAnyRestrictedContributions"]) is not bool
                or (count(collection["restrictedContributionsCount"]) > 0 and not collection["hasAnyRestrictedContributions"])):
            raise ValueError("Invalid contribution window or restricted coverage")
        signature = {key: collection[key] for key in ["startedAt", "endedAt", "hasAnyRestrictedContributions",
            "restrictedContributionsCount", "totalCommitContributions", "totalRepositoriesWithContributedCommits",
            "totalPullRequestContributions", "commitContributionsByRepository"]}
        signature["account"] = viewer["id"]
        if baseline is not None and baseline != signature:
            raise ValueError("Contribution source changed during pagination")
        if baseline is None:
            baseline = signature
            repositories = collection["commitContributionsByRepository"]
            if (not isinstance(repositories, list) or len(repositories) > MAX_REPOSITORIES
                    or count(collection["totalRepositoriesWithContributedCommits"]) != len(repositories)):
                raise ValueError("Contribution repository limit or incomplete repository coverage")
            seen = set()
            for entry in repositories:
                repo = entry["repository"]
                repo_id = digest(profile["host"].lower(), repo["id"])
                if repo_id in seen:
                    raise ValueError("Duplicate contribution repository")
                seen.add(repo_id)
                connection = entry["contributions"]
                nodes = connection["nodes"]
                if (connection["pageInfo"]["hasNextPage"] is not False
                        or not isinstance(nodes, list) or len(nodes) > 100):
                    raise ValueError("Incomplete commit contribution days")
                if count(connection["totalCount"]) != sum(count(node["commitCount"]) for node in nodes):
                    raise ValueError("Incomplete commit contribution count")
                dates = set()
                for node in nodes:
                    occurred_at = instant(node["occurredAt"])
                    profile_day = node["occurredAt"][:10]
                    if profile_day in dates or not start.date().isoformat() <= profile_day <= end.date().isoformat():
                        raise ValueError("Invalid commit contribution date")
                    dates.add(profile_day)
                    commits.append({"repository": {"id": repo_id, "name": repo["nameWithOwner"],
                        "category": repository_category("https://" + profile["host"] + "/" + repo["nameWithOwner"], config)},
                        "profileDay": profile_day, "occurredAt": stamp(occurred_at), "count": count(node["commitCount"])})
            if sum(item["count"] for item in commits) != count(collection["totalCommitContributions"]):
                raise ValueError("Incomplete commit contribution total")
        connection = collection["pullRequestContributions"]
        if count(connection["totalCount"]) != count(collection["totalPullRequestContributions"]):
            raise ValueError("Incomplete pull request contribution total")
        nodes = connection["nodes"]
        if not isinstance(nodes, list) or len(nodes) > 100:
            raise ValueError("Invalid pull request contribution page")
        for node in nodes:
            pr = node["pullRequest"]
            occurred_at, created_at = instant(node["occurredAt"]), instant(pr["createdAt"])
            if (not start <= created_at <= end or pr["author"]["login"].casefold() != profile["login"].casefold()):
                raise ValueError("Invalid pull request contribution identity or date")
            key = digest(profile["host"].lower(), pr["id"])
            if key in prs:
                raise ValueError("Duplicate pull request contribution")
            repo = pr["repository"]
            if type(repo["isFork"]) is not bool or type(repo["isPrivate"]) is not bool:
                raise ValueError("Invalid pull request repository qualification")
            prs[key] = {"key": key, "isFork": repo["isFork"], "isPrivate": repo["isPrivate"], "profileDay": node["occurredAt"][:10],
                "occurredAt": stamp(occurred_at), "createdAt": stamp(created_at),
                "chinaDay": created_at.astimezone(TZ).date().isoformat(),
                "repository": {"id": digest(profile["host"].lower(), repo["id"]), "name": repo["nameWithOwner"],
                    "category": repository_category("https://" + profile["host"] + "/" + repo["nameWithOwner"], config)}}
        page = connection["pageInfo"]
        if page["hasNextPage"] is False:
            if len(prs) != count(connection["totalCount"]):
                raise ValueError("Incomplete pull request contribution pages")
            return {"account": digest(profile["host"].lower(), viewer["id"]),
                "restrictedContributions": count(collection["restrictedContributionsCount"]),
                "hasRestrictedContributions": collection["hasAnyRestrictedContributions"],
                "startedAt": collection["startedAt"], "endedAt": collection["endedAt"],
                "commits": commits, "prs": list(prs.values())}
        if page["hasNextPage"] is not True:
            raise ValueError("Invalid contribution pagination state")
        next_cursor = page["endCursor"]
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in seen_cursors:
            raise ValueError("Invalid contribution cursor")
        seen_cursors.add(next_cursor)
        cursor = next_cursor
    raise ValueError("Contribution pagination limit")


def daily_source(data, first, last, at):
    days = {}
    for offset in range(7):
        date = (first + dt.timedelta(days=offset)).isoformat()
        days[date] = {"day": date, "capturedAt": stamp(at), "status": "partial",
            "rawPrs": 0, "excludedForkPrs": 0, "inProgress": date == last.isoformat(), "knownPrs": 0, "profilePrs": 0, "profileCommits": 0, "repositories": {}}

    def repository(row, info):
        key = info["id"]
        old = row["repositories"].get(key)
        if old is not None and (old["name"] != info["name"] or old["category"] != info["category"]):
            raise ValueError("Conflicting contribution repository")
        return row["repositories"].setdefault(key, {**info, "knownPrs": 0, "profileCommits": 0})

    for pr in data["prs"]:
        if pr["profileDay"] in days:
            days[pr["profileDay"]]["profilePrs"] += 1
        if pr["chinaDay"] in days:
            row = days[pr["chinaDay"]]
            row["rawPrs"] += 1
            if pr["isFork"]:
                row["excludedForkPrs"] += 1
                continue
            row["knownPrs"] += 1
            repository(row, pr["repository"])["knownPrs"] += 1
    for commit in data["commits"]:
        if commit["profileDay"] in days:
            row = days[commit["profileDay"]]
            row["profileCommits"] += commit["count"]
            repository(row, commit["repository"])["profileCommits"] += commit["count"]
    for row in days.values():
        row["repositories"] = sorted(row["repositories"].values(), key=lambda repo: repo["id"])
        # GitHub's aggregate commit buckets contain no per-commit author instants for a China-day conversion.
        row["chinaCommits"] = None
        if row["day"] > at.date().isoformat():
            row["profileCommits"] = None
            row["profilePrs"] = None
            row["status"] = "partial"
            for repo in row["repositories"]:
                repo["profileCommits"] = None
    return list(days.values())


def collect(config, run, repository_category, *, at=None):
    at = at or dt.datetime.now(dt.timezone.utc)
    if at.tzinfo is None:
        raise ValueError("Capture time requires an offset")
    at = at.astimezone(dt.timezone.utc).replace(microsecond=0)
    first, last = capture_window(at)
    # A full preceding UTC date is a guard band, not permission to persist an eighth operation date.
    start = dt.datetime.combine(first - dt.timedelta(days=1), dt.time.min, dt.timezone.utc)
    profiles = config.get("githubProfiles", [])
    if not isinstance(profiles, list) or not profiles or len(profiles) > MAX_PROFILES:
        raise ValueError("Configured contribution accounts required")
    identities = [profile_identity(profile) for profile in profiles]
    if len(set(identities)) != len(identities):
        raise ValueError("Duplicate contribution account scope")
    deadline = time.monotonic() + 120

    def bounded_run(args, timeout=30):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Contribution collection budget elapsed")
        return run(args, timeout=min(timeout, remaining))

    sources = []
    for profile, identity in zip(profiles, identities):
        base = {"id": identity, "host": profile["host"].lower(), "status": "unavailable", "days": []}
        try:
            data = collect_profile(config, profile, start, at, bounded_run, repository_category)
            source = {**base, "account": data["account"], "status": "partial" if data["hasRestrictedContributions"] else "ready",
                "restrictedContributions": data["restrictedContributions"], "hasRestrictedContributions": data["hasRestrictedContributions"],
                "startedAt": data["startedAt"], "endedAt": data["endedAt"],
                "days": daily_source(data, first, last, at)}
        except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            source = {**base, "errorCode": type(error).__name__}
        sources.append(source)
    return {"version": 1, "metricDefinition": DEFINITION, "dateBasis": DATE_BASIS,
        "qualification": "nonfork-at-capture", "asOfAt": stamp(at), "capturedAt": stamp(dt.datetime.now(dt.timezone.utc)),
        "operationWindow": {"timeZone": "Asia/Shanghai", "startDay": first.isoformat(), "endDay": last.isoformat(), "todayPartial": True},
        "activeSourceIds": identities, "sources": sources}


def replace_days(previous, current):
    if previous and (previous.get("version") != 1 or previous.get("metricDefinition") != DEFINITION or previous.get("dateBasis") != DATE_BASIS or previous.get("qualification") != "nonfork-at-capture"):
        raise ValueError("Cannot blend different contribution definitions")
    window = current["operationWindow"]
    first, last = window["startDay"], window["endDay"]
    if (dt.date.fromisoformat(last) - dt.date.fromisoformat(first)).days != 6:
        raise ValueError("Contribution replacement requires seven China dates")
    old_sources = {source["id"]: source for source in previous.get("sources", [])}
    if len(old_sources) != len(previous.get("sources", [])):
        raise ValueError("Duplicate retained contribution account")
    if previous and instant(previous["asOfAt"]) > instant(current["asOfAt"]):
        raise ValueError("Contribution capture moved backwards")
    for source in current["sources"]:
        old = old_sources.get(source["id"], {"id": source["id"], "days": []})
        if (old["days"] and not old.get("account")
                or source["status"] != "unavailable" and not source.get("account")
                or old.get("account") and source.get("account") and old["account"] != source["account"]):
            raise ValueError("Contribution account identity changed or is missing")
        days = {row["day"]: row for row in old["days"]}
        if len(days) != len(old["days"]):
            raise ValueError("Duplicate retained contribution day")
        incoming = {row["day"]: row for row in source["days"]}
        if len(incoming) != len(source["days"]) or any(not first <= day <= last for day in incoming):
            raise ValueError("Contribution replacement outside admitted dates")
        if source["status"] != "unavailable" and len(incoming) != 7:
            raise ValueError("Incomplete contribution operation dates")
        for offset in range(7):
            date = (dt.date.fromisoformat(first) + dt.timedelta(days=offset)).isoformat()
            fresh, retained = incoming.get(date), days.get(date)
            if fresh is None:
                if retained is not None:
                    days[date] = {**retained, "status": "stale"}
            else:
                days[date] = fresh
        old_sources[source["id"]] = {**old, **source, "days": sorted(days.values(), key=lambda row: row["day"])}
    return {**current, "sources": list(old_sources.values())}


@contextmanager
def target_lock(file):
    lock = Path(file).with_suffix(".lock")
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("Contribution lock must be a regular file")
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        # Keep the inode: unlinking permits concurrent writers to lock different files.
        os.close(fd)


def refresh(config, run, repository_category, *, file=None, at=None, skip_api=False):
    if config.get("githubContributionSource") != DEFINITION or skip_api:
        return None
    file = Path(file or Path.home() / ".local/share/mymausbot/usage/github-profile-v1.json")
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with target_lock(file):
        previous = previous_snapshot(file)
        if file.exists() and not previous:
            raise ValueError("Existing contribution cache is unreadable")
        current = collect(config, run, repository_category, at=at)
        result = replace_days(previous, current)
        write_private(file, result)
        return result
