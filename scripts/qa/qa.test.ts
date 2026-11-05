import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { expectedJobs, inspectJobs, eligibleRun, holdsFor, triageOf } from "./contracts.mjs";
import { qaHealth } from "./health.mjs";
import { deliverReport, makeReport, reportRun, sanitize, setupIncident, testFindings } from "./report.mjs";
import { drainQueue, promptLead, queueItems, recoverQa } from "./queue.mjs";
import { gateRun, verifyGate } from "./gate.mjs";

const repository = "example/mausbot";
const now = Date.parse("2026-11-05T05:00:00Z");
const run = { id: 100, run_attempt: 1, head_sha: "a".repeat(40), path: ".github/workflows/ci.yml", head_branch: "main", head_repository: { full_name: repository }, event: "schedule", status: "completed", created_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now).toISOString(), html_url: "https://github.com/example/mausbot/actions/runs/100" };
const report = { version: 1, runId: run.id, attempt: 1, sha: run.head_sha, finishedAt: run.updated_at, executionComplete: true, deliveryComplete: true };
const expected = [{ id: "vitest", name: "vitest (ubuntu-latest, shard 1/8)", artifact: "qa-results-vitest-ubuntu-latest-1", nodeTests: false }];
const job = { ...expected[0], id: 77, status: "completed", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }], html_url: run.html_url + "/job/77" };
const testFile = "server/request-auth.test.ts";
function result(status = "failed") {
  return { "vitest.json": JSON.stringify({ numTotalTests: 1, numFailedTests: status === "failed" ? 1 : 0, numPendingTests: status === "pending" ? 1 : 0,
    testResults: [{ name: `/home/runner/work/mausbot/mausbot/${testFile}`, status,
      assertionResults: [{ ancestorTitles: ["auth"], title: "rejects a foreign owner", status, failureMessages: ["Expected 403, received 200"] }] }] }) };
}

