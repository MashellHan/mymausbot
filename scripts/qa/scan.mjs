import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactFiles, github, pages, runJobs, runPlan } from "./github.mjs";
import { issueLabels, triageOf } from "./contracts.mjs";
import { sanitize, signature } from "./report.mjs";

export const FAST_PR_TARGET_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

function finding(rule, subject, text) {
  return { key: signature(`${rule}:${subject}`, "process"), rule, subject, text };
}

export function queueCases(issues, prs, now = Date.now()) {
  const findings = [];
  for (const pr of prs) {
    const created = Date.parse(pr.created_at), updated = Date.parse(pr.updated_at);
    if (now - created > 24 * HOUR_MS) findings.push(finding("pr-age", `pr:${pr.number}`, `PR #${pr.number} remains open after 24 hours. Preserve ${pr.head.sha}; Lead must record adoption, dependencies and the next action. Age alone does not justify closure.`));
    if (now - updated > 12 * HOUR_MS) findings.push(finding("pr-inactivity", `pr:${pr.number}:${pr.updated_at}`, `PR #${pr.number} has no GitHub update for 12 hours. Lead must inspect substantive progress and the blocker; an update timestamp is not proof of accepted review or progress.`));
  }
  for (const issue of issues.filter((item) => !issueLabels(item).includes("qa:process"))) {
    if (issueLabels(issue).includes("qa:verified")) continue;
    const epoch = issue.body?.match(/"triageEpoch":"([^"]+)"/)?.[1] ?? issue.created_at;
    const triage = triageOf(issue);
    if (!triage.complete && now - Date.parse(epoch) > 30 * 60_000) findings.push(finding("qa-triage", `issue:${issue.number}:${epoch}`, `QA #${issue.number} has incomplete triage after 30 minutes. Lead must assign priority, scope, owner and next action; this deadline adds no merge hold.`));
    else if (triage.complete && Date.parse(triage.due) < now) findings.push(finding("qa-repair", `issue:${issue.number}:${triage.due}`, `QA #${issue.number} is past ${triage.due}, owned by ${triage.owner}. Record the blocker and revised action; a due date adds no merge hold.`));
  }
  return findings;
}

export function ciCase(run, jobs, plan, now = Date.now()) {
  if (!plan?.outputs?.fast_pr) return null;
  const gate = jobs.find((job) => job.name === "CI" && job.run_attempt === run.run_attempt);
  const start = Date.parse(run.run_attempt === 1 ? run.created_at : run.run_started_at);
  const end = gate?.status === "completed" ? Date.parse(gate.completed_at)
    : run.status === "completed" ? Date.parse(run.updated_at) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= FAST_PR_TARGET_MS) return null;
  const seconds = (a, b) => Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.ceil((b - a) / 1000) : "unknown";
  const preflight = jobs.find((job) => job.name.startsWith("typecheck + lint"));
  const slowSteps = (preflight?.steps ?? []).map((step) => ({ name: sanitize(step.name), seconds: seconds(Date.parse(step.started_at), Date.parse(step.completed_at)) }))
    .filter((step) => typeof step.seconds === "number").sort((a, b) => b.seconds - a.seconds).slice(0, 3);
  return finding("ci-latency", `run:${run.id}:${run.run_attempt}`, `CI run ${run.id}, attempt ${run.run_attempt}: attempt-to-gate=${seconds(start, end)}s; original-created-to-gate=${seconds(Date.parse(run.created_at), end)}s; static-queue=${seconds(start, Date.parse(preflight?.started_at))}s; slow steps=${JSON.stringify(slowSteps)}. Gate outcome=${gate?.conclusion ?? "pending"}. Optimize the measured phase; keep successful quality evidence and do not rerun solely for timing.`);
}

