#!/usr/bin/env python3
"""Refresh an existing activity collector with Microsoft tokens held in memory."""

import argparse
import datetime as dt
import http.client
import importlib.util
import importlib
import inspect
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import local_usage_merged
import local_usage_github
import local_usage_contributions

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
                known = records.get(row["day"])
                if status == "unavailable" and known and known["tokenStatus"] != "unavailable":
                    records[row["day"]] = {**known, "tokenStatus": "partial"}
                else:
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
    def __init__(self, config_dir, author_emails, projects=None):
        self.config_dir = config_dir
        self.author_emails = {email.lower() for email in author_emails}
        self.lock = threading.Lock()
        self.client = None
        self.account = None
        self.http = urllib.request.build_opener(NoRedirect())
        self.projects = projects

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
        body, continuation = self.request(str(args[5]), timeout)
        if continuation:
            data = json.loads(body)
            if not isinstance(data, dict) or data.get("continuationToken") not in (None, continuation):
                raise ValueError("Conflicting ADO continuation metadata")
            data["continuationToken"] = continuation
            return json.dumps(data, separators=(",", ":"))
        return body

    def request(self, url, timeout):
        target = urllib.parse.urlsplit(url)
        old_path = re.fullmatch(
            r"/[^/]+/_apis/connectionData|/[^/]+/[^/]+/_apis/git/(?:pullrequests|repositories/[^/]+/(?:pullrequests|pullrequests/\d+/commits|commits/[0-9a-f]{40}(?:[0-9a-f]{24})?))",
            target.path, re.I)
        new_path = re.fullmatch(
            r"/[^/]+/[^/]+/_apis/git/(?:repositories|repositories/[0-9a-f-]{36}/(?:refs|commits))",
            target.path, re.I)
        if (
            target.scheme != "https"
            or target.hostname != "dev.azure.com"
            or target.port not in (None, 443)
            or target.username is not None
            or target.password is not None
            or target.fragment
            or not (old_path or new_path)
        ):
            raise ValueError("Usage permits only Azure DevOps identity and PR endpoints")
        parts = target.path.strip("/").split("/")
        scope = tuple(urllib.parse.unquote(part).casefold() for part in parts[:2])
        if self.projects is not None and (scope[0] not in {org for org, _ in self.projects} or
                len(parts) > 3 and scope not in self.projects):
            raise ValueError("ADO request is outside configured projects")
        if new_path:
            query = urllib.parse.parse_qs(target.query, keep_blank_values=True, strict_parsing=True)
            if any(len(values) != 1 for values in query.values()) or query.get("api-version") != ["7.1"]:
                raise ValueError("Invalid ADO request parameters")
            suffix = parts[-1]
            if suffix == "repositories":
                allowed = {"api-version", "includeHidden"} if "includeHidden" in query else {"api-version"}
                if "includeHidden" in query and query["includeHidden"] != ["true"]:
                    raise ValueError("Invalid hidden repository inventory request")
            elif suffix == "refs":
                allowed = {"api-version", "filter"}
                if not query.get("filter", [""])[0].startswith("heads/"):
                    raise ValueError("Invalid ADO branch filter")
            else:
                allowed = {"api-version", "searchCriteria.itemVersion.version", "searchCriteria.itemVersion.versionType", "$top", "$skip"}
                if (not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", query.get("searchCriteria.itemVersion.version", [""])[0], re.I)
                        or query.get("searchCriteria.itemVersion.versionType") != ["commit"]
                        or not query.get("$top", [""])[0].isdigit() or not 1 <= int(query["$top"][0]) <= 100
                        or not query.get("$skip", [""])[0].isdigit() or int(query["$skip"][0]) > 1_000_000):
                    raise ValueError("Invalid pinned ADO commit page")
            if set(query) != allowed:
                raise ValueError("Unexpected ADO request parameters")
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


