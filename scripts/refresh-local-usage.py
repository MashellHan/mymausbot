#!/usr/bin/env python3
"""Refresh an existing activity collector with Microsoft tokens held in memory."""

import argparse
import datetime as dt
import hashlib
import http.client
import importlib.util
import importlib
import inspect
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

import local_usage_merged
import local_usage_github
import local_usage_contributions
import local_usage_ado
import local_usage_models

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
LOCAL_COLLECT_TIMEOUT = 120
REPOSITORY_TIMEOUT = 15
SHANGHAI = ZoneInfo("Asia/Shanghai")


def child_environment():
    user = pwd.getpwuid(os.getuid())
    home = Path(os.environ.get("HOME", user.pw_dir))
    if not home.is_absolute():
        raise ValueError("An absolute home directory is required")
    return {"HOME": str(home), "USER": user.pw_name, "LOGNAME": user.pw_name,
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "credential.helper", "GIT_CONFIG_VALUE_0": "",
        "GIT_NO_LAZY_FETCH": "1", "GIT_ALLOW_PROTOCOL": "file", "GIT_TERMINAL_PROMPT": "0",
        "GIT_ASKPASS": "/usr/bin/false", "SSH_ASKPASS": "/usr/bin/false",
        "SSH_ASKPASS_REQUIRE": "never", "GCM_INTERACTIVE": "never"}


class LocalGitOnly:
    SubprocessError = subprocess.SubprocessError
    CalledProcessError = subprocess.CalledProcessError
    TimeoutExpired = subprocess.TimeoutExpired
    DEVNULL = subprocess.DEVNULL

    def run(self, args, **kwargs):
        command = [str(part) for part in args]
        if len(command) < 5 or command[:2] != ["git", "-C"]:
            raise ValueError("Unapproved local activity child command")
        operation = command[3:]
        if (operation not in (["remote", "get-url", "origin"],
                              ["rev-parse", "--path-format=absolute", "--git-common-dir"])
                and not (len(operation) == 5 and operation[:3] == ["log", "--all", "--no-merges"]
                         and operation[3].startswith("--since=")
                         and operation[4] == "--format=%H%x1f%aE%x1f%aI")):
            raise ValueError("Unapproved local activity Git command")
        if operation[0] == "log":
            command.insert(4, "--no-show-signature")
        kwargs["env"] = child_environment()
        kwargs["stdin"] = subprocess.DEVNULL
        return subprocess.run(command, **kwargs)

    def Popen(self, *args, **kwargs):
        raise ValueError("Background Git fetch and SSH are unavailable in scheduled Usage")


def _safe_codex_lines(lines):
    for line in lines:
        if not isinstance(line, str):
            continue
        if not any(marker in line[:1024] for marker in ('"session_meta"', '"turn_context"', '"token_count"')):
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        payload = entry.get("payload")
        if payload is not None and not isinstance(payload, dict):
            continue
        event_type = entry.get("type")
        if isinstance(payload, dict):
            if event_type == "session_meta":
                sid = payload.get("id")
                cwd = payload.get("cwd")
                if (sid is not None and not isinstance(sid, str)) or (cwd is not None and not isinstance(cwd, str)):
                    continue
            elif event_type == "turn_context":
                cwd = payload.get("cwd")
                model = payload.get("model")
                if (cwd is not None and not isinstance(cwd, str)) or (model is not None and not isinstance(model, str)):
                    continue
            elif event_type == "event_msg" and payload.get("type") == "token_count":
                info = payload.get("info")
                if info is not None and not isinstance(info, dict):
                    continue
        yield line


class _SafeCollectJson:
    def __init__(self, wrapped):
        self._wrapped = wrapped

    def __getattr__(self, name):
        return getattr(self._wrapped, name)

    def loads(self, raw, *args, **kwargs):
        parsed = self._wrapped.loads(raw, *args, **kwargs)
        if not isinstance(parsed, dict):
            return {}
        payload = parsed.get("payload")
        if payload is not None and not isinstance(payload, dict):
            sanitized = dict(parsed)
            sanitized["payload"] = {}
            return sanitized
        return parsed


def protect_collector(collector):
    collector.subprocess = LocalGitOnly()
    if hasattr(collector, "fetch_origins"):
        collector.fetch_origins = lambda repos: ([{"source": "git-fetch", "code": "DisabledByAuthBoundary"}]
            if any(repo.get("remote") for repo in repos) else [])
    if not getattr(collector, "_omb_codex_guarded", False):
        original_codex_events = getattr(collector, "codex_events", None)
        if callable(original_codex_events):
            def guarded_codex_events(lines, *args, **kwargs):
                return original_codex_events(_safe_codex_lines(lines), *args, **kwargs)

            collector.codex_events = guarded_codex_events
        original_collect = getattr(collector, "collect", None)
        if callable(original_collect) and hasattr(collector, "json"):
            def guarded_collect(*args, **kwargs):
                original_json = collector.json
                collector.json = _SafeCollectJson(original_json)
                try:
                    return original_collect(*args, **kwargs)
                finally:
                    collector.json = original_json

            collector.collect = guarded_collect
        collector._omb_codex_guarded = True
    return collector


def retain_token_history(snapshot, previous, model_days=None, saved=None, agent_days=None):
    at = snapshot.get("updatedAt")
    if type(at) is not int:
        return snapshot
    end = dt.datetime.fromtimestamp(at / 1000, local_usage_merged.TZ).date()
    first = end - dt.timedelta(days=local_usage_merged.MAX_HISTORY_DAYS - 1)
    records = {}

    def retain(rows, projected=False, fresh=False):
        if not isinstance(rows, list) or len(rows) > local_usage_merged.MAX_HISTORY_DAYS:
            return
        for row in rows:
            if not isinstance(row, dict):
                continue
            try:
                day = dt.date.fromisoformat(row["day"])
                status = row["tokenStatus"]
                if day.isoformat() != row["day"] or not first <= day <= end or status not in ("ready", "partial", "unavailable"):
                    continue
                known = records.get(row["day"])
                split, models, agents = {}, None, None
                if status == "unavailable":
                    new, cache = None, None
                elif projected:
                    new, cache = row["newTokens"], row["cacheRead"]
                    if row["totalTokens"] != new + cache:
                        continue
                    agents = row.get("agentTokens")
                    inputs = [row.get(key) for key in ("input", "output")]
                    if all(type(value) is int and value >= 0 for value in inputs) and sum(inputs) == new:
                        split = dict(zip(("input", "output"), inputs))
                        models = row.get("models")
                    elif known and "input" in known and known["newTokens"] == new and known["cacheRead"] == cache:
                        split = {key: known[key] for key in ("input", "output")}
                        models = known.get("models")
                else:
                    categories = [row["categories"][key] for key in ("work", "personal", "unclassified")]
                    values = [value[key] for value in categories for key in ("input", "output", "cacheRead")]
                    if any(type(value) is not int or value < 0 for value in values):
                        continue
                    split = {key: sum(value[key] for value in categories) for key in ("input", "output")}
                    new = sum(split.values())
                    cache = sum(value["cacheRead"] for value in categories)
                    if fresh and model_days is not None:
                        models = model_days.get(row["day"])
                    if fresh and agent_days is not None:
                        agents = agent_days.get(row["day"])
                if status != "unavailable" and any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in (new, cache, new + cache)):
                    continue
                if status == "unavailable" and known and known["tokenStatus"] != "unavailable":
                    records[row["day"]] = {**known, "tokenStatus": "partial"}
                else:
                    details = local_usage_models.validate_models(models, {**split, "cacheRead": cache}) if split else None
                    agent_rows = local_usage_models.validate_agents(agents, new + cache) if status != "unavailable" and agents else None
                    records[row["day"]] = {"day": row["day"], "tokenStatus": status, **split,
                        "newTokens": new, "cacheRead": cache, "totalTokens": None if new is None else new + cache}
                    if details:
                        records[row["day"]]["models"] = details
                    if agent_rows:
                        records[row["day"]]["agentTokens"] = agent_rows
            except (KeyError, TypeError, ValueError, OverflowError):
                continue

    if (isinstance(saved, dict) and saved.get("version") == 1 and saved.get("timeZone") == "Asia/Shanghai"
            and type(saved.get("updatedAt")) is int and 0 < saved["updatedAt"] <= at
            and isinstance(saved.get("trendHistory"), dict) and saved["trendHistory"].get("version") == 1):
        retain(saved["trendHistory"].get("daily"), projected=True)
    if isinstance(previous, dict) and previous.get("version") == 1 and previous.get("timeZone") == "Asia/Shanghai":
        retain(previous.get("daily"))
        for key in ("localHistory", "trendHistory"):
            if isinstance(previous.get(key), dict):
                retain(previous[key].get("daily"), key == "trendHistory")
    if isinstance(snapshot.get("localHistory"), dict):
        retain(snapshot["localHistory"].get("daily"), fresh=True)
    retain(snapshot.get("daily"), fresh=True)
    snapshot["trendHistory"] = {"version": 1, "daily": [records[day] for day in sorted(records)]}
    return snapshot


