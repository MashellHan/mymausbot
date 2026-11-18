import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { holdsFor, issueLabels } from "./contracts.mjs";
import { verifyGate } from "./gate.mjs";
import { github, pages, runJobs, runPlan } from "./github.mjs";
import { currentMerge, executionMatches, prControls } from "./label-gate.mjs";
import { associatedWithPr, latestPrSource } from "./pr-source.mjs";

function failedHoldGate(jobs) {
  const failures = jobs.filter((job) => !["success", "skipped"].includes(job.conclusion));
  if (jobs.some((job) => job.status !== "completed") || failures.length !== 1) return null;
  const [gate] = failures;
  const steps = gate.steps?.filter((step) => step.conclusion === "failure");
  return gate.name === "CI" && gate.conclusion === "failure" && Number.isSafeInteger(gate.id) && gate.id > 0
    && steps?.length === 1 && steps[0].name === "Enforce current PR controls, QA holds and required validation" ? gate : null;
}

function reportedHolds(log) {
  const errors = [...log.toString("utf8").matchAll(/^\S+ Error: ([^\r\n]+)\r?$/gm)];
  if (errors.length !== 1) return [];
  const match = /^QA hold: (#\d+(?:, #\d+)*); Lead must triage or identify a fully validated repair$/.exec(errors[0][1]);
  return match ? [...new Set(match[1].split(", ").map((id) => Number(id.slice(1))))] : [];
}

export async function recheckHeldPr(pr, { repository, api = github, loadPlan = runPlan } = {}) {
  const source = await latestPrSource(pr, repository, api);
  if (!source || source.run.status !== "completed" || source.run.conclusion !== "failure") return false;
  const { run } = source;
  const gate = failedHoldGate(source.jobs);
  if (!gate) return false;
  const ids = reportedHolds(await api(`/actions/jobs/${gate.id}/logs`, { raw: true }));
  let changed = false;
  for (const id of ids) {
    const issue = await api(`/issues/${id}`);
    if (issue.number !== id || issue.pull_request) return false;
    const updated = issue.state === "closed" ? issue.closed_at : issue.updated_at;
    if (Date.parse(updated) >= Date.parse(gate.started_at)) changed = true;
  }
  if (!changed) return false;

  const jobs = await runJobs(run.id, run.run_attempt, api);
  const artifacts = await pages(`/actions/runs/${run.id}/artifacts`, "artifacts", api);
  const plan = await loadPlan(run, jobs, artifacts, { api, shaIdentity: "executed-pr-merge" });
  if (plan?.outputs?.pr_number !== pr.number || plan.outputs.pr_head !== pr.head.sha
    || plan.execution?.base !== pr.base.sha || plan.execution.head !== pr.head.sha) return false;
  const request = { number: pr.number, baseRef: pr.base.ref, base: pr.base.sha, head: pr.head.sha };
  const merge = await currentMerge(request, api);
  if (merge.base !== request.base || !executionMatches(plan, await api(`/commits/${plan.execution.merge}`), request, merge)) return false;
  try {
    await verifyGate(plan.outputs, { api, runId: run.id, attempt: run.run_attempt,
      createdAt: Date.parse(run.run_attempt === 1 ? run.created_at : run.run_started_at), deadlineMs: 0 });
  } catch (error) {
    if (/^(QA hold:|PR head changed;|Current PR controls require|Required validation failed:|Incomplete required validation:)/.test(error.message)) return false;
    throw error;
  }
  const latest = await latestPrSource(pr, repository, api);
  if (latest?.run.id !== run.id || latest.run.run_attempt !== run.run_attempt || latest.run.status !== "completed"
    || latest.run.conclusion !== "failure" || failedHoldGate(latest.jobs)?.id !== gate.id) return false;
  const live = await api(`/pulls/${pr.number}`);
  if (!associatedWithPr(run, live, repository) || live.base.sha !== request.base || live.mergeable_state === "behind"
    || live.mergeable === false || prControls(live) !== prControls(pr)) return false;
  await api(`/actions/jobs/${gate.id}/rerun`, { method: "POST", raw: true });
  return true;
}

export async function recheckReleasedHolds({ repository = process.env.GITHUB_REPOSITORY, api = github, check = recheckHeldPr } = {}) {
  const issues = await pages("/issues?state=open&labels=qa", null, api);
  const globalHold = holdsFor(issues.filter((issue) => !issue.pull_request), []).length > 0;
  const prs = (await pages("/pulls?state=open&base=main", null, api)).filter((pr) =>
    pr.head?.repo?.full_name === repository && (!globalHold || issueLabels(pr).includes("qa:repair")));
  const errors = [];
  for (let i = 0; i < prs.length; i += 4) {
    const batch = prs.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map((pr) => check(pr, { repository, api })));
    for (const [j, result] of results.entries()) {
      if (result.status === "rejected") errors.push(`PR #${batch[j].number}: ${result.reason.message}`);
      else if (result.value) console.log(`Requested the held CI gate for PR #${batch[j].number}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await recheckReleasedHolds();