def ado_project_scopes(config):
    scopes = set()
    for raw in config.get("mergedAdoProjects", []) + config.get("adoRemotes", []):
        parsed = urllib.parse.urlsplit(raw)
        parts = parsed.path.strip("/").split("/")
        if (parsed.scheme != "https" or parsed.hostname != "dev.azure.com" or parsed.port not in (None, 443)
                or parsed.username or parsed.password or parsed.query or parsed.fragment or len(parts) not in (2, 4)
                or len(parts) == 4 and parts[2] != "_git"):
            raise ValueError("Invalid configured ADO project")
        org, project = (urllib.parse.unquote(part).casefold() for part in parts[:2])
        if not org or not project or any(part in (".", "..") or "/" in part or "\\" in part for part in (org, project)):
            raise ValueError("Invalid configured ADO project")
        scopes.add((org, project))
    return scopes


def primary_config(config):
    profiles = config.get("githubProfiles")
    if not isinstance(profiles, list) or not profiles or any(not isinstance(row, dict) or
            not all(isinstance(row.get(key), str) and row[key] for key in ("host", "login", "stableId", "profile"))
            for row in profiles):
        raise ValueError("Verified GitHub Profile identities are required")
    scopes = ado_project_scopes(config)
    principals = config.get("adoPrincipals")
    aliases = config.get("adoAuthorEmails")
    if (not scopes or not isinstance(principals, dict) or set(principals) != {org for org, _ in scopes}
            or not isinstance(aliases, list) or not aliases or len(set(aliases)) != len(aliases)
            or any(not isinstance(alias, str) or alias != alias.lower() or "@" not in alias for alias in aliases)):
        raise ValueError("Verified ADO principals and scoped author aliases are required")
    historical = {value.casefold() for value in config.get("authorEmails", [])}
    for org, principal in principals.items():
        if (not isinstance(principal, dict) or not isinstance(principal.get("stableId"), str)
                or not re.fullmatch(r"[0-9a-fA-F-]{36}", principal["stableId"])
                or principal.get("alias") not in aliases or principal["alias"] not in historical):
            raise ValueError("ADO principal does not match scoped author aliases")
    return scopes