def load_collector(collector_path):
    spec = importlib.util.spec_from_file_location("local_activity_collector", collector_path)
    if spec is None or spec.loader is None:
        raise ValueError("The existing activity collector could not be loaded")
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    return protect_collector(collector)


def _collect_worker():
    try:
        request = json.load(sys.stdin)
        collector = load_collector(request["collector"])
        if request["stage"] == "repositories":
            if not Path(request["config"]["repoRoots"][0]).expanduser().is_dir():
                raise ValueError("Repository root is unavailable")
            original_walk = collector.os.walk

            def walk(root):
                def failed(error):
                    raise error
                return original_walk(root, onerror=failed)

            collector.os.walk = walk
            result = collector.repositories(request["config"])
        else:
            collector.repositories = lambda config: request["repositories"]
            original_classify = collector.Classifier.classify
            blocked = [os.path.abspath(os.path.expanduser(root)) for root in request["failedRoots"]]

            def classify(self, cwd, context=None):
                if cwd and any(os.path.commonpath([os.path.abspath(cwd), root]) == root for root in blocked):
                    category = original_classify(self, None, context)
                    if category == "unclassified":
                        matches = {r["category"] for r in self.repos if r["name"] in Path(cwd).parts}
                        if len(matches) == 1:
                            category = matches.pop()
                    return category
                return original_classify(self, cwd, context)

            collector.Classifier.classify = classify
            result = collector.collect(request["config"], request["device"],
                                       at=collector.instant(request["at"]),
                                       history_days=request["history_days"])
        json.dump(result, sys.stdout)
    except Exception as error:
        print(f"usage stage=local-collect failed type={type(error).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None


def _run_worker(request, timeout):
    command = [sys.executable, "-c",
               "import os,runpy,sys; sys.path.insert(0,os.path.dirname(sys.argv[1])); "
               "runpy.run_path(sys.argv[1])['_collect_worker']()", str(Path(__file__).resolve())]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               text=True, start_new_session=True, env=child_environment())
    try:
        output, _ = process.communicate(json.dumps(request), timeout=timeout)
    except BaseException as error:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            print("usage stage=local-collect cleanup-failed lock-retained", file=sys.stderr, flush=True)
            os._exit(1)
        if isinstance(error, subprocess.TimeoutExpired):
            print("usage stage=local-collect timeout worker-reaped", file=sys.stderr, flush=True)
            raise subprocess.TimeoutExpired("local activity collection", timeout) from None
        raise
    if process.returncode:
        raise ValueError("Local activity collection failed")
    return json.loads(output)


