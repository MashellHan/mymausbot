"""Private China-day model and agent totals from the existing activity collector's events."""

from collections import defaultdict
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import types

FIELDS = ("input", "output", "cacheRead")
MAX_DAILY_MODELS = 24
MAX_DAILY_AGENTS = 64
MAX_LABEL_LENGTH = 120
MAX_CODEX_FILES = 4096
MAX_CODEX_FILE_BYTES = 64 * 1024 * 1024
MAX_CODEX_SCAN_BYTES = 256 * 1024 * 1024
MAX_HEADER_BYTES = 256 * 1024
MAX_CONTINUITY_BYTES = 2 * 1024 * 1024
MAX_CLOSED_INTERVALS = 2048
CONTINUITY_RETENTION_DAYS = 65
WRITER_CADENCE_SECONDS = 300
MAX_CONTINUITY_GAP_SECONDS = 450
MAX_SAMPLE_SPAN_SECONDS = 450
PROVIDERS = {"codex", "copilot", "hermes", "pi"}
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.+-]*(?:/[A-Za-z0-9][A-Za-z0-9_.+-]*)?")
WORKSPACE_ID_RE = re.compile(r"^w\d+$")
PANE_ID_RE = re.compile(r"^w\d+:p[0-9A-Za-z]+$")
UUID_RE = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.I)
UUID_FILE_RE = re.compile(r"-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$", re.I)
MAX_COUNT = 2**53 - 1


def eligible_machines(collector, machines, at):
    if at is None:
        return machines
    return [{**machine, "tokens": [row for row in machine.get("tokens", [])
              if (timestamp := collector.instant(row.get("at"))) is not None and timestamp < at]}
            for machine in machines]


def model_label(provider, model):
    return (isinstance(provider, str) and provider in PROVIDERS and isinstance(model, str)
            and len(model) <= 120 and model.lower() != "unknown" and MODEL.fullmatch(model))


def daily_models(collector, machines, snapshot):
    days = {row["day"] for source in (snapshot.get("localHistory", {}).get("daily", []), snapshot["daily"])
            for row in source if "day" in row and row.get("tokenStatus") != "unavailable"}
    if not days:
        return {}
    groups = defaultdict(dict)
    seen = set()
    for machine in machines:
        for record in machine.get("tokens", []):
            key = record["key"]
            if key in seen:
                continue
            seen.add(key)
            day = collector.day(collector.instant(record["at"]))
            model, provider = record.get("model"), record.get("provider")
            counts = {field: collector.count(record.get(field)) for field in FIELDS}
            if day not in days or not model_label(provider, model) or not any(counts.values()):
                continue
            row = groups[day].setdefault((provider, model), {"provider": provider, "model": model, **dict.fromkeys(FIELDS, 0)})
            for field in FIELDS:
                row[field] += counts[field]
    return {day: sorted(rows.values(), key=lambda row: (
        -sum(row[field] for field in FIELDS), row["model"], row["provider"]))[:MAX_DAILY_MODELS]
        for day, rows in groups.items()}


def validate_models(rows, totals):
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_DAILY_MODELS:
        return None
    seen, amounts, result = set(), dict.fromkeys(FIELDS, 0), []
    for row in rows:
        try:
            provider, model = row["provider"], row["model"]
            values = {field: row[field] for field in FIELDS}
        except (KeyError, TypeError):
            return None
        if not model_label(provider, model) or (provider, model) in seen or not any(values.values()) or any(
                type(value) is not int or not 0 <= value <= MAX_COUNT for value in values.values()):
            return None
        seen.add((provider, model))
        for field in FIELDS:
            amounts[field] += values[field]
        result.append({"provider": provider, "model": model, **values})
    if any(amounts[field] > totals[field] for field in FIELDS):
        return None
    return result


def _clean_label(value):
    if not isinstance(value, str) or not value or len(value) > MAX_LABEL_LENGTH:
        return None
    if value.strip() != value or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return None
    return value


