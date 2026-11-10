#!/usr/bin/env python3
"""Prepare, capture, seal, apply and roll back the versioned Activities source."""

import argparse
import ast
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shutil
import subprocess
import tempfile
import urllib.parse

import local_usage_contributions as contributions

HELPERS = ("refresh-local-usage.py", "local_usage_contributions.py", "local_usage_profile.py", "local_usage_profile_private.py",
           "local_usage_ado.py", "local_usage_merged.py", "local_usage_github.py")


def sha(path):
    path = Path(path)
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError("Migration path must be a regular file")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    os.chmod(path, 0o600)


def atomic(path, content, mode):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Migration target is a symlink")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verified_inputs(evidence_dir):
    adoption = read(evidence_dir / "lead-root-evidence-adoption.json")
    bound = {Path(item["path"]).name: item["sha256"] for item in adoption["rootEvidence"]}
    result = {}
    for name in ("account-api-verification.json", "ado-remote-inventory.json"):
        path = evidence_dir / name
        if sha(path) != bound.get(name):
            raise ValueError("Frozen identity evidence changed")
        result[name] = read(path)
    return result


def pinned_ado_authors(path):
    tree = ast.parse(Path(path).read_text())
    assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == "EMAILS" for target in node.targets)]
    if len(assignments) != 1:
        raise ValueError("Pinned ADO attribution proof has no unique EMAILS set")
    values = ast.literal_eval(assignments[0].value)
    if not isinstance(values, set) or not values or any(not isinstance(value, str) for value in values):
        raise ValueError("Pinned ADO attribution proof is invalid")
    return sorted(value.casefold() for value in values)


def migrated_config(config, evidence, ado_authors, private_candidate):
    if not isinstance(config, dict) or not isinstance(config.get("githubProfiles"), list):
        raise ValueError("Existing Activities account configuration is missing")
    profiles = evidence["account-api-verification.json"]
    by_profile = {row["profile"]: row["result"]["data"]["viewer"] for row in profiles}
    if len(by_profile) != len(profiles):
        raise ValueError("Duplicate verified Profile identity")
    updated = dict(config)
    github = []
    candidates = private_candidate.get("githubProfiles")
    if not isinstance(candidates, list) or len(candidates) != len(profiles):
        raise ValueError("Frozen private repository candidate does not cover configured Profiles")
    by_candidate = {row.get("profile"): row for row in candidates if isinstance(row, dict)}
    if len(by_candidate) != len(candidates):
        raise ValueError("Duplicate private Profile candidate")
    for profile in config["githubProfiles"]:
        profile = dict(profile)
        viewer = by_profile.get(profile.get("profile"))
        candidate = by_candidate.get(profile.get("profile"))
        if not viewer:
            raise ValueError("Configured Profile lacks verified identity")
        if (not candidate or candidate.get("host") != profile.get("host") or
                str(candidate.get("login", "")).casefold() != str(profile.get("login", "")).casefold() or
                candidate.get("stableId") != viewer["id"] or "visibilityProof" in candidate):
            raise ValueError("Private Profile candidate differs from verified identity")
        url = urllib.parse.urlsplit(viewer["url"])
        if (url.scheme != "https" or url.hostname != profile.get("host")
                or viewer["login"].casefold() != str(profile.get("login", "")).casefold()
                or not isinstance(viewer.get("id"), str) or not viewer["id"]):
            raise ValueError("Profile host, login or stable identity mismatch")
        profile["stableId"] = viewer["id"]
        private_repositories = candidate.get("privateRepositories")
        if (not isinstance(private_repositories, list) or len(private_repositories) > 16 or
                any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", item)
                    or any(part in (".", "..") for part in item.split("/")) for item in private_repositories) or
                len({item.casefold() for item in private_repositories}) != len(private_repositories)):
            raise ValueError("Invalid verified private repository candidate")
        profile.pop("visibilityProof", None)
        profile["privateRepositories"] = private_repositories
        github.append(profile)
    if len(github) != len(by_profile):
        raise ValueError("Verified Profile account set differs from configuration")
    identities = evidence["ado-remote-inventory.json"]["identities"]
    if not isinstance(ado_authors, list) or not ado_authors or len(set(ado_authors)) != len(ado_authors):
        raise ValueError("Scoped ADO author evidence is required")
    historical = {value.casefold() for value in config.get("authorEmails", [])}
    if any(not isinstance(value, str) or value != value.lower() or value not in historical for value in ado_authors):
        raise ValueError("ADO authors must be verified scoped historical aliases")
    principals = {}
    for org, person in identities.items():
        alias = person["account"].casefold()
        if alias not in ado_authors or not isinstance(person.get("id"), str):
            raise ValueError("ADO principal does not match scoped author evidence")
        principals[org.casefold()] = {"stableId": person["id"], "alias": alias}
    updated.update({"githubProfiles": github, "adoPrincipals": principals,
                    "adoAuthorEmails": ado_authors, "primaryContributionSource": "contributions-v2"})
    helper = private_candidate.get("githubHelper")
    if not isinstance(helper, str) or not helper:
        raise ValueError("Frozen GitHub account helper is missing")
    updated["githubHelper"] = helper
    return updated