def collect_local(collector_path, config, device, at=None, history_days=30):
    deadline = time.monotonic() + LOCAL_COLLECT_TIMEOUT
    fields = ("home", "repoRoots", "authorEmails", "workGithubOrgs", "personalGithubOwners", "m365Repos")
    request = {"collector": str(collector_path), "config": {k: config[k] for k in fields if k in config},
               "device": device, "at": at.isoformat() if at else None, "history_days": history_days}
    repositories, failed_roots, errors = [], [], []
    for index, root in enumerate(config["repoRoots"], 1):
        print(f"usage stage=repository root={index} begin", file=sys.stderr, flush=True)
        try:
            repositories.extend(_run_worker({**request, "stage": "repositories",
                "config": {**request["config"], "repoRoots": [root]}},
                min(REPOSITORY_TIMEOUT, max(0, deadline - time.monotonic()))))
            print(f"usage stage=repository root={index} end", file=sys.stderr, flush=True)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            failed_roots.append(root)
            errors.append({"source": "repositories", "rootIndex": index, "code": type(error).__name__})
            print(f"usage stage=repository root={index} unavailable", file=sys.stderr, flush=True)
    print("usage stage=local-records begin", file=sys.stderr, flush=True)
    try:
        result = _run_worker({**request, "stage": "collect", "repositories": repositories,
                              "failedRoots": failed_roots}, max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        lock = Path(config["storageDir"]).expanduser() / ".refresh.lock"
        try:
            (lock / ".detached-child-unverified").mkdir(exist_ok=True)
        except OSError:
            print("usage stage=local-collect timeout lock-marker-failed", file=sys.stderr, flush=True)
            os._exit(1)
        print("usage stage=local-collect timeout lock-retained", file=sys.stderr, flush=True)
        raise RuntimeError("Local activity worker cleanup is unverified") from None
    if errors or result.get("errors"):
        collector = load_collector(collector_path)
        previous = collector.read_json(Path(config["storageDir"]).expanduser() / "machines" / (device + ".json"), {})
        start, end = collector.instant(result["start"]), collector.instant(result["capturedAt"])
        if failed_roots:
            previous_tokens = {}
            for record in previous.get("tokens", []):
                previous_tokens.setdefault(record["key"], record)
            for record in result["tokens"]:
                previous_category = previous_tokens.get(record["key"], {}).get("category")
                if record.get("category") == "unclassified" and previous_category in ("work", "personal"):
                    record["category"] = previous_category
        combined_errors = list(result.get("errors") or []) + list(errors)
        fetch_disabled_only = bool(combined_errors) and all(
            isinstance(error, dict)
            and error.get("source") == "git-fetch"
            and error.get("code") == "DisabledByAuthBoundary"
            for error in combined_errors
        )
        retain_fields = ("tokens",) if fetch_disabled_only else ("tokens", "commits")
        for field in retain_fields:
            def key(record):
                return record["key"] if field == "tokens" else (record["key"], (record.get("repository") or {}).get("id"))
            fresh_keys = {key(record) for record in result[field]}
            result[field].extend(record for record in previous.get(field, [])
                                 if key(record) not in fresh_keys
                                 and (record_at := collector.instant(record.get("at"))) is not None
                                 and start <= record_at < end)
        result["adoRepos"] = sorted(set(result["adoRepos"]) | set(previous.get("adoRepos", [])))
        result["status"] = "partial"
        result["errors"].extend(errors)
        result["retainedTokenCapturedAt"] = (
            previous.get("retainedTokenCapturedAt") or previous.get("retainedCapturedAt") or previous.get("capturedAt")
        )
        if "commits" in retain_fields:
            result["retainedCapturedAt"] = previous.get("retainedCapturedAt") or previous.get("capturedAt")
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHubFileSession:
    AUTH_DIRECTORIES = ("github-personal", "github-work")
    MAX_RESPONSE_BYTES = 8 * 1024 * 1024

    def __init__(self, config, auth_root=None):
        self.config = config
        self.auth_root = auth_root or Path(pwd.getpwuid(os.getuid()).pw_dir) / ".local/share/mymausbot-auth"
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.credentials = None
        self.verified = set()

    @staticmethod
    def _private(path, directory):
        info = path.lstat()
        if (info.st_uid != os.getuid() or info.st_mode & 0o077
                or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))):
            raise ValueError("GitHub credential path is not private")

    def _read_file(self, path):
        self._private(self.auth_root, True)
        self._private(path.parent, True)
        self._private(path, False)
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError("GitHub credential file changed during read")
            raw = stream.read(8193)
        if len(raw) > 8192:
            raise ValueError("GitHub credential file is too large")
        credential = json.loads(raw)
        if (not isinstance(credential, dict) or set(credential) != {"host", "login", "stableId", "token"}
                or credential["host"] != "github.com"
                or any(not isinstance(credential[key], str) or not credential[key]
                       for key in ("login", "stableId", "token"))
                or len(credential["token"]) > 2048 or any(char.isspace() for char in credential["token"])):
            raise ValueError("GitHub credential metadata is invalid")
        return credential

    def _credential(self, name):
        profiles = self.config.get("githubProfiles")
        helper = self.config.get("githubHelper")
        if (not isinstance(profiles, list) or not profiles or not isinstance(helper, str)
                or Path(helper) != Path(__file__).resolve() or Path(helper).is_symlink()
                or any(not isinstance(profile, dict) or profile.get("host") != "github.com"
                       or not isinstance(profile.get("profile"), str)
                       or not isinstance(profile.get("login"), str)
                       or not isinstance(profile.get("stableId"), str)
                       for profile in profiles)):
            raise ValueError("Configured GitHub account or helper path is unavailable")
        if self.credentials is None:
            found = {}
            for directory in self.AUTH_DIRECTORIES:
                path = self.auth_root / directory / "credential.json"
                if not path.exists():
                    continue
                credential = self._read_file(path)
                matches = [profile["profile"] for profile in profiles
                    if profile["login"].casefold() == credential["login"].casefold()
                    and profile["stableId"] == credential["stableId"]]
                if len(matches) != 1 or matches[0] in found:
                    raise ValueError("GitHub credential identity is ambiguous")
                found[matches[0]] = credential
            if set(found) != {profile["profile"] for profile in profiles} or len(found) != len(profiles):
                raise ValueError("GitHub credential identity is missing")
            self.credentials = found
        if name not in self.credentials:
            raise ValueError("Unconfigured GitHub account")
        return self.credentials[name]

    def _request(self, credential, path, timeout, body=None):
        request = urllib.request.Request("https://api.github.com/" + path, data=body,
            headers={"Authorization": "Bearer " + credential["token"], "Accept": "application/json",
                     "Content-Type": "application/json", "User-Agent": "MausBot-Activities-File-Credentials"},
            method="POST" if body is not None else "GET")
        try:
            with self.http.open(request, timeout=timeout) as response:
                raw = response.read(self.MAX_RESPONSE_BYTES + 1)
            if len(raw) > self.MAX_RESPONSE_BYTES:
                raise ValueError("GitHub response exceeds the bounded size")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError("Invalid GitHub response")
            return value
        except Exception:
            raise ValueError("GitHub file-auth request is unavailable") from None

    @staticmethod
    def _identity_url(value, login):
        if not isinstance(value, str):
            return False
        url = urllib.parse.urlsplit(value)
        return (url.scheme == "https" and url.hostname == "github.com" and url.port in (None, 443)
                and url.username is None and url.password is None and not url.query and not url.fragment
                and url.path.strip("/").casefold() == login.casefold())

    def _verified(self, name, credential, timeout):
        if name in self.verified:
            return
        user = self._request(credential, "user", timeout)
        if (user.get("node_id") != credential["stableId"]
                or not isinstance(user.get("login"), str)
                or user["login"].casefold() != credential["login"].casefold()
                or not self._identity_url(user.get("html_url"), credential["login"])):
            raise ValueError("GitHub token identity does not match the configured account")
        self.verified.add(name)

    def run(self, args, timeout):
        if (not isinstance(args, list) or len(args) < 6 or args[0] != sys.executable
                or args[1] != self.config.get("githubHelper") or args[2] != "gh" or args[4] != "api"
                or not isinstance(timeout, (int, float)) or not 0 < timeout <= 35):
            raise ValueError("Unapproved GitHub helper request")
        name, operation = args[3], args[5:]
        credential = self._credential(name)
        if operation == ["user", "--jq", ".login"]:
            self._verified(name, credential, timeout)
            return credential["login"]
        if len(operation) >= 1 and operation[0] == "graphql":
            fields = {}
            flags = operation[1:]
            if len(flags) % 2:
                raise ValueError("Invalid GitHub GraphQL fields")
            for flag, assignment in zip(flags[::2], flags[1::2]):
                if (flag != "-f" or not isinstance(assignment, str) or "=" not in assignment):
                    raise ValueError("Invalid GitHub GraphQL field")
                key, value = assignment.split("=", 1)
                if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key) or key in fields:
                    raise ValueError("Duplicate GitHub GraphQL field")
                fields[key] = value
            query = fields.pop("query", None)
            if not isinstance(query, str) or not query or len(query) > 100_000:
                raise ValueError("GitHub GraphQL query is invalid")
            self._verified(name, credential, timeout)
            data = self._request(credential, "graphql", timeout,
                json.dumps({"query": query, "variables": fields}).encode())
            viewer = (data.get("data") or {}).get("viewer")
            if (data.get("errors") or not isinstance(viewer, dict)
                    or not isinstance(viewer.get("login"), str)
                    or viewer["login"].casefold() != credential["login"].casefold()
                    or viewer.get("id", credential["stableId"]) != credential["stableId"]
                    or ("url" in viewer and not self._identity_url(viewer["url"], credential["login"]))):
                raise ValueError("GitHub GraphQL account identity differs from the credential")
            return json.dumps(data)
        if (len(operation) == 9 and operation[:3] == ["--method", "GET", "search/issues"]
                and operation[3] == "-f" and operation[5:7] == ["-F", "per_page=100"]
                and operation[7] == "-F"):
            query = operation[4].removeprefix("q=")
            page = operation[8].removeprefix("page=")
            if (not operation[4].startswith("q=is:pr author:" + credential["login"] + " created:>=")
                    or not page.isdigit() or not 1 <= int(page) <= 11):
                raise ValueError("Unapproved GitHub search page")
            path = "search/issues?" + urllib.parse.urlencode({"q": query, "per_page": 100, "page": int(page)})
            self._verified(name, credential, timeout)
            return json.dumps(self._request(credential, path, timeout))
        if len(operation) == 1:
            endpoint = urllib.parse.urlsplit("https://api.github.com/" + operation[0])
            pattern = (r"/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/compare/"
                       r"[0-9a-f]{40}(?:[0-9a-f]{24})?\.\.\.[0-9a-f]{40}(?:[0-9a-f]{24})?")
            query = urllib.parse.parse_qs(endpoint.query, strict_parsing=True)
            if (endpoint.hostname == "api.github.com" and re.fullmatch(pattern, endpoint.path, re.I)
                    and set(query) == {"per_page", "page"} and query["per_page"] == ["100"]
                    and len(query["page"]) == 1 and query["page"][0].isdigit()
                    and 1 <= int(query["page"][0]) <= 100):
                self._verified(name, credential, timeout)
                return json.dumps(self._request(credential, operation[0], timeout))
        raise ValueError("Unapproved GitHub helper endpoint")


