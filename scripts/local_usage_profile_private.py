"""Qualify private GitHub Profile supplements against pinned remote history."""

import re


MAX_PRIVATE_REPOSITORIES = 20
MAX_PRIVATE_PAGES = 100
PRIVATE_CODES = {
    "private_repository_ineligible", "private_default_head_unavailable", "private_repository_changed",
    "private_pr_total_changed", "invalid_private_pr_page", "invalid_private_pr",
    "incomplete_private_pr_inventory", "private_pr_page_budget_exhausted", "private_head_changed",
    "private_history_changed", "invalid_private_history_page", "invalid_private_commit",
    "incomplete_private_authors", "private_commit_eligibility_uncertain", "incomplete_private_history",
    "private_history_page_budget_exhausted", "duplicate_private_repository", "private_default_head_changed",
    "private_pr_overlap", "private_commit_overlap", "invalid_private_cursor",
}

REPOSITORY_QUERY = """query($owner: String!, $name: String!) {
  viewer { id login url }
  repository(owner: $owner, name: $name) {
    id nameWithOwner isPrivate isFork createdAt
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

HISTORY_QUERY = """query($owner: String!, $name: String!, $head: GitObjectID!, $after: String) {
  viewer { id login url }
  repository(owner: $owner, name: $name) {
    id
    object(oid: $head) { ... on Commit {
      oid
      history(first: 100, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          oid authoredDate
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
    created = instant(repo["createdAt"])
    branch = repo["defaultBranchRef"]
    if (not isinstance(branch, dict) or not isinstance(branch.get("name"), str) or not branch["name"]
            or not isinstance(branch.get("target"), dict)
            or not isinstance(branch["target"].get("oid"), str)
            or not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", branch["target"]["oid"], re.I)):
        raise ValueError("private_default_head_unavailable")
    return repo, created, branch["target"]["oid"].lower()


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
            day = node["createdAt"][:10]
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
                    and first.isoformat() <= day <= at.date().isoformat()):
                events.append({"day": day, "repository": info,
                               "key": digest("github-pr", profile["host"], key)})
        after = _cursor(connection["pageInfo"], cursors)
        if after is None:
            if len(seen) != total:
                raise ValueError("incomplete_private_pr_inventory")
            return events
    raise ValueError("private_pr_page_budget_exhausted")


def _private_commits(budget, profile, owner, name, repo, created, head, at, first, info, instant, count, digest):
    events, seen, cursors, after, total = [], set(), set(), None, None
    for _ in range(MAX_PRIVATE_PAGES):
        data = budget.query(profile, HISTORY_QUERY, {"owner": owner, "name": name, "head": head, "after": after})
        response_repo = data["repository"]
        if not isinstance(response_repo, dict) or response_repo.get("id") != repo["id"]:
            raise ValueError("private_repository_changed")
        commit = response_repo["object"]
        if not isinstance(commit, dict) or commit.get("oid", "").lower() != head:
            raise ValueError("private_head_changed")
        history = commit["history"]
        value = count(history["totalCount"])
        if total is not None and total != value:
            raise ValueError("private_history_changed")
        total = value
        nodes = history["nodes"]
        if not isinstance(nodes, list) or len(nodes) > 100:
            raise ValueError("invalid_private_history_page")
        for node in nodes:
            oid = node["oid"].lower()
            authored = instant(node["authoredDate"])
            day = node["authoredDate"][:10]
            if not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", oid, re.I) or oid in seen:
                raise ValueError("invalid_private_commit")
            seen.add(oid)
            authors = node["authors"]
            actors = authors["nodes"]
            if (not isinstance(actors, list) or len(actors) > 100
                    or authors["pageInfo"]["hasNextPage"] is not False
                    or count(authors["totalCount"]) != len(actors)):
                raise ValueError("incomplete_private_authors")
            if (any(isinstance(actor, dict) and isinstance(actor.get("user"), dict)
                    and actor["user"].get("id") == profile["stableId"] for actor in actors)
                    and first.isoformat() <= day <= at.date().isoformat()):
                if authored > at:
                    continue
                if authored < created:
                    raise ValueError("private_commit_eligibility_uncertain")
                events.append({"day": day, "repository": info, "count": 1,
                               "key": digest("github-private-commit", profile["host"], repo["id"], oid),
                               "oid": oid})
        after = _cursor(history["pageInfo"], cursors)
        if after is None:
            if len(seen) != total:
                raise ValueError("incomplete_private_history")
            return events
    raise ValueError("private_history_page_budget_exhausted")


def supplement_private(config, profile, budget, typed, first, at, repository_category,
                       repository_info, instant, count, digest):
    candidates = profile["privateRepositories"]
    if not isinstance(candidates, list) or len(candidates) > MAX_PRIVATE_REPOSITORIES:
        raise ValueError("invalid_private_repository_config")
    names = set()
    for candidate in candidates:
        if (not isinstance(candidate, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", candidate)
                or any(part in (".", "..") for part in candidate.split("/"))
                or candidate.casefold() in names):
            raise ValueError("invalid_private_repository_config")
        names.add(candidate.casefold())
    result, reasons, heads, seen_repositories, seen_oids = {"prs": [], "commits": []}, [], [], set(), set()
    for candidate in candidates:
        owner, name = candidate.split("/")
        try:
            repo, created, head = _repository(budget, profile, owner, name, instant)
            info = repository_info(repo, profile, config, repository_category)
            if info["id"] in seen_repositories:
                raise ValueError("duplicate_private_repository")
            seen_repositories.add(info["id"])
            pending_prs = [] if info["id"] in typed["prRepositoryIds"] else _private_prs(
                budget, profile, owner, name, repo, created, at, first, info, instant, digest)
            pending_commits = [] if info["id"] in typed["commitRepositoryIds"] else _private_commits(
                budget, profile, owner, name, repo, created, head, at, first, info, instant, count, digest)
            latest, _, latest_head = _repository(budget, profile, owner, name, instant)
            if latest["id"] != repo["id"] or latest_head != head:
                raise ValueError("private_default_head_changed")
            if any(event["key"] in typed["prKeys"] for event in pending_prs):
                raise ValueError("private_pr_overlap")
            if any(event["oid"] in seen_oids for event in pending_commits):
                raise ValueError("private_commit_overlap")
            seen_oids.update(event["oid"] for event in pending_commits)
            result["prs"].extend(pending_prs)
            result["commits"].extend(pending_commits)
            heads.append({"repositoryId": info["id"], "head": head,
                          "prs": len(pending_prs), "commits": len(pending_commits)})
        except ValueError as error:
            if str(error) == "account_identity_mismatch":
                raise
            reasons.append("private_" + (str(error) if str(error) in PRIVATE_CODES else "invalid_response"))
        except (OSError, TimeoutError, KeyError, TypeError, IndexError, AttributeError) as error:
            reasons.append("private_" + type(error).__name__)
    for events in result.values():
        for event in events:
            event.pop("oid", None)
    return result, reasons, heads
