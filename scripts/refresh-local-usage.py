#!/usr/bin/env python3
"""Refresh an existing activity collector with Microsoft tokens held in memory."""

import argparse
import datetime as dt
import http.client
import importlib.util
import inspect
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import local_usage_merged

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
LOCAL_COLLECT_TIMEOUT = 120
REPOSITORY_TIMEOUT = 15


def retain_token_history(snapshot, previous):
    at = snapshot.get("updatedAt")
    if type(at) is not int:
        return snapshot
    end = dt.datetime.fromtimestamp(at / 1000, local_usage_merged.TZ).date()
    first = end - dt.timedelta(days=local_usage_merged.MAX_HISTORY_DAYS - 1)
    records = {}

    def retain(rows, projected=False):
        if not isinstance(rows, list) or len(rows) > local_usage_merged.MAX_HISTORY_DAYS:
            return
        for row in rows:
            try:
                day = dt.date.fromisoformat(row["day"])
                status = row["tokenStatus"]
                if day.isoformat() != row["day"] or not first <= day <= end or status not in ("ready", "partial", "unavailable"):
                    continue
                if status == "unavailable":
                    new, cache = None, None
                elif projected:
                    new, cache = row["newTokens"], row["cacheRead"]
                    if row["totalTokens"] != new + cache:
                        continue
                else:
                    categories = [row["categories"][key] for key in ("work", "personal", "unclassified")]
                    values = [value[key] for value in categories for key in ("input", "output", "cacheRead")]
                    if any(type(value) is not int or value < 0 for value in values):
                        continue
                    new = sum(value["input"] + value["output"] for value in categories)
                    cache = sum(value["cacheRead"] for value in categories)
                if status != "unavailable" and any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in (new, cache, new + cache)):
                    continue
                records[row["day"]] = {"day": row["day"], "tokenStatus": status,
                    "newTokens": new, "cacheRead": cache, "totalTokens": None if new is None else new + cache}
            except (KeyError, TypeError, ValueError, OverflowError):
                continue

    if isinstance(previous, dict) and previous.get("version") == 1 and previous.get("timeZone") == "Asia/Shanghai":
        retain(previous.get("daily"))
        for key in ("localHistory", "trendHistory"):
            if isinstance(previous.get(key), dict):
                retain(previous[key].get("daily"), key == "trendHistory")
    if isinstance(snapshot.get("localHistory"), dict):
        retain(snapshot["localHistory"].get("daily"))
    retain(snapshot.get("daily"))
    snapshot["trendHistory"] = {"version": 1, "daily": [records[day] for day in sorted(records)]}
    return snapshot


def load_collector(collector_path):
    spec = importlib.util.spec_from_file_location("local_activity_collector", collector_path)
    if spec is None or spec.loader is None:
        raise ValueError("The existing activity collector could not be loaded")
    collector = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(collector)
    return collector


def _collect_worker():
    try:
        request = json.load(sys.stdin)
        collector = load_collector(request["collector"])
        if request["stage"] == "repositories":
            if not Path(request["config"]["repoRoots"][0]).expanduser().is_dir():
                raise ValueError("Repository root is unavailable")
            original_walk = collector.os.walk

            def walk(root):
                def failed(error):
                    raise error
                return original_walk(root, onerror=failed)

            collector.os.walk = walk
            result = collector.repositories(request["config"])
        else:
            collector.repositories = lambda config: request["repositories"]
            original_classify = collector.Classifier.classify
            blocked = [os.path.abspath(os.path.expanduser(root)) for root in request["failedRoots"]]

            def classify(self, cwd, context=None):
                if cwd and any(os.path.commonpath([os.path.abspath(cwd), root]) == root for root in blocked):
                    category = original_classify(self, None, context)
                    if category == "unclassified":
                        matches = {r["category"] for r in self.repos if r["name"] in Path(cwd).parts}
                        if len(matches) == 1:
                            category = matches.pop()
                    return category
                return original_classify(self, cwd, context)

            collector.Classifier.classify = classify
            result = collector.collect(request["config"], request["device"],
                                       at=collector.instant(request["at"]),
                                       history_days=request["history_days"])
        json.dump(result, sys.stdout)
    except Exception as error:
        print(f"usage stage=local-collect failed type={type(error).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None


def _run_worker(request, timeout):
    command = [sys.executable, "-c",
               "import os,runpy,sys; sys.path.insert(0,os.path.dirname(sys.argv[1])); "
               "runpy.run_path(sys.argv[1])['_collect_worker']()", str(Path(__file__).resolve())]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               text=True, start_new_session=True)
    try:
        output, _ = process.communicate(json.dumps(request), timeout=timeout)
    except BaseException as error:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            print("usage stage=local-collect cleanup-failed lock-retained", file=sys.stderr, flush=True)
            os._exit(1)
        if isinstance(error, subprocess.TimeoutExpired):
            print("usage stage=local-collect timeout worker-reaped", file=sys.stderr, flush=True)
            raise subprocess.TimeoutExpired("local activity collection", timeout) from None
        raise
    if process.returncode:
        raise ValueError("Local activity collection failed")
    return json.loads(output)


