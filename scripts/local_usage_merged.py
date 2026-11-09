"""Collect owner-authored merged PRs and their original non-merge commits into a private Usage sidecar."""

import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
from zoneinfo import ZoneInfo


TZ = ZoneInfo("Asia/Shanghai")
DAY = dt.timedelta(days=1)
MAX_HISTORY_DAYS = 191
MAX_SOURCES = 24
MAX_PAGES = 10
MAX_ITEMS = 1000
MAX_FILE_BYTES = 16 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", re.I)
OPAQUE = re.compile(r"[0-9a-f]{64}")
GUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", re.I)

SEARCH = """query($search: String!, $after: String) {
  viewer { login }
  search(query: $search, type: ISSUE, first: 100, after: $after) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { id mergedAt author { login } repository { id nameWithOwner } } }
  }
}"""
COMMITS = """query($id: ID!, $after: String) {
  viewer { login }
  node(id: $id) { ... on PullRequest {
    baseRefOid headRefOid repository { nameWithOwner }
    commits(first: 100, after: $after) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { commit { oid parents(first: 2) { totalCount } } }
    }
  } }
}"""


class PartialResult(Exception):
    def __init__(self, items, reason):
        super().__init__(reason)
        self.items = items
        self.reason = reason


def instant(value):
    if not isinstance(value, str):
        raise ValueError("Invalid merge instant")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Merge instant needs an offset")
    return parsed.astimezone(dt.timezone.utc)


