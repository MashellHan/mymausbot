import copy
import datetime as dt
import json
import unittest
import urllib.parse
from unittest.mock import patch

import local_usage_ado as ado


AT = dt.datetime.fromisoformat("2026-11-10T00:30:00+00:00")
OWNER = "11111111-2222-3333-4444-555555555555"
REPO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
HEAD = "a" * 40
OLDER = "b" * 40
OTHER = "c" * 40
EMAIL = "owner@example.test"
CONFIG = {"azureCli": "/fixture/az", "authorEmails": ["personal@example.test", "machine@example.test"],
          "adoAuthorEmails": [EMAIL, "alias@example.test"],
          "adoPrincipals": {"example": {"stableId": OWNER, "alias": EMAIL}},
          "mergedAdoProjects": ["https://dev.azure.com/example/project"],
          "adoRemotes": ["https://dev.azure.com/EXAMPLE/Project/_git/repository"]}


def commit(oid, day, email=EMAIL, *, parents=1, comment=""):
    return {"commitId": oid, "author": {"date": day, "email": email},
            "committer": {"date": day, "email": email}, "parents": ["f" * 40] * parents,
            "comment": comment, "commentTruncated": False}


def pr(number, day, status="active"):
    return {"pullRequestId": number, "creationDate": day, "status": status,
            "createdBy": {"id": OWNER, "uniqueName": EMAIL},
            "repository": {"id": REPO}}


class Api:
    def __init__(self):
        self.calls = []
        self.owner = OWNER
        self.repos = [{"id": REPO, "name": "repository", "defaultBranch": "refs/heads/main",
                       "isDisabled": False}]
        self.heads = {REPO: HEAD}
        self.prs = [pr(3, "2026-11-10T00:01:00Z", "abandoned"),
                    pr(2, "2026-11-09T23:59:00Z", "completed"),
                    pr(1, "2026-11-09T12:00:00Z")]
        self.histories = {HEAD: [
            commit(HEAD, "2026-11-09T12:00:00Z", parents=2),
            commit(OLDER, "2026-11-09T23:59:00Z", "other@example.test", comment="Co-authored-by: Owner <alias@example.test>"),
            commit("9" * 40, "2026-11-09T13:00:00Z", "personal@example.test"),
            commit(OTHER, "2026-11-10T00:01:00Z", "other@example.test")],
            }
        self.details = {row["commitId"]: row for rows in self.histories.values() for row in rows}

    def __call__(self, args, timeout):
        self.calls.append(args)
        assert 0 < timeout <= 20
        assert args[:5] == ["/fixture/az", "rest", "--method", "get", "--url"]
        assert args[6:] == ["--resource", ado.RESOURCE, "-o", "json"]
        target = urllib.parse.urlsplit(args[5])
        assert target.scheme == "https" and target.hostname == "dev.azure.com"
        query = urllib.parse.parse_qs(target.query)
        path = target.path
        if path.endswith("/_apis/connectionData"):
            result = {"authenticatedUser": {"id": self.owner,
                "properties": {"Account": {"$value": EMAIL}}}}
        elif path.endswith("/_apis/git/repositories"):
            result = {"value": self.repos, "count": len(self.repos)}
        elif path.endswith("/_apis/git/pullrequests"):
            assert query["searchCriteria.status"] == ["all"]
            assert query["searchCriteria.creatorId"] == [OWNER]
            start = int(query["$skip"][0])
            page = self.prs[start:start + int(query["$top"][0])]
            result = {"value": page, "count": len(page)}
        elif path.endswith("/refs"):
            assert query["filter"] == ["heads/main"]
            repo = path.split("/")[-2]
            result = {"value": [{"name": "refs/heads/main", "objectId": self.heads[repo]}], "count": 1}
        elif path.endswith("/commits"):
            head = query["searchCriteria.itemVersion.version"][0]
            assert query["searchCriteria.itemVersion.versionType"] == ["commit"]
            start = int(query["$skip"][0])
            page = self.histories[head][start:start + int(query["$top"][0])]
            result = {"value": page, "count": len(page)}
        elif "/commits/" in path:
            result = self.details[path.split("/")[-1]]
        else:
            raise AssertionError(path)
        return json.dumps(result)


def collect(api, *, previous=None, at=AT, config=CONFIG):
    return ado.collect(config, api, lambda remote, cfg: "work", at=at, previous=previous)