def user_home():
    return Path(pwd.getpwuid(os.getuid()).pw_dir)


def primary_cache():
    return user_home() / ".local/share/mymausbot/usage/contributions-v2.json"


def launch_agent(path, helpers_dir, config_path, collector_path, azure_dir, python_path, cache_path):
    with Path(path).open("rb") as stream:
        value = plistlib.load(stream)
    arguments = value.get("ProgramArguments")
    defaults = {"config": user_home() / ".config/agent-town/activity.json",
                "azure": user_home() / ".azure", "cache": primary_cache()}
    expected = [str(python_path), str(helpers_dir / "refresh-local-usage.py"), "--collector", str(collector_path)]
    if (value.get("StartInterval") != 300 or not isinstance(arguments, list)
            or arguments not in (expected, [*expected, "--config", str(config_path)])
            or arguments == expected and config_path != defaults["config"]
            or str(python_path) != arguments[0] or not python_path.is_file()
            or azure_dir != defaults["azure"] or cache_path != defaults["cache"]):
        raise ValueError("Existing five-minute scheduled helper is not the selected installation")
    environment = value.get("EnvironmentVariables") or {}
    if (not isinstance(environment, dict) or set(environment) != {"PATH", "PYTHONUNBUFFERED"}
            or not isinstance(environment.get("PATH"), str) or not environment["PATH"]
            or environment.get("PYTHONUNBUFFERED") != "1"):
        raise ValueError("Scheduled runtime overrides the reviewed default identity or auth directory")
    working = value.get("WorkingDirectory")
    if working is not None and (not isinstance(working, str) or not Path(working).is_absolute() or not Path(working).is_dir()):
        raise ValueError("Scheduled working directory is unavailable")
    return {"label": value["Label"], "python": arguments[0], "arguments": arguments,
            "environment": environment, "workingDirectory": working, "defaults": {key: str(path) for key, path in defaults.items()}}


def paths(plan):
    manifest = read(plan / "prepared-plan.json")
    return manifest, Path(manifest["config"]), Path(manifest["cache"]), Path(manifest["helpersDir"]), Path(manifest["sourceHelpers"])


def scheduled_runtime(manifest):
    if sha(manifest["launchAgent"]) != manifest["launchAgentSha256"]:
        raise ValueError("Scheduled command changed after plan preparation")
    runtime = launch_agent(manifest["launchAgent"], Path(manifest["helpersDir"]), Path(manifest["config"]),
                           Path(manifest["collector"]), Path(manifest["azureConfigDir"]), Path(manifest["python"]), Path(manifest["cache"]))
    if runtime != manifest["launchRuntime"]:
        raise ValueError("Scheduled runtime changed after plan preparation")
    return runtime