class AzureMemorySession:
    def __init__(self, config_dir, author_emails, projects=None):
        self.config_dir = config_dir
        self.author_emails = {email.lower() for email in author_emails}
        self.lock = threading.Lock()
        self.client = None
        self.account = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.projects = projects

    def token(self):
        with self.lock:
            try:
                if self.client is None:
                    self.connect()
                result = self.client.acquire_token_silent(
                    [ADO_RESOURCE + "/.default"], account=self.account
                ) or {}
            except Exception:
                raise ValueError("Microsoft sign-in is unavailable without an interactive login") from None
            token = result.get("access_token") if isinstance(result, dict) else None
            if not isinstance(token, str) or not token:
                raise ValueError("Microsoft sign-in is unavailable without an interactive login")
            return token

    def connect(self):
        from azure.cli.core.auth.constants import AZURE_CLI_CLIENT_ID
        from msal import PublicClientApplication, SerializableTokenCache

        profile = json.loads(
            (self.config_dir / "azureProfile.json").read_text(encoding="utf-8-sig")
        )
        defaults = [entry for entry in profile["subscriptions"] if entry.get("isDefault")]
        if len(defaults) != 1:
            raise ValueError("Select one existing Azure CLI account before collecting Usage")
        selected = defaults[0]
        user = selected.get("user", {})
        username = user.get("name", "")
        tenant = selected.get("tenantId", "")
        if (
            selected.get("environmentName") != "AzureCloud"
            or user.get("type") != "user"
            or username.lower() not in self.author_emails
            or not re.fullmatch(r"[0-9a-fA-F-]{36}", tenant)
        ):
            raise ValueError("The existing Azure CLI identity does not match the Usage owner")
        cache = SerializableTokenCache()
        cache.deserialize((self.config_dir / "msal_token_cache.json").read_text())
        client = PublicClientApplication(
            AZURE_CLI_CLIENT_ID,
            authority="https://login.microsoftonline.com/" + tenant,
            token_cache=cache,
            http_cache={},
            enable_broker_on_mac=False,
            enable_pii_log=False,
            client_capabilities=["CP1"],
            timeout=15,
        )
        # MSAL 1.39.0 projects one tenant record per home account in cache order.
        accounts = [account for account in client.get_accounts(username=username)
                    if account.get("home_account_id") and any(
                        cached.get("username", "").lower() == username.lower()
                        for cached in cache.search(cache.CredentialType.ACCOUNT, query={
                            "home_account_id": account["home_account_id"],
                            "environment": account["environment"], "realm": tenant,
                        })
                    )]
        if len(accounts) != 1:
            raise ValueError("The Microsoft account is not present in the existing CLI cache")
        self.client, self.account = client, accounts[0]

    def run(self, args, timeout):
        if (
            len(args) != 10
            or list(args[1:5]) != ["rest", "--method", "get", "--url"]
            or list(args[6:]) != ["--resource", ADO_RESOURCE, "-o", "json"]
        ):
            raise ValueError("Usage permits only the existing Azure DevOps GET requests")
        body, continuation = self.request(str(args[5]), timeout)
        if continuation:
            data = json.loads(body)
            if not isinstance(data, dict) or data.get("continuationToken") not in (None, continuation):
                raise ValueError("Conflicting ADO continuation metadata")
            data["continuationToken"] = continuation
            return json.dumps(data, separators=(",", ":"))
        return body

    def request(self, url, timeout):
        target = urllib.parse.urlsplit(url)
        old_path = re.fullmatch(
            r"/[^/]+/_apis/connectionData|/[^/]+/[^/]+/_apis/git/(?:pullrequests|repositories/[^/]+/(?:pullrequests|pullrequests/\d+/commits|commits/[0-9a-f]{40}(?:[0-9a-f]{24})?))",
            target.path, re.I)
        new_path = re.fullmatch(
            r"/[^/]+/[^/]+/_apis/git/(?:repositories|repositories/[0-9a-f-]{36}/(?:refs|commits))",
            target.path, re.I)
        if (
            target.scheme != "https"
            or target.hostname != "dev.azure.com"
            or target.port not in (None, 443)
            or target.username is not None
            or target.password is not None
            or target.fragment
            or not (old_path or new_path)
        ):
            raise ValueError("Usage permits only Azure DevOps identity and PR endpoints")
        parts = target.path.strip("/").split("/")
        scope = tuple(urllib.parse.unquote(part).casefold() for part in parts[:2])
        if self.projects is not None and (scope[0] not in {org for org, _ in self.projects} or
                len(parts) > 3 and scope not in self.projects):
            raise ValueError("ADO request is outside configured projects")
        if new_path:
            query = urllib.parse.parse_qs(target.query, keep_blank_values=True, strict_parsing=True)
            if any(len(values) != 1 for values in query.values()) or query.get("api-version") != ["7.1"]:
                raise ValueError("Invalid ADO request parameters")
            suffix = parts[-1]
            if suffix == "repositories":
                allowed = {"api-version", "includeHidden"} if "includeHidden" in query else {"api-version"}
                if "includeHidden" in query and query["includeHidden"] != ["true"]:
                    raise ValueError("Invalid hidden repository inventory request")
            elif suffix == "refs":
                allowed = {"api-version", "filter"}
                if not query.get("filter", [""])[0].startswith("heads/"):
                    raise ValueError("Invalid ADO branch filter")
            else:
                allowed = {"api-version", "searchCriteria.itemVersion.version", "searchCriteria.itemVersion.versionType", "$top", "$skip"}
                if (not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", query.get("searchCriteria.itemVersion.version", [""])[0], re.I)
                        or query.get("searchCriteria.itemVersion.versionType") != ["commit"]
                        or not query.get("$top", [""])[0].isdigit() or not 1 <= int(query["$top"][0]) <= 100
                        or not query.get("$skip", [""])[0].isdigit() or int(query["$skip"][0]) > 1_000_000):
                    raise ValueError("Invalid pinned ADO commit page")
                bounds = {"searchCriteria.fromDate", "searchCriteria.toDate"}
                if bounds & query.keys():
                    if not bounds <= query.keys():
                        raise ValueError("Invalid ADO commit date window")
                    start, end = (query[key][0] for key in ("searchCriteria.fromDate", "searchCriteria.toDate"))
                    if not all(re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value) for value in (start, end)):
                        raise ValueError("Invalid ADO commit date window")
                    try:
                        start_at, end_at = (dt.datetime.fromisoformat(value[:-1] + "+00:00") for value in (start, end))
                    except ValueError:
                        raise ValueError("Invalid ADO commit date window") from None
                    if start_at > end_at or end_at - start_at > dt.timedelta(days=60):
                        raise ValueError("Invalid ADO commit date window")
                    allowed |= bounds
            if set(query) != allowed:
                raise ValueError("Unexpected ADO request parameters")
        request = urllib.request.Request(
            target.geturl(),
            headers={"Authorization": "Bearer " + self.token(), "Accept": "application/json"},
            method="GET",
        )
        try:
            with self.http.open(request, timeout=timeout) as response:
                headers = getattr(response, "headers", None)
                continuation = headers.get("x-ms-continuationtoken") if headers else None
                return response.read().decode("utf-8"), continuation
        except urllib.error.HTTPError as error:
            if type(error.code) is not int or not 100 <= error.code <= 599:
                raise ValueError("The Azure DevOps HTTP status is unavailable") from None
            raise local_usage_ado.HttpReadError(error.code) from None
        except http.client.HTTPException:
            raise OSError("The Azure DevOps response could not be read") from None


