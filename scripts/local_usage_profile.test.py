import copy
import datetime as dt
import json
import re
import subprocess
import unittest
import urllib.parse
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
        self.public_created_at = PUBLIC["createdAt"]
        self.public_history = None
        self.public_page_size = 100
        self.commit_details = {}
        self.enforce_query_window = False
        self.duplicate_compare_page = False
        self.profile_pr_rows = None

    def __call__(self, args, timeout):
        self.calls.append(args)
        assert 0 < timeout <= 30
        if self.fail:
            raise OSError("synthetic expired credential")
        if "/compare/" in args[-1]:
            path = urllib.parse.urlsplit(args[-1])
            refs = path.path.split("/compare/")[1]
            base, head = refs.split("...")
            base_known = {oid for oid, _, _ in self.public_history.get(base, [])} if self.public_history else {base, "1" * 40, "2" * 40}
            frontier, changed, reached = [head], {}, False
            while frontier:
                oid = frontier.pop()
                if oid == base:
                    reached = True
                    continue
                if oid in changed or oid in base_known:
                    continue
                if oid not in self.commit_details:
                    continue
                authored, parents = self.commit_details[oid]
                changed[oid] = parents
                frontier.extend(parents)
            page = int(urllib.parse.parse_qs(path.query)["page"][0])
            rows = list(changed.items())[(page - 1) * 100:page * 100]
            if self.duplicate_compare_page and page == 2 and rows:
                rows[0] = list(changed.items())[0]
            return json.dumps({"status": "ahead" if reached else "diverged",
                "merge_base_commit": {"sha": base if reached else "0" * 40},
                "base_commit": {"sha": base}, "total_commits": len(changed),
                "commits": [{"sha": oid, "parents": [{"sha": parent} for parent in parents]}
                            for oid, parents in rows]})
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
            records = (self.profile_pr_rows if self.profile_pr_rows is not None else
                       [(f"public-pr-{i}", f"2026-11-09T09:0{i}:00Z", PUBLIC) for i in (1, 2)])
            nodes = [{"occurredAt": when, "pullRequest": {
                "id": key, "createdAt": when,
                "author": {"id": viewer["id"], "login": viewer["login"]}, "repository": repo}}
                for key, when, repo in records]
            if self.enforce_query_window:
                nodes = [node for node in nodes if values["from"] <= node["occurredAt"] <= values["to"]]
            after = values.get("after")
            page_nodes = nodes[1:] if after else nodes[:1]
            more = len(nodes) > 1 and not after and not self.truncate_prs
            groups = [{"repository": {**PUBLIC,
                "createdAt": self.public_created_at,
                "defaultBranchRef": {"name": "main", "target": {"oid": self.public_head}}}, "contributions": {
                "totalCount": 2, "pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [{"occurredAt": self.profile_commit_at, "commitCount": 2}]}}]
            if self.enforce_query_window and not values["from"] <= self.profile_commit_at <= values["to"]:
                groups = []
            viewer["contributionsCollection"] = {
                "startedAt": values["from"], "endedAt": values["to"],
                "hasAnyRestrictedContributions": False, "restrictedContributionsCount": 0,
                "totalCommitContributions": 2 if groups else 0,
                "totalRepositoriesWithContributedCommits": len(groups),
                "totalPullRequestContributions": len(nodes),
                "commitContributionsByRepository": groups,
                "pullRequestContributions": {"totalCount": len(nodes), "nodes": page_nodes,
                    "pageInfo": {"hasNextPage": more, "endCursor": "profile-next" if more else None}}}
            data = {"viewer": viewer}
        elif "defaultBranchRef" in document:
            self.metadata_reads += 1
            head = "c" * 40 if self.changed_head and self.metadata_reads > 1 else (
                self.public_head if values.get("name") == "public-repo" else HEAD)
            raw = PUBLIC if values.get("name") == "public-repo" else PRIVATE
            data = {"viewer": viewer, "repository": {**raw, "nameWithOwner": self.repo_name if raw is PRIVATE else PUBLIC["nameWithOwner"],
                "owner": {"id": self.owner_id, "login": self.owner_login},
                "createdAt": self.public_created_at if raw is PUBLIC else PRIVATE["createdAt"],
                "defaultBranchRef": {"name": "main", "target": {"oid": head}}}}
        elif "search(query:" in document:
            query = values["q"]
            start, end = query.split("created:", 1)[1].split("..", 1)
            matches = start <= self.private_pr_date <= end
            nodes = ([{"id": "private-pr-1", "createdAt": self.private_pr_date,
                       "author": {"id": viewer["id"], "login": viewer["login"]},
                       "repository": {"id": PRIVATE["id"]}}] if matches else [])
            data = {"viewer": viewer, "search": {"issueCount": len(nodes), "nodes": nodes,
                    "pageInfo": {"hasNextPage": False, "endCursor": None}}}
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
        elif "c0: object" in document:
            objects = {}
            for key, oid in values.items():
                if not key.startswith("oid"):
                    continue
                authored, parents = self.commit_details[oid]
                objects["c" + key[3:]] = {"oid": oid, "authoredDate": authored,
                    "authors": {"totalCount": 1, "pageInfo": {"hasNextPage": False},
                                "nodes": [{"user": {"id": viewer["id"]}}]},
                    "parents": {"totalCount": len(parents)}}
            data = {"viewer": viewer, "repository": {"id": PUBLIC["id"], **objects}}
        else:
            raise AssertionError("Unexpected GraphQL document")
        data["rateLimit"] = {"cost": 1, "remaining": 4999 - len(self.calls),
                             "resetAt": "2026-11-09T13:00:00Z"}
        return json.dumps({"data": data})


def collect(api=None, account=None, at=AT, previous=None, focus_start=None):
    configured = copy.deepcopy(account or ACCOUNT)
    return profile.collect({**CONFIG, "githubProfiles": [configured]}, api or Api(),
                           lambda remote, config: "personal", at=at, previous=previous,
                           focus_start=focus_start)


class ProfileBeijingTests(unittest.TestCase):
    def assert_same_days_except_capture_time(self, first, second):
        for days in (first, second):
            captured = {day["capturedAt"] for day in days}
            self.assertEqual(len(captured), 1)
            self.assertIsNotNone(profile.instant(captured.pop()).tzinfo)
        self.assertEqual(
            [{key: value for key, value in day.items() if key != "capturedAt"} for day in first],
            [{key: value for key, value in day.items() if key != "capturedAt"} for day in second])

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
        self.assert_same_days_except_capture_time(first["sources"][0]["days"], second["sources"][0]["days"])
        self.assertEqual(first["activeSourceIds"], second["activeSourceIds"])

    def test_warm_focus_queries_only_the_requested_beijing_day_and_keeps_old_events(self):
        api = Api()
        api.enforce_query_window = True
        account = {**ACCOUNT, "privateRepositories": []}
        previous = collect(api, account)
        api.calls.clear()
        at = dt.datetime.fromisoformat("2026-11-10T12:00:00+00:00")
        current = collect(api, account, at=at, previous=previous, focus_start="2026-11-10")
        profile_calls = [call for call in api.calls if any("contributionsCollection" in arg for arg in call)]
        self.assertEqual(len(profile_calls), 1)
        self.assertIn("from=2026-11-09T16:00:00Z", profile_calls[0])
        self.assertIn("to=2026-11-10T12:00:00Z", profile_calls[0])
        self.assertEqual(next(row for row in current["sources"][0]["days"]
                              if row["day"] == "2026-11-09")["knownPrs"], 2)
        self.assertTrue(current["sources"][0]["coverage"]["paginationComplete"])
        self.assertFalse(any("history(first:" in arg for call in api.calls for arg in call))

    def test_private_pr_discovery_uses_the_same_focus_and_retains_older_known_pr(self):
        api = Api()
        api.enforce_query_window = True
        previous = collect(api)
        api.calls.clear()
        at = dt.datetime.fromisoformat("2026-11-10T12:00:00+00:00")
        current = collect(api, at=at, previous=previous, focus_start="2026-11-10")
        queries = [item.split("=", 1)[1] for call in api.calls for item in call
                   if item.startswith("q=repo:")]
        self.assertEqual(len(queries), 1)
        self.assertIn("created:2026-11-09T16:00:00Z..2026-11-10T12:00:00Z", queries[0])
        prior_day = next(row for row in current["sources"][0]["days"] if row["day"] == "2026-11-09")
        self.assertEqual(prior_day["knownPrs"], 3)
        self.assertTrue(current["sources"][0]["coverage"]["paginationComplete"])

    def test_new_typed_private_pr_does_not_remove_older_supplemented_pr(self):
        api = Api()
        previous = collect(api)
        api.enforce_query_window = True
        api.profile_pr_rows = [(f"new-private-pr-{index}", f"2026-11-10T09:0{index}:00Z", PRIVATE)
                               for index in (1, 2)]
        at = dt.datetime.fromisoformat("2026-11-10T12:00:00+00:00")
        current = collect(api, at=at, previous=previous, focus_start="2026-11-10")
        days = {row["day"]: row for row in current["sources"][0]["days"]}
        self.assertEqual(days["2026-11-09"]["knownPrs"], 3)
        self.assertEqual(days["2026-11-10"]["knownPrs"], 2)
        self.assertTrue(current["sources"][0]["coverage"]["paginationComplete"])

    def test_compare_batches_more_than_one_page_without_losing_author_day(self):
        api = Api()
        account = {**ACCOUNT, "privateRepositories": []}
        previous = collect(api, account)
        previous_id = previous["state"]["sources"][profile.source_id(profile.profile_config(account))]
        self.assertTrue(previous_id["cache"])
        chain = [f"{index:040x}" for index in range(1000, 1151)]
        for index, oid in enumerate(chain):
            parent = HEAD if index == 0 else chain[index - 1]
            api.commit_details[oid] = ("2026-11-08T15:59:59Z" if index == 0 else
                                       "2026-11-09T10:00:00Z", [parent])
        api.public_head = chain[-1]
        result = collect(api, account, previous=previous)
        rows = {row["day"]: row for row in result["sources"][0]["days"]}
        self.assertTrue(result["sources"][0]["coverage"]["paginationComplete"])
        self.assertEqual(rows["2026-11-08"]["knownCommits"], 1)
        self.assertEqual(sum(row["knownCommits"] or 0 for row in rows.values()), 153)
        self.assertEqual(sum("/compare/" in call[-1] for call in api.calls), 2)
        self.assertLessEqual(sum("c0: object" in arg for call in api.calls for arg in call), 8)
        api.duplicate_compare_page = True
        api.public_head = f"{2000:040x}"
        api.commit_details[api.public_head] = ("2026-11-09T11:00:00Z", [chain[-1]])
        duplicate = collect(api, account, previous=previous)
        self.assertFalse(duplicate["sources"][0]["coverage"]["paginationComplete"])

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
        self.assertEqual(sum("c0: object" in arg for call in api.calls for arg in call), 1)

    def test_precreation_history_page_keeps_newer_events_and_progress_through_head_advance(self):
        api = Api()
        api.public_created_at = "2026-10-01T00:00:00Z"
        api.public_page_size = 1
        imported, newer, advanced = "1" * 40, "2" * 40, "b" * 40
        api.public_history = {HEAD: [(HEAD, "2026-11-09T08:00:00Z", 1),
                                     (imported, "2026-09-15T08:00:00Z", 1),
                                     (newer, "2026-11-08T08:00:00Z", 0)]}
        api.commit_details = {advanced: ("2026-11-09T09:00:00Z", [HEAD])}
        account = {**ACCOUNT, "privateRepositories": []}
        repo_id = profile.repository_info(PUBLIC, account, CONFIG, lambda remote, config: "personal")["id"]
        source_id = profile.source_id(profile.profile_config(account))

        def capture(previous=None):
            return collect(api, account, previous=previous)

        with patch.object(profile, "HISTORY_PAGES_PER_REPOSITORY", 1):
            first = capture()
            self.assertEqual(first["state"]["sources"][source_id]["progress"][repo_id]["pages"], 1)
            api.public_head = advanced
            second = capture(first)
            partial = second["state"]["sources"][source_id]["progress"][repo_id]
            self.assertEqual(partial["pages"], 2)
            self.assertEqual(partial["eligibilityUncertainDays"], [])
            self.assertEqual([item["oid"] for item in partial["items"]], [HEAD, imported])
            third = capture(second)
            self.assertEqual(third["state"]["sources"][source_id]["cache"][repo_id]["head"], HEAD)
            fourth = capture(third)
            settled = capture(fourth)
            history_calls = sum("history(first:" in arg for call in api.calls for arg in call)
            repeated = capture(settled)

        source = settled["sources"][0]
        self.assertEqual(source["status"], "partial")
        self.assertTrue(source["coverage"]["paginationComplete"])
        self.assertEqual(source["coverage"]["eligibilityUncertainDays"], [])
        self.assertNotIn("eligibilityUncertainDaysByCategory", source["coverage"])
        self.assertEqual(sum(day["knownCommits"] or 0 for day in source["days"]), 4)
        self.assertEqual(next(day for day in source["days"] if day["day"] == "2026-09-15")["knownCommits"], 1)
        self.assertTrue(all(day["commits"] is None for day in source["days"]))
        proof = settled["state"]["sources"][source_id]["cache"][repo_id]
        self.assertEqual(proof["head"], advanced)
        self.assertEqual(proof["eligibilityUncertainDays"], [])
        self.assertIn(imported, proof["checked"])
        self.assertIn(imported, [item["oid"] for item in proof["items"]])
        self.assert_same_days_except_capture_time(repeated["sources"][0]["days"], source["days"])
        self.assertEqual(sum("history(first:" in arg for call in api.calls for arg in call), history_calls)

    def test_legacy_uncertain_cache_repairs_only_affected_history_with_persisted_progress(self):
        api = Api()
        api.public_created_at = "2026-10-01T00:00:00Z"
        imported = "9" * 40
        api.public_history = {HEAD: [(HEAD, "2026-11-09T08:00:00Z", 1),
                                     (imported, "2026-09-15T08:00:00Z", 1),
                                     ("2" * 40, "2026-11-08T08:00:00Z", 0)]}
        source_id = profile.source_id(profile.profile_config(ACCOUNT))
        repo_id = profile.repository_info(PUBLIC, ACCOUNT, CONFIG, lambda remote, setting: "personal")["id"]
        previous = collect(api)
        state = previous["state"]["sources"][source_id]
        old_proof = state["cache"][repo_id]
        old_proof["items"] = [item for item in old_proof["items"] if item["oid"] != imported]
        old_proof["eligibilityUncertainDays"] = ["2026-09-15"]
        other_id = next(key for key in state["cache"] if key != repo_id)
        other_proof = copy.deepcopy(state["cache"][other_id])
        api.public_page_size = 1
        with patch.object(profile, "HISTORY_PAGES_PER_REPOSITORY", 1):
            first = collect(api, previous=previous)
            first_state = first["state"]["sources"][source_id]
            self.assertEqual(first_state["progress"][repo_id]["pages"], 1)
            self.assertTrue(first_state["progress"][repo_id]["eligibilityRepair"])
            self.assertEqual(first_state["cache"][repo_id], old_proof)
            self.assertEqual(first["sources"][0]["coverage"]["eligibilityUncertainDays"], ["2026-09-15"])
            self.assertFalse(first["sources"][0]["coverage"]["paginationComplete"])
            second = collect(api, previous=first)
            self.assertEqual(second["state"]["sources"][source_id]["progress"][repo_id]["pages"], 2)
            self.assertEqual(second["sources"][0]["coverage"]["eligibilityUncertainDays"], ["2026-09-15"])
            settled = collect(api, previous=second)
            history_calls = sum("history(first:" in arg for call in api.calls for arg in call)
            repeated = collect(api, previous=settled)
        source = settled["sources"][0]
        repaired = settled["state"]["sources"][source_id]
        self.assertNotIn(repo_id, repaired["progress"])
        self.assertEqual(repaired["cache"][other_id], other_proof)
        self.assertEqual(repaired["cache"][repo_id]["eligibilityUncertainDays"], [])
        self.assertIn(imported, [item["oid"] for item in repaired["cache"][repo_id]["items"]])
        self.assertEqual(source["coverage"]["eligibilityUncertainDays"], [])
        self.assertTrue(source["coverage"]["paginationComplete"])
        self.assertFalse(source["coverage"]["visibilityComplete"])
        self.assertEqual(next(day for day in source["days"] if day["day"] == "2026-09-15")["knownCommits"], 1)
        self.assertEqual(sum("history(first:" in arg for call in api.calls for arg in call), history_calls)
        self.assert_same_days_except_capture_time(repeated["sources"][0]["days"], source["days"])
        legacy_progress = copy.deepcopy(first)
        old_state = legacy_progress["state"]["sources"][source_id]
        old_state["cache"].pop(repo_id)
        old_state["progress"][repo_id].pop("eligibilityRepair")
        old_state["progress"][repo_id]["pages"] = 2
        with patch.object(profile, "HISTORY_PAGES_PER_REPOSITORY", 1):
            restarted = collect(api, previous=legacy_progress)
        renewed = restarted["state"]["sources"][source_id]["progress"][repo_id]
        self.assertTrue(renewed["eligibilityRepair"])
        self.assertEqual(renewed["pages"], 1)
        self.assertEqual(restarted["sources"][0]["coverage"]["eligibilityUncertainDays"], ["2026-09-15"])

    def test_precreation_day_keeps_unaffected_category_zero(self):
        day = "2026-09-15"
        typed = {"prs": [{"day": day, "repository": {"id": category, "name": category,
                    "category": category}} for category in ("work", "personal")], "commits": []}
        rows = profile.measured_days(dt.date.fromisoformat("2026-09-11"), AT, typed,
                                     {"prs": [], "commits": []}, False, "2026-11-09T12:00:00Z",
                                     True, True, {day}, {"work": set(), "personal": {day}, "unclassified": set()})
        affected = next(row for row in rows if row["day"] == day)
        self.assertIsNone(affected["knownCommits"])
        self.assertEqual({row["category"]: row["knownCommits"] for row in affected["repositories"]},
                         {"work": 0, "personal": None})

    def test_precreation_delta_commit_does_not_hide_later_newer_parent(self):
        api = Api()
        api.public_created_at = "2026-10-01T00:00:00Z"
        base_commit, imported, newer, advanced = "1" * 40, "2" * 40, "3" * 40, "b" * 40
        api.public_history = {HEAD: [(HEAD, "2026-11-09T08:00:00Z", 1),
                                     (base_commit, "2026-11-07T08:00:00Z", 0)]}
        api.commit_details = {advanced: ("2026-11-09T09:00:00Z", [imported]),
                              imported: ("2026-09-15T08:00:00Z", [newer]),
                              newer: ("2026-11-08T08:00:00Z", [HEAD])}
        account = {**ACCOUNT, "privateRepositories": []}
        repo_id = profile.repository_info(PUBLIC, account, CONFIG, lambda remote, config: "personal")["id"]
        source_id = profile.source_id(profile.profile_config(account))

        with patch.object(profile, "HISTORY_PAGES_PER_REPOSITORY", 1):
            base = collect(api, account)
            api.public_head = advanced
            current = base
            for _ in range(4):
                current = collect(api, account, previous=current)

        source = current["sources"][0]
        proof = current["state"]["sources"][source_id]["cache"][repo_id]
        self.assertEqual(proof["head"], advanced)
        self.assertEqual(proof["eligibilityUncertainDays"], [])
        self.assertEqual(sum(day["knownCommits"] or 0 for day in source["days"]), 5)
        self.assertIn(imported, proof["checked"])
        self.assertIn(imported, [item["oid"] for item in proof["items"]])
        self.assertIn(newer, [item["oid"] for item in proof["items"]])
        self.assertTrue(source["coverage"]["paginationComplete"])
        self.assertEqual(next(day for day in source["days"] if day["day"] == "2026-09-15")["knownCommits"], 1)

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
                    document = next((value[6:] for value in args if value.startswith("query=")), "")
                    target = (phase == "history" and "history(first:" in document
                              or phase == "delta" and "c0: object" in document
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
