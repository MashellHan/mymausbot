import copy
import datetime as dt
import json
import re
import subprocess
import unittest
from unittest.mock import patch

import local_usage_profile as profile
import local_usage_profile_private as private
import local_usage_ado as ado


AT = dt.datetime.fromisoformat("2026-11-09T12:00:00+00:00")
ACCOUNT = {"host": "github.com", "login": "fixture-owner", "stableId": "fixture-account-id",
           "profile": "fixture", "privateRepositories": ["fixture-owner/private-repo"]}
CONFIG = {"githubHelper": "/fixture/helper", "githubProfiles": [ACCOUNT]}
HEAD = "a" * 40
PUBLIC = {"id": "public-repo-id", "nameWithOwner": "fixture-owner/public-repo",
          "isPrivate": False, "isFork": True, "createdAt": "2026-09-10T00:00:00Z",
          "defaultBranchRef": {"name": "main", "target": {"oid": HEAD}}}
PRIVATE = {"id": "private-repo-id", "nameWithOwner": "fixture-owner/private-repo",
           "isPrivate": True, "isFork": False, "createdAt": "2026-09-10T00:00:00Z",
           "defaultBranchRef": {"name": "main", "target": {"oid": HEAD}}}


def proof(prs=3, commits=4):
    return {"stableId": ACCOUNT["stableId"], "startDay": "2026-09-11", "endDay": "2026-11-09",
            "asOfAt": "2026-11-09T12:00:00Z", "prs": prs, "commits": commits,
            "metricDefinition": profile.DEFINITION, "dateBasis": profile.DATE_BASIS,
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
        self.profile_commit_at = "2026-11-09T08:00:00Z"
        self.private_pr_date = "2026-11-09T10:00:00Z"
        self.repo_name = PRIVATE["nameWithOwner"]
        self.owner_id = ACCOUNT["stableId"]
        self.owner_login = ACCOUNT["login"]
        self.private_viewer_id = None
        self.fail_private_owner = None
        self.fail_private_error = None
        self.fail_private_phase = None
        self.public_head = HEAD
        self.public_history = None
        self.public_page_size = 100
        self.commit_details = {}

    def __call__(self, args, timeout):
        self.calls.append(args)
        assert 0 < timeout <= 30
        if self.fail:
            raise OSError("synthetic expired credential")
        values = {args[i+1].split("=", 1)[0]: args[i+1].split("=", 1)[1]
                  for i, value in enumerate(args[:-1]) if value == "-f"}
        document = values["query"]
        if (self.fail_private_owner is not None and values.get("owner") == self.fail_private_owner
                and (self.fail_private_phase is None or self.fail_private_phase in document)):
            raise self.fail_private_error
        viewer = {"id": self.account["stableId"], "login": self.account["login"],
                  "url": f"https://{self.account['host']}/{self.account['login']}"}
        if "contributionsCollection" not in document and self.private_viewer_id:
            viewer["id"] = self.private_viewer_id
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
                "commitContributionsByRepository": [{"repository": {**PUBLIC,
                    "defaultBranchRef": {"name": "main", "target": {"oid": self.public_head}}}, "contributions": {
                    "totalCount": 2, "pageInfo": {"hasNextPage": False, "endCursor": None},
                    "nodes": [{"occurredAt": self.profile_commit_at, "commitCount": 2}]}}],
                "pullRequestContributions": {"totalCount": 2, "nodes": page_nodes,
                    "pageInfo": {"hasNextPage": more, "endCursor": "profile-next" if more else None}}}
            data = {"viewer": viewer}
        elif "defaultBranchRef" in document:
            self.metadata_reads += 1
            head = "c" * 40 if self.changed_head and self.metadata_reads > 1 else (
                self.public_head if values.get("name") == "public-repo" else HEAD)
            raw = PUBLIC if values.get("name") == "public-repo" else PRIVATE
            data = {"viewer": viewer, "repository": {**raw, "nameWithOwner": self.repo_name if raw is PRIVATE else PUBLIC["nameWithOwner"],
                "owner": {"id": self.owner_id, "login": self.owner_login},
                "createdAt": "2026-09-10T00:00:00Z",
                "defaultBranchRef": {"name": "main", "target": {"oid": head}}}}
        elif "pullRequests(first:" in document:
            data = {"viewer": viewer, "repository": {"id": PRIVATE["id"],
                "pullRequests": {"totalCount": 1, "pageInfo": {"hasNextPage": False,
                    "endCursor": None}, "nodes": [{"id": "public-pr-1" if self.duplicate_private else "private-pr-1",
                    "createdAt": self.private_pr_date, "author": {"id": viewer["id"],
                    "login": viewer["login"]}}]}}}
        elif "history(first:" in document:
            after = values.get("after")
            is_public = values.get("name") == "public-repo"
            rows = ([(("1" * 40), self.profile_commit_at, 2), (("2" * 40), self.profile_commit_at, 1)]
                    if is_public else [(("d" * 40), self.commit_dates[0], 1), (("e" * 40), self.commit_dates[1], 2)])
            if is_public and self.public_history is not None:
                rows = self.public_history.get(values["head"], [])
            offset = int(after.split("-")[-1]) if is_public and after else 0
            page_rows = rows[offset:offset + self.public_page_size] if is_public else rows[1:] if after else rows[:1]
            more = offset + len(page_rows) < len(rows) if is_public else not after
            data = {"viewer": viewer, "repository": {"id": PUBLIC["id"] if is_public else PRIVATE["id"], "object": {
                "oid": values["head"], "history": {"totalCount": len(rows), "pageInfo": {
                    "hasNextPage": more,
                    "endCursor": (f"public-{offset + len(page_rows)}" if is_public else "history-next") if more else None},
                    "nodes": [{"oid": oid, "authoredDate": authored, "parents": {"totalCount": parents},
                        "authors": {"totalCount": 1, "pageInfo": {"hasNextPage": False},
                                    "nodes": [{"user": {"id": viewer["id"]}}]}} for oid, authored, parents in page_rows]}}}}
        elif "parents(first: 100)" in document:
            oid = values["oid"]
            authored, parents = self.commit_details[oid]
            data = {"viewer": viewer, "repository": {"id": PUBLIC["id"], "object": {
                "oid": oid, "authoredDate": authored,
                "authors": {"totalCount": 1, "pageInfo": {"hasNextPage": False},
                            "nodes": [{"user": {"id": viewer["id"]}}]},
                "parents": {"totalCount": len(parents), "pageInfo": {"hasNextPage": False},
                            "nodes": [{"oid": parent} for parent in parents]}}}}
        else:
            raise AssertionError("Unexpected GraphQL document")
        data["rateLimit"] = {"cost": 1, "remaining": 4999 - len(self.calls),
                             "resetAt": "2026-11-09T13:00:00Z"}
        return json.dumps({"data": data})