def collect_local(collector_path, config, device, at=None, history_days=30):
    deadline = time.monotonic() + LOCAL_COLLECT_TIMEOUT
    fields = ("home", "repoRoots", "authorEmails", "workGithubOrgs", "personalGithubOwners", "m365Repos")
    request = {"collector": str(collector_path), "config": {k: config[k] for k in fields if k in config},
               "device": device, "at": at.isoformat() if at else None, "history_days": history_days}
    repositories, failed_roots, errors = [], [], []
    for index, root in enumerate(config["repoRoots"], 1):
        print(f"usage stage=repository root={index} begin", file=sys.stderr, flush=True)
        try:
            repositories.extend(_run_worker({**request, "stage": "repositories",
                "config": {**request["config"], "repoRoots": [root]}},
                min(REPOSITORY_TIMEOUT, max(0, deadline - time.monotonic()))))
            print(f"usage stage=repository root={index} end", file=sys.stderr, flush=True)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            failed_roots.append(root)
            errors.append({"source": "repositories", "rootIndex": index, "code": type(error).__name__})
            print(f"usage stage=repository root={index} unavailable", file=sys.stderr, flush=True)
    print("usage stage=local-records begin", file=sys.stderr, flush=True)
    try:
        result = _run_worker({**request, "stage": "collect", "repositories": repositories,
                              "failedRoots": failed_roots}, max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        lock = Path(config["storageDir"]).expanduser() / ".refresh.lock"
        try:
            (lock / ".detached-child-unverified").mkdir(exist_ok=True)
        except OSError:
            print("usage stage=local-collect timeout lock-marker-failed", file=sys.stderr, flush=True)
            os._exit(1)
        print("usage stage=local-collect timeout lock-retained", file=sys.stderr, flush=True)
        raise RuntimeError("Local activity worker cleanup is unverified") from None
    if errors or result.get("errors"):
        collector = load_collector(collector_path)
        previous = collector.read_json(Path(config["storageDir"]).expanduser() / "machines" / (device + ".json"), {})
        start, end = collector.instant(result["start"]), collector.instant(result["capturedAt"])
        if failed_roots:
            previous_tokens = {}
            for record in previous.get("tokens", []):
                previous_tokens.setdefault(record["key"], record)
            for record in result["tokens"]:
                previous_category = previous_tokens.get(record["key"], {}).get("category")
                if record.get("category") == "unclassified" and previous_category in ("work", "personal"):
                    record["category"] = previous_category
        for field in ("tokens", "commits"):
            def key(record):
                return record["key"] if field == "tokens" else (record["key"], (record.get("repository") or {}).get("id"))
            fresh_keys = {key(record) for record in result[field]}
            result[field].extend(record for record in previous.get(field, [])
                                 if key(record) not in fresh_keys
                                 and (record_at := collector.instant(record.get("at"))) is not None
                                 and start <= record_at < end)
        result["adoRepos"] = sorted(set(result["adoRepos"]) | set(previous.get("adoRepos", [])))
        result["status"] = "partial"
        result["errors"].extend(errors)
        result["retainedCapturedAt"] = previous.get("retainedCapturedAt") or previous.get("capturedAt")
    return result


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
    collector = load_collector(collector_path)
    original_run = collector.run
    azure = AzureMemorySession(azure_config_dir, config["authorEmails"])

    original_aggregate = getattr(collector, "aggregate", None)
    if original_aggregate is not None:
        def aggregate(machines, *args, **kwargs):
            snapshot = original_aggregate(machines, *args, **kwargs)
            if len(snapshot["sources"]) != len(machines):
                raise ValueError("Activity source coverage does not match the collected machines")
            for source, machine in zip(snapshot["sources"], machines):
                if source.get("device") != machine.get("device"):
                    raise ValueError("Activity source identity does not match the collected machine")
                errors = machine.get("errors")
                git_fetch_only = isinstance(errors, list) and bool(errors) and all(
                    isinstance(error, dict) and error.get("source") == "git-fetch" for error in errors
                )
                source["tokenStatus"] = "ready" if machine.get("status") == "ok" or (
                    machine.get("status") == "partial" and git_fetch_only
                ) else "partial" if machine.get("status") in ("partial", "stale") else "unavailable"
            previous = collector.read_json(Path(config["storageDir"]).expanduser() / "latest.json", {}) if "storageDir" in config else {}
            return retain_token_history(snapshot, previous)

        collector.aggregate = aggregate

    def run(args, timeout=35):
        if str(args[0]) == config["azureCli"]:
            return azure.run(args, timeout)
        return original_run(args, timeout)

    collector.run = run
    collector.collect = lambda config, device, at=None, history_days=30: collect_local(
        collector_path, config, device, at, history_days
    )
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
