import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eligibleRun, fullPushPlan, narrowPushPlan } from "./contracts.mjs";

export async function github(path, { method = "GET", body, raw = false } = {}) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid GitHub repository/path");
  const endpoint = `/repos/${repository}${path}`;
  if (process.env.MAUSBOT_GH_COMMAND) {
    const [command, ...prefix] = JSON.parse(process.env.MAUSBOT_GH_COMMAND);
    const result = execFileSync(command, [...prefix, "api", "--method", method, endpoint,
      ...(body === undefined ? [] : ["--input", "-"])], {
      input: body === undefined ? undefined : JSON.stringify(body), timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return raw ? result : result.length ? JSON.parse(result.toString("utf8")) : null;
  }
  if (!process.env.GH_TOKEN) throw new Error("GitHub credentials unavailable");
  const response = await fetch(`${process.env.GITHUB_API_URL || "https://api.github.com"}${endpoint}`, {
    method, headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]}: HTTP ${response.status}`);
  return raw ? Buffer.from(await response.arrayBuffer()) : response.status === 204 ? null : response.json();
}

export async function pages(path, key, api = github) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const result = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = key ? result[key] : result;
    if (!Array.isArray(rows)) throw new Error(`Invalid paginated response: ${path}`);
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error(`Pagination limit reached: ${path}`);
}

export async function runJobs(id, attempt, api = github) {
  const jobs = await pages(`/actions/runs/${id}/jobs?filter=all`, "jobs", api);
  if (jobs.some((job) => !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1)) throw new Error("Missing workflow attempt identity");
  const eligible = jobs.filter((job) => job.run_attempt <= Number(attempt));
  const latest = new Map();
  for (const job of eligible) latest.set(job.name, Math.max(latest.get(job.name) ?? 0, job.run_attempt));
  return eligible.filter((job) => job.run_attempt === latest.get(job.name))
    .map((job) => ({ ...job, priorFailures: eligible.filter((earlier) => earlier.name === job.name && earlier.run_attempt < job.run_attempt
      && ["failure", "timed_out"].includes(earlier.conclusion)).map((earlier) => ({ attempt: earlier.run_attempt, conclusion: earlier.conclusion, step: earlier.steps?.find((step) => step.conclusion === "failure")?.name ?? "execution" })) }))
    .sort((a, b) => b.run_attempt - a.run_attempt);
}

export async function runPlan(run, jobs, artifacts, { api = github, readArtifact = artifactFiles } = {}) {
  const preflight = jobs.find((job) => job.name.startsWith("typecheck + lint"));
  const artifact = artifacts.find((item) => item.name === `qa-plan-attempt-${preflight?.run_attempt}` && !item.expired);
  if (!artifact) return null;
  const plan = JSON.parse((await readArtifact(artifact, api))["qa-plan.json"]);
  if (plan.version !== 1 || plan.sha !== run.head_sha || plan.runId !== run.id || plan.attempt !== preflight.run_attempt || plan.attempt > run.run_attempt) {
    throw new Error("Missing current-run validation plan; rerun all jobs for this revision");
  }
  return plan;
}

/** A trusted push without its plan may still be running; it is pending, never full or healthy. */
export async function fullRunEvidence(run, { api = github, readArtifact = artifactFiles, repository = process.env.GITHUB_REPOSITORY, now = Date.now() } = {}) {
  if (!eligibleRun(run, repository, false)) return "ineligible";
  if (run.event !== "push") return "full";
  if (!Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || !/^[a-f\d]{40}$/i.test(run.head_sha)) return "unknown";
  try {
    const jobs = await runJobs(run.id, run.run_attempt, api);
    const artifacts = await pages(`/actions/runs/${run.id}/artifacts`, "artifacts", api);
    const preflight = jobs.find((job) => job.name.startsWith("typecheck + lint"));
    if (artifacts.some((artifact) => artifact.name === `qa-plan-attempt-${preflight?.run_attempt}` && artifact.expired)) return "unknown";
    const plan = await runPlan(run, jobs, artifacts, { api, readArtifact });
    if (plan) return fullPushPlan(plan) ? "full" : narrowPushPlan(plan) ? "ineligible" : "unknown";
    const age = now - Date.parse(run.created_at);
    return ["queued", "in_progress", "waiting", "requested", "pending"].includes(run.status)
      && preflight?.status !== "completed" && Number.isFinite(age) && age >= -60_000 && age < 14 * 60 * 60_000
      ? "pending" : "unknown";
  } catch { return "unknown"; }
}

export async function artifactFiles(artifact, api = github) {
  if (artifact.expired || artifact.size_in_bytes > 25 * 1024 * 1024) throw new Error("Artifact expired or too large");
  const directory = mkdtempSync(join(tmpdir(), "mausbot-qa-"));
  try {
    const archive = join(directory, "results.zip");
    writeFileSync(archive, await api(`/actions/artifacts/${artifact.id}/zip`, { raw: true }));
    const names = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8", maxBuffer: 100_000 }).trim().split("\n");
    if (names.length > 30 || names.some((name) => !/^(?:[1-8]\/)?(?:vitest|evals|qa-report|qa-plan|receipt)\.json$|^vitest-retries\.jsonl$/.test(name))) {
      throw new Error("Unexpected artifact entries");
    }
    return Object.fromEntries(names.map((name) => [name, execFileSync("unzip", ["-p", archive, name], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