def collect(api=None, account=None, at=AT, previous=None):
    configured = copy.deepcopy(account or ACCOUNT)
    return profile.collect({**CONFIG, "githubProfiles": [configured]}, api or Api(),
                           lambda remote, config: "personal", at=at, previous=previous)


class ProfileBeijingTests(unittest.TestCase):
    def test_frozen_current_day_events_share_one_beijing_boundary(self):
        prs = ["2026-11-10T23:49:54Z", "2026-11-10T23:40:48Z", "2026-11-10T19:41:40Z",
               "2026-11-10T17:27:35Z", "2026-11-10T16:54:36Z"]
        commits = [
            ("08:14:19", True), ("07:59:41", True), ("07:56:59", True),
            ("07:47:31", False), ("07:38:22", False), ("05:51:09", True),
            ("05:43:23", True), ("05:42:43", False), ("05:36:29", True),
            ("05:26:06", False), ("05:16:59", True), ("05:16:28", True),
            ("05:13:06", True), ("03:54:37", False), ("03:51:27", False),
            ("03:40:26", False), ("01:22:15", False), ("00:49:03", True),
        ]
        cutoff = profile.instant("2026-11-11T01:32:36Z")
        self.assertEqual(profile.china_day(cutoff), "2026-11-11")
        self.assertEqual(sum(profile.china_day(profile.instant(value)) == "2026-11-11" for value in prs), 5)
        self.assertEqual(sum(value[:10] == "2026-11-11" for value in prs), 0)
        author_times = [profile.instant(f"2026-11-11T{clock}+08:00") for clock, _ in commits]
        self.assertTrue(all(value <= cutoff for value in author_times))
        self.assertEqual(sum(profile.china_day(value) == "2026-11-11" for value in author_times), 18)
        self.assertEqual(sum(ado.china_day(value) == "2026-11-11" for value in author_times), 18)
        self.assertEqual(sum(value.date().isoformat() == "2026-11-11" for value in author_times), 1)
        self.assertEqual(sum(merge for _, merge in commits), 10)

    def test_private_pr_in_first_eight_beijing_hours_is_not_lost(self):
        api = Api()
        api.private_pr_date = "2026-11-10T17:00:00Z"
        events = private._private_prs(profile.Budget(CONFIG, api), ACCOUNT, "fixture-owner", "private-repo",
            PRIVATE, profile.instant(PRIVATE["createdAt"]), profile.instant("2026-11-10T18:00:00Z"),
            dt.date(2026, 11, 11), {"id": "fixture-private-repo"}, profile.instant, profile.digest)
        self.assertEqual([event["day"] for event in events], ["2026-11-11"])

    def test_raw_author_time_not_profile_bucket_sets_commit_day_and_cutoff(self):
        api = Api()
        api.profile_commit_at = "2026-11-09T15:00:00Z"
        source = collect(api)["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(source["days"][-1]["knownCommits"], 1)

        api = Api()
        api.profile_commit_at = "2026-11-10T00:00:00Z"
        source = collect(api)["sources"][0]
        self.assertEqual(source["status"], "unavailable")
        self.assertIsNone(source["days"][-1]["knownCommits"])

        api = Api()
        api.profile_commit_at = "2026-09-10T08:00:00Z"
        source = collect(api, {**ACCOUNT, "privateRepositories": []})["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertEqual(sum(day["knownCommits"] for day in source["days"]), 0)
        self.assertEqual(source["provenance"]["typedProfileTotals"]["commits"], 2)

    def test_profile_pages_private_history_and_reconciliation(self):
        api = Api()
        result = collect(api, {**ACCOUNT, "visibilityProof": proof()})
        source = result["sources"][0]
        self.assertEqual(result["operationWindow"], {"startDay": "2026-09-11",
            "endDay": "2026-11-09", "todayPartial": True})
        self.assertEqual(result["dateBasis"], profile.DATE_BASIS)
        self.assertEqual(source["status"], "ready")
        self.assertEqual(len(source["days"]), 60)
        self.assertEqual(sum(row["prs"] for row in source["days"]), 3)
        self.assertEqual(sum(row["commits"] for row in source["days"]), 4)
        self.assertEqual(source["days"][0]["commits"], 1)
        self.assertEqual(source["provenance"]["supplementedTotals"], {"prs": 1, "commits": 0})
        self.assertEqual(result["collection"]["requestCount"], 10)
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

    def test_partial_pinned_history_survives_head_advance_then_reconciles_older_side_merge(self):
        api = Api()
        api.public_page_size = 1
        side, old_one, old_two = "3" * 40, "1" * 40, "2" * 40
        advanced = "b" * 40
        api.public_history = {HEAD: [(HEAD, "2026-11-09T08:00:00Z", 1),
                                     (old_one, "2026-11-08T08:00:00Z", 1),
                                     (old_two, "2026-11-07T08:00:00Z", 0)]}
        api.commit_details = {advanced: ("2026-11-09T09:00:00Z", [HEAD, side]),
                              side: ("2026-09-15T08:00:00Z", [old_one])}
        config = {**CONFIG, "githubProfiles": [{**ACCOUNT, "privateRepositories": []}]}
        def capture(previous=None):
            return profile.collect(config, api, lambda remote, setting: "personal", at=AT, previous=previous)
        source_id = profile.source_id(profile.profile_config(config["githubProfiles"][0]))
        with patch.object(profile, "HISTORY_PAGES_PER_REPOSITORY", 1):
            first = capture()
            self.assertEqual(first["state"]["sources"][source_id]["progress"][profile.repository_info(PUBLIC, config["githubProfiles"][0], config, lambda r, c: "personal")["id"]]["head"], HEAD)
            api.public_head = advanced
            second = capture(first)
            third = capture(second)
            self.assertEqual(third["state"]["sources"][source_id]["cache"][profile.repository_info(PUBLIC, config["githubProfiles"][0], config, lambda r, c: "personal")["id"]]["head"], HEAD)
            self.assertIn("history-head_drift_after_history", third["sources"][0]["coverage"]["reasons"])
            fourth = capture(third)
            fifth = capture(fourth)
            settled = capture(fifth)
        self.assertTrue(settled["sources"][0]["coverage"]["paginationComplete"])
        self.assertEqual(sum(row["knownCommits"] or 0 for row in settled["sources"][0]["days"]), 5)
        self.assertEqual(sum("history(first:" in arg and "head=" + advanced in call
                             for call in api.calls for arg in call), 0)
        self.assertEqual(sum("parents(first: 100)" in arg for call in api.calls for arg in call), 2)

    def test_diverged_head_invalidates_old_reachability_before_new_full_proof(self):
        api = Api()
        old_one, old_two, rewritten = "1" * 40, "2" * 40, "c" * 40
        api.public_history = {HEAD: [(HEAD, "2026-11-09T08:00:00Z", 1),
                                     (old_one, "2026-11-08T08:00:00Z", 1),
                                     (old_two, "2026-11-07T08:00:00Z", 0)],
                              rewritten: [(rewritten, "2026-11-09T10:00:00Z", 1),
                                          (old_two, "2026-11-07T08:00:00Z", 0)]}
        api.commit_details = {rewritten: ("2026-11-09T10:00:00Z", [old_two])}
        config = {**CONFIG, "githubProfiles": [{**ACCOUNT, "privateRepositories": []}]}
        def capture(previous=None):
            return profile.collect(config, api, lambda remote, setting: "personal", at=AT, previous=previous)
        first = capture()
        api.public_head = rewritten
        partial = capture(first)
        self.assertIn("history-rewritten_history_requires_full_scan", partial["sources"][0]["coverage"]["reasons"])
        self.assertIsNone(partial["sources"][0]["days"][-1]["commits"])
        recovered = capture(partial)
        self.assertEqual(sum(row["knownCommits"] or 0 for row in recovered["sources"][0]["days"]), 2)
        self.assertTrue(recovered["sources"][0]["coverage"]["paginationComplete"])

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

    def test_pr_creation_instant_sets_beijing_day_even_when_profile_day_differs(self):
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
        self.assertEqual(source["days"][-2]["knownPrs"], 0)
        self.assertEqual(source["days"][-1]["knownPrs"], 3)

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
            if "defaultBranchRef" in document and "contributionsCollection" not in document:
                valid_owner = re.search(r"\bowner\s*\{\s*login\s+\.\.\.\s+on\s+User\s*\{\s*id\s*\}\s*\}", document)
                if not valid_owner:
                    return json.dumps({"errors": [{"extensions": {
                        "code": "undefinedField", "typeName": "RepositoryOwner", "fieldName": "id"}}]})
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
        with patch.object(private, "REPOSITORY_QUERY", private.REPOSITORY_QUERY.replace(
                "owner { login ... on User { id } }", "owner { id login }")):
            source = collect(schema_run)["sources"][0]
            self.assertEqual(source["status"], "partial")
            self.assertIn("private_invalid_response", source["coverage"]["reasons"])

    def test_private_profile_date_uses_original_git_timestamp_at_both_boundaries(self):
        cutoff = dt.datetime.fromisoformat("2026-11-09T15:59:59+00:00")
        cases = (
            ("2026-09-11T00:30:00+08:00", "2026-11-09T11:00:00Z", 1, 1),
            ("2026-09-10T23:30:00-08:00", "2026-11-09T11:00:00Z", 1, 1),
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
        api.private_pr_date = "2026-09-10T23:30:00+08:00"
        source = collect(api)["sources"][0]
        self.assertEqual(source["days"][0]["knownPrs"], 0)
        self.assertEqual(source["days"][-1]["knownPrs"], 2)

    def test_readable_nonowner_candidate_has_no_known_supplement(self):
        for owner_id, owner_login, candidate in (
                ("other-stable-id", "fixture-owner", "fixture-owner/private-repo"),
                ("other-stable-id", "other-owner", "other-owner/private-repo")):
            with self.subTest(candidate=candidate, owner_id=owner_id):
                api = Api()
                api.repo_name = candidate
                api.owner_id = owner_id
                api.owner_login = owner_login
                source = collect(api, {**ACCOUNT, "privateRepositories": [candidate]})["sources"][0]
                self.assertEqual(source["status"], "partial")
                self.assertIn("private_private_owner_unverified", source["coverage"]["reasons"])
                self.assertEqual(source["days"][-1]["knownPrs"], 2)
                self.assertEqual(source["days"][-1]["knownCommits"], 2)
                self.assertEqual(source["provenance"]["supplementedTotals"], {"prs": 0, "commits": 0})
                self.assertFalse(any("history(first:" in arg for call in api.calls if "name=private-repo" in call for arg in call))

    def test_subprocess_candidate_failure_retains_typed_and_continues(self):
        api = Api()
        api.fail_private_owner = "failure-owner"
        api.fail_private_error = subprocess.CalledProcessError(1, ["synthetic-gh"])
        candidates = ["failure-owner/private-repo", "fixture-owner/private-repo"]
        source = collect(api, {**ACCOUNT, "privateRepositories": candidates})["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertIn("private_CalledProcessError", source["coverage"]["reasons"])
        self.assertEqual(source["days"][-1]["knownPrs"], 3)
        self.assertEqual(source["days"][-1]["knownCommits"], 3)
        self.assertEqual(source["provenance"]["supplementedTotals"], {"prs": 1, "commits": 0})
        self.assertFalse(source["coverage"]["paginationComplete"])

    def test_history_timeout_retains_prs_without_inventing_commit_zero(self):
        api = Api()
        api.fail_private_owner = "fixture-owner"
        api.fail_private_phase = "history(first:"
        api.fail_private_error = subprocess.TimeoutExpired(["synthetic-gh"], 5)
        source = collect(api)["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertIn("history-TimeoutExpired", source["coverage"]["reasons"])
        self.assertEqual(source["days"][-1]["knownPrs"], 3)
        self.assertIsNone(source["days"][-1]["knownCommits"])
        self.assertEqual(source["provenance"]["supplementedTotals"], {"prs": 1, "commits": 0})

    def test_private_query_identity_mismatch_remains_hard_rejection(self):
        api = Api()
        api.private_viewer_id = "different-account-id"
        source = collect(api)["sources"][0]
        self.assertEqual(source["status"], "unavailable")
        self.assertTrue(all(day["knownPrs"] is None for day in source["days"]))

    def test_history_delta_and_final_head_identity_mismatch_reject_account(self):
        account = {**ACCOUNT, "privateRepositories": []}
        for phase in ("history", "delta", "final-head"):
            with self.subTest(phase=phase):
                api = Api()
                previous = collect(api, account) if phase == "delta" else None
                if phase == "delta":
                    advanced = "b" * 40
                    api.public_head = advanced
                    api.commit_details[advanced] = ("2026-11-09T10:00:00Z", [HEAD])

                def mismatched(args, timeout):
                    result = json.loads(api(args, timeout))
                    document = next(value[6:] for value in args if value.startswith("query="))
                    target = (phase == "history" and "history(first:" in document
                              or phase == "delta" and "parents(first: 100)" in document
                              or phase == "final-head" and "defaultBranchRef" in document
                                  and "contributionsCollection" not in document)
                    if target:
                        result["data"]["viewer"]["id"] = "different-account-id"
                    return json.dumps(result)

                source = collect(mismatched, account, previous=previous)["sources"][0]
                self.assertEqual(source["status"], "unavailable")
                self.assertFalse(source["coverage"]["identityVerified"])
                self.assertNotIn("provenance", source)
                self.assertTrue(all(day["knownPrs"] is None and day["knownCommits"] is None
                                    for day in source["days"]))

    def test_failed_private_discovery_without_public_history_keeps_commit_zero_unknown(self):
        api = Api()
        api.fail_private_owner = "fixture-owner"
        api.fail_private_phase = "defaultBranchRef"
        api.fail_private_error = OSError("synthetic private discovery failure")

        def empty_public(args, timeout):
            result = json.loads(api(args, timeout))
            document = next(value[6:] for value in args if value.startswith("query="))
            if "contributionsCollection" in document:
                collection = result["data"]["viewer"]["contributionsCollection"]
                collection.update({"totalCommitContributions": 0, "totalRepositoriesWithContributedCommits": 0,
                                   "commitContributionsByRepository": [], "totalPullRequestContributions": 0,
                                   "pullRequestContributions": {"totalCount": 0, "nodes": [],
                                                                "pageInfo": {"hasNextPage": False, "endCursor": None}}})
            return json.dumps(result)

        source = collect(empty_public)["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertTrue(source["coverage"]["identityVerified"])
        self.assertFalse(source["coverage"]["paginationComplete"])
        self.assertIn("private_OSError", source["coverage"]["reasons"])
        self.assertEqual(source["provenance"]["historyRepositories"], 0)
        self.assertTrue(all(day["knownCommits"] is None for day in source["days"]))


if __name__ == "__main__":
    unittest.main()
