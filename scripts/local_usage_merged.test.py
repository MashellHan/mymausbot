import datetime as dt
import hashlib
import json
from pathlib import Path
import stat
import tempfile
import unittest
import urllib.parse

import local_usage_merged as merged


AT = dt.datetime.fromisoformat("2026-11-06T08:00:00+00:00")
OWNER = "fixture-owner"
IDENTITY = "11111111-2222-3333-4444-555555555555"
REPO = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
PROJECT = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"


class Monitor:
    @staticmethod
    def digest(*values):
        return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    @classmethod
    def repository_identity(cls, remote):
        target = urllib.parse.urlsplit(remote)
        name = target.hostname + "/" + urllib.parse.unquote(target.path.strip("/"))
        return {"id": cls.digest(name.casefold()), "name": name}

    @staticmethod
    def remote_category(remote, _config):
        target = urllib.parse.urlsplit(remote)
        return "work" if target.hostname.endswith(".ghe.com") or target.hostname == "dev.azure.com" or target.path.startswith("/workorg/") else "personal"

    @staticmethod
    def ado_coordinates(remote):
        target = urllib.parse.urlsplit(remote)
        parts = target.path.strip("/").split("/")
        return tuple(parts[0:2] + [parts[-1]]) if target.hostname == "dev.azure.com" and len(parts) == 4 and parts[-2] == "_git" else None


def sha(index):
    return f"{index:040x}"


def github_pr(pr_id, when, repo="personal/project"):
    return {"id": pr_id, "mergedAt": when, "author": {"login": OWNER},
            "repository": {"id": "repo-" + repo, "nameWithOwner": repo}}


class Github:
    def __init__(self):
        self.calls = []
        self.fail_commits = False
        self.prs = [github_pr("pr-1", "2026-11-06T03:00:00Z"),
                    github_pr("pr-2", "2026-11-05T05:00:00Z", "workorg/shared"),
                    github_pr("pr-3", "2026-10-01T04:00:00Z")]
        self.commits = {"pr-1": [(sha(i), 1) for i in range(1, 6)],
                        "pr-2": [(sha(1), 1), (sha(7), 2)],
                        "pr-3": [(sha(8), 0)]}

    def __call__(self, args, timeout):
        self.calls.append(args)
        self.timeout = timeout
        fields = dict(arg.split("=", 1) for index, arg in enumerate(args) if index > 0 and args[index - 1] == "-f")
        if "search(query:" in fields["query"]:
            after = fields.get("after")
            rows = self.prs[:1] if not after else self.prs[1:]
            result = {"issueCount": len(self.prs), "nodes": rows,
                      "pageInfo": {"hasNextPage": not after, "endCursor": "next" if not after else None}}
            return json.dumps({"data": {"viewer": {"login": OWNER}, "search": result}})
        if self.fail_commits:
            raise AssertionError("Immutable complete commit pages should be cached")
        pr_id = fields["id"]
        commits = self.commits[pr_id]
        after = fields.get("after")
        rows = commits[:3] if pr_id == "pr-1" and not after else commits[3:] if pr_id == "pr-1" else commits
        result = {"totalCount": len(commits), "nodes": [{"commit": {"oid": oid,
                  "parents": {"totalCount": parents}}} for oid, parents in rows],
                  "pageInfo": {"hasNextPage": pr_id == "pr-1" and not after, "endCursor": "commits-next" if pr_id == "pr-1" and not after else None}}
        return json.dumps({"data": {"viewer": {"login": OWNER}, "node": {"commits": result}}})


