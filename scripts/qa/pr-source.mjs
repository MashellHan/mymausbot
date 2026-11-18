import { isDeepStrictEqual } from "node:util";
import { preflightJob } from "./contracts.mjs";
import { github, pages } from "./github.mjs";

export function associatedWithPr(run, pr, repository) {
  const members = run?.pull_requests;
  const member = members?.length === 1 && members[0];
  return Boolean(member && Number.isSafeInteger(pr?.number) && pr.number > 0 && pr.state === "open"
    && pr.base?.repo?.full_name === repository && pr.base.ref === "main"
    && Number.isSafeInteger(pr.base.repo.id) && pr.base.repo.id > 0
    && pr.head?.repo?.id === pr.base.repo.id && pr.head.repo.full_name === repository
    && /^[a-f\d]{40}$/.test(pr.head.sha) && pr.head.ref
    && run.path === ".github/workflows/ci.yml" && run.event === "pull_request"
    && run.head_repository?.full_name === repository && run.head_branch === pr.head.ref && run.head_sha === pr.head.sha
    && member.number === pr.number && member.base?.ref === pr.base.ref && member.base.repo?.id === pr.base.repo.id
    && member.head?.ref === pr.head.ref && member.head.repo?.id === pr.head.repo.id && member.head.sha === pr.head.sha);
}

async function listedRuns(pr, api) {
  const branch = encodeURIComponent(pr.head.ref);
  const list = await api(`/actions/workflows/ci.yml/runs?event=pull_request&branch=${branch}&head_sha=${pr.head.sha}&per_page=20`);
  if (!Array.isArray(list?.workflow_runs) || list.workflow_runs.length > 20) throw new Error("Unreadable PR CI run list");
  return list.workflow_runs.sort((a, b) => b.id - a.id);
}

function signature(run, pr, repository) {
  return [run.id, run.run_attempt, run.status, run.conclusion, associatedWithPr(run, pr, repository)];
}

export async function sourceStillCurrent(source, pr, repository, api = github) {
  const [list, current] = await Promise.all([listedRuns(pr, api), api(`/actions/runs/${source.run.id}`)]);
  const prefix = list.slice(0, source.prefix.length).map((run) => signature(run, pr, repository));
  return isDeepStrictEqual(prefix, source.prefix)
    && isDeepStrictEqual(signature(current, pr, repository), source.prefix.at(-1));
}

export async function latestPrSource(pr, repository, api = github) {
  const list = await listedRuns(pr, api);
  const snapshot = list.map((run) => signature(run, pr, repository));
  for (const [index, run] of list.entries()) {
    if (!associatedWithPr(run, pr, repository) || !Number.isSafeInteger(run.id) || run.id < 1
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return null;
    const jobs = await pages(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs", api);
    if (!jobs.length || jobs.some((job) => job.run_id !== run.id || job.run_attempt !== run.run_attempt)) return null;
    const preflight = preflightJob(jobs);
    if (preflight && preflight.conclusion !== "skipped") return { run, jobs, prefix: snapshot.slice(0, index + 1) };
    const skippedStatic = preflight || jobs.find((job) => job.name.includes("vars.BOAT_CI") && job.name.includes("typecheck + lint"));
    if (skippedStatic?.conclusion !== "skipped" || !jobs.some((job) => job.name === "CI")
      || jobs.some((job) => job.name !== "CI" && job.conclusion !== "skipped")) return null;
  }
  return null;
}
