"""Collect GitHub Profile contributions from explicit authenticated accounts."""

import datetime as dt
import copy
import hashlib
import json
import re
import subprocess
import sys
import time
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from local_usage_profile_private import HISTORY_QUERY, REPOSITORY_QUERY, supplement_private


DEFINITION = "github-profile-beijing-v1"
DATE_BASIS = {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"}
MAX_ACCOUNTS = 24
MAX_REQUESTS = 120
MAX_SECONDS = 180
MAX_PROFILE_PAGES = 100
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_COUNT = 2**53 - 1
UTC = dt.timezone.utc
TZ = ZoneInfo("Asia/Shanghai")
HISTORY_PAGES_PER_REPOSITORY = 8
MAX_HISTORY_PAGES = 1000

PROFILE_QUERY = """query($from: DateTime!, $to: DateTime!, $after: String) {
  viewer {
    id login url
    contributionsCollection(from: $from, to: $to) {
      startedAt endedAt hasAnyRestrictedContributions restrictedContributionsCount
      totalCommitContributions totalRepositoriesWithContributedCommits
      totalPullRequestContributions(excludeFirst: false, excludePopular: false)
      commitContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner isPrivate isFork createdAt
          defaultBranchRef { name target { ... on Commit { oid } } } }
        contributions(first: 100) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes { occurredAt commitCount }
        }
      }
      pullRequestContributions(first: 100, after: $after, excludeFirst: false, excludePopular: false) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          occurredAt
          pullRequest {
            id createdAt author { login ... on User { id } }
            repository { id nameWithOwner isPrivate isFork }
          }
        }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}"""

COMMIT_QUERY = """query($owner: String!, $name: String!, $oid: GitObjectID!) {
  viewer { id login url }
  repository(owner: $owner, name: $name) {
    id
    object(oid: $oid) { ... on Commit {
      oid authoredDate
      authors(first: 100) { totalCount pageInfo { hasNextPage } nodes { user { id } } }
      parents(first: 100) { totalCount pageInfo { hasNextPage } nodes { oid } }
    } }
  }
  rateLimit { cost remaining resetAt }
}"""


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("invalid_instant")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("invalid_instant")
    return parsed.astimezone(UTC)


def china_day(value):
    return value.astimezone(TZ).date().isoformat()


def window_start(first):
    day = first if isinstance(first, dt.date) else dt.date.fromisoformat(first)
    return dt.datetime.combine(day, dt.time.min, TZ).astimezone(UTC)


def stamp(value):
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def count(value):
    if type(value) is not int or not 0 <= value <= MAX_COUNT:
        raise ValueError("invalid_count")
    return value


def digest(*values):
    return hashlib.sha256(json.dumps(values, separators=(",", ":")).encode()).hexdigest()


def profile_config(profile):
    if not isinstance(profile, dict):
        raise ValueError("invalid_account_config")
    host, login, stable, alias = (profile.get(key) for key in ("host", "login", "stableId", "profile"))
    if (not isinstance(host, str) or not (host == "github.com" or re.fullmatch(r"[a-z0-9-]+\.ghe\.com", host))
            or not isinstance(login, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", login)
            or not isinstance(stable, str) or not re.fullmatch(r"[A-Za-z0-9_=/+-]{8,200}", stable)
            or not isinstance(alias, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", alias)):
        raise ValueError("invalid_account_config")
    return {"host": host, "login": login, "stableId": stable, "profile": alias,
            "privateRepositories": profile.get("privateRepositories", []),
            "visibilityProof": profile.get("visibilityProof")}


def source_id(profile):
    return digest("github-profile-source", profile["host"], profile["login"].casefold(), profile["stableId"])


def repository_info(repo, profile, config, repository_category):
    if not isinstance(repo, dict) or type(repo.get("isPrivate")) is not bool or type(repo.get("isFork")) is not bool:
        raise ValueError("invalid_repository")
    name = repo.get("nameWithOwner")
    if (not isinstance(repo.get("id"), str) or not repo["id"]
            or not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", name)
            or any(part in (".", "..") for part in name.split("/"))):
        raise ValueError("invalid_repository")
    category = repository_category(f"https://{profile['host']}/{name}", config)
    if category not in ("work", "personal", "unclassified"):
        raise ValueError("invalid_repository_category")
    return {"id": digest("github-repository", profile["host"], repo["id"]),
            "name": name, "category": category, "providerId": repo["id"]}


class Budget:
    def __init__(self, config, run):
        if not isinstance(config.get("githubHelper"), str) or not config["githubHelper"]:
            raise ValueError("github_helper_required")
        self.helper = config["githubHelper"]
        self.run = run
        self.started = time.monotonic()
        self.requests = 0
        self.rate_limit = None

    def query(self, profile, document, variables):
        remaining = MAX_SECONDS - (time.monotonic() - self.started)
        if self.requests >= MAX_REQUESTS or remaining <= 0:
            raise TimeoutError("collection_budget_exhausted")
        args = [sys.executable, self.helper, "gh", profile["profile"], "api", "graphql", "-f", "query=" + document]
        for key, value in variables.items():
            if value is not None:
                args.extend(("-f", f"{key}={value}"))
        self.requests += 1
        raw = self.run(args, timeout=min(30, remaining))
        if isinstance(raw, bytes):
            raw = raw.decode("utf8")
        if not isinstance(raw, str) or len(raw.encode("utf8")) > MAX_RESPONSE_BYTES:
            raise ValueError("invalid_response_size")
        response = json.loads(raw)
        if not isinstance(response, dict) or response.get("errors") or not isinstance(response.get("data"), dict):
            raise ValueError("incomplete_graphql_response")
        data = response["data"]
        viewer = data["viewer"]
        if (not isinstance(viewer, dict) or viewer.get("id") != profile["stableId"]
                or not isinstance(viewer.get("login"), str)
                or viewer["login"].casefold() != profile["login"].casefold()
                or not isinstance(viewer.get("url"), str)
                or urlsplit(viewer["url"]).hostname != profile["host"]):
            raise ValueError("account_identity_mismatch")
        rate = data.get("rateLimit")
        if isinstance(rate, dict):
            try:
                self.rate_limit = {"cost": count(rate["cost"]), "remaining": count(rate["remaining"]),
                                   "resetAt": stamp(instant(rate["resetAt"]))}
            except (KeyError, TypeError, ValueError):
                self.rate_limit = None
        return data

    def elapsed(self):
        return round(time.monotonic() - self.started, 3)


def profile_records(config, profile, budget, first, at, repository_category):
    start = window_start(first) - dt.timedelta(days=1)
    after, seen_cursors, prs, repositories, commit_repositories = None, set(), {}, {}, []
    signature = None
    for _ in range(MAX_PROFILE_PAGES):
        data = budget.query(profile, PROFILE_QUERY, {"from": stamp(start), "to": stamp(at), "after": after})
        collection = data["viewer"]["contributionsCollection"]
        if (instant(collection["startedAt"]) != start or instant(collection["endedAt"]) != at
                or type(collection["hasAnyRestrictedContributions"]) is not bool
                or (count(collection["restrictedContributionsCount"]) > 0 and not collection["hasAnyRestrictedContributions"])):
            raise ValueError("invalid_profile_window")
        stable = {key: collection[key] for key in ("startedAt", "endedAt", "hasAnyRestrictedContributions",
                  "restrictedContributionsCount", "totalCommitContributions", "totalRepositoriesWithContributedCommits",
                  "totalPullRequestContributions", "commitContributionsByRepository")}
        if signature is not None and stable != signature:
            raise ValueError("profile_changed_during_pagination")
        if signature is None:
            signature = stable
            groups = collection["commitContributionsByRepository"]
            if (not isinstance(groups, list) or len(groups) > 100
                    or len(groups) != count(collection["totalRepositoriesWithContributedCommits"])):
                raise ValueError("incomplete_profile_repositories")
            bucket_total = 0
            for group in groups:
                raw_repo = group["repository"]
                repo = repository_info(raw_repo, profile, config, repository_category)
                if repo["id"] in repositories:
                    raise ValueError("duplicate_profile_repository")
                repositories[repo["id"]] = repo
                created = instant(raw_repo["createdAt"])
                branch = raw_repo.get("defaultBranchRef")
                head = branch.get("target", {}).get("oid") if isinstance(branch, dict) else None
                if head is not None and (not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", head, re.I)):
                    raise ValueError("invalid_profile_default_head")
                if branch is not None and (not isinstance(branch.get("name"), str) or not branch["name"]):
                    raise ValueError("invalid_profile_default_branch")
                owner, name = repo["name"].split("/", 1)
                commit_repositories.append({"repository": repo, "owner": owner, "name": name,
                    "createdAt": stamp(created), "branch": branch["name"] if branch else None,
                    "head": head.lower() if head else None})
                connection = group["contributions"]
                nodes = connection["nodes"]
                if (not isinstance(nodes, list) or len(nodes) > 100
                        or connection["pageInfo"]["hasNextPage"] is not False
                        or count(connection["totalCount"]) != sum(count(node["commitCount"]) for node in nodes)):
                    raise ValueError("incomplete_commit_buckets")
                dates = set()
                for node in nodes:
                    instant(node["occurredAt"])
                    day = node["occurredAt"][:10]
                    if day in dates or day < start.date().isoformat() or day > at.date().isoformat():
                        raise ValueError("invalid_commit_bucket")
                    dates.add(day)
                    bucket_total += count(node["commitCount"])
            if bucket_total != count(collection["totalCommitContributions"]):
                raise ValueError("incomplete_commit_total")
        connection = collection["pullRequestContributions"]
        nodes = connection["nodes"]
        total = count(connection["totalCount"])
        if total != count(collection["totalPullRequestContributions"]) or not isinstance(nodes, list) or len(nodes) > 100:
            raise ValueError("invalid_pr_page")
        for node in nodes:
            pr = node["pullRequest"]
            occurred = instant(node["occurredAt"])
            created = instant(pr["createdAt"])
            if (occurred < start or occurred > at or created > at
                    or not isinstance(pr.get("author"), dict)
                    or pr["author"].get("id") != profile["stableId"]
                    or pr["author"].get("login", "").casefold() != profile["login"].casefold()
                    or not isinstance(pr.get("id"), str) or not pr["id"]):
                raise ValueError("invalid_profile_pr")
            repo = repository_info(pr["repository"], profile, config, repository_category)
            old = repositories.get(repo["id"])
            if old is not None and old != repo:
                raise ValueError("conflicting_profile_repository")
            repositories[repo["id"]] = repo
            key = digest("github-pr", profile["host"], pr["id"])
            if key in prs:
                raise ValueError("duplicate_profile_pr")
            prs[key] = {"day": china_day(created), "createdAt": stamp(created),
                        "repository": repo, "key": key}
        page = connection["pageInfo"]
        if page["hasNextPage"] is False:
            if len(prs) != total:
                raise ValueError("incomplete_pr_pages")
            return {"prs": list(prs.values()), "commits": [], "commitRepositories": commit_repositories,
                    "prKeys": set(prs), "prRepositoryIds": {pr["repository"]["id"] for pr in prs.values()},
                    "commitRepositoryIds": {item["repository"]["id"] for item in commit_repositories},
                    "restricted": count(collection["restrictedContributionsCount"]),
                    "typedTotals": {"prs": total, "commits": count(collection["totalCommitContributions"])}}
        cursor = page["endCursor"]
        if page["hasNextPage"] is not True or not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
            raise ValueError("invalid_pr_cursor")
        seen_cursors.add(cursor)
        after = cursor
    raise ValueError("profile_page_budget_exhausted")


def observed_head(config, profile, budget, candidate, repository_category):
    data = budget.query(profile, REPOSITORY_QUERY, {"owner": candidate["owner"], "name": candidate["name"]})
    raw = data["repository"]
    repo = repository_info(raw, profile, config, repository_category)
    branch = raw.get("defaultBranchRef")
    head = branch.get("target", {}).get("oid") if isinstance(branch, dict) else None
    if (repo != candidate["repository"] or not isinstance(branch, dict)
            or branch.get("name") != candidate["branch"] or not isinstance(head, str)
            or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", head, re.I)):
        raise ValueError("default_branch_changed_during_history")
    return head.lower()


def full_progress(candidate, first):
    return {"mode": "full", "head": candidate["head"], "branch": candidate["branch"],
            "repositoryId": candidate["repository"]["providerId"],
            "coverageStartAt": stamp(window_start(first)), "cursor": None,
            "cursors": [], "seen": [], "items": [], "total": None, "pages": 0}


def delta_events(config, profile, budget, candidate, first, cache, progress, current, repository_category):
    repo = candidate["repository"]
    repo_id = repo["id"]
    base = cache.get(repo_id)
    if (not isinstance(base, dict) or base.get("head") != current.get("baseHead")
            or base.get("branch") != current.get("branch")
            or not isinstance(base.get("checked"), list)
            or any(not isinstance(oid, str) or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", oid)
                   for oid in base["checked"])):
        raise ValueError("incompatible_history_delta")
    known, seen = set(base["checked"]), set(current["seen"])
    for _ in range(HISTORY_PAGES_PER_REPOSITORY):
        while current["frontier"] and (current["frontier"][-1] in known or current["frontier"][-1] in seen):
            oid = current["frontier"].pop()
            if oid == base["head"]:
                current["reachedBase"] = True
        if not current["frontier"]:
            if not current["reachedBase"]:
                progress[repo_id] = full_progress({**candidate, "head": current["head"]}, first)
                raise ValueError("rewritten_history_requires_full_scan")
            observed = observed_head(config, profile, budget, candidate, repository_category)
            items = {item["oid"]: item for item in base["items"]}
            for item in current["items"]:
                if item["oid"] in items:
                    raise ValueError("duplicate_history_delta")
                items[item["oid"]] = item
            cache[repo_id] = {"head": current["head"], "branch": current["branch"],
                              "repositoryId": repo["providerId"], "coverageStartAt": base["coverageStartAt"],
                              "items": list(items.values()), "checked": sorted(known | seen)}
            progress.pop(repo_id, None)
            if observed != current["head"]:
                raise ValueError("head_drift_after_delta")
            return cache[repo_id]["items"], True
        oid = current["frontier"][-1]
        data = budget.query(profile, COMMIT_QUERY, {"owner": candidate["owner"], "name": candidate["name"], "oid": oid})
        response_repo = data["repository"]
        if not isinstance(response_repo, dict) or response_repo.get("id") != repo["providerId"]:
            raise ValueError("history_repository_changed")
        node = response_repo["object"]
        if not isinstance(node, dict) or node.get("oid", "").lower() != oid:
            raise ValueError("history_commit_changed")
        authored = instant(node["authoredDate"])
        authors, parents = node["authors"], node["parents"]
        actors, parent_nodes = authors["nodes"], parents["nodes"]
        if (not isinstance(actors, list) or len(actors) > 100
                or authors["pageInfo"]["hasNextPage"] is not False
                or count(authors["totalCount"]) != len(actors)
                or not isinstance(parent_nodes, list) or len(parent_nodes) > 100
                or parents["pageInfo"]["hasNextPage"] is not False
                or count(parents["totalCount"]) != len(parent_nodes)):
            raise ValueError("incomplete_history_commit_detail")
        parent_ids = [parent["oid"].lower() for parent in parent_nodes]
        if any(not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", parent) for parent in parent_ids):
            raise ValueError("invalid_history_parent")
        item = None
        if any(isinstance(actor, dict) and isinstance(actor.get("user"), dict)
               and actor["user"].get("id") == profile["stableId"] for actor in actors):
            day = china_day(authored)
            if day >= first.isoformat():
                if authored < instant(candidate["createdAt"]):
                    raise ValueError("history_commit_eligibility_uncertain")
                item = {"day": day, "authoredAt": stamp(authored), "repository": repo,
                        "key": digest("github-commit", profile["host"], repo["providerId"], oid),
                        "oid": oid, "count": 1, "merge": len(parent_ids) > 1}
        current["frontier"].pop()
        current["frontier"].extend(parent_ids)
        current["seen"].append(oid)
        seen.add(oid)
        if item:
            current["items"].append(item)
    return current["items"], False


def history_events(config, profile, budget, candidate, first, at, cache, progress, repository_category):
    repo = candidate["repository"]
    repo_id, head, branch = repo["id"], candidate["head"], candidate["branch"]
    if not head or not branch:
        raise ValueError("default_head_unavailable")
    proof = cache.get(repo_id)
    proof_usable = (isinstance(proof, dict) and proof.get("branch") == branch
            and proof.get("repositoryId") == repo["providerId"]
            and isinstance(proof.get("items"), list)
            and isinstance(proof.get("checked"), list)
            and isinstance(proof.get("coverageStartAt"), str)
            and instant(proof["coverageStartAt"]) <= window_start(first))
    if proof_usable and proof["head"] == head:
        return proof["items"], True
    current = progress.get(repo_id)
    if (not isinstance(current, dict) or current.get("branch") != branch
            or current.get("repositoryId") != repo["providerId"]
            or instant(current.get("coverageStartAt", stamp(window_start(first)))) > window_start(first)):
        if proof_usable:
            current = {"mode": "delta", "head": head, "baseHead": proof["head"],
                       "branch": branch, "repositoryId": repo["providerId"],
                       "coverageStartAt": proof["coverageStartAt"], "frontier": [head],
                       "seen": [], "items": [], "reachedBase": False}
        else:
            current = full_progress(candidate, first)
        progress[repo_id] = current
    if current.get("mode") == "delta":
        return delta_events(config, profile, budget, candidate, first, cache, progress, current, repository_category)
    head = current["head"]
    for _ in range(HISTORY_PAGES_PER_REPOSITORY):
        if current["pages"] >= MAX_HISTORY_PAGES:
            raise ValueError("history_page_budget_exhausted")
        data = budget.query(profile, HISTORY_QUERY, {"owner": candidate["owner"], "name": candidate["name"],
                                                    "head": head, "after": current["cursor"]})
        response_repo = data["repository"]
        if not isinstance(response_repo, dict) or response_repo.get("id") != repo["providerId"]:
            raise ValueError("history_repository_changed")
        pinned = response_repo["object"]
        if not isinstance(pinned, dict) or pinned.get("oid", "").lower() != head:
            raise ValueError("history_head_changed")
        history = pinned["history"]
        total, nodes, page = count(history["totalCount"]), history["nodes"], history["pageInfo"]
        if (current["total"] is not None and current["total"] != total
                or not isinstance(nodes, list) or len(nodes) > 100):
            raise ValueError("invalid_history_page")
        seen, pending = set(current["seen"]), []
        for node in nodes:
            oid = node["oid"].lower()
            authored = instant(node["authoredDate"])
            if not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", oid) or oid in seen:
                raise ValueError("duplicate_history_commit")
            seen.add(oid)
            authors = node["authors"]
            actors = authors["nodes"]
            parents = node["parents"]
            if (not isinstance(actors, list) or len(actors) > 100
                    or authors["pageInfo"]["hasNextPage"] is not False
                    or count(authors["totalCount"]) != len(actors)
                    or not isinstance(parents, dict) or count(parents["totalCount"]) < 0):
                raise ValueError("incomplete_history_authors_or_parents")
            if any(isinstance(actor, dict) and isinstance(actor.get("user"), dict)
                   and actor["user"].get("id") == profile["stableId"] for actor in actors):
                day = china_day(authored)
                if day >= first.isoformat():
                    if authored < instant(candidate["createdAt"]):
                        raise ValueError("history_commit_eligibility_uncertain")
                    pending.append({"day": day, "authoredAt": stamp(authored), "repository": repo,
                                    "key": digest("github-commit", profile["host"], repo["providerId"], oid),
                                    "oid": oid, "count": 1, "merge": parents["totalCount"] > 1})
        has_next = page["hasNextPage"]
        cursor = page.get("endCursor")
        if has_next is True:
            if not isinstance(cursor, str) or not cursor or cursor in current["cursors"] or not nodes:
                raise ValueError("invalid_history_cursor")
        elif has_next is False:
            if len(seen) != total:
                raise ValueError("incomplete_history")
            cursor = None
        else:
            raise ValueError("invalid_history_cursor")
        observed = observed_head(config, profile, budget, candidate, repository_category) if not has_next else None
        current["seen"] = sorted(seen)
        current["items"].extend(pending)
        current["cursors"] = [*current["cursors"], cursor] if cursor else current["cursors"]
        current["cursor"] = cursor
        current["total"] = total
        current["pages"] += 1
        if not has_next:
            cache[repo_id] = {"head": head, "branch": branch, "repositoryId": repo["providerId"],
                              "coverageStartAt": current["coverageStartAt"], "items": current["items"],
                              "checked": current["seen"]}
            progress.pop(repo_id, None)
            if observed != head:
                raise ValueError("head_drift_after_history")
            return current["items"], True
    return current["items"], False


def empty_days(first, at, status, captured):
    return [{"day": (first + dt.timedelta(days=offset)).isoformat(), "capturedAt": captured,
             "status": status, "prs": None, "knownPrs": None, "commits": None,
             "knownCommits": None, "repositories": []} for offset in range(60)]


def measured_days(first, at, typed, supplement, exact, captured, prs_complete, commits_complete):
    days = {row["day"]: row for row in empty_days(first, at, "ready" if exact else "partial", captured)}
    repositories = {day: {} for day in days}
    for metric, events in (("prs", typed["prs"] + supplement["prs"]),
                           ("commits", typed["commits"] + supplement["commits"])):
        for event in events:
            row = days.get(event["day"])
            if row is None:
                continue
            repo = event["repository"]
            prior = repositories[event["day"]].get(repo["id"])
            if prior is not None and (prior["name"] != repo["name"] or prior["category"] != repo["category"]):
                raise ValueError("conflicting_repository_day")
            item = repositories[event["day"]].setdefault(repo["id"], {"id": repo["id"], "name": repo["name"],
                "category": repo["category"], "prs": None, "knownPrs": 0, "commits": None,
                "knownCommits": 0, "status": "ready" if exact else "partial"})
            item["known" + metric.capitalize()] += event.get("count", 1)
    for day, row in days.items():
        row["repositories"] = sorted(repositories[day].values(), key=lambda repo: repo["id"])
        for metric in ("prs", "commits"):
            known = "known" + metric.capitalize()
            observed = sum(repo[known] for repo in row["repositories"])
            complete = prs_complete if metric == "prs" else commits_complete
            row[known] = observed if observed or complete else None
            for repo in row["repositories"]:
                if not repo[known] and not complete:
                    repo[known] = None
            if exact:
                row[metric] = row[known]
                for repo in row["repositories"]:
                    repo[metric] = repo[known]
    return list(days.values())


def visibility_proven(profile, first, at, totals):
    proof = profile["visibilityProof"]
    if not isinstance(proof, dict):
        return False
    try:
        return (proof["stableId"] == profile["stableId"]
                and proof["metricDefinition"] == DEFINITION and proof["dateBasis"] == DATE_BASIS
                and proof["startDay"] == first.isoformat()
                and proof["endDay"] == china_day(at)
                and instant(proof["asOfAt"]) == at
                and re.fullmatch(r"[0-9a-f]{64}", proof["evidenceSha256"]) is not None
                and count(proof["prs"]) == totals["prs"]
                and count(proof["commits"]) == totals["commits"])
    except (KeyError, TypeError, ValueError):
        return False


def collect(config, run, repository_category, *, at=None, days=60, previous=None):
    if type(days) is not int or days != 60:
        raise ValueError("profile_window_must_be_60_days")
    at = at or dt.datetime.now(UTC)
    if not isinstance(at, dt.datetime) or at.tzinfo is None:
        raise ValueError("capture_time_requires_offset")
    at = at.astimezone(UTC).replace(microsecond=0)
    profiles = config.get("githubProfiles")
    if not isinstance(profiles, list) or not 0 < len(profiles) <= MAX_ACCOUNTS:
        raise ValueError("configured_accounts_required")
    profiles = [profile_config(profile) for profile in profiles]
    identities = [source_id(profile) for profile in profiles]
    if len(set(identities)) != len(identities):
        raise ValueError("duplicate_account_scope")
    first = at.astimezone(TZ).date() - dt.timedelta(days=59)
    budget = Budget(config, run)
    sources, reasons, states = [], [], {}
    retained = {}
    if isinstance(previous, dict) and previous.get("version") == 2 and previous.get("metricDefinition") == DEFINITION and previous.get("dateBasis") == DATE_BASIS:
        state = previous.get("state", {})
        if not isinstance(state, dict) or state.get("schema") != 1 or not isinstance(state.get("sources"), dict):
            raise ValueError("Invalid GitHub event continuation")
        retained = state["sources"]
    for profile, identity in zip(profiles, identities):
        captured = stamp(dt.datetime.now(UTC))
        account = {key: profile[key] for key in ("host", "login", "stableId")}
        scope_hash = digest("github-profile-scope", account, profile["privateRepositories"])
        prior = copy.deepcopy(retained.get(identity, {}))
        if prior and (prior.get("account") != account or prior.get("scopeHash") != scope_hash):
            prior = {}
        cache = prior.get("cache", {})
        progress = prior.get("progress", {})
        if not isinstance(cache, dict) or not isinstance(progress, dict):
            raise ValueError("Invalid GitHub event continuation")
        try:
            typed = profile_records(config, profile, budget, first, at, repository_category)
            supplemental, supplement_reasons, heads, private_candidates = supplement_private(
                config, profile, budget, typed, first, at, repository_category, repository_info, instant, count, digest)
            candidates = {item["repository"]["id"]: item for item in typed["commitRepositories"]}
            for item in private_candidates:
                repo_id = item["repository"]["id"]
                if repo_id in candidates and candidates[repo_id] != item:
                    raise ValueError("conflicting_profile_repository_head")
                candidates[repo_id] = item
            history_reasons, drifted = [], set()
            for candidate in candidates.values():
                try:
                    _, complete = history_events(config, profile, budget, candidate, first, at,
                                                 cache, progress, repository_category)
                    if not complete:
                        history_reasons.append("history-incomplete")
                except (OSError, subprocess.SubprocessError, TimeoutError, KeyError, TypeError,
                        ValueError, IndexError, AttributeError) as error:
                    code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[a-z][a-z0-9_]{0,80}", str(error)) else type(error).__name__
                    history_reasons.append("history-" + code)
                    if code.startswith("head_drift_"):
                        drifted.add(candidate["repository"]["id"])
                    if isinstance(error, TimeoutError):
                        break
            raw_commits = {}
            for candidate in candidates.values():
                repo_id = candidate["repository"]["id"]
                if repo_id in drifted:
                    continue
                proof = cache.get(repo_id)
                current = (proof if isinstance(proof, dict) and proof.get("head") == candidate["head"]
                           else progress.get(repo_id))
                if not isinstance(current, dict) or current.get("head") != candidate["head"]:
                    continue
                for item in current.get("items", []):
                    authored = instant(item["authoredAt"])
                    day = china_day(authored)
                    if first.isoformat() <= day <= china_day(at) and authored <= at:
                        key = digest("github-commit", profile["host"], candidate["repository"]["providerId"], item["oid"])
                        if key in raw_commits:
                            raise ValueError("duplicate_profile_commit")
                        raw_commits[key] = {**item, "day": day, "repository": candidate["repository"], "key": key}
            typed["commits"] = list(raw_commits.values())
            totals = {metric: sum(event.get("count", 1) for event in typed[metric] + supplemental[metric]
                                   if first.isoformat() <= event["day"] <= china_day(at))
                      for metric in ("prs", "commits")}
            proof = visibility_proven(profile, first, at, totals)
            source_reasons = supplement_reasons + history_reasons + ([] if proof else ["profile_visibility_unverified"])
            exact = proof and not source_reasons
            source = {"id": identity, "account": account, "status": "ready" if exact else "partial",
                      "coverage": {"identityVerified": True, "paginationComplete": not supplement_reasons and not history_reasons,
                                   "visibilityComplete": proof, "reasons": sorted(set(source_reasons))},
                      "days": measured_days(first, at, typed, supplemental, exact, captured,
                                            not supplement_reasons, not history_reasons),
                      "provenance": {"typedProfileTotals": typed["typedTotals"],
                                     "restrictedContributions": typed["restricted"],
                                     "supplementedTotals": {metric: len(supplemental[metric]) for metric in ("prs", "commits")},
                                     "pinnedDefaultHeads": heads,
                                     "historyRepositories": len(candidates),
                                     "completedHistoryRepositories": sum(item["repository"]["id"] in cache
                                         and cache[item["repository"]["id"]].get("head") == item["head"]
                                         for item in candidates.values())}}
        except (OSError, subprocess.SubprocessError, TimeoutError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            reason = "source_" + type(error).__name__
            source = {"id": identity, "account": account, "status": "unavailable",
                      "coverage": {"identityVerified": False, "paginationComplete": False,
                                   "visibilityComplete": False, "reasons": [reason]},
                      "days": empty_days(first, at, "unavailable", captured)}
        sources.append(source)
        reasons.extend(source["coverage"]["reasons"])
        states[identity] = {"account": account, "scopeHash": scope_hash, "cache": cache, "progress": progress}
    result = {"version": 2, "metricDefinition": DEFINITION, "provider": "github",
              "asOfAt": stamp(at), "capturedAt": stamp(dt.datetime.now(UTC)), "dateBasis": DATE_BASIS,
              "operationWindow": {"startDay": first.isoformat(), "endDay": china_day(at),
                                  "todayPartial": True},
              "activeSourceIds": identities, "sources": sources,
              "collection": {"requestCount": budget.requests, "elapsedSeconds": budget.elapsed(),
                             "complete": not reasons, "reasons": sorted(set(reasons))},
              "state": {"schema": 1, "sources": states}}
    if budget.rate_limit is not None:
        result["collection"]["rateLimit"] = budget.rate_limit
    return result