function issueApi() {
  const issues: any[] = [];
  const api = vi.fn(async (path: string, options: any = {}) => {
    if (path.startsWith("/issues?") && options.method !== "POST") return structuredClone(issues);
    if (path === "/issues" && options.method === "POST") {
      const issue = { ...options.body, labels: options.body.labels.map((name: string) => ({ name })), number: 1 + issues.length, state: "open", created_at: run.updated_at, html_url: "https://github.com/example/mausbot/issues/1" };
      issues.push(issue); return structuredClone(issue);
    }
    if (/^\/issues\/\d+$/.test(path) && options.method === "PATCH") {
      const issue = issues.find((item) => item.number === Number(path.split("/")[2]));
      Object.assign(issue, options.body, options.body.labels ? { labels: options.body.labels.map((name: string) => ({ name })) } : {});
      return structuredClone(issue);
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  return { api, issues };
}

describe("complete CI and trusted QA health", () => {
  it("includes every specialist job and every matrix row, excluding deployment", () => {
    const jobs = expectedJobs();
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    for (const id of Object.keys(workflow.jobs).filter((id) => !["gate", "deploy-composio-broker", "shadow"].includes(id))) {
      expect(jobs.some((job) => job.id === id), id).toBe(true);
    }
    expect(jobs.filter((job) => job.id === "vitest")).toHaveLength(20);
    const observed = jobs.map((job) => ({ ...job, status: "completed", conclusion: "success" }));
    expect(inspectJobs(jobs, observed).passed).toBe(true);
    expect(inspectJobs(jobs, observed.slice(1))).toMatchObject({ passed: false, missing: [jobs[0].name] });
    for (const conclusion of ["skipped", "cancelled", "timed_out", "failure"]) expect(inspectJobs(jobs, [{ ...observed[0], conclusion }, ...observed.slice(1)]).passed).toBe(false);
  });

  it("rejects PR execution and non-main manual runs as reporting sources", () => {
    expect(eligibleRun(run, repository)).toBe(true);
    for (const patch of [{ event: "pull_request" }, { head_branch: "feature" }, { head_repository: { full_name: "outsider/fork" } }, { path: ".github/workflows/untrusted.yml" }]) {
      expect(eligibleRun({ ...run, ...patch }, repository)).toBe(false);
    }
    const workflow = parse(readFileSync(".github/workflows/qa-report.yml", "utf8"));
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.jobs.report.steps[0].with.ref).toBe("main");
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read", issues: "write" });
  });

  it("falls back for stale, missing, incomplete, untrusted or unreadable reports", async () => {
    const api = async (path: string) => {
      if (path.includes("ci.yml/runs")) return { workflow_runs: [run] };
      if (path.startsWith("/actions/artifacts?")) return { artifacts: [{ id: 3, workflow_run: { id: 200 } }] };
      if (path === "/actions/runs/200") return { path: ".github/workflows/qa-report.yml", head_branch: "main", head_repository: { full_name: repository }, event: "workflow_run", conclusion: "success" };
      if (path.startsWith("/issues?")) return [{ number: 4, labels: [{ name: "qa:untriaged" }, { name: "qa:scope:usage" }] }];
      throw new Error(path);
    };
    const readArtifact = async () => ({ "qa-report.json": JSON.stringify(report) });
    expect(await qaHealth({ api, readArtifact, now, repository })).toMatchObject({ healthy: true, blockedAreas: ["usage"] });
    for (const patch of [{ executionComplete: false }, { deliveryComplete: false }, { sha: "wrong" }, { attempt: 2 }, { finishedAt: new Date(now - 15 * 60 * 60_000).toISOString() }]) {
      expect((await qaHealth({ api, readArtifact: async () => ({ "qa-report.json": JSON.stringify({ ...report, ...patch }) }), now, repository })).healthy).toBe(false);
    }
    for (const patch of [{ deliveryComplete: false }, { sha: "wrong" }, { version: 2 }, { finishedAt: "invalid" }]) {
      expect((await qaHealth({ api, readArtifact: async () => ({ "qa-report.json": JSON.stringify({ ...report, ...patch }) }), now, repository })).report).toBeUndefined();
    }
    expect((await qaHealth({ api: async () => { throw new Error("offline"); }, now, repository })).healthy).toBe(false);
    expect((await qaHealth({ api: async (path: string) => path === "/actions/runs/200" ? { ...await api(path), event: "pull_request" } : api(path), readArtifact, now, repository })).healthy).toBe(false);
  });

  it("cannot pass a selected missing full job or a newly unavailable reduced-coverage guard", async () => {
    const outputs = { full_required: true, expected_jobs: [{ id: "static", name: "typecheck + lint" }, ...expected], required_jobs: ["vitest"], qa_areas: ["usage"], reduced: false };
    const api = async (path: string) => path.startsWith("/issues?") ? [] : { jobs: [] };
    await expect(verifyGate(outputs, { api, deadlineMs: 0 })).rejects.toThrow("Incomplete required validation");
    await expect(verifyGate({ ...outputs, full_required: false, reduced: true }, { api, health: async () => ({ healthy: false, reason: "stale", blockedAreas: [] }) })).rejects.toThrow("stale");
    expect(holdsFor([{ number: 1, labels: ["qa:p0"] }, { number: 2, labels: ["qa:p1", "qa:scope:usage"] }], ["agents"], [])).toHaveLength(1);
    expect(holdsFor([{ number: 1, labels: ["qa:p0"] }], ["agents"], [1])).toEqual([]);
  });

  it("rechecks holds and authoritative repair controls after required jobs finish", async () => {
    const outputs = { full_required: true, expected_jobs: [{ id: "static", name: "typecheck + lint" }, ...expected], required_jobs: ["vitest"], qa_areas: ["usage"], reduced: false, pr_number: 7, pr_head: "head" };
    let completed = false;
    let labels: string[] = [];
    const api = async (path: string) => {
      if (path === "/pulls/7") return { head: { sha: "head" }, labels: labels.map((name) => ({ name })), body: "QA-Repair: #1" };
      if (path.startsWith("/issues?")) return completed ? [{ number: 1, labels: ["qa:p0"] }] : [];
      return { jobs: outputs.expected_jobs.map((item) => ({ ...item, status: completed ? "completed" : "in_progress", conclusion: completed ? "success" : null })) };
    };
    await expect(verifyGate(outputs, { api, wait: async () => { completed = true; } })).rejects.toThrow("QA hold: #1");
    labels = ["qa:repair"];
    await expect(verifyGate(outputs, { api })).resolves.toBeUndefined();
    await expect(verifyGate({ ...outputs, full_required: false }, { api })).rejects.toThrow("fresh full CI");
  });

  it("accepts only a selection artifact from the exact run, attempt and revision", async () => {
    const outputs = { full_required: false, expected_jobs: [{ id: "static", name: "typecheck + lint" }], required_jobs: [], qa_areas: ["global"], reduced: false };
    const plan = { version: 1, runId: run.id, attempt: 1, sha: run.head_sha, outputs };
    const api = async (path: string) => {
      if (path.startsWith("/issues?")) return [];
      if (path.includes("/artifacts")) return { artifacts: [{ name: "qa-plan-attempt-1" }] };
      return { jobs: [{ name: "typecheck + lint", status: "completed", conclusion: "success" }] };
    };
    const invoke = (value: object) => gateRun({ api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(value) }), runId: run.id, attempt: 1, sha: run.head_sha, deadlineMs: 0 });
    await expect(invoke(plan)).resolves.toBeUndefined();
    for (const patch of [{ sha: "old" }, { runId: 99 }, { attempt: 2 }]) await expect(invoke({ ...plan, ...patch })).rejects.toThrow("Missing current-run validation plan");
  });
});

