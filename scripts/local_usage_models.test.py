import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import socket
import sqlite3
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
    return types.SimpleNamespace(
        instant=lambda value: dt.datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else None,
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


class OpenCodeEventsTests(unittest.TestCase):
    start = dt.datetime.fromisoformat("2026-11-18T16:00:00+00:00")
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(AT.timestamp() * 1000)

    def database(self, path, *, current=True, legacy=True):
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path)
        self.addCleanup(db.close)
        if current:
            db.execute("CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)")
        if legacy:
            db.execute("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)")
        return db

    def payload(self, completed, model="gemini-4-hydrogen", *, legacy=False, cwd="/fixture/personal"):
        return json.dumps({
            "time": {"completed": completed},
            "tokens": {"input": 10, "output": 5, "reasoning": 3, "cache": {"read": 20, "write": 4}},
            "path": {"cwd": cwd}, "unrelated": "Synthetic private text",
            **({"role": "assistant", "modelID": model} if legacy else {"model": {"id": model}}),
        })

    def test_completed_window_schema_precedence_classification_and_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = home / ".local/share/opencode/opencode.db"
            db = self.database(path)
            self.assertEqual(db.execute("PRAGMA journal_mode = WAL").fetchone()[0], "wal")
            db.executemany("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)", [
                ("crossing", "current", "assistant", self.start_ms - 1000, self.payload(self.start_ms)),
                ("end", "current", "assistant", self.end_ms - 1000, self.payload(self.end_ms)),
                ("before", "current", "assistant", self.start_ms - 2000, self.payload(self.start_ms - 1000)),
                ("pending", "current", "assistant", self.start_ms, self.payload(None)),
                ("user", "current", "user", self.start_ms, self.payload(self.start_ms)),
                ("other-day-user", "migrated", "user", self.start_ms - 86400000, "{}"),
                ("invalid-model", "current", "assistant", self.start_ms + 1000,
                 self.payload(self.start_ms + 1000, "sk-" + "a" * 24, cwd="relative/cwd")),
            ])
            db.executemany("INSERT INTO message VALUES (?, ?, ?, ?)", [
                ("crossing", "current", self.start_ms, self.payload(self.start_ms, legacy=True)),
                ("legacy-migrated", "migrated", self.start_ms,
                 self.payload(self.start_ms, "gemini-4-carbon", legacy=True)),
                ("legacy-only", "legacy", self.start_ms + 1000,
                 self.payload(self.start_ms + 1000, "mai-code-2", legacy=True, cwd="/fixture/work")),
            ])
            db.commit()
            file_bytes = path.read_bytes()
            classify = {"/fixture/personal": "personal", "/fixture/work": "work", None: "unclassified"}.__getitem__
            events, error = models.opencode_events(home, classify, self.start, AT, env={})
            self.assertIsNone(error)
            self.assertEqual(path.read_bytes(), file_bytes)
            self.assertEqual(len(events), 4)
            indexed = {event["model"]: event for event in events}
            valid = indexed["gemini-4-hydrogen"]
            self.assertEqual(valid, {
                "key": hashlib.sha256(b"opencode\0current\0crossing").hexdigest(),
                "at": "2026-11-18T16:00:00Z", "category": "personal", "provider": "opencode",
                "model": "gemini-4-hydrogen", "input": 14, "output": 8, "cacheRead": 20,
                "cacheWrite": 4, "reasoning": 3,
            })
            self.assertEqual(indexed["mai-code-2"]["category"], "work")
            self.assertEqual(indexed["gemini-4-carbon"]["category"], "personal")
            self.assertEqual(indexed["unknown"]["category"], "unclassified")
            self.assertEqual(models.opencode_events(home, classify, self.start, AT, env={}), (events, None))
            projected = models.daily_models(collector_fixture(), [{"tokens": events}], snapshot([daily(TODAY)]))
            self.assertEqual({row["model"] for row in projected[TODAY]},
                             {"gemini-4-hydrogen", "gemini-4-carbon", "mai-code-2"})
            self.assertNotIn("Synthetic private text", json.dumps(events))
            self.assertNotIn("/fixture", json.dumps(events))

    def test_database_selection_and_missing_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            data_home = home / "data"
            selected = data_home / "opencode/custom.db"
            db = self.database(selected, current=False)
            db.execute("INSERT INTO message VALUES (?, ?, ?, ?)",
                       ("legacy", "legacy", self.start_ms, self.payload(self.start_ms, legacy=True)))
            db.commit()
            classify = lambda _cwd: "unclassified"
            read = lambda env: models.opencode_events(home, classify, self.start, AT, env=env)
            relative = read({"XDG_DATA_HOME": str(data_home), "OPENCODE_DB": "custom.db"})
            self.assertEqual(len(relative[0]), 1)
            self.assertIsNone(relative[1])
            self.assertEqual(read({"XDG_DATA_HOME": "relative", "OPENCODE_DB": str(selected)}), relative)
            self.assertEqual(read({"OPENCODE_DB": ":memory:"}), ([], None))
            self.assertEqual(read({}), ([], None))
            self.assertEqual(read({"OPENCODE_DB": "missing.db"}), ([], "MissingDatabase"))
            invalid = home / "invalid.db"
            invalid.write_text("not a SQLite database")
            self.assertEqual(read({"OPENCODE_DB": str(invalid)}), ([], "DatabaseReadError"))
            with contextlib.closing(sqlite3.connect(invalid := home / "unsupported.db")) as unsupported:
                unsupported.execute("CREATE TABLE unrelated (id TEXT)")
            self.assertEqual(read({"OPENCODE_DB": str(invalid)}), ([], "UnsupportedSchema"))

    def test_bad_rows_and_limits_preserve_good_observations(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            db = self.database(home / ".local/share/opencode/opencode.db", legacy=False)
            db.executemany("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)", [
                ("oversize", "test", "assistant", self.start_ms + 3, "x" * 1024),
                ("malformed", "test", "assistant", self.start_ms + 2, "{"),
                ("last", "test", "assistant", self.start_ms + 1, self.payload(self.start_ms + 1)),
                ("first", "test", "assistant", self.start_ms, self.payload(self.start_ms)),
            ])
            db.commit()
            with patch.object(models, "MAX_OPENCODE_MESSAGE_BYTES", 512):
                events, error = models.opencode_events(home, lambda _cwd: "work", self.start, AT, env={})
                self.assertEqual(error, "MalformedUsage")
                self.assertEqual(len(events), 2)
                with patch.object(models, "MAX_OPENCODE_ROWS", 3):
                    limited, error = models.opencode_events(home, lambda _cwd: "work", self.start, AT, env={})
                    self.assertEqual(error, "ReadLimit")
                    self.assertEqual(limited, events[:1])

    def test_completed_assistant_rows_without_tokens_do_not_mark_malformed(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            db = self.database(home / ".local/share/opencode/opencode.db", legacy=False)
            db.executemany("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)", [
                ("error-no-tokens", "test", "assistant", self.start_ms + 2,
                 json.dumps({"time": {"created": self.start_ms, "completed": self.start_ms + 2}, "finish": "error", "error": {"name": "APIError"}})),
                ("completed-no-tokens", "test", "assistant", self.start_ms + 2,
                 json.dumps({"time": {"created": self.start_ms, "completed": self.start_ms + 2}, "model": {"id": "gemini-4-hydrogen"}})),
                ("good", "test", "assistant", self.start_ms + 1, self.payload(self.start_ms + 1)),
            ])
            db.commit()
            events, error = models.opencode_events(home, lambda _cwd: "personal", self.start, AT, env={})
            self.assertIsNone(error)
            self.assertEqual(len(events), 1)

            db.execute("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)",
                       ("bad-tokens", "test", "assistant", self.start_ms + 3,
                        json.dumps({"time": {"created": self.start_ms, "completed": self.start_ms + 3}, "tokens": "corrupt"})))
            db.commit()
            events, error = models.opencode_events(home, lambda _cwd: "personal", self.start, AT, env={})
            self.assertEqual(error, "MalformedUsage")
            self.assertEqual(len(events), 1)


class AgyEventsTests(unittest.TestCase):
    start = dt.datetime.fromisoformat("2026-11-18T16:00:00+00:00")
    sid_meta = "434a295d-b277-43f9-942c-8899d25c25c8"
    sid_db = "9ece8e24-0fda-4418-a0e2-1039aff8cbd5"

    def write_transcript(self, home, sid, lines, *, name="transcript.jsonl"):
        logs_dir = home / ".gemini/antigravity-cli/brain" / sid / ".system_generated/logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        path = logs_dir / name
        path.write_text("\n".join(line if isinstance(line, str) else json.dumps(line) for line in lines) + "\n")
        return path

    def test_transcript_normalization_dedup_and_workspace_classification(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            agy_home = home / ".gemini/antigravity-cli"
            (agy_home / "cache").mkdir(parents=True, exist_ok=True)
            (agy_home / "cache/conversation_metadata.json").write_text(json.dumps({
                "conversations": {
                    self.sid_meta: {"summary": {"WorkspaceURIs": ["file:///fixture/personal"]}},
                }
            }))
            db = sqlite3.connect(agy_home / "conversation_summaries.db")
            self.addCleanup(db.close)
            db.execute("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)")
            db.execute("INSERT INTO conversation_summaries VALUES (?, ?)",
                       (self.sid_db, json.dumps(["file:///fixture/work"])))
            db.commit()

            t_before = "2026-11-18T15:59:59Z"
            t_in = "2026-11-18T16:00:00Z"
            t_in2 = "2026-11-18T16:00:30Z"
            t_end = AT.isoformat().replace("+00:00", "Z")
            rows_meta = [
                {"step_index": 0, "type": "USER_INPUT", "created_at": t_in, "content": "Synthetic prompt"},
                {"step_index": 1, "type": "PLANNER_RESPONSE", "created_at": t_before, "model": "gemini-4-neon-high",
                 "input_tokens": 5, "output_tokens": 1, "cache_read_tokens": 0},
                {"step_index": 2, "type": "PLANNER_RESPONSE", "created_at": t_in, "model": "gemini-4-neon-high",
                 "input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 50},
                {"step_index": 3, "type": "PLANNER_RESPONSE", "created_at": t_in2, "model": "gemini-4-neon-medium",
                 "input_tokens": 30, "output_tokens": 10, "cache_read_tokens": None},
                {"step_index": 4, "type": "PLANNER_RESPONSE", "created_at": t_in2, "model": "gemini-4-neon-low",
                 "input_tokens": None, "output_tokens": None, "cache_read_tokens": None},
                {"step_index": 5, "type": "PLANNER_RESPONSE", "created_at": t_end, "model": "gemini-4-neon-high",
                 "input_tokens": 999, "output_tokens": 1, "cache_read_tokens": 0},
            ]
            self.write_transcript(home, self.sid_meta, rows_meta)
            # transcript_full.jsonl must never double-count turns already in transcript.jsonl.
            self.write_transcript(home, self.sid_meta, rows_meta, name="transcript_full.jsonl")
            self.write_transcript(home, self.sid_db, [
                {"step_index": 1, "type": "PLANNER_RESPONSE", "created_at": t_in,
                 "model": "MODEL_GOOGLE_GEMINI_INTERNAL_BYOM", "input_tokens": 40, "output_tokens": 5, "cache_read_tokens": 10},
                {"step_index": 2, "type": "PLANNER_RESPONSE", "created_at": t_in2,
                 "model": "gemini-4-carbon-xhigh", "input_tokens": 15, "output_tokens": 3, "cache_read_tokens": 2},
            ])

            classify = {"/fixture/personal": "personal", "/fixture/work": "work"}.get
            events, error = models.agy_events(home, classify, self.start, AT)
            self.assertIsNone(error)
            self.assertEqual(len(events), 4)
            by_key = {event["key"]: event for event in events}
            self.assertEqual(by_key[hashlib.sha256(f"agy\0{self.sid_meta}\0step:2".encode()).hexdigest()], {
                "key": hashlib.sha256(f"agy\0{self.sid_meta}\0step:2".encode()).hexdigest(),
                "at": "2026-11-18T16:00:00Z", "provider": "agy", "category": "personal",
                "model": "gemini-4-neon", "input": 100, "output": 20, "cacheRead": 50,
                "cacheWrite": 0, "reasoning": 0,
            })
            self.assertEqual(by_key[hashlib.sha256(f"agy\0{self.sid_db}\0step:1".encode()).hexdigest()]["model"], "unknown")
            self.assertEqual(by_key[hashlib.sha256(f"agy\0{self.sid_db}\0step:1".encode()).hexdigest()]["category"], "work")
            self.assertEqual(by_key[hashlib.sha256(f"agy\0{self.sid_db}\0step:2".encode()).hexdigest()]["model"], "gemini-4-carbon")

            snap = snapshot([daily(TODAY, input=185, output=38, cache=62)])
            projected = models.daily_models(collector_fixture(), [{"tokens": events}], snap)
            self.assertEqual(projected[TODAY], [
                {"provider": "agy", "model": "gemini-4-neon", "input": 130, "output": 30, "cacheRead": 50},
                {"provider": "agy", "model": "gemini-4-carbon", "input": 15, "output": 3, "cacheRead": 2},
            ])
            self.assertNotIn("Synthetic prompt", json.dumps(events))

    def test_missing_symlinks_and_malformed_lines(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self.assertEqual(models.agy_events(home, lambda _cwd: "unclassified", self.start, AT), ([], None))
            self.write_transcript(home, self.sid_meta, [
                "{bad json",
                {"step_index": 1, "type": "PLANNER_RESPONSE", "created_at": "2026-11-18T16:00:00Z",
                 "model": "gemini-4-neon-high", "input_tokens": 12, "output_tokens": 4, "cache_read_tokens": 0},
            ])
            events, error = models.agy_events(home, lambda _cwd: "unclassified", self.start, AT)
            self.assertEqual(error, "MalformedUsage")
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["model"], "gemini-4-neon")

            bad_home = Path(temporary) / "symlinked"
            (bad_home / ".gemini/antigravity-cli").mkdir(parents=True)
            os.symlink(home / ".gemini/antigravity-cli/brain", bad_home / ".gemini/antigravity-cli/brain")
            self.assertEqual(models.agy_events(bad_home, lambda _cwd: "unclassified", self.start, AT), ([], "InvalidLogPath"))


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

    def test_real_collector_end_to_end_agent_attribution_preserves_collector_totals(self):
        collector_path = Path(os.environ["OMB_ACTIVITY_COLLECTOR_FIXTURE"])
        sid_root = "11111111-1111-4111-8111-111111111111"
        sid_child = "33333333-3333-4333-8333-333333333333"
        workspaces = [{"workspace_id": "w6", "label": "MausBot"}]
        runner = _herdr_payload(workspaces, [_agent_row("w6:p1", "w6", "mausbot-back", session_id=sid_root)], generation="gen-real")

        def write_rollout(home, sid, events, *, forked_from=None):
            directory = Path(home) / ".codex" / "sessions" / "2026" / "11" / "19"
            directory.mkdir(parents=True, exist_ok=True)
            payload = {"id": sid, "cwd": str(home)}
            if forked_from:
                payload["forked_from_id"] = forked_from
            lines = [
                json.dumps({"type": "session_meta", "payload": payload}),
                json.dumps({"type": "turn_context", "payload": {"cwd": str(home), "model": "gpt-6.2-sol"}}),
            ]
            cum_in = cum_out = cum_cache = 0
            for stamp_at, inp, out, cache in events:
                cum_in += inp + cache
                cum_out += out
                cum_cache += cache
                lines.append(json.dumps({
                    "type": "event_msg",
                    "timestamp": stamp_at,
                    "payload": {
                        "type": "token_count",
                        "info": {"total_token_usage": {
                            "input_tokens": cum_in,
                            "cached_input_tokens": cum_cache,
                            "cache_write_input_tokens": 0,
                            "output_tokens": cum_out,
                            "reasoning_output_tokens": 0,
                        }},
                    },
                }))
            (directory / f"rollout-2026-11-19-{sid}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")

        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "home"
            storage = Path(root) / "storage"
            baseline_storage = Path(root) / "baseline"
            home.mkdir()
            write_rollout(home, sid_root, [
                ("2026-11-19T00:50:00Z", 10, 5, 5),
                ("2026-11-19T01:02:00Z", 25, 10, 5),
            ])
            write_rollout(home, sid_child, [
                ("2026-11-19T01:03:00Z", 15, 5, 5),
            ], forked_from=sid_root)

            base_config = {
                "azureCli": "/fixture/az",
                "authorEmails": ["owner@example.test"],
                "home": str(home),
                "repoRoots": [],
                "machines": [{"id": "mini-2", "mode": "local"}],
                "githubProfiles": [],
                "adoRemotes": [],
            }
            t0 = dt.datetime.fromisoformat("2026-11-19T01:00:00+00:00")
            t1 = dt.datetime.fromisoformat("2026-11-19T01:05:00+00:00")
            t_gap = dt.datetime.fromisoformat("2026-11-19T04:05:05+00:00")

            def run_usage(now_dt, *, herdr_fn):
                collector = usage.load_collector(collector_path)
                cfg = {**base_config, "storageDir": str(storage)}
                with patch.object(usage, "load_collector", return_value=collector), \
                     patch.object(collector, "now", return_value=now_dt), \
                     patch.object(collector, "ado_prs", return_value=[]), \
                     patch.object(collector, "github_prs", return_value=[]), \
                     contextlib.redirect_stdout(io.StringIO()):
                    usage.refresh(collector_path, cfg, storage, legacy_diagnostics=False, herdr_runner=herdr_fn)
                return json.loads((storage / "latest.json").read_text(encoding="utf-8"))

            run_usage(t0, herdr_fn=runner)
            res_t1 = run_usage(t1, herdr_fn=runner)
            # Add a new event inside the 3-hour gap before running at t_gap; it must remain unattributed.
            write_rollout(home, sid_root, [
                ("2026-11-19T00:50:00Z", 10, 5, 5),
                ("2026-11-19T01:02:00Z", 25, 10, 5),
                ("2026-11-19T02:30:00Z", 30, 10, 10),
            ])
            res_gap = run_usage(t_gap, herdr_fn=runner)

            # Baseline run directly with the real collector at t_gap must match today/totals/daily identically.
            baseline_collector = usage.load_collector(collector_path)
            baseline_cfg = {**base_config, "storageDir": str(baseline_storage)}
            with patch.object(baseline_collector, "now", return_value=t_gap), \
                 patch.object(baseline_collector, "ado_prs", return_value=[]), \
                 patch.object(baseline_collector, "github_prs", return_value=[]), \
                 contextlib.redirect_stdout(io.StringIO()):
                baseline_collector.refresh(baseline_cfg, history_days=59)
            baseline = json.loads((baseline_storage / "latest.json").read_text(encoding="utf-8"))

            self.assertEqual(res_gap["today"], baseline["today"])
            self.assertEqual(res_gap["totals"], baseline["totals"])
            self.assertEqual(res_gap["daily"], baseline["daily"])
            self.assertEqual(res_t1["trendHistory"]["daily"][-1]["totalTokens"], 85)
            self.assertEqual(res_t1["trendHistory"]["daily"][-1]["agentTokens"], [{
                "id": "w6:p1", "name": "mausbot-back", "teamId": "w6", "teamName": "MausBot", "totalTokens": 65,
            }])
            # After the 3h gap, totalTokens increases by 50 (85 -> 135) while attributed agentTokens stays 65.
            self.assertEqual(res_gap["trendHistory"]["daily"][-1]["totalTokens"], 135)
            self.assertEqual(res_gap["trendHistory"]["daily"][-1]["agentTokens"], [{
                "id": "w6:p1", "name": "mausbot-back", "teamId": "w6", "teamName": "MausBot", "totalTokens": 65,
            }])
            continuity_file = storage / "agent-continuity.json"
            self.assertEqual(continuity_file.stat().st_mode & 0o777, 0o600)
            continuity = json.loads(continuity_file.read_text(encoding="utf-8"))
            self.assertTrue(continuity["healthy"])
            self.assertEqual(continuity["generation"], "gen-real")

            # Broken Herdr runner must never fail refresh or change collector totals; only degrades Agents.
            def broken_herdr(_args):
                raise RuntimeError("herdr down")

            with contextlib.redirect_stderr(io.StringIO()):
                res_broken = run_usage(t_gap + dt.timedelta(seconds=300), herdr_fn=broken_herdr)
            self.assertEqual(res_broken["today"], baseline["today"])
            self.assertEqual(res_broken["trendHistory"]["daily"][-1]["agentTokens"], [{
                "id": "w6:p1", "name": "mausbot-back", "teamId": "w6", "teamName": "MausBot", "totalTokens": 65,
            }])
            broken_continuity = json.loads(continuity_file.read_text(encoding="utf-8"))
            self.assertFalse(broken_continuity["healthy"])
            self.assertEqual(broken_continuity["active"], {})

    def test_real_non_reuse_worker_survives_malformed_codex_first_and_mid_lines(self):
        collector_path = Path(os.environ["OMB_ACTIVITY_COLLECTOR_FIXTURE"])
        sid_root = "11111111-1111-4111-8111-111111111111"
        workspaces = [{"workspace_id": "w6", "label": "MausBot"}]
        runner = _herdr_payload(workspaces, [_agent_row("w6:p1", "w6", "mausbot-back", session_id=sid_root)], generation="gen-worker")

        def token_line(stamp_at):
            return json.dumps({
                "type": "event_msg",
                "timestamp": stamp_at,
                "payload": {
                    "type": "token_count",
                    "info": {"total_token_usage": {
                        "input_tokens": 10,
                        "cached_input_tokens": 3,
                        "cache_write_input_tokens": 0,
                        "output_tokens": 2,
                        "reasoning_output_tokens": 0,
                    }},
                },
            })

        def run_non_reuse(home, storage, now_dt):
            collector = usage.load_collector(collector_path)
            cfg = {
                "azureCli": "/fixture/az",
                "authorEmails": ["owner@example.test"],
                "home": str(home),
                "repoRoots": [],
                "machines": [{"id": "mini-2", "mode": "local"}],
                "githubProfiles": [],
                "adoRemotes": [],
                "storageDir": str(storage),
            }
            with patch.object(usage, "load_collector", return_value=collector), \
                 patch.object(collector, "now", return_value=now_dt), \
                 patch.object(collector, "ado_prs", return_value=[]), \
                 patch.object(collector, "github_prs", return_value=[]), \
                 contextlib.redirect_stdout(io.StringIO()):
                usage.refresh(collector_path, cfg, storage, reuse_sources=False, legacy_diagnostics=False, herdr_runner=runner)
            latest = json.loads((storage / "latest.json").read_text(encoding="utf-8"))
            retained = json.loads((storage / "token-history.json").read_text(encoding="utf-8"))
            return latest, retained

        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "home"
            storage = Path(root) / "storage"
            codex_dir = home / ".codex" / "sessions" / "2026" / "11" / "19"
            codex_dir.mkdir(parents=True, exist_ok=True)
            rollout = codex_dir / f"rollout-2026-11-19-{sid_root}.jsonl"
            rollout.write_text("\n".join([
                json.dumps({"type": "session_meta", "payload": {"id": sid_root, "cwd": str(home)}}),
                json.dumps({"type": "turn_context", "payload": {"cwd": str(home), "model": "gpt-6.2-sol"}}),
                token_line("2026-11-19T01:02:00Z"),
            ]) + "\n", encoding="utf-8")

            t0 = dt.datetime.fromisoformat("2026-11-19T01:00:00+00:00")
            t1 = dt.datetime.fromisoformat("2026-11-19T01:05:00+00:00")
            t2 = dt.datetime.fromisoformat("2026-11-19T01:10:00+00:00")

            run_non_reuse(home, storage, t0)
            latest1, retained1 = run_non_reuse(home, storage, t1)
            self.assertNotEqual(latest1["today"]["tokenStatus"], "unavailable")
            self.assertEqual(latest1["today"]["categories"]["unclassified"]["totalTokens"], 12)
            self.assertEqual(retained1["trendHistory"]["daily"][-1]["totalTokens"], 12)

            # Append JSON array, scalar, and non-object payload/info lines to the same rollout,
            # plus first-line malformed Codex files in the same home.
            with rollout.open("a", encoding="utf-8") as stream:
                stream.write("\n".join([
                    '["token_count"]',
                    '123',
                    '"\\"token_count\\""',
                    json.dumps({"type": "event_msg", "payload": ["not-a-dict"]}),
                    json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": ["not-a-dict"]}}),
                    json.dumps({"type": "turn_context", "payload": 42}),
                ]) + "\n")
            (codex_dir / "rollout-first-array.jsonl").write_text('["token_count"]\n', encoding="utf-8")
            (codex_dir / "rollout-first-scalar.jsonl").write_text("123\n", encoding="utf-8")
            (codex_dir / "rollout-first-nonobj-payload.jsonl").write_text(
                json.dumps({"type": "session_meta", "payload": ["not-a-dict"]}) + "\n",
                encoding="utf-8",
            )

            latest2, retained2 = run_non_reuse(home, storage, t2)
            self.assertEqual(latest2["today"], latest1["today"])
            self.assertEqual(latest2["trendHistory"]["daily"][-1]["totalTokens"], 12)
            self.assertEqual(latest2["trendHistory"]["daily"][-1]["agentTokens"], [{
                "id": "w6:p1", "name": "mausbot-back", "teamId": "w6", "teamName": "MausBot", "totalTokens": 12,
            }])
            self.assertEqual(retained2["trendHistory"]["daily"][-1]["tokenStatus"], retained1["trendHistory"]["daily"][-1]["tokenStatus"])
            self.assertEqual(retained2["trendHistory"]["daily"][-1]["totalTokens"], 12)
            self.assertEqual(retained2["trendHistory"]["daily"][-1]["agentTokens"], [{
                "id": "w6:p1", "name": "mausbot-back", "teamId": "w6", "teamName": "MausBot", "totalTokens": 12,
            }])

            # First-line malformed session_meta payload in the token-bearing file itself still keeps daily total 12
            # and degrades only agent attribution for that file.
            bad_header_home = Path(root) / "bad_header_home"
            bad_header_storage = Path(root) / "bad_header_storage"
            bad_dir = bad_header_home / ".codex" / "sessions" / "2026" / "11" / "19"
            bad_dir.mkdir(parents=True, exist_ok=True)
            (bad_dir / f"rollout-2026-11-19-{sid_root}.jsonl").write_text("\n".join([
                json.dumps({"type": "session_meta", "payload": ["not-a-dict"]}),
                json.dumps({"type": "turn_context", "payload": {"cwd": str(bad_header_home), "model": "gpt-6.2-sol"}}),
                token_line("2026-11-19T01:02:00Z"),
            ]) + "\n", encoding="utf-8")

            run_non_reuse(bad_header_home, bad_header_storage, t0)
            bad_latest, bad_retained = run_non_reuse(bad_header_home, bad_header_storage, t1)
            self.assertNotEqual(bad_latest["today"]["tokenStatus"], "unavailable")
            self.assertEqual(bad_latest["today"]["categories"]["unclassified"]["totalTokens"], 12)
            self.assertEqual(bad_latest["trendHistory"]["daily"][-1]["totalTokens"], 12)
            self.assertNotIn("agentTokens", bad_latest["trendHistory"]["daily"][-1])
            self.assertEqual(bad_retained["trendHistory"]["daily"][-1]["totalTokens"], 12)
            self.assertNotIn("agentTokens", bad_retained["trendHistory"]["daily"][-1])


def _digest(*values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _stamp(value):
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _codex_events_fixture(lines, classify, start, end, parents=None):
    session = ""
    cwd = None
    model = "unknown"
    previous = None
    for line in lines:
        if not any(x in line[:1024] for x in ('"session_meta"', '"turn_context"', '"token_count"')):
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        payload = event.get("payload") or {}
        if event.get("type") == "session_meta":
            session = payload.get("id", session)
            lineage = parents or {}
            visited = set()
            while session in lineage and session not in visited:
                visited.add(session)
                session = lineage[session]
            cwd = payload.get("cwd", cwd)
        elif event.get("type") == "turn_context":
            cwd, model = payload.get("cwd", cwd), payload.get("model", model)
        elif event.get("type") == "event_msg" and payload.get("type") == "token_count":
            total = (payload.get("info") or {}).get("total_token_usage")
            at = collector_fixture().instant(event.get("timestamp")) if isinstance(event.get("timestamp"), str) else None
            if not isinstance(total, dict) or not at:
                continue
            names = ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens")
            current = {k: total.get(k) if type(total.get(k)) is int and total.get(k) >= 0 else 0 for k in names}
            if current == previous:
                continue
            reset = previous is not None and any(current[k] < previous[k] for k in ("input_tokens", "output_tokens"))
            delta = {k: max(0, current[k] - (0 if previous is None or reset else previous[k])) for k in names}
            previous = current
            if not start <= at < end or not (delta["input_tokens"] or delta["output_tokens"]):
                continue
            cached = min(delta["cached_input_tokens"], delta["input_tokens"])
            yield {
                "key": _digest("codex", session, _stamp(at), current),
                "at": _stamp(at),
                "provider": "codex",
                "model": model,
                "category": classify.classify(cwd),
                "input": delta["input_tokens"] - cached,
                "cacheRead": cached,
                "cacheWrite": min(delta["cache_write_input_tokens"], delta["input_tokens"] - cached),
                "output": delta["output_tokens"],
                "reasoning": min(delta["reasoning_output_tokens"], delta["output_tokens"]),
            }


def _herdr_payload(workspaces, agents, generation=None):
    ws_doc = {"result": {"workspaces": workspaces}}
    ag_doc = {"result": {"agents": agents}}
    if generation is not None:
        ws_doc["server_generation"] = generation
        ag_doc["server_generation"] = generation

    def runner(args):
        if args[-2:] == ["workspace", "list"]:
            return json.dumps(ws_doc)
        if args[-2:] == ["agent", "list"]:
            return json.dumps(ag_doc)
        return ""

    return runner


def _agent_row(pane_id="w6:p1", workspace_id="w6", name="mausbot-back", agent="codex",
               session_id="11111111-1111-4111-8111-111111111111", *, source="herdr:codex",
               kind="id", session_agent="codex", terminal_id="term_1"):
    row = {
        "pane_id": pane_id,
        "workspace_id": workspace_id,
        "name": name,
        "agent": agent,
        "agent_session": None if session_id is None else {
            "agent": session_agent,
            "kind": kind,
            "source": source,
            "value": session_id,
        },
    }
    if terminal_id is not None:
        row["terminal_id"] = terminal_id
    return row


class AgentAttributionTests(unittest.TestCase):
    SID_A = "11111111-1111-4111-8111-111111111111"
    SID_B = "22222222-2222-4222-8222-222222222222"
    SID_CHILD = "33333333-3333-4333-8333-333333333333"
    WORKSPACES = [{"workspace_id": "w6", "label": "MausBot"}, {"workspace_id": "w7", "label": "Other"}]

    def _collector(self):
        base = collector_fixture()
        return types.SimpleNamespace(
            instant=lambda value: dt.datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else None,
            day=base.day,
            count=base.count,
            codex_events=_codex_events_fixture,
        )

    def _write_codex_rollout(self, home, sid, events, *, forked_from=None, extra_lines=(), header_pad=0):
        directory = Path(home) / ".codex" / "sessions" / "2026" / "11" / "19"
        directory.mkdir(parents=True, exist_ok=True)
        payload = {"id": sid, "cwd": "/shared/repo"}
        if forked_from:
            payload["forked_from_id"] = forked_from
        if header_pad:
            payload["base_instructions"] = {"text": "x" * header_pad}
        lines = [
            json.dumps({"type": "session_meta", "payload": payload}),
            json.dumps({"type": "turn_context", "payload": {"cwd": "/shared/repo", "model": "gpt-6.2-sol"}}),
            *extra_lines,
        ]
        cum_in = 0
        cum_out = 0
        cum_cache = 0
        records = []
        for key_at, inp, out, cache in events:
            cum_in += inp + cache
            cum_out += out
            cum_cache += cache
            total_usage = {
                "input_tokens": cum_in,
                "cached_input_tokens": cum_cache,
                "cache_write_input_tokens": 0,
                "output_tokens": cum_out,
                "reasoning_output_tokens": 0,
            }
            lines.append(json.dumps({
                "type": "event_msg",
                "timestamp": key_at,
                "payload": {"type": "token_count", "info": {"total_token_usage": total_usage}},
            }))
            records.append({
                "key": _digest("codex", forked_from or sid, key_at, total_usage),
                "at": key_at,
                "provider": "codex",
                "model": "gpt-6.2-sol",
                "input": inp,
                "output": out,
                "cacheRead": cache,
            })
        path = directory / f"rollout-2026-11-19-{sid}.jsonl"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return records

    def test_sample_herdr_matches_verified_member_rules_and_rejects_ambiguity(self):
        # Rejects unknown:manual, non-id kind, non-UUID, invalid workspace/pane ID, and duplicate names across panes.
        good = _agent_row("w6:p1", "w6", "mausbot-back", session_id=self.SID_A)
        bad_source = _agent_row("w6:p2", "w6", "fake-source", session_id=self.SID_B, source="unknown:manual")
        bad_kind = _agent_row("w6:p3", "w6", "bad-kind", session_id="33333333-3333-4333-8333-333333333333", kind="path")
        bad_pane = _agent_row("w6:badpane", "w6", "bad-pane", session_id="44444444-4444-4444-8444-444444444444")
        bad_uuid = _agent_row("w6:p4", "w6", "bad-uuid", session_id="not-a-uuid")
        sample = models.sample_herdr(
            at="2026-11-19T01:00:00Z",
            herdr_runner=_herdr_payload(self.WORKSPACES, [good, bad_source, bad_kind, bad_pane, bad_uuid]),
        )
        self.assertEqual(list(sample["panes"].keys()), ["w6:p1"])
        self.assertEqual(sample["panes"]["w6:p1"]["name"], "mausbot-back")

        # Same member name on two different panes (even across different workspaces or agents) drops ambiguity.
        dup_a = _agent_row("w6:p1", "w6", "shared-name", session_id=self.SID_A)
        dup_b = _agent_row("w7:p1", "w7", "shared-name", agent="opencode", session_id=None)
        dup_sample = models.sample_herdr(
            at="2026-11-19T01:00:00Z",
            herdr_runner=_herdr_payload(self.WORKSPACES, [dup_a, dup_b]),
        )
        self.assertEqual(dup_sample["panes"], {})

        # Conflicting session claim across two panes drops both.
        claim_a = _agent_row("w6:p1", "w6", "alice", session_id=self.SID_A)
        claim_b = _agent_row("w6:p2", "w6", "bob", session_id=self.SID_A)
        conflict_sample = models.sample_herdr(
            at="2026-11-19T01:00:00Z",
            herdr_runner=_herdr_payload(self.WORKSPACES, [claim_a, claim_b]),
        )
        self.assertEqual(conflict_sample["panes"], {})
        self.assertIn(self.SID_A, conflict_sample["conflictedSessions"])

    def test_continuity_adjacent_cadence_vs_three_hour_gap_missed_round_and_generation_change(self):
        runner = _herdr_payload(self.WORKSPACES, [_agent_row("w6:p1", "w6", "mausbot-back", session_id=self.SID_A)], generation="gen-1")
        t0 = "2026-11-19T01:00:00Z"
        t0_end = "2026-11-19T01:00:05Z"
        s0_pre = models.sample_herdr(at=t0, herdr_runner=runner)
        s0_post = models.sample_herdr(at=t0_end, herdr_runner=runner)
        state1, iv1 = models.reconcile_continuity(None, s0_pre, s0_post, now=t0_end)
        self.assertTrue(state1["healthy"])
        self.assertEqual(len(iv1), 1)
        self.assertEqual(iv1[0]["startAt"], models._utc_instant(t0))
        self.assertEqual(iv1[0]["endAt"], models._utc_instant(t0_end))

        # Adjacent normal writer cadence (+300s from prior lastSampleAt) extends continuity seamlessly.
        t1_pre = "2026-11-19T01:05:05Z"
        t1_post = "2026-11-19T01:05:10Z"
        state2, iv2 = models.reconcile_continuity(
            state1,
            models.sample_herdr(at=t1_pre, herdr_runner=runner),
            models.sample_herdr(at=t1_post, herdr_runner=runner),
            now=t1_post,
        )
        self.assertEqual(iv2[0]["startAt"], models._utc_instant(t0))
        self.assertEqual(iv2[0]["endAt"], models._utc_instant(t1_post))

        # 3-hour gap (10805s) between identical endpoints MUST NOT bridge [01:05:10Z, 04:05:15Z].
        t_3h_pre = "2026-11-19T04:05:15Z"
        t_3h_post = "2026-11-19T04:05:20Z"
        state_3h, iv_3h = models.reconcile_continuity(
            state2,
            models.sample_herdr(at=t_3h_pre, herdr_runner=runner),
            models.sample_herdr(at=t_3h_post, herdr_runner=runner),
            now=t_3h_post,
        )
        gap_event = models._utc_instant("2026-11-19T02:30:00Z")
        self.assertFalse(any(iv["startAt"] <= gap_event <= iv["endAt"] for iv in iv_3h))
        # Closed prior [01:00:00Z, 01:05:10Z] remains valid; new active starts at 04:05:15Z.
        self.assertEqual(state_3h["active"]["w6:p1"]["observedSince"], t_3h_pre)

        # Missed round (605s > 450s) breaks continuity.
        t_miss_pre = "2026-11-19T01:15:15Z"
        t_miss_post = "2026-11-19T01:15:20Z"
        _, iv_miss = models.reconcile_continuity(
            state2,
            models.sample_herdr(at=t_miss_pre, herdr_runner=runner),
            models.sample_herdr(at=t_miss_post, herdr_runner=runner),
            now=t_miss_post,
        )
        miss_event = models._utc_instant("2026-11-19T01:10:00Z")
        self.assertFalse(any(iv["startAt"] <= miss_event <= iv["endAt"] for iv in iv_miss))

        # Server generation change at normal +300s cadence breaks continuity.
        runner_gen2 = _herdr_payload(self.WORKSPACES, [_agent_row("w6:p1", "w6", "mausbot-back", session_id=self.SID_A)], generation="gen-2")
        _, iv_gen = models.reconcile_continuity(
            state2,
            models.sample_herdr(at=t1_post, herdr_runner=runner_gen2) if False else models.sample_herdr(at="2026-11-19T01:10:00Z", herdr_runner=runner_gen2),
            models.sample_herdr(at="2026-11-19T01:10:05Z", herdr_runner=runner_gen2),
            now="2026-11-19T01:10:05Z",
        )
        gen_event = models._utc_instant("2026-11-19T01:07:30Z")
        self.assertFalse(any(iv["startAt"] <= gen_event <= iv["endAt"] for iv in iv_gen))

        # Exceeded single-round span (> 450s) invalidates the round.
        state_span, iv_span = models.reconcile_continuity(
            state2,
            models.sample_herdr(at="2026-11-19T01:10:00Z", herdr_runner=runner),
            models.sample_herdr(at="2026-11-19T01:19:00Z", herdr_runner=runner),
            now="2026-11-19T01:19:00Z",
        )
        self.assertFalse(state_span["healthy"])
        self.assertEqual(state_span["active"], {})
        span_event = models._utc_instant("2026-11-19T01:15:00Z")
        self.assertFalse(any(iv["startAt"] <= span_event <= iv["endAt"] for iv in iv_span))

        # Production path (herdr_runner=None): stable herdr.sock identity bridges normal cadence;
        # unverifiable generation (missing herdr.sock / generation=None) across consecutive rounds
        # preserves only previously proved intervals and sends new growth to Unattributed.
        prod_runner = _herdr_payload(self.WORKSPACES, [_agent_row("w6:p1", "w6", "mausbot-back", session_id=self.SID_A)])
        with tempfile.TemporaryDirectory() as sock_home:
            sock_dir = Path(sock_home) / ".config" / "herdr"
            sock_dir.mkdir(parents=True, exist_ok=True)
            sock_path = sock_dir / "herdr.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv, \
                 patch.object(models, "_run_herdr", side_effect=lambda _h, args, _r=None: prod_runner(args)):
                srv.bind(str(sock_path))
                cfg_sock = {"home": sock_home}
                sp0_pre = models.sample_herdr(cfg_sock, at=t0)
                sp0_post = models.sample_herdr(cfg_sock, at=t0_end)
                self.assertTrue(sp0_pre["generation"].startswith("sock:"))
                st_sock1, _ = models.reconcile_continuity(None, sp0_pre, sp0_post, now=t0_end)
                st_sock2, iv_sock2 = models.reconcile_continuity(
                    st_sock1,
                    models.sample_herdr(cfg_sock, at=t1_pre),
                    models.sample_herdr(cfg_sock, at=t1_post),
                    now=t1_post,
                )
                self.assertTrue(st_sock2["healthy"])
                self.assertEqual(iv_sock2[0]["startAt"], models._utc_instant(t0))
                self.assertEqual(iv_sock2[0]["endAt"], models._utc_instant(t1_post))

                sock_path.unlink()
                u1_pre = models.sample_herdr(cfg_sock, at="2026-11-19T01:10:00Z")
                u1_post = models.sample_herdr(cfg_sock, at="2026-11-19T01:10:05Z")
                self.assertIsNone(u1_pre["generation"])
                st_unk1, iv_unk1 = models.reconcile_continuity(
                    st_sock2, u1_pre, u1_post, now="2026-11-19T01:10:05Z"
                )
                self.assertFalse(st_unk1["healthy"])
                self.assertEqual(st_unk1["active"], {})
                self.assertEqual(len(iv_unk1), 1)
                self.assertEqual(iv_unk1[0]["endAt"], models._utc_instant(t1_post))

                u2_pre = models.sample_herdr(cfg_sock, at="2026-11-19T01:15:05Z")
                u2_post = models.sample_herdr(cfg_sock, at="2026-11-19T01:15:10Z")
                st_unk2, iv_unk2 = models.reconcile_continuity(
                    st_unk1, u2_pre, u2_post, now="2026-11-19T01:15:10Z"
                )
                self.assertFalse(st_unk2["healthy"])
                self.assertEqual(st_unk2["active"], {})
                self.assertEqual(len(iv_unk2), 1)
                self.assertEqual(iv_unk2[0]["endAt"], models._utc_instant(t1_post))
                unk_event = models._utc_instant("2026-11-19T01:12:00Z")
                self.assertFalse(any(iv["startAt"] <= unk_event <= iv["endAt"] for iv in iv_unk2))

    def test_mixed_generation_and_socket_pre_post_atomicity(self):
        agents = [_agent_row("w6:p1", "w6", "mausbot-back", session_id=self.SID_A)]
        ws_json = json.dumps({"result": {"workspaces": self.WORKSPACES}})
        ag_json = json.dumps({"result": {"agents": agents}})

        def make_doc(key_ws, gen_ws, key_ag, gen_ag):
            ws_obj = {"result": {"workspaces": self.WORKSPACES}}
            ag_obj = {"result": {"agents": agents}}
            if key_ws:
                ws_obj["server_generation"] = gen_ws
            if key_ag:
                ag_obj["server_generation"] = gen_ag
            return lambda args: json.dumps(ws_obj if args[-2] == "workspace" else ag_obj)

        # 1. Mixed workspace.list vs agent.list server_generation MUST be rejected.
        mixed_cases = [
            make_doc(True, "gen-1", True, "gen-2"),
            make_doc(True, "gen-1", False, None),
            make_doc(False, None, True, "gen-2"),
            make_doc(True, "gen-1", True, ""),
            make_doc(True, "gen-1", True, 123),
        ]
        good_runner = _herdr_payload(self.WORKSPACES, agents, generation="gen-1")
        t0 = "2026-11-19T01:00:00Z"
        t0_end = "2026-11-19T01:00:05Z"
        st_good, _ = models.reconcile_continuity(
            None,
            models.sample_herdr(at=t0, herdr_runner=good_runner),
            models.sample_herdr(at=t0_end, herdr_runner=good_runner),
            now=t0_end,
        )
        self.assertTrue(st_good["healthy"])

        for bad_runner in mixed_cases:
            self.assertIsNone(models.sample_herdr(at="2026-11-19T01:05:05Z", herdr_runner=bad_runner))
            st_bad, iv_bad = models.reconcile_continuity(
                st_good,
                models.sample_herdr(at="2026-11-19T01:05:05Z", herdr_runner=bad_runner),
                models.sample_herdr(at="2026-11-19T01:05:10Z", herdr_runner=good_runner),
                now="2026-11-19T01:05:10Z",
            )
            self.assertFalse(st_bad["healthy"])
            self.assertEqual(st_bad["active"], {})
            self.assertEqual(len(iv_bad), 1)
            self.assertEqual(iv_bad[0]["endAt"], models._utc_instant(t0_end))

        # 2. Native Unix socket pre/post atomicity with real AF_UNIX socket mutations.
        with tempfile.TemporaryDirectory() as sock_home:
            sock_dir = Path(sock_home) / ".config" / "herdr"
            sock_dir.mkdir(parents=True, exist_ok=True)
            sock_path = sock_dir / "herdr.sock"
            cfg_sock = {"home": sock_home}

            def run_with_hook(hook, *, with_gen=False, at="2026-11-19T01:05:05Z"):
                def side_effect(_h, args, _r=None):
                    if args[-2] == "agent" and hook is not None:
                        hook()
                    if with_gen:
                        payload = make_doc(True, "gen-1", True, "gen-1")(args)
                        return payload
                    return ws_json if args[-2] == "workspace" else ag_json

                with patch.object(models, "_run_herdr", side_effect=side_effect):
                    return models.sample_herdr(cfg_sock, at=at)

            def establish_baseline():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv, \
                     patch.object(models, "_run_herdr", side_effect=lambda _h, args, _r=None: ws_json if args[-2] == "workspace" else ag_json):
                    srv.bind(str(sock_path))
                    sp_pre = models.sample_herdr(cfg_sock, at=t0)
                    sp_post = models.sample_herdr(cfg_sock, at=t0_end)
                    st, _ = models.reconcile_continuity(None, sp_pre, sp_post, now=t0_end)
                    self.assertTrue(st["healthy"])
                    return st, srv

            # 2a. Mid-query restart/rebind (unlink + bind new AF_UNIX socket between workspace.list and agent.list).
            srv1 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv2 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                srv1.bind(str(sock_path))
                with patch.object(models, "_run_herdr", side_effect=lambda _h, args, _r=None: ws_json if args[-2] == "workspace" else ag_json):
                    st_base, _ = models.reconcile_continuity(
                        None,
                        models.sample_herdr(cfg_sock, at=t0),
                        models.sample_herdr(cfg_sock, at=t0_end),
                        now=t0_end,
                    )
                self.assertTrue(st_base["healthy"])

                def rebind_hook():
                    sock_path.unlink()
                    srv2.bind(str(sock_path))

                rebound_sample = run_with_hook(rebind_hook)
                self.assertIsNone(rebound_sample)
                # Even when both queries report matching server_generation, mid-query socket rebind is rejected.
                if sock_path.exists():
                    sock_path.unlink()
                srv3 = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    srv3.bind(str(sock_path))
                    def rebind_with_gen_hook():
                        sock_path.unlink()
                        srv3.close()
                        rebound_srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        rebound_srv.bind(str(sock_path))
                        self._extra_sockets = getattr(self, "_extra_sockets", [])
                        self._extra_sockets.append(rebound_srv)
                    self.assertIsNone(run_with_hook(rebind_with_gen_hook, with_gen=True))
                finally:
                    for extra in getattr(self, "_extra_sockets", []):
                        extra.close()
                    self._extra_sockets = []
                    srv3.close()
            finally:
                srv1.close()
                srv2.close()
                if sock_path.exists():
                    sock_path.unlink()

            # 2b. Mid-query rename (updates ctime_ns / identity between workspace.list and agent.list).
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv:
                srv.bind(str(sock_path))
                with patch.object(models, "_run_herdr", side_effect=lambda _h, args, _r=None: ws_json if args[-2] == "workspace" else ag_json):
                    st_ren_base, _ = models.reconcile_continuity(
                        None,
                        models.sample_herdr(cfg_sock, at=t0),
                        models.sample_herdr(cfg_sock, at=t0_end),
                        now=t0_end,
                    )
                backup = sock_dir / "herdr.sock.bak"

                def rename_hook():
                    os.rename(sock_path, backup)
                    os.rename(backup, sock_path)

                renamed_sample = run_with_hook(rename_hook)
                self.assertIsNone(renamed_sample)
                st_ren, iv_ren = models.reconcile_continuity(
                    st_ren_base,
                    renamed_sample,
                    models.sample_herdr(cfg_sock, at="2026-11-19T01:05:10Z") if False else None,
                    now="2026-11-19T01:05:10Z",
                )
                self.assertFalse(st_ren["healthy"])
                self.assertEqual(len(iv_ren), 1)
                self.assertEqual(iv_ren[0]["endAt"], models._utc_instant(t0_end))
                if sock_path.exists():
                    sock_path.unlink()

            # 2c. Mid-query unavailable (socket unlinked between workspace.list and agent.list).
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv:
                srv.bind(str(sock_path))
                with patch.object(models, "_run_herdr", side_effect=lambda _h, args, _r=None: ws_json if args[-2] == "workspace" else ag_json):
                    st_unavail_base, _ = models.reconcile_continuity(
                        None,
                        models.sample_herdr(cfg_sock, at=t0),
                        models.sample_herdr(cfg_sock, at=t0_end),
                        now=t0_end,
                    )
                unavail_sample = run_with_hook(lambda: sock_path.unlink())
                self.assertIsNone(unavail_sample)
                st_unavail, iv_unavail = models.reconcile_continuity(
                    st_unavail_base, unavail_sample, None, now="2026-11-19T01:05:10Z"
                )
                self.assertFalse(st_unavail["healthy"])
                self.assertEqual(len(iv_unavail), 1)
                self.assertEqual(iv_unavail[0]["endAt"], models._utc_instant(t0_end))

            # 2d. Mid-query appear (missing before workspace.list, bound before agent.list finishes).
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv:
                appear_sample = run_with_hook(lambda: srv.bind(str(sock_path)))
                self.assertIsNone(appear_sample)
                if sock_path.exists():
                    sock_path.unlink()

            # 2e. Cross-round socket rebind even with identical server_generation ("gen-1") breaks continuity.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv_a:
                srv_a.bind(str(sock_path))
                pre_a = run_with_hook(None, with_gen=True, at=t0)
                post_a = run_with_hook(None, with_gen=True, at=t0_end)
                self.assertIsNotNone(pre_a["generation"])
                st_round1, _ = models.reconcile_continuity(None, pre_a, post_a, now=t0_end)
                self.assertTrue(st_round1["healthy"])
                sock_path.unlink()
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv_b:
                    srv_b.bind(str(sock_path))
                    pre_b = run_with_hook(None, with_gen=True, at="2026-11-19T01:05:05Z")
                    post_b = run_with_hook(None, with_gen=True, at="2026-11-19T01:05:10Z")
                    self.assertNotEqual(pre_a["generation"], pre_b["generation"])
                    st_round2, iv_round2 = models.reconcile_continuity(
                        st_round1, pre_b, post_b, now="2026-11-19T01:05:10Z"
                    )
                    # Generation changed across socket rebind -> prior closed at t0_end, no bridged [t0_end, 01:05:05Z] interval.
                    self.assertEqual(len(iv_round2), 2)
                    self.assertEqual(iv_round2[0]["endAt"], models._utc_instant(t0_end))
                    self.assertEqual(iv_round2[1]["startAt"], models._utc_instant("2026-11-19T01:05:05Z"))
                    self.assertEqual(iv_round2[1]["endAt"], models._utc_instant("2026-11-19T01:05:10Z"))
                    gap_mid = models._utc_instant("2026-11-19T01:02:30Z")
                    self.assertFalse(any(iv["startAt"] <= gap_mid <= iv["endAt"] for iv in iv_round2))

    def test_daily_agents_exact_events_subagent_move_rebind_and_jsonl_hardening(self):
        collector = self._collector()
        with tempfile.TemporaryDirectory() as root:
            # 24 KB base_instructions header + malformed scalar/list/non-object payload lines in JSONL.
            bad_lines = [
                "123",
                '"just a string"',
                '["list", "line"]',
                json.dumps({"type": "event_msg", "payload": ["not-a-dict"]}),
                json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": ["not-a-dict"]}}),
            ]
            # Events:
            # - 00:50:00Z: before observation start (unproven start -> Unattributed)
            # - 01:02:00Z: inside adjacent round [01:00:00Z, 01:05:10Z] -> Attributed (15)
            # - 02:30:00Z: inside 3-hour 10805s gap -> Unattributed (30)
            root_records = self._write_codex_rollout(
                root,
                self.SID_A,
                [
                    ("2026-11-19T00:50:00Z", 4, 1, 5),
                    ("2026-11-19T01:02:00Z", 10, 2, 3),
                    ("2026-11-19T02:30:00Z", 20, 4, 6),
                ],
                extra_lines=bad_lines,
                header_pad=24000,
            )
            # Subagent forked from SID_A at 01:03:00Z -> Attributed to SID_A's owner (25)
            child_records = self._write_codex_rollout(
                root,
                self.SID_CHILD,
                [("2026-11-19T01:03:00Z", 15, 5, 5)],
                forked_from=self.SID_A,
            )
            # Second session SID_B moved from w6:p2 to w7:p1 between pre and post -> Unattributed (40)
            moved_records = self._write_codex_rollout(
                root,
                self.SID_B,
                [("2026-11-19T01:05:07Z", 30, 5, 5)],
            )

            all_tokens = root_records + child_records + moved_records
            total_in = sum(r["input"] for r in all_tokens)
            total_out = sum(r["output"] for r in all_tokens)
            total_cache = sum(r["cacheRead"] for r in all_tokens)
            snap = snapshot([daily(TODAY, input=total_in, output=total_out, cache=total_cache)])

            r_a = _agent_row("w6:p1", "w6", "mausbot-back", session_id=self.SID_A)
            r_b_pre = _agent_row("w6:p2", "w6", "mover", session_id=self.SID_B)
            r_b_post = _agent_row("w7:p1", "w7", "mover", session_id=self.SID_B)
            runner_t0 = _herdr_payload(self.WORKSPACES, [r_a, r_b_pre], generation="gen-1")
            runner_t1_post = _herdr_payload(self.WORKSPACES, [r_a, r_b_post], generation="gen-1")

            st1, _ = models.reconcile_continuity(
                None,
                models.sample_herdr(at="2026-11-19T01:00:00Z", herdr_runner=runner_t0),
                models.sample_herdr(at="2026-11-19T01:00:05Z", herdr_runner=runner_t0),
                now="2026-11-19T01:00:05Z",
            )
            st2, _ = models.reconcile_continuity(
                st1,
                models.sample_herdr(at="2026-11-19T01:05:05Z", herdr_runner=runner_t0),
                models.sample_herdr(at="2026-11-19T01:05:10Z", herdr_runner=runner_t1_post),
                now="2026-11-19T01:05:10Z",
            )
            # Run 3 after 3-hour (10805s) gap: SID_A endpoints match again, must NOT bridge gap.
            runner_3h = _herdr_payload(self.WORKSPACES, [r_a], generation="gen-1")
            _, intervals = models.reconcile_continuity(
                st2,
                models.sample_herdr(at="2026-11-19T04:05:15Z", herdr_runner=runner_3h),
                models.sample_herdr(at="2026-11-19T04:05:20Z", herdr_runner=runner_3h),
                now="2026-11-19T04:05:20Z",
            )

            attributed = models.daily_agents(
                collector,
                [{"tokens": all_tokens}],
                snap,
                config={"home": root},
                intervals=intervals,
            )
            self.assertEqual(attributed, {
                TODAY: [{
                    "id": "w6:p1",
                    "name": "mausbot-back",
                    "teamId": "w6",
                    "teamName": "MausBot",
                    "totalTokens": 40,  # 15 (root at 01:02) + 25 (forked subagent at 01:03); 10 + 30 + 40 remain Unattributed
                }]
            })

            # Missing/malformed Herdr sample degrades only Agents, never raises.
            self.assertIsNone(models.sample_herdr(at="2026-11-19T01:00:00Z", herdr_runner=lambda _args: "not-json"))
            self.assertIsNone(models.sample_herdr(at="2026-11-19T01:00:00Z", herdr_runner=lambda _args: "[]"))

            # Member rebinding on same pane (rename alice -> bob) breaks continuity and seeds bob from post_at.
            reb_pre = _herdr_payload(self.WORKSPACES, [_agent_row("w6:p1", "w6", "alice", session_id=self.SID_A)], generation="gen-1")
            reb_post = _herdr_payload(self.WORKSPACES, [_agent_row("w6:p1", "w6", "bob", session_id=self.SID_A)], generation="gen-1")
            st_reb1, _ = models.reconcile_continuity(
                None,
                models.sample_herdr(at="2026-11-19T01:00:00Z", herdr_runner=reb_pre),
                models.sample_herdr(at="2026-11-19T01:00:05Z", herdr_runner=reb_pre),
                now="2026-11-19T01:00:05Z",
            )
            st_reb2, iv_reb2 = models.reconcile_continuity(
                st_reb1,
                models.sample_herdr(at="2026-11-19T01:05:05Z", herdr_runner=reb_pre),
                models.sample_herdr(at="2026-11-19T01:05:10Z", herdr_runner=reb_post),
                now="2026-11-19T01:05:10Z",
            )
            self.assertEqual(st_reb2["active"]["w6:p1"]["name"], "bob")
            self.assertEqual(st_reb2["active"]["w6:p1"]["observedSince"], "2026-11-19T01:05:10Z")
            self.assertEqual(len(iv_reb2), 1)
            self.assertEqual(iv_reb2[0]["name"], "alice")
            self.assertEqual(iv_reb2[0]["endAt"], models._utc_instant("2026-11-19T01:05:05Z"))

            # Mid-file conflicting session_meta drops attribution for that rollout file cleanly.
            conflict_root = Path(root) / "conflict_home"
            conflict_records = self._write_codex_rollout(
                conflict_root,
                self.SID_A,
                [("2026-11-19T01:02:00Z", 10, 2, 3)],
                extra_lines=[json.dumps({"type": "session_meta", "payload": {"id": self.SID_B}})],
            )
            self.assertEqual(
                models.daily_agents(
                    collector,
                    [{"tokens": conflict_records}],
                    snapshot([daily(TODAY, input=10, output=2, cache=3)]),
                    config={"home": str(conflict_root)},
                    intervals=intervals,
                ),
                {},
            )

            # Malformed continuity JSON returns None without crashing.
            bad_cont = Path(root) / "bad-continuity.json"
            bad_cont.write_text('{"version": 1, "healthy": "yes"}', encoding="utf-8")
            self.assertIsNone(models.load_continuity(bad_cont))

    def test_daily_agents_ranks_matched_files_by_mtime_under_scan_budget(self):
        collector = self._collector()
        sid_old_match = "44444444-4444-4444-8444-444444444444"
        sid_unverified = "55555555-5555-4555-8555-555555555555"
        sid_unrelated = "66666666-6666-4666-8666-666666666666"
        with tempfile.TemporaryDirectory() as root:
            old_dir = Path(root) / ".codex" / "sessions" / "2026" / "11" / "18"
            old_dir.mkdir(parents=True, exist_ok=True)
            old_match_path = old_dir / f"rollout-2026-11-18-{sid_old_match}.jsonl"
            old_match_path.write_text(
                "\n".join([
                    json.dumps({"type": "session_meta", "payload": {"id": sid_old_match, "forked_from_id": self.SID_A, "base_instructions": {"text": "x" * 500}}}),
                    json.dumps({"type": "turn_context", "payload": {"cwd": "/shared/repo", "model": "gpt-6.2-sol"}}),
                ]) + "\n",
                encoding="utf-8",
            )

            unrelated_records = self._write_codex_rollout(
                root,
                sid_unrelated,
                [("2026-11-19T01:02:30Z", 40, 5, 5)],
                header_pad=4096,
            )
            unrelated_path = Path(root) / ".codex" / "sessions" / "2026" / "11" / "19" / f"rollout-2026-11-19-{sid_unrelated}.jsonl"

            unverified_records = self._write_codex_rollout(
                root,
                sid_unverified,
                [("2026-11-19T01:02:45Z", 50, 10, 10)],
                header_pad=4096,
            )
            unverified_path = Path(root) / ".codex" / "sessions" / "2026" / "11" / "19" / f"rollout-2026-11-19-{sid_unverified}.jsonl"

            lead_records = self._write_codex_rollout(
                root,
                self.SID_A,
                [
                    ("2026-11-19T00:50:00Z", 4, 1, 5),
                    ("2026-11-19T01:02:00Z", 10, 2, 3),
                ],
            )
            lead_path = Path(root) / ".codex" / "sessions" / "2026" / "11" / "19" / f"rollout-2026-11-19-{self.SID_A}.jsonl"

            review_records = self._write_codex_rollout(
                root,
                self.SID_B,
                [("2026-11-19T01:03:00Z", 20, 4, 6)],
            )
            review_path = Path(root) / ".codex" / "sessions" / "2026" / "11" / "19" / f"rollout-2026-11-19-{self.SID_B}.jsonl"

            os.utime(old_match_path, ns=(1_700_000_000_000_000_000, 1_700_000_000_000_000_000))
            os.utime(lead_path, ns=(1_800_000_000_000_000_000, 1_800_000_000_000_000_000))
            os.utime(review_path, ns=(1_800_000_100_000_000_000, 1_800_000_100_000_000_000))
            os.utime(unrelated_path, ns=(1_900_000_000_000_000_000, 1_900_000_000_000_000_000))
            os.utime(unverified_path, ns=(1_950_000_000_000_000_000, 1_950_000_000_000_000_000))

            old_size = old_match_path.stat().st_size
            lead_size = lead_path.stat().st_size
            review_size = review_path.stat().st_size
            synthetic_cap = lead_size + review_size
            self.assertLessEqual(old_size, synthetic_cap)
            self.assertGreater(old_size + lead_size, synthetic_cap)
            self.assertGreater(old_size + review_size, synthetic_cap)

            runner = _herdr_payload(
                self.WORKSPACES,
                [
                    _agent_row("w6:p1", "w6", "mausbot-lead", session_id=self.SID_A),
                    _agent_row("w6:p2", "w6", "mausbot-review2", session_id=self.SID_B),
                    _agent_row("w6:p3", "w6", "unverified-member", session_id=sid_unverified, source="unknown:manual"),
                ],
                generation="gen-budget",
            )
            _, intervals = models.reconcile_continuity(
                None,
                models.sample_herdr(at="2026-11-19T01:00:00Z", herdr_runner=runner),
                models.sample_herdr(at="2026-11-19T01:05:00Z", herdr_runner=runner),
                now="2026-11-19T01:05:00Z",
            )

            all_tokens = lead_records + review_records + unrelated_records + unverified_records
            snap = snapshot([daily(
                TODAY,
                input=sum(r["input"] for r in all_tokens),
                output=sum(r["output"] for r in all_tokens),
                cache=sum(r["cacheRead"] for r in all_tokens),
            )])

            with patch.object(models, "MAX_CODEX_SCAN_BYTES", synthetic_cap):
                attributed = models.daily_agents(
                    collector,
                    [{"tokens": all_tokens}],
                    snap,
                    config={"home": root},
                    intervals=intervals,
                )

            self.assertEqual(attributed, {
                TODAY: [
                    {"id": "w6:p2", "name": "mausbot-review2", "teamId": "w6", "teamName": "MausBot", "totalTokens": 30},
                    {"id": "w6:p1", "name": "mausbot-lead", "teamId": "w6", "teamName": "MausBot", "totalTokens": 15},
                ]
            })
            retained = usage.retain_token_history(snap, None, None, agent_days=attributed)
            self.assertEqual(retained["trendHistory"]["daily"][0]["totalTokens"], 175)
            self.assertEqual(retained["trendHistory"]["daily"][0]["agentTokens"], attributed[TODAY])

            # Equal mtime ties preserve the existing lexical scan order stably.
            tie_ns = 1_850_000_000_000_000_000
            os.utime(lead_path, ns=(tie_ns, tie_ns))
            os.utime(review_path, ns=(tie_ns, tie_ns))
            with patch.object(models, "MAX_CODEX_SCAN_BYTES", lead_size):
                tie_attributed = models.daily_agents(
                    collector,
                    [{"tokens": all_tokens}],
                    snap,
                    config={"home": root},
                    intervals=intervals,
                )
            self.assertEqual(tie_attributed, {
                TODAY: [
                    {"id": "w6:p1", "name": "mausbot-lead", "teamId": "w6", "teamName": "MausBot", "totalTokens": 15},
                ]
            })

            # Fresh scan-boundary stat re-reads st_size so a file that grows past cap after ranking is skipped cleanly.
            os.utime(review_path, ns=(1_900_000_000_000_000_000, 1_900_000_000_000_000_000))
            headers_seen = [False]
            review_stat_calls = [0]
            orig_read_header = models._read_codex_header
            orig_stat = Path.stat

            def tracked_header(path, *args, **kwargs):
                if path == review_path:
                    headers_seen[0] = True
                return orig_read_header(path, *args, **kwargs)

            def grown_stat(path_self, *args, **kwargs):
                st = orig_stat(path_self, *args, **kwargs)
                if path_self == review_path and headers_seen[0]:
                    review_stat_calls[0] += 1
                    if review_stat_calls[0] >= 2:
                        return types.SimpleNamespace(
                            st_mode=st.st_mode,
                            st_size=synthetic_cap + 1,
                            st_mtime_ns=st.st_mtime_ns,
                        )
                return st

            with patch.object(models, "MAX_CODEX_SCAN_BYTES", synthetic_cap), \
                 patch.object(models, "_read_codex_header", side_effect=tracked_header), \
                 patch.object(Path, "stat", grown_stat):
                grown_attributed = models.daily_agents(
                    collector,
                    [{"tokens": all_tokens}],
                    snap,
                    config={"home": root},
                    intervals=intervals,
                )
            self.assertEqual(review_stat_calls[0], 2)
            self.assertEqual(grown_attributed, {
                TODAY: [
                    {"id": "w6:p1", "name": "mausbot-lead", "teamId": "w6", "teamName": "MausBot", "totalTokens": 15},
                ]
            })

    def test_retain_token_history_recomputes_fresh_same_sum_days_and_keeps_unavailable_fallback(self):
        agent_a = {"id": "w6:p1", "name": "mausbot-back", "teamId": "w6", "teamName": "MausBot", "totalTokens": 15}
        agent_b = {"id": "w6:p2", "name": "mausbot-dev2", "teamId": "w6", "teamName": "MausBot", "totalTokens": 15}
        first = usage.retain_token_history(snapshot([daily(TODAY)]), None, None, agent_days={TODAY: [agent_a]})
        self.assertEqual(first["trendHistory"]["daily"][0]["agentTokens"], [agent_a])

        # Same daily token sum (15) from different fresh collection with no attributed agents must NOT retain stale agent_a.
        fresh_unattributed = usage.retain_token_history(snapshot([daily(TODAY)]), first, None, saved=first, agent_days={})
        self.assertEqual(fresh_unattributed["trendHistory"]["daily"][0]["totalTokens"], 15)
        self.assertNotIn("agentTokens", fresh_unattributed["trendHistory"]["daily"][0])

        # Same daily sum (15) recomputed to a different agent replaces previous attribution.
        fresh_reassigned = usage.retain_token_history(snapshot([daily(TODAY)]), first, None, saved=first, agent_days={TODAY: [agent_b]})
        self.assertEqual(fresh_reassigned["trendHistory"]["daily"][0]["agentTokens"], [agent_b])

        # Unavailable fresh day falls back to prior retained day and preserves that original day's agentTokens.
        fallback = usage.retain_token_history(snapshot([daily(TODAY, "unavailable")]), first, None, saved=first, agent_days={})
        self.assertEqual(fallback["trendHistory"]["daily"][0]["tokenStatus"], "partial")
        self.assertEqual(fallback["trendHistory"]["daily"][0]["agentTokens"], [agent_a])

        # Historical pane reuse on the same day: two distinct verified names on the same (teamId, id) pass both
        # validate_agents and retain_token_history, while a true duplicate (teamId, id, name) triple is rejected.
        reuse_old = {"id": "w6:p1", "name": "alice", "teamId": "w6", "teamName": "MausBot", "totalTokens": 9}
        reuse_new = {"id": "w6:p1", "name": "bob", "teamId": "w6", "teamName": "MausBot", "totalTokens": 6}
        self.assertEqual(models.validate_agents([reuse_old, reuse_new], 15), [reuse_old, reuse_new])
        self.assertIsNone(models.validate_agents([reuse_old, {**reuse_old, "totalTokens": 6}], 15))
        reused_retained = usage.retain_token_history(
            snapshot([daily(TODAY)]),
            None,
            None,
            agent_days={TODAY: [reuse_old, reuse_new]},
        )
        self.assertEqual(reused_retained["trendHistory"]["daily"][0]["agentTokens"], [reuse_old, reuse_new])
        # Retained saved history with same-day dual names on the same pane stays intact on unavailable fallback.
        reused_fallback = usage.retain_token_history(
            snapshot([daily(TODAY, "unavailable")]),
            reused_retained,
            None,
            saved=reused_retained,
            agent_days={},
        )
        self.assertEqual(reused_fallback["trendHistory"]["daily"][0]["agentTokens"], [reuse_old, reuse_new])


if __name__ == "__main__":
    unittest.main()
