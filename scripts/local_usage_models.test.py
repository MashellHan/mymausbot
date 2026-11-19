import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
from zoneinfo import ZoneInfo

import local_usage_models as models

SPEC = importlib.util.spec_from_file_location("usage_refresh", Path(__file__).with_name("refresh-local-usage.py"))
usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage)
AT = dt.datetime.fromisoformat("2026-11-18T16:01:00+00:00")
TZ = ZoneInfo("Asia/Shanghai")
PREVIOUS_DAY, TODAY = "2026-11-18", "2026-11-19"


def collector_fixture():
    return types.SimpleNamespace(instant=dt.datetime.fromisoformat,
        day=lambda value: value.astimezone(TZ).date().isoformat(),
        count=lambda value: value if type(value) is int and value >= 0 else 0)


def token(key, date, model="gpt-6.2-sol", provider="codex", count=10):
    return {"key": key, "at": date, "model": model, "provider": provider,
            "input": count, "output": 2, "cacheRead": 3, "category": "personal",
            "unused": "raw transcript, path, or event metadata"}


def daily(day, status="ready", *, input=10, output=2, cache=3):
    categories = {key: {"input": 0, "output": 0, "cacheRead": 0} for key in ("work", "unclassified")}
    return {"day": day, "tokenStatus": status,
            "categories": {**categories, "personal": {"input": input, "output": output, "cacheRead": cache}}}


def snapshot(rows, at=AT):
    return {"version": 1, "timeZone": "Asia/Shanghai", "updatedAt": int(at.timestamp() * 1000), "daily": rows}


class ModelAggregationTests(unittest.TestCase):
    def test_calendar_cutoff_first_duplicate_and_provider_accounting(self):
        collector = collector_fixture()
        previous = token("yesterday", "2026-11-18T15:59:59+00:00")
        current = token("current", "2026-11-18T16:00:00+00:00")
        duplicate = {**current, "model": "activities-unpriced-fixture", "input": 999}
        future = token("future", AT.isoformat())
        distinct_provider = token("distinct", current["at"], provider="pi")
        samples = [{"tokens": [previous, current, future]},
                   {"tokens": [duplicate, distinct_provider]}]
        eligible = models.eligible_machines(collector, samples, AT)
        projected = models.daily_models(collector, eligible, snapshot([daily(PREVIOUS_DAY), daily(TODAY)]))
        self.assertEqual(len(samples[0]["tokens"]), 3)
        today = {"model": "gpt-6.2-sol", "provider": "codex", "input": 10, "output": 2, "cacheRead": 3}
        self.assertEqual(projected, {PREVIOUS_DAY: [today], TODAY: [today, {**today, "provider": "pi"}]})

    def test_bounds_and_reconciliation_preserve_daily_totals_and_exact_zero(self):
        collector = collector_fixture()
        events = [token(str(index), "2026-11-18T16:00:00+00:00", f"model-{index}", count=index)
                  for index in range(models.MAX_DAILY_MODELS + 1)]
        snap = snapshot([daily(PREVIOUS_DAY, input=0, output=0, cache=0),
                         daily(TODAY, input=sum(range(len(events))), output=2 * len(events), cache=3 * len(events))])
        projected = models.daily_models(collector, [{"tokens": events}], snap)
        self.assertEqual(len(projected[TODAY]), models.MAX_DAILY_MODELS)
        history = usage.retain_token_history(snap, None, projected)["trendHistory"]["daily"]
        self.assertEqual(history[0]["totalTokens"], 0)
        self.assertEqual(history[1]["input"], sum(range(len(events))))
        self.assertEqual(len(history[1]["models"]), models.MAX_DAILY_MODELS)
        contradictory = snapshot([daily(TODAY, input=1)])
        row = usage.retain_token_history(contradictory, None, projected)["trendHistory"]["daily"][0]
        self.assertEqual(row["input"], 1)
        self.assertNotIn("models", row)

    def test_history_keeps_only_models_for_retained_observations(self):
        row = {"model": "gpt-6.2-sol", "provider": "codex", "input": 10, "output": 2, "cacheRead": 3}
        first = usage.retain_token_history(snapshot([daily(TODAY)]), None, {TODAY: [row]})
        fresh = usage.retain_token_history(snapshot([daily(TODAY)]), first, {})
        self.assertNotIn("models", fresh["trendHistory"]["daily"][0])
        unobserved = usage.retain_token_history(snapshot([daily(TODAY, "unavailable")]), first, {})
        self.assertEqual(unobserved["trendHistory"]["daily"][0]["models"], [row])
        self.assertEqual(unobserved["trendHistory"]["daily"][0]["tokenStatus"], "partial")
        next_day = dt.datetime.fromisoformat("2026-11-20T08:00:00+00:00")
        stock = snapshot([daily("2026-11-20")], next_day)
        recovered = usage.retain_token_history(snapshot([daily("2026-11-20")], next_day), stock, {}, saved=first)
        self.assertEqual(recovered["trendHistory"]["daily"][0]["models"], [row])


