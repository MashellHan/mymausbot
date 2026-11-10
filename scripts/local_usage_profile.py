"""Collect GitHub Profile contributions from explicit authenticated accounts."""

import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
import time
from urllib.parse import urlsplit

from local_usage_profile_private import supplement_private


DEFINITION = "github-profile-v2"
DATE_BASIS = {"prs": "github-profile-day", "commits": "github-profile-day"}
MAX_ACCOUNTS = 24
MAX_REQUESTS = 120
MAX_SECONDS = 180
MAX_PROFILE_PAGES = 100
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_COUNT = 2**53 - 1
UTC = dt.timezone.utc

PROFILE_QUERY = """query($from: DateTime!, $to: DateTime!, $after: String) {
  viewer {
    id login url
    contributionsCollection(from: $from, to: $to) {
      startedAt endedAt hasAnyRestrictedContributions restrictedContributionsCount
      totalCommitContributions totalRepositoriesWithContributedCommits
      totalPullRequestContributions(excludeFirst: false, excludePopular: false)
      commitContributionsByRepository(maxRepositories: 100) {
        repository { id nameWithOwner isPrivate isFork }
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


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})", value):
        raise ValueError("invalid_instant")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("invalid_instant")
    return parsed.astimezone(UTC)


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
    start = dt.datetime.combine(first - dt.timedelta(days=1), dt.time.min, UTC)
    after, seen_cursors, prs, commits, repositories = None, set(), {}, [], {}
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
            for group in groups:
                repo = repository_info(group["repository"], profile, config, repository_category)
                if repo["id"] in repositories:
                    raise ValueError("duplicate_profile_repository")
                repositories[repo["id"]] = repo
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
                    commits.append({"day": day, "repository": repo, "count": count(node["commitCount"])})
            if sum(item["count"] for item in commits) != count(collection["totalCommitContributions"]):
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
            prs[key] = {"day": node["occurredAt"][:10], "repository": repo, "key": key}
        page = connection["pageInfo"]
        if page["hasNextPage"] is False:
            if len(prs) != total:
                raise ValueError("incomplete_pr_pages")
            return {"prs": list(prs.values()), "commits": commits,
                    "prKeys": set(prs), "prRepositoryIds": {pr["repository"]["id"] for pr in prs.values()},
                    "commitRepositoryIds": {commit["repository"]["id"] for commit in commits},
                    "restricted": count(collection["restrictedContributionsCount"]),
                    "typedTotals": {"prs": total, "commits": count(collection["totalCommitContributions"])}}
        cursor = page["endCursor"]
        if page["hasNextPage"] is not True or not isinstance(cursor, str) or not cursor or cursor in seen_cursors:
            raise ValueError("invalid_pr_cursor")
        seen_cursors.add(cursor)
        after = cursor
    raise ValueError("profile_page_budget_exhausted")


def empty_days(first, at, status, captured):
    return [{"day": (first + dt.timedelta(days=offset)).isoformat(), "capturedAt": captured,
             "status": status, "prs": None, "knownPrs": None, "commits": None,
             "knownCommits": None, "repositories": []} for offset in range(60)]


def measured_days(first, at, typed, supplement, exact, captured):
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
            row[known] = sum(repo[known] for repo in row["repositories"])
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
                and proof["startDay"] == first.isoformat()
                and proof["endDay"] == at.date().isoformat()
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
    first = at.date() - dt.timedelta(days=59)
    budget = Budget(config, run)
    sources, reasons = [], []
    for profile, identity in zip(profiles, identities):
        captured = stamp(dt.datetime.now(UTC))
        account = {key: profile[key] for key in ("host", "login", "stableId")}
        try:
            typed = profile_records(config, profile, budget, first, at, repository_category)
            supplemental, supplement_reasons, heads = supplement_private(
                config, profile, budget, typed, first, at, repository_category, repository_info, instant, count, digest)
            totals = {metric: sum(event.get("count", 1) for event in typed[metric] + supplemental[metric]
                                   if first.isoformat() <= event["day"] <= at.date().isoformat())
                      for metric in ("prs", "commits")}
            proof = visibility_proven(profile, first, at, totals)
            source_reasons = supplement_reasons + ([] if proof else ["profile_visibility_unverified"])
            exact = proof and not source_reasons
            source = {"id": identity, "account": account, "status": "ready" if exact else "partial",
                      "coverage": {"identityVerified": True, "paginationComplete": not supplement_reasons,
                                   "visibilityComplete": exact, "reasons": source_reasons},
                      "days": measured_days(first, at, typed, supplemental, exact, captured),
                      "provenance": {"typedProfileTotals": typed["typedTotals"],
                                     "restrictedContributions": typed["restricted"],
                                     "supplementedTotals": {metric: len(supplemental[metric]) for metric in ("prs", "commits")},
                                     "pinnedDefaultHeads": heads}}
        except (OSError, subprocess.SubprocessError, TimeoutError, KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
            reason = "source_" + type(error).__name__
            source = {"id": identity, "account": account, "status": "unavailable",
                      "coverage": {"identityVerified": False, "paginationComplete": False,
                                   "visibilityComplete": False, "reasons": [reason]},
                      "days": empty_days(first, at, "unavailable", captured)}
        sources.append(source)
        reasons.extend(source["coverage"]["reasons"])
    result = {"version": 2, "metricDefinition": DEFINITION, "provider": "github",
              "asOfAt": stamp(at), "capturedAt": stamp(dt.datetime.now(UTC)), "dateBasis": DATE_BASIS,
              "operationWindow": {"startDay": first.isoformat(), "endDay": at.date().isoformat(),
                                  "todayPartial": True},
              "activeSourceIds": identities, "sources": sources,
              "collection": {"requestCount": budget.requests, "elapsedSeconds": budget.elapsed(),
                             "complete": not reasons, "reasons": sorted(set(reasons))}}
    if budget.rate_limit is not None:
        result["collection"]["rateLimit"] = budget.rate_limit
    return result
