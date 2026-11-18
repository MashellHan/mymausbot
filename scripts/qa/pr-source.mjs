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

export async function latestPrSource(pr, repository, api = github) {
  const branch = encodeURIComponent(pr.head.ref);
  const list = await api(`/actions/workflows/ci.yml/runs?event=pull_request&branch=${branch}&head_sha=${pr.head.sha}&per_page=20`);
  if (!Array.isArray(list?.workflow_runs) || list.workflow_runs.length > 20) throw new Error("Unreadable PR CI run list");
  for (const run of list.workflow_runs.sort((a, b) => b.id - a.id)) {
    if (!associatedWithPr(run, pr, repository) || !Number.isSafeInteger(run.id) || run.id < 1
      || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return null;
    const jobs = await pages(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, "jobs", api);
    if (!jobs.length || jobs.some((job) => job.run_id !== run.id || job.run_attempt !== run.run_attempt)) return null;
    const preflight = preflightJob(jobs);
    if (preflight && preflight.conclusion !== "skipped") return { run, jobs };
    const skippedStatic = preflight || jobs.find((job) => job.name.includes("vars.BOAT_CI") && job.name.includes("typecheck + lint"));
    if (skippedStatic?.conclusion !== "skipped" || !jobs.some((job) => job.name === "CI")
      || jobs.some((job) => job.name !== "CI" && job.conclusion !== "skipped")) return null;
  }
  return null;
}
