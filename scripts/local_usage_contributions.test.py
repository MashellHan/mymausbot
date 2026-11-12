import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
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
from zoneinfo import ZoneInfo
def collect(config, run, repository_category, *, at, days, previous):
    assert days == 60 and config["githubProfiles"][0]["stableId"] == "fixture-stable-id"
    mode = config.get("syntheticMode", "ready")
    end = at.astimezone(ZoneInfo("Asia/Shanghai")).date()
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
    if mode != "ready":
        source["status"] = "unavailable" if mode == "source-error" else "partial"
        source["coverage"].update({"identityVerified": mode != "source-error",
            "paginationComplete": mode not in ("incomplete", "source-error"),
            "visibilityComplete": False, "reasons": [mode]})
        for row in rows:
            row["status"] = "unavailable" if mode == "source-error" else "partial"
            row["prs"] = row["commits"] = None
            if mode in ("incomplete", "source-error"):
                row["knownPrs"] = row["knownCommits"] = None
                row["repositories"] = []
        if mode == "complete-correction":
            source["coverage"].update({"paginationComplete": True, "visibilityComplete": True, "reasons": []})
            source["status"] = "ready"
            for row in rows:
                row["status"] = "ready"
                row["prs"] = row["knownPrs"] = row["commits"] = row["knownCommits"] = 1 if row["day"] == end.isoformat() else 0
                if row["repositories"]:
                    for repo in row["repositories"]:
                        repo["prs"] = repo["knownPrs"] = repo["commits"] = repo["knownCommits"] = 1
    old_page = previous.get("state", {}).get("sources", {}).get("github:fixture", {}).get("progress", {}).get("page", 0) if previous else 0
    return {"version": 2, "metricDefinition": "github-profile-beijing-v1", "provider": "github",
        "asOfAt": at.isoformat().replace("+00:00", "Z"), "capturedAt": at.isoformat().replace("+00:00", "Z"),
        "dateBasis": {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"},
        "operationWindow": {"startDay": rows[0]["day"], "endDay": rows[-1]["day"], "todayPartial": True},
        "activeSourceIds": ["github:fixture"], "sources": [source],
        "collection": {"requestCount": 1, "elapsedSeconds": 0.1, "complete": mode in ("ready", "complete-correction"), "reasons": [] if mode in ("ready", "complete-correction") else [mode]},
        "state": {"schema": 1, "sources": {"github:fixture": {"account": source["account"],
            "scopeHash": config.get("syntheticScope", "scope-one"), "progress": {"page": old_page + 1}}}}}
''')
        (self.fixture / "local_usage_ado.py").write_text('''from local_usage_profile import collect as github
def collect(config, run, repository_category, *, at, days, previous):
    assert config["adoAuthorEmails"] == ["corporate@example.test"]
    result = github({**config, "syntheticMode": "ready"}, run, repository_category, at=at, days=days, previous=None)
    result["provider"] = "ado"
    result["metricDefinition"] = "ado-default-head-beijing-v1"
    result["dateBasis"] = {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"}
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

    def test_private_capture_cli_uses_only_remote_workers_and_private_output(self):
        candidate = self.root / "candidate-config.json"
        candidate.write_text(json.dumps(self.config))
        result = subprocess.run([sys.executable, str(self.fixture / "refresh-local-usage.py"),
            "--collector", str(self.collector), "--config", str(candidate),
            "--capture-only", "--output", str(self.target)], capture_output=True, text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.target.read_text())["version"], 2)
        self.assertFalse((self.root / "tokens.txt").exists())

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

    def test_partial_account_day_accepts_known_category_with_unknown_repository(self):
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            value = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                 file=self.target, whole_cycle_seconds=10)
        source = value["github"]["sources"][0]
        source["status"] = "partial"
        source["coverage"]["visibilityComplete"] = False
        row = source["days"][-1]
        row["status"], row["commits"], row["knownCommits"] = "partial", None, None
        known = row["repositories"][0]
        known["status"], known["category"], known["commits"], known["knownCommits"] = "partial", "work", None, 0
        row["repositories"].append({**known, "id": "unknown-repo", "category": "personal",
                                    "prs": 0, "knownPrs": 0, "knownCommits": None})
        contributions.validate_bindings(value, self.config)
        known["knownCommits"] = 5
        contributions.validate_bindings(value, self.config)
        row["repositories"][1]["knownCommits"] = 0
        with self.assertRaisesRegex(ValueError, "Repository subtotal exceeds source day"):
            contributions.validate_bindings(value, self.config)

    def test_account_host_case_alias_cannot_double_a_configured_profile(self):
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            self.wrapper.refresh_primary(self.collector, self.config, self.root, file=self.target, whole_cycle_seconds=10)
        original = self.target.read_bytes()
        value = json.loads(original)
        duplicate = json.loads(json.dumps(value["github"]["sources"][0]))
        duplicate["id"] = "github:case-alias"
        duplicate["account"]["host"] = duplicate["account"]["host"].upper()
        value["github"]["sources"].append(duplicate)
        value["github"]["activeSourceIds"].append(duplicate["id"])
        with self.assertRaisesRegex(ValueError, "Duplicate contribution account scope"):
            contributions.snapshot(value)
        with self.assertRaises(ValueError):
            contributions.validate_bindings(value, self.config)
        self.assertEqual(self.target.read_bytes(), original)

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

    def test_incomplete_history_retains_partial_observations_and_resumes_after_restart(self):
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            self.config["syntheticMode"] = "visibility-partial"
            first = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                 file=self.target, whole_cycle_seconds=10)
            original_cutoff = first["github"]["asOfAt"]
            self.config["syntheticMode"] = "incomplete"
            second = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                  file=self.target, whole_cycle_seconds=10)
            self.assertEqual(second["github"]["sources"][0]["days"][-1]["knownCommits"], 2)
            self.assertEqual(second["github"]["sources"][0]["status"], "stale")
            self.assertEqual(second["github"]["sources"][0]["provenance"]["sourceCutoffAt"], original_cutoff)
            self.assertEqual(second["github"]["state"]["sources"]["github:fixture"]["progress"]["page"], 2)
            self.assertEqual(second["ado"]["sources"][0]["status"], "ready")
            self.wrapper = load_wrapper(SCRIPT)
            with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
                third = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                     file=self.target, whole_cycle_seconds=10)
                self.assertEqual(third["github"]["state"]["sources"]["github:fixture"]["progress"]["page"], 3)
                self.assertEqual(third["github"]["sources"][0]["provenance"]["sourceCutoffAt"], original_cutoff)
                self.config["syntheticMode"] = "complete-correction"
                recovered = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                         file=self.target, whole_cycle_seconds=10)
                self.assertEqual(recovered["github"]["sources"][0]["status"], "ready")
                self.assertEqual(recovered["github"]["sources"][0]["days"][-1]["knownCommits"], 1)
                self.assertNotIn("provenance", recovered["github"]["sources"][0])

    def test_source_error_and_changed_scope_do_not_publish_false_retention(self):
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            first = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                 file=self.target, whole_cycle_seconds=10)
            self.config["syntheticMode"] = "source-error"
            retained = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                    file=self.target, whole_cycle_seconds=10)
            self.assertEqual(retained["github"]["sources"][0]["status"], "stale")
            self.assertEqual(retained["github"]["sources"][0]["days"][-1]["knownCommits"], 2)
            self.config["syntheticScope"] = "different-scope"
            changed = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                   file=self.target, whole_cycle_seconds=10)
            self.assertEqual(changed["github"]["sources"][0]["status"], "unavailable")
            self.assertIsNone(changed["github"]["sources"][0]["days"][-1]["knownCommits"])
            self.assertEqual(first["github"]["metricDefinition"], changed["github"]["metricDefinition"])

    def test_new_beijing_day_retains_old_cutoff_with_missing_day_and_healthy_ado(self):
        with patch.object(self.wrapper, "__file__", str(self.fixture / "refresh-local-usage.py")):
            prior = self.wrapper.refresh_primary(self.collector, self.config, self.root,
                                                 file=self.target, whole_cycle_seconds=10)
        oldest = prior["github"]["operationWindow"]["startDay"]
        old_source = prior["github"]["sources"][0]
        old_source["status"] = "partial"
        old_source["coverage"].update({"eligibilityUncertainDays": [oldest],
            "eligibilityUncertainDaysByCategory": {"work": [], "personal": [oldest], "unclassified": []},
            "reasons": ["history-commit-eligibility-uncertain"]})
        prior["github"]["collection"].update({"complete": False, "reasons": ["history-commit-eligibility-uncertain"]})
        contributions.validate_bindings(prior, self.config)
        candidate = copy.deepcopy(prior)
        next_day = (dt.date.fromisoformat(prior["github"]["operationWindow"]["endDay"]) + dt.timedelta(days=1)).isoformat()
        for provider in ("github", "ado"):
            envelope = candidate[provider]
            envelope["asOfAt"] = (contributions.instant(envelope["asOfAt"]) + dt.timedelta(days=1)).isoformat().replace("+00:00", "Z")
            envelope["capturedAt"] = envelope["asOfAt"]
            envelope["operationWindow"] = {"startDay": envelope["sources"][0]["days"][1]["day"],
                                            "endDay": next_day, "todayPartial": True}
            source = envelope["sources"][0]
            source["days"] = source["days"][1:]
            day = {**source["days"][-1], "day": next_day, "capturedAt": envelope["capturedAt"]}
            source["days"].append(day)
        github = candidate["github"]["sources"][0]
        github["status"] = "partial"
        github["coverage"].update({"paginationComplete": False, "reasons": ["history-incomplete"],
                                   "eligibilityUncertainDays": [],
                                   "eligibilityUncertainDaysByCategory": {"work": [], "personal": [], "unclassified": []}})
        lost = github["days"][-2]
        lost.update({"status": "partial", "prs": None, "knownPrs": None,
                     "commits": None, "knownCommits": None, "repositories": []})
        github["days"][-1].update({"status": "unavailable", "prs": None, "knownPrs": None,
                                   "commits": None, "knownCommits": None, "repositories": []})
        candidate["github"]["collection"].update({"complete": False, "reasons": ["history-incomplete"]})
        contributions.validate_bindings(candidate, self.config)
        contributions.preserve_incomplete_github(prior, candidate)
        contributions.validate_bindings(candidate, self.config)
        retained = candidate["github"]["sources"][0]
        self.assertEqual(retained["status"], "stale")
        self.assertEqual(retained["days"][-1]["day"], prior["github"]["operationWindow"]["endDay"])
        self.assertEqual(retained["provenance"]["sourceCutoffAt"], prior["github"]["asOfAt"])
        self.assertEqual(retained["coverage"]["eligibilityUncertainDays"], [])
        self.assertEqual(retained["coverage"]["eligibilityUncertainDaysByCategory"],
                         {"work": [], "personal": [], "unclassified": []})
        self.assertEqual(candidate["ado"]["sources"][0]["days"][-1]["day"], next_day)
        stale = copy.deepcopy(candidate)
        stale["github"]["asOfAt"] = (contributions.instant(prior["github"]["asOfAt"]) - dt.timedelta(days=1)).isoformat().replace("+00:00", "Z")
        with self.assertRaisesRegex(ValueError, "Older contribution capture"):
            contributions.preserve_incomplete_github(candidate, stale)

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