def stamp(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def window(at):
    day = at.astimezone(TZ).date()
    first = day - (MAX_HISTORY_DAYS - 1) * DAY
    start = dt.datetime.combine(first, dt.time.min, TZ).astimezone(dt.timezone.utc)
    return start, first.isoformat()


def checked_json(run, args):
    result = json.loads(run(args, timeout=30))
    if not isinstance(result, dict) or result.get("errors"):
        raise ValueError("Remote Usage response is incomplete")
    return result


def cached_commits(old, at, repository, category):
    if not isinstance(old, dict) or old.get("at") != at or old.get("repository") != repository or old.get("category") != category:
        return None
    keys = old.get("commits")
    if not isinstance(keys, list) or len(keys) > MAX_ITEMS or any(not isinstance(key, str) or not OPAQUE.fullmatch(key) for key in keys) or len(set(keys)) != len(keys):
        return None
    return keys


def previous_snapshot(file):
    try:
        value = json.loads(file.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_private(file, value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("Remote Usage cache exceeds 16 MiB")
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(file.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix=file.name + ".", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.chmod(temporary, 0o600)
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def github_query(config, profile, query, variables, run):
    args = [sys.executable, config["githubHelper"], "gh", profile["profile"], "api", "graphql", "-f", "query=" + query]
    for key, value in variables.items():
        if value is not None:
            args += ["-f", key + "=" + str(value)]
    data = checked_json(run, args)["data"]
    if data["viewer"]["login"].casefold() != profile["login"].casefold():
        raise ValueError("GitHub account mismatch")
    return data


def github_compare_commits(config, profile, pr, total, known, run, monitor):
    base, head = pr["baseRefOid"], pr["headRefOid"]
    repo = pr["repository"]["nameWithOwner"]
    if any(not isinstance(oid, str) or not SHA.fullmatch(oid) for oid in (base, head)):
        raise ValueError("Invalid PR comparison refs")
    if (not isinstance(repo, str) or len(repo) > 300 or len(repo.split("/")) != 2 or
            any(part in (".", "..") or not re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in repo.split("/"))):
        raise ValueError("Invalid PR comparison repository")
    commits, seen = [], {}
    for page in range(1, MAX_PAGES + 1):
        endpoint = "repos/" + repo + "/compare/" + base + "..." + head + "?per_page=100&page=" + str(page)
        data = checked_json(run, [sys.executable, config["githubHelper"], "gh", profile["profile"], "api", endpoint])
        rows = data["commits"]
        if (type(data["total_commits"]) is not int or data["total_commits"] != total or
                data["base_commit"]["sha"].lower() != base.lower() or
                not isinstance(rows, list) or not rows or len(rows) > 100):
            raise ValueError("Incomplete PR comparison page")
        for row in rows:
            oid, parents = row["sha"].lower(), row["parents"]
            if not SHA.fullmatch(oid) or oid in seen or not isinstance(parents, list):
                raise ValueError("Invalid PR comparison commit")
            seen[oid] = len(parents)
            if len(parents) <= 1:
                commits.append(monitor.digest("original-pr-commit", oid))
        if len(seen) >= total:
            if len(seen) != total or any(seen.get(oid) != parents for oid, parents in known.items()):
                raise ValueError("PR comparison does not match original commits")
            return commits
    raise ValueError("PR comparison pagination limit")


def github_commits(config, profile, pr_id, run, monitor):
    commits, seen, cursor, total = [], {}, None, None
    for _ in range(MAX_PAGES):
        data = github_query(config, profile, COMMITS, {"id": pr_id, "after": cursor}, run)
        connection = data["node"]["commits"]
        count = connection["totalCount"]
        if type(count) is not int or count < 0 or count > MAX_ITEMS or total is not None and count != total:
            raise ValueError("Incomplete PR commit count")
        total = count
        for node in connection["nodes"]:
            commit = node["commit"]
            oid = commit["oid"].lower()
            parents = commit["parents"]["totalCount"]
            if not SHA.fullmatch(oid) or type(parents) is not int or parents < 0 or oid in seen:
                raise ValueError("Invalid PR commit page")
            seen[oid] = parents
            if parents <= 1:
                commits.append(monitor.digest("original-pr-commit", oid))
        # GitHub's v4 PR commit connection can stop at 250 nodes while reporting a larger total.
        if total > 250:
            return github_compare_commits(config, profile, data["node"], total, seen, run, monitor)
        page = connection["pageInfo"]
        if not page["hasNextPage"]:
            if len(seen) != total:
                raise ValueError("Incomplete PR commit pages")
            return commits
        next_cursor = page["endCursor"]
        if not next_cursor or next_cursor == cursor:
            raise ValueError("Invalid PR commit cursor")
        cursor = next_cursor
    raise ValueError("PR commit pagination limit")


def github_source(config, profile, previous, start, at, run, monitor):
    host = profile["host"].lower()
    if host != "github.com" and not host.endswith(".ghe.com"):
        raise ValueError("Unsupported GitHub host")
    prior = {item["key"]: item for item in previous.get("items", []) if isinstance(item, dict) and isinstance(item.get("key"), str)}
    items, seen, cursor, expected = [], set(), None, None
    last_second = (at - dt.timedelta(microseconds=1)).replace(microsecond=0)
    search = "is:pr is:merged author:" + profile["login"] + " merged:" + stamp(start) + ".." + stamp(last_second)
    try:
        for _ in range(MAX_PAGES):
            data = github_query(config, profile, SEARCH, {"search": search, "after": cursor}, run)
            result = data["search"]
            count = result["issueCount"]
            if type(count) is not int or count < 0 or count > MAX_ITEMS or expected is not None and count != expected:
                raise ValueError("Incomplete GitHub merge search")
            expected = count
            nodes = result["nodes"]
            if not isinstance(nodes, list) or len(nodes) > 100:
                raise ValueError("Invalid GitHub merge page")
            for row in nodes:
                merged = instant(row["mergedAt"])
                if row["author"]["login"].casefold() != profile["login"].casefold():
                    raise ValueError("GitHub PR author mismatch")
                if not start <= merged < at:
                    raise ValueError("PR outside pinned merge window")
                remote = "https://" + host + "/" + row["repository"]["nameWithOwner"]
                repository = monitor.repository_identity(remote)
                if not repository:
                    raise ValueError("Missing repository identity")
                repository = {**repository, "id": monitor.digest("remote-repo", host, row["repository"]["id"])}
                category = monitor.remote_category(remote, config)
                key = monitor.digest("merged-pr", host, row["id"])
                if key in seen:
                    raise ValueError("Duplicate GitHub PR page")
                seen.add(key)
                commits = cached_commits(prior.get(key), stamp(merged), repository, category)
                if commits is None:
                    commits = github_commits(config, profile, row["id"], run, monitor)
                items.append({"key": key, "at": stamp(merged), "category": category, "repository": repository, "commits": commits})
            page = result["pageInfo"]
            if not page["hasNextPage"]:
                if len(seen) != expected:
                    raise ValueError("Incomplete GitHub merge pages")
                return items
            next_cursor = page["endCursor"]
            if not next_cursor or next_cursor == cursor:
                raise ValueError("Invalid GitHub search cursor")
            cursor = next_cursor
        raise ValueError("GitHub merge pagination limit")
    except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
        raise PartialResult(items, type(error).__name__) from None


def ado_projects(config, monitor):
    projects = {}
    def add(org, project):
        def decode(value):
            if not isinstance(value, str) or re.search(r"%(?![0-9a-f]{2})", value, re.I):
                raise ValueError("Invalid configured ADO project")
            decoded = urllib.parse.unquote(value, errors="strict")
            if not decoded or decoded in (".", "..") or any(char in decoded for char in "/\\\r\n\x00"):
                raise ValueError("Invalid configured ADO project")
            return decoded
        decoded = decode(org), decode(project)
        projects.setdefault(tuple(value.casefold() for value in decoded), decoded)
    for value in config.get("mergedAdoProjects", []):
        parsed = urllib.parse.urlsplit(value)
        parts = parsed.path.strip("/").split("/")
        if (parsed.scheme != "https" or parsed.hostname != "dev.azure.com" or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.query or parsed.fragment or len(parts) != 2
                or not all(parts)):
            raise ValueError("Invalid configured ADO project")
        add(*parts)
    for remote in config.get("adoRemotes", []):
        coords = monitor.ado_coordinates(remote)
        if not coords:
            raise ValueError("Invalid configured ADO remote")
        add(*coords[:2])
    if len(projects) > MAX_SOURCES:
        raise ValueError("Too many configured ADO projects")
    return [projects[key] for key in sorted(projects)]


def ado_get(request, url):
    body, continuation = request(url, 30)
    data = json.loads(body)
    if not isinstance(data, dict) or data.get("errors"):
        raise ValueError("Invalid ADO response")
    return data, continuation or data.get("continuationToken")


def ado_url(org, project, suffix, params):
    base = "https://dev.azure.com/" + "/".join(urllib.parse.quote(value, safe="") for value in (org, project))
    return base + suffix + "?" + urllib.parse.urlencode(params)


def ado_commits(request, org, project, repository_id, pr_id, monitor):
    commits, seen, token, tokens = [], set(), None, set()
    path = "/_apis/git/repositories/" + urllib.parse.quote(repository_id, safe="") + "/pullrequests/" + str(pr_id) + "/commits"
    for _ in range(MAX_PAGES):
        data, next_token = ado_get(request, ado_url(org, project, path, {"api-version": "7.1", "$top": 100,
            **({"continuationToken": token} if token else {})}))
        rows = data["value"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError("Invalid ADO commit page")
        for row in rows:
            oid = row["commitId"].lower()
            if not SHA.fullmatch(oid) or oid in seen:
                raise ValueError("Invalid ADO commit identity")
            seen.add(oid)
            parents = row.get("parents")
            if not isinstance(parents, list):
                detail_path = "/_apis/git/repositories/" + urllib.parse.quote(repository_id, safe="") + "/commits/" + oid
                parents = ado_get(request, ado_url(org, project, detail_path, {"api-version": "7.1"}))[0].get("parents")
            if not isinstance(parents, list):
                raise ValueError("Unknown ADO commit parents")
            if len(parents) <= 1:
                commits.append(monitor.digest("original-pr-commit", oid))
        if not next_token:
            return commits
        if next_token in tokens or not isinstance(next_token, str) or len(next_token) > 1024:
            raise ValueError("Invalid ADO commit continuation")
        tokens.add(next_token)
        token = next_token
    raise ValueError("ADO commit pagination limit")


def ado_source(config, org, project, previous, start, at, request, monitor):
    prior = {item["key"]: item for item in previous.get("items", []) if isinstance(item, dict) and isinstance(item.get("key"), str)}
    items, seen, offset = [], set(), 0
    try:
        identity_url = "https://dev.azure.com/" + urllib.parse.quote(org, safe="") + "/_apis/connectionData?connectOptions=0"
        identity = ado_get(request, identity_url)[0]["authenticatedUser"]
        author = identity.get("properties", {}).get("Account", {}).get("$value", "").casefold()
        owner_id = identity.get("id", "")
        if author not in {email.casefold() for email in config["authorEmails"]} or not GUID.fullmatch(owner_id):
            raise ValueError("ADO account mismatch")
        for _ in range(MAX_PAGES):
            params = {"api-version": "7.1", "searchCriteria.status": "completed", "searchCriteria.creatorId": owner_id,
                      "searchCriteria.queryTimeRangeType": "closed", "searchCriteria.minTime": stamp(start),
                      "searchCriteria.maxTime": stamp(at), "$top": 100, "$skip": offset}
            data, continuation = ado_get(request, ado_url(org, project, "/_apis/git/pullrequests", params))
            if continuation:
                raise ValueError("Unexpected ADO PR continuation")
            rows = data["value"]
            if not isinstance(rows, list) or len(rows) > 100 or "count" in data and data["count"] != len(rows):
                raise ValueError("Invalid ADO PR page")
            if not rows:
                return items
            for row in rows:
                if row.get("status") != "completed" or row.get("createdBy", {}).get("id", "").lower() != owner_id.lower() or row.get("createdBy", {}).get("uniqueName", "").casefold() != author:
                    raise ValueError("ADO PR author mismatch")
                merged = instant(row["closedDate"])
                if not start <= merged < at:
                    raise ValueError("ADO PR outside pinned closed-time window")
                repository_id = row["repository"]["id"]
                project_id = row["repository"]["project"]["id"]
                pr_id = row["pullRequestId"]
                if not GUID.fullmatch(repository_id) or not GUID.fullmatch(project_id) or type(pr_id) is not int or pr_id < 1:
                    raise ValueError("Invalid ADO PR identity")
                repo_name = row["repository"]["name"]
                remote = "https://dev.azure.com/" + "/".join(urllib.parse.quote(value, safe="") for value in (org, project, "_git", repo_name))
                repository = monitor.repository_identity(remote)
                if not repository:
                    raise ValueError("Missing ADO repository identity")
                repository = {**repository, "id": monitor.digest("remote-repo", "dev.azure.com", org.casefold(), project_id.lower(), repository_id.lower())}
                category = monitor.remote_category(remote, config)
                key = monitor.digest("merged-pr", "dev.azure.com", org.casefold(), project_id.lower(), repository_id.lower(), pr_id)
                if key in seen:
                    raise ValueError("Duplicate ADO PR page")
                seen.add(key)
                commits = cached_commits(prior.get(key), stamp(merged), repository, category)
                if commits is None:
                    commits = ado_commits(request, org, project, repository_id, pr_id, monitor)
                items.append({"key": key, "at": stamp(merged), "category": category, "repository": repository, "commits": commits})
            offset += len(rows)
        raise ValueError("ADO PR pagination limit")
    except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
        raise PartialResult(items, type(error).__name__) from None


def refresh(config, monitor, run, *, file=None, at=None, ado_request=None, skip_api=False):
    at = at or dt.datetime.now(dt.timezone.utc)
    if at.tzinfo is None:
        raise ValueError("Remote capture time needs an offset")
    at = at.astimezone(dt.timezone.utc)
    start, start_day = window(at)
    deadline = time.monotonic() + 120
    def bounded_run(args, timeout=30):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Remote Usage collection budget elapsed")
        return run(args, timeout=min(timeout, remaining))
    def bounded_ado(url, timeout=30):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Remote Usage collection budget elapsed")
        if ado_request is None:
            raise ValueError("ADO response headers are unavailable")
        return ado_request(url, min(timeout, remaining))
    file = Path(file or Path.home() / ".local/share/mymausbot/usage/merged-v1.json")
    previous = previous_snapshot(file)
    prior = {source["id"]: source for source in previous.get("sources", [])
             if isinstance(source, dict) and isinstance(source.get("id"), str)} if previous.get("version") == 1 and isinstance(previous.get("sources"), list) else {}
    jobs = []
    for profile in config.get("githubProfiles", []):
        key = monitor.digest("merged-source", profile["host"].lower(), profile["profile"])
        jobs.append((key, "github" if profile["host"].lower() == "github.com" else "ghe", profile.get("category", "unclassified"),
                     lambda old, profile=profile: github_source(config, profile, old, start, at, bounded_run, monitor)))
    for org, project in ado_projects(config, monitor):
        key = monitor.digest("merged-source", "ado", org.casefold(), project.casefold())
        jobs.append((key, "ado", "work", lambda old, org=org, project=project: ado_source(config, org, project, old, start, at, bounded_ado, monitor)))
    if len(jobs) > MAX_SOURCES:
        raise ValueError("Too many configured remote Usage sources")
    sources = []
    for key, provider, category, collect in jobs:
        base = {"id": key, "provider": provider, "category": category, "items": []}
        old = prior.get(key, base)
        old = {**old, "startDay": old.get("startDay", previous.get("windowStartDay", start_day))}
        if skip_api:
            source = {**old, "status": "stale" if old.get("capturedAt") else "unavailable"}
        else:
            try:
                source = {**base, "status": "ready", "capturedAt": stamp(at), "startDay": start_day, "items": collect(old)}
            except PartialResult as error:
                retained = {item["key"]: item for item in old.get("items", []) if isinstance(item, dict) and isinstance(item.get("key"), str)}
                retained.update((item["key"], item) for item in error.items)
                source = {**old, "status": "stale" if old.get("capturedAt") else "partial" if retained else "unavailable",
                          "items": list(retained.values()), "errorCode": error.reason}
            except (OSError, subprocess.SubprocessError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
                source = {**old, "status": "stale" if old.get("capturedAt") else "unavailable", "errorCode": type(error).__name__}
        try:
            source["startDay"] = max(start_day, dt.date.fromisoformat(source.get("startDay", start_day)).isoformat())
            source["items"] = [item for item in source.get("items", []) if start <= instant(item["at"]) < at]
        except (KeyError, TypeError, ValueError):
            source = {**base, "status": "unavailable", "errorCode": "InvalidCache"}
        sources.append(source)
    result = {"version": 1, "asOfAt": stamp(at), "capturedAt": stamp(dt.datetime.now(dt.timezone.utc)),
              "windowStartDay": start_day, "sources": sources}
    write_private(file, result)
    return result
