"""Qualify private GitHub Profile supplements against pinned remote history."""

import datetime as dt
import re
import subprocess
from zoneinfo import ZoneInfo


MAX_PRIVATE_REPOSITORIES = 20
MAX_PRIVATE_PAGES = 100
TZ = ZoneInfo("Asia/Shanghai")
PRIVATE_CODES = {
    "private_repository_ineligible", "private_default_head_unavailable", "private_repository_changed",
    "private_pr_total_changed", "invalid_private_pr_page", "invalid_private_pr",
    "incomplete_private_pr_inventory", "private_pr_page_budget_exhausted", "private_head_changed",
    "private_history_changed", "invalid_private_history_page", "invalid_private_commit",
    "incomplete_private_authors", "private_commit_eligibility_uncertain", "incomplete_private_history",
    "private_history_page_budget_exhausted", "duplicate_private_repository", "private_default_head_changed",
    "private_pr_overlap", "private_commit_overlap", "invalid_private_cursor", "private_owner_unverified",
}

REPOSITORY_QUERY = """query($owner: String!, $name: String!) {
  viewer { id login url }
  repository(owner: $owner, name: $name) {
    id nameWithOwner isPrivate isFork createdAt
    owner { login ... on User { id } }
    defaultBranchRef { name target { ... on Commit { oid } } }
  }
  rateLimit { cost remaining resetAt }
}"""

PULL_REQUESTS_QUERY = """query($owner: String!, $name: String!, $after: String) {
  viewer { id login url }
  repository(owner: $owner, name: $name) {
    id
    pullRequests(first: 100, after: $after, states: [OPEN, CLOSED, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { id createdAt author { login ... on User { id } } }
    }
  }
  rateLimit { cost remaining resetAt }
}"""

FOCUSED_PULL_REQUESTS_QUERY = """query($q: String!, $after: String) {
  viewer { id login url }
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      id createdAt author { login ... on User { id } }
      repository { id }
    } }
  }
  rateLimit { cost remaining resetAt }
}"""

HISTORY_QUERY = """query($owner: String!, $name: String!, $head: GitObjectID!, $after: String) {
  viewer { id login url }
  repository(owner: $owner, name: $name) {
    id
    object(oid: $head) { ... on Commit {
      oid
      history(first: 100, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          oid authoredDate parents(first: 2) { totalCount }
          authors(first: 100) {
            totalCount pageInfo { hasNextPage }
            nodes { user { id } }
          }
        }
      }
    } }
  }
  rateLimit { cost remaining resetAt }
}"""


def _cursor(page, seen):
    if page["hasNextPage"] is False:
        return None
    cursor = page["endCursor"]
    if page["hasNextPage"] is not True or not isinstance(cursor, str) or not cursor or cursor in seen:
        raise ValueError("invalid_private_cursor")
    seen.add(cursor)
    return cursor


