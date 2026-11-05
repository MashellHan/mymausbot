import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { github, pages } from "./github.mjs";
import { eligibleRun, issueLabels, triageOf } from "./contracts.mjs";
import { qaHealth } from "./health.mjs";

export function queueItems(issues, prs, now = Date.now()) {
  const items = [];
  for (const issue of issues) {
    const labels = issueLabels(issue);
    const epoch = issue.body?.match(/"triageEpoch":"([^"]+)"/)?.[1] ?? issue.created_at;
    const { due, owner, complete: triaged } = triageOf(issue);
    let action;
    if (labels.includes("qa:verified")) action = "verify closure with Reviewer and integrated fix evidence";
    else if (!triaged) action = now - Date.parse(epoch) > 30 * 60_000 ? "overdue triage" : "triage within 30 minutes";
    else if (Date.parse(due) < now) action = `overdue repair owned by ${owner}, due ${due}`;
    if (action) items.push({ key: `issue:${issue.number}:${epoch}:${action}`, text: `${issue.html_url}: ${action}` });
  }
  for (const pr of prs.filter((item) => !item.draft && item.body?.match(/^QA-Handoff:\s*([a-f0-9]{40})\s*$/m)?.[1] === item.head.sha)) {
    items.push({ key: `pr:${pr.number}:${pr.head.sha}`, text: `${pr.html_url}: review/CI handoff for ${pr.head.sha}` });
  }
  return items;
}

export async function recoverQa(state, { api = github, health = qaHealth, now = Date.now(), repository = process.env.GITHUB_REPOSITORY } = {}) {
  const runs = (await api("/actions/workflows/ci.yml/runs?branch=main&per_page=100")).workflow_runs.filter((run) => eligibleRun(run, repository, false));
  const fullRuns = runs.filter((run) => eligibleRun(run, repository));
  const sinceInstallation = (run) => !state.startedAt || Date.parse(run.created_at) >= Date.parse(state.startedAt);
  const latest = fullRuns.find((run) => run.status === "completed" && sinceInstallation(run));
  const qa = await health({ api, repository, now });
  const reporterRuns = (await api("/actions/workflows/qa-report.yml/runs?per_page=100")).workflow_runs;
  const reporting = reporterRuns.some((run) => run.status !== "completed");
  const reported = new Set(reporterRuns.filter((run) => run.conclusion === "success").map((run) => Number(run.display_title?.match(/^QA report (\d+)$/)?.[1])));
  const backlog = runs.filter((run) => run.status === "completed" && sinceInstallation(run)
    && !reported.has(run.id)).at(-1);
  const deliver = !qa.report && latest ? latest : backlog;
  if (deliver && !reporting) {
    const key = `${deliver.id}:${deliver.run_attempt}`;
    const last = state.reportRetry?.[key];
    if (!last || now - last > 30 * 60_000) {
      await api("/actions/workflows/qa-report.yml/dispatches", { method: "POST", body: { ref: "main", inputs: { run_id: String(deliver.id) } } });
      state.reportRetry = { ...state.reportRetry, [key]: now };
    }
  }
  const executionMissing = !latest || now - Date.parse(latest.updated_at) > 14 * 60 * 60_000 || qa.report && !qa.report.executionComplete;
  const anchor = fullRuns.find((run) => run.event === "schedule")?.id ?? "bootstrap";
  if (executionMissing && !fullRuns.some((run) => run.status !== "completed") && state.recoveryFor !== anchor) {
    await api("/actions/workflows/ci.yml/dispatches", { method: "POST", body: { ref: "main" } });
    state.recoveryFor = anchor;
    state.recoveryRequestedAt = new Date(now).toISOString();
  }
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

export async function drainQueue(state, { api = github, recover = recoverQa, send = promptLead, save = () => {}, now = Date.now() } = {}) {
  state.startedAt ??= new Date(now).toISOString();
  const qa = await recover(state, { api, now });
  save(state);
  const issues = (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
  const prs = await pages("/pulls?state=open", null, api);
  const items = queueItems(issues, prs, now).filter((item) => !state.seen?.[item.key]);
  if (!qa.healthy) {
    const key = `qa-unavailable:${qa.report?.runId ?? "no-report"}:${new Date(now).toISOString().slice(0, 10)}`;
    if (!state.seen?.[key]) items.push({ key, text: `QA coverage reduction disabled: ${qa.reason}. Check the shared recovery/report delivery; do not start a full matrix for each PR.` });
  }
  if (!items.length) return { sent: false, state };
  const fingerprint = createHash("sha256").update(items.map((item) => item.key).join("\n")).digest("hex").slice(0, 16);
  if (state.pending) return { sent: false, uncertain: true, state };
  state.pending = { fingerprint, items: items.map((item) => item.key), status: "submitting", at: new Date(now).toISOString() };
  save(state);
  const message = `MausBot QA queue ${fingerprint}. Preserve your active task; handle this handoff at the next safe boundary.\n${items.map((item) => `- ${item.text}`).join("\n")}\nFollow docs/MAUSBOT-VALIDATION.md. Triage with priority, classification, scope, QA-Owner, QA-Next and QA-Due; acknowledge in the issue/PR. Assign repairs to an existing developer, dispatch independent review, and close only with verification. This is a role handoff authorized by 大雄, not permission to change the live App.`;
  try {
    state.lastDelivery = await send(message);
    state.seen = { ...state.seen, ...Object.fromEntries(items.map((item) => [item.key, new Date(now).toISOString()])) };
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
  console.log(JSON.stringify({ at: new Date().toISOString(), sent: result.sent, uncertain: result.uncertain ?? false }));
}
