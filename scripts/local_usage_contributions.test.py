import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import local_usage_contributions as contributions


SCRIPT = Path(__file__).with_name("refresh-local-usage.py")


def load_wrapper(path):
    spec = importlib.util.spec_from_file_location("fixture_refresh", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ContributionWriterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="usage-primary-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.fixture = self.root / "helpers"
        self.fixture.mkdir()
        for name in ("refresh-local-usage.py", "local_usage_contributions.py"):
            shutil.copy2(SCRIPT.with_name(name), self.fixture / name)
        (self.fixture / "local_usage_merged.py").write_text("MAX_HISTORY_DAYS = 191\nTZ = None\n")
        (self.fixture / "local_usage_github.py").write_text('DEFINITION = "github-profile-v1"\n')
        (self.fixture / "local_usage_profile.py").write_text('''from datetime import datetime, timedelta, timezone
def collect(config, run, repository_category, *, at, days, previous):
    assert days == 60 and config["githubProfiles"][0]["stableId"] == "fixture-stable-id"
    end = at.date()
    rows = []
    for offset in range(59, -1, -1):
        day = (end - timedelta(days=offset)).isoformat()
        value = 2 if offset == 0 else 0
        rows.append({"day": day, "capturedAt": at.isoformat().replace("+00:00", "Z"), "status": "ready",
            "prs": value, "knownPrs": value, "commits": value, "knownCommits": value,
            "repositories": [{"id": "fixture-repo", "name": "fixture/repo", "category": "personal",
                "status": "ready", "prs": value, "knownPrs": value, "commits": value, "knownCommits": value}] if value else []})
    source = {"id": "github:fixture", "account": {"host": "github.com", "login": "fixture", "stableId": "fixture-stable-id"},
        "status": "ready", "coverage": {"identityVerified": True, "paginationComplete": True, "visibilityComplete": True, "reasons": []}, "days": rows}
    return {"version": 2, "metricDefinition": "github-profile-v2", "provider": "github",
        "asOfAt": at.isoformat().replace("+00:00", "Z"), "capturedAt": at.isoformat().replace("+00:00", "Z"),
        "dateBasis": {"prs": "github-profile-day", "commits": "github-profile-day"},
        "operationWindow": {"startDay": rows[0]["day"], "endDay": rows[-1]["day"], "todayPartial": True},
        "activeSourceIds": ["github:fixture"], "sources": [source],
        "collection": {"requestCount": 1, "elapsedSeconds": 0.1, "complete": True, "reasons": []}}
''')
        (self.fixture / "local_usage_ado.py").write_text('''from local_usage_profile import collect as github
def collect(config, run, repository_category, *, at, days, previous):
    assert config["adoAuthorEmails"] == ["corporate@example.test"]
    result = github(config, run, repository_category, at=at, days=days, previous=None)
    result["provider"] = "ado"
    result["metricDefinition"] = "ado-default-head-v1"
    result["dateBasis"] = {"prs": "created-at/UTC", "commits": "author-at/UTC"}
    result["activeSourceIds"] = ["ado:fixture"]
    result["sources"][0]["id"] = "ado:fixture"
    result["sources"][0]["account"] = {"host": "dev.azure.com", "login": "corporate@example.test", "stableId": "11111111-2222-3333-4444-555555555555"}
    result["sources"][0]["scope"] = {"organization": "fixture", "project": "Fixture"}
    for day in result["sources"][0]["days"]:
        for repo in day["repositories"]:
            repo["id"], repo["category"] = "ado-fixture-repo", "work"
    return result
''')
        self.collector = self.root / "collector.py"
        self.collector.write_text('''def run(args, timeout=35):
    raise AssertionError("Synthetic provider must not call a live API")
def remote_category(remote, config):
    return "work" if "dev.azure.com" in remote else "personal"
def refresh(config, **options):
    if config["failLegacy"]:
        raise ValueError("Missing local clones")
    from pathlib import Path
    Path(config["legacyResult"]).write_text("tokens preserved")
''')
        self.wrapper = load_wrapper(SCRIPT)
        self.config = {"primaryContributionSource": "contributions-v2", "githubProfiles": [{"host": "github.com",
            "login": "fixture", "profile": "fixture", "stableId": "fixture-stable-id"}],
            "mergedAdoProjects": ["https://dev.azure.com/fixture/Fixture"],
            "adoPrincipals": {"fixture": {"stableId": "11111111-2222-3333-4444-555555555555", "alias": "corporate@example.test"}},
            "adoAuthorEmails": ["corporate@example.test"],
            "authorEmails": ["corporate@example.test", "personal@example.test", "machine@local.invalid"],
            "azureCli": "/fixture/az", "failLegacy": True, "legacyResult": str(self.root / "tokens.txt"),
            "repoRoots": [str(self.root / "missing-clone")], "storageDir": str(self.root / "legacy")}
        self.target = self.root / "contributions-v2.json"

    def test_remote_capture_publishes_without_local_clones_or_legacy_success(self):
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            result = self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target, whole_cycle_seconds=10)
            self.assertEqual(len(result["github"]["sources"][0]["days"]), 60)
            self.assertEqual(len(result["ado"]["sources"][0]["days"]), 60)
            self.assertFalse((self.root / "tokens.txt").exists())
            lock = self.target.with_suffix(".lock")
            inode = lock.stat().st_ino
            self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target, whole_cycle_seconds=10)
            self.assertEqual(lock.stat().st_ino, inode)
            self.assertEqual(json.loads(self.target.read_text())["github"]["sources"][0]["days"][-1]["prs"], 2)

    def test_missing_scoped_ado_alias_blocks_capture_without_mutation(self):
        self.config.pop("adoAuthorEmails")
        with self.assertRaisesRegex(ValueError, "scoped author aliases"):
            self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target, whole_cycle_seconds=10)
        self.assertFalse(self.target.exists())

    def test_malformed_snapshot_fails_closed_and_keeps_old_generation(self):
        self.target.write_text('{"version":1}')
        with self.assertRaises(ValueError):
            self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target, whole_cycle_seconds=10)
        self.assertEqual(self.target.read_text(), '{"version":1}')

    def test_one_provider_failure_retains_the_previous_generation(self):
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target, whole_cycle_seconds=10)
            before = self.target.read_bytes()
            (self.fixture / "local_usage_ado.py").write_text('''def collect(*args, **kwargs):
    raise ValueError("synthetic provider failure")
''')
            with self.assertRaisesRegex(ValueError, "previous generation retained"):
                self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target, whole_cycle_seconds=10)
            self.assertEqual(self.target.read_bytes(), before)

    def test_whole_cycle_deadline_reaps_owned_workers_without_publication(self):
        profile = self.fixture / "local_usage_profile.py"
        profile.write_text(profile.read_text().replace('    assert days == 60', '    import time; time.sleep(2)\n    assert days == 60'))
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            with self.assertRaisesRegex(ValueError, "previous generation retained"):
                self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target,
                    whole_cycle_seconds=0.15)
        self.assertFalse(self.target.exists())
        self.assertTrue(self.target.with_suffix(".lock").is_file())

    def test_ado_route_expansion_is_scoped_to_pinned_git_gets(self):
        session = self.wrapper.AzureMemorySession(self.root, {"corporate@example.test"}, projects={('fixture', 'fixture')})
        session.token = lambda: "fixture-token"
        calls = []
        class Reply:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"value":[]}'
        session.http.open = lambda request, timeout: (calls.append(request.full_url), Reply())[1]
        base = "https://dev.azure.com/fixture/Fixture/_apis/git/repositories"
        guid = "11111111-2222-3333-4444-555555555555"
        for url in (base + "?api-version=7.1", base + f"/{guid}/refs?api-version=7.1&filter=heads%2Fmain",
                    base + f"/{guid}/commits?api-version=7.1&searchCriteria.itemVersion.version=" + "a" * 40 +
                    "&searchCriteria.itemVersion.versionType=commit&%24top=100&%24skip=0"):
            self.assertEqual(session.request(url, 5)[0], '{"value":[]}')
        self.assertEqual(len(calls), 3)
        hidden = base + "?api-version=7.1&includeHidden=true"
        self.assertEqual(json.loads(session.run(["/fixture/az", "rest", "--method", "get", "--url", hidden,
            "--resource", self.wrapper.ADO_RESOURCE, "-o", "json"], 5)), {"value": []})
        self.assertEqual(len(calls), 4)
        for url in (base + f"/{guid}/commits?api-version=7.1&%24top=100",
                    base + f"/{guid}/refs?api-version=7.1&filter=tags%2Ftest",
                    base.replace("fixture/Fixture", "other/Fixture") + "?api-version=7.1",
                    base + "?api-version=7.1&includeHidden=false",
                    base + "?api-version=7.1&includeHidden=True",
                    base + "?api-version=7.1&includeHidden=true&includeHidden=true",
                    base + f"/{guid}/refs?api-version=7.1&filter=heads%2Fmain&includeHidden=true"):
            with self.assertRaises(ValueError): session.request(url, 5)
        self.assertEqual(len(calls), 4)

    def test_header_only_ado_inventory_page_cannot_become_complete(self):
        provider_dir = Path(os.environ.get("OMB_ADO_MODULE_DIR", str(SCRIPT.parent)))
        test_path = provider_dir / "local_usage_ado.test.py"
        if not (provider_dir / "local_usage_ado.py").is_file() or not test_path.is_file():
            self.skipTest("ADO provider PR is not present in this source checkout")
        sys.path.insert(0, str(provider_dir))
        try:
            spec = importlib.util.spec_from_file_location("ado_header_contract_fixture", test_path)
            provider_tests = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(provider_tests)
        finally:
            sys.path.remove(str(provider_dir))
        api = provider_tests.Api()
        session = self.wrapper.AzureMemorySession(self.root, {provider_tests.EMAIL}, projects={("example", "project")})

        def request(url, timeout):
            body = api(["/fixture/az", "rest", "--method", "get", "--url", url,
                        "--resource", provider_tests.ado.RESOURCE, "-o", "json"], timeout)
            continuation = "next-page" if "/_apis/git/repositories?" in url else None
            return body, continuation

        session.request = request
        result = provider_tests.collect(session.run)
        self.assertFalse(result["collection"]["complete"])
        self.assertNotEqual(result["sources"][0]["status"], "ready")
        self.assertFalse(result["sources"][0]["coverage"]["paginationComplete"])


if __name__ == "__main__":
    unittest.main()
