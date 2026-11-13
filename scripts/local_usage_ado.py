"""Collect verified Azure DevOps activity from remote default-branch history."""

import copy
import datetime as dt
import hashlib
import json
import re
import subprocess
import time
import urllib.parse
from zoneinfo import ZoneInfo


DEFINITION = "ado-default-head-beijing-v1"
RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
DATE_BASIS = {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"}
TZ = ZoneInfo("Asia/Shanghai")
GUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", re.I)
SHA = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", re.I)
COAUTHOR_PREFIX = re.compile(r"^[ \t]*(?i:Co-authored-by):", re.M)
COAUTHOR = re.compile(r"^[ \t]*(?i:Co-authored-by):[ \t]*(?P<name>.+?)[ \t]*<(?P<email>[^<>\s]+@[^<>\s]+)>[ \t]*$", re.M)
COAUTHOR_ESCAPED = re.compile(r"^[ \t]*(?i:Co-authored-by):[ \t]*(?P<name>.+?)[ \t]*&lt;(?P<email>[^<>&\s]+@[^<>&\s]+)&gt;[ \t]*$", re.M)
MAX_PROJECTS = 12
MAX_REPOSITORIES = 2000
MAX_PAGES = 1000
PAGE = 100
REQUESTS_PER_PROJECT = 50
REQUESTS_PER_REPOSITORY = 8
SECONDS_PER_PROJECT = 25
SECONDS_TOTAL = 25


class BudgetExceeded(Exception):
    pass


class RepositoryQuantum(Exception):
    pass


class ReadInterrupted(Exception):
    def __init__(self, stage, status=None):
        self.stage = stage
        self.status = status


class HttpReadError(OSError):
    def __init__(self, status):
        self.status = status


def stamp(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("Invalid ADO timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("ADO timestamp requires an offset")
    return parsed.astimezone(dt.timezone.utc)


def china_day(value):
    return value.astimezone(TZ).date().isoformat()


def window_start(first):
    return dt.datetime.combine(dt.date.fromisoformat(first), dt.time.min, TZ).astimezone(dt.timezone.utc)


def digest(*parts):
    return hashlib.sha256(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()


def reday_proof(proof, previous_start=None):
    if not isinstance(proof, dict) or not isinstance(proof.get("items"), list):
        raise ValueError("Invalid ADO raw commit proof")
    items = []
    for item in proof["items"]:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or not SHA.fullmatch(item["id"]) or type(item.get("merge")) is not bool
                or type(item.get("coauthor")) is not bool):
            raise ValueError("Invalid ADO raw commit proof")
        authored = instant(item["authoredAt"])
        items.append({**item, "day": china_day(authored)})
    start = proof.get("coverageStartAt", previous_start)
    if start is not None:
        instant(start)
    return {**proof, "items": items, **({"coverageStartAt": start} if start is not None else {})}


def segment(value):
    decoded = urllib.parse.unquote(value)
    if not decoded or decoded in (".", "..") or "/" in decoded or "\\" in decoded or len(decoded) > 200:
        raise ValueError("Invalid ADO project scope")
    return decoded


def projects(config):
    found = {}
    scopes = ([(raw, False) for raw in config.get("mergedAdoProjects", [])]
              + [(raw, True) for raw in config.get("adoRemotes", [])])
    for raw, is_remote in scopes:
        parsed = urllib.parse.urlsplit(raw)
        if (parsed.scheme != "https" or parsed.hostname != "dev.azure.com" or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("Invalid configured ADO scope")
        parts = parsed.path.strip("/").split("/")
        repository = None
        if is_remote:
            if len(parts) != 4 or parts[2] != "_git":
                raise ValueError("Invalid configured ADO remote")
            repository = segment(parts[3]).casefold()
            parts = parts[:2]
        elif len(parts) != 2:
            raise ValueError("Invalid configured ADO scope")
        org, project = map(segment, parts)
        key = (org.casefold(), project.casefold())
        if key not in found:
            found[key] = [org, project, set()]
        if repository:
            found[key][2].add(repository)
    if not found or len(found) > MAX_PROJECTS:
        raise ValueError("Configured ADO projects required")
    return [(found[key][0], found[key][1], sorted(found[key][2])) for key in sorted(found)]


def principal(config, org):
    declared = config.get("adoPrincipals", {}).get(org.casefold())
    if not isinstance(declared, dict):
        raise ValueError("Verified ADO organization principal required")
    stable_id, alias = declared.get("stableId"), declared.get("alias")
    if (not isinstance(stable_id, str) or not GUID.fullmatch(stable_id)
            or not isinstance(alias, str) or alias != alias.lower()
            or not re.fullmatch(r"[^@\s]+@[^@\s]+", alias)):
        raise ValueError("Invalid configured ADO organization principal")
    return {"host": "dev.azure.com", "login": alias, "stableId": stable_id.lower()}


def author_aliases(config):
    raw = config.get("adoAuthorEmails")
    if (not isinstance(raw, list) or not 1 <= len(raw) <= 32
            or any(not isinstance(value, str) or not re.fullmatch(r"[^@\s]+@[^@\s]+", value)
                   for value in raw)):
        return None
    emails = {value.casefold() for value in raw}
    return emails if len(emails) == len(raw) else None


def url(org, project, path, **params):
    pieces = [org] + ([project] if project else [])
    base = "https://dev.azure.com/" + "/".join(urllib.parse.quote(value, safe="") for value in pieces)
    return base + path + "?" + urllib.parse.urlencode({"api-version": "7.1", **params})


class Reader:
    def __init__(self, config, run, end):
        self.config = config
        self.run = run
        self.end = end
        self.source_end = 0
        self.calls = 0
        self.source_calls = 0
        self.repo_limit = None

    def get(self, target, stage="authenticated"):
        remaining = min(self.end, self.source_end) - time.monotonic()
        if self.source_calls >= REQUESTS_PER_PROJECT or remaining <= 0:
            raise BudgetExceeded("ADO request budget exhausted")
        if self.repo_limit is not None and self.source_calls >= self.repo_limit:
            raise RepositoryQuantum("ADO repository quantum exhausted")
        args = [self.config["azureCli"], "rest", "--method", "get", "--url", target,
                "--resource", RESOURCE, "-o", "json"]
        self.calls += 1
        self.source_calls += 1
        try:
            raw = self.run(args, timeout=min(20, remaining))
        except HttpReadError as error:
            if error.status in (408, 429) or 500 <= error.status <= 599:
                raise ReadInterrupted(stage, error.status) from None
            raise ValueError(f"ADO {stage} HTTP {error.status}") from None
        except (OSError, subprocess.SubprocessError):
            raise ReadInterrupted(stage) from None
        except (ValueError, TypeError):
            raise ValueError(f"ADO {stage} read unavailable") from None
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            raise ValueError("Invalid ADO response") from None
        if not isinstance(body, dict) or body.get("errors") or body.get("continuationToken"):
            raise ValueError("Invalid or unpaged ADO response")
        return body


def rows(body, limit=PAGE):
    values = body.get("value")
    if (not isinstance(values, list) or len(values) > limit
            or "count" in body and body["count"] != len(values)):
        raise ValueError("Invalid ADO page")
    return values


def identity(reader, org, expected):
    target = "https://dev.azure.com/" + urllib.parse.quote(org, safe="") + "/_apis/connectionData?connectOptions=0"
    body = reader.get(target)
    actual = body["authenticatedUser"]
    stable_id = actual.get("id", "")
    alias = actual.get("properties", {}).get("Account", {}).get("$value", "")
    if (not isinstance(stable_id, str) or stable_id.lower() != expected["stableId"]
            or not isinstance(alias, str) or alias.casefold() != expected["login"]):
        raise ValueError("ADO organization principal mismatch")


def inventory(reader, org, project):
    data = reader.get(url(org, project, "/_apis/git/repositories", includeHidden="true"))
    repos = rows(data, MAX_REPOSITORIES)
    result = {}
    for row in repos:
        repo_id, name = row["id"], row["name"]
        branch = row.get("defaultBranch")
        if (not isinstance(repo_id, str) or not GUID.fullmatch(repo_id)
                or not isinstance(name, str) or not name or len(name) > 200
                or branch is not None and (not isinstance(branch, str) or not branch.startswith("refs/heads/"))
                or type(row.get("isDisabled")) is not bool):
            raise ValueError("Invalid ADO repository inventory")
        repo_id = repo_id.lower()
        if repo_id in result:
            raise ValueError("Duplicate ADO repository inventory")
        result[repo_id] = {"id": repo_id, "name": name, "defaultBranch": branch,
                           "isDisabled": row["isDisabled"]}
    return [result[key] for key in sorted(result)]


def pr_page(reader, org, project, account, offset, start=None, end=None):
    criteria = {
        "searchCriteria.status": "all", "searchCriteria.creatorId": account["stableId"],
        "$top": PAGE, "$skip": offset}
    if start is not None:
        criteria.update({"searchCriteria.minTime": start, "searchCriteria.maxTime": end,
                         "searchCriteria.queryTimeRangeType": "created"})
    body = reader.get(url(org, project, "/_apis/git/pullrequests", **criteria))
    return rows(body)


def add_prs(work, page, account, inventory_ids):
    seen = set(work["prSeen"])
    pending = []
    for row in page:
        pr_id = row["pullRequestId"]
        repo_id = row["repository"]["id"].lower()
        creator = row["createdBy"]
        if (type(pr_id) is not int or pr_id < 1 or repo_id not in inventory_ids
                or row.get("status") not in ("active", "completed", "abandoned")
                or creator.get("id", "").lower() != account["stableId"]
                or creator.get("uniqueName", account["login"]).casefold() != account["login"]):
            raise ValueError("Invalid ADO PR creator, repository or page")
        if pr_id in seen:
            raise ValueError("Duplicate ADO PR page")
        seen.add(pr_id)
        created = instant(row["creationDate"])
        query_start = instant(work["prQueryStartAt"]) if work.get("prQueryStartAt") else None
        if query_start is not None and (created < query_start or created > instant(work["cutoff"])):
            raise ValueError("ADO PR lies outside requested creation window")
        if work["firstDay"] <= china_day(created) <= work["lastDay"] and created <= instant(work["cutoff"]):
            pending.append({"id": pr_id, "repo": repo_id, "day": china_day(created), "createdAt": stamp(created)})
    work["prs"].extend(pending)
    work["prSeen"] = sorted(seen)


def reset_pr_pages(work):
    start = instant(work["prQueryStartAt"]) if work.get("prQueryStartAt") else None
    retained = [item for item in work["prs"] if instant(item["createdAt"]) < start] if start else []
    work.update({"prOffset": 0, "prSeen": [], "prFirst": None,
                 "prs": retained, "prComplete": False})


def default_head(reader, org, project, repo):
    branch = repo["defaultBranch"]
    path = "/_apis/git/repositories/" + repo["id"] + "/refs"
    page = rows(reader.get(url(org, project, path, filter=branch[len("refs/"):]), "default-head"), 100)
    exact = [row for row in page if row.get("name") == branch]
    if len(exact) != 1 or not SHA.fullmatch(exact[0].get("objectId", "")):
        raise ValueError("ADO default branch head unavailable")
    return exact[0]["objectId"].lower()


def commit_page(reader, org, project, repo_id, head, offset, start=None, end=None):
    path = "/_apis/git/repositories/" + repo_id + "/commits"
    criteria = {
        "searchCriteria.itemVersion.version": head,
        "searchCriteria.itemVersion.versionType": "commit", "$top": PAGE, "$skip": offset}
    if start is not None:
        criteria.update({"searchCriteria.fromDate": start, "searchCriteria.toDate": end})
    body = reader.get(url(org, project, path, **criteria), "focused-commits" if start else "pinned-commits")
    return rows(body)


def credited_commit(reader, org, project, repo_id, item, emails, first):
    authored = instant(item["author"]["date"])
    day = china_day(authored)
    if day < first:
        return None
    commit_id = item["commitId"].lower()
    detail = item
    if (detail.get("commentTruncated") is not False or not isinstance(detail.get("comment"), str)
            or not isinstance(detail.get("parents"), list)):
        path = "/_apis/git/repositories/" + repo_id + "/commits/" + commit_id
        detail = reader.get(url(org, project, path), "commit-detail")
    truncated = detail.get("commentTruncated", False)
    if (detail.get("commitId", "").lower() != commit_id
            or type(truncated) is not bool or truncated):
        raise ValueError("Incomplete ADO commit detail")
    if instant(detail["author"]["date"]) != authored:
        raise ValueError("ADO author date changed during scan")
    comment = detail.get("comment")
    if not isinstance(comment, str):
        raise ValueError("Invalid ADO commit comment")
    matches = [*COAUTHOR.finditer(comment), *COAUTHOR_ESCAPED.finditer(comment)]
    if (sorted(match.start() for match in matches) != [match.start() for match in COAUTHOR_PREFIX.finditer(comment)]
            or any(not match.group("name").strip() or re.search(r"[<>]|&(?:lt|gt|amp);", match.group("name"), re.I)
                   for match in matches)):
        raise ValueError("Invalid ADO commit comment")
    coauthors = {match.group("email").casefold() for match in matches}
    author_email = detail["author"].get("email", "").casefold()
    if author_email not in emails and not coauthors.intersection(emails):
        return None
    parents = detail.get("parents")
    if not isinstance(parents, list) or any(not isinstance(p, str) or not SHA.fullmatch(p) for p in parents):
        raise ValueError("Unknown ADO commit parentage")
    return {"id": commit_id, "day": day, "authoredAt": stamp(authored), "merge": len(parents) > 1,
            "coauthor": author_email not in emails}


def new_work(at, focus_start=None, retained_prs=None):
    end = at.astimezone(TZ).date()
    return {"cutoff": stamp(at), "firstDay": (end - dt.timedelta(days=59)).isoformat(),
            "lastDay": end.isoformat(), "inventory": None, "prOffset": 0, "prSeen": [],
            "prFirst": None, "prQueryStartAt": stamp(window_start(focus_start.isoformat())) if focus_start else None,
            "prs": [item for item in retained_prs or []
                    if (end - dt.timedelta(days=59)).isoformat() <= item["day"] < focus_start.isoformat()]
                    if focus_start else [], "prComplete": False, "repoIndex": 0,
            "repoDone": {}, "progress": {}, "repoErrors": {}, "activeCursor": 0,
            "scanComplete": False, "selectedRepoIds": [], "reasons": []}


def advance_prs(reader, org, project, account, work):
    if work["prComplete"]:
        return
    inventory_ids = {row["id"] for row in work["inventory"]}
    while work["prOffset"] // PAGE < MAX_PAGES:
        page = pr_page(reader, org, project, account, work["prOffset"],
                       work.get("prQueryStartAt"), work["cutoff"])
        ids = [row["pullRequestId"] for row in page]
        try:
            add_prs(work, page, account, inventory_ids)
        except ValueError as error:
            if str(error) == "Duplicate ADO PR page":
                reset_pr_pages(work)
            raise
        if work["prFirst"] is None:
            work["prFirst"] = ids
        work["prOffset"] += len(page)
        if len(page) < PAGE:
            check = pr_page(reader, org, project, account, 0, work.get("prQueryStartAt"), work["cutoff"])
            if [row["pullRequestId"] for row in check] != work["prFirst"]:
                reset_pr_pages(work)
                raise ValueError("ADO PR pages changed during scan")
            work["prComplete"] = True
            return
    raise ValueError("ADO PR pagination limit")


def advance_repository(reader, org, project, repo, work, cache, emails):
    repo_id = repo["id"]
    progress = work["progress"].get(repo_id)
    prior = cache.get(repo_id)
    prior_checked = set(prior.get("checked", [])) if prior else set()
    prior_items = {item["id"]: item for item in prior["items"]} if prior else {}
    if progress is None:
        head = default_head(reader, org, project, repo)
        if (prior and prior.get("head") == head and prior.get("branch") == repo["defaultBranch"]
                and prior.get("coverageStartAt") is not None
                and instant(prior["coverageStartAt"]) <= window_start(work["firstDay"])):
            work["repoDone"][repo_id] = {**prior, "items": [item for item in prior["items"]
                if work["firstDay"] <= item["day"]]}
            return
        progress = {"branch": repo["defaultBranch"], "head": head,
                    "offset": 0, "seen": [], "pending": [], "items": [], "checked": [],
                    "endPage": False, "pinnedAt": stamp(dt.datetime.now(dt.timezone.utc)),
                    "focusOffset": 0, "focusSeen": [], "focusComplete": False}
        work["progress"][repo_id] = progress
    if progress["branch"] != repo["defaultBranch"]:
        work["progress"].pop(repo_id)
        raise ValueError("Incompatible ADO repository continuation")
    if (prior and progress["offset"] == 0 and not progress["pending"]
            and work.get("prQueryStartAt") and not progress.get("focusComplete")):
        focus_seen = set(progress.get("focusSeen", []))
        for _ in range(4):
            page = commit_page(reader, org, project, repo_id, progress["head"], progress["focusOffset"],
                               work["prQueryStartAt"], work["cutoff"])
            for row in page:
                oid = row["commitId"].lower()
                if not SHA.fullmatch(oid) or oid in focus_seen:
                    raise ValueError("Invalid or duplicate ADO focus commit")
                focus_seen.add(oid)
                if (row.get("commentTruncated") is False and isinstance(row.get("comment"), str)
                        and isinstance(row.get("parents"), list)):
                    credited = credited_commit(reader, org, project, repo_id, row, emails, work["firstDay"])
                    if credited:
                        progress["items"].append(credited)
            progress["focusSeen"] = sorted(focus_seen)
            progress["focusOffset"] += len(page)
            if len(page) < PAGE:
                progress["focusComplete"] = True
                break
        if not progress["focusComplete"]:
            return
    prefetched = {item["id"]: item for item in progress["items"]}
    while True:
        if not progress["pending"] and not progress["endPage"]:
            if progress["offset"] // PAGE >= MAX_PAGES:
                raise ValueError("ADO commit pagination limit")
            page = commit_page(reader, org, project, repo_id, progress["head"], progress["offset"])
            known = set(progress["seen"])
            pending = []
            for row in page:
                oid = row["commitId"].lower()
                if not SHA.fullmatch(oid) or oid in known:
                    raise ValueError("Invalid or duplicate ADO commit")
                known.add(oid)
                entry = {"commitId": oid, "author": {"date": row["author"]["date"]}}
                if (row.get("commentTruncated") is False and isinstance(row.get("comment"), str)
                        and isinstance(row.get("parents"), list)
                        and china_day(instant(row["author"]["date"])) >= work["firstDay"]):
                    entry["credited"] = credited_commit(reader, org, project, repo_id, row, emails,
                                                         work["firstDay"])
                pending.append(entry)
            progress["seen"] = sorted(known)
            progress["pending"] = pending
            progress["offset"] += len(page)
            progress["endPage"] = len(page) < PAGE
        while progress["pending"]:
            item = progress["pending"][0]
            oid = item["commitId"]
            candidate = china_day(instant(item["author"]["date"])) >= work["firstDay"]
            if candidate and oid in prior_checked:
                credited = prior_items.get(oid)
            elif oid in prefetched:
                credited = prefetched[oid]
            elif "credited" in item:
                credited = item["credited"]
            else:
                credited = credited_commit(reader, org, project, repo_id, item, emails, work["firstDay"])
            if credited and oid not in prefetched:
                progress["items"].append(credited)
            if candidate:
                progress["checked"].append(oid)
            progress["pending"].pop(0)
        if progress["endPage"]:
            items = progress["items"]
            if len({item["id"] for item in items}) != len(items) or not set(prefetched).issubset(progress["seen"]):
                raise ValueError("Duplicate ADO commit attribution")
            relation = ("descendant" if prior["head"] in progress["seen"] else "rewritten") if prior else "initial"
            proof = {"head": progress["head"], "branch": repo["defaultBranch"],
                     "items": items, "checked": sorted(set(progress["checked"])),
                     "pinnedAt": progress["pinnedAt"], "relation": relation,
                     "coverageStartAt": stamp(window_start(work["firstDay"]))}
            cache[repo_id] = proof
            current_head = default_head(reader, org, project, repo)
            if current_head != progress["head"]:
                work["progress"].pop(repo_id)
                work["repoErrors"][repo_id] = "head-changed-during-scan"
                return
            work["repoDone"][repo_id] = proof
            work["progress"].pop(repo_id)
            return


def advance_repos(reader, org, project, work, cache, emails):
    if not work["prComplete"]:
        return
    selected = set(work.get("selectedRepoIds", []))
    repos = [repo for repo in work["inventory"] if repo["id"] in selected]
    indexed = {repo["id"]: repo for repo in repos}
    processed = set()

    def process(repo):
        repo_id = repo["id"]
        if repo_id in work["repoDone"] or repo_id in work["repoErrors"]:
            return
        if repo["isDisabled"]:
            if "disabled-repository" not in work["reasons"]:
                work["reasons"].append("disabled-repository")
            return
        if not repo["defaultBranch"]:
            work["repoDone"][repo_id] = {"head": None, "branch": None, "items": []}
            return
        reader.repo_limit = reader.source_calls + REQUESTS_PER_REPOSITORY
        try:
            advance_repository(reader, org, project, repo, work, cache, emails)
        except RepositoryQuantum:
            pass
        except (OSError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            work["repoErrors"][repo_id] = ("unavailable-default-head"
                if isinstance(error, ValueError) and str(error) == "ADO default branch head unavailable"
                else str(error) if isinstance(error, ValueError) else "repository-read-failure")
            work["progress"].pop(repo_id, None)
        finally:
            reader.repo_limit = None

    active = sorted(work["progress"])
    if active:
        start = work["activeCursor"] % len(active)
        for offset in range(len(active)):
            repo_id = active[(start + offset) % len(active)]
            work["activeCursor"] += 1
            process(indexed[repo_id])
            processed.add(repo_id)
    while work["repoIndex"] < len(repos):
        repo = repos[work["repoIndex"]]
        if repo["id"] not in processed:
            process(repo)
        work["repoIndex"] += 1
    while work["progress"] and reader.source_calls < REQUESTS_PER_PROJECT:
        active = sorted(work["progress"])
        start = work["activeCursor"] % len(active)
        before = reader.source_calls
        for offset in range(len(active)):
            repo_id = active[(start + offset) % len(active)]
            work["activeCursor"] += 1
            process(indexed[repo_id])
        if reader.source_calls == before:
            break
    work["scanComplete"] = not work["progress"]
    if not work["scanComplete"]:
        work["repoIndex"] = 0


def source_days(work, cache, org, project, categories, captured_at, complete, verified, visibility_complete):
    repos = {row["id"]: row for row in work["inventory"] or []}
    selected = set(work.get("selectedRepoIds", []))
    prs = [item for item in work["prs"] if item["repo"] in selected]
    known_proofs = dict(work["repoDone"])
    for repo_id, progress in work["progress"].items():
        prior = cache.get(repo_id)
        known_proofs[repo_id] = (prior if prior and prior.get("head") == progress.get("head")
                                else progress)
    commits = [(repo_id, item) for repo_id, result in known_proofs.items()
               for item in result["items"] if repo_id in selected and instant(item["authoredAt"]) <= instant(work["cutoff"])]
    if len({(repo_id, item["id"]) for repo_id, item in commits}) != len(commits):
        raise ValueError("Duplicate repository commit key")
    output = []
    first = dt.date.fromisoformat(work["firstDay"])
    pr_exact = verified and visibility_complete and work["prComplete"]
    commit_proven = verified and work["scanComplete"] and selected.issubset(work["repoDone"])
    for offset in range(60):
        day = (first + dt.timedelta(days=offset)).isoformat()
        pr_rows = [item for item in prs if item["day"] == day]
        commit_rows = [(repo, item) for repo, item in commits if item["day"] == day]
        repository_days = []
        for repo_id in sorted({item["repo"] for item in pr_rows} | {repo for repo, _ in commit_rows}):
            repo = repos[repo_id]
            p = sum(item["repo"] == repo_id for item in pr_rows)
            c = sum(key == repo_id for key, _ in commit_rows)
            repo_pr_exact = verified and work["prComplete"]
            repo_commit_exact = verified and repo_id in work["repoDone"] and not repo["isDisabled"]
            repo_complete = repo_pr_exact and repo_commit_exact
            repository_days.append({"id": digest("ado-repo", org.casefold(), repo_id),
                "name": org + "/" + project + "/" + repo["name"], "category": categories[repo_id],
                "prs": p if repo_pr_exact else None, "knownPrs": p if verified and (p or work["prComplete"]) else None,
                "commits": c if repo_commit_exact else None,
                "knownCommits": c if verified and (c or repo_id in work["repoDone"]) else None,
                "status": "ready" if repo_complete else "partial" if verified else "unavailable"})
        p = len(pr_rows)
        c = len(commit_rows)
        output.append({"day": day, "capturedAt": captured_at,
            "status": "ready" if complete else "partial" if verified else "unavailable",
            "prs": p if pr_exact else None,
            "knownPrs": p if verified and (p or work["prComplete"]) else None,
            "commits": c if complete else None,
            "knownCommits": c if verified and (c or commit_proven) else None,
            "repositories": repository_days})
    return output


def collect(config, run, repository_category, *, at=None, days=60, previous=None, focus_start=None):
    if type(days) is not int or days != 60:
        raise ValueError("ADO collection requires exactly 60 Beijing dates")
    at = at or dt.datetime.now(dt.timezone.utc)
    if at.tzinfo is None:
        raise ValueError("ADO capture time requires an offset")
    at = at.astimezone(dt.timezone.utc).replace(microsecond=0)
    if focus_start is not None:
        focus_start = dt.date.fromisoformat(focus_start) if isinstance(focus_start, str) else focus_start
        if not isinstance(focus_start, dt.date) or focus_start > at.astimezone(TZ).date():
            raise ValueError("Invalid ADO focus window")
    configured = projects(config)
    old_state = {}
    compatible_state = False
    legacy_basis = False
    previous_start = None
    if previous is not None:
        if (not isinstance(previous, dict) or previous.get("version") != 2
                or previous.get("provider") != "ado"):
            raise ValueError("Cannot resume a different ADO metric")
        legacy_basis = (previous.get("metricDefinition") == "ado-default-head-v1"
                        and previous.get("dateBasis") == {"prs": "created-at/UTC", "commits": "author-at/UTC"})
        if not legacy_basis and (previous.get("metricDefinition") != DEFINITION
                                 or previous.get("dateBasis") != DATE_BASIS):
            raise ValueError("Cannot resume a different ADO date basis")
        if legacy_basis:
            previous_start = stamp(dt.datetime.combine(
                dt.date.fromisoformat(previous["operationWindow"]["startDay"]), dt.time.min, dt.timezone.utc))
        state = previous.get("state", {})
        if not isinstance(state, dict) or state.get("schema") not in (1, 2, 3):
            raise ValueError("Invalid ADO continuation schema")
        compatible_state = state["schema"] == 3
        old_state = state.get("projects", {}) if compatible_state else {}
        if not isinstance(old_state, dict):
            raise ValueError("Invalid ADO continuation")
    started = time.monotonic()
    reader = Reader(config, run, started + SECONDS_TOTAL)
    sources, states, source_ids = [], {}, []
    discovered_repositories = set()
    old_sources = ({source["id"]: source for source in previous.get("sources", [])}
                   if compatible_state and not legacy_basis and isinstance(previous.get("sources"), list) else {})
    if old_sources and len(old_sources) != len(previous.get("sources", [])):
        raise ValueError("Duplicate retained ADO source")
    emails = author_aliases(config)
    email_hash = digest("ado-author-aliases", sorted(emails)) if emails else None
    for source_index, (org, project, configured_names) in enumerate(configured):
        account = principal(config, org)
        scope = org.casefold() + "/" + project.casefold()
        scope_hash = digest("ado-remotes", scope, configured_names)
        source_id = digest("ado", "dev.azure.com", scope, account["stableId"])
        source_ids.append(source_id)
        prior = copy.deepcopy(old_state.get(scope, {}))
        if prior and prior.get("account") != account:
            prior = {}
        if prior and not isinstance(prior.get("cache"), dict):
            raise ValueError("Invalid ADO continuation cache")
        if prior.get("emailHash") != email_hash:
            prior = {}
        prior_scope = prior.get("expectedRepositoryScope")
        if prior_scope not in (None, "selected", "legacy-unresolved"):
            raise ValueError("Invalid ADO expected repository scope")
        same_scope = prior.get("remoteScopeHash") == scope_hash
        old_cache = {key: reday_proof(value, previous_start) for key, value in prior.get("cache", {}).items()}
        cache = old_cache if same_scope else {}
        prior_work = prior.get("work")
        expected_ids = set()
        unresolved_scope = same_scope and prior_scope == "legacy-unresolved"
        if same_scope:
            if prior_scope is not None:
                expected_ids = set(prior.get("expectedRepositoryIds", []))
                expected_ids.update(cache)
            else:
                selected_before = set(prior_work.get("selectedRepoIds", [])) if isinstance(prior_work, dict) else set()
                if selected_before:
                    expected_ids = selected_before
                elif cache:
                    expected_ids = set(cache)
                else:
                    expected_ids = set(prior.get("expectedRepositoryIds", []))
                    unresolved_scope = bool(expected_ids)
        work = None if legacy_basis else prior_work
        rollover_progress = {}
        new_first = (at.astimezone(TZ).date() - dt.timedelta(days=59)).isoformat()
        reset_for_full = isinstance(work, dict) and focus_start is None and work.get("prQueryStartAt") is not None
        reset_for_focus = (isinstance(work, dict) and focus_start is not None
            and work.get("prQueryStartAt") is None and work.get("prComplete") is True
            and not work.get("scanComplete"))
        if (isinstance(work, dict) and not work.get("scanComplete")
                and isinstance(work.get("firstDay"), str)
                and work["firstDay"] <= new_first
                and (work["firstDay"] < new_first or not same_scope or reset_for_full or reset_for_focus)):
            rollover_progress = work["progress"]
            active_cursor = work["activeCursor"]
        if (not isinstance(work, dict) or work.get("firstDay") != new_first
                or work.get("scanComplete") or not same_scope or reset_for_full or reset_for_focus):
            can_focus = (focus_start is not None and focus_start.isoformat() >= new_first
                         and same_scope and isinstance(prior_work, dict) and prior_work.get("prComplete") is True
                         and isinstance(prior_work.get("prs"), list))
            work = new_work(at, focus_start if can_focus else None,
                            prior_work["prs"] if can_focus else None)
        reader.source_calls = 0
        source_started = time.monotonic()
        remaining_sources = len(configured) - source_index
        reader.source_end = min(reader.end, source_started + SECONDS_PER_PROJECT,
                                source_started + max(0, reader.end - source_started) / remaining_sources)
        reasons = ["legacy-repository-scope-unresolved"] if unresolved_scope else []
        verified = False
        try:
            if emails is None:
                raise ValueError("Confirmed ADO author aliases required")
            identity(reader, org, account)
            verified = True
            if work["inventory"] is None:
                work["inventory"] = inventory(reader, org, project)
            if rollover_progress:
                indexed = {repo["id"]: repo for repo in work["inventory"]}
                work["progress"] = {repo_id: progress for repo_id, progress in rollover_progress.items()
                    if (repo_id in indexed and not indexed[repo_id]["isDisabled"]
                        and indexed[repo_id]["defaultBranch"] == progress["branch"])}
                work["activeCursor"] = active_cursor
            observed_ids = {repo["id"] for repo in work["inventory"]}
            observed_names = {repo["name"].casefold() for repo in work["inventory"]}
            if expected_ids - observed_ids or set(configured_names) - observed_names:
                if "repository-visibility-gap" not in work["reasons"]:
                    work["reasons"].append("repository-visibility-gap")
            if not work["inventory"] and not expected_ids and not configured_names:
                if "empty-inventory-unverified" not in work["reasons"]:
                    work["reasons"].append("empty-inventory-unverified")
            inventory_keys = {(org.casefold(), row["id"]) for row in work["inventory"]}
            if inventory_keys.intersection(discovered_repositories):
                work = new_work(at)
                raise ValueError("Overlapping ADO project discovery")
            discovered_repositories.update(inventory_keys)
            by_name = {}
            for repo in work["inventory"]:
                by_name.setdefault(repo["name"].casefold(), []).append(repo["id"])
            selected = sorted(by_name[name][0] for name in configured_names if len(by_name.get(name, [])) == 1)
            if same_scope and expected_ids and set(selected) != expected_ids:
                if "configured-repository-identity-changed" not in work["reasons"]:
                    work["reasons"].append("configured-repository-identity-changed")
                selected = sorted(set(selected) & expected_ids)
            if selected != work.get("selectedRepoIds", []):
                work["repoIndex"] = 0
                work["scanComplete"] = False
            work["selectedRepoIds"] = selected
            selected_ids = set(selected)
            expected_ids.update(selected_ids)
            cache = {key: value for key, value in old_cache.items() if key in selected_ids}
            work["progress"] = {key: value for key, value in work["progress"].items() if key in selected_ids}
            work["repoDone"] = {key: value for key, value in work["repoDone"].items() if key in selected_ids}
            work["repoErrors"] = {key: value for key, value in work["repoErrors"].items() if key in selected_ids}
            work["reasons"] = [reason for reason in work["reasons"]
                               if reason not in ("configured-repository-scope", "disabled-repository")]
            if not configured_names and "ado-remotes-required" not in work["reasons"]:
                work["reasons"].append("ado-remotes-required")
            if (any(len(by_name.get(name, [])) > 1 for name in configured_names)
                    and "ambiguous-configured-repository" not in work["reasons"]):
                work["reasons"].append("ambiguous-configured-repository")
            if any(repo["isDisabled"] and repo["id"] in selected_ids for repo in work["inventory"]):
                work["reasons"].append("disabled-repository")
            advance_prs(reader, org, project, account, work)
            advance_repos(reader, org, project, work, cache, emails)
        except (BudgetExceeded, ReadInterrupted, OSError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            reasons.append("request-budget" if isinstance(error, BudgetExceeded)
                           else (f"{error.stage}-read-interrupted" +
                                 (f"-http-{error.status}" if error.status is not None else ""))
                           if isinstance(error, ReadInterrupted)
                           else str(error) if isinstance(error, ValueError) else "read-failure")
        cache = {**cache, **work["repoDone"]}
        reasons += work["reasons"] + list(work["repoErrors"].values())
        if any(repo_id not in work["repoDone"] and repo_id in work["progress"]
               and repo_id in cache and (cache[repo_id].get("coverageStartAt") is None
                   or instant(cache[repo_id]["coverageStartAt"]) > window_start(work["firstDay"]))
               for repo_id in work.get("selectedRepoIds", [])):
            reasons.append("history-start-unverified")
        if work["progress"]:
            reasons.append("history-incomplete")
        reasons = sorted(set(reasons))
        selected_ids = set(work.get("selectedRepoIds", []))
        pagination_complete = (work["prComplete"] and work["scanComplete"] and not work["repoErrors"]
            and all(repo_id in work["repoDone"] for repo_id in selected_ids))
        visibility_complete = (verified and bool(work["inventory"])
            and len(selected_ids) == len(configured_names) > 0
            and not any(repo["isDisabled"] and repo["id"] in selected_ids for repo in work["inventory"])
            and not (expected_ids - selected_ids)
            and not (set(configured_names) - {repo["name"].casefold() for repo in work["inventory"]}))
        complete = verified and pagination_complete and visibility_complete and not reasons
        captured_at = stamp(dt.datetime.now(dt.timezone.utc))
        categories = {}
        for repo in work["inventory"] or []:
            remote = "https://dev.azure.com/" + "/".join(urllib.parse.quote(value, safe="")
                for value in (org, project, "_git", repo["name"]))
            categories[repo["id"]] = repository_category(remote, config)
        if any(value not in ("work", "personal", "unclassified") for value in categories.values()):
            raise ValueError("Invalid repository category")
        source = {"id": source_id, "account": account,
                  "scope": {"organization": org, "project": project},
                  "status": "ready" if complete else "partial" if verified else "unavailable",
                  "coverage": {"identityVerified": verified,
                               "paginationComplete": pagination_complete,
                               "visibilityComplete": visibility_complete,
                               "reasons": reasons},
                  "days": source_days(work, cache, org, project, categories, captured_at,
                                      complete, verified, visibility_complete),
                  "provenance": {"scopeDefinition": "explicit-configured-repositories",
                      "inventoryCount": len(work["inventory"] or []),
                      "configuredRepositoryCount": len(configured_names),
                      "selectedRepositoryCount": len(work.get("selectedRepoIds", [])),
                      "selectedRepositoryIds": sorted(selected_ids),
                      "expectedRepositoryCount": len(expected_ids),
                      "missingRepositoryCount": len(expected_ids - {repo["id"] for repo in work["inventory"] or []}),
                      "missingConfiguredCount": len(set(configured_names) -
                          {repo["name"].casefold() for repo in work["inventory"] or []}),
                      "disabledCount": sum(repo["isDisabled"] for repo in work["inventory"] or []),
                      "withoutDefaultCount": sum(not repo["defaultBranch"] for repo in work["inventory"] or []),
                      "completedRepositories": len(work["repoDone"]), "prPages": (work["prOffset"] + PAGE - 1) // PAGE,
                      "pinnedHeads": {key: value["head"] for key, value in work["repoDone"].items()},
                      "sourceCutoffAt": work["cutoff"]}}
        if not complete and emails is not None and prior and same_scope:
            old_days = {day["day"]: day for day in old_sources.get(source_id, {}).get("days", [])
                        if day.get("status") in ("ready", "stale")}
            source["days"] = [{**old_days[day["day"]], "status": "stale"} if day["day"] in old_days else day
                              for day in source["days"]]
            if old_days and all(day["status"] == "stale" for day in source["days"]):
                source["status"] = "stale"
        sources.append(source)
        states[scope] = {"account": account, "emailHash": email_hash,
                         "remoteScopeHash": scope_hash,
                         "expectedRepositoryScope": "legacy-unresolved" if unresolved_scope else "selected",
                         "expectedRepositoryIds": sorted(expected_ids), "cache": cache, "work": work}
    captured = stamp(dt.datetime.now(dt.timezone.utc))
    return {"version": 2, "metricDefinition": DEFINITION, "provider": "ado",
            "asOfAt": min(source["provenance"]["sourceCutoffAt"] for source in sources),
            "capturedAt": captured, "dateBasis": DATE_BASIS,
            "operationWindow": {"startDay": (at.astimezone(TZ).date() - dt.timedelta(days=59)).isoformat(),
                                "endDay": at.astimezone(TZ).date().isoformat(), "todayPartial": True},
            "activeSourceIds": source_ids, "sources": sources,
            "collection": {"requestCount": reader.calls, "elapsedSeconds": round(time.monotonic() - started, 3),
                           "complete": all(source["status"] == "ready" for source in sources),
                           "reasons": sorted({reason for source in sources
                                              for reason in source["coverage"]["reasons"]})},
            "state": {"schema": 3, "projects": states}}


def adopt_saved_proofs(config, envelope, proofs, responses, repository_category):
    from local_usage_contributions import envelope as validate_envelope

    validate_envelope(envelope, "ado")
    if "state" in envelope or not isinstance(proofs, list) or len(proofs) != 2 or not isinstance(responses, dict) or not 1 <= len(responses) <= 10_000:
        raise ValueError("Invalid ADO proof adoption input")
    if (envelope["collection"]["complete"] is not True or envelope["collection"]["reasons"]
            or len(envelope["sources"]) != 2):
        raise ValueError("ADO proof adoption requires complete selected sources")
    configured = projects(config)
    if len(configured) != 2 or any(len(names) != 1 for _, _, names in configured):
        raise ValueError("Two configured ADO remotes required")
    documents = {}
    for document in proofs:
        if not isinstance(document, dict) or not isinstance(document.get("source"), dict):
            raise ValueError("Invalid ADO proof document")
        source_id = document["source"].get("id")
        if source_id in documents:
            raise ValueError("Duplicate ADO proof source")
        documents[source_id] = document
    if set(documents) != set(envelope["activeSourceIds"]):
        raise ValueError("ADO proof source set mismatch")

    missing = []

    def saved_run(args, timeout):
        target = args[5]
        if target not in responses or not isinstance(responses[target], dict):
            missing.append(target)
            raise ValueError("Saved ADO response unavailable")
        return json.dumps(responses[target])

    replay = None
    for _ in range(100):
        replay = collect(config, saved_run, repository_category, at=instant(envelope["asOfAt"]), previous=replay)
        if missing:
            raise ValueError("Saved ADO response set is incomplete")
        if replay["collection"]["complete"]:
            break
    else:
        raise ValueError("Saved ADO response replay did not complete")
    replay_sources = {source["id"]: source for source in replay["sources"]}
    state = copy.deepcopy(replay["state"])
    for org, project, names in configured:
        account = principal(config, org)
        scope = org.casefold() + "/" + project.casefold()
        source_id = digest("ado", "dev.azure.com", scope, account["stableId"])
        source = next((row for row in envelope["sources"] if row["id"] == source_id), None)
        document = documents.get(source_id)
        if (source is None or document is None or document["source"] != source
                or source["account"] != account or source["scope"]["organization"].casefold() != org.casefold()
                or source["scope"]["project"].casefold() != project.casefold()
                or source["status"] != "ready" or not all(source["coverage"][key]
                    for key in ("identityVerified", "paginationComplete", "visibilityComplete"))
                or source["coverage"]["reasons"] or len(source["days"]) != 60
                or any(day["status"] != "ready" for day in source["days"])):
            raise ValueError("ADO proof identity or source mismatch")
        work, proof = document.get("work"), document.get("proof")
        if not isinstance(work, dict) or not isinstance(proof, dict) or len(work.get("inventory", [])) != 1:
            raise ValueError("Invalid ADO pinned proof")
        repo = work["inventory"][0]
        repo_id = repo.get("id")
        provenance = source.get("provenance", {})
        if (not isinstance(repo_id, str) or not GUID.fullmatch(repo_id)
                or repo["name"].casefold() != names[0] or repo.get("isDisabled") is not False
                or repo.get("defaultBranch") != proof.get("branch") or not SHA.fullmatch(proof.get("head", ""))
                or work.get("repoDone") != {repo_id: proof} or work.get("progress") != {}
                or work.get("repoErrors") != {} or work.get("scanComplete") is not True
                or work.get("prComplete") is not True or work.get("reasons") != []
                or work.get("cutoff") != envelope["asOfAt"]
                or work.get("firstDay") != envelope["operationWindow"]["startDay"]
                or work.get("lastDay") != envelope["operationWindow"]["endDay"]
                or provenance.get("scopeDefinition") != "explicit-configured-repositories"
                or provenance.get("sourceCutoffAt") != envelope["asOfAt"]
                or provenance.get("selectedRepositoryIds") != [repo_id]
                or [name.casefold() for name in provenance.get("selectedRepositoryNames", [])] != names
                or provenance.get("pinnedHeads") != {repo_id: proof["head"]}
                or provenance.get("detailsVerified") != len(proof.get("checked", []))
                or type(provenance.get("historyCommits")) is not int
                or provenance["historyCommits"] < len(proof["checked"]) or provenance.get("headUnchanged") is not True):
            raise ValueError("ADO proof scope or history mismatch")
        checked = proof["checked"]
        items = proof.get("items")
        if (not isinstance(checked, list) or not isinstance(items, list)
                or len(checked) != len(set(checked)) or any(not isinstance(oid, str) or not SHA.fullmatch(oid) for oid in checked)
                or len(items) != len({item["id"] for item in items})
                or any(item["id"] not in checked or item["day"] != china_day(instant(item["authoredAt"]))
                       or type(item["merge"]) is not bool or type(item["coauthor"]) is not bool for item in items)
                or instant(proof["pinnedAt"]) > instant(envelope["capturedAt"])):
            raise ValueError("Invalid ADO credited commit proof")
        seen_prs = work.get("prSeen")
        prs = work.get("prs")
        if (not isinstance(seen_prs, list) or not isinstance(prs, list)
                or len(seen_prs) != len(set(seen_prs)) or any(type(value) is not int or value < 1 for value in seen_prs)
                or len(prs) != len({row["id"] for row in prs})
                or any(row["id"] not in seen_prs or row["repo"] != repo_id
                       or row["day"] != china_day(instant(row["createdAt"])) for row in prs)
                or type(work.get("prOffset")) is not int or work["prOffset"] < len(seen_prs)):
            raise ValueError("Invalid ADO PR proof")
        replay_source = replay_sources[source_id]
        replay_work = state["projects"][scope]["work"]
        replay_proof = state["projects"][scope]["cache"][repo_id]
        replay_prs = [row for row in replay_work["prs"] if row["repo"] == repo_id]
        if (replay_source["account"] != source["account"] or replay_source["scope"] != source["scope"]
                or replay_source["status"] != "ready" or replay_proof["head"] != proof["head"]
                or replay_proof["branch"] != proof["branch"] or replay_proof["checked"] != checked
                or {item["id"]: item for item in replay_proof["items"]} != {item["id"]: item for item in items}
                or len(replay_work["prSeen"]) != len(seen_prs) or set(replay_work["prSeen"]) != set(seen_prs)
                or {row["id"]: row for row in replay_prs} != {row["id"]: row for row in prs}
                or any({key: value for key, value in actual.items() if key != "capturedAt"} !=
                       {key: value for key, value in saved.items() if key != "capturedAt"}
                       for actual, saved in zip(replay_source["days"], source["days"]))):
            raise ValueError("Saved ADO replay differs from accepted proof")
        state["projects"][scope]["cache"][repo_id] = copy.deepcopy(proof)
        replay_work["repoDone"][repo_id] = copy.deepcopy(proof)
    adopted = copy.deepcopy(envelope)
    adopted["state"] = state
    validate_envelope(adopted, "ado")
    return adopted
