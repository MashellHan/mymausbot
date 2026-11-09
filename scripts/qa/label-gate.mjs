import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightJob } from "./contracts.mjs";
import { gateRun, verifyGate } from "./gate.mjs";
import { artifactFiles, github, pages, runJobs, runPlan } from "./github.mjs";

const SHA = /^[a-f\d]{40}$/i;
const BRANCH = /^[a-z\d][a-z\d._/-]{0,199}$/i;
const CONTROLS = new Set(["ci:full", "qa:repair", "windows", "upstream-sync"]);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function ordinaryMetadata(event) {
  const pr = event?.pull_request;
  return ["labeled", "unlabeled"].includes(event?.action) && Number.isSafeInteger(pr?.number) && pr.number > 0
    && SHA.test(pr.base?.sha ?? "") && SHA.test(pr.head?.sha ?? "")
    && typeof event.label?.name === "string" && !!event.label.name
    && !CONTROLS.has(event.label.name.toLowerCase());
}

function exactPr(pr, request, repository) {
  return pr?.number === request.number && pr.state === "open" && pr.head?.sha === request.head
    && pr.base?.ref === request.baseRef && pr.base?.repo?.full_name === repository
    && Array.isArray(pr.labels) && pr.labels.every((label) => typeof label.name === "string");
}

async function currentMerge(request, api) {
  const branch = await api(`/branches/${encodeURIComponent(request.baseRef)}`);
  const base = branch?.commit?.sha;
  if (!SHA.test(base ?? "")) throw new Error("Current PR base ref is unavailable");
  const ref = await api(`/git/ref/pull/${request.number}/merge`);
  if (!SHA.test(ref?.object?.sha ?? "")) throw new Error("Current PR merge ref is unavailable");
  const merge = await api(`/commits/${ref.object.sha}`);
  if (merge?.sha !== ref.object.sha || merge.parents?.length !== 2
    || merge.parents[0]?.sha !== base || merge.parents[1]?.sha !== request.head
    || !SHA.test(merge.commit?.tree?.sha ?? "")) throw new Error("Current PR merge does not match its live base and head");
  return { base, merge };
}

