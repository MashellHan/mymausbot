import importlib.util
import http.server
import io
import json
from pathlib import Path
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
OWNER = "owner@example.test"


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
        (self.root / "msal_token_cache.json").write_text('{"fixture":"existing-cache"}')
        self.created = []
        self.sessions = []
        created = self.created
        sessions = self.sessions

        class Cache:
            def deserialize(self, value):
                self.value = value

        class Client:
            def __init__(self, client_id, **kwargs):
                created.append({"client_id": client_id, **kwargs})
                self.cache = kwargs["token_cache"]
                self.account = {"username": OWNER, "realm": TENANT}
                sessions.append(self)

            def get_accounts(self, username):
                return [self.account] if username == OWNER else []

            def acquire_token_silent(self, scopes, account):
                if scopes != [usage.ADO_RESOURCE + "/.default"] or account is not self.account:
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
        self.assertEqual(self.created[1]["token_cache"].value, '{"fixture":"existing-cache"}')

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


if __name__ == "__main__":
    unittest.main()
