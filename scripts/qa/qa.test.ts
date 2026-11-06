import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { ALL_OS, ciOutputs, FULL_SCOPE, MAIN_SCOPE, moveLinuxIntoStatic, WINDOWS_OS } from "../ci-scope.mjs";
import { executionComplete, expectedJobs, fullPushPlan, inspectJobs, eligibleRun, holdsFor, MERGE_JOBS, narrowPushPlan, triageOf } from "./contracts.mjs";
import { fullRunEvidence, github, runJobs } from "./github.mjs";
import { qaHealth } from "./health.mjs";
import { deliverReport, makeReport, reportRun, sanitize, setupIncident, supersedingMainRun, testFindings } from "./report.mjs";
import { drainQueue, promptLead, queueItems, recoverQa } from "./queue.mjs";
import { gateRun, verifyGate } from "./gate.mjs";

const repository = "example/mausbot";
const now = Date.parse("2026-11-05T05:00:00Z");
const HOUR_MS = 60 * 60_000;
const run = { id: 100, run_attempt: 1, head_sha: "a".repeat(40), path: ".github/workflows/ci.yml", head_branch: "main", head_repository: { full_name: repository }, event: "schedule", status: "completed", created_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now).toISOString(), html_url: "https://github.com/example/mausbot/actions/runs/100" };
const report = { version: 1, runId: run.id, attempt: 1, sha: run.head_sha, finishedAt: run.updated_at, executionComplete: true, deliveryComplete: true };
const expected = [{ id: "vitest", name: "vitest (ubuntu-latest, shard 1/8)", artifact: "qa-results-vitest-ubuntu-latest-1", nodeTests: false }];
const job = { ...expected[0], id: 77, run_attempt: 1, status: "completed", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }], html_url: run.html_url + "/job/77" };
const firstExecution = { created_at: "2026-11-05T12:18:00Z", started_at: "2026-11-05T12:18:19Z", completed_at: "2026-11-05T12:22:32Z" };
const nextExecution = { created_at: "2026-11-05T12:47:31Z", started_at: "2026-11-05T12:47:32Z", completed_at: "2026-11-05T12:47:34Z" };
const pushRun = { ...run, event: "push", status: "in_progress", created_at: new Date(now - 120_000).toISOString() };
function pushPlan(selected = ciOutputs(FULL_SCOPE, ALL_OS), source = pushRun) {
  return { version: 1, runId: source.id, attempt: 1, sha: source.head_sha,
    plan: { full: true, reduced: false, scope: FULL_SCOPE, candidate: false, admitted: false },
    outputs: { ...selected, full_required: true, reduced: false, qa_areas: ["global"],
      required_jobs: selected.jobs.filter((id) => MERGE_JOBS.includes(id)), expected_jobs: expectedJobs(selected) } };
}
function narrowPlan(source = pushRun) {
  const selected = ciOutputs(MAIN_SCOPE, WINDOWS_OS);
  const plan = pushPlan(selected, source);
  return { ...plan, plan: { ...plan.plan, full: false, scope: MAIN_SCOPE },
    outputs: { ...plan.outputs, full_required: false, expected_jobs: expectedJobs(selected, false) } };
}
const testFile = "server/request-auth.test.ts";
function result(status = "failed") {
  return { "vitest.json": JSON.stringify({ numTotalTests: 1, numFailedTests: status === "failed" ? 1 : 0, numPendingTests: status === "pending" ? 1 : 0,
    testResults: [{ name: `/home/runner/work/mausbot/mausbot/${testFile}`, status,
      assertionResults: [{ ancestorTitles: ["auth"], title: "rejects a foreign owner", status, failureMessages: ["Expected 403, received 200"] }] }] }) };
}