def _repository(budget, profile, owner, name, instant):
    data = budget.query(profile, REPOSITORY_QUERY, {"owner": owner, "name": name})
    repo = data["repository"]
    if (not isinstance(repo, dict) or repo.get("nameWithOwner", "").casefold() != f"{owner}/{name}".casefold()
            or repo.get("isPrivate") is not True or repo.get("isFork") is not False):
        raise ValueError("private_repository_ineligible")
    relationship = repo.get("owner")
    if (not isinstance(relationship, dict) or relationship.get("id") != profile["stableId"]
            or not isinstance(relationship.get("login"), str)
            or relationship["login"].casefold() != profile["login"].casefold()):
        raise ValueError("private_owner_unverified")
    created = instant(repo["createdAt"])
    branch = repo["defaultBranchRef"]
    if (not isinstance(branch, dict) or not isinstance(branch.get("name"), str) or not branch["name"]
            or not isinstance(branch.get("target"), dict)
            or not isinstance(branch["target"].get("oid"), str)
            or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", branch["target"]["oid"], re.I)):
        raise ValueError("private_default_head_unavailable")
    return repo, created, branch["target"]["oid"].lower(), branch["name"]


def _private_prs(budget, profile, owner, name, repo, created, at, first, info, instant, digest):
    events, seen, cursors, after, total = [], set(), set(), None, None
    for _ in range(MAX_PRIVATE_PAGES):
        data = budget.query(profile, PULL_REQUESTS_QUERY, {"owner": owner, "name": name, "after": after})
        response_repo = data["repository"]
        if not isinstance(response_repo, dict) or response_repo.get("id") != repo["id"]:
            raise ValueError("private_repository_changed")
        connection = response_repo["pullRequests"]
        value = connection["totalCount"]
        if type(value) is not int or value < 0 or (total is not None and value != total):
            raise ValueError("private_pr_total_changed")
        total = value
        nodes = connection["nodes"]
        if not isinstance(nodes, list) or len(nodes) > 100:
            raise ValueError("invalid_private_pr_page")
        for node in nodes:
            key = node["id"]
            when = instant(node["createdAt"])
            day = when.astimezone(TZ).date().isoformat()
            if not isinstance(key, str) or not key or key in seen or when < created or when > at:
                if when > at:
                    seen.add(key)
                    continue
                raise ValueError("invalid_private_pr")
            seen.add(key)
            author = node.get("author")
            if (isinstance(author, dict) and author.get("id") == profile["stableId"]
                    and isinstance(author.get("login"), str)
                    and author["login"].casefold() == profile["login"].casefold()
                    and first.isoformat() <= day <= at.astimezone(TZ).date().isoformat()):
                events.append({"day": day, "createdAt": when.isoformat().replace("+00:00", "Z"), "repository": info,
                               "key": digest("github-pr", profile["host"], key)})
        after = _cursor(connection["pageInfo"], cursors)
        if after is None:
            if len(seen) != total:
                raise ValueError("incomplete_private_pr_inventory")
            return events
    raise ValueError("private_pr_page_budget_exhausted")


def _focused_private_prs(budget, profile, owner, name, repo, created, at, first, focus_start,
                         info, retained, instant, digest):
    start = dt.datetime.combine(focus_start, dt.time.min, TZ).astimezone(dt.timezone.utc)
    query = (f"repo:{owner}/{name} is:pr author:{profile['login']} "
             f"created:{start.isoformat().replace('+00:00', 'Z')}..{at.isoformat().replace('+00:00', 'Z')}")
    events = {item["key"]: {**item, "repository": info} for item in retained
              if item["repository"]["id"] == info["id"] and first.isoformat() <= item["day"] < focus_start.isoformat()}
    seen, cursors, after, total = set(), set(), None, None
    for _ in range(MAX_PRIVATE_PAGES):
        data = budget.query(profile, FOCUSED_PULL_REQUESTS_QUERY, {"q": query, "after": after})
        connection = data["search"]
        value, nodes = connection["issueCount"], connection["nodes"]
        if (type(value) is not int or not 0 <= value <= 1000 or total is not None and value != total
                or not isinstance(nodes, list) or len(nodes) > 100):
            raise ValueError("invalid_private_pr_page")
        total = value
        for node in nodes:
            key = node["id"]
            when = instant(node["createdAt"])
            author = node.get("author")
            if (not isinstance(key, str) or not key or key in seen or node["repository"]["id"] != repo["id"]
                    or not start <= when <= at or when < created
                    or not isinstance(author, dict) or author.get("id") != profile["stableId"]
                    or author.get("login", "").casefold() != profile["login"].casefold()):
                raise ValueError("invalid_private_pr")
            seen.add(key)
            event_key = digest("github-pr", profile["host"], key)
            events[event_key] = {"day": when.astimezone(TZ).date().isoformat(),
                                 "createdAt": when.isoformat().replace("+00:00", "Z"),
                                 "repository": info, "key": event_key}
        after = _cursor(connection["pageInfo"], cursors)
        if after is None:
            if len(seen) != total:
                raise ValueError("incomplete_private_pr_inventory")
            return list(events.values())
    raise ValueError("private_pr_page_budget_exhausted")


def supplement_private(config, profile, budget, typed, first, at, repository_category,
                       repository_info, instant, count, digest, focus_start=None, retained_prs=None):
    configured_candidates = profile["privateRepositories"]
    if not isinstance(configured_candidates, list) or len(configured_candidates) > MAX_PRIVATE_REPOSITORIES:
        raise ValueError("invalid_private_repository_config")
    names = set()
    for candidate in configured_candidates:
        if (not isinstance(candidate, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", candidate)
                or any(part in (".", "..") for part in candidate.split("/"))
                or candidate.casefold() in names):
            raise ValueError("invalid_private_repository_config")
        names.add(candidate.casefold())
    result, reasons, heads, history_candidates, seen_repositories = {"prs": [], "commits": []}, [], [], [], set()
    for candidate in configured_candidates:
        owner, name = candidate.split("/")
        try:
            repo, created, head, branch = _repository(budget, profile, owner, name, instant)
            info = repository_info(repo, profile, config, repository_category)
            if info["id"] in seen_repositories:
                raise ValueError("duplicate_private_repository")
            seen_repositories.add(info["id"])
            if info["id"] in typed["prRepositoryIds"]:
                retained = {item["key"]: {**item, "repository": info} for item in retained_prs or []
                    if focus_start is not None and item["repository"]["id"] == info["id"]
                    and first.isoformat() <= item["day"] < focus_start.isoformat()
                    and item["key"] not in typed["prKeys"]}
                pending_prs = list(retained.values())
            elif focus_start is not None and retained_prs is not None:
                pending_prs = _focused_private_prs(budget, profile, owner, name, repo, created, at, first,
                                                   focus_start, info, retained_prs, instant, digest)
            else:
                pending_prs = _private_prs(budget, profile, owner, name, repo, created, at, first,
                                           info, instant, digest)
            latest, _, latest_head, _ = _repository(budget, profile, owner, name, instant)
            if latest["id"] != repo["id"] or latest_head != head:
                raise ValueError("private_default_head_changed")
            if any(event["key"] in typed["prKeys"] for event in pending_prs):
                raise ValueError("private_pr_overlap")
            result["prs"].extend(pending_prs)
            history_candidates.append({"repository": info, "owner": owner, "name": name,
                               "createdAt": created.isoformat().replace("+00:00", "Z"),
                               "branch": branch, "head": head})
            heads.append({"repositoryId": info["id"], "head": head,
                          "prs": len(pending_prs), "commits": None})
        except ValueError as error:
            if str(error) == "account_identity_mismatch":
                raise
            reasons.append("private_" + (str(error) if str(error) in PRIVATE_CODES else "invalid_response"))
        except (OSError, subprocess.SubprocessError, TimeoutError, KeyError, TypeError, IndexError, AttributeError) as error:
            reasons.append("private_" + type(error).__name__)
    return result, reasons, heads, history_candidates
