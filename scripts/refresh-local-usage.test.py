import datetime as dt
import importlib.util
import http.client
import http.server
import io
import json
import os
from pathlib import Path
import subprocess
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

    def test_refresh_reuses_collector_and_never_executes_its_azure_cli(self):
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
            usage.refresh(collector, config, self.root, publish=True, skip_api=False, reuse_sources=True)
        self.assertEqual(json.loads(output.read_text()), {"azure": "memory-auth-result",
            "github": "existing-github-result", "publish": True, "skipApi": False, "reuseSources": True})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], 20)

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
def repositories(config):
    return [{"path": config["repoRoots"][0], "cwd": os.getcwd(),
             "home": os.environ["HOME"], "pythonPath": os.environ.get("PYTHONPATH")}]
''')
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        environment["HOME"] = str(home)
        spawn = subprocess.Popen

        def isolated_spawn(command, **kwargs):
            self.assertTrue(kwargs["start_new_session"])
            return spawn(command, cwd=unrelated, env=environment, **kwargs)

        request = {"stage": "repositories", "collector": str(collector),
                   "config": {"repoRoots": [str(repository)]}}
        with patch.object(usage.subprocess, "Popen", side_effect=isolated_spawn):
            result = usage._run_worker(request, 5)
        self.assertEqual(result, [{"path": str(repository), "cwd": str(unrelated.resolve()),
                                   "home": str(home), "pythonPath": None}])

    def test_detached_child_keeps_refresh_lock_after_collection_timeout(self):
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
        try:
            with patch.object(usage, "LOCAL_COLLECT_TIMEOUT", 6), patch.object(usage.local_usage_merged, "refresh") as remote:
                with self.assertRaises(OSError):
                    usage.refresh(collector, config, self.root, skip_api=True)
                remote.assert_called_once()
            self.assertTrue((lock / ".detached-child-unverified").is_dir())
            pid = int(pid_file.read_text())
            self.assertEqual(os.getpgid(pid), pid)
        finally:
            if pid_file.exists():
                pid = int(pid_file.read_text())
                try:
                    if os.getpgid(pid) == pid:
                        os.killpg(pid, usage.signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
