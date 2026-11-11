import datetime as dt
from contextlib import nullcontext
import importlib.util
import http.client
import http.server
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("usage_memory", Path(__file__).with_name("refresh-local-usage.py"))
usage = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(usage)
TENANT = "11111111-2222-3333-4444-555555555555"
OTHER_TENANT = "66666666-7777-8888-9999-000000000000"
OWNER = "owner@example.test"


def account(tenant=TENANT, owner=OWNER, home="fixture-owner.home-tenant"):
    return {"username": owner, "realm": tenant, "home_account_id": home,
            "environment": "login.microsoftonline.com"}


def command(url="https://dev.azure.com/example/_apis/connectionData?connectOptions=0"):
    return ["/fixture/az", "rest", "--method", "get", "--url", url,
            "--resource", usage.ADO_RESOURCE, "-o", "json"]


class TokenHistoryTests(unittest.TestCase):
    @staticmethod
    def snapshot(date, value=10, status="ready"):
        category = {"input": value, "output": 0, "cacheRead": 2}
        zero = {"input": 0, "output": 0, "cacheRead": 0}
        at = dt.datetime.fromisoformat(date + "T08:00:00+00:00")
        return {"version": 1, "timeZone": "Asia/Shanghai", "updatedAt": int(at.timestamp() * 1000),
                "daily": [{"day": date, "tokenStatus": status,
                           "categories": {"work": category, "personal": zero, "unclassified": zero}}]}

    def test_observed_days_survive_the_collectors_60_day_cutoff_without_filling_gaps(self):
        previous = self.snapshot("2026-06-01")
        previous["localHistory"] = {"version": 1, "daily": previous["daily"]}
        first = usage.retain_token_history(self.snapshot("2026-08-02", 0, "partial"), previous)
        self.assertEqual([row["day"] for row in first["trendHistory"]["daily"]], ["2026-06-01", "2026-08-02"])
        self.assertEqual(first["trendHistory"]["daily"][0]["totalTokens"], 12)
        self.assertEqual(first["trendHistory"]["daily"][1]["tokenStatus"], "partial")
        next_snapshot = self.snapshot("2026-11-09", 0, "unavailable")
        result = usage.retain_token_history(next_snapshot, first)
        self.assertEqual([row["day"] for row in result["trendHistory"]["daily"]], ["2026-06-01", "2026-08-02", "2026-11-09"])
        self.assertIsNone(result["trendHistory"]["daily"][-1]["totalTokens"])
        self.assertEqual(len(result["daily"]), 1)

    def test_bounded_history_discards_future_invalid_and_expired_rows_and_preserves_zero(self):
        previous = self.snapshot("2026-11-08")
        projected = {"day": "2026-05-03", "tokenStatus": "ready", "newTokens": 0, "cacheRead": 0, "totalTokens": 0}
        previous["trendHistory"] = {"version": 1, "daily": [projected,
            {**projected, "day": "2026-05-02"}, {**projected, "day": "2026-11-10"},
            {**projected, "day": "2026-06-01", "newTokens": -1},
            {**projected, "day": "2026-06-02", "totalTokens": 1},
            {**projected, "day": "2026-02-30"}]}
        result = usage.retain_token_history(self.snapshot("2026-11-09"), previous)
        rows = result["trendHistory"]["daily"]
        self.assertEqual([row["day"] for row in rows], ["2026-05-03", "2026-11-08", "2026-11-09"])
        self.assertEqual(rows[0]["totalTokens"], 0)
        self.assertEqual(rows[0]["tokenStatus"], "ready")
        previous["localHistory"] = False
        previous["trendHistory"] = None
        usage.retain_token_history(self.snapshot("2026-11-09"), previous)

    def test_unavailable_refresh_preserves_known_tokens_as_partial_beyond_the_60_day_cutoff(self):
        for status in ("ready", "partial"):
            with self.subTest(status=status):
                previous = self.snapshot("2026-11-08")
                known = [{"day": date, "tokenStatus": status, "newTokens": 100, "cacheRead": 20, "totalTokens": 120}
                         for date in ("2026-10-01", "2026-11-01")]
                previous["trendHistory"] = {"version": 1, "daily": known}
                current = self.snapshot("2026-11-09")
                unknown = [self.snapshot(date, 0, "unavailable")["daily"][0]
                           for date in ("2026-10-01", "2026-10-02", "2026-11-01", "2026-11-02")]
                current["localHistory"] = {"version": 1, "daily": unknown}
                current["daily"].extend(unknown[2:])
                result = usage.retain_token_history(current, previous)
                rows = {row["day"]: row for row in result["trendHistory"]["daily"]}
                for row in known:
                    self.assertEqual(rows[row["day"]], {**row, "tokenStatus": "partial"})
                for date in ("2026-10-02", "2026-11-02"):
                    self.assertEqual(rows[date], {"day": date, "tokenStatus": "unavailable",
                                                "newTokens": None, "cacheRead": None, "totalTokens": None})
                self.assertEqual(current["localHistory"]["daily"], unknown)
                self.assertEqual(previous["trendHistory"]["daily"], known)
                later = usage.retain_token_history(self.snapshot("2027-01-15"), result)
                retained = {row["day"]: row for row in later["trendHistory"]["daily"]}
                for row in known:
                    self.assertEqual(retained[row["day"]], {**row, "tokenStatus": "partial"})


class MemoryAuthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        profile = {"subscriptions": [{"isDefault": True, "environmentName": "AzureCloud",
                   "tenantId": TENANT, "user": {"name": OWNER, "type": "user"}}]}
        (self.root / "azureProfile.json").write_text(json.dumps(profile))
        self.saved_cache = json.dumps({"accounts": [account()]})
        (self.root / "msal_token_cache.json").write_text(self.saved_cache)
        self.created = []
        self.sessions = []
        created = self.created
        sessions = self.sessions

        class Cache:
            CredentialType = types.SimpleNamespace(ACCOUNT="Account")

            def deserialize(self, value):
                self.value = value
                self.accounts = json.loads(value)["accounts"]

            def search(self, credential_type, query):
                if credential_type != "Account":
                    raise AssertionError("Unexpected credential lookup")
                return [entry for entry in self.accounts
                        if all(entry.get(key) == value for key, value in query.items())]

        class Client:
            def __init__(self, client_id, **kwargs):
                created.append({"client_id": client_id, **kwargs})
                self.cache = kwargs["token_cache"]
                self.accounts = list({entry["home_account_id"]: entry
                                     for entry in self.cache.accounts}.values())
                sessions.append(self)

            def get_accounts(self, username):
                return [entry for entry in self.accounts if entry["username"].lower() == username.lower()]

            def acquire_token_silent(self, scopes, account):
                if scopes != [usage.ADO_RESOURCE + "/.default"] or account not in self.accounts:
                    raise AssertionError("Unexpected authentication scope or account")
                self.cache.value = "new-session-only-refresh-token"
                return {"access_token": "fixture-access-token"}

        modules = {"msal": types.SimpleNamespace(PublicClientApplication=Client, SerializableTokenCache=Cache),
                   "azure.cli.core.auth.constants": types.SimpleNamespace(AZURE_CLI_CLIENT_ID="fixture-client")}
        patcher = patch.dict("sys.modules", modules)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.session = usage.AzureMemorySession(self.root, [OWNER])

    def test_tokens_are_memory_only_and_broker_is_disabled(self):
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        self.assertEqual(self.session.token(), "fixture-access-token")
        self.assertFalse(self.created[0]["enable_broker_on_mac"])
        self.assertFalse(self.created[0]["enable_pii_log"])
        self.assertEqual(self.created[0]["http_cache"], {})
        self.assertEqual(self.created[0]["token_cache"].value, "new-session-only-refresh-token")
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})
        second = usage.AzureMemorySession(self.root, [OWNER])
        second.connect()
        self.assertEqual(self.created[1]["token_cache"].value, self.saved_cache)

    def test_selected_tenant_works_in_either_account_cache_order(self):
        for tenants in [(TENANT, OTHER_TENANT), (OTHER_TENANT, TENANT)]:
            with self.subTest(tenants=tenants):
                saved = json.dumps({"accounts": [account(tenant) for tenant in tenants]})
                (self.root / "msal_token_cache.json").write_text(saved)
                session = usage.AzureMemorySession(self.root, [OWNER])
                self.assertEqual(session.token(), "fixture-access-token")
                self.assertEqual(self.created[-1]["authority"], "https://login.microsoftonline.com/" + TENANT)
                self.assertEqual((self.root / "msal_token_cache.json").read_text(), saved)

    def test_missing_selected_tenant_wrong_owner_and_ambiguous_identity_are_rejected(self):
        for accounts in [[account(OTHER_TENANT)], [account(owner="other@example.test")],
                         [account(), account(home="another-owner.home-tenant")],
                         [account(owner="other@example.test"), account(OTHER_TENANT)]]:
            with self.subTest(accounts=accounts):
                (self.root / "msal_token_cache.json").write_text(json.dumps({"accounts": accounts}))
                session = usage.AzureMemorySession(self.root, [OWNER])
                with self.assertRaises(ValueError):
                    session.token()
                self.assertIsNone(session.client)

    def test_identity_mismatch_never_constructs_an_authentication_client(self):
        session = usage.AzureMemorySession(self.root, ["someone-else@example.test"])
        with self.assertRaises(ValueError):
            session.token()
        self.assertEqual(self.created, [])

    def test_authentication_failure_never_falls_back_to_cli_or_exposes_sdk_secrets(self):
        self.session.connect()
        def fail(*args, **kwargs):
            raise RuntimeError("credential-bearing SDK error: fixture-secret")
        self.sessions[0].acquire_token_silent = fail
        with self.assertRaises(ValueError) as error:
            self.session.token()
        self.assertNotIn("fixture-secret", str(error.exception))
        self.sessions[0].acquire_token_silent = lambda *a, **k: {"error": "interaction_required"}
        with self.assertRaisesRegex(ValueError, "without an interactive login"):
            self.session.token()

    def test_bearer_token_is_sent_only_to_allowed_https_endpoints(self):
        requests = []
        def open_request(request, timeout):
            requests.append((request, timeout))
            return io.BytesIO(b'{"authenticatedUser":{}}')
        self.session.http = types.SimpleNamespace(open=open_request)
        response = self.session.run(command(), 7)
        self.assertEqual(json.loads(response), {"authenticatedUser": {}})
        self.assertEqual(requests[0][0].get_header("Authorization"), "Bearer fixture-access-token")
        self.assertEqual(requests[0][1], 7)
        for url in ["https://example.test/", "http://dev.azure.com/example/_apis/connectionData",
                    "https://dev.azure.com:8443/example/_apis/connectionData",
                    "https://user@dev.azure.com/example/_apis/connectionData",
                    "https://dev.azure.com/example/_apis/connectionData#fragment",
                    "https://dev.azure.com/example/_apis/arbitrary"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.session.run(command(url), 7)
        altered = command()
        altered[3] = "post"
        with self.assertRaises(ValueError):
            self.session.run(altered, 7)
        self.assertEqual(len(requests), 1)

    def test_remote_merged_ado_pages_keep_only_bounded_get_paths_and_continuation_headers(self):
        class Reply(io.BytesIO):
            headers = {"x-ms-continuationtoken": "next-page"}

        requests = []
        def open_request(request, timeout):
            requests.append((request, timeout))
            return Reply(b'{"value":[]}')
        self.session.http = types.SimpleNamespace(open=open_request)
        allowed = [
            "https://dev.azure.com/example/project/_apis/git/pullrequests?searchCriteria.status=completed",
            "https://dev.azure.com/example/project/_apis/git/repositories/repo/pullrequests/7/commits?continuationToken=next-page",
            "https://dev.azure.com/example/project/_apis/git/repositories/repo/commits/" + "a" * 40 + "?api-version=7.1",
        ]
        for url in allowed:
            self.assertEqual(self.session.request(url, 7), ('{"value":[]}', "next-page"))
        self.assertEqual(len(requests), len(allowed))
        for url in ["https://dev.azure.com/example/project/_apis/git/repositories/repo/refs?api-version=7.1",
                    "https://dev.azure.com/example/project/_apis/git/repositories/repo/pullrequests/7/commits/extra",
                    "https://other.example.test/example/project/_apis/git/pullrequests"]:
            with self.assertRaises(ValueError):
                self.session.request(url, 7)
        self.assertEqual(len(requests), len(allowed))

    def test_authenticated_redirects_are_not_followed(self):
        paths = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/redirected")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = usage.urllib.request.Request(
                "http://127.0.0.1:" + str(server.server_port) + "/start",
                headers={"Authorization": "Bearer fixture-access-token"},
            )
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.session.http.open(request, timeout=3)
            self.assertEqual(error.exception.code, 302)
            self.assertEqual(paths, ["/start"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_http_protocol_failures_are_safe_collector_errors(self):
        for wire in [b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nprivate-response-fragment",
                     b"private-invalid-status-line\r\n\r\n"]:
            class ResponseSocket:
                def makefile(self, *args, **kwargs):
                    return io.BytesIO(wire)

            def open_response(request, timeout):
                response = http.client.HTTPResponse(ResponseSocket())
                response.begin()
                return response

            self.session.http = types.SimpleNamespace(open=open_response)
            with self.subTest(wire=wire), self.assertRaises(ValueError) as error:
                self.session.run(command(), 7)
            self.assertEqual(str(error.exception), "The Azure DevOps response could not be read")

    def test_refresh_reuses_collector_without_azure_cli_or_direct_gh(self):
        collector = self.root / "collector.py"
        output = self.root / "result.json"
        collector.write_text('''import json
def run(args, timeout=35):
    if args[0] == "/fixture/az":
        raise AssertionError("Azure CLI must not execute")
    return "existing-github-result"
def refresh(config, upload=False, skip_api=False, reuse_sources=False):
    azure = run([config["azureCli"], "rest", "--method", "get", "--url", "https://dev.azure.com/example/_apis/connectionData", "--resource", "499b84ac-1321-427f-aa17-267ca6975798", "-o", "json"], timeout=20)
    value = {"azure": azure, "github": run(["gh", "api", "user"]), "publish": upload, "skipApi": skip_api, "reuseSources": reuse_sources}
    with open(config["result"], "w") as stream:
        json.dump(value, stream)
''')
        config = {"azureCli": "/fixture/az", "authorEmails": [OWNER], "result": str(output)}
        calls = []
        def get(session, args, timeout):
            calls.append((args, timeout))
            return "memory-auth-result"
        with patch.object(usage.AzureMemorySession, "run", get):
            with self.assertRaisesRegex(ValueError, "Direct GitHub CLI"):
                usage.refresh(collector, config, self.root, publish=False, skip_api=False, reuse_sources=True)
        self.assertFalse(output.exists())
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 20)
        with self.assertRaisesRegex(ValueError, "publication requires"):
            usage.refresh(collector, config, self.root, publish=True)

    def test_refresh_requests_private_history_only_from_a_capable_collector(self):
        collector = self.root / "collector-history.py"
        output = self.root / "history-result.json"
        collector.write_text('''import json
def run(args, timeout=35):
    raise AssertionError("No CLI should run in this fixture")
def refresh(config, upload=False, skip_api=False, reuse_sources=False, history_days=30):
    with open(config["result"], "w") as stream:
        json.dump({"historyDays": history_days, "publish": upload,
                   "skipApi": skip_api, "reuseSources": reuse_sources}, stream)
''')
        config = {"azureCli": "/fixture/az", "authorEmails": [OWNER], "result": str(output)}
        usage.refresh(collector, config, self.root, publish=False, skip_api=True, reuse_sources=True)
        self.assertEqual(json.loads(output.read_text()), {"historyDays": 59,
            "publish": False, "skipApi": True, "reuseSources": True})

    def test_token_coverage_is_independent_only_for_known_git_fetch_failures(self):
        collector = self.root / "collector-token-coverage.py"
        output = self.root / "token-coverage.json"
        collector.write_text('''import json
def run(args, timeout=35):
    raise AssertionError("No CLI should run in this fixture")
def aggregate(machines, prs, at, history_days=30):
    return {"status": "partial", "sources": [{"device": m["device"], "status": m["status"]} for m in machines],
            "daily": [{"tokenStatus": "partial", "totalTokens": 123}], "historyDays": history_days}
def refresh(config, upload=False, skip_api=False, reuse_sources=False, history_days=30):
    result = aggregate(config["machines"], {}, None, history_days=history_days)
    with open(config["result"], "w") as stream:
        json.dump(result, stream)
''')
        cases = [
            ("ok", [], "ready"),
            ("partial", [{"source": "git-fetch", "code": "CalledProcessError"},
                         {"source": "git-fetch", "code": "TimeoutExpired"}], "ready"),
            ("partial", [{"source": "git-fetch"}, {"source": "codex"}], "partial"),
            ("partial", [{"source": "tokens", "code": "NoRetainedLogs"}], "partial"),
            ("partial", [{"source": "repositories"}], "partial"),
            ("partial", [{"source": "unknown"}], "partial"),
            ("partial", [], "partial"),
            ("partial", ["git-fetch"], "partial"),
            ("stale", [{"source": "git-fetch"}], "partial"),
            ("missing", [], "unavailable"),
        ]
        machines = [{"device": str(i), "status": status, "errors": errors}
                    for i, (status, errors, _) in enumerate(cases)]
        config = {"azureCli": "/fixture/az", "authorEmails": [OWNER], "result": str(output), "machines": machines}
        usage.refresh(collector, config, self.root, skip_api=True, reuse_sources=True)
        result = json.loads(output.read_text())
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["historyDays"], 59)
        self.assertEqual(result["daily"], [{"tokenStatus": "partial", "totalTokens": 123}])
        self.assertEqual(result["sources"], [{"device": str(i), "status": status, "tokenStatus": token_status}
                         for i, (status, _, token_status) in enumerate(cases)])

    def test_remote_refresh_stays_independent_when_local_logs_fail(self):
        collector = self.root / "collector-fails.py"
        collector.write_text('''def run(args, timeout=35):
    raise AssertionError("No CLI should run in this fixture")
def refresh(config, upload=False, skip_api=False, reuse_sources=False):
    raise ValueError("local logs unavailable")
''')
        config = {"azureCli": "/fixture/az", "authorEmails": [OWNER],
                  "githubProfiles": [{"host": "github.com", "profile": "personal", "login": "owner", "category": "personal"}]}
        with patch.object(usage.local_usage_merged, "refresh") as remote:
            with self.assertRaisesRegex(ValueError, "local logs unavailable"):
                usage.refresh(collector, config, self.root, skip_api=True)
            self.assertTrue(remote.called)
            self.assertTrue(remote.call_args.kwargs["skip_api"])

    def test_bounded_failed_root_keeps_previous_tokens_categories_commits_and_ado(self):
        at = dt.datetime.fromisoformat("2026-11-06T08:00:00+00:00")
        old = {"capturedAt": "2026-11-05T08:00:00Z", "tokens": [
            {"key": "replayed", "at": "2026-11-06T07:00:00Z", "category": "work"},
            {"key": "old-token", "at": "2026-11-06T06:00:00Z", "category": "personal"}],
            "commits": [{"key": "old-commit", "at": "2026-11-06T06:00:00Z", "repository": {"id": "old"}}],
            "adoRepos": ["https://dev.azure.com/example/project/_git/old"]}
        fresh = {"start": "2026-11-06T00:00:00Z", "capturedAt": "2026-11-07T00:00:00Z",
                 "status": "ok", "errors": [], "tokens": [{"key": "replayed", "at": "2026-11-06T07:00:00Z", "category": "unclassified"}],
                 "commits": [{"key": "new-commit", "at": "2026-11-06T07:00:00Z", "repository": {"id": "new"}}],
                 "adoRepos": ["https://dev.azure.com/example/project/_git/new"]}
        calls = []
        def worker(request, timeout):
            calls.append((request, timeout))
            if request["stage"] == "repositories" and request["config"]["repoRoots"] == ["/fixture/failed"]:
                raise subprocess.TimeoutExpired("synthetic root", timeout)
            if request["stage"] == "repositories":
                return [{"path": "/fixture/ready", "name": "ready", "category": "work"}]
            return fresh
        collector = types.SimpleNamespace(read_json=lambda path, default: old,
            instant=lambda value: dt.datetime.fromisoformat(value.replace("Z", "+00:00")))
        config = {"repoRoots": ["/fixture/ready", "/fixture/failed"], "storageDir": str(self.root)}
        with patch.object(usage, "_run_worker", side_effect=worker), patch.object(usage, "load_collector", return_value=collector):
            result = usage.collect_local(self.root / "collector.py", config, "fixture", at=at, history_days=59)
        self.assertEqual([call[0]["stage"] for call in calls], ["repositories", "repositories", "collect"])
        self.assertTrue(all(timeout <= 15 for _, timeout in calls[:2]))
        self.assertLessEqual(calls[-1][1], 120)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["tokens"], [
            {"key": "replayed", "at": "2026-11-06T07:00:00Z", "category": "work"},
            {"key": "old-token", "at": "2026-11-06T06:00:00Z", "category": "personal"}])
        self.assertEqual({row["key"] for row in result["commits"]}, {"old-commit", "new-commit"})
        self.assertEqual(result["adoRepos"], [
            "https://dev.azure.com/example/project/_git/new",
            "https://dev.azure.com/example/project/_git/old"])
        self.assertEqual(result["retainedCapturedAt"], old["capturedAt"])
        self.assertEqual(result["errors"], [{"source": "repositories", "rootIndex": 2, "code": "TimeoutExpired"}])

    def test_profile_opt_in_routes_independently_and_preserves_skip_api(self):
        collector = types.SimpleNamespace(run=lambda args, timeout: "{}",
            remote_category=lambda remote, config: "personal", refresh=lambda config, **options: None)
        config = {"azureCli": "/fixture/az", "authorEmails": [OWNER]}
        with patch.object(usage, "load_collector", return_value=collector), patch.object(usage.local_usage_github, "refresh") as profile:
            usage.refresh(self.root / "collector.py", config, self.root)
            profile.assert_not_called()
            config["githubContributionSource"] = "github-profile-v1"
            usage.refresh(self.root / "collector.py", config, self.root, skip_api=True)
            self.assertTrue(profile.call_args.kwargs["skip_api"])
            self.assertIs(profile.call_args.args[0], config)

    def test_local_worker_timeout_kills_and_reaps_its_process_group(self):
        class Worker:
            pid = 123
            returncode = None
            calls = 0
            def communicate(self, payload=None, timeout=None):
                self.calls += 1
                if self.calls == 1:
                    raise subprocess.TimeoutExpired("synthetic worker", timeout)
                return "", ""
        worker = Worker()
        with patch.object(usage.subprocess, "Popen", return_value=worker), patch.object(usage.os, "killpg") as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                usage._run_worker({"stage": "collect"}, 0.1)
        kill.assert_called_once_with(123, usage.signal.SIGKILL)
        self.assertEqual(worker.calls, 2)

    def test_worker_imports_sibling_module_from_unrelated_cwd_without_pythonpath(self):
        unrelated = self.root / "unrelated"
        home = self.root / "home"
        repository = self.root / "repository"
        for directory in (unrelated, home, repository):
            directory.mkdir()
        collector = self.root / "collector.py"
        collector.write_text('''import os
import sys
def repositories(config):
    return [{"path": config["repoRoots"][0], "cwd": os.getcwd(),
             "home": os.environ["HOME"], "pythonPath": os.environ.get("PYTHONPATH"),
             "noBytecode": sys.dont_write_bytecode}]
''')
        spawn = subprocess.Popen

        def isolated_spawn(command, **kwargs):
            self.assertTrue(kwargs["start_new_session"])
            self.assertEqual(kwargs["env"]["HOME"], str(home))
            self.assertEqual(kwargs["env"]["GIT_CONFIG_GLOBAL"], "/dev/null")
            self.assertEqual(kwargs["env"]["GIT_ASKPASS"], "/usr/bin/false")
            self.assertEqual(kwargs["env"]["PYTHONDONTWRITEBYTECODE"], "1")
            return spawn(command, cwd=unrelated, **kwargs)

        request = {"stage": "repositories", "collector": str(collector),
                   "config": {"repoRoots": [str(repository)]}}
        with patch.dict(os.environ, {"HOME": str(home), "PYTHONPATH": "/unsafe/python-path"}), \
             patch.object(usage.subprocess, "Popen", side_effect=isolated_spawn):
            result = usage._run_worker(request, 5)
        self.assertEqual(result, [{"path": str(repository), "cwd": str(unrelated.resolve()),
                                   "home": str(home), "pythonPath": None, "noBytecode": True}])
        self.assertFalse((self.root / "__pycache__").exists())

    def test_unknown_collector_child_is_refused_before_it_can_run(self):
        collector = self.root / "collector.py"
        collector.write_text('''import subprocess
import sys
from pathlib import Path
class Classifier:
    def classify(self, cwd, context=None):
        return "unclassified"
def instant(value):
    return value
def run(args, timeout=35):
    raise AssertionError("No external command is expected")
def collect(config, device, at=None, history_days=30):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True)
    Path(config["home"]).joinpath("detached.pid").write_text(str(child.pid))
    child.wait(timeout=30)
def refresh(config, upload=False, skip_api=False, reuse_sources=False, history_days=30):
    lock = Path(config["storageDir"]) / ".refresh.lock"
    lock.mkdir()
    try:
        collect(config, "fixture", history_days=history_days)
    finally:
        lock.rmdir()
''')
        pid_file = self.root / "detached.pid"
        lock = self.root / ".refresh.lock"
        config = {"azureCli": "/fixture/az", "authorEmails": [OWNER],
                  "storageDir": str(self.root), "home": str(self.root), "repoRoots": [],
                  "githubProfiles": [{"host": "github.com"}]}
        with patch.object(usage.local_usage_merged, "refresh") as remote:
            with self.assertRaisesRegex(ValueError, "Local activity collection failed"):
                usage.refresh(collector, config, self.root, skip_api=True)
            remote.assert_called_once()
        self.assertFalse(pid_file.exists())
        self.assertFalse(lock.exists())


class FileAuthAndChildBoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.root.chmod(0o700)
        self.profiles = [
            {"profile": "personal", "host": "github.com", "login": "SamplePersonal", "stableId": "sample-personal-id"},
            {"profile": "work", "host": "github.com", "login": "SampleWork", "stableId": "sample-work-id"},
        ]
        self.config = {"githubHelper": str(Path(usage.__file__).resolve()), "githubProfiles": self.profiles}
        for directory, profile, token in zip(usage.GitHubFileSession.AUTH_DIRECTORIES, self.profiles,
                                              ("synthetic-personal-token", "synthetic-work-token")):
            folder = self.root / directory
            folder.mkdir(mode=0o700)
            path = folder / "credential.json"
            path.write_text(json.dumps({"host": profile["host"], "login": profile["login"],
                                        "stableId": profile["stableId"], "token": token}))
            path.chmod(0o600)
        self.session = usage.GitHubFileSession(self.config, self.root)
        self.calls = []

        def open_request(request, timeout):
            self.calls.append((request, timeout))
            profile = self.profiles[0] if "personal-token" in request.get_header("Authorization") else self.profiles[1]
            if request.full_url == "https://api.github.com/user":
                result = {"node_id": profile["stableId"], "login": profile["login"],
                          "html_url": "https://github.com/" + profile["login"]}
            elif request.full_url == "https://api.github.com/graphql":
                result = {"data": {"viewer": {"id": profile["stableId"], "login": profile["login"],
                                               "url": "https://github.com/" + profile["login"]}}}
            elif "/search/issues?" in request.full_url:
                result = {"items": [], "total_count": 0, "incomplete_results": False}
            elif "/compare/" in request.full_url:
                result = {"commits": [], "total_commits": 0}
            else:
                raise AssertionError("Unexpected provider path")
            return io.BytesIO(json.dumps(result).encode())

        self.session.http = types.SimpleNamespace(open=open_request)

    def command(self, name, *operation):
        return [sys.executable, self.config["githubHelper"], "gh", name, "api", *operation]

    def test_explicit_files_reach_only_fixed_https_and_verify_identity(self):
        opener = usage.GitHubFileSession(self.config, self.root).http
        self.assertTrue(any(isinstance(handler, usage.NoRedirect) for handler in opener.handlers))
        self.assertFalse(any(isinstance(handler, usage.urllib.request.ProxyHandler) and handler.proxies
                             for handler in opener.handlers))
        first = self.command("personal", "graphql", "-f", "query=query{viewer{id login url}}")
        second = self.command("work", "graphql", "-f", "query=query{viewer{id login url}}")
        for command in (first, second):
            result = json.loads(self.session.run(command, 7))
            self.assertEqual(result["data"]["viewer"]["url"].split("/")[2], "github.com")
        self.assertEqual([call[0].full_url for call in self.calls],
                         ["https://api.github.com/user", "https://api.github.com/graphql"] * 2)
        self.assertEqual([call[1] for call in self.calls], [7] * 4)
        self.assertFalse(any("github_account.py" in call[0].full_url for call in self.calls))

    def test_token_identity_mismatch_stops_before_graphql(self):
        def wrong_user(request, timeout):
            self.calls.append((request, timeout))
            self.assertEqual(request.full_url, "https://api.github.com/user")
            return io.BytesIO(json.dumps({"node_id": "wrong-id", "login": "SamplePersonal",
                                          "html_url": "https://github.com/SamplePersonal"}).encode())
        self.session.http = types.SimpleNamespace(open=wrong_user)
        with self.assertRaisesRegex(ValueError, "token identity"):
            self.session.run(self.command("personal", "graphql", "-f", "query=query{viewer{id}}"), 7)
        self.assertEqual(len(self.calls), 1)

    def test_legacy_user_search_compare_are_bounded_and_unknown_route_is_denied(self):
        self.assertEqual(self.session.run(self.command("personal", "user", "--jq", ".login"), 7), "SamplePersonal")
        query = "is:pr author:SamplePersonal created:>=2026-11-01T00:00:00Z"
        self.session.run(self.command("personal", "--method", "GET", "search/issues", "-f", "q=" + query,
                                      "-F", "per_page=100", "-F", "page=1"), 7)
        endpoint = "repos/owner/repo/compare/" + "a" * 40 + "..." + "b" * 40 + "?per_page=100&page=1"
        self.session.run(self.command("personal", endpoint), 7)
        count = len(self.calls)
        for operation in (("auth", "token"), ("graphql", "-f", "query=x", "-f", "query=y"),
                          ("repos/owner/repo/hooks",), ("--method", "POST", "search/issues")):
            with self.subTest(operation=operation), self.assertRaises(ValueError):
                self.session.run(self.command("personal", *operation), 7)
        self.assertEqual(len(self.calls), count)

    def test_missing_unsafe_or_mismatched_file_has_no_auth_fallback(self):
        path = self.root / "github-personal/credential.json"
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            self.session.run(self.command("personal", "user", "--jq", ".login"), 7)
        path.chmod(0o600)
        value = json.loads(path.read_text())
        value["stableId"] = "wrong-id"
        path.write_text(json.dumps(value))
        with self.assertRaises(ValueError):
            usage.GitHubFileSession(self.config, self.root).run(self.command("personal", "user", "--jq", ".login"), 7)
        path.unlink()
        with self.assertRaises(ValueError):
            usage.GitHubFileSession(self.config, self.root).run(self.command("personal", "user", "--jq", ".login"), 7)
        value["stableId"] = self.profiles[0]["stableId"]
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        (self.root / "github-personal").chmod(0o755)
        with self.assertRaises(ValueError):
            usage.GitHubFileSession(self.config, self.root).run(self.command("personal", "user", "--jq", ".login"), 7)
        self.config["githubHelper"] = "/unsafe/github_account.py"
        with self.assertRaises(ValueError):
            usage.GitHubFileSession(self.config, self.root).run(self.command("personal", "user", "--jq", ".login"), 7)
        self.assertEqual(self.calls, [])

    def test_all_collector_children_deny_network_and_inherited_helpers(self):
        with patch.dict(os.environ, {"GH_TOKEN": "synthetic-inherited", "GIT_ASKPASS": "/unsafe/askpass"}):
            environment = usage.child_environment()
        self.assertNotIn("GH_TOKEN", environment)
        self.assertEqual(environment["GIT_ASKPASS"], "/usr/bin/false")
        self.assertEqual(environment["GIT_CONFIG_GLOBAL"], "/dev/null")
        proxy = usage.LocalGitOnly()
        with patch.object(usage.subprocess, "run", return_value=types.SimpleNamespace(stdout="local")) as run:
            result = proxy.run(["git", "-C", "/fixture/repo", "log", "--all", "--no-merges",
                                "--since=2026-11-01T00:00:00Z", "--format=%H%x1f%aE%x1f%aI"], timeout=5)
            self.assertEqual(result.stdout, "local")
            self.assertEqual(run.call_args.kwargs["env"]["GIT_ALLOW_PROTOCOL"], "file")
            for command in (["git", "-C", "/fixture/repo", "fetch", "origin"],
                            ["ssh", "example"], ["gh", "auth", "token"], ["node", "publisher"]):
                with self.assertRaises(ValueError):
                    proxy.run(command, timeout=5)
            self.assertEqual(run.call_count, 1)
        with self.assertRaises(ValueError):
            proxy.Popen(["git", "fetch", "origin"])

    def test_allowed_log_never_invokes_configured_signature_program(self):
        repository = self.root / "signed-repository"
        repository.mkdir()
        environment = usage.child_environment()

        def git(*args, input=None):
            return subprocess.run(["git", "-C", str(repository), *args], input=input,
                                  capture_output=True, text=True, check=True, env=environment)

        git("-c", "init.templateDir=/dev/null", "init", "-q")
        tree = git("mktree", input="").stdout.strip()
        commit_text = (f"tree {tree}\nauthor Fixture <fixture@example.test> 1760000000 +0000\n"
                       "committer Fixture <fixture@example.test> 1760000000 +0000\n"
                       "gpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\nfixture\n")
        commit = git("hash-object", "-t", "commit", "-w", "--stdin", input=commit_text).stdout.strip()
        git("update-ref", "refs/heads/main", commit)
        marker = self.root / "gpg-invoked"
        sentinel = self.root / "gpg-sentinel.py"
        sentinel.write_text("#!/usr/bin/python3\nfrom pathlib import Path\nPath(" + repr(str(marker))
                            + ").write_text('invoked')\nraise SystemExit(1)\n")
        sentinel.chmod(0o700)
        git("config", "log.showSignature", "true")
        git("config", "gpg.program", str(sentinel))
        git("log", "--show-signature", "--all", "--no-merges", "--since=2025-01-01T00:00:00Z",
            "--format=%H%x1f%aE%x1f%aI")
        self.assertTrue(marker.exists())
        marker.unlink()
        result = usage.LocalGitOnly().run(["git", "-C", str(repository), "log", "--all", "--no-merges",
                                           "--since=2025-01-01T00:00:00Z", "--format=%H%x1f%aE%x1f%aI"],
                                          capture_output=True, text=True, timeout=5, check=True)
        self.assertIn(commit, result.stdout)
        self.assertEqual(result.args[4], "--no-show-signature")
        self.assertFalse(marker.exists())

    def test_loaded_collector_and_all_primary_workers_keep_the_child_boundary(self):
        collector = self.root / "collector.py"
        collector.write_text('''import subprocess
def fetch_origins(repos):
    raise AssertionError("Network fetch must be replaced")
def collect(config):
    return {"tokens": [{"value": 7}], "errors": fetch_origins([{"remote": "https://github.com/example/repo"}])}
''')
        loaded = usage.load_collector(collector)
        self.assertEqual(loaded.fetch_origins([{"remote": "https://github.com/example/repo"}]),
                         [{"source": "git-fetch", "code": "DisabledByAuthBoundary"}])
        self.assertEqual(loaded.collect({})["tokens"], [{"value": 7}])
        with self.assertRaises(ValueError):
            loaded.subprocess.run(["ssh", "example"], timeout=5)

        workers = []

        class Worker:
            returncode = 1
            def __init__(self):
                self.stdin = io.BytesIO()
            def wait(self, timeout):
                return 1
            def poll(self):
                return 1

        def spawn(command, **kwargs):
            workers.append(kwargs)
            return Worker()

        with patch.object(usage, "primary_config"), \
             patch.object(usage.local_usage_contributions, "target_lock", return_value=nullcontext()), \
             patch.object(usage.local_usage_contributions, "load_previous", return_value=None), \
             patch.object(usage.subprocess, "Popen", side_effect=spawn):
            with self.assertRaisesRegex(ValueError, "capture is incomplete"):
                usage.refresh_primary(collector, {"home": str(self.root)}, self.root,
                                      file=self.root / "candidate.json")
        self.assertEqual(len(workers), 3)
        self.assertTrue(all(worker["env"]["GIT_CONFIG_GLOBAL"] == "/dev/null"
                            and worker["env"]["GIT_ASKPASS"] == "/usr/bin/false"
                            and "GH_TOKEN" not in worker["env"] for worker in workers))

    def test_private_capture_prefers_valid_candidate_progress_over_immutable_seed(self):
        zone = dt.timezone(dt.timedelta(hours=8))
        cutoff = dt.datetime.fromisoformat("2026-11-11T01:32:36+00:00")
        config = {"githubProfiles": [{"host": "github.com", "login": "Fixture", "stableId": "fixture-id", "profile": "fixture"}],
                  "mergedAdoProjects": ["https://dev.azure.com/example/project"],
                  "adoPrincipals": {"example": {"stableId": TENANT, "alias": OWNER}},
                  "adoAuthorEmails": [OWNER], "authorEmails": [OWNER]}
        def envelope(provider, at, progress, legacy=False):
            end = at.astimezone(dt.timezone.utc if legacy else zone).date()
            first = (end - dt.timedelta(days=59)).isoformat()
            account = {"host": "github.com" if provider == "github" else "dev.azure.com",
                       "login": "Fixture" if provider == "github" else OWNER,
                       "stableId": "fixture-id" if provider == "github" else TENANT}
            source = {"id": provider + "-source", "account": account, "status": "partial",
                      "coverage": {"identityVerified": True, "paginationComplete": False,
                                   "visibilityComplete": False, "reasons": ["history-incomplete"]}, "days": []}
            if provider == "ado": source["scope"] = {"organization": "example", "project": "project"}
            state = ({"schema": 1, "sources": {source["id"]: {"progress": progress}}} if provider == "github"
                     else {"schema": 3, "projects": {"example/project": {"cache": {"verified": {"items": [
                         {"id": "a" * 40, "authoredAt": "2026-11-10T16:30:00Z", "merge": True, "coauthor": False}]}}}}})
            return {"version": 2, "provider": provider,
                    "metricDefinition": ("github-profile-v2" if provider == "github" else "ado-default-head-v1") if legacy
                        else ("github-profile-beijing-v1" if provider == "github" else "ado-default-head-beijing-v1"),
                    "dateBasis": ({"prs": "github-profile-day", "commits": "github-profile-day"} if provider == "github"
                                  else {"prs": "created-at/UTC", "commits": "author-at/UTC"}) if legacy
                        else {"prs": "created-at/Asia-Shanghai", "commits": "author-at/Asia-Shanghai"},
                    "asOfAt": at.isoformat().replace("+00:00", "Z"), "capturedAt": at.isoformat().replace("+00:00", "Z"),
                    "operationWindow": {"startDay": first, "endDay": end.isoformat(), "todayPartial": True},
                    "activeSourceIds": [source["id"]], "sources": [source],
                    "collection": {"requestCount": 1, "elapsedSeconds": 0.1, "complete": False,
                                   "reasons": ["history-incomplete"]}, "state": state}
        seed = {"version": 2, "github": envelope("github", cutoff, 0, legacy=True),
                "ado": envelope("ado", cutoff, 0, legacy=True)}
        seed_path = self.root / "seed.json"
        seed_path.write_text(json.dumps(seed)); seed_path.chmod(0o600)
        live = self.root / "live.json"
        live.write_text(json.dumps(seed))
        target = self.root / "candidate.json"
        seen = []

        class Worker:
            returncode = 0
            def __init__(self):
                self.stdin = self.Input(self)
            class Input(io.BytesIO):
                def __init__(self, process):
                    super().__init__(); self.process = process
                def close(self):
                    request = json.loads(self.getvalue())
                    seen.append((request["stage"], request["previous"]))
                    old = request["previous"]
                    previous_progress = old.get("state", {}).get("sources", {}).get("github-source", {}).get("progress", 0)
                    result = envelope(request["stage"], dt.datetime.fromisoformat(request["at"]),
                                      previous_progress + 1 if request["stage"] == "github" else 0)
                    Path(request["output"]).write_text(json.dumps(result))
                    super().close()
            def wait(self, timeout): return 0
            def poll(self): return 0

        with patch.object(usage, "primary_config", return_value=None), patch.object(usage.subprocess, "Popen", side_effect=lambda *a, **k: Worker()):
            first = usage.refresh_primary(self.root / "collector.py", config, self.root,
                                          file=target, previous_file=seed_path, include_legacy=False)
            live.write_text('{"new":"ordinary scheduled generation"}')
            second = usage.refresh_primary(self.root / "collector.py", config, self.root,
                                           file=target, previous_file=seed_path, include_legacy=False)
        self.assertEqual(first["github"]["state"]["sources"]["github-source"]["progress"], 1)
        self.assertEqual(second["github"]["state"]["sources"]["github-source"]["progress"], 2)
        self.assertEqual(seen[0][1]["metricDefinition"], "github-profile-v2")
        self.assertEqual(seen[2][1]["metricDefinition"], "github-profile-beijing-v1")
        self.assertEqual(second["ado"]["state"]["projects"], first["ado"]["state"]["projects"])
        self.assertEqual(json.loads(seed_path.read_text()), seed)
        target.write_text("{broken"); target.chmod(0o600)
        with self.assertRaises((ValueError, json.JSONDecodeError)):
            usage.refresh_primary(self.root / "collector.py", config, self.root,
                                  file=target, previous_file=seed_path, include_legacy=False)


if __name__ == "__main__":
    unittest.main()