def prepare(args):
    plan = Path(args.plan_dir)
    if plan.exists():
        raise ValueError("A migration plan already exists")
    config_path, target, helpers = Path(args.config), Path(args.cache), Path(args.helpers_dir)
    source = Path(args.app) / "Contents/Resources/usage-helpers"
    runtime = launch_agent(args.launch_agent, helpers, config_path, Path(args.collector), Path(args.azure_config_dir),
                           Path(args.python), target)
    evidence = verified_inputs(Path(args.evidence_dir))
    candidate_path = Path(args.private_profile_candidate)
    if sha(candidate_path) != args.expected_private_profile_sha256:
        raise ValueError("Frozen private repository candidate hash changed")
    if pinned_ado_authors(args.ado_author_proof) != sorted(args.ado_author_email):
        raise ValueError("Scoped ADO aliases differ from the operator's proof")
    current = read(config_path)
    candidate = migrated_config(current, evidence, args.ado_author_email, read(candidate_path))
    if not source.is_dir() or any(sha(source / name) is None for name in HELPERS):
        raise ValueError("Reviewed App lacks a required contribution helper")
    if any(path.is_symlink() for path in (config_path, target, helpers, source)):
        raise ValueError("Migration path is a symlink")
    plan.mkdir(mode=0o700, parents=True)
    before = plan / "before"
    before.mkdir(mode=0o700)
    old = {"config": sha(config_path), "cache": sha(target),
           "helpers": {name: sha(helpers / name) for name in HELPERS}}
    shutil.copy2(config_path, before / "config.json")
    if target.exists():
        shutil.copy2(target, before / "contributions-v2.json")
    for name in HELPERS:
        if (helpers / name).exists():
            shutil.copy2(helpers / name, before / name)
    write_json(plan / "candidate-config.json", candidate)
    manifest = {"version": 1, "preparedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "sourceApp": str(args.app), "sourceHelpers": str(source), "sourceHelperHashes": {name: sha(source / name) for name in HELPERS},
        "config": str(config_path), "cache": str(target), "helpersDir": str(helpers),
        "launchAgent": str(args.launch_agent), "launchAgentSha256": sha(args.launch_agent), "launchRuntime": runtime,
        "identityEvidence": str(args.evidence_dir), "identityEvidenceSha256": {
            name: sha(Path(args.evidence_dir) / name) for name in ("account-api-verification.json", "ado-remote-inventory.json")},
        "adoAuthorProof": str(args.ado_author_proof), "adoAuthorProofSha256": sha(args.ado_author_proof),
        "privateProfileCandidate": str(candidate_path), "privateProfileCandidateSha256": sha(candidate_path),
        "old": old, "candidateConfigSha256": sha(plan / "candidate-config.json"),
        "collector": str(args.collector), "azureConfigDir": str(args.azure_config_dir), "python": str(args.python)}
    write_json(plan / "prepared-plan.json", manifest)
    print(json.dumps({"status": "PREPARED_PRIVATE_ONLY", "plan": str(plan / "prepared-plan.json"),
                      "candidateConfigSha256": manifest["candidateConfigSha256"]}))


def capture(args):
    plan = Path(args.plan_dir)
    manifest, _, _, _, source = paths(plan)
    if (plan / "sealed-plan.json").exists():
        raise ValueError("Sealed migration capture is immutable")
    if sha(plan / "candidate-config.json") != manifest["candidateConfigSha256"] or any(
            sha(source / name) != expected for name, expected in manifest["sourceHelperHashes"].items()):
        raise ValueError("Migration source or candidate configuration changed")
    runtime = scheduled_runtime(manifest)
    person = pwd.getpwuid(os.getuid())
    environment = {"HOME": str(user_home()), "USER": person.pw_name, "LOGNAME": person.pw_name,
                   **runtime["environment"]}
    command = [runtime["python"], str(source / "refresh-local-usage.py"), "--collector", manifest["collector"],
               "--config", str(plan / "candidate-config.json"), "--capture-only", "--output", str(plan / "candidate-cache.json")]
    result = subprocess.run(command, cwd=runtime["workingDirectory"] or str(user_home()),
                            env=environment, capture_output=True, text=True, timeout=300)
    log = plan / "capture.log"
    log.write_text(result.stdout + result.stderr)
    os.chmod(log, 0o600)
    if result.returncode:
        raise ValueError("Private capture failed under the scheduled Python/runtime; inspect private log")
    print(json.dumps({"status": "CAPTURED_PRIVATE_ONLY", "cacheSha256": sha(plan / "candidate-cache.json")}))