const controls = (pr) => JSON.stringify({ labels: pr.labels.map((label) => label.name.toLowerCase())
  .filter((name) => CONTROLS.has(name)).sort(), repairs: pr.labels.some((label) => label.name.toLowerCase() === "qa:repair")
    ? [...String(pr.body ?? "").matchAll(/^QA-Repair:\s*#\d+\s*$/gm)].map((hit) => hit[0]).sort() : [] });

export function executionMatches(plan, commit, request, current) {
  const execution = plan?.execution;
  return execution && SHA.test(execution.merge ?? "") && execution.base === request.base && execution.head === request.head
    && commit?.sha === execution.merge && Array.isArray(commit.parents) && commit.parents.length === 2
    && commit.parents[0]?.sha === request.base && commit.parents[1]?.sha === request.head
    && SHA.test(commit.commit?.tree?.sha ?? "") && commit.commit.tree.sha === current.merge.commit.tree.sha;
}

async function sourceRun(request, currentRunId, api, loadJobs) {
  let examined = 0;
  for (let page = 1; page <= 5; page++) {
    const listed = await api(`/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${request.head}&per_page=100&page=${page}`);
    if (!Array.isArray(listed?.workflow_runs) || listed.workflow_runs.length > 100) throw new Error("Invalid PR CI run list");
    for (const run of listed.workflow_runs.sort((a, b) => b.id - a.id)) {
      if (run.id >= currentRunId || run.event !== "pull_request" || run.path !== ".github/workflows/ci.yml"
        || run.head_sha !== request.head || !run.pull_requests?.some((pr) => pr.number === request.number)) continue;
      if (++examined > 25) throw new Error("Too many same-head CI runs to bind a source execution");
      if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) throw new Error("Invalid PR CI attempt");
      const jobs = await loadJobs(run.id, run.run_attempt, api);
      const preflight = preflightJob(jobs);
      if (preflight) {
        if (preflight.run_attempt !== run.run_attempt) throw new Error("Newest CI attempt has no current preflight job");
        if (preflight.conclusion !== "skipped") return { run, jobs };
      } else if (!jobs.some((job) => job.name.includes("vars.BOAT_CI") && job.conclusion === "skipped")) {
        throw new Error("Newest CI execution is not yet identifiable as source or metadata");
      }
    }
    if (listed.workflow_runs.length < 100) break;
  }
  throw new Error("No exact-head source CI execution with a preflight job");
}

export async function reattestMetadata({ event, repository = process.env.GITHUB_REPOSITORY, currentRunId = Number(process.env.GITHUB_RUN_ID),
  api = github, loadJobs = runJobs, loadPlan = runPlan, readArtifact = artifactFiles, verify = verifyGate,
  now = Date.now, wait = pause, maxWaitMs = 175 * 60_000 } = {}) {
  if (!ordinaryMetadata(event) || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || event.repository?.full_name !== repository
    || event.pull_request.base.repo?.full_name !== repository || event.number !== event.pull_request.number
    || !BRANCH.test(event.pull_request.base.ref ?? "") || event.pull_request.base.ref.includes("..")
    || !Number.isSafeInteger(currentRunId) || currentRunId < 1) throw new Error("Invalid metadata run identity");
  const member = { number: event.pull_request.number, baseRef: event.pull_request.base.ref, head: event.pull_request.head.sha };
  const firstPr = await api(`/pulls/${member.number}`);
  if (!exactPr(firstPr, member, repository)) throw new Error("Current PR identity differs from metadata event");
  const current = await currentMerge(member, api);
  const request = { ...member, base: current.base };
  const chosen = await sourceRun(request, currentRunId, api, loadJobs);
  let { run, jobs } = chosen;
  const attempt = run.run_attempt;
  const started = now();
  while (run.status !== "completed") {
    if (now() - started >= maxWaitMs) throw new Error("Source CI did not complete before metadata gate deadline");
    await wait(15_000);
    run = await api(`/actions/runs/${run.id}`);
    if (run.head_sha !== request.head || run.event !== "pull_request" || run.run_attempt !== attempt) throw new Error("Source CI identity changed");
  }
  if (run.conclusion !== "success") throw new Error(`Source CI ${run.conclusion ?? "incomplete"}`);
  jobs = await loadJobs(run.id, attempt, api);
  const preflight = preflightJob(jobs);
  const gate = jobs.filter((job) => job.name === "CI" && job.run_attempt === attempt);
  if (preflight?.run_attempt !== attempt || preflight.conclusion !== "success" || gate.length !== 1 || gate[0].conclusion !== "success") {
    throw new Error("Source CI required checks did not pass on this attempt");
  }
  const artifacts = await pages(`/actions/runs/${run.id}/artifacts`, "artifacts", api);
  const plan = await loadPlan(run, jobs, artifacts, { api, readArtifact });
  if (!plan || plan.outputs?.pr_number !== request.number || plan.outputs?.pr_head !== request.head) {
    throw new Error("Missing exact source CI plan");
  }
  if (!SHA.test(plan.execution?.merge ?? "")) throw new Error("Missing immutable source CI merge identity");
  const commit = await api(`/commits/${plan.execution?.merge}`);
  if (!executionMatches(plan, commit, request, current)) throw new Error("Source CI did not execute this PR base and head");
  const createdAt = Date.parse(attempt === 1 ? run.created_at : run.run_started_at);
  if (!Number.isFinite(createdAt)) throw new Error("Invalid source CI attempt time");
  await verify(plan.outputs, { api, runId: run.id, attempt, createdAt, deadlineMs: 0 });
  const finalPr = await api(`/pulls/${request.number}`);
  if (!exactPr(finalPr, request, repository) || controls(finalPr) !== controls(firstPr)) throw new Error("Current PR identity or controls changed during metadata proof");
  const finalMerge = await currentMerge(request, api);
  if (finalMerge.base !== request.base || finalMerge.merge.commit.tree.sha !== current.merge.commit.tree.sha) {
    throw new Error("Current PR merge changed during metadata proof");
  }
  const finalRun = await api(`/actions/runs/${run.id}`);
  if (finalRun.head_sha !== request.head || finalRun.run_attempt !== attempt || finalRun.status !== "completed" || finalRun.conclusion !== "success") {
    throw new Error("Source CI attempt changed during metadata proof");
  }
  return { sourceRunId: run.id, attempt, head: request.head, base: request.base };
}

export async function labelGate({ eventName = process.env.GITHUB_EVENT_NAME, eventPath = process.env.GITHUB_EVENT_PATH,
  event = eventName === "pull_request" ? JSON.parse(readFileSync(eventPath, "utf8")) : null,
  runRequired = gateRun, reattest = reattestMetadata } = {}) {
  return eventName === "pull_request" && ordinaryMetadata(event)
    ? reattest({ event }) : runRequired({ eventPayload: event ?? undefined });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  labelGate().catch((error) => { console.error(error); process.exitCode = 1; });
}
