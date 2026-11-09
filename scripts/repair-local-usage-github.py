#!/usr/bin/env python3
"""Prepare, apply or restore a reviewed seven-China-day private contribution repair."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import types

import local_usage_github as github

ROOT = Path(__file__).resolve().parent.parent
SOURCE_FILES = ("scripts/repair-local-usage-github.py", "scripts/local_usage_github.py", "scripts/local_usage_merged.py")
MAX_BYTES = 16 * 1024 * 1024
TARGET = Path.home() / ".local/share/mymausbot/usage/github-profile-v1.json"


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


def encoded(value):
    return (json.dumps(value, separators=(",", ":")) + "\n").encode()


def read_bytes(file):
    try:
        fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ValueError("Invalid repair artifact")
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Repair artifact exceeds size bound")
    return data


def atomic_bytes(file, data):
    if len(data) > MAX_BYTES:
        raise ValueError("Repair artifact exceeds size bound")
    fd, temporary = tempfile.mkstemp(prefix=file.name + ".", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, file)
        if os.name != "nt":
            directory = os.open(file.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def source_identity(collector):
    if not isinstance(collector["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", collector["sha256"]):
        raise ValueError("Invalid collector source pin")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    hashes = {}
    for name in SOURCE_FILES:
        data = read_bytes(ROOT / name)
        committed = subprocess.check_output(["git", "show", head + ":" + name], cwd=ROOT)
        if data != committed:
            raise ValueError("Repair source differs from its fixed commit")
        hashes[name] = sha(data)
    if sha(read_bytes(Path(collector["path"]))) != collector["sha256"]:
        raise ValueError("Collector source pin changed")
    return {"commit": head, "files": hashes, "collector": collector,
            "python": list(sys.version_info[:3])}


def validate_capture(current, now):
    at = github.instant(current["asOfAt"])
    first, last = github.capture_window(at)
    if (current.get("version") != 1 or current.get("metricDefinition") != github.DEFINITION
            or current.get("dateBasis") != github.DATE_BASIS or current.get("qualification") != "nonfork-at-capture"
            or current.get("operationWindow") != {"timeZone": "Asia/Shanghai", "startDay": str(first), "endDay": str(last), "todayPartial": True}
            or github.capture_window(now) != (first, last) or at > now
            or not at <= github.instant(current["capturedAt"]) <= now):
        raise ValueError("Repair definition, execution dates or cutoff mismatch")
    sources, active = current["sources"], current["activeSourceIds"]
    ids = [source["id"] for source in sources]
    if not ids or len(ids) > github.MAX_PROFILES or len(set(ids)) != len(ids) or set(ids) != set(active) or len(active) != len(ids):
        raise ValueError("Invalid repair account scope")
    dates = {str(first + dt.timedelta(days=offset)) for offset in range(7)}
    for source in sources:
        if (source["status"] not in ("ready", "partial") or not re.fullmatch(r"[a-f0-9]{64}", source["account"])
                or not re.fullmatch(r"[a-f0-9]{64}", source["id"])
                or not re.fullmatch(r"github\.com|[a-z0-9-]+\.ghe\.com", source["host"])
                or type(source["hasRestrictedContributions"]) is not bool
                or github.count(source["restrictedContributions"]) > 0 and not source["hasRestrictedContributions"]
                or len(source["days"]) != 7 or {row["day"] for row in source["days"]} != dates):
            raise ValueError("Unavailable or incomplete repair source")
        for row in source["days"]:
            if (row["status"] != "partial" or row["chinaCommits"] is not None or row["capturedAt"] != current["asOfAt"]
                    or row["inProgress"] is not (row["day"] == str(last))):
                raise ValueError("Repair must preserve partial date semantics")
            if (github.count(row["rawPrs"]) != github.count(row["knownPrs"]) + github.count(row["excludedForkPrs"])
                    or not isinstance(row["repositories"], list) or len(row["repositories"]) > 1000):
                raise ValueError("Invalid repair accounting")
            if row["profilePrs"] is not None:
                github.count(row["profilePrs"])
            repos = row["repositories"]
            repo_ids = [repo["id"] for repo in repos]
            if len(set(repo_ids)) != len(repo_ids):
                raise ValueError("Duplicate repair repository")
            for repo in repos:
                if (not re.fullmatch(r"[a-f0-9]{64}", repo["id"]) or repo["category"] not in ("work", "personal", "unclassified")
                        or len(repo["name"]) > 200 or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo["name"])
                        or (repo["profileCommits"] is None) != (row["profileCommits"] is None)):
                    raise ValueError("Invalid repair repository")
            if sum(github.count(repo["knownPrs"]) for repo in repos) != row["knownPrs"]:
                raise ValueError("Inconsistent repair PR references")
            if row["profileCommits"] is not None and sum(github.count(repo["profileCommits"]) for repo in repos) != github.count(row["profileCommits"]):
                raise ValueError("Inconsistent repair commit buckets")


def prepare(file, operation, config, run, repository_category, collector, *, at=None):
    now = at or dt.datetime.now(dt.timezone.utc)
    file, operation = Path(file).absolute(), Path(operation).absolute()
    if file == operation or operation in file.parents:
        raise ValueError("Snapshot directory cannot contain the live target")
    if config.get("githubContributionSource") != github.DEFINITION:
        raise ValueError("Contribution source has not been admitted")
    identity = source_identity(collector)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with github.target_lock(file):
        before = read_bytes(file)
        previous = json.loads(before) if before is not None else {}
        if before is not None and (not isinstance(previous, dict) or not previous):
            raise ValueError("Existing contribution cache is unreadable")
        current = github.collect(config, run, repository_category, at=now)
        finished = dt.datetime.now(dt.timezone.utc)
        validate_capture(current, finished)
        after = encoded(github.replace_days(previous, current))
        capture = encoded(current)
        if source_identity(collector) != identity:
            raise ValueError("Repair source changed during capture")
        operation.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        operation.mkdir(mode=0o700)
        if before is not None:
            atomic_bytes(operation / "before.bin", before)
        atomic_bytes(operation / "capture.json", capture)
        atomic_bytes(operation / "after.json", after)
        manifest = {"version": 1, "target": str(file), "source": identity,
                    "operationWindow": current["operationWindow"], "asOfAt": current["asOfAt"],
                    "beforeHash": sha(before), "captureHash": sha(capture), "afterHash": sha(after)}
        data = encoded(manifest)
        atomic_bytes(operation / "plan.json", data)
        return {"planSha256": sha(data), "operationWindow": current["operationWindow"],
                "beforeHash": sha(before), "afterHash": sha(after), "targetWritten": False}


def load_plan(file, operation, expected_hash):
    data = read_bytes(operation / "plan.json")
    if data is None or not re.fullmatch(r"[a-f0-9]{64}", expected_hash) or sha(data) != expected_hash:
        raise ValueError("Repair plan does not match the reviewed hash")
    manifest = json.loads(data)
    if manifest["version"] != 1 or manifest["target"] != str(file):
        raise ValueError("Repair plan target mismatch")
    if source_identity(manifest["source"]["collector"]) != manifest["source"]:
        raise ValueError("Repair source/runtime identity changed")
    before, capture, after = (read_bytes(operation / name) for name in ("before.bin", "capture.json", "after.json"))
    if (sha(before) != manifest["beforeHash"] or capture is None or sha(capture) != manifest["captureHash"]
            or after is None or sha(after) != manifest["afterHash"]):
        raise ValueError("Repair snapshot or payload changed")
    current = json.loads(capture)
    if manifest["operationWindow"] != current["operationWindow"] or manifest["asOfAt"] != current["asOfAt"]:
        raise ValueError("Repair capture binding mismatch")
    if encoded(github.replace_days(json.loads(before) if before is not None else {}, current)) != after:
        raise ValueError("Repair payload is not the bounded replacement")
    return manifest, current, before, after


def apply(file, operation, expected_hash, *, at=None):
    file, operation = Path(file).absolute(), Path(operation).absolute()
    with github.target_lock(file):
        manifest, current, before, after = load_plan(file, operation, expected_hash)
        validate_capture(current, at or dt.datetime.now(dt.timezone.utc))
        actual = read_bytes(file)
        if actual == after:
            return "unchanged"
        if actual != before:
            raise ValueError("Concurrent target change; refusing replacement")
        atomic_bytes(file, after)
        if sha(read_bytes(file)) != manifest["afterHash"]:
            raise ValueError("Repair persisted readback mismatch")
        return "applied"


def restore(file, operation, expected_hash):
    file, operation = Path(file).absolute(), Path(operation).absolute()
    with github.target_lock(file):
        _, _, before, after = load_plan(file, operation, expected_hash)
        actual = read_bytes(file)
        if actual == before:
            return "unchanged"
        if actual != after:
            raise ValueError("Concurrent target change; refusing restore")
        if before is None:
            file.unlink()
        else:
            atomic_bytes(file, before)
        if read_bytes(file) != before:
            raise ValueError("Restore persisted readback mismatch")
        return "restored"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    preparing = sub.add_parser("prepare", help="private snapshot and dry-run only; target is not replaced")
    preparing.add_argument("--config", type=Path, required=True)
    preparing.add_argument("--collector", type=Path, required=True)
    preparing.add_argument("--collector-sha256", required=True)
    for name in ("prepare", "apply", "restore"):
        command = preparing if name == "prepare" else sub.add_parser(name)
        command.add_argument("--operation-dir", type=Path, required=True)
        if name != "prepare":
            command.add_argument("--plan-sha256", required=True)
    args = parser.parse_args()
    if args.action == "prepare":
        collector = {"path": str(args.collector.expanduser().absolute()), "sha256": args.collector_sha256}
        source_identity(collector)
        module = types.ModuleType("repair_classification_source")
        module.__file__ = collector["path"]
        data = read_bytes(Path(collector["path"]))
        if sha(data) != collector["sha256"]:
            raise ValueError("Collector source pin changed")
        exec(compile(data, collector["path"], "exec"), module.__dict__)
        result = prepare(TARGET, args.operation_dir.expanduser(), json.loads(args.config.expanduser().read_text()),
                         module.run, module.remote_category, collector)
    else:
        action = apply if args.action == "apply" else restore
        result = action(TARGET, args.operation_dir.expanduser(), args.plan_sha256)
    print(json.dumps({"action": args.action, "result": result}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "refused", "errorType": type(error).__name__}))
        raise SystemExit(1) from None