def seal(args):
    plan = Path(args.plan_dir)
    manifest, _, _, _, source = paths(plan)
    scheduled_runtime(manifest)
    if (plan / "sealed-plan.json").exists():
        raise ValueError("Migration plan is already sealed")
    candidate = read(plan / "candidate-config.json")
    contribution = contributions.validate_bindings(read(plan / "candidate-cache.json"), candidate)
    profiles = {(row["host"].casefold(), row["login"].casefold(), row["stableId"]) for row in candidate["githubProfiles"]}
    principals = candidate["adoPrincipals"]
    for row in contribution["github"]["sources"]:
        account = row["account"]
        if (account["host"].casefold(), account["login"].casefold(), account["stableId"]) not in profiles:
            raise ValueError("Captured GitHub source differs from migrated identity")
    for row in contribution["ado"]["sources"]:
        account, scope = row["account"], row["scope"]
        principal = principals.get(scope["organization"].casefold())
        if not principal or account["stableId"].casefold() != principal["stableId"].casefold() or account["login"].casefold() != principal["alias"]:
            raise ValueError("Captured ADO source differs from migrated principal")
    if sha(plan / "candidate-config.json") != manifest["candidateConfigSha256"] or any(
            sha(source / name) != expected for name, expected in manifest["sourceHelperHashes"].items()):
        raise ValueError("Migration source changed before sealing")
    sealed = {**manifest, "sealedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "candidateCacheSha256": sha(plan / "candidate-cache.json"),
        "sourceCoverage": {provider: [{"status": row["status"], "coverage": row["coverage"]}
            for row in contribution[provider]["sources"]] for provider in ("github", "ado")},
        "operationWindow": contribution["github"]["operationWindow"]}
    write_json(plan / "sealed-plan.json", sealed)
    print(json.dumps({"status": "SEALED_FOR_REVIEW", "planSha256": sha(plan / "sealed-plan.json"),
                      "operationWindow": sealed["operationWindow"]}))


def validate_live(plan, sealed):
    scheduled_runtime(sealed)
    if (sha(sealed["privateProfileCandidate"]) != sealed["privateProfileCandidateSha256"] or
            sha(sealed["adoAuthorProof"]) != sealed["adoAuthorProofSha256"]):
        raise ValueError("Frozen attribution or private repository evidence changed")
    source = Path(sealed["sourceHelpers"])
    if any(sha(source / name) != expected for name, expected in sealed["sourceHelperHashes"].items()):
        raise ValueError("Signed helper source changed after plan review")
    if sha(plan / "candidate-config.json") != sealed["candidateConfigSha256"] or sha(plan / "candidate-cache.json") != sealed["candidateCacheSha256"]:
        raise ValueError("Migration candidate changed after plan review")


def compare_state(path, old, new):
    current = sha(path)
    if current not in (old, new):
        raise ValueError("A live migration target changed outside the reviewed plan")
    return current


@contextmanager
def legacy_capture_exclusion(config, plan_hash):
    storage = Path(config["storageDir"]).expanduser()
    if not storage.is_dir() or storage.is_symlink():
        raise ValueError("Existing Activity storage is unavailable")
    lock = storage / ".refresh.lock"
    lock.mkdir(mode=0o700)
    inode = lock.stat().st_ino
    marker = lock / ".migration-plan-sha256"
    marker.write_text(plan_hash)
    try:
        yield
    finally:
        if lock.stat().st_ino != inode or marker.read_text() != plan_hash:
            raise ValueError("Migration exclusion ownership changed")
        marker.unlink()
        lock.rmdir()