def _utc_instant(value):
    if isinstance(value, dt.datetime):
        return value.replace(tzinfo=dt.timezone.utc) if value.tzinfo is None else value.astimezone(dt.timezone.utc)
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=dt.timezone.utc) if parsed.tzinfo is None else parsed.astimezone(dt.timezone.utc)


def _iso_utc(value):
    return _utc_instant(value).isoformat().replace("+00:00", "Z")


def _occupant_id(pane_id, name, source, value):
    raw = f"{pane_id}\0{name}\0{source}\0{value}".encode("utf-8")
    return "o" + hashlib.sha256(raw).hexdigest()[:16]


def _root_of(sid, parents):
    cur = sid
    visited = set()
    while cur in parents and cur not in visited:
        visited.add(cur)
        cur = parents[cur]
    return cur


def _herdr_binary(home):
    found = shutil.which("herdr")
    if found:
        return found
    for candidate in (home / ".local/bin/herdr", Path("/opt/homebrew/bin/herdr"), Path("/usr/local/bin/herdr")):
        if candidate.is_file() and not candidate.is_symlink() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def _run_herdr(home, args, herdr_runner=None):
    if herdr_runner is not None:
        return herdr_runner(args)
    try:
        real_home = Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    except KeyError:
        return None
    if os.environ.get("OMB_SEALED_FIXTURE") or home.resolve() != real_home or Path.home().resolve() != real_home:
        return None
    binary = _herdr_binary(home)
    if not binary:
        return None
    try:
        return subprocess.check_output(
            [binary, *args], text=True, timeout=4, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def _herdr_sock_generation(home):
    sock = home / ".config/herdr/herdr.sock"
    try:
        st = os.stat(sock, follow_symlinks=False)
    except OSError:
        return None
    if not stat.S_ISSOCK(st.st_mode):
        return None
    return f"sock:{st.st_dev}:{st.st_ino}:{st.st_ctime_ns}"


def sample_herdr(config=None, *, at=None, herdr_runner=None):
    home_value = config.get("home") if isinstance(config, dict) else None
    home = Path(home_value).expanduser() if isinstance(home_value, str) and home_value else Path.home()
    sampled_at = _utc_instant(at) if at is not None else dt.datetime.now(dt.timezone.utc)
    if sampled_at is None:
        return None
    sock_before = _herdr_sock_generation(home) if herdr_runner is None else None
    ws_raw = _run_herdr(home, ["--session", "default", "workspace", "list"], herdr_runner)
    ag_raw = _run_herdr(home, ["--session", "default", "agent", "list"], herdr_runner)
    sock_after = _herdr_sock_generation(home) if herdr_runner is None else None
    if not isinstance(ws_raw, str) or not isinstance(ag_raw, str) or not ws_raw or not ag_raw:
        return None
    try:
        ws_doc = json.loads(ws_raw)
        ag_doc = json.loads(ag_raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(ws_doc, dict) or not isinstance(ag_doc, dict):
        return None
    ws_result = ws_doc.get("result")
    ag_result = ag_doc.get("result")
    if not isinstance(ws_result, dict) or not isinstance(ag_result, dict):
        return None
    workspaces = ws_result.get("workspaces")
    agents = ag_result.get("agents")
    if not isinstance(workspaces, list) or not isinstance(agents, list) or len(workspaces) > 100 or len(agents) > 200:
        return None

    if herdr_runner is None and sock_before != sock_after:
        return None
    ws_raw_gen = ws_doc.get("server_generation")
    ag_raw_gen = ag_doc.get("server_generation")
    if ws_raw_gen is not None or ag_raw_gen is not None:
        ws_gen = _clean_label(ws_raw_gen)
        ag_gen = _clean_label(ag_raw_gen)
        if ws_gen is None or ag_gen is None or ws_gen != ag_gen:
            return None
        if herdr_runner is None:
            if sock_before is None:
                generation = None
            else:
                digest = hashlib.sha256(f"{ws_gen}\x00{sock_before}".encode("utf-8")).hexdigest()[:32]
                generation = f"gen:{digest}"
        else:
            generation = ws_gen
    elif herdr_runner is None:
        generation = sock_before
    else:
        generation = None

    team_names = {}
    for workspace in workspaces:
        if not isinstance(workspace, dict):
            return None
        wid = _clean_label(workspace.get("workspace_id"))
        if not wid or wid in team_names:
            return None
        team_names[wid] = _clean_label(workspace.get("label")) or wid

    seen_panes = set()
    name_counts = defaultdict(int)
    key_counts = defaultdict(int)
    session_claims = defaultdict(set)
    parsed_agents = []
    for agent in agents:
        if not isinstance(agent, dict):
            return None
        pane_id = _clean_label(agent.get("pane_id"))
        wid = _clean_label(agent.get("workspace_id"))
        if not pane_id or pane_id in seen_panes or not wid or wid not in team_names:
            return None
        seen_panes.add(pane_id)

        raw_name = agent.get("name")
        if isinstance(raw_name, str):
            name_counts[raw_name] += 1

        session = agent.get("agent_session")
        if isinstance(session, dict):
            sess_source = session.get("source") if isinstance(session.get("source"), str) else None
            raw_val = session.get("value")
            codex_sid = (
                raw_val.lower()
                if agent.get("agent") == "codex"
                and session.get("agent") == "codex"
                and session.get("kind") == "id"
                and isinstance(raw_val, str)
                and UUID_RE.fullmatch(raw_val)
                else None
            )
            key_val = codex_sid if codex_sid is not None else (raw_val if isinstance(raw_val, str) else None)
            if sess_source is not None or key_val is not None:
                key_counts[(sess_source, key_val)] += 1
            if isinstance(raw_val, str) and UUID_RE.fullmatch(raw_val):
                session_claims[raw_val.lower()].add(pane_id)
        else:
            key_counts[(None, None)] += 1

        parsed_agents.append((agent, pane_id, wid, raw_name, session))

    panes = {}
    for agent, pane_id, wid, raw_name, session in parsed_agents:
        if not WORKSPACE_ID_RE.fullmatch(wid) or not PANE_ID_RE.fullmatch(pane_id) or not pane_id.startswith(f"{wid}:"):
            continue
        if agent.get("agent") != "codex" or not isinstance(session, dict):
            continue
        if session.get("agent") != "codex" or session.get("kind") != "id" or session.get("source") != "herdr:codex":
            continue
        raw_val = session.get("value")
        name = _clean_label(raw_name)
        if not name or name_counts[raw_name] != 1 or not isinstance(raw_val, str) or not UUID_RE.fullmatch(raw_val):
            continue
        sid_lower = raw_val.lower()
        if key_counts[("herdr:codex", sid_lower)] != 1:
            continue
        raw_terminal = agent.get("terminal_id")
        terminal_id = None
        if raw_terminal is not None:
            terminal_id = _clean_label(raw_terminal)
            if terminal_id is None:
                continue
        entry = {
            "paneId": pane_id,
            "occupantId": _occupant_id(pane_id, raw_name, "herdr:codex", raw_val),
            "sessionId": sid_lower,
            "name": name,
            "teamId": wid,
            "teamName": team_names[wid],
        }
        if terminal_id is not None:
            entry["terminalId"] = terminal_id
        panes[pane_id] = entry

    conflicted = {sid for sid, holders in session_claims.items() if len(holders) > 1}
    clean_panes = {pane_id: entry for pane_id, entry in panes.items() if entry["sessionId"] not in conflicted}
    return {
        "sampledAt": sampled_at,
        "generation": generation,
        "panes": clean_panes,
        "conflictedSessions": conflicted,
        "allSessions": set(session_claims.keys()),
    }


def _valid_interval_entry(raw, *, closed):
    if not isinstance(raw, dict):
        return None
    pane_id = _clean_label(raw.get("paneId"))
    occupant_id = _clean_label(raw.get("occupantId"))
    session_id = raw.get("sessionId")
    name = _clean_label(raw.get("name"))
    team_id = _clean_label(raw.get("teamId"))
    team_name = _clean_label(raw.get("teamName"))
    if (
        not pane_id
        or not occupant_id
        or not isinstance(session_id, str)
        or not UUID_RE.fullmatch(session_id)
        or not name
        or not team_id
        or not team_name
        or not WORKSPACE_ID_RE.fullmatch(team_id)
        or not PANE_ID_RE.fullmatch(pane_id)
        or not pane_id.startswith(f"{team_id}:")
    ):
        return None
    raw_terminal = raw.get("terminalId")
    terminal_id = None
    if raw_terminal is not None:
        terminal_id = _clean_label(raw_terminal)
        if terminal_id is None:
            return None
    start_raw = raw.get("startAt" if closed else "observedSince")
    end_raw = raw.get("endAt" if closed else "lastVerifiedAt")
    start_at = _utc_instant(start_raw)
    end_at = _utc_instant(end_raw)
    if start_at is None or end_at is None or end_at < start_at:
        return None
    entry = {
        "paneId": pane_id,
        "occupantId": occupant_id,
        "sessionId": session_id.lower(),
        "name": name,
        "teamId": team_id,
        "teamName": team_name,
        "startAt" if closed else "observedSince": _iso_utc(start_at),
        "endAt" if closed else "lastVerifiedAt": _iso_utc(end_at),
    }
    if terminal_id is not None:
        entry["terminalId"] = terminal_id
    return entry


def load_continuity(path):
    if path is None:
        return None
    try:
        target = Path(path)
        if target.is_symlink() or not target.is_file() or target.stat().st_size > MAX_CONTINUITY_BYTES:
            return None
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("healthy"), bool):
        return None
    last_sample = _utc_instant(data.get("lastSampleAt"))
    if last_sample is None:
        return None
    raw_gen = data.get("generation")
    generation = None
    if raw_gen is not None:
        generation = _clean_label(raw_gen)
        if generation is None:
            return None
    raw_active = data.get("active")
    raw_closed = data.get("closed")
    if not isinstance(raw_active, dict) or not isinstance(raw_closed, list) or len(raw_closed) > MAX_CLOSED_INTERVALS:
        return None
    active = {}
    for pane_id, entry in raw_active.items():
        if not isinstance(pane_id, str):
            return None
        clean = _valid_interval_entry(entry, closed=False)
        if clean is None or clean["paneId"] != pane_id:
            return None
        active[pane_id] = clean
    closed = []
    for entry in raw_closed:
        clean = _valid_interval_entry(entry, closed=True)
        if clean is None:
            return None
        closed.append(clean)
    return {
        "version": 1,
        "healthy": data["healthy"],
        "lastSampleAt": _iso_utc(last_sample),
        "generation": generation,
        "active": active,
        "closed": closed,
    }


def _same_binding(left, right):
    return (
        left["paneId"] == right["paneId"]
        and left["occupantId"] == right["occupantId"]
        and left["sessionId"] == right["sessionId"]
        and left["name"] == right["name"]
        and left["teamId"] == right["teamId"]
        and left["teamName"] == right["teamName"]
        and left.get("terminalId") == right.get("terminalId")
    )


def _to_closed(entry, start_iso, end_iso):
    closed_entry = {
        "paneId": entry["paneId"],
        "occupantId": entry["occupantId"],
        "sessionId": entry["sessionId"],
        "name": entry["name"],
        "teamId": entry["teamId"],
        "teamName": entry["teamName"],
        "startAt": start_iso,
        "endAt": end_iso,
    }
    if entry.get("terminalId") is not None:
        closed_entry["terminalId"] = entry["terminalId"]
    return closed_entry


def _parsed_interval(entry, *, closed):
    start_at = _utc_instant(entry["startAt" if closed else "observedSince"])
    end_at = _utc_instant(entry["endAt" if closed else "lastVerifiedAt"])
    return {
        "paneId": entry["paneId"],
        "occupantId": entry["occupantId"],
        "sessionId": entry["sessionId"],
        "name": entry["name"],
        "teamId": entry["teamId"],
        "teamName": entry["teamName"],
        "startAt": start_at,
        "endAt": end_at,
    }


def _sample_generation(sample):
    if not isinstance(sample, dict):
        return None, False
    clean = _clean_label(sample.get("generation"))
    return clean, clean is not None


def reconcile_continuity(prior, pre_sample, post_sample, *, now=None):
    prior_active = prior["active"] if isinstance(prior, dict) and isinstance(prior.get("active"), dict) else {}
    prior_closed = list(prior["closed"]) if isinstance(prior, dict) and isinstance(prior.get("closed"), list) else []
    prior_healthy = bool(prior.get("healthy")) if isinstance(prior, dict) else False
    prior_last = _utc_instant(prior.get("lastSampleAt")) if isinstance(prior, dict) else None
    prior_gen, prior_gen_ok = _sample_generation(prior)

    ref_now = _utc_instant(now) or dt.datetime.now(dt.timezone.utc)
    pre_at = _utc_instant(pre_sample.get("sampledAt")) if isinstance(pre_sample, dict) else None
    post_at = _utc_instant(post_sample.get("sampledAt")) if isinstance(post_sample, dict) else None
    pre_gen, pre_gen_ok = _sample_generation(pre_sample)
    post_gen, post_gen_ok = _sample_generation(post_sample)
    cutoff = ref_now - dt.timedelta(days=CONTINUITY_RETENTION_DAYS)

    closed = [
        entry
        for entry in prior_closed
        if (end_at := _utc_instant(entry.get("endAt"))) is not None and end_at >= cutoff
    ]

    if (
        not isinstance(pre_sample, dict)
        or not isinstance(post_sample, dict)
        or pre_at is None
        or post_at is None
        or post_at < pre_at
        or (post_at - pre_at).total_seconds() > MAX_SAMPLE_SPAN_SECONDS
        or not pre_gen_ok
        or not post_gen_ok
        or pre_gen != post_gen
    ):
        for entry in prior_active.values():
            obs = _utc_instant(entry.get("observedSince"))
            last = _utc_instant(entry.get("lastVerifiedAt"))
            if obs is not None and last is not None and obs < last and last >= cutoff:
                closed.append(_to_closed(entry, entry["observedSince"], entry["lastVerifiedAt"]))
        closed = closed[-MAX_CLOSED_INTERVALS:]
        last_at = post_at or pre_at or prior_last or ref_now
        next_gen = post_gen if post_gen_ok and post_gen is not None else (
            pre_gen if pre_gen_ok and pre_gen is not None else (prior_gen if prior_gen_ok else None)
        )
        next_state = {
            "version": 1,
            "healthy": False,
            "lastSampleAt": _iso_utc(last_at),
            "generation": next_gen,
            "active": {},
            "closed": closed,
        }
        intervals = [_parsed_interval(entry, closed=True) for entry in closed]
        return next_state, intervals

    pre_panes = pre_sample.get("panes") if isinstance(pre_sample.get("panes"), dict) else {}
    post_panes = post_sample.get("panes") if isinstance(post_sample.get("panes"), dict) else {}
    pre_conflicted = set(pre_sample.get("conflictedSessions") or ())
    post_conflicted = set(post_sample.get("conflictedSessions") or ())

    pre_iso = _iso_utc(pre_at)
    post_iso = _iso_utc(post_at)
    gap_seconds = (pre_at - prior_last).total_seconds() if prior_last is not None else None
    continuous_from_prior = (
        prior_healthy
        and prior_gen_ok
        and prior_gen == pre_gen
        and gap_seconds is not None
        and 0 <= gap_seconds <= MAX_CONTINUITY_GAP_SECONDS
    )

    carried_since = {}
    for pane_id, entry in prior_active.items():
        obs = _utc_instant(entry.get("observedSince"))
        last = _utc_instant(entry.get("lastVerifiedAt"))
        if obs is None or last is None or obs > last:
            continue
        pre_match = pre_panes.get(pane_id)
        sid = entry["sessionId"]
        matches_pre = (
            continuous_from_prior
            and pre_match is not None
            and _same_binding(entry, pre_match)
            and sid not in pre_conflicted
        )
        post_match = post_panes.get(pane_id)
        matches_post = (
            matches_pre
            and post_match is not None
            and _same_binding(entry, post_match)
            and sid not in post_conflicted
        )
        if matches_post:
            carried_since[pane_id] = entry["observedSince"]
        elif matches_pre:
            if obs < pre_at and pre_at >= cutoff:
                closed.append(_to_closed(entry, entry["observedSince"], pre_iso))
        else:
            if obs < last and last >= cutoff:
                closed.append(_to_closed(entry, entry["observedSince"], entry["lastVerifiedAt"]))

    next_active = {}
    provable_active = []
    for pane_id, post_entry in post_panes.items():
        sid = post_entry["sessionId"]
        if sid in pre_conflicted or sid in post_conflicted:
            continue
        pre_entry = pre_panes.get(pane_id)
        if pre_entry is not None and _same_binding(pre_entry, post_entry):
            obs_iso = carried_since.get(pane_id, pre_iso)
            active_entry = {**post_entry, "observedSince": obs_iso, "lastVerifiedAt": post_iso}
            next_active[pane_id] = active_entry
            provable_active.append(_parsed_interval(active_entry, closed=False))
        else:
            # Newly observed, moved, or rebound during [pre_at, post_at]; seed from post_at for future runs only.
            next_active[pane_id] = {**post_entry, "observedSince": post_iso, "lastVerifiedAt": post_iso}

    closed = closed[-MAX_CLOSED_INTERVALS:]
    next_state = {
        "version": 1,
        "healthy": True,
        "lastSampleAt": post_iso,
        "generation": post_gen,
        "active": next_active,
        "closed": closed,
    }
    intervals = [_parsed_interval(entry, closed=True) for entry in closed] + provable_active
    return next_state, intervals


def _codex_files(home):
    codex_dir = home / ".codex"
    if not codex_dir.is_dir() or codex_dir.is_symlink():
        return []
    files = []
    for sub in ("sessions", "archived_sessions"):
        base = codex_dir / sub
        if not base.is_dir() or base.is_symlink():
            continue
        for path in sorted(base.glob("**/*.jsonl")):
            try:
                if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CODEX_FILE_BYTES:
                    continue
            except OSError:
                continue
            files.append(path)
            if len(files) >= MAX_CODEX_FILES:
                return files
    return files


def _read_codex_header(path, *, only_if_forked=False):
    try:
        with path.open(encoding="utf-8", errors="replace") as stream:
            first = stream.readline(MAX_HEADER_BYTES + 1)
    except OSError:
        return None
    if not first or len(first) > MAX_HEADER_BYTES:
        return None
    if only_if_forked and '"forked_from_id"' not in first:
        return None
    try:
        meta = json.loads(first)
    except ValueError:
        return None
    if not isinstance(meta, dict) or meta.get("type") != "session_meta":
        return None
    payload = meta.get("payload")
    if not isinstance(payload, dict):
        return None
    sid = payload.get("id")
    if not isinstance(sid, str) or not sid:
        return None
    fk = payload.get("forked_from_id")
    return sid, fk if isinstance(fk, str) and fk else None


def _checked_codex_lines(stream, expected_sid, conflict_flag):
    first_seen = False
    for line in stream:
        if '"session_meta"' in line or any(marker in line[:1024] for marker in ('"turn_context"', '"token_count"')):
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict):
                continue
            payload = entry.get("payload")
            if entry.get("type") == "session_meta":
                entry_id = payload.get("id") if isinstance(payload, dict) else None
                if not isinstance(entry_id, str) or entry_id.lower() != expected_sid or first_seen:
                    conflict_flag[0] = True
                    return
                first_seen = True
            elif payload is not None and not isinstance(payload, dict):
                continue
            elif entry.get("type") == "event_msg" and isinstance(payload, dict) and payload.get("type") == "token_count":
                info = payload.get("info")
                if info is not None and not isinstance(info, dict):
                    continue
        yield line