export async function recordCases(findings, { api = github, now = Date.now() } = {}) {
  const issues = (await pages("/issues?state=all&labels=qa:process", null, api)).filter((issue) => !issue.pull_request);
  for (const item of findings) {
    const marker = `<!-- mausbot-process-case ${item.key} -->`;
    const existing = issues.find((issue) => issue.body?.includes(marker));
    if (existing) continue;
    const body = `${marker}\n\n${sanitize(item.text)}\n\nProcess-Rule: ${item.rule}\nProcess-Subject: ${item.subject}\nProcess-Observed: ${new Date(now).toISOString()}\nProcess-Owner: mausbot-lead\nProcess-Next: inspect the evidence, assign an existing owner at available capacity, optimize the pipeline or fixture, and retain the PR's adoption or recovery path.\n\nThis is an advisory process case. It adds no quality hold, merge failure, PR closure or live App action. Keep the affected PR, branch, source/check evidence and any superseding PR; close this finding only with an explained resolution.`;
    const created = await api("/issues", { method: "POST", body: { title: `[Process] ${item.rule}: ${item.subject}`, body, labels: ["qa:process"] } });
    issues.push(created);
  }
  return issues.filter((issue) => issue.state === "open").map((issue) => ({
    key: `process:${issue.body?.match(/<!-- mausbot-process-case ([a-f\d]+) -->/)?.[1] ?? issue.number}`,
    text: `${issue.html_url}: ${sanitize(issue.title)}. Lead: assign process improvements at available capacity and preserve any pending PR's recovery/adoption path.`,
  }));
}

export async function scanProcesses(state = {}, { api = github, readArtifact = artifactFiles, now = Date.now(), repository = process.env.GITHUB_REPOSITORY, prs, issues, runId } = {}) {
  if (runId !== undefined && !/^\d+$/.test(String(runId))) throw new Error("A numeric CI run ID is required");
  const openPrs = prs ?? await pages("/pulls?state=open", null, api);
  const qaIssues = issues ?? (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
  const findings = queueCases(qaIssues, openPrs, now);
  const runs = runId ? [await api(`/actions/runs/${runId}`)]
    : (await api(`/actions/workflows/ci.yml/runs?event=pull_request&created=>${new Date(now - 24 * HOUR_MS).toISOString()}&per_page=100`)).workflow_runs;
  const errors = [];
  const completed = {};
  for (const run of runs) {
    if (run.path !== ".github/workflows/ci.yml" || run.event !== "pull_request" || run.repository?.full_name !== repository) continue;
    const key = `${run.id}:${run.run_attempt}`;
    if (state.completedRuns?.[key]) continue;
    if (now - Date.parse(run.run_attempt === 1 ? run.created_at : run.run_started_at) <= FAST_PR_TARGET_MS) continue;
    try {
      const jobs = await runJobs(run.id, run.run_attempt, api);
      const artifacts = await pages(`/actions/runs/${run.id}/artifacts`, "artifacts", api);
      const plan = await runPlan(run, jobs, artifacts, { api, readArtifact });
      const item = ciCase(run, jobs, plan, now);
      if (item) findings.push(item);
      const pr = openPrs.find((entry) => entry.head.sha === run.head_sha);
      if (!plan && pr && !issueLabels(pr).some((label) => ["ci:full", "qa:repair", "windows"].includes(label))) {
        findings.push(finding("ci-latency", `run:${run.id}:${run.run_attempt}`, `CI run ${run.id}, attempt ${run.run_attempt}: ordinary PR #${pr.number} has no available validation plan after the five-minute target. Inspect queue/setup and preserve required validation; timing alone must not fail or cancel the run.`));
      }
      if (run.status === "completed" && plan) completed[key] = now;
    } catch (error) {
      errors.push({ runId: run.id, message: sanitize(error.message) });
    }
  }
  const handoffs = await recordCases(findings, { api, now });
  state.completedRuns = Object.fromEntries(Object.entries({ ...state.completedRuns, ...completed }).filter(([, at]) => now - at < 7 * 24 * HOUR_MS));
  return { at: new Date(now).toISOString(), outcome: errors.length ? "incomplete" : findings.length ? "optimization_needed" : "passed", findings, errors, handoffs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await scanProcesses({}, { runId: process.env.QA_RUN_ID });
  writeFileSync("process-scan.json", JSON.stringify(result, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Process scan: ${result.outcome}; ${result.findings.length} advisory cases, ${result.errors.length} unavailable run observations. Quality gates are independent.\n`);
  process.exitCode = result.outcome === "passed" ? 0 : 1;
}