def transition(args, rollback=False):
    plan = Path(args.plan_dir)
    sealed = read(plan / "sealed-plan.json")
    if sha(plan / "sealed-plan.json") != args.expected_plan_sha256:
        raise ValueError("The reviewed migration plan hash does not match")
    validate_live(plan, sealed)
    config, target, helpers, source = (Path(sealed[key]) for key in ("config", "cache", "helpersDir", "sourceHelpers"))
    candidates = [(helpers / name, plan / "before" / name, source / name, sealed["old"]["helpers"][name],
                   sealed["sourceHelperHashes"][name]) for name in HELPERS]
    candidates += [(target, plan / "before/contributions-v2.json", plan / "candidate-cache.json",
                    sealed["old"]["cache"], sealed["candidateCacheSha256"]),
                   (config, plan / "before/config.json", plan / "candidate-config.json",
                    sealed["old"]["config"], sealed["candidateConfigSha256"])]
    current_config = read(config)
    with legacy_capture_exclusion(current_config, args.expected_plan_sha256), contributions.target_lock(target):
        for path, old_file, new_file, old_hash, new_hash in candidates:
            compare_state(path, old_hash, new_hash)
            if old_hash is not None and sha(old_file) != old_hash or sha(new_file) != new_hash:
                raise ValueError("Migration backup or signed source changed")
        selected = list(reversed(candidates)) if rollback else candidates
        if not rollback and sha(config) == sealed["candidateConfigSha256"] and any(
                sha(path) != new_hash for path, _, _, _, new_hash in candidates):
            raise ValueError("Enabled configuration has incomplete installed source")
        for path, old_file, new_file, old_hash, new_hash in selected:
            desired = old_hash if rollback else new_hash
            if sha(path) == desired:
                continue
            if desired is None:
                path.unlink()
            else:
                content = (old_file if rollback else new_file).read_bytes()
                mode = 0o600 if path in (target, config) else 0o644
                atomic(path, content, mode)
            if sha(path) != desired:
                raise ValueError("Migration write did not retain the reviewed bytes")
    receipt = {"recordedAtUtc": dt.datetime.now(dt.timezone.utc).isoformat(),
        "operation": "rollback" if rollback else "apply", "planSha256": args.expected_plan_sha256,
        "configSha256": sha(config), "cacheSha256": sha(target), "helpersSha256": {name: sha(helpers / name) for name in HELPERS},
        "launchAgentSha256": sha(sealed["launchAgent"]), "liveTargetReadback": True}
    write_json(plan / ("rollback-result.json" if rollback else "apply-result.json"), receipt)
    print(json.dumps({"status": "ROLLED_BACK" if rollback else "APPLIED", "receipt": str(plan / ("rollback-result.json" if rollback else "apply-result.json"))}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    first = sub.add_parser("prepare")
    for key in ("plan-dir", "config", "cache", "helpers-dir", "app", "launch-agent", "evidence-dir", "ado-author-proof", "private-profile-candidate", "expected-private-profile-sha256", "collector", "azure-config-dir", "python"):
        first.add_argument("--" + key, required=True)
    first.add_argument("--ado-author-email", action="append", required=True)
    for command in ("capture", "seal", "apply", "rollback"):
        item = sub.add_parser(command)
        item.add_argument("--plan-dir", required=True)
        if command in ("apply", "rollback"):
            item.add_argument("--expected-plan-sha256", required=True)
    args = parser.parse_args()
    if args.command == "prepare": prepare(args)
    elif args.command == "capture": capture(args)
    elif args.command == "seal": seal(args)
    else: transition(args, rollback=args.command == "rollback")


if __name__ == "__main__":
    main()