@unittest.skipUnless(os.environ.get("OMB_ACTIVITY_COLLECTOR_FIXTURE"), "pass the frozen collector path")
class FrozenCollectorTest(unittest.TestCase):
    def test_legacy_scope_recovery_and_private_model_capture(self):
        collector_path = Path(os.environ["OMB_ACTIVITY_COLLECTOR_FIXTURE"])
        collector = usage.load_collector(collector_path)
        inside = "git@ssh.dev.azure.com:v3/example/Scope/discovered"
        outside = "https://dev.azure.com/example/other/_git/outside"
        explicit = "https://dev.azure.com/example/scope/_git/explicit"
        with tempfile.TemporaryDirectory() as root:
            storage = Path(root)
            config = {"azureCli": "/fixture/az", "authorEmails": ["owner@example.test"], "home": root,
                      "repoRoots": [], "storageDir": root, "machines": [{"id": "mini-2", "mode": "local"}],
                      "githubProfiles": [{"profile": "fixture", "category": "personal"}], "adoRemotes": [explicit]}
            (storage / "machines").mkdir()
            (storage / "machines/mini-2.json").write_text(json.dumps({
                "device": "mini-2", "status": "ok", "capturedAt": AT.isoformat(), "commits": [],
                "adoRepos": [inside, outside],
                "tokens": [token("real", "2026-11-18T16:00:00+00:00"),
                           token("future", AT.isoformat(), count=100)],
            }))
            allowed_outside, queried = True, []

            def ado_prs(_config, remote, *_args):
                queried.append(remote)
                if remote == outside and not allowed_outside:
                    raise ValueError("fixture denies out-of-scope project")
                return []

            with patch.object(collector, "now", return_value=AT), patch.object(collector, "ado_prs", ado_prs), \
                 patch.object(collector, "github_prs", return_value=[]), contextlib.redirect_stdout(io.StringIO()):
                collector.refresh(config, reuse_sources=True, history_days=59)
                allowed_outside = False
                collector.refresh(config, reuse_sources=True, history_days=59)
                read = lambda: json.loads((storage / "latest.json").read_text())
                self.assertEqual([row["status"] for row in read()["prSources"]].count("stale"), 1)
                self.assertEqual(read()["prCoverage"]["work"], "partial")
                queried.clear()
                with patch.object(usage, "load_collector", return_value=collector):
                    usage.refresh(collector_path, config, storage, reuse_sources=True, legacy_diagnostics=False)
                result = read()
                self.assertCountEqual(queried, [inside, explicit])
                self.assertEqual(result["prCoverage"]["work"], "ready")
                self.assertEqual(result["today"]["categories"]["personal"]["totalTokens"], 15)
                private = result["trendHistory"]["daily"][-1]
                self.assertEqual(private["models"], [{
                    "model": "gpt-6.2-sol", "provider": "codex", "input": 10, "output": 2, "cacheRead": 3,
                }])
                sidecar = json.loads((storage / "token-history.json").read_text())
                self.assertEqual(sidecar["updatedAt"], result["updatedAt"])
                self.assertEqual(sidecar["trendHistory"], result["trendHistory"])
                if schema := os.environ.get("OMB_ACTIVITY_SCHEMA_FIXTURE"):
                    public = subprocess.run(["node", "-e", """
const assert = require("node:assert/strict");
const sanitize = require(process.argv[1]).sanitizeActivity;
const raw = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const { trendHistory, ...stock } = raw;
const published = sanitize(raw);
assert.ok(published);
assert.deepEqual(published, sanitize(stock));
assert.equal(Object.hasOwn(published, "trendHistory"), false);
""", schema], input=json.dumps(result), text=True, capture_output=True)
                    self.assertEqual(public.returncode, 0, public.stderr)
                    self.assertFalse(public.stdout)
                self.assertEqual((storage / "token-history.json").stat().st_mode & 0o777, 0o600)
                saved_machine = json.loads((storage / "machines/mini-2.json").read_text())
                self.assertCountEqual(saved_machine["adoRepos"], [inside, outside])

                sample = saved_machine
                sample["tokens"][0]["model"] = "unknown"
                (storage / "machines/mini-2.json").write_text(json.dumps(sample))
                fresh_collector = usage.load_collector(collector_path)
                with patch.object(usage, "load_collector", return_value=fresh_collector), \
                     patch.object(fresh_collector, "now", return_value=AT), \
                     patch.object(fresh_collector, "ado_prs", ado_prs), \
                     patch.object(fresh_collector, "github_prs", return_value=[]):
                    usage.refresh(collector_path, config, storage, reuse_sources=True, legacy_diagnostics=False)
                self.assertNotIn("models", read()["trendHistory"]["daily"][-1])

                queried.clear()
                unscoped = usage.load_collector(collector_path)
                with patch.object(usage, "load_collector", return_value=unscoped), \
                     patch.object(unscoped, "now", return_value=AT), \
                     patch.object(unscoped, "ado_prs", ado_prs), \
                     patch.object(unscoped, "github_prs", return_value=[]):
                    usage.refresh(collector_path, {**config, "adoRemotes": []}, storage,
                                  reuse_sources=True, legacy_diagnostics=False)
                self.assertCountEqual(queried, [inside, outside])


if __name__ == "__main__":
    unittest.main()
