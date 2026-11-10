"""Collect verified Azure DevOps activity from remote default-branch history."""

import copy
import datetime as dt
import hashlib
import json
import re
import subprocess
import time
import urllib.parse


DEFINITION = "ado-default-head-v1"
RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
DATE_BASIS = {"prs": "created-at/UTC", "commits": "author-at/UTC"}
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
SECONDS_PER_PROJECT = 42
SECONDS_TOTAL = 180


class BudgetExceeded(Exception):
    pass


class RepositoryQuantum(Exception):
    pass


def stamp(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("Invalid ADO timestamp")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("ADO timestamp requires an offset")
    return parsed.astimezone(dt.timezone.utc)


def digest(*parts):
    return hashlib.sha256(json.dumps(parts, separators=(",", ":")).encode()).hexdigest()


def segment(value):
    decoded = urllib.parse.unquote(value)
    if not decoded or decoded in (".", "..") or "/" in decoded or "\\" in decoded or len(decoded) > 200:
        raise ValueError("Invalid ADO project scope")
    return decoded


def projects(config):
    found = {}
    for raw in config.get("mergedAdoProjects", []) + config.get("adoRemotes", []):
        parsed = urllib.parse.urlsplit(raw)
        if (parsed.scheme != "https" or parsed.hostname != "dev.azure.com" or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("Invalid configured ADO scope")
        parts = parsed.path.strip("/").split("/")
        repository = None
        if len(parts) == 4 and parts[2] == "_git":
            repository = segment(parts[3]).casefold()
            parts = parts[:2]
        if len(parts) != 2:
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

    def get(self, target):
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
            body = json.loads(self.run(args, timeout=min(20, remaining)))
        except (OSError, ValueError, TypeError, subprocess.SubprocessError):
            raise ValueError("ADO authenticated read unavailable") from None
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


def pr_page(reader, org, project, account, offset):
    body = reader.get(url(org, project, "/_apis/git/pullrequests", **{
        "searchCriteria.status": "all", "searchCriteria.creatorId": account["stableId"],
        "$top": PAGE, "$skip": offset}))
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
        if work["firstDay"] <= created.date().isoformat() <= work["lastDay"] and created <= instant(work["cutoff"]):
            pending.append({"id": pr_id, "repo": repo_id, "day": created.date().isoformat()})
    work["prs"].extend(pending)
    work["prSeen"] = sorted(seen)


def default_head(reader, org, project, repo):
    branch = repo["defaultBranch"]
    path = "/_apis/git/repositories/" + repo["id"] + "/refs"
    page = rows(reader.get(url(org, project, path, filter=branch[len("refs/"):])), 100)
    exact = [row for row in page if row.get("name") == branch]
    if len(exact) != 1 or not SHA.fullmatch(exact[0].get("objectId", "")):
        raise ValueError("ADO default branch head unavailable")
    return exact[0]["objectId"].lower()


def commit_page(reader, org, project, repo_id, head, offset):
    path = "/_apis/git/repositories/" + repo_id + "/commits"
    body = reader.get(url(org, project, path, **{
        "searchCriteria.itemVersion.version": head,
        "searchCriteria.itemVersion.versionType": "commit", "$top": PAGE, "$skip": offset}))
    return rows(body)


def credited_commit(reader, org, project, repo_id, item, emails, first):
    authored = instant(item["author"]["date"])
    day = authored.date().isoformat()
    if day < first:
        return None
    commit_id = item["commitId"].lower()
    path = "/_apis/git/repositories/" + repo_id + "/commits/" + commit_id
    detail = reader.get(url(org, project, path))
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


def new_work(at):
    end = at.date()
    return {"cutoff": stamp(at), "firstDay": (end - dt.timedelta(days=59)).isoformat(),
            "lastDay": end.isoformat(), "inventory": None, "prOffset": 0, "prSeen": [],
            "prFirst": None, "prs": [], "prComplete": False, "repoIndex": 0,
            "repoDone": {}, "progress": {}, "repoErrors": {}, "activeCursor": 0,
            "scanComplete": False, "reasons": []}


def advance_prs(reader, org, project, account, work):
    if work["prComplete"]:
        return
    inventory_ids = {row["id"] for row in work["inventory"]}
    while work["prOffset"] // PAGE < MAX_PAGES:
        page = pr_page(reader, org, project, account, work["prOffset"])
        ids = [row["pullRequestId"] for row in page]
        try:
            add_prs(work, page, account, inventory_ids)
        except ValueError as error:
            if str(error) == "Duplicate ADO PR page":
                work.update({"prOffset": 0, "prSeen": [], "prFirst": None,
                             "prs": [], "prComplete": False})
            raise
        if work["prFirst"] is None:
            work["prFirst"] = ids
        work["prOffset"] += len(page)
        if len(page) < PAGE:
            check = pr_page(reader, org, project, account, 0)
            if [row["pullRequestId"] for row in check] != work["prFirst"]:
                work.update({"prOffset": 0, "prSeen": [], "prFirst": None,
                             "prs": [], "prComplete": False})
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
        if prior and prior.get("head") == head and prior.get("branch") == repo["defaultBranch"]:
            work["repoDone"][repo_id] = {**prior, "items": [item for item in prior["items"]
                if work["firstDay"] <= item["day"]]}
            return
        progress = {"branch": repo["defaultBranch"], "head": head,
                    "offset": 0, "seen": [], "pending": [], "items": [], "checked": [],
                    "endPage": False, "pinnedAt": stamp(dt.datetime.now(dt.timezone.utc))}
        work["progress"][repo_id] = progress
    if progress["branch"] != repo["defaultBranch"]:
        work["progress"].pop(repo_id)
        raise ValueError("Incompatible ADO repository continuation")
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
                pending.append({"commitId": oid, "author": {"date": row["author"]["date"]}})
            progress["seen"] = sorted(known)
            progress["pending"] = pending
            progress["offset"] += len(page)
            progress["endPage"] = len(page) < PAGE
        while progress["pending"]:
            item = progress["pending"][0]
            oid = item["commitId"]
            candidate = instant(item["author"]["date"]).date().isoformat() >= work["firstDay"]
            if candidate and oid in prior_checked:
                credited = prior_items.get(oid)
            else:
                credited = credited_commit(reader, org, project, repo_id, item, emails, work["firstDay"])
            if credited:
                progress["items"].append(credited)
            if candidate:
                progress["checked"].append(oid)
            progress["pending"].pop(0)
        if progress["endPage"]:
            items = progress["items"]
            if len({item["id"] for item in items}) != len(items):
                raise ValueError("Duplicate ADO commit attribution")
            relation = ("descendant" if prior["head"] in progress["seen"] else "rewritten") if prior else "initial"
            proof = {"head": progress["head"], "branch": repo["defaultBranch"],
                     "items": items, "checked": sorted(set(progress["checked"])),
                     "pinnedAt": progress["pinnedAt"], "relation": relation}
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
    repos = work["inventory"]
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
        repo_id = active[work["activeCursor"] % len(active)]
        work["activeCursor"] += 1
        process(indexed[repo_id])
        processed.add(repo_id)
    while work["repoIndex"] < len(repos):
        repo = repos[work["repoIndex"]]
        if repo["id"] not in processed:
            process(repo)
        work["repoIndex"] += 1
    work["scanComplete"] = not work["progress"]
    if not work["scanComplete"]:
        work["repoIndex"] = 0


def source_days(work, org, project, categories, captured_at, complete, verified, visibility_complete):
    repos = {row["id"]: row for row in work["inventory"] or []}
    prs = work["prs"]
    commits = [(repo_id, item) for repo_id, result in work["repoDone"].items()
               for item in result["items"] if instant(item["authoredAt"]) <= instant(work["cutoff"])]
    if len({(repo_id, item["id"]) for repo_id, item in commits}) != len(commits):
        raise ValueError("Duplicate repository commit key")
    output = []
    first = dt.date.fromisoformat(work["firstDay"])
    pr_exact = verified and visibility_complete and work["prComplete"]
    for offset in range(60):
        day = (first + dt.timedelta(days=offset)).isoformat()
        pr_rows = [item for item in prs if item["day"] == day]
        commit_rows = [(repo, item) for repo, item in commits if item["day"] == day]
        repository_days = []
        for repo_id in sorted({item["repo"] for item in pr_rows} | {repo for repo, _ in commit_rows}):
            repo = repos[repo_id]
            p = sum(item["repo"] == repo_id for item in pr_rows)
            c = sum(key == repo_id for key, _ in commit_rows)
            repo_complete = pr_exact and repo_id in work["repoDone"] and not repo["isDisabled"]
            repository_days.append({"id": digest("ado-repo", org.casefold(), repo_id),
                "name": org + "/" + project + "/" + repo["name"], "category": categories[repo_id],
                "prs": p if pr_exact else None, "knownPrs": p if verified else None,
                "commits": c if repo_complete else None,
                "knownCommits": c if verified and repo_id in work["repoDone"] else None,
                "status": "ready" if repo_complete else "partial" if verified else "unavailable"})
        p = len(pr_rows)
        c = len(commit_rows)
        output.append({"day": day, "capturedAt": captured_at,
            "status": "ready" if complete else "partial" if verified else "unavailable",
            "prs": p if pr_exact else None,
            "knownPrs": p if verified and (work["prComplete"] or work["prSeen"]) else None,
            "commits": c if complete else None,
            "knownCommits": c if verified and (work["repoDone"] or work["scanComplete"]) else None,
            "repositories": repository_days})
    return output


def collect(config, run, repository_category, *, at=None, days=60, previous=None):
    if type(days) is not int or days != 60:
        raise ValueError("ADO collection requires exactly 60 UTC dates")
    at = at or dt.datetime.now(dt.timezone.utc)
    if at.tzinfo is None:
        raise ValueError("ADO capture time requires an offset")
    at = at.astimezone(dt.timezone.utc).replace(microsecond=0)
    configured = projects(config)
    old_state = {}
    compatible_state = False
    if previous is not None:
        if (not isinstance(previous, dict) or previous.get("version") != 2
                or previous.get("metricDefinition") != DEFINITION or previous.get("provider") != "ado"):
            raise ValueError("Cannot resume a different ADO metric")
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
                   if compatible_state and isinstance(previous.get("sources"), list) else {})
    if compatible_state and len(old_sources) != len(previous.get("sources", [])):
        raise ValueError("Duplicate retained ADO source")
    emails = author_aliases(config)
    email_hash = digest("ado-author-aliases", sorted(emails)) if emails else None
    for org, project, configured_names in configured:
        account = principal(config, org)
        scope = org.casefold() + "/" + project.casefold()
        source_id = digest("ado", "dev.azure.com", scope, account["stableId"])
        source_ids.append(source_id)
        prior = copy.deepcopy(old_state.get(scope, {}))
        expected_ids = set(prior.get("expectedRepositoryIds", []))
        if prior and prior.get("account") != account:
            prior = {}
        if prior and not isinstance(prior.get("cache"), dict):
            raise ValueError("Invalid ADO continuation cache")
        if prior.get("emailHash") != email_hash:
            prior = {}
        cache = prior.get("cache", {})
        expected_ids.update(cache)
        if isinstance(prior.get("work"), dict):
            expected_ids.update(repo["id"] for repo in prior["work"].get("inventory") or [])
        work = prior.get("work")
        if (not isinstance(work, dict) or work.get("firstDay") != (at.date() - dt.timedelta(days=59)).isoformat()
                or work.get("scanComplete")):
            work = new_work(at)
        reader.source_calls = 0
        reader.source_end = min(reader.end, time.monotonic() + SECONDS_PER_PROJECT)
        reasons = []
        verified = False
        try:
            if emails is None:
                raise ValueError("Confirmed ADO author aliases required")
            identity(reader, org, account)
            verified = True
            if work["inventory"] is None:
                work["inventory"] = inventory(reader, org, project)
            observed_ids = {repo["id"] for repo in work["inventory"]}
            observed_names = {repo["name"].casefold() for repo in work["inventory"]}
            if expected_ids - observed_ids or set(configured_names) - observed_names:
                if "repository-visibility-gap" not in work["reasons"]:
                    work["reasons"].append("repository-visibility-gap")
            if not work["inventory"] and not expected_ids and not configured_names:
                if "empty-inventory-unverified" not in work["reasons"]:
                    work["reasons"].append("empty-inventory-unverified")
            expected_ids.update(observed_ids)
            inventory_keys = {(org.casefold(), row["id"]) for row in work["inventory"]}
            if inventory_keys.intersection(discovered_repositories):
                work = new_work(at)
                raise ValueError("Overlapping ADO project discovery")
            discovered_repositories.update(inventory_keys)
            advance_prs(reader, org, project, account, work)
            advance_repos(reader, org, project, work, cache, emails)
        except (BudgetExceeded, OSError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            reasons.append("request-budget" if isinstance(error, BudgetExceeded)
                           else str(error) if isinstance(error, ValueError) else "read-failure")
        cache = {**cache, **work["repoDone"]}
        reasons += work["reasons"] + list(work["repoErrors"].values())
        reasons = sorted(set(reasons))
        pagination_complete = (work["prComplete"] and work["scanComplete"] and not work["repoErrors"]
            and all(repo["isDisabled"] or repo["id"] in work["repoDone"]
                    for repo in work["inventory"] or []))
        visibility_complete = (verified and bool(work["inventory"])
            and not any(repo["isDisabled"] for repo in work["inventory"])
            and not (expected_ids - {repo["id"] for repo in work["inventory"]})
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
                  "days": source_days(work, org, project, categories, captured_at,
                                      complete, verified, visibility_complete),
                  "provenance": {"inventoryCount": len(work["inventory"] or []),
                      "expectedRepositoryCount": len(expected_ids),
                      "missingRepositoryCount": len(expected_ids - {repo["id"] for repo in work["inventory"] or []}),
                      "missingConfiguredCount": len(set(configured_names) -
                          {repo["name"].casefold() for repo in work["inventory"] or []}),
                      "disabledCount": sum(repo["isDisabled"] for repo in work["inventory"] or []),
                      "withoutDefaultCount": sum(not repo["defaultBranch"] for repo in work["inventory"] or []),
                      "completedRepositories": len(work["repoDone"]), "prPages": (work["prOffset"] + PAGE - 1) // PAGE,
                      "pinnedHeads": {key: value["head"] for key, value in work["repoDone"].items()},
                      "sourceCutoffAt": work["cutoff"]}}
        if not complete and emails is not None and prior:
            old_days = {day["day"]: day for day in old_sources.get(source_id, {}).get("days", [])
                        if day.get("status") in ("ready", "stale")}
            source["days"] = [{**old_days[day["day"]], "status": "stale"} if day["day"] in old_days else day
                              for day in source["days"]]
            if old_days and all(day["status"] == "stale" for day in source["days"]):
                source["status"] = "stale"
        sources.append(source)
        states[scope] = {"account": account, "emailHash": email_hash,
                         "expectedRepositoryIds": sorted(expected_ids), "cache": cache, "work": work}
    captured = stamp(dt.datetime.now(dt.timezone.utc))
    return {"version": 2, "metricDefinition": DEFINITION, "provider": "ado",
            "asOfAt": min(source["provenance"]["sourceCutoffAt"] for source in sources),
            "capturedAt": captured, "dateBasis": DATE_BASIS,
            "operationWindow": {"startDay": (at.date() - dt.timedelta(days=59)).isoformat(),
                                "endDay": at.date().isoformat(), "todayPartial": True},
            "activeSourceIds": source_ids, "sources": sources,
            "collection": {"requestCount": reader.calls, "elapsedSeconds": round(time.monotonic() - started, 3),
                           "complete": all(source["status"] == "ready" for source in sources),
                           "reasons": sorted({reason for source in sources
                                              for reason in source["coverage"]["reasons"]})},
            "state": {"schema": 3, "projects": states}}
