#!/usr/bin/env python3
"""Refresh an existing activity collector with Microsoft tokens held in memory."""

import argparse
import http.client
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import sys
import threading
import urllib.parse
import urllib.request

import local_usage_merged

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AzureMemorySession:
    def __init__(self, config_dir, author_emails):
        self.config_dir = config_dir
        self.author_emails = {email.lower() for email in author_emails}
        self.lock = threading.Lock()
        self.client = None
        self.account = None
        self.http = urllib.request.build_opener(NoRedirect())

    def token(self):
        with self.lock:
            try:
                if self.client is None:
                    self.connect()
                result = self.client.acquire_token_silent(
                    [ADO_RESOURCE + "/.default"], account=self.account
                ) or {}
            except Exception:
                raise ValueError("Microsoft sign-in is unavailable without an interactive login") from None
            token = result.get("access_token") if isinstance(result, dict) else None
            if not isinstance(token, str) or not token:
                raise ValueError("Microsoft sign-in is unavailable without an interactive login")
            return token

    def connect(self):
        from azure.cli.core.auth.constants import AZURE_CLI_CLIENT_ID
        from msal import PublicClientApplication, SerializableTokenCache

        profile = json.loads(
            (self.config_dir / "azureProfile.json").read_text(encoding="utf-8-sig")
        )
        defaults = [entry for entry in profile["subscriptions"] if entry.get("isDefault")]
        if len(defaults) != 1:
            raise ValueError("Select one existing Azure CLI account before collecting Usage")
        selected = defaults[0]
        user = selected.get("user", {})
        username = user.get("name", "")
        tenant = selected.get("tenantId", "")
        if (
            selected.get("environmentName") != "AzureCloud"
            or user.get("type") != "user"
            or username.lower() not in self.author_emails
            or not re.fullmatch(r"[0-9a-fA-F-]{36}", tenant)
        ):
            raise ValueError("The existing Azure CLI identity does not match the Usage owner")
        cache = SerializableTokenCache()
        cache.deserialize((self.config_dir / "msal_token_cache.json").read_text())
        client = PublicClientApplication(
            AZURE_CLI_CLIENT_ID,
            authority="https://login.microsoftonline.com/" + tenant,
            token_cache=cache,
            http_cache={},
            enable_broker_on_mac=False,
            enable_pii_log=False,
            client_capabilities=["CP1"],
            timeout=15,
        )
        # MSAL 1.39.0 projects one tenant record per home account in cache order.
        accounts = [account for account in client.get_accounts(username=username)
                    if account.get("home_account_id") and any(
                        cached.get("username", "").lower() == username.lower()
                        for cached in cache.search(cache.CredentialType.ACCOUNT, query={
                            "home_account_id": account["home_account_id"],
                            "environment": account["environment"], "realm": tenant,
                        })
                    )]
        if len(accounts) != 1:
            raise ValueError("The Microsoft account is not present in the existing CLI cache")
        self.client, self.account = client, accounts[0]

    def run(self, args, timeout):
        if (
            len(args) != 10
            or list(args[1:5]) != ["rest", "--method", "get", "--url"]
            or list(args[6:]) != ["--resource", ADO_RESOURCE, "-o", "json"]
        ):
            raise ValueError("Usage permits only the existing Azure DevOps GET requests")
        return self.request(str(args[5]), timeout)[0]

    def request(self, url, timeout):
        target = urllib.parse.urlsplit(url)
        if (
            target.scheme != "https"
            or target.hostname != "dev.azure.com"
            or target.port not in (None, 443)
            or target.username is not None
            or target.password is not None
            or target.fragment
            or not re.fullmatch(
                r"/[^/]+/_apis/connectionData|/[^/]+/[^/]+/_apis/git/(?:pullrequests|repositories/[^/]+/(?:pullrequests|pullrequests/\d+/commits|commits/[0-9a-f]{40}(?:[0-9a-f]{24})?))",
                target.path,
                re.I,
            )
        ):
            raise ValueError("Usage permits only Azure DevOps identity and PR endpoints")
        request = urllib.request.Request(
            target.geturl(),
            headers={"Authorization": "Bearer " + self.token(), "Accept": "application/json"},
            method="GET",
        )
        try:
            with self.http.open(request, timeout=timeout) as response:
                headers = getattr(response, "headers", None)
                continuation = headers.get("x-ms-continuationtoken") if headers else None
                return response.read().decode("utf-8"), continuation
        except http.client.HTTPException:
            raise ValueError("The Azure DevOps response could not be read") from None


def refresh(collector_path, config, azure_config_dir, *, publish=False, skip_api=False, reuse_sources=False):
    spec = importlib.util.spec_from_file_location("local_activity_collector", collector_path)
    if spec is None or spec.loader is None:
        raise ValueError("The existing activity collector could not be loaded")
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    original_run = collector.run
    azure = AzureMemorySession(azure_config_dir, config["authorEmails"])

    def run(args, timeout=35):
        if str(args[0]) == config["azureCli"]:
            return azure.run(args, timeout)
        return original_run(args, timeout)

    collector.run = run
    options = {"upload": publish, "skip_api": skip_api, "reuse_sources": reuse_sources}
    if "history_days" in inspect.signature(collector.refresh).parameters:
        options["history_days"] = 59
    try:
        collector.refresh(config, **options)
    finally:
        if config.get("githubProfiles") or config.get("mergedAdoProjects") or config.get("adoRemotes"):
            try:
                local_usage_merged.refresh(config, collector, collector.run, ado_request=azure.request, skip_api=skip_api)
            except Exception as error:
                print("Remote merged Usage unavailable: " + type(error).__name__, file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/agent-town/activity.json")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--skip-api", action="store_true")
    parser.add_argument("--reuse-sources", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.expanduser().read_text())
    azure_dir = Path(os.environ.get("AZURE_CONFIG_DIR", str(Path.home() / ".azure"))).expanduser()
    refresh(args.collector.expanduser(), config, azure_dir, publish=args.publish,
            skip_api=args.skip_api, reuse_sources=args.reuse_sources)


if __name__ == "__main__":
    main()
