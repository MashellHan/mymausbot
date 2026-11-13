import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactFiles, fullRunEvidence, github, pages, runJobs, runPlan } from "./github.mjs";
import { eligibleRun, fullRunPlan, issueLabels, triageOf } from "./contracts.mjs";
import { FULL_QA_FRESHNESS_MS, qaHealth } from "./health.mjs";
import { scanProcesses } from "./scan.mjs";
import { backlogSlot, beijingDay, planBacklog } from "./backlog.mjs";

export function queueItems(issues, prs, now = Date.now()) {
  const items = [];
  for (const issue of issues) {
    const labels = issueLabels(issue);
    const epoch = issue.body?.match(/"triageEpoch":"([^"]+)"/)?.[1] ?? issue.created_at;
    const { due, owner, complete: triaged } = triageOf(issue);
    let action, kind;
    if (labels.includes("qa:verified")) { action = "verify closure with Reviewer and integrated fix evidence"; kind = "verify"; }
    else if (!triaged) {
      kind = now - Date.parse(epoch) > 30 * 60_000 ? "overdue-triage" : "triage";
      action = kind === "overdue-triage" ? "overdue triage" : "triage within 30 minutes";
    } else if (Date.parse(due) < now) { action = `overdue repair owned by ${owner}, due ${due}`; kind = "overdue-repair"; }
    if (action) items.push({ key: `issue:${issue.number}:${epoch}:${kind}`, text: `${issue.html_url}: ${action}` });
  }
  for (const pr of prs.filter((item) => !item.draft && item.body?.match(/^QA-Handoff:\s*([a-f0-9]{40})\s*$/m)?.[1] === item.head.sha)) {
    items.push({ key: `pr:${pr.number}:${pr.head.sha}`, text: `${pr.html_url}: review/CI handoff for ${pr.head.sha}` });
  }
  return items;
}

export async function recoverQa(state, { api = github, readArtifact = artifactFiles, health = qaHealth, now = Date.now(), repository = process.env.GITHUB_REPOSITORY } = {}) {
  const runs = (await api("/actions/workflows/ci.yml/runs?branch=main&per_page=100")).workflow_runs.filter((run) => eligibleRun(run, repository, false));
  const sinceInstallation = (run) => !state.startedAt || Date.parse(run.created_at) >= Date.parse(state.startedAt);
  const fullRuns = [];
  let latest, unreportable, pendingPlan = false, completedSeen = false;
  for (const run of runs) {
    if (completedSeen && run.status === "completed") continue;
    let evidence = await fullRunEvidence(run, { api, readArtifact, repository, now });
    if (evidence === "full" && run.status === "completed" && run.event !== "push") {
      const jobs = await runJobs(run.id, run.run_attempt, api);
      const artifacts = await pages(`/actions/runs/${run.id}/artifacts`, "artifacts", api);
      const plan = await runPlan(run, jobs, artifacts, { api, readArtifact });
      if (!plan || !fullRunPlan(plan)) {
        evidence = "unknown";
        unreportable = { runId: run.id, sha: run.head_sha, attempt: run.run_attempt, conclusion: run.conclusion,
          reason: plan ? "invalid_full_plan" : "missing_trusted_plan" };
      }
    }
    if (evidence === "pending") pendingPlan = true;
    if (run.status === "completed" && (evidence === "full" || evidence === "unknown")) completedSeen = true;
    if (evidence !== "full") continue;
    fullRuns.push(run);
    if (run.status === "completed" && (sinceInstallation(run) || run.event === "push")) latest = run;
  }
  const qa = await health({ api, readArtifact, repository, now });
  const reporterRuns = (await api("/actions/workflows/qa-report.yml/runs?per_page=100")).workflow_runs;
  const reporting = reporterRuns.some((run) => run.status !== "completed");
  const reported = new Set(reporterRuns.filter((run) => run.conclusion === "success").map((run) => Number(run.display_title?.match(/^QA report (\d+)$/)?.[1])));
  let backlog;
  if (!reporting) for (const run of [...runs].reverse()) {
    if (run.status !== "completed" || !sinceInstallation(run) || reported.has(run.id) || run.id === unreportable?.runId) continue;
    if (fullRuns.includes(run)) { backlog = run; break; }
    const evidence = await fullRunEvidence(run, { api, readArtifact, repository, now });
    if (evidence !== "full") continue;
    if (run.event !== "push") {
      const jobs = await runJobs(run.id, run.run_attempt, api);
      const artifacts = await pages(`/actions/runs/${run.id}/artifacts`, "artifacts", api);
      const plan = await runPlan(run, jobs, artifacts, { api, readArtifact });
      if (!plan || !fullRunPlan(plan)) continue;
    }
    backlog = run;
    break;
  }
  const deliver = !qa.report && latest ? latest : backlog;
  if (deliver && !reporting) {
    const key = `${deliver.id}:${deliver.run_attempt}`;
    const last = state.reportRetry?.[key];
    if (!last || now - last > 30 * 60_000) {
      await api("/actions/workflows/qa-report.yml/dispatches", { method: "POST", body: { ref: "main", inputs: { run_id: String(deliver.id) } } });
      state.reportRetry = { ...state.reportRetry, [key]: now };
    }
  }
  const executionMissing = !latest || now - Date.parse(latest.updated_at) > FULL_QA_FRESHNESS_MS || qa.report && !qa.report.executionComplete;
  const anchor = runs.find((run) => run.event === "schedule")?.id ?? "bootstrap";
  const activeFull = fullRuns.find((run) => run.status !== "completed");
  const dispatch = executionMissing && !pendingPlan && !activeFull && state.recoveryFor !== anchor;
  if (dispatch) {
    await api("/actions/workflows/ci.yml/dispatches", { method: "POST", body: { ref: "main" } });
    state.recoveryFor = anchor;
    state.recoveryRequestedAt = new Date(now).toISOString();
  }
  const candidate = !executionMissing ? latest : activeFull;
  state.lastRecoveryDecision = {
    at: new Date(now).toISOString(),
    action: dispatch ? "dispatch" : !executionMissing || activeFull ? "reuse" : pendingPlan ? "wait" : "hold",
    reason: dispatch ? !latest ? "no_completed_full" : qa.report && !qa.report.executionComplete ? "incomplete_report" : "stale_completed_full"
      : !executionMissing ? "fresh_completed_full" : activeFull ? "active_full" : pendingPlan ? "pending_plan" : unreportable?.reason ?? "recovery_already_requested",
    candidate: candidate ? { runId: candidate.id, sha: candidate.head_sha, attempt: candidate.run_attempt,
      event: candidate.event, status: candidate.status } : null,
    ...(unreportable ? { unreportable } : {}),
    anchor,
  };
  return qa;
}

