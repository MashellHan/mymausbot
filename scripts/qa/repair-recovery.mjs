import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { holdsFor, issueLabels } from "./contracts.mjs";
import { github, pages } from "./github.mjs";

const acquisitionFailure = "The job was not acquired by Runner of type hosted even after multiple attempts";

export async function runnerLosses(run, api) {
  const jobs = await pages(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs", api);
  if (!jobs.length || jobs.some((job) => job.run_id !== run.id || job.run_attempt !== run.run_attempt
    || job.status !== "completed" || !Number.isSafeInteger(job.id) || job.id <= 0)) return [];
  const failed = jobs.filter((job) => !["success", "skipped"].includes(job.conclusion));
  const losses = failed.filter((job) => job.name !== "CI");
  if (!losses.length || losses.some((job) => !["cancelled", "failure"].includes(job.conclusion)
    || job.runner_id !== 0 || job.runner_name !== "" || job.steps?.length !== 0)) return [];
  for (const job of losses) {
    const annotations = await pages(`/check-runs/${job.id}/annotations`, null, api);
    const errors = annotations.filter((item) => item.annotation_level === "failure");
    if (!errors.length || errors.some((item) => item.path !== ".github" || item.message !== acquisitionFailure)) return [];
  }
  const gates = failed.filter((job) => job.name === "CI");
  if (gates.length !== 1 || gates[0].conclusion !== "failure") return [];
  const failedSteps = gates[0].steps?.filter((step) => step.conclusion === "failure");
  if (failedSteps?.length !== 1 || failedSteps[0].name !== "Enforce current PR controls, QA holds and required validation") return [];
  const log = await api(`/actions/jobs/${gates[0].id}/logs`, { raw: true });
  const errors = [...log.toString("utf8").matchAll(/^\S+ Error: ([^\r\n]+)\r?$/gm)];
  if (errors.length !== 1 || !errors[0][1].startsWith("Required validation failed: ")) return [];
  let reason = errors[0][1].slice("Required validation failed: ".length);
  const names = losses.map((job) => job.name);
  while (reason) {
    const match = names.find((name) => name && (reason === name || reason.startsWith(`${name}, `)));
    if (!match) return [];
    if (reason === match) return names;
    reason = reason.slice(match.length + 2);
  }
  return [];
}

export async function recoverRepair(run, repository, api = github) {
  if (run?.path !== ".github/workflows/ci.yml" || run.event !== "pull_request" || run.status !== "completed"
    || run.conclusion !== "failure" || run.head_repository?.full_name !== repository
    || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f\d]{40}$/.test(run.head_sha)
    || !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt)
    || run.run_attempt < 1 || run.run_attempt >= 4) return "Ineligible CI attempt";
  const branch = encodeURIComponent(run.head_branch);
  const prs = await api(`/pulls?state=open&base=main&head=${repository.split("/")[0]}:${branch}`);
  const isRepair = (pr) => pr.state === "open" && pr.base?.repo?.full_name === repository && pr.base.ref === "main"
    && pr.head?.repo?.full_name === repository && pr.head.ref === run.head_branch && pr.head.sha === run.head_sha
    && issueLabels(pr).includes("qa:repair");
  if (prs.length !== 1 || !isRepair(prs[0])) return "No current repair PR";
  const losses = await runnerLosses(run, api);
  if (!losses.length) return "Failure is not attributable solely to hosted runner acquisition";
  const pr = await api(`/pulls/${prs[0].number}`);
  if (!isRepair(pr)) return "Repair changed";
  const repairs = [...String(pr.body ?? "").matchAll(/^QA-Repair:[ \t]*#(\d+)[ \t]*\r?$/gm)].map((hit) => Number(hit[1]));
  const issues = await pages("/issues?state=open&labels=qa", null, api);
  if (!holdsFor(issues.filter((issue) => !issue.pull_request && repairs.includes(issue.number)), []).length) return "No linked global hold";
  const latest = await api(`/actions/workflows/ci.yml/runs?event=pull_request&branch=${branch}&head_sha=${run.head_sha}&per_page=1`);
  const current = latest.workflow_runs[0];
  if (current?.id !== run.id || current.run_attempt !== run.run_attempt
    || current.status !== "completed" || current.conclusion !== "failure") return "CI attempt already superseded";
  await api(`/actions/runs/${run.id}/rerun-failed-jobs`, { method: "POST", raw: true });
  return `Requested failed jobs of run ${run.id}, attempt ${run.run_attempt} (PR #${pr.number}): ${losses.join(", ")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  console.log(await recoverRepair(event.workflow_run, process.env.GITHUB_REPOSITORY));
}