describe("QA findings and idempotent delivery", () => {
  it("keeps retry passes as flakes and uses the same identity across revisions", () => {
    const data = testFindings({ ...result("passed"), "vitest-retries.jsonl": JSON.stringify({ file: testFile, test: "auth > rejects a foreign owner", retries: 2, state: "pass" }) }, "linux");
    expect(data.passed).toEqual([]);
    expect(data.findings).toEqual([expect.objectContaining({ kind: "flake", retries: 2 })]);
    expect(data.findings[0].key).toBe(testFindings(result(), "linux").findings[0].key);
    expect(data.findings[0].key).not.toBe(testFindings(result(), "darwin").findings[0].key);
    expect(sanitize("Bearer abcdef ghp_sensitive /Users/private/account token=abc https://host/token @somebody")).not.toMatch(/abcdef|sensitive|\/Users|token=abc|https:|@somebody/);
  });

  it("separates complete failed execution from missing jobs and missing results", () => {
    const results = [{ name: expected[0].artifact, ...testFindings(result(), "linux") }];
    expect(makeReport({ run, expected, jobs: [job], results })).toMatchObject({ executionComplete: true, testsPassed: false, deliveryComplete: false });
    expect(makeReport({ run, expected, jobs: [job], results: [] }).executionComplete).toBe(false);
    expect(makeReport({ run, expected, jobs: [], results }).executionComplete).toBe(false);
    expect(makeReport({ run, expected, jobs: [{ ...job, steps: [{ name: "Run tests", conclusion: "skipped" }] }], results }).executionComplete).toBe(false);
  });

  it("never mixes an earlier attempt's artifacts into a later report", async () => {
    const { api: issuesApi, issues } = issueApi();
    const current = { ...run, event: "push", run_attempt: 2 };
    const outputs = { build: false, jobs: ["vitest"], full_required: false, vitest_matrix: { include: [{ os: "ubuntu-latest", part: "shard 1/8", shard: 1 }] } };
    const plan = { sha: run.head_sha, runId: run.id, attempt: 2, outputs };
    const api = async (path: string, options?: object) => {
      if (path === `/actions/runs/${run.id}`) return current;
      if (path.includes("/jobs")) return { jobs: [{ name: "typecheck + lint", status: "completed", conclusion: "success" }, { ...job, conclusion: "success", steps: [{ name: "Run tests", conclusion: "success" }] }] };
      if (path.includes("/artifacts")) return { artifacts: [{ name: `${expected[0].artifact}-attempt-1` }, { name: `${expected[0].artifact}-attempt-2` }, { name: "qa-plan-attempt-2" }] };
      if (path.includes("ci.yml/runs")) return { workflow_runs: [] };
      return issuesApi(path, options);
    };
    const readArtifact = vi.fn(async (artifact: { name: string }) => artifact.name.startsWith("qa-plan") ? { "qa-plan.json": JSON.stringify(plan) } : result(artifact.name.endsWith("-2") ? "passed" : "failed"));
    const actual = await reportRun(run.id, { api, readArtifact, repository });
    expect(actual.findings).toEqual([]);
    expect(actual.counts.total).toBe(1);
    expect(issues).toEqual([]);
    expect(readArtifact).toHaveBeenCalledTimes(2);
  });

  it("groups only proven shared setup failures", () => {
    const setup = { ...job, steps: [{ name: "Run pnpm install --frozen-lockfile", conclusion: "failure" }] };
    const first = setupIncident(setup, "ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/example/-/example-1.tgz");
    const second = setupIncident({ ...setup, name: "another platform" }, "ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/example/-/example-1.tgz");
    expect(first?.key).toBe(second?.key);
    expect(setupIncident(setup, "timed out")).toBeNull();
    expect(setupIncident(job, "ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/example")).toBeNull();
    expect(makeReport({ run, expected: [], jobs: [], infrastructure: [first, second] }).findings).toHaveLength(1);
  });

  it("reports a workflow with no jobs as one incident while retaining observed test failures", () => {
    const full = makeReport({ run, jobs: [] });
    expect(full).toMatchObject({ executionComplete: false, testsPassed: false });
    expect(full.findings).toEqual([expect.objectContaining({ kind: "infrastructure", jobs: expectedJobs().map((item) => item.name) })]);
    expect(makeReport({ run, jobs: expectedJobs().slice(1).map((item) => ({ ...item, status: "completed", conclusion: "skipped" })) }).findings).toHaveLength(1);
    const observed = makeReport({ run, expected, jobs: [], results: [{ name: expected[0].artifact, ...testFindings(result(), "linux") }] });
    expect(observed.findings.map((item) => item.kind)).toEqual(["product", "infrastructure"]);
  });

  it("verifies a shared setup incident only after every affected job completes successfully", async () => {
    const { api, issues } = issueApi();
    const second = { id: "vitest", name: "vitest (windows-latest, shard 1/8)", artifact: "qa-results-vitest-windows-latest-1" };
    const contracts = [...expected, second];
    const jobs = contracts.map((item, index) => ({ ...job, ...item, id: 77 + index, steps: [{ name: "Run pnpm install --frozen-lockfile", conclusion: "failure" }] }));
    const infrastructure = jobs.map((item) => setupIncident(item, "ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/example/-/example-1.tgz"));
    await deliverReport(makeReport({ run, expected: contracts, jobs, infrastructure }), { api });
    expect(issues).toHaveLength(1);
    const successJobs = jobs.map((item) => ({ ...item, conclusion: "success", steps: [{ name: "Run tests", conclusion: "success" }] }));
    const results = contracts.map((item, index) => ({ name: item.artifact, ...testFindings(result("passed"), index ? "win32" : "linux") }));
    const labels = () => issues[0].labels.map((item: any) => item.name);
    await deliverReport(makeReport({ run: { ...run, id: 101 }, expected, jobs: successJobs.slice(0, 1), results: results.slice(0, 1) }), { api });
    expect(labels()).not.toContain("qa:verified");
    await deliverReport(makeReport({ run: { ...run, id: 102 }, expected: contracts, jobs: successJobs, results: [] }), { api });
    expect(labels()).not.toContain("qa:verified");
    const retried = { ...results[1], ...testFindings({ ...result("passed"), "vitest-retries.jsonl": JSON.stringify({ file: testFile, test: "auth > rejects a foreign owner", retries: 1, state: "pass" }) }, "win32") };
    await deliverReport(makeReport({ run: { ...run, id: 103 }, expected: contracts, jobs: successJobs, results: [results[0], retried] }), { api });
    expect(labels()).not.toContain("qa:verified");
    await deliverReport(makeReport({ run: { ...run, id: 104 }, expected: contracts, jobs: successJobs, results }), { api });
    expect(labels()).toContain("qa:verified");
    expect(issues[0].state).toBe("open");
  });

  it("creates once, preserves triage, reopens recurrence and marks verified without auto-closing", async () => {
    const { api, issues } = issueApi();
    const initial = makeReport({ run, expected, jobs: [job], results: [{ name: expected[0].artifact, ...testFindings(result(), "linux") }] });
    await deliverReport(initial, { api });
    await deliverReport(initial, { api });
    expect(issues).toHaveLength(1);
    expect(issues[0].body).toContain('"count":1');
    issues[0].labels = [{ name: "qa" }, { name: "qa:triaged" }, { name: "owner:back" }];
    issues[0].body += "\nQA-Owner: mausbot-back\nQA-Next: repair auth\nQA-Due: 2026-11-06T00:00:00Z\n";
    await deliverReport({ ...initial, runId: 101 }, { api });
    expect(issues[0].body).toContain('"count":2');
    expect(issues[0].body).toContain("QA-Owner: mausbot-back");
    expect(issues[0].labels.map((item: any) => item.name)).not.toContain("qa:untriaged");
    const success = { ...initial, runId: 102, findings: [], passed: [initial.findings[0].key], executionComplete: true };
    await deliverReport(success, { api });
    expect(issues[0].state).toBe("open");
    expect(issues[0].labels.map((item: any) => item.name)).toContain("qa:verified");
    issues[0].state = "closed";
    await deliverReport(initial, { api });
    expect(issues[0].state).toBe("closed");
    await deliverReport({ ...initial, runId: 103 }, { api });
    expect(issues[0].state).toBe("open");
    expect(issues[0].labels.map((item: any) => item.name)).toContain("qa:untriaged");
    expect(issues[0].labels.map((item: any) => item.name)).not.toContain("qa:verified");
  });

  it("ignores an older execution that finishes after newer failure and repair evidence", async () => {
    const { api, issues } = issueApi();
    const failure = makeReport({ run: { ...run, id: 101 }, expected, jobs: [job], results: [{ name: expected[0].artifact, ...testFindings(result(), "linux") }] });
    const success = makeReport({ run: { ...run, id: 102 }, expected, jobs: [{ ...job, conclusion: "success", steps: [{ name: "Run tests", conclusion: "success" }] }], results: [{ name: expected[0].artifact, ...testFindings(result("passed"), "linux") }] });
    const later = new Date(now + 60_000).toISOString();
    const labels = () => issues[0].labels.map((item: any) => item.name);
    await deliverReport(failure, { api });
    await deliverReport({ ...success, runId: 100, finishedAt: later }, { api });
    expect(labels()).not.toContain("qa:verified");
    await deliverReport(success, { api });
    expect(labels()).toContain("qa:verified");
    issues[0].state = "closed";
    await deliverReport({ ...success, runId: 104 }, { api });
    expect(issues[0].body).toContain('"lastExecution":"104:1"');
    await deliverReport({ ...failure, runId: 103, finishedAt: later }, { api });
    expect(issues[0].state).toBe("closed");
    expect(labels()).toContain("qa:verified");
  });
});

