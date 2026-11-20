import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { artifactFiles, github, pages, runJobs, runPlan } from "./github.mjs";
import { eligibleRun, executionComplete, expectedJobs, fullPushPlan, fullRunPlan, inspectJobs, issueLabels, narrowPushPlan, preflightJob } from "./contracts.mjs";
import { generatedSections, issueKey, previousCoverage, stateRecord, withState } from "./issue-state.mjs";
import { qaGroups, refreshQaGroups } from "./groups.mjs";
import { combineTextFindings, textCaseEvidence } from "./text-cases.mjs";

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

const UNKNOWN_TEST_FILE = "unknown test file";

function relativeTest(value) {
  return String(value).replaceAll("\\", "/").match(/(?:^|\/)((?:src|server|shared|scripts|evals|cloudflare|electron)\/.*?\.test\.[cm]?[jt]sx?)$/)?.[1] ?? UNKNOWN_TEST_FILE;
}

function testIssueKey(file, title, platform) {
  const identityFile = String(file).startsWith("electron/") ? UNKNOWN_TEST_FILE : file;
  return signature(`${identityFile} > ${title}`, platform);
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
        const title = [...(test.ancestorTitles ?? []), test.title].filter(Boolean).join(" > ") || test.fullName;
        const contract = `${file} > ${title}`;
        const key = testIssueKey(file, title, platform);
        if (test.status === "passed") passed.add(key);
        if (test.status === "failed") findings.push({ key, contract, file, platform, kind: "product", assertion: sanitize((test.failureMessages ?? []).join("\n")), retries: 0,
          ...(test.meta?.qaTextChange?.from === "MausBot" && test.meta.qaTextChange.to === "mymausbot" ? { textChange: { from: "MausBot", to: "mymausbot" } } : {}) });
      }
      if (suite.status === "failed" && !(suite.assertionResults ?? []).some((test) => test.status === "failed")) {
        const contract = `${file} > suite setup`;
        findings.push({ key: testIssueKey(file, "suite setup", platform), contract, file, platform, kind: "unclassified", assertion: sanitize(suite.message), retries: 0 });
      }
    }
  }
  for (const [name, text] of Object.entries(files).filter(([name]) => name.endsWith("vitest-retries.jsonl"))) {
    for (const line of text.split("\n").filter(Boolean)) {
      const retry = JSON.parse(line);
      if (retry.listError) throw new Error(`Retry evidence invalid in ${name}`);
      const contract = `${retry.file} > ${retry.test}`;
      const key = testIssueKey(retry.file, retry.test, platform);
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
const SHA = /^[a-f\d]{40}$/i;

function newerThan(report, state) {
  if (!state) return true;
  const [id, attempt] = String(state.lastExecution ?? state.lastRun).split(":").map(Number);
  return report.runId > id || report.runId === id && report.attempt > attempt;
}

function stripGeneratedBlock(body) {
  return String(body ?? "").replace(/<!-- mausbot-qa:[a-f\d]+ -->\s*<!-- mausbot-qa:start -->[\s\S]*?<!-- mausbot-qa:end -->/g, "");
}

function authorizedVerifier(entry) {
  const assoc = String(entry?.author_association ?? "").toUpperCase();
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(assoc);
}

async function isStrictAncestor(ancestorSha, descendantSha, api) {
  if (!SHA.test(ancestorSha ?? "") || !SHA.test(descendantSha ?? "")) return false;
  if (ancestorSha.toLowerCase() === descendantSha.toLowerCase()) return false;
  try {
    const comparison = await api(`/compare/${ancestorSha}...${descendantSha}`);
    return comparison?.status === "ahead"
      && Number.isSafeInteger(comparison.ahead_by) && comparison.ahead_by > 0
      && comparison.behind_by === 0;
  } catch {
    return false;
  }
}

async function isStalePreFixReport(finding, issue, record, report, api) {
  if (!issue) return false;
  const state = record?.state;
  if (state?.coverageUnknown) return false;
  const labels = issueLabels(issue);
  if (issue.state !== "closed" && !labels.includes("qa:verified")) return false;
  if (!SHA.test(report?.sha ?? "")) return false;
  if (finding.cases?.length && (state?.verified !== true || !Array.isArray(state.caseKeys)
    || !finding.cases.every((entry) => state.caseKeys.includes(entry.key)))) return false;
  if (finding.jobs?.length && (!Array.isArray(state?.verificationJobs)
    || !finding.jobs.every((job) => state.verificationJobs.includes(job)))) return false;

  const candidates = new Set();
  const author = issue.user;
  if (author?.id === 41898282 && author.type === "Bot" && author.login === "github-actions[bot]" && record?.canonical) {
    const revision = state.verifiedSha ?? (labels.includes("qa:verified") ? state.lastExecutionSha : null);
    if (typeof revision === "string" && SHA.test(revision)) candidates.add(revision.toLowerCase());
  }

  if (candidates.size === 0 && issue.state === "closed" && !finding.cases?.length && !finding.jobs?.length) {
    const coverage = state ?? previousCoverage(issue.body, finding.key);
    if ((!state && !coverage.hasRecords) || coverage.coverageUnknown || coverage.caseKeys?.length || coverage.verificationJobs?.length) return false;
    // Only trust an authorized closure comment on the same issue (outside the generated QA block).
    try {
      const comments = await pages(`/issues/${issue.number}/comments`, null, api);
      for (const comment of comments) {
        if (!authorizedVerifier(comment)) continue;
        const text = stripGeneratedBlock(comment?.body);
        if (!new RegExp(`<!--\\s*lead-qa${issue.number}-[^>]+closure[^>]*-->`, "i").test(text)) continue;
        for (const match of text.matchAll(/\bmerged at \[`([a-f\d]{40})`\]/gi)) {
          candidates.add(match[1].toLowerCase());
        }
      }
    } catch {
      return false;
    }
  }

  if (candidates.size !== 1) return false;
  const [verifiedSha] = candidates;
  return (await isStrictAncestor(report.sha, verifiedSha, api)) ? verifiedSha : false;
}

function findingBody(finding, report, state, scopeBasis, previous = "") {
  const text = [marker(finding.key), "<!-- mausbot-qa:start -->", `<!-- mausbot-qa-state ${JSON.stringify(state)} -->`,
    `Contract: ${sanitize(finding.contract)}`, `Classification: ${finding.kind}; platform: ${sanitize(finding.platform)}`,
    `Automated scope: ${state.area} (${scopeBasis}).`,
    state.area === "global" ? "Lead: verify affected callers. Retain global while impact is unknown; record the decision and supporting evidence outside this block." : "",
    `Tested revision: \`${report.sha}\`; last green revision: ${report.lastGreenSha ?? "not yet recorded"}`,
    `Run: ${report.url}`, `First seen: ${state.firstSeen}; last seen: ${state.lastSeen}; occurrences: ${state.count}`,
    `Retries: ${finding.retries}; retry passes remain findings.`,
    finding.jobs ? `Affected jobs: ${finding.jobs.map(sanitize).join(", ")}` : "",
    finding.file && finding.file !== "unknown test file" ? `Reproduce on an isolated fixture: checkout the tested revision, install the locked dependencies, then run \`pnpm exec vitest run ${finding.file}\` on ${sanitize(finding.platform)}. Match the job's OMB_VITEST_E2E and opt-in flags; never use live app data.` : "Reproducer and environment: use the linked job's exact command on the tested revision.",
    `\nAssertion:\n\`\`\`text\n${finding.assertion}\n\`\`\``, textCaseEvidence(finding, report, previous, sanitize), "<!-- mausbot-qa:end -->"].filter(Boolean).join("\n\n");
  const blocks = generatedSections(previous).filter((block) => block.key === finding.key);
  if (blocks.length === 1 && blocks[0].complete) {
    const [block] = blocks;
    return previous.slice(0, block.start) + text + previous.slice(block.start + block.text.length);
  }
  for (const block of blocks.reverse()) {
    const controls = /<!-- mausbot-qa:(?:[a-f\d]{24}|start|end) -->|<!-- mausbot-qa-state [^\r\n]+ -->|<!-- mausbot-qa-cases:(?:start|end) -->/g;
    const archived = block.text.replace(controls, (control) => {
      const pointedKey = /^<!-- mausbot-qa:([a-f\d]{24}) -->$/.exec(control)?.[1];
      return pointedKey && pointedKey !== finding.key ? control : control.replace("<!-- mausbot-qa", "<!-- archived-mausbot-qa");
    });
    previous = previous.slice(0, block.start) + archived + previous.slice(block.start + block.text.length);
  }
  return `${previous ? `${previous.replace(marker(finding.key), "")}\n\n` : ""}${text}\n\nLead triage due within 30 minutes: priority (P0/P1/P2), classification, scope, owner role, next action, due date. Use role labels, not invented GitHub assignees. Close only after Reviewer and post-integration verification evidence.\n`;
}

export async function deliverReport(report, { api = github, policy = JSON.parse(readFileSync("scripts/testing/check-policy.json", "utf8")) } = {}) {
  if (report.coverage === "focused-main" && !report.findings.length) {
    report.deliveryComplete = true;
    return report;
  }
  const issues = (await pages("/issues?state=all&labels=qa", null, api)).filter((issue) => !issue.pull_request);
  const { groups, byKey } = qaGroups(issues), changedKeys = new Set();
  const staleCasesByIssue = new Map();
  const groupParents = new Set(groups.map((group) => group.parent));
  const issuesByKey = new Map(), groupFallbacks = new Map();
  for (const issue of issues) {
    const directKey = issueKey(issue.body);
    const key = directKey ?? (groupParents.has(issue) ? issueKey(issue.body, true) : null);
    if (!key) continue;
    const claims = directKey ? issuesByKey : groupFallbacks;
    claims.set(key, claims.has(key) ? null : issue);
  }
  for (const [key, owner] of groupFallbacks) if (!issuesByKey.has(key)) issuesByKey.set(key, owner);
  const ownerFor = (key) => {
    const owner = issuesByKey.get(key);
    if (owner === null) throw new Error(`Multiple QA issues claim contract ${key}`);
    return owner;
  };
  const update = async (issue, key, patch) => {
    if (ownerFor(key) !== issue) return;
    await api(`/issues/${issue.number}`, { method: "PATCH", body: patch });
    Object.assign(issue, patch);
    changedKeys.add(key);
  };
  const findings = combineTextFindings(report.findings, issuesByKey, byKey, signature);
  for (const finding of findings) {
    const issue = ownerFor(finding.key);
    const grouped = byKey.has(finding.key);
    const record = issue && stateRecord(issue.body, finding.key);
    const previous = record?.state;
    const recurrence = issue && !grouped && (issue.state === "closed" || issueLabels(issue).includes("qa:verified"));
    const runKey = `${report.runId}:${report.attempt}`;
    if (!newerThan(report, previous)) {
      const added = finding.cases?.filter((entry) => !previous.caseKeys?.includes(entry.key)) ?? [];
      if (!added.length) continue;
      const evidence = /Affected cases [^\n]*\n<!-- mausbot-qa-cases:start -->[\s\S]*?<!-- mausbot-qa-cases:end -->/;
      if (!evidence.test(issue.body)) throw new Error(`Missing QA text case evidence #${issue.number}`);
      const state = { ...previous, verified: false, lastMembershipRun: runKey,
        caseKeys: [...new Set([...(previous.caseKeys ?? []), ...finding.cases.map((entry) => entry.key)])],
        ...(recurrence ? { triageEpoch: new Date().toISOString() } : {}) };
      const labels = issueLabels(issue).filter((label) => label !== "qa:verified" && (!recurrence || label !== "qa:triaged"));
      await update(issue, state.key, {
        body: withState(issue.body, record, state)
          .replace(evidence, textCaseEvidence(finding, report, issue.body, sanitize))
          + `\n\nLate report ${report.url} added ${added.length} previously untracked cases. Newer execution evidence is retained; the added cases still need positive verification.`,
        state: "open", labels: recurrence ? [...new Set([...labels, "qa:untriaged"])] : labels,
      });
      continue;
    }
    const mapped = policy.areas.find((entry) => entry.tests.includes(finding.file));
    const area = finding.cases ? "global" : mapped?.id ?? "global";
    const scopeBasis = finding.cases ? "grouped-case policy"
      : mapped ? "test listed in check-policy.json"
      : "conservative fallback: no test-to-area mapping in check-policy.json";
    const verifiedMember = grouped && issueLabels(issue).includes("qa:verified");
    const staleVerifiedSha = recurrence || verifiedMember ? await isStalePreFixReport(finding, issue, record, report, api) : false;
    if (staleVerifiedSha) {
      staleCasesByIssue.set(issue.number, new Set(finding.cases?.map((entry) => entry.key)));
      const entry = `${runKey}@${report.sha.toLowerCase()}`;
      const note = `Recorded stale pre-fix report ${report.url} (attempt ${report.attempt}, tested \`${report.sha}\`, strict ancestor of verified \`${staleVerifiedSha}\`).`;
      if (issue.body.includes(note)) continue;
      let body = issue.body;
      if (record?.canonical) {
        const history = Array.isArray(previous.stalePreFixRuns) ? previous.stalePreFixRuns : [];
        if (history.includes(entry)) continue;
        const staleState = { ...previous, stalePreFixRuns: [...history, entry].slice(-10) };
        body = withState(body, record, staleState);
      }
      body += `\n\n${note}`;
      await api(`/issues/${issue.number}`, { method: "PATCH", body: { body } });
      issue.body = body;
      continue;
    }
    const coverage = previous ?? (issue && previousCoverage(issue.body, finding.key));
    const parentKeys = finding.cases ? groups.find((group) => group.parent === issue)?.keys : [];
    const caseKeys = new Set([...(coverage?.caseKeys ?? []), ...(parentKeys ?? []), ...(finding.cases ?? []).map((entry) => entry.key)]);
    const verificationJobs = new Set([...(coverage?.verificationJobs ?? []), ...(finding.jobs ?? [])]);
    const state = { key: finding.key, area, firstSeen: previous?.firstSeen ?? report.finishedAt, lastSeen: report.finishedAt, count: (previous?.count ?? 0) + 1, lastRun: runKey,
      triageEpoch: !issue || recurrence ? report.finishedAt : previous?.triageEpoch ?? previous?.firstSeen ?? report.finishedAt,
      lastExecution: runKey, lastExecutionAt: report.finishedAt,
      ...(finding.cases ? { textChange: finding.textChange, verified: false } : {}),
      ...(caseKeys.size ? { caseKeys: [...caseKeys] } : {}), ...(verificationJobs.size ? { verificationJobs: [...verificationJobs] } : {}),
      ...(coverage?.coverageUnknown ? { coverageUnknown: true } : {}) };
    const body = findingBody(finding, report, state, scopeBasis, issue?.body);
    const defaults = ["qa", "qa:untriaged", `qa:kind:${finding.kind}`, `qa:scope:${area}`, "owner:lead"];
    if (issue) {
      const labels = issueLabels(issue).filter((label) => label !== "qa:verified");
      await update(issue, state.key, { body, ...(!grouped ? { state: "open" } : {}), labels: recurrence ? [...new Set([...labels.filter((label) => label !== "qa:triaged"), "qa:untriaged"])] : labels });
    } else {
      const created = await api("/issues", { method: "POST", body: { title: `[QA] ${sanitize(finding.contract).slice(0, 150)} (${sanitize(finding.platform).slice(0, 35)})`, body, labels: defaults } });
      issues.push(created);
      issuesByKey.set(finding.key, created);
    }
  }
  for (const issue of issues) {
    const record = stateRecord(issue.body);
    const state = record?.state;
    if (!newerThan(report, state)) continue;
    const staleCases = staleCasesByIssue.get(issue.number);
    if (!state) {
      const key = issueKey(issue.body, groupParents.has(issue));
      if (!key) continue;
      const coverage = previousCoverage(issue.body, key);
      if (!coverage.caseKeys.some((item) => !staleCases?.has(item) && report.findings.some((finding) => finding.key === item))) continue;
      const note = `A tracked case failed in ${report.url} (attempt ${report.attempt}). Its historical coverage records require reconciliation.`;
      const labels = issueLabels(issue);
      if (issue.state === "open" && !labels.includes("qa:verified") && issue.body.includes(note)) continue;
      await update(issue, key, {
        body: issue.body.includes(note) ? issue.body : issue.body + "\n\n" + note,
        labels: [...new Set([...labels.filter((label) => !["qa:verified", "qa:triaged"].includes(label)), "qa:untriaged"])], state: "open",
      });
      continue;
    }
    const failedCase = state.caseKeys?.some((key) => !staleCases?.has(key) && report.findings.some((finding) => finding.key === key));
    if (failedCase) {
      const recurrence = issue.state === "closed" || issueLabels(issue).includes("qa:verified");
      const failed = { ...state, verified: false, lastExecution: `${report.runId}:${report.attempt}`, lastExecutionAt: report.finishedAt,
        ...(recurrence ? { triageEpoch: report.finishedAt } : {}) };
      const labels = issueLabels(issue).filter((label) => label !== "qa:verified" && (!recurrence || label !== "qa:triaged"));
      await update(issue, state.key, {
        body: withState(issue.body, record, failed)
          + (recurrence ? `\n\nA tracked case failed or retried in ${report.url}. Aggregate verification is withdrawn; each failure retains its own current classification and evidence.` : ""),
        state: "open", labels: recurrence ? [...new Set([...labels, "qa:untriaged"])] : labels,
      });
      continue;
    }
    if (staleCases || state.coverageUnknown || !report.executionComplete || report.coverage === "focused-main") continue;
    const required = [...(state.caseKeys ?? []), ...(state.verificationJobs ?? []).map((name) => signature(`job:${name} > execution`, "job"))];
    const contractPassed = required.length ? required.every((key) => report.passed.includes(key)) : report.passed.includes(state.key);
    if (!contractPassed || report.findings.some((finding) => finding.key === state.key)) continue;
    const verified = { ...state, verified: true, ...(SHA.test(report.sha ?? "") ? { verifiedSha: report.sha.toLowerCase() } : {}), lastExecution: `${report.runId}:${report.attempt}`, lastExecutionAt: report.finishedAt };
    const alreadyVerified = issueLabels(issue).includes("qa:verified");
    await update(issue, state.key, {
      body: withState(issue.body, record, verified)
        + (alreadyVerified ? "" : `\n\nQA verified this contract without retries on \`${report.sha}\`: ${report.url}. Lead: check the integrated fix and Reviewer evidence before closing.`),
      ...(!alreadyVerified ? { labels: [...issueLabels(issue), "qa:verified"] } : {}),
    });
  }
  for (const { parent, keys, members } of groups) {
    const direct = stateRecord(parent.body)?.state;
    if (direct?.lastExecution === `${report.runId}:${report.attempt}` || direct?.lastMembershipRun === `${report.runId}:${report.attempt}`) changedKeys.add(direct.key);
    for (let i = 0; i < keys.length; i++) {
      if (stateRecord(members[i].body, keys[i])?.state.lastExecution === `${report.runId}:${report.attempt}`) changedKeys.add(keys[i]);
    }
  }
  await refreshQaGroups(groups, changedKeys, report, api, ownerFor);
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
  if (plan?.outputs?.focused_push && (run.event !== "push" || !narrowPushPlan(plan))) {
    throw new Error("Trusted focused integration plan is inconsistent with its bound source or selected jobs");
  }
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
  if (plan?.outputs?.focused_push) {
    report.coverage = "focused-main";
    report.integration = plan.integration;
    report.deferredFiles = plan.outputs.deferred_files;
    report.deferredChecks = plan.outputs.deferred_checks;
  } else {
    report.coverage = (run.event === "push" ? fullPushPlan(plan) : fullRunPlan(plan)) ? "full" : "unclassified";
  }
  if (plan?.outputs?.platform_policy) report.platformPolicy = plan.outputs.platform_policy;
  const recent = await api("/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=100");
  report.lastGreenSha = recent.workflow_runs.find((item) => eligibleRun(item, repository) && item.id < run.id)?.head_sha ?? null;
  await deliverReport(report, { api });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await reportRun(process.env.QA_RUN_ID);
  writeFileSync("qa-report.json", JSON.stringify(report, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `QA ${report.runId} (${report.coverage}): selected execution ${report.executionComplete ? "complete" : "incomplete"}; ${report.findings.length} findings; delivery complete. Tested ${report.sha}.\n`);
}