def ado_project_scopes(config):
    scopes = set()
    for raw in config.get("mergedAdoProjects", []) + config.get("adoRemotes", []):
        parsed = urllib.parse.urlsplit(raw)
        parts = parsed.path.strip("/").split("/")
        if (parsed.scheme != "https" or parsed.hostname != "dev.azure.com" or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.query or parsed.fragment or len(parts) not in (2, 4)
                or len(parts) == 4 and parts[2] != "_git"):
            raise ValueError("Invalid configured ADO project")
        org, project = (urllib.parse.unquote(part).casefold() for part in parts[:2])
        if not org or not project or any(part in (".", "..") or "/" in part or "\\" in part for part in (org, project)):
            raise ValueError("Invalid configured ADO project")
        scopes.add((org, project))
    return scopes


def primary_config(config):
    profiles = config.get("githubProfiles")
    if not isinstance(profiles, list) or not profiles or any(not isinstance(row, dict) or
            not all(isinstance(row.get(key), str) and row[key] for key in ("host", "login", "stableId", "profile"))
            for row in profiles):
        raise ValueError("Verified GitHub Profile identities are required")
    scopes = ado_project_scopes(config)
    principals = config.get("adoPrincipals")
    aliases = config.get("adoAuthorEmails")
    if (not scopes or not isinstance(principals, dict) or set(principals) != {org for org, _ in scopes}
            or not isinstance(aliases, list) or not aliases or len(set(aliases)) != len(aliases)
            or any(not isinstance(alias, str) or alias != alias.lower() or "@" not in alias for alias in aliases)):
        raise ValueError("Verified ADO principals and scoped author aliases are required")
    historical = {value.casefold() for value in config.get("authorEmails", [])}
    for org, principal in principals.items():
        if (not isinstance(principal, dict) or not isinstance(principal.get("stableId"), str)
                or not re.fullmatch(r"[0-9a-fA-F-]{36}", principal["stableId"])
                or principal.get("alias") not in aliases or principal["alias"] not in historical):
            raise ValueError("ADO principal does not match scoped author aliases")
    return scopes


