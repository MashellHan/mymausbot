#!/usr/bin/env node
/**
 * Read-only Agent Team health & speed monitor.
 * Audits recent Antigravity CLI (agy) transcripts for a Herdr workspace, host CPU load,
 * stale git worktrees, stuck feature-dev `tsc` processes, and delivery backup counts.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, cpus, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { inspectLocalConcurrency } from "./local-concurrency.mjs";

const DEFAULT_WINDOW_MIN = 60;
const STALE_WORKTREE_DAYS = 2;
const WORKTREE_TOTAL_ALERT_THRESHOLD = 15;
const POLL_ALERT_THRESHOLD = 5;
const MAX_DELIVERY_BACKUPS = 3;

export function parseArgs(argv) {
  let workspace = "w6";
  let windowMin = DEFAULT_WINDOW_MIN;
  let json = false;
  let repoRoot = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" && argv[i + 1]) workspace = argv[++i];
    else if (arg === "--window-min" && argv[i + 1]) windowMin = Math.max(5, Math.min(1440, Number(argv[++i]) || DEFAULT_WINDOW_MIN));
    else if (arg === "--repo" && argv[i + 1]) repoRoot = resolve(argv[++i]);
    else if (arg === "--json") json = true;
  }
  return { workspace, windowMin, json, repoRoot };
}

export function analyzeTranscriptRows(rows, cutoffMs) {
  let prevTs = null;
  let modelSec = 0;
  let toolSec = 0;
  let llmCalls = 0;
  let polls = 0;
  let errors = 0;
  let tscRuns = 0;
  let buildRuns = 0;
  let checkReadyRuns = 0;
  let vitestRuns = 0;
  let reads = 0;
  let edits = 0;
  let contextK = 0;
  let model = null;
  const errorKinds = new Map();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const ts = typeof row.created_at === "string" ? Date.parse(row.created_at) : NaN;
    if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    const type = row.type;
    if (prevTs !== null) {
      const dt = (ts - prevTs) / 1000;
      if (dt > 0 && dt < 300) {
        if (type === "PLANNER_RESPONSE") modelSec += dt;
        else if (type === "GENERIC") toolSec += dt;
      }
    }
    if (type === "PLANNER_RESPONSE") {
      llmCalls += 1;
      if (typeof row.model === "string" && row.model) model = row.model;
      const inp = (Number(row.input_tokens) || 0) + (Number(row.cache_read_tokens) || 0);
      if (inp > 0) contextK = Math.round(inp / 1000);
      if (Array.isArray(row.tool_calls)) {
        for (const tc of row.tool_calls) {
          const name = String(tc?.name || "");
          if (name === "manage_task") polls += 1;
          else if (name === "read_file") reads += 1;
          else if (name === "edit_file" || name === "write_file") edits += 1;
          else if (name === "run_command") {
            const cmd = String(tc?.args?.CommandLine || "");
            if (/\b(?:tsc|typecheck)\b/.test(cmd)) tscRuns += 1;
            if (/(?:\bpnpm(?:\s+run)?\s+build\b|\bvite\s+build\b|build\.py|\belectron-builder\b|\bpackage:(?:mac|win|linux|arch)\b)/.test(cmd)) buildRuns += 1;
            if (/\bcheck:ready\b/.test(cmd)) checkReadyRuns += 1;
            if (/\bvitest\b/.test(cmd)) vitestRuns += 1;
          }
        }
      }
    } else if (type === "ERROR_MESSAGE") {
      errors += 1;
      const msg = String(row.error || "unknown").slice(0, 72);
      errorKinds.set(msg, (errorKinds.get(msg) || 0) + 1);
    }
    prevTs = ts;
  }

  return {
    model,
    contextK,
    llmCalls,
    avgLlmSec: llmCalls > 0 ? Number((modelSec / llmCalls).toFixed(1)) : 0,
    modelSec: Math.round(modelSec),
    toolSec: Math.round(toolSec),
    polls,
    errors,
    tscRuns,
    buildRuns,
    checkReadyRuns,
    vitestRuns,
    reads,
    edits,
    errorKinds: Object.fromEntries(errorKinds),
  };
}

export function detectAnomalies({ seats, load1m, cpuCount, totalWorktrees = 0, staleWorktrees, deliveryBackups, stuckTscCount }) {
  const anomalies = [];
  if (cpuCount > 0 && load1m >= cpuCount * 2) {
    anomalies.push({
      severity: "high",
      code: "cpu-saturation",
      detail: `1m load average ${load1m.toFixed(1)} exceeds 2x CPU count (${cpuCount}); parallel local checks/builds will thrash.`,
    });
  }
  if (stuckTscCount > 0) {
    anomalies.push({
      severity: "high",
      code: "feature-dev-tsc",
      detail: `${stuckTscCount} local tsc/typecheck process(es) running outside CI/build-owner.`,
    });
  }
  for (const seat of seats) {
    if (seat.polls > POLL_ALERT_THRESHOLD) {
      anomalies.push({
        severity: seat.polls >= 20 ? "high" : "medium",
        code: "poll-loop",
        seat: seat.name,
        detail: `${seat.name} called manage_task ${seat.polls} times in window (> ${POLL_ALERT_THRESHOLD}); wait for async completion notifications instead of polling.`,
      });
    }
    if (!/front|lead/i.test(seat.name) && (seat.tscRuns > 0 || seat.buildRuns > 0)) {
      anomalies.push({
        severity: "high",
        code: "dev-local-build",
        seat: seat.name,
        detail: `${seat.name} ran local tsc (${seat.tscRuns}) / build (${seat.buildRuns}) in window; feature devs must skip local tsc/builds and rely on CI + single build owner.`,
      });
    }
    if (seat.errors >= 5) {
      anomalies.push({
        severity: "medium",
        code: "upstream-errors",
        seat: seat.name,
        detail: `${seat.name} hit ${seat.errors} upstream model errors in window.`,
      });
    }
    if (seat.reads >= 80 && seat.edits === 0 && seat.llmCalls >= 40) {
      anomalies.push({
        severity: "low",
        code: "read-only-spin",
        seat: seat.name,
        detail: `${seat.name} did ${seat.reads} file reads and 0 edits across ${seat.llmCalls} steps; may be stuck exploring instead of opening a slice PR.`,
      });
    }
  }
  if (totalWorktrees > WORKTREE_TOTAL_ALERT_THRESHOLD || staleWorktrees > 0) {
    anomalies.push({
      severity: totalWorktrees >= 30 || staleWorktrees >= 10 ? "high" : "medium",
      code: "worktree-bloat",
      detail: `${totalWorktrees} total git worktrees (${staleWorktrees} older than ${STALE_WORKTREE_DAYS} days; threshold > ${WORKTREE_TOTAL_ALERT_THRESHOLD} total or > 0 stale); prune merged/detached worktrees to reduce git/Spotlight/usage-collector overhead.`,
    });
  }
  if (deliveryBackups > MAX_DELIVERY_BACKUPS) {
    anomalies.push({
      severity: "low",
      code: "backup-cap-exceeded",
      detail: `${deliveryBackups} delivery backup dirs in .omb-scratch/*-delivery-* (cap is ${MAX_DELIVERY_BACKUPS}).`,
    });
  }
  return anomalies;
}

function listHerdrAgents(workspace) {
  try {
    const raw = execFileSync("herdr", ["--session", "default", "agent", "list"], { encoding: "utf8", timeout: 4000 });
    const line = raw.split("\n").find((l) => l.startsWith("{"));
    if (!line) return [];
    const agents = JSON.parse(line)?.result?.agents;
    return Array.isArray(agents) ? agents.filter((a) => a.workspace_id === workspace) : [];
  } catch {
    return [];
  }
}

function countStaleWorktrees(repoRoot, nowMs) {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 5000 });
    const paths = out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9).trim());
    let stale = 0;
    for (const dir of paths.slice(1)) {
      try {
        const mt = statSync(dir).mtimeMs;
        if (nowMs - mt > STALE_WORKTREE_DAYS * 86_400_000) stale += 1;
      } catch {
        stale += 1;
      }
    }
    return { total: paths.length, stale };
  } catch {
    return { total: 0, stale: 0 };
  }
}

function countDeliveryBackups(repoRoot) {
  const scratch = join(repoRoot, ".omb-scratch");
  if (!existsSync(scratch)) return 0;
  try {
    return readdirSync(scratch).filter((name) => /-delivery-/.test(name)).length;
  } catch {
    return 0;
  }
}

function countStuckTsc() {
  try {
    const out = execFileSync("ps", ["-Ao", "pid,args"], { encoding: "utf8", timeout: 3000 });
    return out.split("\n").filter((line) => /[/\s]tsc\s/.test(line) && !/scripts\/team-health|desktop-job|-delivery-/.test(line)).length;
  } catch {
    return 0;
  }
}

export function collectTeamHealth({
  workspace = "w6",
  windowMin = DEFAULT_WINDOW_MIN,
  repoRoot = process.cwd(),
  home = homedir(),
  nowMs = Date.now(),
  lockDir,
  includeProcessScan = true,
} = {}) {
  const cutoffMs = nowMs - windowMin * 60_000;
  const agents = includeProcessScan ? listHerdrAgents(workspace) : [];
  const seats = agents.map((agent) => {
    const cid = agent?.agent_session?.value;
    const transcriptPath = typeof cid === "string" && cid
      ? join(home, ".gemini", "antigravity-cli", "brain", cid, ".system_generated", "logs", "transcript.jsonl")
      : null;
    let rows = [];
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        rows = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      } catch {
        rows = [];
      }
    }
    const stats = analyzeTranscriptRows(rows, cutoffMs);
    return {
      paneId: agent.pane_id,
      name: agent.name,
      status: agent.agent_status,
      ...stats,
    };
  });

  const cpuCount = cpus().length;
  const load1m = loadavg()[0] ?? 0;
  const worktrees = includeProcessScan ? countStaleWorktrees(repoRoot, nowMs) : { total: 0, stale: 0 };
  const deliveryBackups = countDeliveryBackups(repoRoot);
  const stuckTscCount = includeProcessScan ? countStuckTsc() : 0;
  const concurrency = inspectLocalConcurrency({
    ...(lockDir ? { lockDir } : {}),
    nowMs,
    ...(includeProcessScan ? {} : { detectBuildProcess: () => false }),
  });
  const anomalies = detectAnomalies({
    seats,
    load1m,
    cpuCount,
    totalWorktrees: worktrees.total,
    staleWorktrees: worktrees.stale,
    deliveryBackups,
    stuckTscCount,
  });

  return {
    capturedAt: new Date(nowMs).toISOString(),
    workspace,
    windowMin,
    host: { cpuCount, load1m: Number(load1m.toFixed(2)), worktrees, deliveryBackups, stuckTscCount, concurrency },
    seats,
    anomalies,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseArgs(process.argv.slice(2));
  const report = collectTeamHealth(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Team Health (${report.workspace}, last ${report.windowMin}m) — load1m=${report.host.load1m} / ${report.host.cpuCount} CPUs, worktrees=${report.host.worktrees.total} (${report.host.worktrees.stale} stale), backups=${report.host.deliveryBackups}, tsc=${report.host.stuckTscCount}, testSlots=${report.host.concurrency.activeTestCount}/${report.host.concurrency.maxSlots}${report.host.concurrency.buildActive ? ` [BUILD ACTIVE:${report.host.concurrency.buildSource}]` : ""}`);
    console.log("SEAT                STATUS   STEPS  AVG_S  POLLS  ERR  TSC  BUILD  VITEST  EDITS  CTX");
    for (const s of report.seats) {
      console.log(
        `${String(s.name).padEnd(19)} ${String(s.status).padEnd(8)} ${String(s.llmCalls).padStart(5)} ${String(s.avgLlmSec + "s").padStart(6)} ${String(s.polls).padStart(6)} ${String(s.errors).padStart(4)} ${String(s.tscRuns).padStart(4)} ${String(s.buildRuns).padStart(6)} ${String(s.vitestRuns).padStart(7)} ${String(s.edits).padStart(6)} ${String(s.contextK + "k").padStart(5)}`,
      );
    }
    if (report.anomalies.length) {
      console.log("\nAnomalies:");
      for (const a of report.anomalies) {
        console.log(`  [${a.severity.toUpperCase()}] ${a.code}: ${a.detail}`);
      }
    } else {
      console.log("\nNo anomalies detected.");
    }
  }
}
