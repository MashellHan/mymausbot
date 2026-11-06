import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { artifactFiles, github, pages, runJobs, runPlan } from "./github.mjs";
import { eligibleRun, executionComplete, expectedJobs, inspectJobs, issueLabels, preflightJob } from "./contracts.mjs";

export function sanitize(value) {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/(?:Bearer\s+|(?:gh[pousr]_|github_pat_)[\w-]*|(?:sk-|AKIA)[\w-]{12,})[^\s"']*/gi, "[redacted]")
    .replace(/(?:token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
    .replace(/https?:\/\/[^\s)]+/g, "[URL omitted]")
    .replace(/(?:[A-Z]:\\|\/(?:Users|home|tmp|private|opt)\/)[^\s:'"<>]+/gi, "[path]")
    .replace(/@/g, "(at)").replace(/`{3}/g, "'").replace(/<!--/g, "&lt;!--").slice(0, 1600);
}

export function signature(contract, platform) {
  return createHash("sha256").update(`${contract}\0${platform}`).digest("hex").slice(0, 24);
}

function relativeTest(value) {
  return String(value).replaceAll("\\", "/").match(/(?:^|\/)((?:src|server|shared|scripts|evals|cloudflare)\/.*?\.test\.[cm]?[jt]sx?)$/)?.[1] ?? "unknown test file";
}

export function testFindings(files, platform) {
  const findings = [], passed = new Set();
  let valid = false, counts = { total: 0, failed: 0, skipped: 0 };
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith(".json") || name.endsWith("qa-plan.json")) continue;
    const report = JSON.parse(text);
    if (!Array.isArray(report.testResults) || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 1) continue;
    valid = true;
    counts = { total: counts.total + report.numTotalTests, failed: counts.failed + report.numFailedTests, skipped: counts.skipped + report.numPendingTests };
    for (const suite of report.testResults) {
      const file = relativeTest(suite.name);
      for (const test of suite.assertionResults ?? []) {
        const contract = `${file} > ${[...(test.ancestorTitles ?? []), test.title].filter(Boolean).join(" > ") || test.fullName}`;
        const key = signature(contract, platform);
        if (test.status === "passed") passed.add(key);
        if (test.status === "failed") findings.push({ key, contract, file, platform, kind: "product", assertion: sanitize((test.failureMessages ?? []).join("\n")), retries: 0 });
      }
      if (suite.status === "failed" && !(suite.assertionResults ?? []).some((test) => test.status === "failed")) {
        const contract = `${file} > suite setup`;
        findings.push({ key: signature(contract, platform), contract, file, platform, kind: "unclassified", assertion: sanitize(suite.message), retries: 0 });
      }
    }
  }
  for (const [name, text] of Object.entries(files).filter(([name]) => name.endsWith("vitest-retries.jsonl"))) {
    for (const line of text.split("\n").filter(Boolean)) {
      const retry = JSON.parse(line);
      if (retry.listError) throw new Error(`Retry evidence invalid in ${name}`);
      const contract = `${retry.file} > ${retry.test}`;
      const key = signature(contract, platform);
      passed.delete(key);
      const existing = findings.find((finding) => finding.key === key);
      if (existing) existing.retries = retry.retries;
      else findings.push({ key, contract, file: retry.file, platform, kind: "flake", assertion: `Result after ${retry.retries} retries: ${retry.state}`, retries: retry.retries });
    }
  }
  return { findings, passed: [...passed], valid, counts };
}

export function setupIncident(job, log) {
  const step = job.steps?.find((item) => item.conclusion === "failure");
  if (!step || !/install|setup-node|pnpm\/action-setup/i.test(step.name)) return null;
  const code = log.match(/\b(ERR_PNPM_FETCH_\d+|ERR_PNPM_META_FETCH_FAIL|ENOSPC)\b/)?.[1];
  const target = log.match(/(?:GET|HEAD) (https:\/\/[^\s"']+)/)?.[1];
  if (!code || !target) return null;
  let hostPath;
  try { const url = new URL(target); hostPath = url.host + url.pathname; } catch { return null; }
  return { key: signature(`setup:${code}:${hostPath}`, "shared"), contract: `Dependency setup ${code}`, kind: "infrastructure", platform: "shared", assertion: `${code} at ${sanitize(hostPath)}`, jobs: [job.name], retries: 0 };
}

export function supersedingMainRun(run, runs, repository) {
  if (!eligibleRun(run, repository, false) || run.event !== "push" || run.status !== "completed" || run.conclusion !== "cancelled"
    || !/^[a-f\d]{40}$/i.test(run.head_sha ?? "") || !Array.isArray(runs)) return null;
  const created = Date.parse(run.created_at), cancelled = Date.parse(run.updated_at);
  if (!Number.isFinite(created) || !Number.isFinite(cancelled) || cancelled < created) return null;
  return runs.find((candidate) => Number.isSafeInteger(candidate.id) && candidate.id > run.id
    && eligibleRun(candidate, repository, false) && candidate.event === "push"
    && /^[a-f\d]{40}$/i.test(candidate.head_sha ?? "") && candidate.head_sha !== run.head_sha
    && Date.parse(candidate.created_at) >= created && Date.parse(candidate.created_at) <= cancelled) ?? null;
}

export function makeReport({ run, jobs, results = [], expected = expectedJobs(), infrastructure = [], supersededBy = null }) {
  const artifacts = new Set(results.filter((entry) => entry.valid).map((entry) => entry.name));
  const status = inspectJobs(expected, jobs);
  const findings = results.flatMap((entry) => entry.findings);
  const passed = results.flatMap((entry) => entry.passed);
  const grouped = new Map();
  for (const incident of infrastructure) {
    if (grouped.has(incident.key)) grouped.get(incident.key).jobs.push(...incident.jobs);
    else grouped.set(incident.key, { ...incident, jobs: [...incident.jobs] });
  }
  const preflight = expected.find((item) => item.id === "static");
  const staticJob = jobs.find((job) => job.name === preflight?.name);
  const blocked = staticJob && staticJob.conclusion !== "success" ? expected.filter((item) => item.id !== "static"
    && !jobs.some((job) => job.name === item.name && !["skipped", "cancelled"].includes(job.conclusion))).map((item) => item.name) : [];
  if (staticJob && blocked.length) {
    const incident = [...grouped.values()].find((item) => item.jobs.includes(staticJob.name));
    if (incident) incident.jobs.push(...blocked);
  }
  findings.push(...grouped.values());
  const unavailable = !staticJob && (preflight || jobs.length === 0) ? expected.filter((item) => !jobs.some((job) => job.name === item.name && !["skipped", "cancelled"].includes(job.conclusion))).map((item) => item.name) : [];
  const superseded = unavailable.length && jobs.length === 0 && run.conclusion === "cancelled" && supersededBy;
  if (unavailable.length) findings.push({ key: signature("workflow:execution unavailable", "shared"), contract: "Workflow execution unavailable", kind: "infrastructure", platform: "shared",
    assertion: superseded ? `The zero-job main run was cancelled after newer main push ${supersededBy.id} was created; this revision was not validated.`
      : "The completed workflow did not execute its required preflight or dependent validation.", jobs: unavailable, retries: 0 });
  for (const item of expected) {
    if (unavailable.includes(item.name) || blocked.includes(item.name)) continue;
    const job = jobs.find((entry) => entry.name === item.name);
    const failedStep = job?.steps?.find((step) => step.conclusion === "failure")?.name ?? "execution";
    const contract = `job:${item.name} > ${failedStep}`;
    const key = signature(contract, "job");
    if (job?.conclusion === "success") {
      const retried = job.priorFailures?.length || results.some((entry) => entry.name === item.artifact && entry.findings.some((finding) => finding.retries > 0));
      if (job.priorFailures?.length) {
        const contract = `job:${item.name} > workflow retry`;
        findings.push({ key: signature(contract, "job"), contract, kind: "unclassified", platform: item.name,
          assertion: `Passed after failed workflow attempts: ${sanitize(job.priorFailures.map((failure) => `${failure.attempt}: ${failure.step} (${failure.conclusion})`).join(", "))}`, jobs: [item.name], retries: job.priorFailures.length });
      }
      if (!retried) {
        passed.push(signature(`job:${item.name} > execution`, "job"));
        for (const step of job.steps ?? []) if (step.conclusion === "success") passed.push(signature(`job:${item.name} > ${step.name}`, "job"));
      }
    }
    else if (!infrastructure.some((incident) => incident.jobs.includes(item.name)) && !results.some((entry) => entry.name === item.artifact && entry.findings.length)) {
      findings.push({ key, contract, kind: "unclassified", platform: item.name, assertion: job ? `${job.conclusion ?? job.status}; failed step: ${sanitize(failedStep)}` : "Required job missing", retries: 0,
        ...(item.id === "static" && blocked.length ? { jobs: [item.name, ...blocked] } : {}) });
    }
  }
  return {
    version: 1, runId: run.id, attempt: run.run_attempt, sha: run.head_sha, event: run.event, url: run.html_url,
    finishedAt: run.updated_at, executionComplete: executionComplete(expected, jobs, artifacts), testsPassed: status.passed && findings.length === 0,
    ...(unavailable.length ? { executionDisposition: superseded ? "superseded" : "unavailable" } : {}),
    deliveryComplete: false, missing: status.missing, failedJobs: status.failed,
    findings: [...new Map(findings.map((finding) => [finding.key, finding])).values()], passed: [...new Set(passed)],
    jobs: jobs.filter((job) => expected.some((item) => item.name === job.name)).map(({ name, conclusion, html_url, started_at, completed_at }) => ({ name, conclusion, url: html_url, startedAt: started_at, finishedAt: completed_at })),
    counts: results.reduce((sum, entry) => ({ total: sum.total + entry.counts.total, failed: sum.failed + entry.counts.failed, skipped: sum.skipped + entry.counts.skipped }), { total: 0, failed: 0, skipped: 0 }),
  };
}

const marker = (key) => `<!-- mausbot-qa:${key} -->`;
const stateOf = (issue) => {
  try { return JSON.parse(issue.body.match(/<!-- mausbot-qa-state (.+) -->/)?.[1] ?? "null"); } catch { return null; }
};

function newerThan(report, state) {
  if (!state) return true;
  const [id, attempt] = String(state.lastExecution ?? state.lastRun).split(":").map(Number);
  return report.runId > id || report.runId === id && report.attempt > attempt;
}

function findingBody(finding, report, state, previous = "") {
  const area = state.area;
  const text = [marker(finding.key), "<!-- mausbot-qa:start -->", `<!-- mausbot-qa-state ${JSON.stringify(state)} -->`,
    `Contract: ${sanitize(finding.contract)}`, `Classification: ${finding.kind}; scope: ${area}; platform: ${sanitize(finding.platform)}`,
    `Tested revision: \`${report.sha}\`; last green revision: ${report.lastGreenSha ?? "not yet recorded"}`,
    `Run: ${report.url}`, `First seen: ${state.firstSeen}; last seen: ${state.lastSeen}; occurrences: ${state.count}`,
    `Retries: ${finding.retries}; retry passes remain findings.`,
    finding.jobs ? `Affected jobs: ${finding.jobs.map(sanitize).join(", ")}` : "",
    finding.file && finding.file !== "unknown test file" ? `Reproduce on an isolated fixture: checkout the tested revision, install the locked dependencies, then run \`pnpm exec vitest run ${finding.file}\` on ${sanitize(finding.platform)}. Match the job's OMB_VITEST_E2E and opt-in flags; never use live app data.` : "Reproducer and environment: use the linked job's exact command on the tested revision.",
    `\nAssertion:\n\`\`\`text\n${finding.assertion}\n\`\`\``, "<!-- mausbot-qa:end -->"].filter(Boolean).join("\n\n");
  if (previous.includes("<!-- mausbot-qa:start -->")) return previous.replace(/<!-- mausbot-qa:[a-f\d]+ -->\s*<!-- mausbot-qa:start -->[\s\S]*?<!-- mausbot-qa:end -->/, text);
  return `${text}\n\nLead triage due within 30 minutes: priority (P0/P1/P2), classification, scope, owner role, next action, due date. Use role labels, not invented GitHub assignees. Close only after Reviewer and post-integration verification evidence.\n`;
}

export async function deliverReport(report, { api = github, policy = JSON.parse(readFileSync("scripts/testing/check-policy.json", "utf8")) } = {}) {
  const issues = (await pages("/issues?state=all&labels=qa", null, api)).filter((issue) => !issue.pull_request);
  for (const finding of report.findings) {
    const issue = issues.find((entry) => entry.body?.includes(marker(finding.key)));
    const previous = issue ? stateOf(issue) : null;
    const runKey = `${report.runId}:${report.attempt}`;
    if (!newerThan(report, previous)) continue;
    const area = policy.areas.find((entry) => entry.tests.includes(finding.file))?.id ?? "global";
    const state = { key: finding.key, area, firstSeen: previous?.firstSeen ?? report.finishedAt, lastSeen: report.finishedAt, count: (previous?.count ?? 0) + 1, lastRun: runKey,
      triageEpoch: !issue || issue.state === "closed" ? report.finishedAt : previous?.triageEpoch ?? previous?.firstSeen ?? report.finishedAt,
      lastExecution: runKey, lastExecutionAt: report.finishedAt,
      ...(finding.jobs?.length ? { verificationJobs: [...new Set([...(previous?.verificationJobs ?? []), ...finding.jobs])] } : {}) };
    const body = findingBody(finding, report, state, issue?.body);
    const defaults = ["qa", "qa:untriaged", `qa:kind:${finding.kind}`, `qa:scope:${area}`, "owner:lead"];
    if (issue) {
      const labels = issueLabels(issue).filter((label) => label !== "qa:verified");
      await api(`/issues/${issue.number}`, { method: "PATCH", body: { body, state: "open", labels: issue.state === "closed" ? [...new Set([...labels.filter((label) => label !== "qa:triaged"), "qa:untriaged"])] : labels } });
    } else {
      const created = await api("/issues", { method: "POST", body: { title: `[QA] ${sanitize(finding.contract).slice(0, 150)} (${sanitize(finding.platform).slice(0, 35)})`, body, labels: defaults } });
      issues.push(created);
    }
  }
  if (report.executionComplete) {
    for (const issue of issues) {
      const state = stateOf(issue);
      const contractPassed = state && (state.verificationJobs?.length
        ? state.verificationJobs.every((name) => report.passed.includes(signature(`job:${name} > execution`, "job"))) : report.passed.includes(state.key));
      if (!state || !newerThan(report, state) || !contractPassed || report.findings.some((finding) => finding.key === state.key)) continue;
      const verified = { ...state, lastExecution: `${report.runId}:${report.attempt}`, lastExecutionAt: report.finishedAt };
      const alreadyVerified = issueLabels(issue).includes("qa:verified");
      await api(`/issues/${issue.number}`, { method: "PATCH", body: {
        body: issue.body.replace(/<!-- mausbot-qa-state (.+) -->/, `<!-- mausbot-qa-state ${JSON.stringify(verified)} -->`)
          + (alreadyVerified ? "" : `\n\nQA verified this contract without retries on \`${report.sha}\`: ${report.url}. Lead: check the integrated fix and Reviewer evidence before closing.`),
        ...(!alreadyVerified ? { labels: [...issueLabels(issue), "qa:verified"] } : {}),
      } });
    }
  }
  report.deliveryComplete = true;
  return report;
}

export async function reportRun(id, { api = github, readArtifact = artifactFiles, repository = process.env.GITHUB_REPOSITORY } = {}) {
  if (!/^\d+$/.test(String(id))) throw new Error("A numeric CI run ID is required");
  const run = await api(`/actions/runs/${id}`);
  if (!eligibleRun(run, repository, false) || run.status !== "completed") throw new Error("Reporter accepts only completed trusted main CI runs");
  const jobs = await runJobs(id, run.run_attempt, api);
  const artifacts = await pages(`/actions/runs/${id}/artifacts`, "artifacts", api);
  const results = [];
  const plan = await runPlan(run, jobs, artifacts, { api, readArtifact });
  const producer = preflightJob(jobs);
  if (run.event !== "push" && !plan) throw new Error("Trusted validation plan unavailable; historical coverage cannot be reconstructed");
  const expected = plan ? expectedJobs(plan.outputs, plan.outputs.full_required, producer?.name)
    : expectedJobs(undefined, true, producer?.name);
  if (run.event !== "push" && (plan.outputs?.full_required !== true || !isDeepStrictEqual(plan.outputs.expected_jobs, expected))) {
    throw new Error("Trusted full validation plan is inconsistent with its selected jobs");
  }
  const selectedArtifacts = new Set();
  for (const artifact of artifacts.filter((item) => item.name.startsWith("qa-results-"))) {
    const match = artifact.name.match(/^(qa-results-.+)-attempt-(\d+)$/);
    const contract = match && expected.find((item) => item.artifact === match[1]);
    const job = contract && jobs.find((item) => item.name === contract.name);
    if (!job || job.run_attempt !== Number(match[2])) continue;
    if (selectedArtifacts.has(artifact.name)) throw new Error(`Ambiguous result artifact: ${artifact.name}`);
    selectedArtifacts.add(artifact.name);
    if (artifact.workflow_run && (artifact.workflow_run.id !== run.id || artifact.workflow_run.head_sha !== run.head_sha)) {
      throw new Error(`Result artifact does not belong to this run: ${artifact.name}`);
    }
    const files = await readArtifact(artifact, api);
    const platform = artifact.name.includes("windows") ? "win32" : artifact.name.includes("macos") ? "darwin" : "linux";
    const result = testFindings(files, platform);
    if (job.priorFailures.length) result.passed = [];
    results.push({ name: match[1], ...result });
  }
  const infrastructure = [];
  for (const job of jobs.filter((item) => item.conclusion === "failure" && expected.some((entry) => entry.name === item.name))) {
    if (!job.steps?.some((step) => step.conclusion === "failure" && /install|setup-node|pnpm\/action-setup/i.test(step.name))) continue;
    let incident;
    try { incident = setupIncident(job, String(await api(`/actions/jobs/${job.id}/logs`, { raw: true }))); } catch { /* The job remains an unclassified finding. */ }
    if (incident) infrastructure.push(incident);
  }
  let supersededBy = null;
  if (run.event === "push" && run.conclusion === "cancelled" && jobs.length === 0) {
    try {
      const recent = await api("/actions/workflows/ci.yml/runs?branch=main&per_page=100");
      supersededBy = supersedingMainRun(run, recent.workflow_runs, repository);
    } catch (error) {
      console.warn(`Could not verify a superseding main run: ${error.message}`);
    }
  }
  const report = makeReport({ run, jobs, results, expected, infrastructure, supersededBy });
  const recent = await api("/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=100");
  report.lastGreenSha = recent.workflow_runs.find((item) => eligibleRun(item, repository) && item.id < run.id)?.head_sha ?? null;
  await deliverReport(report, { api });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await reportRun(process.env.QA_RUN_ID);
  writeFileSync("qa-report.json", JSON.stringify(report, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `QA ${report.runId}: execution ${report.executionComplete ? "complete" : "incomplete"}; ${report.findings.length} findings; delivery complete. Tested ${report.sha}.\n`);
}