def _primary_worker():
    try:
        request = json.load(sys.stdin)
        config = request["config"]
        stage = request["stage"]
        collector_path = Path(request["collector"])
        azure_dir = Path(request["azureDir"])
        if stage == "legacy":
            refresh(collector_path, config, azure_dir, publish=request["publish"],
                    skip_api=request["skipApi"], reuse_sources=request["reuseSources"], force_legacy=True,
                    legacy_diagnostics=False)
            return
        if stage not in ("github", "ado"):
            raise ValueError("Unknown contribution worker")
        collector = load_collector(collector_path)
        module = importlib.import_module("local_usage_profile" if stage == "github" else "local_usage_ado")
        azure = AzureMemorySession(azure_dir, config["adoAuthorEmails"], projects=ado_project_scopes(config))

        def run(args, timeout=35):
            if str(args[0]) == config["azureCli"]:
                return azure.run(args, timeout)
            return collector.run(args, timeout)

        at = dt.datetime.fromisoformat(request["at"])
        result = module.collect(config, run, collector.remote_category, at=at, days=60, previous=request["previous"])
        local_usage_contributions.envelope(result, stage)
        output = Path(request["output"])
        data = (json.dumps(result, separators=(",", ":")) + "\n").encode()
        if len(data) > local_usage_contributions.MAX_BYTES:
            raise ValueError("Contribution worker output exceeds limit")
        fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception as error:
        print(f"usage stage=primary-worker status=unavailable type={type(error).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None


def _stop_worker(process):
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    process.wait(timeout=5)


def refresh_primary(collector_path, config, azure_config_dir, *, publish=False, reuse_sources=False,
                    file=None, whole_cycle_seconds=285, include_legacy=True):
    primary_config(config)
    target = Path(file or Path.home() / ".local/share/mymausbot/usage/contributions-v2.json")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not 0 < whole_cycle_seconds <= 285:
        raise ValueError("Contribution cycle must stay within the existing five-minute job")
    with local_usage_contributions.target_lock(target):
        previous = local_usage_contributions.load_previous(target)
        at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        deadline = time.monotonic() + whole_cycle_seconds
        processes = {}
        with tempfile.TemporaryDirectory(prefix="contributions-capture-", dir=target.parent) as temporary:
            try:
                for stage in (("github", "ado", "legacy") if include_legacy else ("github", "ado")):
                    request = {"stage": stage, "collector": str(collector_path), "config": config,
                               "azureDir": str(azure_config_dir), "at": at.isoformat(),
                               "previous": previous.get(stage) if previous and stage != "legacy" else None,
                               "output": str(Path(temporary) / (stage + ".json")),
                               "publish": publish, "skipApi": False, "reuseSources": reuse_sources}
                    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--worker"],
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        start_new_session=True)
                    processes[stage] = process
                    process.stdin.write(json.dumps(request).encode())
                    process.stdin.close()
                results = {}
                for stage, process in processes.items():
                    try:
                        process.wait(timeout=max(0.01, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        _stop_worker(process)
                        results[stage] = "timeout"
                    else:
                        results[stage] = "ready" if process.returncode == 0 else "unavailable"
                if results["github"] != "ready" or results["ado"] != "ready":
                    raise ValueError("Remote contribution capture is incomplete; previous generation retained")
                current = {"version": 2, **{stage: json.loads((Path(temporary) / (stage + ".json")).read_text())
                    for stage in ("github", "ado")}}
                local_usage_contributions.validate_bindings(current, config)
                local_usage_contributions.write_private(target, current)
                print(json.dumps({"primary": "published", "legacy": results.get("legacy", "not-run"),
                    "asOfAt": current["github"]["asOfAt"], "sources": len(current["github"]["sources"]) + len(current["ado"]["sources"]),
                    "elapsedSeconds": round(whole_cycle_seconds - max(0, deadline - time.monotonic()), 1)}))
                return current
            finally:
                for process in processes.values():
                    if process.poll() is None:
                        _stop_worker(process)


def refresh(collector_path, config, azure_config_dir, *, publish=False, skip_api=False, reuse_sources=False,
            force_legacy=False, legacy_diagnostics=True):
    if config.get("primaryContributionSource") == "contributions-v2" and not force_legacy:
        if skip_api:
            return refresh(collector_path, config, azure_config_dir, publish=publish,
                           skip_api=True, reuse_sources=reuse_sources, force_legacy=True, legacy_diagnostics=False)
        return refresh_primary(collector_path, config, azure_config_dir, publish=publish, reuse_sources=reuse_sources)
    collector = load_collector(collector_path)
    original_run = collector.run
    azure = AzureMemorySession(azure_config_dir, config["authorEmails"], projects=ado_project_scopes(config) or None)

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
        if legacy_diagnostics and (config.get("githubProfiles") or config.get("mergedAdoProjects") or config.get("adoRemotes")):
            try:
                local_usage_merged.refresh(config, collector, collector.run, ado_request=azure.request, skip_api=skip_api)
            except Exception as error:
                print("Remote merged Usage unavailable: " + type(error).__name__, file=sys.stderr)
        if legacy_diagnostics and config.get("githubContributionSource") == local_usage_github.DEFINITION:
            try:
                local_usage_github.refresh(config, collector.run, collector.remote_category, skip_api=skip_api)
            except Exception as error:
                print("GitHub contribution Usage unavailable: " + type(error).__name__, file=sys.stderr)


def main():
    if sys.argv[1:] == ["--worker"]:
        return _primary_worker()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collector", type=Path, required=True)
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/agent-town/activity.json")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--skip-api", action="store_true")
    parser.add_argument("--reuse-sources", action="store_true")
    parser.add_argument("--capture-only", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.expanduser().read_text())
    azure_dir = Path(os.environ.get("AZURE_CONFIG_DIR", str(Path.home() / ".azure"))).expanduser()
    if args.capture_only:
        if args.output is None or args.publish or args.skip_api or args.reuse_sources:
            parser.error("Private capture requires --output and no publication or skip flags")
        return refresh_primary(args.collector.expanduser(), config, azure_dir,
                               file=args.output.expanduser(), include_legacy=False)
    if args.output is not None:
        parser.error("--output is only available for private capture")
    refresh(args.collector.expanduser(), config, azure_dir, publish=args.publish,
            skip_api=args.skip_api, reuse_sources=args.reuse_sources)


if __name__ == "__main__":
    main()