class AdoTests(unittest.TestCase):
    def test_all_pr_states_utc_author_dates_merge_coauthor_and_one_repository(self):
        api = Api()
        result = collect(api)
        source = result["sources"][0]
        self.assertEqual(result["operationWindow"], {"startDay": "2026-09-12", "endDay": "2026-11-10", "todayPartial": True})
        self.assertEqual(len(result["activeSourceIds"]), 1)
        self.assertEqual(source["status"], "ready")
        self.assertEqual(source["coverage"], {"identityVerified": True, "paginationComplete": True,
                                                "visibilityComplete": True, "reasons": []})
        nov9, nov10 = source["days"][-2:]
        self.assertEqual((nov9["prs"], nov9["commits"], nov10["prs"], nov10["commits"]), (2, 2, 1, 0))
        self.assertEqual((nov9["knownPrs"], nov9["knownCommits"]), (2, 2))
        self.assertEqual((nov9["repositories"][0]["prs"], nov9["repositories"][0]["commits"]), (2, 2))
        self.assertEqual(sum(row["prs"] for row in source["days"]), 3)
        self.assertEqual(sum(row["commits"] for row in source["days"]), 2)
        self.assertIn("personal@example.test", CONFIG["authorEmails"])
        self.assertNotIn("personal@example.test", CONFIG["adoAuthorEmails"])
        self.assertEqual(result["collection"]["complete"], True)
        self.assertTrue(all("/" not in part for part in result["activeSourceIds"]))

    def test_request_budget_resumes_without_inventing_zero_or_reloading_completed_commit_details(self):
        api = Api()
        previous = None
        with patch.object(ado, "REQUESTS_PER_PROJECT", 3):
            for attempt in range(10):
                result = collect(api, previous=previous)
                if attempt == 0:
                    self.assertEqual(result["sources"][0]["status"], "partial")
                    self.assertIsNone(result["sources"][0]["days"][-1]["prs"])
                    self.assertIsNone(result["sources"][0]["days"][-1]["commits"])
                    self.assertIn("request-budget", result["collection"]["reasons"])
                previous = result
                if result["sources"][0]["status"] == "ready":
                    break
        self.assertEqual(result["sources"][0]["status"], "ready")
        self.assertEqual(result["sources"][0]["days"][-2]["commits"], 2)
        details = [args[5] for args in api.calls if "/commits/" in args[5]]
        self.assertEqual(len(details), 4)

    def test_unchanged_head_reuses_pinned_history_and_changed_head_scans_all_reachable_commits(self):
        api = Api()
        first = collect(api)
        api.calls.clear()
        same = collect(api, previous=first, at=AT + dt.timedelta(minutes=5))
        self.assertEqual(same["sources"][0]["days"][-2]["commits"], 2)
        self.assertFalse(any("/commits?" in args[5] for args in api.calls))
        newer = "d" * 40
        api.heads[REPO] = newer
        api.histories[newer] = [commit(newer, "2026-11-09T10:00:00Z"), *api.histories[HEAD]]
        api.details[newer] = api.histories[newer][0]
        changed = collect(api, previous=same, at=AT + dt.timedelta(minutes=10))
        self.assertEqual(changed["sources"][0]["days"][-2]["commits"], 3)
        self.assertEqual(changed["state"]["projects"]["example/project"]["cache"][REPO]["head"], newer)
        self.assertEqual(first["sources"][0]["id"], changed["sources"][0]["id"])

    def test_late_side_merge_after_old_head_reconciles_older_author_day(self):
        api = Api()
        initial = collect(api)
        merge = "d" * 40
        topic = "e" * 40
        api.heads[REPO] = merge
        api.histories[merge] = [
            commit(merge, "2026-11-10T00:02:00Z", parents=2),
            api.histories[HEAD][0],
            commit(topic, "2026-11-09T08:00:00Z"),
            *api.histories[HEAD][1:]]
        api.details[merge] = api.histories[merge][0]
        api.details[topic] = api.histories[merge][2]
        with patch.object(ado, "REQUESTS_PER_PROJECT", 5):
            partial = collect(api, previous=initial, at=AT + dt.timedelta(minutes=5))
        self.assertFalse(partial["collection"]["complete"])
        self.assertFalse(partial["sources"][0]["coverage"]["paginationComplete"])
        self.assertEqual(partial["sources"][0]["days"][-2]["status"], "stale")
        result = partial
        for _ in range(10):
            if result["sources"][0]["status"] == "ready":
                break
            result = collect(api, previous=result, at=AT + dt.timedelta(minutes=5))
        self.assertEqual(result["sources"][0]["status"], "ready")
        self.assertEqual(result["sources"][0]["days"][-2]["commits"], 3)
        self.assertEqual(result["sources"][0]["days"][-1]["commits"], 1)
        self.assertEqual(initial["sources"][0]["days"][-2]["commits"], 2)

    def test_force_push_drops_incompatible_old_head_and_older_author_date_is_retained(self):
        api = Api()
        first = collect(api)
        replacement = "e" * 40
        api.heads[REPO] = replacement
        api.histories[replacement] = [commit(replacement, "2026-09-12T00:00:00Z")]
        api.details[replacement] = api.histories[replacement][0]
        changed = collect(api, previous=first, at=AT + dt.timedelta(minutes=5))
        self.assertEqual(sum(day["commits"] for day in changed["sources"][0]["days"]), 1)
        self.assertEqual(changed["sources"][0]["days"][0]["commits"], 1)

    def test_head_change_during_incomplete_scan_discards_incompatible_progress(self):
        api = Api()
        initial = collect(api)
        intermediate, replacement = "d" * 40, "e" * 40
        api.heads[REPO] = intermediate
        api.histories[intermediate] = [commit(intermediate, "2026-11-09T01:00:00Z"), *api.histories[HEAD]]
        api.details[intermediate] = api.histories[intermediate][0]
        with patch.object(ado, "REQUESTS_PER_PROJECT", 6):
            partial = collect(api, previous=initial, at=AT + dt.timedelta(minutes=5))
        progress = partial["state"]["projects"]["example/project"]["work"]["progress"]
        self.assertEqual(progress["head"], intermediate)
        self.assertTrue(progress["pending"])
        api.heads[REPO] = replacement
        api.histories[replacement] = [commit(replacement, "2026-11-09T02:00:00Z")]
        api.details[replacement] = api.histories[replacement][0]
        result = collect(api, previous=partial, at=AT + dt.timedelta(minutes=10))
        self.assertEqual(result["sources"][0]["status"], "ready")
        self.assertEqual(result["sources"][0]["days"][-2]["commits"], 1)
        self.assertEqual(result["state"]["projects"]["example/project"]["cache"][REPO]["head"], replacement)

    def test_identity_mismatch_disabled_and_missing_head_keep_coverage_explicit(self):
        api = Api()
        api.owner = "99999999-2222-3333-4444-555555555555"
        mismatch = collect(api)
        self.assertEqual(mismatch["sources"][0]["status"], "unavailable")
        self.assertFalse(mismatch["sources"][0]["coverage"]["identityVerified"])
        self.assertIsNone(mismatch["sources"][0]["days"][-1]["prs"])
        api.owner = OWNER
        api.repos[0]["isDisabled"] = True
        disabled = collect(api)
        self.assertEqual(disabled["sources"][0]["status"], "partial")
        self.assertIn("disabled-repository", disabled["sources"][0]["coverage"]["reasons"])
        self.assertEqual(disabled["sources"][0]["days"][-2]["prs"], 2)
        self.assertIsNone(disabled["sources"][0]["days"][-2]["commits"])
        api.repos[0]["isDisabled"] = False
        api.heads[REPO] = "bad"
        missing = collect(api)
        self.assertIn("unavailable-default-head", missing["sources"][0]["coverage"]["reasons"])
        self.assertIsNone(missing["sources"][0]["days"][-2]["commits"])

    def test_incomplete_refresh_retains_old_rows_only_as_stale_with_original_capture(self):
        api = Api()
        complete = collect(api)
        old_capture = complete["sources"][0]["days"][-2]["capturedAt"]
        with patch.object(ado, "REQUESTS_PER_PROJECT", 2):
            later = collect(api, previous=complete, at=AT + dt.timedelta(minutes=5))
        source = later["sources"][0]
        self.assertEqual(source["status"], "stale")
        self.assertEqual(source["days"][-2]["status"], "stale")
        self.assertEqual(source["days"][-2]["capturedAt"], old_capture)
        self.assertEqual((source["days"][-2]["prs"], source["days"][-2]["commits"]), (2, 2))
        self.assertFalse(later["collection"]["complete"])

    def test_first_pr_page_change_and_overlapping_project_repositories_never_certify(self):
        class ChangingApi(Api):
            def __init__(self):
                super().__init__()
                self.pr_reads = 0

            def __call__(self, args, timeout):
                if urllib.parse.urlsplit(args[5]).path.endswith("/_apis/git/pullrequests"):
                    self.pr_reads += 1
                    if self.pr_reads == 2:
                        self.prs.insert(0, pr(4, "2026-11-10T00:02:00Z"))
                return super().__call__(args, timeout)

        changed = collect(ChangingApi())
        self.assertEqual(changed["sources"][0]["status"], "partial")
        self.assertIn("ADO PR pages changed during scan", changed["sources"][0]["coverage"]["reasons"])
        self.assertIsNone(changed["sources"][0]["days"][-1]["prs"])

        config = copy.deepcopy(CONFIG)
        config["mergedAdoProjects"].append("https://dev.azure.com/example/other-project")
        overlap = collect(Api(), config=config)
        self.assertEqual(len(overlap["sources"]), 2)
        self.assertEqual(overlap["sources"][1]["status"], "partial")
        self.assertIn("Overlapping ADO project discovery", overlap["sources"][1]["coverage"]["reasons"])
        self.assertIsNone(overlap["sources"][1]["days"][-2]["prs"])

    def test_creator_mismatch_malformed_coauthor_and_bad_scope_fail_closed(self):
        api = Api()
        api.prs[0]["createdBy"]["id"] = "99999999-2222-3333-4444-555555555555"
        bad_pr = collect(api)
        self.assertEqual(bad_pr["sources"][0]["status"], "partial")
        self.assertIsNone(bad_pr["sources"][0]["days"][-1]["prs"])
        api = Api()
        api.details[OLDER]["comment"] = "Co-authored-by: unclear person"
        bad_commit = collect(api)
        self.assertIsNone(bad_commit["sources"][0]["days"][-2]["commits"])
        for invalid in ["https://dev.azure.com/example/../_git/thing", "https://evil.test/example/project",
                        "https://dev.azure.com/example/project?token=secret"]:
            config = copy.deepcopy(CONFIG)
            config["mergedAdoProjects"] = [invalid]
            config["adoRemotes"] = []
            with self.assertRaises(ValueError):
                collect(Api(), config=config)

    def test_scoped_attribution_list_is_required_and_changes_invalidate_cached_heads(self):
        api = Api()
        first = collect(api)
        missing = copy.deepcopy(CONFIG)
        missing.pop("adoAuthorEmails")
        unavailable = collect(api, previous=first, config=missing)
        self.assertEqual(unavailable["collection"]["requestCount"], 0)
        self.assertEqual(unavailable["sources"][0]["status"], "unavailable")
        self.assertIsNone(unavailable["sources"][0]["days"][-2]["commits"])
        self.assertIn("Confirmed ADO author aliases required", unavailable["collection"]["reasons"])
        changed = copy.deepcopy(CONFIG)
        changed["adoAuthorEmails"] = [EMAIL]
        api.calls.clear()
        replaced = collect(api, previous=first, config=changed)
        self.assertEqual(replaced["sources"][0]["days"][-2]["commits"], 1)
        self.assertTrue(any("/commits?" in args[5] for args in api.calls))

    def test_auth_failure_does_not_copy_transport_exception_text_into_snapshot(self):
        def broken_run(args, timeout):
            raise ValueError("Bearer private-token")

        result = collect(broken_run)
        self.assertEqual(result["sources"][0]["status"], "unavailable")
        self.assertIn("ADO authenticated read unavailable", result["collection"]["reasons"])
        self.assertNotIn("private-token", json.dumps(result))

    def test_large_remote_inventory_is_bounded_and_resumable_without_local_clones(self):
        api = Api()
        api.prs = []
        api.histories[HEAD] = []
        api.repos = []
        for index in range(1100):
            repo_id = f"{index:08x}-bbbb-cccc-dddd-eeeeeeeeeeee"
            api.repos.append({"id": repo_id, "name": f"repository-{index}",
                              "defaultBranch": None if 477 <= index < 490 else "refs/heads/main",
                              "isDisabled": index < 477})
            api.heads[repo_id] = HEAD
        with patch.object(ado, "REQUESTS_PER_PROJECT", 20):
            partial = collect(api)
            later = collect(api, previous=partial)
        source = later["sources"][0]
        self.assertEqual(source["provenance"]["inventoryCount"], 1100)
        self.assertEqual(source["provenance"]["disabledCount"], 477)
        self.assertEqual(source["provenance"]["withoutDefaultCount"], 13)
        self.assertEqual(partial["collection"]["requestCount"], 20)
        self.assertEqual(later["collection"]["requestCount"], 20)
        self.assertGreater(later["state"]["projects"]["example/project"]["work"]["repoIndex"],
                           partial["state"]["projects"]["example/project"]["work"]["repoIndex"])
        self.assertIsNone(source["days"][-1]["commits"])
        self.assertIn("request-budget", source["coverage"]["reasons"])


if __name__ == "__main__":
    unittest.main()
