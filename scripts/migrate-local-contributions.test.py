import argparse
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("migrate-local-contributions.py")
spec = importlib.util.spec_from_file_location("migration", SCRIPT)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def envelope(provider, stable, login, legacy=False):
    end = dt.date(2026, 11, 10)
    days = []
    for offset in range(59, -1, -1):
        date = (end - dt.timedelta(days=offset)).isoformat()
        count = 2 if offset == 0 else 0
        days.append({"day": date, "capturedAt": "2026-11-10T12:00:00Z", "status": "ready",
            "prs": count, "knownPrs": count, "commits": count, "knownCommits": count,
            "repositories": [{"id": provider + "-repo", "name": "fixture/repo", "category": "personal" if provider == "github" else "work",
                "status": "ready", "prs": count, "knownPrs": count, "commits": count, "knownCommits": count}] if count else []})
    source = {"id": provider + "-source", "account": {"host": "github.com" if provider == "github" else "dev.azure.com",
        "login": login, "stableId": stable}, "status": "ready",
        "coverage": {"identityVerified": True, "paginationComplete": True, "visibilityComplete": True, "reasons": []}, "days": days}
    if provider == "ado":
        source["scope"] = {"organization": "example", "project": "Project"}
    return {"version": 2, "provider": provider,
        "metricDefinition": ("github-profile-v2" if provider == "github" else "ado-default-head-v1") if legacy
            else ("github-profile-beijing-v1" if provider == "github" else "ado-default-head-beijing-v1"),
        "dateBasis": ({"prs": "github-profile-day", "commits": "github-profile-day"} if provider == "github"
                      else {"prs": "created-at/UTC", "commits": "author-at/UTC"}) if legacy
            else {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"},
        "asOfAt": "2026-11-10T12:00:00Z", "capturedAt": "2026-11-10T12:00:00Z",
        "operationWindow": {"startDay": days[0]["day"], "endDay": days[-1]["day"], "todayPartial": True},
        "activeSourceIds": [source["id"]], "sources": [source],
        "collection": {"requestCount": 1, "elapsedSeconds": 0.1, "complete": True, "reasons": []}}


def snapshot(legacy=False, progress=0):
    github = envelope("github", "fixture-stable-id", "Fixture", legacy)
    ado = envelope("ado", "11111111-2222-3333-4444-555555555555", "corporate@example.test", legacy)
    if not legacy:
        github["state"] = {"schema": 1, "sources": {"fixture-source": {"progress": {"fixture-repo": {"pages": progress}}}}}
    ado["state"] = {"schema": 3, "projects": {}}
    return {"version": 2, "github": github, "ado": ado}


class MigrationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="contribution-migration-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        patcher = patch.object(migration, "user_home", return_value=self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.plan = self.root / "plan"
        self.config = self.root / ".config/agent-town/activity.json"
        self.config.parent.mkdir(parents=True)
        self.cache = self.root / ".local/share/mymausbot/usage/contributions-v2.json"
        self.azure = self.root / ".azure"
        self.azure.mkdir()
        self.python = self.root / "azure-venv/bin/python"
        self.python.parent.mkdir(parents=True)
        self.python.symlink_to(sys.executable)
        self.collector = self.root / "collector.py"
        self.collector.write_text("# synthetic collector entry\n")
        self.helpers = self.root / "installed-helpers"
        self.helpers.mkdir()
        self.app = self.root / "candidate.app"
        source = self.app / "Contents/Resources/usage-helpers"
        source.mkdir(parents=True)
        for name in migration.HELPERS:
            (source / name).write_text("signed candidate " + name)
        (self.helpers / "refresh-local-usage.py").write_text("old wrapper")
        self.plist = self.root / "scheduled.plist"
        with self.plist.open("wb") as stream:
            plistlib.dump({"Label": "fixture.usage", "StartInterval": 300,
                "ProgramArguments": [str(self.python), str(self.helpers / "refresh-local-usage.py"), "--collector", str(self.collector)],
                "EnvironmentVariables": {"PATH": "/usr/bin:/bin", "PYTHONUNBUFFERED": "1"},
                "WorkingDirectory": str(self.root)}, stream)
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        accounts = [{"profile": "fixture", "result": {"data": {"viewer": {
            "id": "fixture-stable-id", "login": "Fixture", "url": "https://github.com/Fixture"}}}}]
        inventory = {"identities": {"example": {"id": "11111111-2222-3333-4444-555555555555",
            "account": "corporate@example.test"}}}
        (self.evidence / "account-api-verification.json").write_text(json.dumps(accounts))
        (self.evidence / "ado-remote-inventory.json").write_text(json.dumps(inventory))
        (self.evidence / "lead-root-evidence-adoption.json").write_text(json.dumps({"rootEvidence": [
            {"path": str(self.evidence / name), "sha256": sha(self.evidence / name)}
            for name in ("account-api-verification.json", "ado-remote-inventory.json")]}))
        self.proof = self.root / "ado-author-proof.txt"
        self.proof.write_text("EMAILS = {'corporate@example.test'}\n")
        self.private_candidate = self.root / "private-profile-candidate.json"
        self.private_candidate.write_text(json.dumps({"githubHelper": str((self.helpers / "refresh-local-usage.py").resolve()), "githubProfiles": [{
            "profile": "fixture", "host": "github.com", "login": "Fixture", "stableId": "fixture-stable-id",
            "privateRepositories": ["fixture/private-repo"]}]}))
        self.original = {"githubProfiles": [{"host": "github.com", "login": "Fixture", "profile": "fixture",
            "category": "personal", "visibilityProof": {"stale": True}}], "mergedAdoProjects": ["https://dev.azure.com/example/Project"],
            "authorEmails": ["corporate@example.test", "personal@example.test", "machine@local.invalid"],
            "otherSetting": {"preserve": True}, "storageDir": str(self.root / "activity-storage")}
        (self.root / "activity-storage").mkdir()
        self.config.write_text(json.dumps(self.original))
        self.args = argparse.Namespace(plan_dir=str(self.plan), config=str(self.config), cache=str(self.cache),
            helpers_dir=str(self.helpers), app=str(self.app), launch_agent=str(self.plist), evidence_dir=str(self.evidence),
            ado_author_proof=str(self.proof), ado_author_email=["corporate@example.test"],
            private_profile_candidate=str(self.private_candidate), expected_private_profile_sha256=sha(self.private_candidate),
            collector=str(self.collector), azure_config_dir=str(self.azure), python=str(self.python))

    def prepared(self):
        migration.prepare(self.args)
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertFalse(self.cache.exists())
        candidate = json.loads((self.plan / "candidate-config.json").read_text())
        self.assertEqual(candidate["githubProfiles"][0]["stableId"], "fixture-stable-id")
        self.assertEqual(candidate["githubProfiles"][0]["privateRepositories"], ["fixture/private-repo"])
        self.assertNotIn("visibilityProof", candidate["githubProfiles"][0])
        self.assertEqual(candidate["adoAuthorEmails"], ["corporate@example.test"])
        self.assertEqual(candidate["authorEmails"], self.original["authorEmails"])
        self.assertEqual(candidate["otherSetting"], self.original["otherSetting"])
        return candidate

    def sealed(self):
        if self.cache.exists():
            migration.prepare(self.args)
        else:
            self.prepared()
        value = snapshot(progress=1)
        def fake_run(command, **options):
            path = Path(command[command.index("--output") + 1])
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            return subprocess.CompletedProcess(command, 0, stdout='{"primary":"published"}\n', stderr="")
        with patch.object(migration.subprocess, "run", side_effect=fake_run):
            migration.capture(argparse.Namespace(plan_dir=str(self.plan)))
        migration.seal(argparse.Namespace(plan_dir=str(self.plan)))
        return argparse.Namespace(plan_dir=str(self.plan), expected_plan_sha256=sha(self.plan / "sealed-plan.json"))

    def seed(self):
        self.cache.parent.mkdir(parents=True, exist_ok=True)
        self.cache.write_text(json.dumps(snapshot(legacy=True)))
        self.cache.chmod(0o600)

    def test_prepare_config_and_seal_are_private_and_reconcile_identities(self):
        args = self.sealed()
        self.assertFalse(self.cache.exists())
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertEqual(json.loads((self.plan / "sealed-plan.json").read_text())["candidateCacheSha256"],
                         sha(self.plan / "candidate-cache.json"))
        self.assertEqual(args.expected_plan_sha256, sha(self.plan / "sealed-plan.json"))

    def test_capture_uses_the_scheduled_venv_executable_and_clean_runtime(self):
        self.prepared()
        captured = {}
        value = snapshot(progress=1)

        def fake_run(command, **options):
            captured.update(command=command, options=options)
            path = Path(command[command.index("--output") + 1])
            path.write_text(json.dumps(value))
            path.chmod(0o600)
            return subprocess.CompletedProcess(command, 0, stdout='{"primary":"published"}\n', stderr="")

        with patch.object(migration.subprocess, "run", side_effect=fake_run):
            migration.capture(argparse.Namespace(plan_dir=str(self.plan)))
        self.assertEqual(captured["command"][0], str(self.python))
        self.assertEqual(captured["command"][1], str((self.app / "Contents/Resources/usage-helpers/refresh-local-usage.py").resolve()))
        self.assertEqual(captured["command"][captured["command"].index("--config") + 1], str(self.plan / "capture-config.json"))
        self.assertEqual(json.loads((self.plan / "capture-config.json").read_text())["githubHelper"], captured["command"][1])
        self.assertEqual(json.loads((self.plan / "candidate-config.json").read_text())["githubHelper"], str((self.helpers / "refresh-local-usage.py").resolve()))
        self.assertEqual(captured["options"]["cwd"], str(self.root))
        self.assertEqual(captured["options"]["env"]["PATH"], "/usr/bin:/bin")
        self.assertEqual(captured["options"]["env"]["HOME"], str(self.root))
        self.assertEqual(captured["options"]["env"]["PYTHONDONTWRITEBYTECODE"], "1")
        self.assertNotIn("AZURE_CONFIG_DIR", captured["options"]["env"])
        self.assertNotIn("GH_TOKEN", captured["options"]["env"])
        migration.seal(argparse.Namespace(plan_dir=str(self.plan)))

    def test_packaged_executable_requires_its_exact_capture_config_binding(self):
        source = self.app / "Contents/Resources/usage-helpers/refresh-local-usage.py"
        sibling = source.with_name("local_usage_profile.py")
        sibling.write_text("PROOF = 'signed-resource-import'\n")
        fixture = self.root / "synthetic-result.json"
        fixture.write_text(json.dumps(snapshot(progress=1)))
        source.write_text('''import argparse
import json
import sys
from pathlib import Path
import local_usage_profile
parser = argparse.ArgumentParser()
parser.add_argument("--config", required=True)
parser.add_argument("--output", required=True)
args, _ = parser.parse_known_args()
if not sys.dont_write_bytecode or local_usage_profile.PROOF != "signed-resource-import":
    raise SystemExit(18)
if json.loads(Path(args.config).read_text())["githubHelper"] != str(Path(__file__).resolve()):
    raise SystemExit(17)
target = Path(args.output)
target.write_bytes(Path(%r).read_bytes())
target.chmod(0o600)
''' % str(fixture))
        migration.prepare(self.args)
        migration.capture(argparse.Namespace(plan_dir=str(self.plan)))
        self.assertEqual(json.loads((self.plan / "candidate-cache.json").read_text())["github"]["state"]["schema"], 1)
        self.assertFalse((source.parent / "__pycache__").exists())
        self.assertEqual(list(source.parent.rglob("*.pyc")), [])
        capture_config = self.plan / "capture-config.json"
        wrong = json.loads(capture_config.read_text())
        wrong["githubHelper"] = str((self.helpers / "refresh-local-usage.py").resolve())
        capture_config.write_text(json.dumps(wrong))
        failed = subprocess.run([str(self.python), "-B", str(source), "--config", str(capture_config),
                                 "--output", str(self.root / "rejected.json")], capture_output=True, text=True,
                                 env={"HOME": str(self.root), "PATH": "/usr/bin:/bin"})
        self.assertEqual(failed.returncode, 17)
        self.assertFalse((self.root / "rejected.json").exists())

    def test_two_private_captures_resume_candidate_despite_live_writer_advance(self):
        self.seed()
        original_seed = sha(self.cache)
        migration.prepare(self.args)
        observed = []

        def fake_run(command, **options):
            output = Path(command[command.index("--output") + 1])
            seed_path = Path(command[command.index("--previous") + 1])
            observed.append((sha(seed_path), json.loads(output.read_text())["github"]["state"]["sources"]["fixture-source"]["progress"]["fixture-repo"]["pages"]
                             if output.exists() else 0))
            output.write_text(json.dumps(snapshot(progress=observed[-1][1] + 1)))
            output.chmod(0o600)
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with patch.object(migration.subprocess, "run", side_effect=fake_run):
            migration.capture(argparse.Namespace(plan_dir=str(self.plan)))
            live = snapshot(legacy=True)
            live["github"]["collection"]["requestCount"] = 2
            self.cache.write_text(json.dumps(live))
            self.assertNotEqual(sha(self.cache), original_seed)
            migration.capture(argparse.Namespace(plan_dir=str(self.plan)))
        self.assertEqual(observed, [(original_seed, 0), (original_seed, 1)])
        self.assertEqual(json.loads((self.plan / "candidate-cache.json").read_text())["github"]["state"]["sources"]["fixture-source"]["progress"]["fixture-repo"]["pages"], 2)
        self.assertEqual(sha(self.plan / "before/contributions-v2.json"), original_seed)

    def test_invalid_seed_or_candidate_stops_before_capture(self):
        self.seed()
        legacy = json.loads(self.cache.read_text())
        legacy["ado"].pop("state")
        self.cache.write_text(json.dumps(legacy))
        migration.prepare(self.args)
        with patch.object(migration.subprocess, "run") as runner, self.assertRaisesRegex(ValueError, "ADO raw continuation"):
            migration.capture(argparse.Namespace(plan_dir=str(self.plan)))
        runner.assert_not_called()
        shutil.rmtree(self.plan)
        self.seed()
        migration.prepare(self.args)
        candidate = snapshot(progress=1)
        candidate["github"]["metricDefinition"] = "github-profile-v2"
        private_cache = self.plan / "candidate-cache.json"
        private_cache.write_text(json.dumps(candidate))
        private_cache.chmod(0o600)
        with patch.object(migration.subprocess, "run") as runner, self.assertRaisesRegex(ValueError, "definition"):
            migration.capture(argparse.Namespace(plan_dir=str(self.plan)))
        runner.assert_not_called()

    def test_prepare_rejects_mismatched_scheduled_targets_or_base_python(self):
        for field, wrong in (("config", str(self.root / "wrong-config.json")),
                             ("collector", str(self.root / "wrong-collector.py")),
                             ("cache", str(self.root / "wrong-contributions-v2.json")),
                             ("azure_config_dir", str(self.root / "wrong-azure")),
                             ("python", sys.executable)):
            with self.subTest(field=field):
                original = getattr(self.args, field)
                setattr(self.args, field, wrong)
                try:
                    with self.assertRaisesRegex(ValueError, "scheduled helper"):
                        migration.prepare(self.args)
                    self.assertFalse(self.plan.exists())
                finally:
                    setattr(self.args, field, original)

    def test_skip_api_or_changed_schedule_fails_before_seal_or_apply(self):
        with self.plist.open("rb") as stream:
            scheduled = plistlib.load(stream)
        scheduled["ProgramArguments"].append("--skip-api")
        with self.plist.open("wb") as stream:
            plistlib.dump(scheduled, stream)
        with self.assertRaisesRegex(ValueError, "scheduled helper"):
            migration.prepare(self.args)
        self.assertFalse(self.plan.exists())
        scheduled["ProgramArguments"].pop()
        with self.plist.open("wb") as stream:
            plistlib.dump(scheduled, stream)
        self.prepared()
        value = {"version": 2, "github": envelope("github", "fixture-stable-id", "Fixture"),
                 "ado": envelope("ado", "11111111-2222-3333-4444-555555555555", "corporate@example.test")}
        (self.plan / "candidate-cache.json").write_text(json.dumps(value))
        scheduled["ProgramArguments"].append("--skip-api")
        with self.plist.open("wb") as stream:
            plistlib.dump(scheduled, stream)
        with self.assertRaisesRegex(ValueError, "Scheduled command changed"):
            migration.seal(argparse.Namespace(plan_dir=str(self.plan)))
        self.assertEqual(json.loads(self.config.read_text()), self.original)

    def test_apply_resume_idempotency_and_rollback_preserve_unrelated_config(self):
        args = self.sealed()
        original_helper = (self.helpers / "refresh-local-usage.py").read_bytes()
        source = self.app / "Contents/Resources/usage-helpers"
        (self.helpers / "refresh-local-usage.py").write_bytes((source / "refresh-local-usage.py").read_bytes())
        migration.transition(args)
        self.assertEqual(json.loads(self.config.read_text())["primaryContributionSource"], "contributions-v2")
        self.assertEqual(sha(self.cache), sha(self.plan / "candidate-cache.json"))
        migration.transition(args)
        migration.transition(args, rollback=True)
        migration.transition(args, rollback=True)
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertFalse(self.cache.exists())
        self.assertEqual((self.helpers / "refresh-local-usage.py").read_bytes(), original_helper)
        self.assertEqual(sha(self.plist), json.loads((self.plan / "prepared-plan.json").read_text())["launchAgentSha256"])

    def test_already_enabled_unchanged_config_upgrades_and_resumes_partial_install(self):
        enabled = migration.migrated_config(self.original, migration.verified_inputs(self.evidence),
            ["corporate@example.test"], json.loads(self.private_candidate.read_text()))
        self.config.write_text(json.dumps(enabled, indent=2, ensure_ascii=False) + "\n")
        self.seed()
        old_cache = sha(self.cache)
        args = self.sealed()
        self.assertEqual(sha(self.config), json.loads((self.plan / "sealed-plan.json").read_text())["candidateConfigSha256"])
        original_atomic = migration.atomic
        writes = []

        def interrupted(path, content, mode):
            if writes:
                raise RuntimeError("synthetic interruption after first helper write")
            original_atomic(path, content, mode)
            writes.append(str(path))

        with patch.object(migration, "atomic", side_effect=interrupted), self.assertRaisesRegex(RuntimeError, "interruption"):
            migration.transition(args)
        self.assertEqual(sha(self.config), sha(self.plan / "candidate-config.json"))
        self.assertEqual(sha(self.cache), old_cache)
        self.assertEqual(sha(self.helpers / "refresh-local-usage.py"),
                         sha(self.app / "Contents/Resources/usage-helpers/refresh-local-usage.py"))
        migration.transition(args)
        migration.transition(args)
        self.assertEqual(sha(self.cache), sha(self.plan / "candidate-cache.json"))
        self.assertEqual(sha(self.config), sha(self.plan / "before/config.json"))
        self.assertEqual(json.loads((self.plan / "apply-result.json").read_text())["configSha256"], sha(self.config))
        migration.transition(args, rollback=True)
        self.assertEqual(sha(self.cache), old_cache)
        self.assertEqual(sha(self.config), sha(self.plan / "candidate-config.json"))

    def test_distinct_config_premature_enable_is_rejected(self):
        args = self.sealed()
        self.config.write_bytes((self.plan / "candidate-config.json").read_bytes())
        with self.assertRaisesRegex(ValueError, "incomplete installed source"):
            migration.transition(args)
        self.assertFalse(self.cache.exists())
        self.assertEqual((self.helpers / "refresh-local-usage.py").read_text(), "old wrapper")

    def test_staged_progress_enters_fresh_final_plan_and_late_external_change_blocks_apply(self):
        self.sealed()
        staged_hash = sha(self.plan / "sealed-plan.json")
        staged_cache_hash = sha(self.plan / "candidate-cache.json")
        self.seed()
        final = self.root / "final-plan"
        final_args = argparse.Namespace(**{**vars(self.args), "plan_dir": str(final)})
        migration.prepare(final_args)
        migration.adopt_staged(argparse.Namespace(plan_dir=str(final), staged_plan_dir=str(self.plan),
            expected_staged_plan_sha256=staged_hash))
        self.assertEqual(sha(final / "candidate-cache.json"), staged_cache_hash)
        observed = []

        def fake_run(command, **options):
            output = Path(command[command.index("--output") + 1])
            previous = json.loads(output.read_text())
            pages = previous["github"]["state"]["sources"]["fixture-source"]["progress"]["fixture-repo"]["pages"]
            observed.append(pages)
            output.write_text(json.dumps(snapshot(progress=pages + 1)))
            output.chmod(0o600)
            return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

        with patch.object(migration.subprocess, "run", side_effect=fake_run):
            migration.capture(argparse.Namespace(plan_dir=str(final)))
        self.assertEqual(observed, [1])
        migration.seal(argparse.Namespace(plan_dir=str(final)))
        changed = snapshot(legacy=True)
        changed["github"]["collection"]["requestCount"] = 3
        self.cache.write_text(json.dumps(changed))
        advanced_hash = sha(self.cache)
        with self.assertRaisesRegex(ValueError, "changed outside"):
            migration.transition(argparse.Namespace(plan_dir=str(final), expected_plan_sha256=sha(final / "sealed-plan.json")))
        self.assertEqual(sha(self.cache), advanced_hash)
        self.assertEqual(self.config.read_text(), json.dumps(self.original))

    def test_new_collection_after_apply_blocks_destructive_rollback(self):
        args = self.sealed()
        migration.transition(args)
        self.cache.write_text('{"new":"scheduled capture"}')
        with self.assertRaisesRegex(ValueError, "changed outside"):
            migration.transition(args, rollback=True)
        self.assertEqual(self.cache.read_text(), '{"new":"scheduled capture"}')

    def test_existing_scheduled_collector_lock_blocks_install(self):
        args = self.sealed()
        legacy_lock = Path(self.original["storageDir"]) / ".refresh.lock"
        legacy_lock.mkdir()
        with self.assertRaises(FileExistsError):
            migration.transition(args)
        self.assertEqual(json.loads(self.config.read_text()), self.original)
        self.assertFalse(self.cache.exists())

    def test_identity_mismatch_and_unscoped_legacy_alias_fail_before_a_live_write(self):
        self.args.ado_author_email = ["personal@example.test"]
        self.proof.write_text("EMAILS = {'personal@example.test'}\n")
        with self.assertRaisesRegex(ValueError, "ADO principal"):
            migration.prepare(self.args)
        self.assertFalse(self.plan.exists())
        self.args.ado_author_email = ["corporate@example.test"]
        self.proof.write_text("EMAILS = {'corporate@example.test'}\n")
        self.original["githubProfiles"][0]["login"] = "other"
        self.config.write_text(json.dumps(self.original))
        with self.assertRaisesRegex(ValueError, "Private Profile candidate"):
            migration.prepare(self.args)
        self.assertFalse(self.plan.exists())


if __name__ == "__main__":
    unittest.main()