class LargeGithub(Github):
    def __init__(self):
        super().__init__()
        self.prs = [github_pr("large", "2026-11-06T03:00:00Z")]
        self.commits = {"large": [(sha(i), 2 if i % 3 == 0 else 1) for i in range(1, 342)]}
        self.comparison_pages = []
        self.problem = None

    def __call__(self, args, timeout):
        if "/compare/" in args[-1]:
            if self.fail_commits:
                raise AssertionError("Complete large PR commits should be cached")
            page = int(urllib.parse.parse_qs(urllib.parse.urlsplit(args[-1]).query)["page"][0])
            self.comparison_pages.append(page)
            rows = list(reversed(self.commits["large"]))[(page - 1) * 100:page * 100]
            if self.problem == "missing" and page == 4:
                rows = []
            if self.problem == "different" and page == 4:
                rows = [(sha(999) if oid == sha(1) else oid, parents) for oid, parents in rows]
            if self.problem == "parents" and page == 4:
                rows = [(oid, 2 if oid == sha(1) else parents) for oid, parents in rows]
            return json.dumps({"total_commits": 340 if self.problem == "count" and page == 2 else 341,
                "base_commit": {"sha": sha(888) if self.problem == "base" else sha(900)},
                "commits": [{"sha": oid, "parents": [{"sha": sha(i)} for i in range(parents)]} for oid, parents in rows]})
        fields = dict(arg.split("=", 1) for index, arg in enumerate(args) if index > 0 and args[index - 1] == "-f")
        if "search(query:" in fields["query"]:
            return super().__call__(args, timeout)
        if self.fail_commits:
            raise AssertionError("Complete large PR commits should be cached")
        if fields.get("after"):
            raise AssertionError("Do not page through GitHub's truncated PR connection")
        self.calls.append(args)
        rows = self.commits["large"][:100]
        return json.dumps({"data": {"viewer": {"login": OWNER}, "node": {
            "baseRefOid": sha(900), "headRefOid": sha(341), "repository": {"nameWithOwner": "personal/project"},
            "commits": {"totalCount": 341, "nodes": [{"commit": {"oid": oid, "parents": {"totalCount": parents}}} for oid, parents in rows],
                        "pageInfo": {"hasNextPage": True, "endCursor": "next"}}}}})


class RemoteMergedTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.file = Path(self.folder.name) / "merged-v1.json"
        self.monitor = Monitor()
        self.config = {"githubHelper": "/fixture/helper", "githubProfiles": [{"host": "github.com", "profile": "personal",
                       "login": OWNER, "category": "personal"}], "authorEmails": ["owner@example.test"]}

    def test_paginated_original_commits_are_cached_and_stale_failures_keep_counts(self):
        github = Github()
        first = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        self.assertEqual(stat.S_IMODE(self.file.stat().st_mode), 0o600)
        self.assertEqual(first["windowStartDay"], "2026-09-08")
        self.assertEqual(first["sources"][0]["status"], "ready")
        items = first["sources"][0]["items"]
        self.assertEqual(len(items), 3)
        self.assertEqual([len(item["commits"]) for item in items], [5, 1, 1])
        self.assertIn("merged:>=", " ".join(str(call) for call in github.calls))
        self.assertIn("merged:<", " ".join(str(call) for call in github.calls))
        self.assertNotIn("created:", " ".join(str(call) for call in github.calls))
        self.assertTrue(all("pr-" not in json.dumps(item) and sha(1) not in json.dumps(item) for item in items))
        github.calls.clear()
        github.fail_commits = True
        second = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        self.assertEqual(second["sources"][0]["status"], "ready")
        self.assertEqual(len(github.calls), 2)
        stale = merged.refresh(self.config, self.monitor, lambda _args, timeout: (_ for _ in ()).throw(OSError("offline")), file=self.file, at=AT)
        self.assertEqual(stale["sources"][0]["status"], "stale")
        self.assertEqual(stale["sources"][0]["items"], items)
        self.assertEqual(merged.refresh(self.config, self.monitor, github, file=self.file, at=AT, skip_api=True)["sources"][0]["status"], "stale")

    def test_large_pr_comparison_recovers_all_original_commits_and_is_cached(self):
        github = LargeGithub()
        result = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        source = result["sources"][0]
        self.assertEqual(source["status"], "ready")
        self.assertEqual(set(source["items"][0]["commits"]), {
            self.monitor.digest("original-pr-commit", sha(i)) for i in range(1, 342) if i % 3})
        self.assertEqual(github.comparison_pages, [1, 2, 3, 4])
        github.fail_commits = True
        cached = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        self.assertEqual(cached["sources"][0]["status"], "ready")
        self.assertEqual(cached["sources"][0]["items"], source["items"])

    def test_large_pr_comparison_rejects_mismatched_or_incomplete_pages(self):
        for problem in ("missing", "different", "parents", "count", "base"):
            with self.subTest(problem=problem):
                github = LargeGithub()
                github.problem = problem
                with self.assertRaises(ValueError):
                    merged.github_commits(self.config, self.config["githubProfiles"][0], "large", github, self.monitor)

    def test_project_wide_ado_merges_use_verified_creator_and_parent_details(self):
        self.config = {"azureCli": "/fixture/az", "authorEmails": ["owner@example.test"],
                       "mergedAdoProjects": ["https://dev.azure.com/example/project"]}
        calls = []
        def ado(url, timeout):
            calls.append(url)
            if "/connectionData" in url:
                return json.dumps({"authenticatedUser": {"id": IDENTITY, "properties": {"Account": {"$value": "owner@example.test"}}}}), None
            if "/_apis/git/pullrequests?" in url:
                if urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get("$skip") == ["1"]:
                    return json.dumps({"value": [], "count": 0}), None
                return json.dumps({"value": [{"status": "completed", "pullRequestId": 7,
                    "closedDate": "2026-11-06T02:00:00Z", "createdBy": {"id": IDENTITY, "uniqueName": "owner@example.test"},
                    "repository": {"id": REPO, "name": "fixture", "project": {"id": PROJECT}}}], "count": 1}), None
            if "/pullrequests/7/commits?" in url:
                if "continuationToken=next" in url:
                    return json.dumps({"value": [{"commitId": sha(11), "parents": [sha(1), sha(2)]}]}), None
                return json.dumps({"value": [{"commitId": sha(10)}]}), "next"
            if "/commits/" in url:
                return json.dumps({"parents": [sha(1)]}), None
            raise AssertionError(url)
        result = merged.refresh(self.config, self.monitor, lambda _args, timeout: (_ for _ in ()).throw(AssertionError("No CLI")),
                                ado_request=ado, file=self.file, at=AT)
        self.assertEqual(result["sources"][0]["status"], "ready")
        self.assertEqual(len(result["sources"][0]["items"][0]["commits"]), 1)
        self.assertTrue(any("/_apis/git/pullrequests?" in url and "queryTimeRangeType=closed" in url for url in calls))
        self.assertTrue(any("/pullrequests/7/commits?" in url for url in calls))
        self.assertTrue(any("continuationToken=next" in url for url in calls))
        self.assertTrue(any("/commits/" in url for url in calls))
        self.assertTrue(all("repositories/" not in url for url in calls if "/_apis/git/pullrequests?" in url))

    def test_completed_ado_pr_commit_pages_survive_a_cold_timeout(self):
        self.config = {"azureCli": "/fixture/az", "authorEmails": ["owner@example.test"],
                       "mergedAdoProjects": ["https://dev.azure.com/example/project"]}
        calls = []
        fail_second = True
        fail_cached = False
        def ado(url, timeout):
            calls.append(url)
            if "/connectionData" in url:
                return json.dumps({"authenticatedUser": {"id": IDENTITY, "properties": {"Account": {"$value": "owner@example.test"}}}}), None
            if "/_apis/git/pullrequests?" in url:
                offset = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get("$skip")
                if offset == ["2"]:
                    return json.dumps({"value": [], "count": 0}), None
                prs = [{"status": "completed", "pullRequestId": pr_id,
                        "closedDate": "2026-11-06T02:00:00Z", "createdBy": {"id": IDENTITY, "uniqueName": "owner@example.test"},
                        "repository": {"id": REPO, "name": "fixture", "project": {"id": PROJECT}}} for pr_id in (7, 8)]
                return json.dumps({"value": prs, "count": 2}), None
            if "/pullrequests/7/commits?" in url:
                if fail_cached:
                    raise AssertionError("completed ADO PR was refetched")
                return json.dumps({"value": [{"commitId": sha(10), "parents": [sha(1)]}]}), None
            if "/pullrequests/8/commits?" in url:
                if fail_second:
                    raise TimeoutError("synthetic budget")
                return json.dumps({"value": [{"commitId": sha(12), "parents": [sha(1)]}]}), None
            raise AssertionError(url)
        no_cli = lambda _args, timeout: (_ for _ in ()).throw(AssertionError("No CLI"))
        partial = merged.refresh(self.config, self.monitor, no_cli, ado_request=ado, file=self.file, at=AT)
        self.assertEqual(partial["sources"][0]["status"], "partial")
        self.assertEqual(len(partial["sources"][0]["items"]), 1)
        fail_second = False
        fail_cached = True
        calls.clear()
        complete = merged.refresh(self.config, self.monitor, no_cli, ado_request=ado, file=self.file, at=AT)
        self.assertEqual(complete["sources"][0]["status"], "ready")
        self.assertEqual(len(complete["sources"][0]["items"]), 2)
        self.assertFalse(any("/pullrequests/7/commits?" in url for url in calls))

    def test_ado_project_aliases_decode_once_and_schedule_one_source_per_canonical_project(self):
        self.config = {"azureCli": "/fixture/az", "authorEmails": ["owner@example.test"],
                       "mergedAdoProjects": ["https://dev.azure.com/Example/My%20Project",
                                             "https://dev.azure.com/Example/Project", "https://dev.azure.com/example/project"],
                       "adoRemotes": ["https://dev.azure.com/example/My%20Project/_git/One",
                                      "https://dev.azure.com/EXAMPLE/My Project/_git/Two"]}
        self.assertEqual(len(merged.ado_projects(self.config, self.monitor)), 2)
        urls = []
        def ado(url, timeout):
            urls.append(url)
            if "/connectionData" in url:
                return json.dumps({"authenticatedUser": {"id": IDENTITY, "properties": {"Account": {"$value": "owner@example.test"}}}}), None
            if "/_apis/git/pullrequests?" in url:
                return json.dumps({"value": [], "count": 0}), None
            raise AssertionError(url)
        no_cli = lambda _args, timeout: (_ for _ in ()).throw(AssertionError("No CLI"))
        result = merged.refresh(self.config, self.monitor, no_cli, ado_request=ado, file=self.file, at=AT)
        self.assertEqual(len(result["sources"]), 2)
        self.assertEqual(len({source["id"] for source in result["sources"]}), 2)
        self.assertTrue(all(source["status"] == "ready" for source in result["sources"]))
        project_urls = [url for url in urls if "/_apis/git/pullrequests?" in url]
        self.assertEqual(len(project_urls), 2)
        self.assertTrue(any("/Example/My%20Project/_apis/git/pullrequests?" in url for url in project_urls))
        self.assertFalse(any("%2520" in url for url in project_urls))

    def test_ghe_uses_its_verified_profile_and_work_repository_category(self):
        self.config["githubProfiles"][0].update(host="microsoft.ghe.com", profile="enterprise")
        github = Github()
        result = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        self.assertEqual(result["sources"][0]["provider"], "ghe")
        self.assertTrue(all(item["category"] == "work" for item in result["sources"][0]["items"]))
        self.assertTrue(all(call[3] == "enterprise" for call in github.calls))

    def test_missing_source_is_not_a_zero_and_incomplete_pages_never_replace_cache(self):
        github = Github()
        first = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        github.prs = github.prs * 400
        second = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        self.assertEqual(second["sources"][0]["status"], "stale")
        self.assertEqual(second["sources"][0]["items"], first["sources"][0]["items"])
        self.file.unlink()
        empty = merged.refresh(self.config, self.monitor, lambda _args, timeout: (_ for _ in ()).throw(OSError("offline")), file=self.file, at=AT)
        self.assertEqual(empty["sources"][0]["status"], "unavailable")
        self.assertEqual(empty["sources"][0]["items"], [])

    def test_completed_pr_pages_survive_a_cold_budget_then_finish_without_refetching_commits(self):
        class Cold(Github):
            fail_page = True
            fail_cached = False

            def __call__(self, args, timeout):
                fields = dict(arg.split("=", 1) for index, arg in enumerate(args) if index > 0 and args[index - 1] == "-f")
                if self.fail_page and "search(query:" in fields["query"] and fields.get("after"):
                    raise TimeoutError("synthetic budget")
                if self.fail_cached and fields.get("id") == "pr-1":
                    raise AssertionError("completed original commits were reread")
                return super().__call__(args, timeout)

        github = Cold()
        partial = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        self.assertEqual(partial["sources"][0]["status"], "partial")
        self.assertEqual(len(partial["sources"][0]["items"]), 1)
        self.assertEqual(len(partial["sources"][0]["items"][0]["commits"]), 5)
        github.fail_page = False
        github.fail_cached = True
        complete = merged.refresh(self.config, self.monitor, github, file=self.file, at=AT)
        self.assertEqual(complete["sources"][0]["status"], "ready")
        self.assertEqual(len(complete["sources"][0]["items"]), 3)

    def test_short_terminal_search_page_never_claims_complete_coverage(self):
        class Short(Github):
            def __call__(self, args, timeout):
                fields = dict(arg.split("=", 1) for index, arg in enumerate(args) if index > 0 and args[index - 1] == "-f")
                if "search(query:" in fields["query"]:
                    return json.dumps({"data": {"viewer": {"login": OWNER}, "search": {
                        "issueCount": 2, "nodes": self.prs[:1], "pageInfo": {"hasNextPage": False, "endCursor": None}}}})
                return super().__call__(args, timeout)

        partial = merged.refresh(self.config, self.monitor, Short(), file=self.file, at=AT)
        self.assertEqual(partial["sources"][0]["status"], "partial")
        self.assertEqual(len(partial["sources"][0]["items"]), 1)
        self.assertNotEqual(partial["sources"][0]["status"], "ready")


if __name__ == "__main__":
    unittest.main()
