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
        self.inventory_continuation = None
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
            assert target.query == "connectOptions=0"
        else:
            assert query["api-version"] == ["7.1"]
        if path.endswith("/_apis/connectionData"):
            result = {"authenticatedUser": {"id": self.owner,
                "properties": {"Account": {"$value": EMAIL}}}}
        elif path.endswith("/_apis/git/repositories"):
            result = {"value": self.repos, "count": len(self.repos)}
            if self.inventory_continuation:
                result["continuationToken"] = self.inventory_continuation
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
    def test_connection_data_uses_verified_versionless_url_only_for_identity(self):
        api = Api()
        collect(api)
        targets = [args[5] for args in api.calls]
        self.assertEqual(targets[0], "https://dev.azure.com/example/_apis/connectionData?connectOptions=0")
        self.assertTrue(all(urllib.parse.parse_qs(urllib.parse.urlsplit(target).query)["api-version"] == ["7.1"]
                            for target in targets[1:]))

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

    def test_unchanged_head_cache_reconsiders_future_author_at_later_cutoff(self):
        api = Api()
        future = "8" * 40
        api.histories[HEAD].insert(0, commit(future, "2026-11-10T00:31:00Z"))
        api.details[future] = api.histories[HEAD][0]
        first = collect(api)
        self.assertEqual(first["sources"][0]["status"], "ready")
        self.assertEqual(first["sources"][0]["days"][-1]["commits"], 0)
        self.assertIn(future, {item["id"] for item in first["state"]["projects"]["example/project"]["cache"][REPO]["items"]})
        api.calls.clear()
        later = collect(api, previous=first, at=AT + dt.timedelta(minutes=5))
        self.assertEqual(later["sources"][0]["status"], "ready")
        self.assertEqual(later["sources"][0]["days"][-1]["commits"], 1)
        self.assertFalse(any("/commits?" in args[5] for args in api.calls))

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

    def test_force_push_during_incomplete_scan_cannot_certify_old_pinned_history(self):
        api = Api()
        initial = collect(api)
        intermediate, replacement = "d" * 40, "e" * 40
        api.heads[REPO] = intermediate
        api.histories[intermediate] = [commit(intermediate, "2026-11-09T01:00:00Z"), *api.histories[HEAD]]
        api.details[intermediate] = api.histories[intermediate][0]
        with patch.object(ado, "REQUESTS_PER_PROJECT", 6):
            partial = collect(api, previous=initial, at=AT + dt.timedelta(minutes=5))
        progress = partial["state"]["projects"]["example/project"]["work"]["progress"][REPO]
        self.assertEqual(progress["head"], intermediate)
        self.assertTrue(progress["pending"])
        api.heads[REPO] = replacement
        api.histories[replacement] = [commit(replacement, "2026-11-09T02:00:00Z")]
        api.details[replacement] = api.histories[replacement][0]
        mismatch = collect(api, previous=partial, at=AT + dt.timedelta(minutes=10))
        self.assertFalse(mismatch["collection"]["complete"])
        self.assertIn("head-changed-during-scan", mismatch["sources"][0]["coverage"]["reasons"])
        self.assertEqual(mismatch["sources"][0]["days"][-2]["status"], "stale")
        retained = mismatch["state"]["projects"]["example/project"]["cache"][REPO]
        self.assertEqual(retained["head"], intermediate)
        self.assertIn(intermediate, retained["checked"])
        result = collect(api, previous=mismatch, at=AT + dt.timedelta(minutes=15))
        self.assertEqual(result["sources"][0]["status"], "ready")
        self.assertEqual(result["sources"][0]["days"][-2]["commits"], 1)
        rewritten = result["state"]["projects"]["example/project"]["cache"][REPO]
        self.assertEqual(rewritten["head"], replacement)
        self.assertEqual(rewritten["relation"], "rewritten")

    def test_repeated_fast_forward_keeps_complete_pinned_proofs_until_head_settles(self):
        api = Api()
        initial = collect(api)
        first_head, second_head, third_head = ("d" * 40, "e" * 40, "6" * 40)

        def advance(new_head, prior_head):
            api.heads[REPO] = new_head
            row = commit(new_head, "2026-11-09T08:00:00Z")
            api.histories[new_head] = [row, *api.histories[prior_head]]
            api.details[new_head] = row

        def finish_moved(previous, at):
            for _ in range(12):
                result = collect(api, previous=previous, at=at)
                if "head-changed-during-scan" in result["sources"][0]["coverage"]["reasons"]:
                    return result
                previous = result
            self.fail("Pinned traversal did not finish under bounded continuation")

        advance(first_head, HEAD)
        with patch.object(ado, "REQUESTS_PER_REPOSITORY", 3):
            first_partial = collect(api, previous=initial, at=AT + dt.timedelta(minutes=5))
            advance(second_head, first_head)
            first_moved = finish_moved(first_partial, AT + dt.timedelta(minutes=5))
            first_proof = first_moved["state"]["projects"]["example/project"]["cache"][REPO]
            self.assertEqual((first_proof["head"], first_proof["relation"]), (first_head, "descendant"))
            api.calls.clear()
            second_partial = collect(api, previous=first_moved, at=AT + dt.timedelta(minutes=10))
            self.assertIn(REPO, second_partial["state"]["projects"]["example/project"]["work"]["progress"])
            advance(third_head, second_head)
            second_moved = finish_moved(second_partial, AT + dt.timedelta(minutes=10))
            second_proof = second_moved["state"]["projects"]["example/project"]["cache"][REPO]
            self.assertEqual((second_proof["head"], second_proof["relation"]), (second_head, "descendant"))
            settled = second_moved
            for _ in range(12):
                settled = collect(api, previous=settled, at=AT + dt.timedelta(minutes=15))
                if settled["sources"][0]["status"] == "ready":
                    break
        self.assertEqual(settled["sources"][0]["status"], "ready")
        self.assertEqual(settled["sources"][0]["days"][-2]["commits"], 5)
        self.assertEqual(settled["state"]["projects"]["example/project"]["cache"][REPO]["relation"], "descendant")
        detail_urls = [args[5] for args in api.calls if "/commits/" in args[5]]
        detail_ids = {urllib.parse.urlsplit(target).path.split("/")[-1] for target in detail_urls}
        self.assertEqual(detail_ids, {second_head, third_head})

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
        self.assertIsNone(disabled["sources"][0]["days"][-2]["prs"])
        self.assertEqual(disabled["sources"][0]["days"][-2]["knownPrs"], 2)
        self.assertIsNone(disabled["sources"][0]["days"][-2]["commits"])
        api.repos[0]["isDisabled"] = False
        api.heads[REPO] = "bad"
        missing = collect(api)
        self.assertIn("unavailable-default-head", missing["sources"][0]["coverage"]["reasons"])
        self.assertIsNone(missing["sources"][0]["days"][-2]["commits"])

    def test_permission_filtered_inventory_cannot_erase_previously_seen_or_configured_repo(self):
        api = Api()
        complete = collect(api)
        original_repos = api.repos
        api.repos = []
        api.prs = []
        missing = collect(api, previous=complete, at=AT + dt.timedelta(minutes=5))
        source = missing["sources"][0]
        self.assertEqual(source["status"], "stale")
        self.assertFalse(source["coverage"]["visibilityComplete"])
        self.assertIn("repository-visibility-gap", source["coverage"]["reasons"])
        self.assertEqual(source["days"][-2]["status"], "stale")
        self.assertEqual(source["days"][-2]["prs"], 2)
        self.assertEqual(source["days"][-2]["commits"], 2)
        again = collect(api, previous=missing, at=AT + dt.timedelta(minutes=10))
        self.assertIn("repository-visibility-gap", again["sources"][0]["coverage"]["reasons"])
        self.assertFalse(again["collection"]["complete"])
        first = collect(api)
        self.assertIn("repository-visibility-gap", first["sources"][0]["coverage"]["reasons"])
        self.assertIsNone(first["sources"][0]["days"][-2]["prs"])
        self.assertEqual(first["sources"][0]["days"][-2]["knownPrs"], 0)
        self.assertIsNone(first["sources"][0]["days"][-2]["commits"])
        api.repos = original_repos
        restored = collect(api, previous=again, at=AT + dt.timedelta(minutes=15))
        self.assertEqual(restored["sources"][0]["status"], "ready")

    def test_inventory_continuation_signal_cannot_certify_a_truncated_list(self):
        api = Api()
        api.inventory_continuation = "more-repositories"
        partial = collect(api)
        self.assertEqual(partial["sources"][0]["status"], "partial")
        self.assertFalse(partial["sources"][0]["coverage"]["paginationComplete"])
        self.assertIsNone(partial["sources"][0]["days"][-2]["commits"])
        self.assertIn("Invalid or unpaged ADO response", partial["collection"]["reasons"])

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

        api = ChangingApi()
        changed = collect(api)
        self.assertEqual(changed["sources"][0]["status"], "partial")
        self.assertIn("ADO PR pages changed during scan", changed["sources"][0]["coverage"]["reasons"])
        self.assertIsNone(changed["sources"][0]["days"][-1]["prs"])
        state = changed["state"]["projects"]["example/project"]["work"]
        self.assertEqual((state["prOffset"], state["prSeen"], state["prs"]), (0, [], []))
        recovered = collect(api, previous=changed)
        self.assertEqual(recovered["sources"][0]["days"][-1]["prs"], 2)

        config = copy.deepcopy(CONFIG)
        config["mergedAdoProjects"].append("https://dev.azure.com/example/other-project")
        overlap = collect(Api(), config=config)
        self.assertEqual(len(overlap["sources"]), 2)
        self.assertEqual(overlap["sources"][1]["status"], "partial")
        self.assertIn("Overlapping ADO project discovery", overlap["sources"][1]["coverage"]["reasons"])
        self.assertIsNone(overlap["sources"][1]["days"][-2]["prs"])

    def test_failed_pr_page_admits_no_prefix_and_corrected_retry_cannot_duplicate(self):
        api = Api()
        api.prs[1]["createdBy"]["id"] = "99999999-2222-3333-4444-555555555555"
        partial = collect(api)
        work = partial["state"]["projects"]["example/project"]["work"]
        self.assertEqual((work["prs"], work["prSeen"], work["prOffset"], work["prFirst"]),
                         ([], [], 0, None))
        self.assertIsNone(partial["sources"][0]["days"][-2]["prs"])
        api.prs[1]["createdBy"]["id"] = OWNER
        recovered = collect(api, previous=partial)
        self.assertEqual(recovered["sources"][0]["status"], "ready")
        self.assertEqual(sum(row["prs"] for row in recovered["sources"][0]["days"]), 3)
        self.assertEqual(len(recovered["state"]["projects"]["example/project"]["work"]["prSeen"]), 3)

    def test_duplicate_pr_pagination_resets_before_clean_rescan(self):
        api = Api()
        api.prs = [pr(index, "2026-11-09T12:00:00Z") for index in range(1, 101)]
        api.prs.append(pr(50, "2026-11-09T12:00:00Z"))
        partial = collect(api)
        work = partial["state"]["projects"]["example/project"]["work"]
        self.assertIn("Duplicate ADO PR page", partial["sources"][0]["coverage"]["reasons"])
        self.assertEqual((work["prOffset"], work["prSeen"], work["prs"]), (0, [], []))
        api.prs[-1] = pr(101, "2026-11-09T12:00:00Z")
        recovered = collect(api, previous=partial)
        self.assertEqual(recovered["sources"][0]["days"][-2]["prs"], 101)

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

    def test_advancing_head_keeps_pinned_progress_and_later_repo_gets_fair_slice(self):
        api = Api()
        second_repo = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
        second_head = "7" * 40
        api.repos.append({"id": second_repo, "name": "second", "defaultBranch": "refs/heads/main",
                          "isDisabled": False})
        api.heads[second_repo] = second_head
        api.prs = []
        api.histories[HEAD] = [commit(HEAD, "2026-11-09T12:00:00Z")] + [
            commit(f"{index:040x}", "2026-11-09T12:00:00Z") for index in range(1, 25)]
        api.histories[second_head] = [commit(second_head, "2026-11-09T12:00:00Z")]
        api.details = {row["commitId"]: row for rows in api.histories.values() for row in rows}
        with patch.object(ado, "REQUESTS_PER_REPOSITORY", 4), patch.object(ado, "REQUESTS_PER_PROJECT", 20):
            first = collect(api)
            work = first["state"]["projects"]["example/project"]["work"]
            self.assertIn(REPO, work["progress"])
            self.assertIn(second_repo, work["repoDone"])
            pending_before = len(work["progress"][REPO]["pending"])
            api.heads[REPO] = "6" * 40
            later = collect(api, previous=first, at=AT + dt.timedelta(minutes=5))
        continued = later["state"]["projects"]["example/project"]["work"]
        self.assertEqual(continued["progress"][REPO]["head"], HEAD)
        self.assertLess(len(continued["progress"][REPO]["pending"]), pending_before)
        self.assertIn(second_repo, continued["repoDone"])
        self.assertFalse(later["sources"][0]["coverage"]["paginationComplete"])


if __name__ == "__main__":
    unittest.main()
