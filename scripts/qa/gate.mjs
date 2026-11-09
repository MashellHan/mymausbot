import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactFiles, github, pages, runJobs, runPlan } from "./github.mjs";
import { holdsFor, inspectJobs, preflightJob } from "./contracts.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function failedRequiredStep(expected, jobs) {
  for (const item of expected) {
    const job = jobs.find((entry) => entry.name === item.name);
    const step = job?.status !== "completed" && job?.steps?.find((entry) => entry.conclusion === "failure");
    if (step) return `${item.name} > ${step.name}`;
  }
  return null;
}

export async function verifyGate(outputs, { api = github, runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT || 1, deadlineMs = 85 * 60_000, createdAt = NaN, now = Date.now, wait = pause } = {}) {
  const areas = outputs.qa_areas;
  const expected = outputs.expected_jobs;
  if (!Array.isArray(areas) || !areas.length || !Array.isArray(expected) || !expected.some((item) => item.id === "static")
    || !Array.isArray(outputs.required_jobs) || outputs.required_jobs.some((id) => !expected.some((item) => item.id === id))) throw new Error("Missing required validation plan");
  if (outputs.fast_pr && (!Number.isFinite(createdAt) || outputs.full_required || outputs.reduced || outputs.required_jobs.length
    || expected.length !== 1 || expected[0].fast !== true || expected[0].name !== "typecheck + lint")) throw new Error("Invalid fast PR validation plan");
  const checkControls = async () => {
    let repairs = [];
    if (outputs.pr_number) {
      const pr = await api(`/pulls/${outputs.pr_number}`);
      if (pr.head.sha !== outputs.pr_head) throw new Error("PR head changed; wait for its current CI run");
      const labels = pr.labels.map((label) => label.name);
      if ((labels.includes("ci:full") || labels.includes("qa:repair")) && !outputs.full_required
        || labels.includes("upstream-sync") && !outputs.full_required
        || labels.includes("windows") && outputs.fast_pr) throw new Error("Current PR controls require a fresh full CI run");
      if (outputs.full_required && labels.includes("qa:repair")) repairs = [...String(pr.body ?? "").matchAll(/^QA-Repair:\s*#(\d+)\s*$/gm)].map((hit) => Number(hit[1]));
    }
    const issues = (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
    const holds = holdsFor(issues, areas, repairs);
    if (holds.length) throw new Error(`QA hold: ${holds.map((issue) => `#${issue.number}`).join(", ")}; Lead must triage or identify a fully validated repair`);
  };
  await checkControls();
  const started = now();
  while (true) {
    const observed = await runJobs(runId, attempt, api);
    const result = inspectJobs(expected, observed);
    if (result.failed.length) throw new Error(`Required validation failed: ${result.failed.join(", ")}`);
    const failedStep = failedRequiredStep(expected, observed);
    if (failedStep) throw new Error(`Required validation failed: ${failedStep}`);
    if (result.passed) {
      await checkControls();
      return;
    }
    if (now() - started >= deadlineMs) throw new Error(`Incomplete required validation: ${[...result.missing, ...result.pending].join(", ")}`);
    console.log(`Waiting for required validation: ${result.missing.length} missing, ${result.pending.length} pending`);
    await wait(15_000);
  }
}

export async function gateRun({ api = github, readArtifact = artifactFiles, runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT || 1, sha = process.env.GITHUB_SHA, event = process.env.GITHUB_EVENT_NAME, eventPath = process.env.GITHUB_EVENT_PATH, eventPayload, deadlineMs = 175 * 60_000, now = Date.now, wait = pause, ...options } = {}) {
  const started = now();
  let createdAt = NaN, originalCreatedAt = NaN, prNumber = null, prHead = null;
  if (event === "pull_request") {
    const snapshot = eventPayload ?? (eventPath ? JSON.parse(readFileSync(eventPath, "utf8")) : {});
    prNumber = snapshot.pull_request?.number;
    prHead = snapshot.pull_request?.head?.sha;
    const run = await api(`/actions/runs/${runId}`);
    originalCreatedAt = Date.parse(run.created_at);
    createdAt = Number(attempt) === 1 ? originalCreatedAt : Date.parse(run.run_started_at);
    if (run.id !== Number(runId) || run.event !== "pull_request" || !Number.isSafeInteger(run.run_attempt)
      || run.run_attempt !== Number(attempt)
      || !Number.isSafeInteger(prNumber) || prNumber < 1 || !/^[a-f\d]{40}$/i.test(prHead ?? "") || run.head_sha !== prHead
      || !Number.isFinite(originalCreatedAt) || !Number.isFinite(createdAt) || createdAt < originalCreatedAt
      || createdAt > now() + 60_000) throw new Error("Invalid current PR run creation evidence");
  }
  while (true) {
    const jobs = await runJobs(runId, attempt, api);
    const preflight = preflightJob(jobs);
    const failedStep = preflight?.status !== "completed" && preflight?.steps?.find((step) => step.conclusion === "failure");
    if (failedStep) throw new Error(`Preflight failed: ${failedStep.name}`);
    if (preflight?.status === "completed" && preflight.conclusion !== "success") throw new Error(`Preflight ${preflight.conclusion}`);
    const artifacts = await pages(`/actions/runs/${runId}/artifacts`, "artifacts", api);
    const plan = await runPlan({ id: Number(runId), run_attempt: Number(attempt), head_sha: sha }, jobs, artifacts, { api, readArtifact });
    if (plan) {
      return verifyGate(plan.outputs, { ...options, api, runId, attempt, wait, now, createdAt, deadlineMs: Math.max(0, deadlineMs - (now() - started)) });
    }
    if (preflight?.conclusion === "success" || now() - started >= deadlineMs) throw new Error("Missing current-run validation plan; rerun all jobs for this revision");
    if (prNumber) {
      const pr = await api(`/pulls/${prNumber}`);
      if (pr.head?.sha !== prHead) throw new Error("PR head changed; wait for its current CI run");
      if (!Array.isArray(pr.labels) || pr.labels.some((label) => typeof label.name !== "string")) throw new Error("Invalid current PR controls");
    }
    console.log("Waiting for the current run's validation plan");
    await wait(15_000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await gateRun();
}
