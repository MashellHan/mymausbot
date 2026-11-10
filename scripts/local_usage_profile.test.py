import copy
import datetime as dt
import json
import re
import unittest
from unittest.mock import patch

import local_usage_profile as profile
import local_usage_profile_private as private


AT = dt.datetime.fromisoformat("2026-11-09T12:00:00+00:00")
ACCOUNT = {"host": "github.com", "login": "fixture-owner", "stableId": "fixture-account-id",
           "profile": "fixture", "privateRepositories": ["fixture-owner/private-repo"]}
CONFIG = {"githubHelper": "/fixture/helper", "githubProfiles": [ACCOUNT]}
HEAD = "a" * 40
PUBLIC = {"id": "public-repo-id", "nameWithOwner": "fixture-owner/public-repo",
          "isPrivate": False, "isFork": True}
PRIVATE = {"id": "private-repo-id", "nameWithOwner": "fixture-owner/private-repo",
           "isPrivate": True, "isFork": False}


def proof(prs=3, commits=4):
    return {"stableId": ACCOUNT["stableId"], "startDay": "2026-09-11", "endDay": "2026-11-09",
            "asOfAt": "2026-11-09T12:00:00Z", "prs": prs, "commits": commits,
            "evidenceSha256": "b" * 64}


class Api:
    def __init__(self):
        self.calls = []
        self.changed_head = False
        self.truncate_prs = False
        self.fail = False
        self.account = ACCOUNT
        self.duplicate_private = False
        self.metadata_reads = 0
        self.commit_dates = ("2026-09-11T08:00:00Z", "2026-11-09T11:00:00Z")
        self.private_pr_date = "2026-11-09T10:00:00Z"

    def __call__(self, args, timeout):
        self.calls.append(args)
        assert 0 < timeout <= 30
        if self.fail:
            raise OSError("synthetic expired credential")
        values = {args[i+1].split("=", 1)[0]: args[i+1].split("=", 1)[1]
                  for i, value in enumerate(args[:-1]) if value == "-f"}
        document = values["query"]
        viewer = {"id": self.account["stableId"], "login": self.account["login"],
                  "url": f"https://{self.account['host']}/{self.account['login']}"}
        if "contributionsCollection" in document:
            nodes = [{"occurredAt": f"2026-11-09T09:0{i}:00Z", "pullRequest": {
                "id": f"public-pr-{i}", "createdAt": f"2026-11-09T09:0{i}:00Z",
                "author": {"id": viewer["id"], "login": viewer["login"]}, "repository": PUBLIC}}
                for i in (1, 2)]
            after = values.get("after")
            page_nodes = nodes[1:] if after else nodes[:1]
            more = not after and not self.truncate_prs
            viewer["contributionsCollection"] = {
                "startedAt": values["from"], "endedAt": values["to"],
                "hasAnyRestrictedContributions": False, "restrictedContributionsCount": 0,
                "totalCommitContributions": 2, "totalRepositoriesWithContributedCommits": 1,
                "totalPullRequestContributions": 2,
                "commitContributionsByRepository": [{"repository": PUBLIC, "contributions": {
                    "totalCount": 2, "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [{"occurredAt": "2026-11-09T08:00:00Z", "commitCount": 2}]}}],
                "pullRequestContributions": {"totalCount": 2, "nodes": page_nodes,
                    "pageInfo": {"hasNextPage": more, "endCursor": "profile-next" if more else None}}}
            data = {"viewer": viewer}
        elif "defaultBranchRef" in document:
            self.metadata_reads += 1
            head = "c" * 40 if self.changed_head and self.metadata_reads > 1 else HEAD
            data = {"viewer": viewer, "repository": {**PRIVATE, "createdAt": "2026-09-10T00:00:00Z",
                "defaultBranchRef": {"name": "main", "target": {"oid": head}}}}
        elif "pullRequests(first:" in document:
            data = {"viewer": viewer, "repository": {"id": PRIVATE["id"],
                "pullRequests": {"totalCount": 1, "pageInfo": {"hasNextPage": False,
                    "endCursor": None}, "nodes": [{"id": "public-pr-1" if self.duplicate_private else "private-pr-1",
                    "createdAt": self.private_pr_date, "author": {"id": viewer["id"],
                    "login": viewer["login"]}}]}}}
        elif "history(first:" in document:
            after = values.get("after")
            oid, authored = (("d" * 40, self.commit_dates[0]) if not after
                             else ("e" * 40, self.commit_dates[1]))
            data = {"viewer": viewer, "repository": {"id": PRIVATE["id"], "object": {
                "oid": HEAD, "history": {"totalCount": 2, "pageInfo": {
                    "hasNextPage": not after, "endCursor": "history-next" if not after else None},
                    "nodes": [{"oid": oid, "authoredDate": authored,
                        "authors": {"totalCount": 1, "pageInfo": {"hasNextPage": False},
                                    "nodes": [{"user": {"id": viewer["id"]}}]}}]}}}}
        else:
            raise AssertionError("Unexpected GraphQL document")
        data["rateLimit"] = {"cost": 1, "remaining": 4999 - len(self.calls),
                             "resetAt": "2026-11-09T13:00:00Z"}
        return json.dumps({"data": data})


def collect(api=None, account=None, at=AT):
    configured = copy.deepcopy(account or ACCOUNT)
    return profile.collect({**CONFIG, "githubProfiles": [configured]}, api or Api(),
                           lambda remote, config: "personal", at=at)


class ProfileV2Tests(unittest.TestCase):
    def test_profile_pages_private_history_and_reconciliation(self):
        api = Api()
        result = collect(api, {**ACCOUNT, "visibilityProof": proof()})
        source = result["sources"][0]
        self.assertEqual(result["operationWindow"], {"startDay": "2026-09-11",
            "endDay": "2026-11-09", "todayPartial": True})
        self.assertEqual(result["dateBasis"], {"prs": "github-profile-day", "commits": "github-profile-day"})
        self.assertEqual(source["status"], "ready")
        self.assertEqual(len(source["days"]), 60)
        self.assertEqual(sum(row["prs"] for row in source["days"]), 3)
        self.assertEqual(sum(row["commits"] for row in source["days"]), 4)
        self.assertEqual(source["days"][0]["commits"], 1)
        self.assertEqual(source["provenance"]["supplementedTotals"], {"prs": 1, "commits": 2})
        self.assertEqual(result["collection"]["requestCount"], 7)
        self.assertTrue(result["collection"]["complete"])
        self.assertIn("excludeFirst: false, excludePopular: false", profile.PROFILE_QUERY)
        self.assertTrue(any("after=profile-next" in call for call in api.calls))
        self.assertTrue(any("after=history-next" in call for call in api.calls))
        self.assertFalse(any(arg == "git" for call in api.calls for arg in call))

    def test_restricted_zero_without_proof_stays_partial_with_known_values(self):
        source = collect()["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertFalse(source["coverage"]["visibilityComplete"])
        self.assertIn("profile_visibility_unverified", source["coverage"]["reasons"])
        self.assertIsNone(source["days"][-1]["prs"])
        self.assertEqual(source["days"][-1]["knownPrs"], 3)
        self.assertEqual(source["days"][-1]["knownCommits"], 3)

    def test_historical_fork_records_are_not_filtered(self):
        source = collect()["sources"][0]
        self.assertEqual(source["days"][-1]["knownPrs"], 3)
        self.assertEqual(source["days"][-1]["repositories"][0]["knownPrs"], 2)

    def test_account_mismatch_and_expired_credentials_are_unavailable(self):
        for kind in ("mismatch", "expired"):
            with self.subTest(kind=kind):
                api = Api()
                api.account = {**ACCOUNT, "stableId": "wrong-account-id"} if kind == "mismatch" else ACCOUNT
                api.fail = kind == "expired"
                source = collect(api)["sources"][0]
                self.assertEqual(source["status"], "unavailable")
                self.assertFalse(source["coverage"]["identityVerified"])
                self.assertTrue(all(day["prs"] is None and day["knownPrs"] is None for day in source["days"]))

    def test_incomplete_profile_and_private_overlap_fail_closed(self):
        api = Api()
        api.truncate_prs = True
        self.assertEqual(collect(api)["sources"][0]["status"], "unavailable")
        api = Api()
        api.duplicate_private = True
        source = collect(api, {**ACCOUNT, "visibilityProof": proof()})["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertFalse(source["coverage"]["paginationComplete"])
        self.assertEqual(source["days"][-1]["knownPrs"], 2)
        self.assertIsNone(source["days"][-1]["prs"])

    def test_changed_default_head_and_budget_keep_typed_subtotal(self):
        api = Api()
        api.changed_head = True
        source = collect(api)["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["days"][-1]["knownPrs"], 2)
        self.assertIn("private_private_default_head_changed", source["coverage"]["reasons"])
        with patch.object(profile, "MAX_REQUESTS", 2):
            self.assertEqual(collect(Api())["sources"][0]["status"], "partial")

    def test_invalid_identity_config_and_window_refuse(self):
        api = Api()
        with self.assertRaises(ValueError):
            collect(api, {**ACCOUNT, "stableId": None})
        with self.assertRaises(ValueError):
            profile.collect(CONFIG, api, lambda remote, config: "personal", at=AT, days=59)
        source = collect(Api(), {**ACCOUNT, "privateRepositories": ["../escape"]})["sources"][0]
        self.assertEqual(source["status"], "unavailable")

    def test_repeated_snapshot_replaces_not_adds(self):
        api = Api()
        first = collect(api, {**ACCOUNT, "visibilityProof": proof()})
        second = profile.collect({**CONFIG, "githubProfiles": [{**ACCOUNT, "visibilityProof": proof()}]},
                                 api, lambda remote, config: "personal", at=AT, previous=first)
        self.assertEqual(first["sources"][0]["days"], second["sources"][0]["days"])
        self.assertEqual(first["activeSourceIds"], second["activeSourceIds"])

    def test_four_account_scopes_and_one_provider_failure_stay_separate(self):
        profiles = [
            {"host": "github.com", "login": "first", "stableId": "stable-first", "profile": "one"},
            {"host": "github.com", "login": "second", "stableId": "stable-second", "profile": "two"},
            {"host": "one.ghe.com", "login": "third", "stableId": "stable-third", "profile": "three"},
            {"host": "two.ghe.com", "login": "fourth", "stableId": "stable-fourth", "profile": "four"},
        ]
        accounts = {row["profile"]: row for row in profiles}
        def run(args, timeout):
            alias = args[3]
            if alias == "three":
                raise OSError("synthetic provider failure")
            row = accounts[alias]
            variables = {args[i+1].split("=", 1)[0]: args[i+1].split("=", 1)[1]
                         for i, value in enumerate(args[:-1]) if value == "-f"}
            collection = {"startedAt": variables["from"], "endedAt": variables["to"],
                "hasAnyRestrictedContributions": False, "restrictedContributionsCount": 0,
                "totalCommitContributions": 0, "totalRepositoriesWithContributedCommits": 0,
                "totalPullRequestContributions": 0, "commitContributionsByRepository": [],
                "pullRequestContributions": {"totalCount": 0, "nodes": [],
                    "pageInfo": {"hasNextPage": False, "endCursor": None}}}
            return json.dumps({"data": {"viewer": {"id": row["stableId"], "login": row["login"],
                "url": f"https://{row['host']}/{row['login']}", "contributionsCollection": collection}}})
        result = profile.collect({"githubHelper": "/fixture/helper", "githubProfiles": profiles},
                                 run, lambda remote, config: "work", at=AT)
        self.assertEqual(len(set(result["activeSourceIds"])), 4)
        self.assertEqual([source["status"] for source in result["sources"]],
                         ["partial", "partial", "unavailable", "partial"])
        self.assertEqual(result["sources"][0]["days"][-1]["knownPrs"], 0)
        self.assertIsNone(result["sources"][0]["days"][-1]["prs"])
        self.assertIsNone(result["sources"][2]["days"][-1]["knownPrs"])

    def test_profile_day_uses_source_timestamp_not_china_midnight(self):
        api = Api()
        original = api.__call__
        def run(args, timeout):
            response = json.loads(original(args, timeout))
            document = next(value[6:] for value in args if value.startswith("query="))
            if "contributionsCollection" in document:
                nodes = response["data"]["viewer"]["contributionsCollection"]["pullRequestContributions"]["nodes"]
                for node in nodes:
                    node["occurredAt"] = "2026-11-08T23:59:59Z"
            return json.dumps(response)
        source = collect(run)["sources"][0]
        self.assertEqual(source["days"][-2]["knownPrs"], 2)
        self.assertEqual(source["days"][-1]["knownPrs"], 1)

    def test_mismatched_independent_proof_never_makes_exact_counts(self):
        source = collect(Api(), {**ACCOUNT, "visibilityProof": proof(prs=999)})["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertFalse(source["coverage"]["visibilityComplete"])
        self.assertIsNone(source["days"][-1]["prs"])

    def test_actor_schema_requires_user_fragment_on_both_pr_queries(self):
        api = Api()
        checked = []
        def schema_run(args, timeout):
            document = next(value[6:] for value in args if value.startswith("query="))
            if re.search(r"\bauthor\s*\{", document):
                checked.append(document)
                valid = re.search(r"\bauthor\s*\{\s*login\s+\.\.\.\s+on\s+User\s*\{\s*id\s*\}\s*\}", document)
                direct_actor_id = re.search(r"\bauthor\s*\{\s*(?:id\b|login\s+id\b)", document)
                if not valid or direct_actor_id:
                    return json.dumps({"errors": [{"extensions": {
                        "code": "undefinedField", "typeName": "Actor", "fieldName": "id"}}]})
            return api(args, timeout)
        self.assertEqual(collect(schema_run, {**ACCOUNT, "visibilityProof": proof()})["sources"][0]["status"], "ready")
        self.assertEqual(len(checked), 3)
        with patch.object(profile, "PROFILE_QUERY", profile.PROFILE_QUERY.replace(
                "author { login ... on User { id } }", "author { id login }")):
            self.assertEqual(collect(schema_run)["sources"][0]["status"], "unavailable")
        with patch.object(private, "PULL_REQUESTS_QUERY", private.PULL_REQUESTS_QUERY.replace(
                "author { login ... on User { id } }", "author { id login }")):
            source = collect(schema_run)["sources"][0]
            self.assertEqual(source["status"], "partial")
            self.assertIn("private_invalid_response", source["coverage"]["reasons"])

    def test_private_profile_date_uses_original_git_timestamp_at_both_boundaries(self):
        cutoff = dt.datetime.fromisoformat("2026-11-09T23:59:59+00:00")
        cases = (
            ("2026-09-11T00:30:00+08:00", "2026-11-09T11:00:00Z", 1, 1),
            ("2026-09-10T23:30:00-08:00", "2026-11-09T11:00:00Z", 0, 1),
            ("2026-09-11T08:00:00Z", "2026-11-09T23:30:00-08:00", 1, 0),
            ("2026-09-11T08:00:00Z", "2026-11-10T00:30:00+08:00", 1, 0),
        )
        for first_stamp, last_stamp, first_count, last_count in cases:
            with self.subTest(first=first_stamp, last=last_stamp):
                api = Api()
                api.commit_dates = (first_stamp, last_stamp)
                source = collect(api, at=cutoff)["sources"][0]
                self.assertEqual(source["status"], "partial")
                self.assertTrue(source["coverage"]["paginationComplete"])
                self.assertEqual(source["days"][0]["knownCommits"], first_count)
                self.assertEqual(source["days"][-1]["knownCommits"], 2 + last_count)

    def test_private_pr_profile_date_uses_original_offset_day(self):
        api = Api()
        api.private_pr_date = "2026-09-11T00:30:00+08:00"
        source = collect(api)["sources"][0]
        self.assertEqual(source["days"][0]["knownPrs"], 1)
        self.assertEqual(source["days"][-1]["knownPrs"], 2)
        api = Api()
        api.private_pr_date = "2026-09-10T23:30:00-08:00"
        source = collect(api)["sources"][0]
        self.assertEqual(source["days"][0]["knownPrs"], 0)
        self.assertEqual(source["days"][-1]["knownPrs"], 2)


if __name__ == "__main__":
    unittest.main()