function passedPreflight(name = "preflight") {
  const steps = ["Verify CI selection and documentation references", "Validate locale catalogs", "pnpm lint", "Source guards"];
  if (name.includes("Boat")) steps.push("Linux tests (vitest shards, behavior evals, packaged server), side by side");
  return { name, run_attempt: 1, status: "completed", conclusion: "success", steps: steps.map((name) => ({ name, conclusion: "success" })) };
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
  it("requires the relay's audit, check and test on a selected wider lane", () => {
    const selection = ciOutputs({ checks: ["relay"] }, ["ubuntu-latest"]);
    const relay = expectedJobs(selection, false).find((item) => item.id === "relay")!;
    expect(MERGE_JOBS).toContain("relay");
    expect(relay.name).toBe("relay typecheck + tests + fuzz + audit");
    const steps = ["Audit the production dependencies", "pnpm check", "pnpm test"].map((name) => ({ name, conclusion: "success" }));
    const observed = { name: relay.name, status: "completed", conclusion: "success", steps };
    expect(executionComplete([relay], [observed], new Set())).toBe(true);
    expect(executionComplete([relay], [{ ...observed, steps: steps.slice(0, -1) }], new Set())).toBe(false);
  });

  it("keeps the separate build required and its checks out of static", () => {
    const contracts = expectedJobs({ jobs: ["build"], vitest_os: [], packaged_server_os: [], vitest_matrix: { include: [] } }, false, "preflight");
    expect(contracts.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "static", name: "preflight" }, { id: "build", name: "typecheck + build" },
    ]);
    const preflight = passedPreflight();
    const build = { name: "typecheck + build", status: "completed", conclusion: "success", steps: ["pnpm typecheck", "pnpm check:electron", "production UI build"].map((name) => ({ name, conclusion: "success" })) };
    expect(executionComplete(contracts, [preflight, build], new Set())).toBe(true);
    expect(executionComplete(contracts, [preflight, { ...build, steps: build.steps.slice(1) }], new Set())).toBe(false);
  });

  it("uses the hosted and Boat preflight names, while accepting exact historical producers", async () => {
    const hosted = { jobs: [], vitest_os: [], packaged_server_os: [], vitest_matrix: { include: [] } };
    const boat = { ...hosted, linux_lanes: { vitest: [], evals: false, packaged_server: false } };
    expect(expectedJobs(hosted)[0].name).toBe("typecheck + lint");
    expect(expectedJobs(boat)[0].name).toBe("typecheck + lint + Linux tests (Boat)");
    expect(expectedJobs(hosted, true, "preflight")[0].name).toBe("preflight");
    expect(() => expectedJobs(hosted, true, "preflight + Linux tests (Boat)")).toThrow("Invalid workflow preflight");

    for (const name of ["preflight", "preflight + Linux tests (Boat)", "typecheck + lint", "typecheck + lint + Linux tests (Boat)"]) {
      const outputs = { full_required: false, expected_jobs: [{ id: "static", name }], required_jobs: [], qa_areas: ["global"], reduced: false };
      const plan = { version: 1, runId: run.id, attempt: 1, sha: run.head_sha, outputs };
      const api = async (path: string) => path.startsWith("/issues?") ? [] : path.includes("/artifacts")
        ? { artifacts: [{ name: "qa-plan-attempt-1", workflow_run: { id: run.id } }] }
        : { jobs: [passedPreflight(name)] };
      await expect(gateRun({ api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(plan) }), runId: run.id, attempt: 1, sha: run.head_sha, deadlineMs: 0 })).resolves.toBeUndefined();
    }
    const api = async (path: string) => path.includes("/jobs")
      ? { jobs: [passedPreflight("preflight"), passedPreflight("typecheck + lint")] } : { artifacts: [] };
    await expect(gateRun({ api, runId: run.id, attempt: 1, sha: run.head_sha, deadlineMs: 0 })).rejects.toThrow("Ambiguous workflow preflight");
    for (const name of ["preflight", "preflight + Linux tests (Boat)"]) {
      const failedApi = async (path: string) => path.includes("/jobs")
        ? { jobs: [{ ...passedPreflight(name), conclusion: "failure" }] } : { artifacts: [] };
      await expect(gateRun({ api: failedApi, runId: run.id, attempt: 1, sha: run.head_sha, deadlineMs: 0 })).rejects.toThrow("Preflight failure");
    }
  });

  it("keeps conditional validation steps per row across calls", () => {
    const steps = (...names: string[]) => names.map((name) => ({ name, conclusion: "success" }));
    const complete = (item: object, names: string[]) => ({ ...item, status: "completed", conclusion: "success", steps: steps(...names) });
    const hosted = { id: "static", name: "preflight" };
    const shard1 = { id: "vitest", name: "vitest (ubuntu-latest, shard 1/8)", nodeTests: true, artifact: "shard-1" };
    const shard2 = { id: "vitest", name: "vitest (ubuntu-latest, shard 2/8)", nodeTests: false, artifact: "shard-2" };
    const first = complete(shard1, ["Run tests", "Broker and Electron unit tests"]);
    const second = complete(shard2, ["Run tests"]);
    const shards = [hosted, shard1, shard2];
    const observed = [passedPreflight(), first, second];
    const artifacts = new Set(["shard-1", "shard-2"]);
    expect(executionComplete(shards, observed, artifacts)).toBe(true);
    expect(executionComplete(shards, observed, artifacts)).toBe(true);
    expect(executionComplete(shards, [observed[0], complete(shard1, ["Run tests"]), second], artifacts)).toBe(false);
    expect(executionComplete(shards, observed, new Set(["shard-1"]))).toBe(false);

    const drivers = ["ubuntu-latest", "windows-latest", "macos-latest"].map((os) => ({ id: "browser-driver", name: `browser driver S4 (${os})`, artifact: `driver-${os}` }));
    const driverJobs = drivers.map((item) => complete(item, ["S4 on the runner's Google Chrome",
      ...(item.name.includes("ubuntu") ? ["S4 inside the server image's runtime"] : []),
      ...(item.name.includes("macos") ? ["The runner's Google Chrome did not change"] : [])]));
    const driverArtifacts = new Set(drivers.map((item) => item.artifact));
    expect(executionComplete(drivers, driverJobs, driverArtifacts)).toBe(true);
    expect(executionComplete(drivers, driverJobs, driverArtifacts)).toBe(true);
    expect(executionComplete(drivers, [complete(drivers[0], ["S4 on the runner's Google Chrome"]), ...driverJobs.slice(1)], driverArtifacts)).toBe(false);
    expect(executionComplete(drivers, [...driverJobs.slice(0, 2), complete(drivers[2], ["S4 on the runner's Google Chrome"])], driverArtifacts)).toBe(false);

    const boat = { id: "static", name: "preflight + Linux tests (Boat)", linux: true };
    const boatJob = passedPreflight(boat.name);
    expect(executionComplete([boat], [boatJob], new Set())).toBe(true);
    expect(executionComplete([hosted], [passedPreflight()], new Set())).toBe(true);
    expect(executionComplete([boat], [{ ...boatJob, steps: boatJob.steps.slice(0, -1) }], new Set())).toBe(false);
    expect(executionComplete([hosted], [passedPreflight()], new Set())).toBe(true);
  });
  it("requires the fast core and typecheck steps without claiming an Electron or UI build", () => {
    const selection = { ...ciOutputs({ checks: ["build"] }, ["ubuntu-latest"]), fast_pr: true };
    const [staticJob] = expectedJobs(selection);
    expect(staticJob).toMatchObject({ fast: true, build: true });
    const names = ["Verify CI selection and documentation references", "Validate locale catalogs", "pnpm lint", "Source guards",
      "Security, data and dispatch core with bounded affected tests", "pnpm typecheck"];
    const observed = [{ name: staticJob.name, status: "completed", conclusion: "success", steps: names.map((name) => ({ name, conclusion: "success" })) }];
    expect(executionComplete([staticJob], observed, new Set())).toBe(true);
    expect(executionComplete([staticJob], [{ ...observed[0], steps: observed[0].steps.slice(0, -2) }], new Set())).toBe(false);
  });

  it("counts fast PR queue and setup from creation, prioritizing real test failures", async () => {
    const outputs = { fast_pr: true, full_required: false, reduced: false, required_jobs: [], qa_areas: ["global"],
      expected_jobs: [{ id: "static", name: "typecheck + lint", fast: true }] };
    const createdAt = 1_000_000;
    const staticJob = { name: "typecheck + lint", run_attempt: 1, status: "completed", conclusion: "success",
      started_at: new Date(createdAt + 90_000).toISOString(), completed_at: new Date(createdAt + 290_000).toISOString() };
    const jobs = [staticJob];
    const api = async (path: string) => path.startsWith("/issues?") ? [] : { jobs };
    await expect(verifyGate(outputs, { api, createdAt, now: () => createdAt + 299_000 })).resolves.toBeUndefined();
    await expect(verifyGate(outputs, { api, createdAt, now: () => createdAt + 300_001 })).rejects.toThrow(/CI performance: fast PR exceeded 5 minutes.*static-queue=90s.*static-checks=200s/);
    jobs[0] = { ...staticJob, conclusion: "failure" };
    await expect(verifyGate(outputs, { api, createdAt, now: () => createdAt + 300_001 })).rejects.toThrow("Required validation failed");
  });

  it("reports a failed required core step while static is still uploading its result", async () => {
    const createdAt = 1_000_000;
    const outputs = { fast_pr: true, full_required: false, reduced: false, required_jobs: [], qa_areas: ["global"],
      expected_jobs: [{ id: "static", name: "typecheck + lint", fast: true }] };
    const preflight = { name: "typecheck + lint", run_attempt: 1, status: "in_progress", conclusion: null,
      steps: [{ name: "Security, data and dispatch core with bounded affected tests", conclusion: "failure" },
        { name: "Upload fast results", conclusion: null }] };
    const api = async (path: string) => path.startsWith("/issues?") ? [] : { jobs: [preflight] };
    await expect(verifyGate(outputs, { api, createdAt, now: () => createdAt + 300_001 })).rejects.toThrow(
      "Required validation failed: typecheck + lint > Security, data and dispatch core with bounded affected tests");
  });

  it("classifies a queued ordinary PR with no plan at five minutes", async () => {
    const createdAt = 1_000_000;
    const prHead = "b".repeat(40);
    const preflight = { name: "typecheck + lint", run_attempt: 1, status: "in_progress", conclusion: null as string | null,
      steps: [] as { name: string; conclusion: string | null }[] };
    const api = async (path: string) => path === "/actions/runs/100"
      ? { id: run.id, run_attempt: 1, event: "pull_request", head_sha: prHead, created_at: new Date(createdAt).toISOString() }
      : path === "/pulls/7" ? { head: { sha: prHead }, labels: [] }
        : path.includes("/jobs") ? { jobs: [preflight] } : { artifacts: [] };
    const invoke = () => gateRun({ api, runId: run.id, attempt: 1, sha: run.head_sha, event: "pull_request",
      eventPayload: { pull_request: { number: 7, head: { sha: prHead }, labels: [] } }, now: () => createdAt + 300_001, deadlineMs: 400_000 });
    await expect(invoke()).rejects.toThrow("CI performance: fast PR validation plan unavailable after 5 minutes");
    preflight.steps = [{ name: "Security, data and dispatch core with bounded affected tests", conclusion: "failure" },
      { name: "Upload fast results", conclusion: null }];
    await expect(invoke()).rejects.toThrow("Preflight failed: Security, data and dispatch core with bounded affected tests");
    preflight.steps = [];
    preflight.status = "completed";
    preflight.conclusion = "failure";
    await expect(invoke()).rejects.toThrow("Preflight failure");
  });

  it("uses current PR controls for a no-plan budget even when event labels are stale", async () => {
    const createdAt = 1_000_000, prHead = "b".repeat(40);
    let currentLabels: string[] = [], currentHead = prHead, readError = false;
    const api = async (path: string) => path === "/actions/runs/100"
      ? { id: run.id, run_attempt: 1, event: "pull_request", head_sha: prHead, created_at: new Date(createdAt).toISOString() }
      : path === "/pulls/7" ? readError ? Promise.reject(new Error("current controls unavailable"))
        : { head: { sha: currentHead }, labels: currentLabels.map((name) => ({ name })) }
        : path.includes("/jobs") ? { jobs: [{ name: "typecheck + lint", run_attempt: 1, status: "in_progress", conclusion: null }] }
          : { artifacts: [] };
    const invoke = (eventLabels: string[]) => gateRun({ api, runId: run.id, attempt: 1, sha: run.head_sha,
      event: "pull_request", eventPayload: { pull_request: { number: 7, head: { sha: prHead }, labels: eventLabels.map((name) => ({ name })) } },
      now: () => createdAt + 300_001, deadlineMs: 400_000, wait: async () => { throw new Error("waiting for full plan"); } });
    for (const control of ["ci:full", "qa:repair", "windows"]) {
      currentLabels = [control];
      await expect(invoke([])).rejects.toThrow("waiting for full plan");
    }
    currentLabels = [];
    await expect(invoke(["ci:full"])).rejects.toThrow("CI performance: fast PR validation plan unavailable after 5 minutes");
    currentHead = "c".repeat(40);
    await expect(invoke([])).rejects.toThrow("PR head changed");
    currentHead = prHead;
    readError = true;
    await expect(invoke([])).rejects.toThrow("current controls unavailable");
  });

  it("binds the PR API head to the event while the plan uses the merge SHA", async () => {
    const prHead = "b".repeat(40), mergeSha = "c".repeat(40), createdAt = 1_000_000;
    const outputs = { fast_pr: true, full_required: false, reduced: false, required_jobs: [], qa_areas: ["global"],
      pr_number: 7, pr_head: prHead, expected_jobs: [{ id: "static", name: "typecheck + lint", fast: true }] };
    const plan = { version: 1, runId: run.id, attempt: 1, sha: mergeSha, outputs };
    let apiHead = prHead;
    const api = async (path: string) => path === "/actions/runs/100"
      ? { id: run.id, run_attempt: 1, event: "pull_request", head_sha: apiHead, created_at: new Date(createdAt).toISOString() }
      : path.startsWith("/issues?") ? []
        : path === "/pulls/7" ? { head: { sha: prHead }, labels: [] }
          : path.includes("/jobs") ? { jobs: [{ name: "typecheck + lint", run_attempt: 1, status: "completed", conclusion: "success" }] }
            : { artifacts: [{ name: "qa-plan-attempt-1", workflow_run: { id: run.id } }] };
    const invoke = () => gateRun({ api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(plan) }),
      runId: run.id, attempt: 1, sha: mergeSha, event: "pull_request", eventPayload: { pull_request: { number: 7, head: { sha: prHead }, labels: [] } },
      now: () => createdAt + 120_000 });
    await expect(invoke()).resolves.toBeUndefined();
    apiHead = "d".repeat(40);
    await expect(invoke()).rejects.toThrow("Invalid current PR run creation evidence");
  });

  it("budgets a rerun from its current attempt start while retaining the original run age", async () => {
    const prHead = "b".repeat(40), mergeSha = "c".repeat(40), original = 1_000_000, rerun = 10_000_000;
    const outputs = { fast_pr: true, full_required: false, reduced: false, required_jobs: [], qa_areas: ["global"],
      expected_jobs: [{ id: "static", name: "typecheck + lint", fast: true }] };
    const plan = { version: 1, runId: run.id, attempt: 2, sha: mergeSha, outputs };
    const staticJob = { name: "typecheck + lint", run_attempt: 2, status: "completed", conclusion: "success",
      created_at: new Date(rerun).toISOString(), started_at: new Date(rerun + 30_000).toISOString(), completed_at: new Date(rerun + 100_000).toISOString() };
    const api = async (path: string) => path === "/actions/runs/100"
      ? { id: run.id, run_attempt: 2, event: "pull_request", head_sha: prHead, created_at: new Date(original).toISOString(), run_started_at: new Date(rerun).toISOString() }
      : path.startsWith("/issues?") ? []
        : path.includes("/jobs") ? { jobs: [staticJob] }
          : { artifacts: [{ name: "qa-plan-attempt-2", workflow_run: { id: run.id } }] };
    const invoke = (elapsed: number) => gateRun({ api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(plan) }),
      runId: run.id, attempt: 2, sha: mergeSha, event: "pull_request", eventPayload: { pull_request: { number: 7, head: { sha: prHead }, labels: [] } },
      now: () => rerun + elapsed });
    await expect(invoke(120_000)).resolves.toBeUndefined();
    await expect(invoke(300_001)).rejects.toThrow(/CI performance: fast PR exceeded 5 minutes.*original-created-to-gate=/);
  });

  it("invalidates a fast plan when the Windows request is added after selection", async () => {
    const prHead = "b".repeat(40);
    const outputs = { fast_pr: true, full_required: false, reduced: false, required_jobs: [], qa_areas: ["global"], pr_number: 7, pr_head: prHead,
      expected_jobs: [{ id: "static", name: "typecheck + lint", fast: true }] };
    const api = async (path: string) => path === "/pulls/7" ? { head: { sha: prHead }, labels: [{ name: "windows" }] } : [];
    await expect(verifyGate(outputs, { api, createdAt: 1_000_000, now: () => 1_120_000 })).rejects.toThrow("Current PR controls require a fresh full CI run");
  });

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

  it("recognizes only a full selected push plan, including the equivalent relocated Linux lane", () => {
    const plan = pushPlan();
    const narrow = narrowPlan();
    expect(plan.outputs.expected_jobs[0]).toEqual({ id: "static", name: "typecheck + lint", build: true, linux: false });
    expect(narrow.outputs.expected_jobs[0]).toEqual({ id: "static", name: "typecheck + lint", build: true, linux: false });
    expect(plan.outputs.expected_jobs).toHaveLength(37);
    expect(fullPushPlan(plan)).toBe(true);
    expect(fullPushPlan(pushPlan(moveLinuxIntoStatic(ciOutputs(FULL_SCOPE, ALL_OS))))).toBe(true);
    expect(narrowPushPlan(narrow)).toBe(true);
    expect(narrowPushPlan(plan)).toBe(false);
    expect(narrowPushPlan({ ...narrow, plan: { ...narrow.plan, scope: FULL_SCOPE } })).toBe(false);
    for (const candidate of [
      { ...plan, outputs: { ...plan.outputs, full_required: false } },
      { ...plan, outputs: { ...plan.outputs, reduced: true } },
      { ...plan, outputs: { ...plan.outputs, expected_jobs: plan.outputs.expected_jobs.slice(1) } },
      { ...plan, outputs: { ...plan.outputs, jobs: ["vitest"] } },
      { ...plan, outputs: { ...plan.outputs, required_jobs: [] } },
      { ...plan, outputs: { ...plan.outputs, vitest_matrix: { include: plan.outputs.vitest_matrix.include.slice(1) } } },
      { ...plan, outputs: { ...plan.outputs, qa_areas: ["usage"] } },
      { ...plan, plan: { ...plan.plan, full: false } },
      { ...plan, plan: { ...plan.plan, candidate: true } },
      { ...plan, plan: { ...plan.plan, admitted: true } },
      { ...plan, plan: { ...plan.plan, scope: { areas: ["main"], checks: [] } } },
    ]) expect(fullPushPlan(candidate)).toBe(false);
  });

  it("binds a push plan to its trusted run, SHA and producing attempt without treating absent evidence as full", async () => {
    const preflight = { name: "typecheck + lint", run_attempt: 1, status: "in_progress" };
    let artifacts = [{ name: "qa-plan-attempt-1", id: 9, expired: false }];
    let value = pushPlan();
    const api = async (path: string) => {
      if (path.includes("/jobs?filter=all")) return { jobs: [preflight] };
      if (path.includes("/artifacts?")) return { artifacts };
      throw new Error(path);
    };
    const readArtifact = async () => ({ "qa-plan.json": JSON.stringify(value) });
    const check = (candidate = pushRun) => fullRunEvidence(candidate, { api, readArtifact, repository, now });
    expect(await check()).toBe("full");
    expect(await check({ ...pushRun, run_attempt: 2 })).toBe("full");
    artifacts = [{ name: "qa-plan-attempt-1", id: 9, expired: false }, { name: "qa-plan-attempt-2", id: 10, expired: true }];
    expect(await check({ ...pushRun, run_attempt: 2 })).toBe("full");
    artifacts = [{ name: "qa-plan-attempt-1", id: 9, expired: false }];
    for (const patch of [{ sha: "b".repeat(40) }, { runId: 99 }, { attempt: 2 }]) {
      value = { ...pushPlan(), ...patch };
      expect(await check()).toBe("unknown");
    }
    value = pushPlan();
    expect(await fullRunEvidence(pushRun, { api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(narrowPlan()) }), repository, now })).toBe("ineligible");
    expect(await check({ ...pushRun, head_branch: "feature" })).toBe("ineligible");
    expect(await check({ ...pushRun, head_repository: { full_name: "outsider/fork" } })).toBe("ineligible");
    expect(await check({ ...pushRun, path: ".github/workflows/untrusted.yml" })).toBe("ineligible");
    expect(await check({ ...pushRun, head_sha: "not-a-sha" })).toBe("unknown");
    artifacts = [];
    expect(await check()).toBe("pending");
    preflight.status = "completed";
    expect(await check()).toBe("unknown");
    preflight.status = "in_progress";
    expect(await check({ ...pushRun, status: "completed" })).toBe("unknown");
    expect(await check({ ...pushRun, created_at: new Date(now - 15 * 60 * 60_000).toISOString() })).toBe("unknown");
    artifacts = [{ name: "qa-plan-attempt-1", id: 9, expired: true }];
    expect(await check()).toBe("unknown");
    artifacts = [{ name: "qa-plan-attempt-1", id: 9, expired: false }];
    expect(await fullRunEvidence(pushRun, { api, readArtifact: async () => { throw new Error("unreadable"); }, repository, now })).toBe("unknown");
  });

  it("keeps zero-job cancellation open while distinguishing a newer main push from unavailable execution", async () => {
    const cancelled = { ...run, event: "push", status: "completed", conclusion: "cancelled", created_at: "2026-11-06T03:41:54Z",
      updated_at: "2026-11-06T03:47:31Z" };
    const newer = { ...cancelled, id: 101, head_sha: "b".repeat(40), status: "queued", conclusion: null,
      created_at: "2026-11-06T03:47:30Z" };
    expect(supersedingMainRun(cancelled, [newer], repository)).toEqual(newer);
    const missing = makeReport({ run: cancelled, jobs: [] });
    const superseded = makeReport({ run: cancelled, jobs: [], supersededBy: newer });
    expect(superseded).toMatchObject({ executionDisposition: "superseded", executionComplete: false, testsPassed: false });
    expect(superseded.findings[0].key).toBe(missing.findings[0].key);
    expect(superseded.findings[0].assertion).toContain("newer main push 101");
    expect(missing.executionDisposition).toBe("unavailable");
    for (const patch of [{ head_sha: cancelled.head_sha }, { event: "workflow_dispatch" }, { head_branch: "feature" },
      { head_repository: { full_name: "other/repo" } }, { created_at: "2026-11-06T03:47:32Z" }]) {
      expect(supersedingMainRun(cancelled, [{ ...newer, ...patch }], repository)).toBeNull();
    }
    expect(supersedingMainRun({ ...cancelled, conclusion: "failure" }, [newer], repository)).toBeNull();
    const calls: string[] = [];
    const api = async (path: string, options: { method?: string; body?: object } = {}) => {
      calls.push(`${options.method ?? "GET"} ${path}`);
      if (path === "/actions/runs/100") return cancelled;
      if (path.includes("/jobs?filter=all")) return { jobs: [] };
      if (path.includes("/artifacts?")) return { artifacts: [] };
      if (path === "/actions/workflows/ci.yml/runs?branch=main&per_page=100") return { workflow_runs: [newer] };
      if (path === "/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=100") return { workflow_runs: [] };
      if (path.startsWith("/issues?")) return [];
      if (path === "/issues" && options.method === "POST") return { number: 1, body: options.body };
      throw new Error(path);
    };
    const reported = await reportRun(cancelled.id, { api, repository });
    expect(reported).toMatchObject({ executionDisposition: "superseded", executionComplete: false, testsPassed: false, deliveryComplete: true });
    expect(reported.findings[0].key).toBe(missing.findings[0].key);
    expect(calls).toContain("GET /actions/workflows/ci.yml/runs?branch=main&per_page=100");
    expect(calls).toContain("POST /issues");
  });

  it("rejects PR execution and non-main manual runs as reporting sources", () => {
    expect(eligibleRun(run, repository)).toBe(true);
    expect(eligibleRun({ ...run, event: "workflow_dispatch" }, repository)).toBe(true);
    expect(eligibleRun({ ...run, event: "push" }, repository)).toBe(false);
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
    for (const hours of [24, 26]) {
      const aged = { ...report, finishedAt: new Date(now - hours * HOUR_MS).toISOString() };
      expect((await qaHealth({ api, readArtifact: async () => ({ "qa-report.json": JSON.stringify(aged) }), now, repository })).healthy).toBe(true);
    }
    const expired = { ...report, finishedAt: new Date(now - 26 * HOUR_MS - 1).toISOString() };
    const expiredHealth = await qaHealth({ api, readArtifact: async () => ({ "qa-report.json": JSON.stringify(expired) }), now, repository });
    expect(expiredHealth).toMatchObject({ healthy: false, blockedAreas: ["global"] });
    expect(expiredHealth.reason).toContain("twenty-six hours");
    for (const patch of [{ executionComplete: false }, { deliveryComplete: false }, { sha: "wrong" }, { attempt: 2 }]) {
      expect((await qaHealth({ api, readArtifact: async () => ({ "qa-report.json": JSON.stringify({ ...report, ...patch }) }), now, repository })).healthy).toBe(false);
    }
    for (const patch of [{ deliveryComplete: false }, { sha: "wrong" }, { version: 2 }, { finishedAt: "invalid" }]) {
      expect((await qaHealth({ api, readArtifact: async () => ({ "qa-report.json": JSON.stringify({ ...report, ...patch }) }), now, repository })).report).toBeUndefined();
    }
    expect((await qaHealth({ api: async () => { throw new Error("offline"); }, now, repository })).healthy).toBe(false);
    expect((await qaHealth({ api: async (path: string) => path === "/actions/runs/200" ? { ...await api(path), event: "pull_request" } : api(path), readArtifact, now, repository })).healthy).toBe(false);
  });

  it("fails closed on unreadable newer push evidence while skipping a proven narrow push", async () => {
    const current = { ...pushRun, id: 101, head_sha: "b".repeat(40), status: "completed", updated_at: new Date(now).toISOString() };
    let plan = pushPlan(ciOutputs(FULL_SCOPE, ALL_OS), current);
    let delivered = { ...report, runId: current.id, sha: current.head_sha };
    let unreadableJobs = false, unreadablePlan = false;
    const api = async (path: string) => {
      if (path.includes("ci.yml/runs")) return { workflow_runs: [current, run] };
      if (path.includes("/jobs?filter=all")) {
        if (unreadableJobs) throw new Error("jobs unavailable");
        return { jobs: [{ name: "typecheck + lint", run_attempt: 1, status: "completed", conclusion: "success" }] };
      }
      if (path.startsWith(`/actions/runs/${current.id}/artifacts?`)) return { artifacts: [{ name: "qa-plan-attempt-1", id: 9 }] };
      if (path.startsWith("/actions/artifacts?")) return { artifacts: [{ name: "mausbot-qa-report", workflow_run: { id: 200 } }] };
      if (path === "/actions/runs/200") return { path: ".github/workflows/qa-report.yml", head_branch: "main", head_repository: { full_name: repository }, event: "workflow_run", conclusion: "success" };
      if (path.startsWith("/issues?")) return [];
      throw new Error(path);
    };
    const readArtifact = async (artifact: { name: string }) => {
      if (!artifact.name.startsWith("qa-plan")) return { "qa-report.json": JSON.stringify(delivered) };
      if (unreadablePlan) throw new Error("plan unavailable");
      return { "qa-plan.json": JSON.stringify(plan) };
    };
    expect((await qaHealth({ api, readArtifact, now, repository })).healthy).toBe(true);
    delivered = { ...delivered, runId: run.id };
    expect((await qaHealth({ api, readArtifact, now, repository })).healthy).toBe(false);
    delivered = { ...delivered, runId: current.id, deliveryComplete: false };
    expect((await qaHealth({ api, readArtifact, now, repository })).healthy).toBe(false);
    delivered = { ...report };
    unreadableJobs = true;
    expect(await qaHealth({ api, readArtifact, now, repository })).toMatchObject({ healthy: false,
      reason: expect.stringMatching(/unclassifiable validation evidence/) });
    unreadableJobs = false;
    unreadablePlan = true;
    expect((await qaHealth({ api, readArtifact, now, repository })).healthy).toBe(false);
    unreadablePlan = false;
    plan = narrowPlan(current);
    expect((await qaHealth({ api, readArtifact, now, repository })).healthy).toBe(true);
  });

  it("cannot pass a selected missing full job or a newly unavailable reduced-coverage guard", async () => {
    const outputs = { full_required: true, expected_jobs: [{ id: "static", name: "preflight" }, ...expected], required_jobs: ["vitest"], qa_areas: ["usage"], reduced: false };
    const api = async (path: string) => path.startsWith("/issues?") ? [] : { jobs: [] };
    await expect(verifyGate(outputs, { api, deadlineMs: 0 })).rejects.toThrow("Incomplete required validation");
    await expect(verifyGate({ ...outputs, full_required: false, reduced: true }, { api, health: async () => ({ healthy: false, reason: "stale", blockedAreas: [] }) })).rejects.toThrow("stale");
    expect(holdsFor([{ number: 1, labels: ["qa:p0"] }, { number: 2, labels: ["qa:p1", "qa:scope:usage"] }], ["agents"], [])).toHaveLength(1);
    expect(holdsFor([{ number: 1, labels: ["qa:p0"] }], ["agents"], [1])).toEqual([]);
  });

  it("rechecks holds and authoritative repair controls after required jobs finish", async () => {
    const outputs = { full_required: true, expected_jobs: [{ id: "static", name: "preflight" }, ...expected], required_jobs: ["vitest"], qa_areas: ["usage"], reduced: false, pr_number: 7, pr_head: "head" };
    let completed = false;
    let labels: string[] = [];
    const api = async (path: string) => {
      if (path === "/pulls/7") return { head: { sha: "head" }, labels: labels.map((name) => ({ name })), body: "QA-Repair: #1" };
      if (path.startsWith("/issues?")) return completed ? [{ number: 1, labels: ["qa:p0"] }] : [];
      return { jobs: outputs.expected_jobs.map((item) => ({ ...item, run_attempt: 1, status: completed ? "completed" : "in_progress", conclusion: completed ? "success" : null })) };
    };
    await expect(verifyGate(outputs, { api, wait: async () => { completed = true; } })).rejects.toThrow("QA hold: #1");
    labels = ["qa:repair"];
    await expect(verifyGate(outputs, { api })).resolves.toBeUndefined();
    await expect(verifyGate({ ...outputs, full_required: false }, { api })).rejects.toThrow("fresh full CI");
  });

  it("accepts only a selection artifact from the exact run, attempt and revision", async () => {
    const outputs = { full_required: false, expected_jobs: [{ id: "static", name: "preflight" }], required_jobs: [], qa_areas: ["global"], reduced: false };
    const plan = { version: 1, runId: run.id, attempt: 1, sha: run.head_sha, outputs };
    const api = async (path: string) => {
      if (path.startsWith("/issues?")) return [];
      if (path.includes("/artifacts")) return { artifacts: [{ name: "qa-plan-attempt-1" }] };
      return { jobs: [{ name: "preflight", run_attempt: 1, status: "completed", conclusion: "success" }] };
    };
    const invoke = (value: object) => gateRun({ api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(value) }), runId: run.id, attempt: 1, sha: run.head_sha, event: "schedule", deadlineMs: 0 });
    await expect(invoke(plan)).resolves.toBeUndefined();
    for (const patch of [{ sha: "old" }, { runId: 99 }, { attempt: 2 }]) await expect(invoke({ ...plan, ...patch })).rejects.toThrow("Missing current-run validation plan");
  });

  it("carries successful same-run evidence for failed-jobs reruns while enforcing current controls", async () => {
    const outputs = { full_required: false, expected_jobs: [{ id: "static", name: "preflight" }, ...expected], required_jobs: ["vitest"], qa_areas: ["usage"], reduced: false, pr_number: 7, pr_head: run.head_sha };
    const plan = { version: 1, runId: run.id, attempt: 1, sha: run.head_sha, outputs };
    const jobs = [{ name: "preflight", run_attempt: 1, status: "completed", conclusion: "success" }, job, { ...job, ...nextExecution, run_attempt: 2, conclusion: "success" }];
    let labels: string[] = [];
    let expired = false;
    const api = async (path: string) => {
      if (path === "/pulls/7") return { head: { sha: run.head_sha }, labels: labels.map((name) => ({ name })) };
      if (path.startsWith("/issues?")) return [];
      if (path.includes("/artifacts")) return { artifacts: [{ name: "qa-plan-attempt-1", expired }] };
      return { jobs };
    };
    const invoke = () => gateRun({ api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(plan) }), runId: run.id, attempt: 2, sha: run.head_sha, event: "schedule", wait: async () => { throw new Error("Unexpected wait for an impossible artifact"); } });
    await expect(invoke()).resolves.toBeUndefined();
    jobs[2]!.conclusion = "failure";
    await expect(invoke()).rejects.toThrow("Required validation failed");
    jobs[2]!.conclusion = "success";
    labels = ["ci:full"];
    await expect(invoke()).rejects.toThrow("fresh full CI");
    labels = [];
    expired = true;
    await expect(invoke()).rejects.toThrow("rerun all jobs for this revision");
  });

  it("uses the producing execution for copied preflight rows and a fresh plan for attempt three", async () => {
    const original = { ...passedPreflight(), ...firstExecution, id: 10 };
    const copied = { ...original, id: 11, run_attempt: 2, created_at: nextExecution.created_at };
    const fresh = { ...original, id: 12, run_attempt: 3, created_at: "2026-11-05T12:58:20Z", started_at: "2026-11-05T12:58:21Z", completed_at: "2026-11-05T13:00:00Z" };
    const outputs = { full_required: false, expected_jobs: [{ id: "static", name: original.name }], required_jobs: [], qa_areas: ["global"], reduced: false };
    const plans = [1, 3].map((attempt) => ({ name: `qa-plan-attempt-${attempt}`, workflow_run: { id: run.id, head_sha: "b".repeat(40) } }));
    const readArtifact = vi.fn(async (artifact: { name: string }) => ({ "qa-plan.json": JSON.stringify({ version: 1, runId: run.id, attempt: Number(artifact.name.at(-1)), sha: run.head_sha, outputs }) }));
    let jobs = [original, copied, fresh];
    let artifacts = plans;
    const api = async (path: string) => path.startsWith("/issues?") ? [] : path.includes("/jobs") ? { jobs } : { artifacts };
    expect(await runJobs(run.id, 2, api)).toMatchObject([{ id: original.id, run_attempt: 1 }]);
    await expect(gateRun({ api, readArtifact, runId: run.id, attempt: 2, sha: run.head_sha, event: "schedule", deadlineMs: 0 })).resolves.toBeUndefined();
    expect(readArtifact.mock.calls[0]?.[0].name).toBe("qa-plan-attempt-1");
    await expect(gateRun({ api, readArtifact, runId: run.id, attempt: 3, sha: run.head_sha, event: "schedule", deadlineMs: 0 })).resolves.toBeUndefined();
    expect(readArtifact.mock.calls[1]?.[0].name).toBe("qa-plan-attempt-3");
    artifacts = [plans[0]!];
    await expect(gateRun({ api, readArtifact, runId: run.id, attempt: 3, sha: run.head_sha, event: "schedule", deadlineMs: 0 })).rejects.toThrow("rerun all jobs for this revision");
    jobs = [copied];
    await expect(runJobs(run.id, 2, api)).rejects.toThrow("Ambiguous workflow job execution");
    jobs = [original, copied];
    artifacts = [plans[0]!, plans[0]!];
    await expect(gateRun({ api, readArtifact, runId: run.id, attempt: 2, sha: run.head_sha, event: "schedule", deadlineMs: 0 })).rejects.toThrow("Ambiguous current-run validation plan");
    artifacts = [{ ...plans[0]!, workflow_run: { id: 99, head_sha: run.head_sha } }];
    await expect(gateRun({ api, readArtifact, runId: run.id, attempt: 2, sha: run.head_sha, event: "schedule", deadlineMs: 0 })).rejects.toThrow("rerun all jobs for this revision");
  });

  it("retries only bounded transient reads from GitHub", async () => {
    vi.stubEnv("GITHUB_REPOSITORY", repository);
    vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
    vi.stubEnv("GH_TOKEN", "synthetic-token");
    vi.stubEnv("MAUSBOT_GH_COMMAND", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      fetcher.mockResolvedValueOnce(new Response(null, { status: 502 })).mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(Response.json({ jobs: [] }));
      await expect(github("/actions/runs/100/jobs?filter=all")).resolves.toEqual({ jobs: [] });
      expect(fetcher).toHaveBeenCalledTimes(3);
      fetcher.mockClear();
      fetcher.mockResolvedValue(new Response(null, { status: 504 }));
      await expect(github("/actions/runs/100/jobs")).rejects.toThrow("GitHub GET /actions/runs/100/jobs: HTTP 504");
      expect(fetcher).toHaveBeenCalledTimes(3);
      fetcher.mockClear();
      fetcher.mockResolvedValue(new Response(null, { status: 502 }));
      await expect(github("/issues", { method: "POST", body: { title: "Synthetic" } })).rejects.toThrow("GitHub POST /issues: HTTP 502");
      expect(fetcher).toHaveBeenCalledTimes(1);
      fetcher.mockClear();
      fetcher.mockResolvedValue(new Response(null, { status: 500 }));
      await expect(github("/actions/runs/100/jobs")).rejects.toThrow("GitHub GET /actions/runs/100/jobs: HTTP 500");
      expect(fetcher).toHaveBeenCalledTimes(1);

      const socketError = (message: string) => new TypeError(message, { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
      fetcher.mockReset();
      fetcher.mockRejectedValueOnce(socketError("fetch failed")).mockResolvedValueOnce(Response.json({ jobs: [] }));
      await expect(github("/actions/runs/100/jobs")).resolves.toEqual({ jobs: [] });
      expect(fetcher).toHaveBeenCalledTimes(2);

      fetcher.mockReset();
      fetcher.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(socketError("terminated")) }).mockResolvedValueOnce(Response.json({ jobs: [] }));
      await expect(github("/actions/runs/100/jobs")).resolves.toEqual({ jobs: [] });
      expect(fetcher).toHaveBeenCalledTimes(2);

      fetcher.mockReset();
      fetcher.mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: () => Promise.reject(socketError("terminated")) }).mockResolvedValueOnce(new Response("ok"));
      await expect(github("/actions/artifacts/3/zip", { raw: true })).resolves.toEqual(Buffer.from("ok"));
      expect(fetcher).toHaveBeenCalledTimes(2);

      fetcher.mockReset();
      const exhausted = socketError("terminated");
      fetcher.mockRejectedValue(exhausted);
      await expect(github("/actions/runs/100/jobs")).rejects.toBe(exhausted);
      expect(fetcher).toHaveBeenCalledTimes(3);

      for (const options of [{ method: "POST", body: { title: "Synthetic" } }, { method: "GET", body: { filter: "all" } }]) {
        fetcher.mockReset();
        const closed = socketError("fetch failed");
        fetcher.mockRejectedValue(closed);
        await expect(github("/issues", options)).rejects.toBe(closed);
        expect(fetcher).toHaveBeenCalledTimes(1);
      }

      for (const error of [new SyntaxError("invalid JSON"), new TypeError("fetch failed", { cause: new Error("connection reset") }),
        socketError("unrelated message"), new DOMException("aborted", "AbortError"), new DOMException("deadline", "TimeoutError")]) {
        fetcher.mockReset();
        if (error instanceof SyntaxError) fetcher.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(error) });
        else fetcher.mockRejectedValue(error);
        await expect(github("/actions/runs/100/jobs")).rejects.toBe(error);
        expect(fetcher).toHaveBeenCalledTimes(1);
      }

      fetcher.mockReset();
      const deadline = socketError("terminated");
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
      try {
        fetcher.mockRejectedValue(deadline);
        await expect(github("/actions/runs/100/jobs")).rejects.toBe(deadline);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
      } finally { timeout.mockRestore(); }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
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

  it("carries successful jobs but keeps a pass after a failed workflow attempt visible", async () => {
    const { api: issuesApi, issues } = issueApi();
    const current = { ...run, event: "push", run_attempt: 2 };
    const outputs = { build: false, jobs: ["vitest"], full_required: false, vitest_matrix: { include: [{ os: "ubuntu-latest", part: "shard 1/8", shard: 1 }] } };
    const plan = { version: 1, sha: run.head_sha, runId: run.id, attempt: 1, outputs };
    const api = async (path: string, options?: object) => {
      if (path === `/actions/runs/${run.id}`) return current;
      if (path.includes("/jobs")) return { jobs: [{ name: "preflight", run_attempt: 1, status: "completed", conclusion: "success" }, job, { ...job, ...nextExecution, run_attempt: 2, conclusion: "success", steps: [{ name: "Run tests", conclusion: "success" }] }] };
      if (path.includes("/artifacts")) return { artifacts: [{ name: `${expected[0].artifact}-attempt-1` }, { name: `${expected[0].artifact}-attempt-2` }, { name: "qa-plan-attempt-1" }] };
      if (path.includes("ci.yml/runs")) return { workflow_runs: [] };
      return issuesApi(path, options);
    };
    const readArtifact = vi.fn(async (artifact: { name: string }) => artifact.name.startsWith("qa-plan") ? { "qa-plan.json": JSON.stringify(plan) } : result(artifact.name.endsWith("-2") ? "passed" : "failed"));
    const actual = await reportRun(run.id, { api, readArtifact, repository });
    expect(actual.findings).toEqual([expect.objectContaining({ kind: "unclassified", retries: 1 })]);
    expect(actual.counts.total).toBe(1);
    expect(actual.passed).not.toContain(testFindings(result("passed"), "linux").passed[0]);
    expect(issues).toHaveLength(1);
    expect(readArtifact).toHaveBeenCalledTimes(2);
  });

  it("reads a carried job's result from its producing attempt", async () => {
    const { api: issuesApi } = issueApi();
    const current = { ...run, event: "push", run_attempt: 2 };
    const outputs = { build: false, jobs: ["vitest"], full_required: false, vitest_matrix: { include: [{ os: "ubuntu-latest", part: "shard 1/8", shard: 1 }] } };
    const plan = { version: 1, sha: run.head_sha, runId: run.id, attempt: 1, outputs };
    const executed = { ...job, ...firstExecution, conclusion: "success", steps: [{ name: "Run tests", conclusion: "success" }] };
    const copied = { ...executed, id: 78, run_attempt: 2, created_at: nextExecution.created_at };
    const resultName = `${expected[0].artifact}-attempt-1`;
    let artifacts = [resultName, `${expected[0].artifact}-attempt-2`, "qa-plan-attempt-1"].map((name) => ({ name, workflow_run: { id: run.id, head_sha: run.head_sha } }));
    const api = async (path: string, options?: object) => {
      if (path === `/actions/runs/${run.id}`) return current;
      if (path.includes("/jobs")) return { jobs: [passedPreflight("typecheck + lint"), executed, copied] };
      if (path.includes("/artifacts")) return { artifacts };
      if (path.includes("ci.yml/runs")) return { workflow_runs: [] };
      return issuesApi(path, options);
    };
    const readArtifact = vi.fn(async (artifact: { name: string }) => artifact.name.startsWith("qa-plan") ? { "qa-plan.json": JSON.stringify(plan) } : result(artifact.name === resultName ? "passed" : "failed"));
    const actual = await reportRun(run.id, { api, readArtifact, repository });
    expect(actual.counts).toMatchObject({ total: 1, failed: 0 });
    expect(readArtifact.mock.calls.map(([artifact]) => artifact.name)).toEqual(["qa-plan-attempt-1", resultName]);
    artifacts = [artifacts[0]!, artifacts[0]!, artifacts[2]!];
    await expect(reportRun(run.id, { api, readArtifact, repository })).rejects.toThrow("Ambiguous result artifact");
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

  it("does not clear a preflight incident merely because its original step passed", async () => {
    const { api, issues } = issueApi();
    const preflight = passedPreflight();
    const specialist = expectedJobs().find((item) => item.id === "cloudflared-linux-arm64")!;
    const contracts = [{ id: "static", name: preflight.name, build: false }, specialist];
    const failed = { ...preflight, conclusion: "failure", steps: preflight.steps.map((step) => ({ ...step, conclusion: step.name === "pnpm lint" ? "failure" : "success" })) };
    await deliverReport(makeReport({ run, expected: contracts, jobs: [failed, { ...specialist, status: "completed", conclusion: "skipped" }] }), { api });
    expect(issues).toHaveLength(1);
    const narrow = makeReport({ run: { ...run, id: 101 }, expected: contracts.slice(0, 1), jobs: [preflight] });
    expect(narrow.executionComplete).toBe(true);
    await deliverReport(narrow, { api });
    expect(issues[0].labels.map((item: any) => item.name)).not.toContain("qa:verified");
    const complete = makeReport({ run: { ...run, id: 102 }, expected: contracts, jobs: [preflight, { ...specialist, status: "completed", conclusion: "success", steps: [{ name: "Install and reuse the pinned connector", conclusion: "success" }] }] });
    expect(complete.executionComplete).toBe(true);
    await deliverReport(complete, { api });
    expect(issues[0].labels.map((item: any) => item.name)).toContain("qa:verified");
  });

  it("requires clean relocated Linux evidence before verifying a Boat setup incident", async () => {
    const { api, issues } = issueApi();
    const contracts = expectedJobs({ build: false, jobs: [], linux_lanes: { vitest: [{}], evals: false, packaged_server: false } });
    expect(contracts[0].artifact).toBe("qa-results-boat");
    const preflight = passedPreflight(contracts[0].name);
    const failed = { ...preflight, conclusion: "failure", steps: [{ name: "Run pnpm install --frozen-lockfile", conclusion: "failure" }] };
    await deliverReport(makeReport({ run, expected: contracts, jobs: [failed], infrastructure: [setupIncident(failed, "ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/example/-/example-1.tgz")] }), { api });
    const retried = { name: "qa-results-boat", ...testFindings({ ...result("passed"), "vitest-retries.jsonl": JSON.stringify({ file: testFile, test: "auth > rejects a foreign owner", retries: 1, state: "pass" }) }, "linux") };
    const retryReport = makeReport({ run: { ...run, id: 101 }, expected: contracts, jobs: [preflight], results: [retried] });
    expect(retryReport.executionComplete).toBe(true);
    await deliverReport(retryReport, { api });
    expect(issues[0].labels.map((item: any) => item.name)).not.toContain("qa:verified");
    const clean = { name: "qa-results-boat", ...testFindings(result("passed"), "linux") };
    await deliverReport(makeReport({ run: { ...run, id: 102 }, expected: contracts, jobs: [preflight], results: [clean] }), { api });
    expect(issues[0].labels.map((item: any) => item.name)).toContain("qa:verified");
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

  it("waits through the daily grace window, recovers once, and leaves a running bootstrap alone", async () => {
    const scheduled = { ...run, updated_at: new Date(now - 24 * HOUR_MS).toISOString() };
    const calls: string[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      if (path.includes("qa-report.yml")) return { workflow_runs: [{ status: "completed", conclusion: "success", display_title: `QA report ${scheduled.id}` }] };
      return { workflow_runs: [scheduled] };
    };
    const state = {};
    const health = async () => ({ healthy: true, report: { ...report, executionComplete: true } });
    await recoverQa(state, { api, health, now, repository });
    expect(calls).toEqual([]);
    scheduled.updated_at = new Date(now - 26 * HOUR_MS).toISOString();
    await recoverQa(state, { api, health, now, repository });
    expect(calls).toEqual([]);
    await recoverQa(state, { api, health, now: now + 1, repository });
    await recoverQa(state, { api, health, now: now + 1, repository });
    expect(calls).toEqual(["/actions/workflows/ci.yml/dispatches"]);

    const bootstrap = { ...run, id: 200, event: "workflow_dispatch", status: "in_progress" };
    const bootstrapApi = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      return { workflow_runs: path.includes("qa-report.yml") ? [] : [bootstrap] };
    };
    calls.length = 0;
    await recoverQa({}, { api: bootstrapApi, health: async () => ({ healthy: false }), now, repository });
    expect(calls).toEqual([]);
  });

  it("reuses a bound full push that began before queue installation and requests only its missing report", async () => {
    const current = { ...pushRun };
    const preflight = { name: "typecheck + lint", run_attempt: 1, status: "in_progress" };
    const calls: string[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      if (path.includes("ci.yml/runs")) return { workflow_runs: [current] };
      if (path.includes("qa-report.yml/runs")) return { workflow_runs: [] };
      if (path.includes("/jobs?filter=all")) return { jobs: [preflight] };
      if (path.includes("/artifacts?")) return { artifacts: [{ name: "qa-plan-attempt-1", id: 9 }] };
      throw new Error(path);
    };
    const state = { startedAt: new Date(now - 60_000).toISOString() };
    const readArtifact = async () => ({ "qa-plan.json": JSON.stringify(pushPlan()) });
    const health = async () => ({ healthy: false, reason: "report missing" });
    await recoverQa(state, { api, readArtifact, health, now, repository });
    expect(calls).toEqual([]);
    current.status = "completed";
    preflight.status = "completed";
    await recoverQa(state, { api, readArtifact, health, now, repository });
    expect(calls).toEqual(["/actions/workflows/qa-report.yml/dispatches"]);
  });

  it("persists the selected full-push reuse and the later recovery dispatch decision", async () => {
    const current = { ...pushRun };
    const preflight = { name: "typecheck + lint", run_attempt: 1, status: "in_progress" };
    let plan: ReturnType<typeof pushPlan> | ReturnType<typeof narrowPlan> = pushPlan();
    let healthResult: { healthy: boolean; reason: string; report?: { runId: number; executionComplete: boolean } } =
      { healthy: false, reason: "report missing" };
    const calls: string[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      if (path.includes("ci.yml/runs")) return { workflow_runs: [current] };
      if (path.includes("qa-report.yml/runs")) return { workflow_runs: [] };
      if (path.includes("/jobs?filter=all")) return { jobs: [preflight] };
      if (path.includes("/artifacts?")) return { artifacts: [{ name: "qa-plan-attempt-1", id: 9 }] };
      if (path.startsWith("/issues?") || path.startsWith("/pulls?")) return [];
      throw new Error(path);
    };
    const state: Record<string, unknown> = { startedAt: new Date(now - 60_000).toISOString() };
    const saved: Array<Record<string, unknown>> = [];
    const tick = () => drainQueue(state, { api, now,
      recover: (snapshot: Record<string, unknown>) => recoverQa(snapshot, { api, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(plan) }),
        health: async () => healthResult, now, repository }),
      save: (snapshot: Record<string, unknown>) => { saved.push(structuredClone(snapshot)); },
      send: () => ({ submittedAt: new Date(now).toISOString() }) });

    await tick();
    expect(saved[0]).toMatchObject({ lastRecoveryDecision: { action: "reuse", reason: "active_full",
      candidate: { runId: current.id, sha: current.head_sha, attempt: 1, event: "push", status: "in_progress" } } });
    expect(calls).toEqual([]);

    current.status = "completed";
    preflight.status = "completed";
    healthResult = { healthy: true, reason: "", report: { runId: current.id, executionComplete: true } };
    await tick();
    expect(saved.at(-1)).toMatchObject({ lastRecoveryDecision: { action: "reuse", reason: "fresh_completed_full",
      candidate: { runId: current.id, sha: current.head_sha, attempt: 1, event: "push", status: "completed" } } });
    expect(calls).toEqual([]);

    plan = narrowPlan();
    healthResult = { healthy: false, reason: "report missing" };
    await tick();
    expect(saved.at(-1)).toMatchObject({ recoveryFor: "bootstrap", lastRecoveryDecision: {
      action: "dispatch", reason: "no_completed_full", candidate: null } });
    expect(calls).toEqual(["/actions/workflows/ci.yml/dispatches"]);
  });

  it("waits only for an active push's pending plan, then recovers when coverage is absent or narrow", async () => {
    const current = { ...pushRun };
    const preflight = { name: "typecheck + lint", run_attempt: 1, status: "in_progress" };
    const calls: string[] = [];
    let artifacts: { name: string; id: number }[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      if (path.includes("ci.yml/runs")) return { workflow_runs: [current] };
      if (path.includes("qa-report.yml/runs")) return { workflow_runs: [] };
      if (path.includes("/jobs?filter=all")) return { jobs: [preflight] };
      if (path.includes("/artifacts?")) return { artifacts };
      throw new Error(path);
    };
    const state = { startedAt: new Date(now - 60_000).toISOString() };
    const health = async () => ({ healthy: false, reason: "report missing" });
    const narrow = narrowPlan();
    const readArtifact = async () => ({ "qa-plan.json": JSON.stringify(narrow) });
    await recoverQa(state, { api, readArtifact, health, now, repository });
    expect(calls).toEqual([]);
    artifacts = [{ name: "qa-plan-attempt-1", id: 9 }];
    await recoverQa(state, { api, readArtifact, health, now, repository });
    expect(calls).toEqual(["/actions/workflows/ci.yml/dispatches"]);
    calls.length = 0;
    current.status = "completed";
    artifacts = [];
    await recoverQa({ startedAt: new Date(now - 60_000).toISOString() }, { api, readArtifact, health, now, repository });
    expect(calls).toEqual(["/actions/workflows/ci.yml/dispatches"]);
  });

  it("does not report an older full push ahead of a newer pre-installation scheduled run", async () => {
    const newer = { ...run, id: 201, created_at: new Date(now - 120_000).toISOString() };
    const older = { ...pushRun, id: 200, head_sha: "b".repeat(40), status: "completed",
      created_at: new Date(now - 180_000).toISOString() };
    const plan = pushPlan(ciOutputs(FULL_SCOPE, ALL_OS), older);
    expect(fullPushPlan(plan)).toBe(true);
    const calls: string[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      if (path.includes("ci.yml/runs")) return { workflow_runs: [newer, older] };
      if (path.includes("qa-report.yml/runs")) return { workflow_runs: [] };
      if (path.includes("/jobs?filter=all")) return { jobs: [{ name: "typecheck + lint", run_attempt: 1, status: "completed" }] };
      if (path.startsWith("/actions/artifacts?")) return { artifacts: [{ name: "mausbot-qa-report", workflow_run: { id: 300 } }] };
      if (path.includes("/artifacts?")) return { artifacts: [{ name: "qa-plan-attempt-1", id: 9 }] };
      if (path === "/actions/runs/300") return { path: ".github/workflows/qa-report.yml", head_branch: "main", head_repository: { full_name: repository }, event: "workflow_run", conclusion: "success" };
      throw new Error(path);
    };
    const readArtifact = vi.fn(async (artifact: { name: string }) => artifact.name.startsWith("qa-plan")
      ? { "qa-plan.json": JSON.stringify(plan) } : { "qa-report.json": JSON.stringify({ ...report, runId: older.id, sha: older.head_sha }) });
    const state = { startedAt: new Date(now - 60_000).toISOString() };
    expect((await qaHealth({ api, readArtifact, now, repository })).healthy).toBe(false);
    await recoverQa(state, { api, readArtifact, now, repository });
    await recoverQa(state, { api, readArtifact, now, repository });
    expect(calls).toEqual(["/actions/workflows/ci.yml/dispatches"]);
    expect(state).toMatchObject({ recoveryFor: newer.id });
    expect(readArtifact).toHaveBeenCalled();
    expect(readArtifact.mock.calls.every(([artifact]) => artifact.name === "mausbot-qa-report")).toBe(true);
  });

  it.each([
    { name: "pre-installation full run without report", event: "schedule", createdOffset: -120_000, incomplete: false, pending: false },
    { name: "delivered but incomplete full run", event: "schedule", createdOffset: -30_000, incomplete: true, pending: false },
    { name: "completed push with unknown evidence", event: "push", createdOffset: -120_000, incomplete: false, pending: false },
    { name: "pre-installation run while the older push plan is pending", event: "schedule", createdOffset: -120_000, incomplete: false, pending: true },
  ])("keeps an older active push in flight behind a newer $name", async ({ event, createdOffset, incomplete, pending }) => {
    const newer = { ...run, id: 201, event, head_sha: "c".repeat(40), created_at: new Date(now + createdOffset).toISOString() };
    const older = { ...pushRun, id: 200, head_sha: "b".repeat(40), created_at: new Date(now - 180_000).toISOString() };
    const plan = pushPlan(ciOutputs(FULL_SCOPE, ALL_OS), older);
    const calls: string[] = [];
    const api = async (path: string, options: any = {}) => {
      if (options.method === "POST") { calls.push(path); return null; }
      if (path.includes("ci.yml/runs")) return { workflow_runs: [newer, older] };
      if (path.includes("qa-report.yml/runs")) return { workflow_runs: incomplete
        ? [{ status: "completed", conclusion: "success", display_title: `QA report ${newer.id}` }] : [] };
      if (path.includes("/jobs?filter=all")) {
        if (path.includes(`/runs/${newer.id}/`)) throw new Error("newer jobs unavailable");
        return { jobs: [{ name: "typecheck + lint", run_attempt: 1, status: "in_progress" }] };
      }
      if (path.startsWith("/actions/artifacts?")) return { artifacts: incomplete
        ? [{ name: "mausbot-qa-report", workflow_run: { id: 300 } }] : [] };
      if (path.includes("/artifacts?")) return { artifacts: pending ? [] : [{ name: "qa-plan-attempt-1", id: 9 }] };
      if (path === "/actions/runs/300") return { path: ".github/workflows/qa-report.yml", head_branch: "main",
        head_repository: { full_name: repository }, event: "workflow_run", conclusion: "success" };
      if (path.startsWith("/issues?")) return [];
      throw new Error(path);
    };
    const readArtifact = vi.fn(async (artifact: { name: string }) => artifact.name.startsWith("qa-plan")
      ? { "qa-plan.json": JSON.stringify(plan) } : { "qa-report.json": JSON.stringify({ ...report, runId: newer.id,
        sha: newer.head_sha, executionComplete: false }) });
    const state = { startedAt: new Date(now - 60_000).toISOString() };
    expect((await qaHealth({ api, readArtifact, now, repository })).healthy).toBe(false);
    await recoverQa(state, { api, readArtifact, now, repository });
    await recoverQa(state, { api, readArtifact, now, repository });
    expect(calls).toEqual([]);
    expect(state).not.toHaveProperty("recoveryFor");
    expect(readArtifact.mock.calls.some(([artifact]) => artifact.name === "qa-plan-attempt-1")).toBe(!pending);
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