describe("Lead queue and bounded recovery", () => {
  const issue = { number: 1, created_at: run.updated_at, html_url: "https://github.com/example/mausbot/issues/1", body: "", labels: [{ name: "qa:untriaged" }] };
  it("ignores unchanged recurrence but wakes on new heads, verified repairs and the triage deadline", () => {
    const first = queueItems([issue], [], now);
    expect(queueItems([{ ...issue, body: "occurrences: 9" }], [], now)).toEqual(first);
    expect(queueItems([issue], [], now + 31 * 60_000)[0].key).not.toBe(first[0].key);
    const pr = { number: 7, draft: false, head: { sha: "a".repeat(40) }, body: `QA-Handoff: ${"a".repeat(40)}`, html_url: "https://github.com/example/mausbot/pull/7" };
    expect(queueItems([], [{ ...pr, head: { sha: "b".repeat(40) } }])).toEqual([]);
    expect(queueItems([], [pr])[0].key).not.toBe(queueItems([], [{ ...pr, head: { sha: "b".repeat(40) }, body: `QA-Handoff: ${"b".repeat(40)}` }])[0].key);
    expect(queueItems([{ ...issue, labels: [{ name: "qa:verified" }] }], [], now)[0].text).toContain("closure");
    expect(queueItems([{ ...issue, labels: [{ name: "qa:triaged" }] }], [], now)[0].text).toContain("triage");
    const triaged = { ...issue, labels: ["qa:triaged", "qa:scope:usage", "qa:kind:product", "qa:p2", "owner:back"], body: "QA-Owner: mausbot-back\nQA-Next: reproduce\nQA-Due: 2026-11-06T00:00:00Z" };
    expect(triageOf(triaged).complete).toBe(true);
    expect(triageOf({ ...triaged, labels: triaged.labels.filter((label) => label !== "qa:scope:usage") }).complete).toBe(false);
  });

  it("records submission, deduplicates handoffs and never blindly resends an ambiguous delivery", async () => {
    const api = async (path: string) => path.startsWith("/issues?") ? [issue] : [];
    const recover = async () => ({ healthy: true });
    const send = vi.fn(() => ({ submittedAt: run.updated_at }));
    const state = { version: 1 };
    expect((await drainQueue(state, { api, recover, send, now })).sent).toBe(true);
    expect((await drainQueue(state, { api, recover, send, now })).sent).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    const uncertain = {};
    const timeout = vi.fn(() => { throw new Error("timeout after possible submission"); });
    await expect(drainQueue(uncertain, { api, recover, send: timeout, now })).rejects.toThrow("timeout");
    expect((await drainQueue(uncertain, { api, recover, send: timeout, now })).uncertain).toBe(true);
    expect(timeout).toHaveBeenCalledTimes(1);
  });

  it("retries safely after Herdr is unavailable before any prompt was submitted", async () => {
    const api = async (path: string) => path.startsWith("/issues?") ? [issue] : [];
    const recover = async () => ({ healthy: true });
    const state = {};
    await expect(drainQueue(state, { api, recover, now, send: (message: string) => promptLead(message, { binary: "mausbot-test-missing-herdr-binary" }) })).rejects.toMatchObject({ code: "ENOENT", notSubmitted: true });
    expect(state).not.toHaveProperty("pending");
    const send = vi.fn(() => ({ submittedAt: run.updated_at }));
    expect((await drainQueue(state, { api, recover, now, send })).sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries report delivery without rerunning tests and starts only one shared execution recovery", async () => {
    const calls: string[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      return { workflow_runs: path.includes("ci.yml") ? [run] : [] };
    };
    const state = {};
    const health = async () => ({ healthy: false, reason: "report missing" });
    await recoverQa(state, { api, health, now, repository });
    await recoverQa(state, { api, health, now, repository });
    expect(calls).toEqual(["/actions/workflows/qa-report.yml/dispatches"]);
    calls.length = 0;
    const incomplete = async () => ({ healthy: false, report: { ...report, executionComplete: false } });
    await recoverQa(state, { api, health: incomplete, now, repository });
    await recoverQa(state, { api, health: incomplete, now, repository });
    expect(calls).toEqual(["/actions/workflows/ci.yml/dispatches"]);
  });

  it("does not backfill pre-installation runs that lack structured evidence", async () => {
    const calls: string[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      return { workflow_runs: path.includes("ci.yml") ? [run] : [] };
    };
    const state = { startedAt: new Date(now).toISOString() };
    await recoverQa(state, { api, health: async () => ({ healthy: false }), now, repository });
    await recoverQa(state, { api, health: async () => ({ healthy: false }), now, repository });
    expect(calls).toEqual(["/actions/workflows/ci.yml/dispatches"]);
  });
});