def refresh_scope_hash(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def refresh_window(at, previous, scope_hash):
    local = at.astimezone(SHANGHAI)
    yesterday = local.date() - dt.timedelta(days=1)
    first = local.date() - dt.timedelta(days=59)
    state = previous.get("refreshState", {}) if previous else {}
    if state.get("scopeHash") == scope_hash and isinstance(state.get("finalizedThroughDay"), str):
        finalized = dt.date.fromisoformat(state["finalizedThroughDay"])
    elif previous and all(previous[provider]["metricDefinition"] == local_usage_contributions.DEFINITIONS[provider][0]
                          for provider in ("github", "ado")):
        cutoff = min(local_usage_contributions.instant(previous[provider]["asOfAt"]).astimezone(SHANGHAI).date()
                     for provider in ("github", "ado"))
        complete = all(all(source["coverage"]["paginationComplete"] and source["status"] != "stale"
                           for source in previous[provider]["sources"]) for provider in ("github", "ado"))
        finalized = cutoff - dt.timedelta(days=1 if complete else 2)
    else:
        finalized = yesterday - dt.timedelta(days=1)
    unpaid = max(first, finalized + dt.timedelta(days=1))
    if local.time() < dt.time(0, 30):
        return min(yesterday, unpaid), finalized
    return (min(local.date(), unpaid)
            if finalized < yesterday else local.date()), finalized


def finalized_day(current, at, focus_start, previous_finalized):
    yesterday = at.astimezone(SHANGHAI).date() - dt.timedelta(days=1)
    first = at.astimezone(SHANGHAI).date() - dt.timedelta(days=59)
    if (focus_start > yesterday or focus_start < first
            or any(local_usage_contributions.instant(current[provider]["asOfAt"]) != at
                   or any(source["status"] in ("stale", "unavailable")
                          or source["coverage"]["identityVerified"] is not True
                          or source["coverage"]["paginationComplete"] is not True
                          for source in current[provider]["sources"])
                   for provider in ("github", "ado"))):
        return previous_finalized
    return yesterday


def legacy_ado_commits(config, repository_identity, repository_category, *, at, snapshot=None, file=None):
    if not config.get("mergedAdoProjects") and not config.get("adoRemotes"):
        return {"records": [], "complete": True}
    if isinstance(at, str):
        aggregate_at = local_usage_contributions.instant(at)
    elif isinstance(at, dt.datetime) and at.tzinfo is not None:
        aggregate_at = at.astimezone(dt.timezone.utc)
    else:
        raise ValueError("ADO aggregate cutoff requires an offset")
    if snapshot is None:
        target = Path(file or Path.home() / ".local/share/mymausbot/usage/contributions-v2.json")
        snapshot = local_usage_contributions.load_previous(target)
    if snapshot is None:
        return {"records": [], "complete": False}
    local_usage_contributions.validate_seed_bindings(snapshot, config)
    ado = snapshot["ado"]
    configured = local_usage_ado.projects(config)
    if len(configured) != len(ado["sources"]):
        raise ValueError("ADO raw source count mismatch")
    state = ado["state"]
    sources = {source["id"]: source for source in ado["sources"]}
    records, complete = [], True
    email_hash = local_usage_ado.digest("ado-author-aliases", sorted(local_usage_ado.author_aliases(config)))
    for org, project, repository_names in configured:
        account = local_usage_ado.principal(config, org)
        scope = org.casefold() + "/" + project.casefold()
        source_id = local_usage_ado.digest("ado", "dev.azure.com", scope, account["stableId"])
        source = sources.get(source_id)
        project_state = state["projects"].get(scope)
        if (source is None or source["account"] != account or not isinstance(project_state, dict)
                or project_state.get("account") != account or project_state.get("emailHash") != email_hash
                or project_state.get("remoteScopeHash") != local_usage_ado.digest(
                    "ado-remotes", scope, repository_names)):
            raise ValueError("ADO raw project binding mismatch")
        verified = source["coverage"]["identityVerified"] is True
        provenance = source.get("provenance", {})
        cutoff = local_usage_contributions.instant(provenance.get("sourceCutoffAt", ado["asOfAt"]))
        captured = local_usage_contributions.instant(provenance.get("sourceCapturedAt", ado["capturedAt"]))
        if cutoff > captured or captured > local_usage_contributions.instant(ado["capturedAt"]):
            raise ValueError("ADO raw capture is out of order")
        raw_complete = (source["status"] == "ready" and verified
                        and source["coverage"]["paginationComplete"] is True
                        and source["coverage"]["visibilityComplete"] is True)
        source_complete = raw_complete and cutoff >= aggregate_at
        complete = complete and source_complete
        if not verified:
            continue
        work = project_state.get("work")
        prior_cache = project_state.get("cache")
        if (not isinstance(work, dict) or not isinstance(prior_cache, dict)
                or work.get("cutoff") != local_usage_ado.stamp(cutoff)
                or work.get("firstDay") != ado["operationWindow"]["startDay"]
                or work.get("lastDay") != ado["operationWindow"]["endDay"]
                or not isinstance(work.get("inventory"), list)):
            raise ValueError("ADO raw work binding mismatch")
        inventory = {repo.get("id"): repo for repo in work["inventory"]
                     if isinstance(repo, dict) and isinstance(repo.get("id"), str)}
        if len(inventory) != len(work["inventory"]):
            raise ValueError("ADO raw repository inventory is invalid")
        selected = work.get("selectedRepoIds")
        if (not isinstance(selected, list) or len(selected) != len(set(selected))
                or any(repo_id not in inventory for repo_id in selected)):
            raise ValueError("ADO raw selected repositories are invalid")
        selected_repos = [inventory[repo_id] for repo_id in selected]
        if {repo["name"].casefold() for repo in selected_repos} != set(repository_names):
            raise ValueError("ADO raw repository scope mismatch")
        completed = work.get("repoDone")
        progress = work.get("progress")
        if not isinstance(completed, dict) or not isinstance(progress, dict):
            raise ValueError("ADO raw repository proofs are invalid")
        if not source_complete and work.get("scanComplete") is True:
            complete = False
        proofs = {}
        for repo_id, active in progress.items():
            if not isinstance(active, dict):
                raise ValueError("ADO raw repository progress is invalid")
            prior = prior_cache.get(repo_id)
            proofs[repo_id] = (prior, True) if isinstance(prior, dict) \
                and prior.get("head") == active.get("head") else (active, False)
        proofs.update((repo_id, (proof, True)) for repo_id, proof in completed.items())
        pinned = provenance.get("pinnedHeads", {})
        if not isinstance(pinned, dict):
            raise ValueError("ADO raw pinned heads are invalid")
        if raw_complete and (set(completed) != set(selected) or any(
                pinned.get(repo_id) != completed[repo_id].get("head") for repo_id in selected)):
            raise ValueError("ADO raw completed repository binding mismatch")
        for repo_id, (proof, retained) in proofs.items():
            if repo_id not in selected or not isinstance(proof, dict):
                continue
            repo = inventory[repo_id]
            head, branch, pinned_at = proof.get("head"), proof.get("branch"), proof.get("pinnedAt")
            coverage_start = (local_usage_ado.instant(proof.get("coverageStartAt")) if retained
                              else local_usage_ado.window_start(ado["operationWindow"]["startDay"]))
            if (repo.get("isDisabled") is not False or repo.get("defaultBranch") != branch
                    or not isinstance(head, str) or not local_usage_ado.SHA.fullmatch(head)
                    or local_usage_ado.instant(pinned_at) > captured
                    or coverage_start > local_usage_ado.window_start(ado["operationWindow"]["startDay"])
                    or repo_id in completed and pinned.get(repo_id) != head):
                raise ValueError("ADO raw repository proof mismatch")
            items, checked = proof.get("items"), proof.get("checked", [])
            if (not isinstance(items, list) or not isinstance(checked, list)
                    or len(checked) != len(set(checked))
                    or any(not isinstance(oid, str) or not local_usage_ado.SHA.fullmatch(oid) for oid in checked)):
                raise ValueError("ADO raw commit proof is invalid")
            remote = "https://dev.azure.com/" + "/".join(urllib.parse.quote(value, safe="")
                for value in (org, project, "_git", repo["name"]))
            identity = repository_identity(remote)
            if (not isinstance(identity, dict) or not isinstance(identity.get("id"), str) or not identity["id"]
                    or not isinstance(identity.get("name"), str) or not identity["name"]):
                raise ValueError("ADO raw repository identity is invalid")
            category = repository_category(remote, config)
            if category not in ("work", "personal", "unclassified"):
                raise ValueError("ADO raw repository category is invalid")
            family = repo["name"].casefold() in {name.casefold() for name in config.get("m365Repos", [])}
            seen = set()
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("ADO raw commit is invalid")
                oid = item.get("id")
                authored = local_usage_ado.instant(item.get("authoredAt"))
                if (not isinstance(oid, str) or not local_usage_ado.SHA.fullmatch(oid) or oid in seen
                        or oid not in checked or item.get("day") != local_usage_ado.china_day(authored)
                        or authored < coverage_start or authored > local_usage_ado.instant(pinned_at)
                        or type(item.get("merge")) is not bool or type(item.get("coauthor")) is not bool):
                    raise ValueError("ADO raw commit proof is invalid")
                seen.add(oid)
                if (ado["operationWindow"]["startDay"] <= item["day"] <= ado["operationWindow"]["endDay"]
                        and authored <= cutoff and not item["merge"] and not item["coauthor"]):
                    records.append({"key": oid, "at": item["authoredAt"], "category": category,
                                    "m365": family, "repository": identity})
    return {"records": records, "complete": complete}


def _primary_worker():
    try:
        request = json.load(sys.stdin)
        config = request["config"]
        stage = request["stage"]
        collector_path = Path(request["collector"])
        azure_dir = Path(request["azureDir"])
        if stage == "legacy":
            refresh(collector_path, config, azure_dir, publish=request["publish"],
                    skip_api=request["skipApi"], reuse_sources=request["reuseSources"], force_legacy=True,
                    legacy_diagnostics=False, primary_snapshot=request.get("primary"))
            return
        if stage not in ("github", "ado"):
            raise ValueError("Unknown contribution worker")
        collector = load_collector(collector_path)
        module = importlib.import_module("local_usage_profile" if stage == "github" else "local_usage_ado")
        azure = AzureMemorySession(azure_dir, config["adoAuthorEmails"], projects=ado_project_scopes(config))
        github = GitHubFileSession(config)

        def run(args, timeout=35):
            if str(args[0]) == config["azureCli"]:
                return azure.run(args, timeout)
            if len(args) > 2 and args[2] == "gh":
                return github.run(args, timeout)
            if str(args[0]) == "gh":
                raise ValueError("Direct GitHub CLI is unavailable in scheduled Usage")
            return collector.run(args, timeout)

        at = dt.datetime.fromisoformat(request["at"])
        result = module.collect(config, run, collector.remote_category, at=at, days=60,
                                previous=request["previous"], focus_start=request["focusStart"])
        local_usage_contributions.envelope(result, stage)
        output = Path(request["output"])
        data = (json.dumps(result, separators=(",", ":")) + "\n").encode()
        if len(data) > local_usage_contributions.MAX_BYTES:
            raise ValueError("Contribution worker output exceeds limit")
        fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception as error:
        print(f"usage stage=primary-worker status=unavailable type={type(error).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None


def _stop_worker(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=5)


def refresh_primary(collector_path, config, azure_config_dir, *, publish=False, reuse_sources=False,
                    file=None, previous_file=None, whole_cycle_seconds=285, include_legacy=True):
    primary_config(config)
    target = Path(file or Path.home() / ".local/share/mymausbot/usage/contributions-v2.json")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not 0 < whole_cycle_seconds <= 285:
        raise ValueError("Contribution cycle must stay within the existing five-minute job")
    with local_usage_contributions.target_lock(target):
        if previous_file is not None and Path(previous_file).resolve() == target.resolve():
            raise ValueError("Private contribution seed must be separate from the candidate target")
        if target.exists() or target.is_symlink():
            previous = local_usage_contributions.validate_bindings(
                local_usage_contributions.load_previous(target), config)
        elif previous_file is not None:
            previous = local_usage_contributions.validate_seed_bindings(
                local_usage_contributions.load_previous(previous_file), config)
        else:
            previous = None
        at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        scope_hash = refresh_scope_hash(config)
        focus_start, previous_finalized = refresh_window(at, previous, scope_hash)
        deadline = time.monotonic() + whole_cycle_seconds
        processes = {}
        with tempfile.TemporaryDirectory(prefix="contributions-capture-", dir=target.parent) as temporary:
            try:
                def start(stage, primary=None):
                    request = {"stage": stage, "collector": str(collector_path), "config": config,
                               "azureDir": str(azure_config_dir), "at": at.isoformat(),
                               "focusStart": focus_start.isoformat() if include_legacy else None,
                               "previous": previous.get(stage) if previous and stage != "legacy" else None,
                               "output": str(Path(temporary) / (stage + ".json")),
                               "publish": publish, "skipApi": False, "reuseSources": reuse_sources,
                               "primary": primary}
                    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker"],
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        start_new_session=True, env=child_environment())
                    processes[stage] = process
                    process.stdin.write(json.dumps(request).encode())
                    process.stdin.close()

                for stage in ("github", "ado"):
                    start(stage)
                results, captured = {}, {}
                for stage in ("github", "ado"):
                    process = processes[stage]
                    try:
                        process.wait(timeout=max(0.01, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        _stop_worker(process)
                        results[stage] = "timeout"
                    else:
                        if process.returncode:
                            results[stage] = "unavailable"
                            continue
                        try:
                            captured[stage] = json.loads((Path(temporary) / (stage + ".json")).read_text())
                            results[stage] = "ready"
                        except (OSError, ValueError):
                            results[stage] = "invalid-output"
                for stage, status in results.items():
                    if status != "ready":
                        print(f"usage stage={stage} status={status} generation=retained", file=sys.stderr, flush=True)
                complete = results["github"] == "ready" and results["ado"] == "ready"
                current = None
                if complete:
                    current = {"version": 2, **captured}
                    local_usage_contributions.validate_bindings(current, config)
                    local_usage_contributions.preserve_incomplete_github(previous, current)
                    current["refreshState"] = {"version": 1, "scopeHash": scope_hash,
                        "finalizedThroughDay": finalized_day(current, at, focus_start, previous_finalized).isoformat()}
                    local_usage_contributions.validate_bindings(current, config)
                    local_usage_contributions.write_private(target, current)
                if include_legacy:
                    start("legacy", current if complete else previous)
                if not complete:
                    raise ValueError("Remote contribution capture is incomplete; previous generation retained")
                print(json.dumps({"primary": "published", "legacy": "pending" if include_legacy else "not-run",
                    "asOfAt": current["github"]["asOfAt"], "sources": len(current["github"]["sources"]) + len(current["ado"]["sources"]),
                    "staleSources": sum(source["status"] == "stale" for stage in ("github", "ado")
                                        for source in current[stage]["sources"]),
                    "elapsedSeconds": round(whole_cycle_seconds - max(0, deadline - time.monotonic()), 1)}), flush=True)
                return current
            finally:
                legacy = processes.get("legacy")
                if legacy is not None:
                    try:
                        legacy.wait(timeout=max(0.01, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        _stop_worker(legacy)
                        legacy_status = "timeout"
                    except Exception:
                        legacy_status = "unavailable"
                    else:
                        legacy_status = "ready" if legacy.returncode == 0 else "unavailable"
                    print(json.dumps({"legacy": legacy_status}), flush=True)
                for process in processes.values():
                    if process.poll() is None:
                        _stop_worker(process)


def refresh(collector_path, config, azure_config_dir, *, publish=False, skip_api=False, reuse_sources=False,
            force_legacy=False, legacy_diagnostics=True, herdr_runner=None, primary_snapshot=None):
    if publish:
        raise ValueError("Scheduled Usage publication requires a separately reviewed transport")
    if config.get("primaryContributionSource") == "contributions-v2" and not force_legacy:
        if skip_api:
            return refresh(collector_path, config, azure_config_dir, publish=publish,
                           skip_api=True, reuse_sources=reuse_sources, force_legacy=True,
                           legacy_diagnostics=False, herdr_runner=herdr_runner)
        return refresh_primary(collector_path, config, azure_config_dir, publish=publish, reuse_sources=reuse_sources)
    collector = load_collector(collector_path)
    original_run = collector.run
    projects = ado_project_scopes(config)
    azure = AzureMemorySession(azure_config_dir, config["authorEmails"], projects=projects or None)
    github = GitHubFileSession(config)

    original_refresh_prs = getattr(collector, "refresh_prs", None)
    if original_refresh_prs is not None and projects:
        def authorized_remote(remote):
            try:
                coords = collector.ado_coordinates(remote)
                return coords and tuple(part.casefold() for part in coords[:2]) in projects
            except (TypeError, ValueError):
                return False

        def refresh_prs(config, machines, *args, **kwargs):
            eligible = [{**machine, "adoRepos": [remote for remote in machine.get("adoRepos", [])
                                                 if isinstance(remote, str) and authorized_remote(remote)]}
                        for machine in machines]
            return original_refresh_prs(config, eligible, *args, **kwargs)

        collector.refresh_prs = refresh_prs

    storage = Path(config["storageDir"]).expanduser() if "storageDir" in config else None
    latest = storage / "latest.json" if storage is not None else None
    retained = storage / "token-history.json" if storage is not None else None
    continuity_path = storage / "agent-continuity.json" if storage is not None else None
    pending_continuity = None
    try:
        pre_at = collector.now() if callable(getattr(collector, "now", None)) else None
        pre_herdr = local_usage_models.sample_herdr(config, at=pre_at, herdr_runner=herdr_runner)
    except Exception:
        pre_herdr = None
    original_write = getattr(collector, "write_json", None)
    if latest is not None and original_write is not None:
        def write_json(path, value):
            original_write(path, value)
            if path == latest and "trendHistory" in value:
                try:
                    original_write(retained, {key: value[key] for key in ("version", "timeZone", "updatedAt", "trendHistory")})
                except OSError:
                    print("usage stage=token-history status=unavailable", file=sys.stderr, flush=True)
                if pending_continuity is not None and continuity_path is not None:
                    try:
                        original_write(continuity_path, pending_continuity)
                    except OSError:
                        print("usage stage=agent-continuity status=unavailable", file=sys.stderr, flush=True)

        collector.write_json = write_json

    original_aggregate = getattr(collector, "aggregate", None)
    if original_aggregate is not None:
        def aggregate(machines, prs, at, *args, **kwargs):
            machines = local_usage_models.eligible_machines(collector, machines, at)
            if config.get("mergedAdoProjects") or config.get("adoRemotes"):
                try:
                    ado = legacy_ado_commits(config, collector.repository_identity, collector.remote_category,
                                             at=at, snapshot=primary_snapshot)
                except (OSError, ValueError, TypeError, KeyError, AttributeError):
                    ado = {"records": [], "complete": False}
            else:
                ado = {"records": [], "complete": True}
            if ado["records"]:
                machines = [dict(machine) for machine in machines]
                target_machine = next((machine for machine in machines if machine.get("status") != "missing"), None)
                if target_machine is not None:
                    local_records = target_machine.get("commits", [])
                    if not isinstance(local_records, list):
                        raise ValueError("Invalid retained local commit events")
                    target_machine["commits"] = [*local_records, *ado["records"]]
            snapshot = original_aggregate(machines, prs, at, *args, **kwargs)
            if len(snapshot["sources"]) != len(machines):
                raise ValueError("Activity source coverage does not match the collected machines")
            commit_statuses = []
            for source, machine in zip(snapshot["sources"], machines):
                if source.get("device") != machine.get("device"):
                    raise ValueError("Activity source identity does not match the collected machine")
                errors = machine.get("errors")
                git_fetch_only = isinstance(errors, list) and bool(errors) and all(
                    isinstance(error, dict) and error.get("source") == "git-fetch" for error in errors
                )
                fetch_disabled_only = isinstance(errors, list) and bool(errors) and all(
                    isinstance(error, dict)
                    and error.get("source") == "git-fetch"
                    and error.get("code") == "DisabledByAuthBoundary"
                    for error in errors
                )
                source["tokenStatus"] = "ready" if machine.get("status") == "ok" or (
                    machine.get("status") == "partial" and git_fetch_only
                ) else "partial" if machine.get("status") in ("partial", "stale") else "unavailable"
                source["commitStatus"] = "ready" if machine.get("status") == "ok" else (
                    "local-ref-ready" if machine.get("status") == "partial" and fetch_disabled_only
                    and not machine.get("retainedCapturedAt")
                    and not machine.get("retainedCommits")
                    else "partial" if machine.get("status") in ("partial", "stale") else "unavailable"
                )
                if not ado["complete"] and source["commitStatus"] in ("ready", "local-ref-ready"):
                    source["commitStatus"] = "partial"
                if machine.get("status") != "missing":
                    commit_statuses.append(source["commitStatus"])
            day_commit_status = None
            if commit_statuses and all(s == "ready" for s in commit_statuses):
                day_commit_status = "ready"
            elif commit_statuses and all(s in ("ready", "local-ref-ready") for s in commit_statuses):
                day_commit_status = "local-ref-ready"
            if day_commit_status:
                at_instant = collector.instant(at.isoformat() if isinstance(at, dt.datetime) else at)
                tz = getattr(collector, "TZ", dt.timezone(dt.timedelta(hours=8)))
                today_date = at_instant.astimezone(tz).date() if at_instant is not None else None
                active_machines = [machine for machine in machines if machine.get("status") != "missing"]
                machine_windows = []
                for machine in active_machines:
                    m_start = collector.instant(machine.get("start"))
                    m_end = collector.instant(machine.get("capturedAt"))
                    if m_start is None or m_end is None or m_start >= m_end:
                        machine_windows = None
                        break
                    machine_windows.append((m_start, m_end))
                rows_to_mark = list(snapshot.get("daily") or [])
                if isinstance(snapshot.get("localHistory"), dict) and isinstance(snapshot["localHistory"].get("daily"), list):
                    rows_to_mark.extend(snapshot["localHistory"]["daily"])
                for row in rows_to_mark:
                    if not isinstance(row, dict) or "commitStatus" in row:
                        continue
                    row_day = row.get("day")
                    if not isinstance(row_day, str) or machine_windows is None or today_date is None:
                        continue
                    try:
                        row_date = dt.date.fromisoformat(row_day)
                    except ValueError:
                        continue
                    if row_date.isoformat() != row_day or row_date > today_date:
                        continue
                    day_start = dt.datetime.combine(row_date, dt.time(), tz)
                    required_end = at_instant if row_date == today_date else day_start + dt.timedelta(days=1)
                    if all(m_start <= day_start and m_end >= required_end for m_start, m_end in machine_windows):
                        row["commitStatus"] = day_commit_status
            previous = collector.read_json(latest, {}) if latest is not None else {}
            saved = collector.read_json(retained, {}) if retained is not None else {}
            models = local_usage_models.daily_models(collector, machines, snapshot)
            nonlocal pending_continuity
            agents = {}
            try:
                prior_continuity = local_usage_models.load_continuity(continuity_path)
                at_ref = collector.instant(at.isoformat() if isinstance(at, dt.datetime) else at)
                try:
                    post_at = collector.now() if callable(getattr(collector, "now", None)) else at_ref
                    post_herdr = local_usage_models.sample_herdr(config, at=post_at, herdr_runner=herdr_runner)
                except Exception:
                    post_herdr = None
                pending_continuity, intervals = local_usage_models.reconcile_continuity(
                    prior_continuity, pre_herdr, post_herdr, now=at_ref
                )
                agents = local_usage_models.daily_agents(
                    collector, machines, snapshot, config=config, intervals=intervals
                )
            except Exception:
                agents = {}
                print("usage stage=agent-attribution status=unavailable", file=sys.stderr, flush=True)
            return retain_token_history(snapshot, previous, models, saved, agents)

        collector.aggregate = aggregate

    def run(args, timeout=35):
        if str(args[0]) == config["azureCli"]:
            return azure.run(args, timeout)
        if len(args) > 2 and args[2] == "gh":
            return github.run(args, timeout)
        if str(args[0]) == "gh":
            raise ValueError("Direct GitHub CLI is unavailable in scheduled Usage")
        return original_run(args, timeout)

    collector.run = run
    collector.collect = lambda config, device, at=None, history_days=30: collect_local(
        collector_path, config, device, at, history_days
    )
    options = {"upload": publish, "skip_api": skip_api, "reuse_sources": reuse_sources}
    if "history_days" in inspect.signature(collector.refresh).parameters:
        options["history_days"] = 59
    try:
        collector.refresh(config, **options)
    finally:
        if legacy_diagnostics and (config.get("githubProfiles") or config.get("mergedAdoProjects") or config.get("adoRemotes")):
            try:
                local_usage_merged.refresh(config, collector, collector.run, ado_request=azure.request, skip_api=skip_api)
            except Exception as error:
                print("Remote merged Usage unavailable: " + type(error).__name__, file=sys.stderr)
        if legacy_diagnostics and config.get("githubContributionSource") == local_usage_github.DEFINITION:
            try:
                local_usage_github.refresh(config, collector.run, collector.remote_category, skip_api=skip_api)
            except Exception as error:
                print("GitHub contribution Usage unavailable: " + type(error).__name__, file=sys.stderr)


def main():
    if sys.argv[1:] == ["--worker"]:
        return _primary_worker()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/agent-town/activity.json")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--skip-api", action="store_true")
    parser.add_argument("--reuse-sources", action="store_true")
    parser.add_argument("--capture-only", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--previous", type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.expanduser().read_text())
    azure_dir = Path(os.environ.get("AZURE_CONFIG_DIR", str(Path.home() / ".azure"))).expanduser()
    if args.capture_only:
        if args.output is None or args.publish or args.skip_api or args.reuse_sources:
            parser.error("Private capture requires --output and no publication or skip flags")
        return refresh_primary(args.collector.expanduser(), config, azure_dir,
                               file=args.output.expanduser(), previous_file=args.previous,
                               include_legacy=False)
    if args.output is not None or args.previous is not None:
        parser.error("--output and --previous are only available for private capture")
    refresh(args.collector.expanduser(), config, azure_dir, publish=args.publish,
            skip_api=args.skip_api, reuse_sources=args.reuse_sources)


if __name__ == "__main__":
    main()