def daily_agents(collector, machines, snapshot, config=None, intervals=None, *, pre_sample=None, post_sample=None, continuity=None):
    if not callable(getattr(collector, "codex_events", None)) or not isinstance(snapshot, dict) or not isinstance(machines, list):
        return {}
    local_history = snapshot.get("localHistory") if isinstance(snapshot.get("localHistory"), dict) else {}
    raw_sources = (
        local_history.get("daily") if isinstance(local_history.get("daily"), list) else [],
        snapshot.get("daily") if isinstance(snapshot.get("daily"), list) else [],
    )
    days = {
        row["day"]
        for source in raw_sources
        for row in source
        if isinstance(row, dict) and isinstance(row.get("day"), str) and row.get("tokenStatus") != "unavailable"
    }
    if not days:
        return {}

    if intervals is None:
        if pre_sample is None or post_sample is None:
            return {}
        _, intervals = reconcile_continuity(continuity, pre_sample, post_sample)
    if not intervals:
        return {}

    events = {}
    seen = set()
    min_at = None
    max_at = None
    for machine in machines:
        if not isinstance(machine, dict):
            continue
        tokens = machine.get("tokens")
        if not isinstance(tokens, list):
            continue
        for record in tokens:
            if not isinstance(record, dict):
                continue
            key = record.get("key")
            if not isinstance(key, str) or not key or key in seen:
                continue
            seen.add(key)
            if record.get("provider") != "codex":
                continue
            timestamp = collector.instant(record.get("at"))
            if timestamp is None:
                continue
            day = collector.day(timestamp)
            if day not in days:
                continue
            total = sum(collector.count(record.get(field)) for field in FIELDS)
            if total > 0:
                events[key] = (day, total, _utc_instant(timestamp))
                min_at = timestamp if min_at is None or timestamp < min_at else min_at
                max_at = timestamp if max_at is None or timestamp > max_at else max_at
    if not events or min_at is None or max_at is None:
        return {}

    by_sid = defaultdict(list)
    all_intervals = []
    for item in intervals:
        if not isinstance(item, dict):
            continue
        sid = item.get("sessionId")
        start_at = _utc_instant(item.get("startAt"))
        end_at = _utc_instant(item.get("endAt"))
        if not isinstance(sid, str) or start_at is None or end_at is None or end_at < start_at:
            continue
        owner = (item["paneId"], item["name"], item["teamId"], item["teamName"])
        by_sid[sid.lower()].append((start_at, end_at, owner))
        all_intervals.append((start_at, end_at))
    if not by_sid:
        return {}

    if not any(
        start_iv <= ev_at <= end_iv
        for _, _, ev_at in events.values()
        for start_iv, end_iv in all_intervals
    ):
        return {}

    home_value = config.get("home") if isinstance(config, dict) else None
    home = Path(home_value).expanduser() if isinstance(home_value, str) and home_value else Path.home()
    if not home.is_dir():
        return {}

    codex_files = _codex_files(home)
    if not codex_files:
        return {}

    parents_raw = {}
    parents_lower = {}
    file_sids = []
    for path in codex_files:
        match = UUID_FILE_RE.search(path.name)
        only_if_forked = bool(match and match.group(1).lower() not in by_sid)
        header = _read_codex_header(path, only_if_forked=only_if_forked)
        if header is None:
            continue
        sid, fk = header
        if fk:
            parents_raw[sid] = fk
            parents_lower[sid.lower()] = fk.lower()
        file_sids.append((path, sid.lower()))

    def _nearest_sid(sid_lower):
        cur = sid_lower
        visited = set()
        depth = 0
        while cur and cur not in visited and depth < 16:
            if cur in by_sid:
                return cur
            visited.add(cur)
            cur = parents_lower.get(cur)
            depth += 1
        return None

    matched_files = []
    for path, sid_lower in file_sids:
        target_sid = _nearest_sid(sid_lower)
        if target_sid is None:
            continue
        try:
            mtime_ns = path.stat().st_mtime_ns
        except OSError:
            continue
        matched_files.append((mtime_ns, path, sid_lower, target_sid))

    if not matched_files:
        return {}
    matched_files.sort(key=lambda item: -item[0])

    by_root = defaultdict(list)
    for sid_lower, sid_intervals in by_sid.items():
        root = _root_of(sid_lower, parents_lower)
        by_root[root].extend(sid_intervals)

    classify = types.SimpleNamespace(classify=lambda _cwd, _context=None: "unclassified")
    end_at = max_at + dt.timedelta(microseconds=1)
    key_owners = defaultdict(set)
    scan_bytes = 0
    for _, path, sid_lower, target_sid in matched_files:
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size > MAX_CODEX_FILE_BYTES or scan_bytes + size > MAX_CODEX_SCAN_BYTES:
            continue
        scan_bytes += size
        file_events = []
        conflict_flag = [False]
        try:
            with path.open(encoding="utf-8", errors="replace") as stream:
                for event in collector.codex_events(
                    _checked_codex_lines(stream, sid_lower, conflict_flag),
                    classify,
                    min_at,
                    end_at,
                    parents_raw,
                ):
                    if not isinstance(event, dict):
                        continue
                    key = event.get("key")
                    if key in events:
                        event_at = collector.instant(event.get("at")) if event.get("at") is not None else events[key][2]
                        event_at = _utc_instant(event_at)
                        if event_at is not None and event_at == events[key][2]:
                            file_events.append((key, event_at))
        except (OSError, TypeError, ValueError):
            continue
        if conflict_flag[0]:
            continue
        sid_intervals = by_sid[target_sid]
        root_intervals = by_root[_root_of(sid_lower, parents_lower)]
        for key, event_at in file_events:
            matched_owners = {owner for start_iv, end_iv, owner in sid_intervals if start_iv <= event_at <= end_iv}
            root_matched = {owner for start_iv, end_iv, owner in root_intervals if start_iv <= event_at <= end_iv}
            if len(matched_owners) == 1 and root_matched == matched_owners:
                key_owners[key].update(matched_owners)
            elif len(matched_owners) > 1 or len(root_matched) > 1:
                key_owners[key].update(matched_owners | root_matched)

    day_totals = defaultdict(lambda: defaultdict(int))
    for key, (day, total, _) in events.items():
        owners = key_owners.get(key)
        if owners and len(owners) == 1:
            day_totals[day][next(iter(owners))] += total

    return {
        day: sorted(
            (
                {"id": owner[0], "name": owner[1], "teamId": owner[2], "teamName": owner[3], "totalTokens": total}
                for owner, total in members.items()
                if total > 0
            ),
            key=lambda row: (-row["totalTokens"], row["teamId"], row["id"], row["name"]),
        )[:MAX_DAILY_AGENTS]
        for day, members in day_totals.items()
        if any(total > 0 for total in members.values())
    }


def validate_agents(rows, total_tokens):
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_DAILY_AGENTS:
        return None
    if type(total_tokens) is not int or not 0 <= total_tokens <= MAX_COUNT:
        return None
    seen = set()
    total = 0
    result = []
    for row in rows:
        if not isinstance(row, dict):
            return None
        row_id = _clean_label(row.get("id"))
        name = _clean_label(row.get("name"))
        team_id = _clean_label(row.get("teamId"))
        team_name = _clean_label(row.get("teamName"))
        tokens = row.get("totalTokens")
        if not row_id or not name or not team_id or not team_name or type(tokens) is not int or not 0 <= tokens <= MAX_COUNT:
            return None
        key = (team_id, row_id, name)
        if key in seen:
            return None
        seen.add(key)
        total += tokens
        if total > total_tokens:
            return None
        result.append({"id": row_id, "name": name, "teamId": team_id, "teamName": team_name, "totalTokens": tokens})
    return result