export function promptLead(message, { binary = process.env.MAUSBOT_HERDR || "herdr", session = process.env.MAUSBOT_HERDR_SESSION || "default", lead = "mausbot-lead" } = {}) {
  const command = (...args) => execFileSync(binary, ["--session", session, "agent", ...args], { encoding: "utf8", timeout: 45_000, maxBuffer: 128_000 });
  let agent, screen;
  try {
    agent = JSON.parse(command("get", lead)).result.agent;
    screen = command("read", lead, "--source", "visible", "--lines", "20");
    if (!agent?.interactive_ready || !["working", "done", "idle"].includes(agent.agent_status) || /Would you like|Allow this|approval required|Yes, proceed/i.test(screen)) {
      throw new Error("Lead is not ready for a queue handoff");
    }
  } catch (error) {
    throw Object.assign(error, { notSubmitted: true });
  }
  const receipt = JSON.parse(command("prompt", lead, message));
  return { submittedAt: new Date().toISOString(), pane: agent.pane_id, receipt };
}

export async function drainQueue(state, { api = github, recover = recoverQa, scan = scanProcesses, send = promptLead, save = () => {}, now = Date.now() } = {}) {
  state.startedAt ??= new Date(now).toISOString();
  const qa = await recover(state, { api, now });
  save(state);
  const issues = (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
  const prs = await pages("/pulls?state=open", null, api);
  let processItems = [];
  try {
    state.process ??= {};
    state.lastProcessScan = await scan(state.process, { api, now, prs, issues, publish: true });
    processItems = state.lastProcessScan.handoffs;
  } catch (error) {
    state.lastProcessScan = { at: new Date(now).toISOString(), outcome: "incomplete", error: error.message };
  }
  save(state);
  if (state.pending) return { sent: false, uncertain: true, state };
  const day = beijingDay(now), slot = backlogSlot(now);
  const daily = state.backlog?.lastDailyDay !== day;
  const followup = state.backlog?.lastFollowupSlot !== slot;
  let backlogItems = [];
  if (daily || followup) {
    const allOpen = await pages("/issues?state=open", null, api);
    state.backlog ??= { records: {} };
    state.backlog.records ??= {};
    const plan = planBacklog(allOpen, prs, state.backlog.records, now, { daily, followup });
    for (const item of plan.observed) state.backlog.records[item.number] = { ...state.backlog.records[item.number], ...item };
    if (daily) {
      const openIds = new Set(plan.observed.map((item) => item.number));
      const missing = Object.values(state.backlog.records).filter((item) => !openIds.has(item.number)
        && !["closed", "closed_evidence_pending"].includes(item.stage)).slice(0, 4);
      for (const item of missing) {
        const closed = await api(`/issues/${item.number}`);
        if (closed.state !== "closed" || !closed.closed_at) continue;
        const evidence = closed.body?.match(/^QA-(?:Closure|Disposition)-Evidence:\s*(.+)$/m)?.[1]
          ?? closed.body?.match(/<!-- lead-qa-close:[a-z0-9:-]+ -->/)?.[0];
        state.backlog.records[item.number] = { ...item, stage: evidence ? "closed" : "closed_evidence_pending",
          closedAt: closed.closed_at, closureEvidence: evidence ?? null };
      }
      const needsEvidence = Object.values(state.backlog.records).filter((item) => item.stage === "closed_evidence_pending").slice(0, 4);
      if (needsEvidence.length) plan.items[0].text += `\nClosed items awaiting exact disposition evidence: ${needsEvidence.map((item) => `#${item.number}`).join(", ")}. Verify on the original issue; do not infer completion.`;
    }
    state.backlog.lastInventory = plan.inventory;
    if (daily) plan.items[0].text += `\nComplete compact inventory: ${process.env.MAUSBOT_QA_STATE || "the existing queue state file"} -> backlog.records. Lead reviews deferred entries there before selecting later bounded work.`;
    backlogItems = plan.items;
    save(state);
  }
  const selectedIds = new Set(backlogItems.flatMap((entry) => entry.selected.map((item) => item.number)));
  const qaItems = queueItems(issues, prs, now);
  const ordinary = [...qaItems, ...processItems];
  const covered = ordinary.filter((item) => selectedIds.has(Number(item.key.match(/^issue:(\d+):/)?.[1]
    ?? item.subject?.match(/^issue:(\d+)$/)?.[1])));
  const items = [...qaItems.filter((item) => !state.seen?.[item.key] && !covered.includes(item)).slice(0, 6),
    ...processItems.filter((item) => !state.seen?.[item.key] && !covered.includes(item)).slice(0, 4), ...backlogItems];
  if (!qa.healthy) {
    const key = `qa-unavailable:${qa.report?.runId ?? "no-report"}:${new Date(now).toISOString().slice(0, 10)}`;
    if (!state.seen?.[key]) items.push({ key, text: `QA coverage reduction disabled: ${qa.reason}. Check the shared recovery/report delivery; do not start a full matrix for each PR.` });
  }
  if (!items.length) return { sent: false, state };
  const fingerprint = createHash("sha256").update(items.map((item) => item.key).join("\n")).digest("hex").slice(0, 16);
  state.pending = { fingerprint, items: items.map((item) => item.key), covered: covered.map((item) => item.key),
    status: "submitting", at: new Date(now).toISOString() };
  save(state);
  const message = `MausBot QA queue ${fingerprint}. Preserve your active task; handle this handoff at the next safe boundary.\n${items.map((item) => `- ${item.text}`).join("\n")}\nFollow docs/MAUSBOT-VALIDATION.md. Triage with priority, classification, scope, QA-Owner, QA-Next and QA-Due; acknowledge in the issue/PR. Assign repairs to an existing developer, dispatch independent review, and close only with verification. This is a role handoff authorized by 大雄, not permission to change the live App.`;
  try {
    state.lastDelivery = await send(message);
    state.seen = { ...state.seen, ...Object.fromEntries([...items, ...covered].map((item) => [item.key, new Date(now).toISOString()])) };
    if (daily || followup) {
      if (daily) state.backlog.lastDailyDay = day;
      if (followup) state.backlog.lastFollowupSlot = slot;
      for (const item of backlogItems.flatMap((entry) => entry.selected)) {
        const record = state.backlog.records[item.number];
        record.lastNotifiedAt = new Date(now).toISOString();
        record.delivery = { status: "notification_sent", at: record.lastNotifiedAt, fingerprint };
      }
    }
    delete state.pending;
    save(state);
    return { sent: true, fingerprint, state };
  } catch (error) {
    if (error.notSubmitted) delete state.pending;
    else { state.pending.status = "uncertain"; state.pending.error = error.message; }
    save(state);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.env.MAUSBOT_QA_STATE;
  if (!path) throw new Error("MAUSBOT_QA_STATE is required");
  mkdirSync(dirname(path), { recursive: true });
  const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1 };
  const save = (value) => { writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(`${path}.tmp`, path); };
  const result = await drainQueue(state, { save });
  console.log(JSON.stringify({ at: new Date().toISOString(), sent: result.sent, uncertain: result.uncertain ?? false,
    recovery: result.state.lastRecoveryDecision }));
}
