import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactFiles, github, pages, runJobs, runPlan } from "./github.mjs";
import { holdsFor, inspectJobs } from "./contracts.mjs";
import { qaHealth } from "./health.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function verifyGate(outputs, { api = github, health = qaHealth, runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT || 1, deadlineMs = 85 * 60_000, wait = pause } = {}) {
  const areas = outputs.qa_areas;
  const expected = outputs.expected_jobs;
  if (!Array.isArray(areas) || !areas.length || !Array.isArray(expected) || !expected.some((item) => item.id === "static")
    || !Array.isArray(outputs.required_jobs) || outputs.required_jobs.some((id) => !expected.some((item) => item.id === id))) throw new Error("Missing required validation plan");
  const checkControls = async () => {
    let repairs = [];
    if (outputs.pr_number) {
      const pr = await api(`/pulls/${outputs.pr_number}`);
      if (pr.head.sha !== outputs.pr_head) throw new Error("PR head changed; wait for its current CI run");
      const labels = pr.labels.map((label) => label.name);
      if ((labels.includes("ci:full") || labels.includes("qa:repair")) && !outputs.full_required) throw new Error("Current PR controls require a fresh full CI run");
      if (outputs.full_required && labels.includes("qa:repair")) repairs = [...String(pr.body ?? "").matchAll(/^QA-Repair:\s*#(\d+)\s*$/gm)].map((hit) => Number(hit[1]));
    }
    const issues = (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
    const holds = holdsFor(issues, areas, repairs);
    if (holds.length) throw new Error(`QA hold: ${holds.map((issue) => `#${issue.number}`).join(", ")}; Lead must triage or identify a fully validated repair`);
    if (outputs.reduced) {
      const state = await health({ api });
      if (!state.healthy || state.blockedAreas.some((area) => area === "global" || areas.includes(area))) {
        throw new Error(`Reduced coverage is no longer eligible: ${state.reason || "untriaged QA findings"}. Re-run CI to restore broader checks.`);
      }
    }
  };
  await checkControls();
  const started = Date.now();
  while (true) {
    const observed = await runJobs(runId, attempt, api);
    const result = inspectJobs(expected, observed);
    if (result.failed.length) throw new Error(`Required validation failed: ${result.failed.join(", ")}`);
    if (result.passed) { await checkControls(); return; }
    if (Date.now() - started >= deadlineMs) throw new Error(`Incomplete required validation: ${[...result.missing, ...result.pending].join(", ")}`);
    console.log(`Waiting for required validation: ${result.missing.length} missing, ${result.pending.length} pending`);
    await wait(15_000);
  }
}

export async function gateRun({ api = github, readArtifact = artifactFiles, runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT || 1, sha = process.env.GITHUB_SHA, deadlineMs = 175 * 60_000, wait = pause, ...options } = {}) {
  const started = Date.now();
  while (true) {
    const jobs = await runJobs(runId, attempt, api);
    const preflight = jobs.find((job) => job.name.startsWith("typecheck + lint"));
    if (preflight?.status === "completed" && preflight.conclusion !== "success") throw new Error(`Preflight ${preflight.conclusion}`);
    const artifacts = await pages(`/actions/runs/${runId}/artifacts`, "artifacts", api);
    const plan = await runPlan({ id: Number(runId), run_attempt: Number(attempt), head_sha: sha }, jobs, artifacts, { api, readArtifact });
    if (plan) {
      return verifyGate(plan.outputs, { ...options, api, runId, attempt, wait, deadlineMs: Math.max(0, deadlineMs - (Date.now() - started)) });
    }
    if (preflight?.conclusion === "success" || Date.now() - started >= deadlineMs) throw new Error("Missing current-run validation plan; rerun all jobs for this revision");
    console.log("Waiting for the current run's validation plan");
    await wait(15_000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await gateRun();
}
