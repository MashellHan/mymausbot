import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { github, pages } from "./github.mjs";
import { holdsFor, inspectJobs } from "./contracts.mjs";
import { qaHealth } from "./health.mjs";

export async function verifyGate(outputs, { api = github, health = qaHealth, runId = process.env.GITHUB_RUN_ID, deadlineMs = 85 * 60_000, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const issues = (await pages("/issues?state=open&labels=qa", null, api)).filter((issue) => !issue.pull_request);
  const areas = JSON.parse(outputs.qa_areas);
  const repairs = outputs.full_required === "true" ? JSON.parse(outputs.repair_ids) : [];
  const holds = holdsFor(issues, areas, repairs);
  if (holds.length) throw new Error(`QA hold: ${holds.map((issue) => `#${issue.number}`).join(", ")}; Lead must triage or identify a fully validated repair`);
  if (outputs.reduced === "true") {
    const state = await health({ api });
    if (!state.healthy || state.blockedAreas.some((area) => area === "global" || areas.includes(area))) {
      throw new Error(`Reduced coverage is no longer eligible: ${state.reason || "untriaged QA findings"}. Re-run CI to restore broader checks.`);
    }
  }
  if (outputs.full_required !== "true") return;
  const expected = JSON.parse(outputs.expected_jobs);
  if (!Array.isArray(expected) || expected.length < 2) throw new Error("Missing full validation plan");
  const started = Date.now();
  while (true) {
    const observed = await pages(`/actions/runs/${runId}/jobs?filter=latest`, "jobs", api);
    const result = inspectJobs(expected, observed);
    if (result.failed.length) throw new Error(`Full validation failed: ${result.failed.join(", ")}`);
    if (result.passed) return;
    if (Date.now() - started >= deadlineMs) throw new Error(`Incomplete full validation: ${[...result.missing, ...result.pending].join(", ")}`);
    console.log(`Waiting for full validation: ${result.missing.length} missing, ${result.pending.length} pending`);
    await wait(15_000);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyGate(JSON.parse(process.env.SCOPE_OUTPUTS));
}
