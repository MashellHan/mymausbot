import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { github } from "./qa/github.mjs";

export const CONTROL_LABELS = ["ci:full", "qa:repair", "windows", "upstream-sync"];
const SHA = /^[a-f\d]{40}$/i;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export function labelRequest(event, repository) {
  if (!event || !["labeled", "unlabeled"].includes(event.action)) throw new Error("Invalid label event");
  const pr = event.pull_request;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || event.repository?.full_name !== repository
    || pr?.base?.repo?.full_name !== repository || !Number.isSafeInteger(pr.number) || pr.number < 1
    || !SHA.test(pr.head?.sha ?? "") || !SHA.test(pr.base?.sha ?? "")
    || event.number !== pr.number) throw new Error("Invalid current PR identity in label event");
  if (typeof event.label?.name === "string" && !CONTROL_LABELS.includes(event.label.name)) return null;
  return { number: pr.number, head: pr.head.sha, base: pr.base.sha };
}

function exactRun(run, request) {
  return Number.isSafeInteger(run?.id) && run.id > 0 && run.event === "pull_request"
    && run.path === ".github/workflows/ci.yml" && run.head_sha === request.head
    && Array.isArray(run.pull_requests) && run.pull_requests.some((pr) => pr.number === request.number
      && pr.head?.sha === request.head && pr.base?.sha === request.base)
    && run.conclusion !== "skipped";
}

async function sourceRun(request, api) {
  for (let page = 1; page <= 5; page++) {
    const result = await api(`/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${request.head}&per_page=100&page=${page}`);
    if (!Array.isArray(result?.workflow_runs) || result.workflow_runs.length > 100) throw new Error("Invalid PR CI run list");
    const matching = result.workflow_runs.filter((run) => exactRun(run, request));
    if (matching.length) return matching.sort((a, b) => b.id - a.id)[0];
    if (result.workflow_runs.length < 100) break;
  }
  throw new Error("No current-head source PR CI run to refresh");
}

export async function routeLabelControl({ event, repository = process.env.GITHUB_REPOSITORY, api = github,
  now = Date.now, wait = pause, maxWaitMs = 180 * 60_000 } = {}) {
  const request = labelRequest(event, repository);
  if (!request) return { status: "ignored" };
  let run = await sourceRun(request, api);
  const started = now();
  while (run.status !== "completed") {
    if (now() - started >= maxWaitMs) throw new Error("Current-head source PR CI run did not complete in time");
    await wait(30_000);
    run = await api(`/actions/runs/${run.id}`);
    if (!exactRun(run, request)) throw new Error("Source PR CI run identity changed");
  }
  if (!exactRun(run, request) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error("Invalid completed source PR CI run");
  }
  let current = null;
  try { current = await api(`/pulls/${request.number}`); } catch { /* The CI gate rechecks current controls and fails closed. */ }
  if (current?.state === "closed" || current?.merged) return { status: "closed" };
  if (current?.head?.sha && current.head.sha !== request.head) return { status: "superseded" };
  if (current?.base?.sha && current.base.sha !== request.base) throw new Error("PR base changed; a new source validation is required");
  await api(`/actions/runs/${run.id}/rerun`, { method: "POST", raw: true });
  return { status: "rerun-requested", runId: run.id, head: request.head };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  routeLabelControl({ event }).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
