import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { ciOutputs } from "../ci-scope.mjs";
import { expectedJobs, holdsFor } from "./contracts.mjs";
import { verifyGate } from "./gate.mjs";
import { drainQueue } from "./queue.mjs";
import { ciCase, closureCases, queueCases, recordCases, scanProcesses } from "./scan.mjs";

const start = Date.parse("2026-11-09T01:00:00Z"), now = start + 400_000;
const run = { id: 100, run_attempt: 1, event: "pull_request", path: ".github/workflows/ci.yml", repository: { full_name: "example/mausbot" },
  head_sha: "a".repeat(40), status: "completed", created_at: new Date(start).toISOString(), updated_at: new Date(now).toISOString() };
const selected = { ...ciOutputs({ checks: ["build"] }, ["ubuntu-latest"]), fast_pr: true };
const outputs = { ...selected, full_required: false, reduced: false, required_jobs: [], qa_areas: ["global"],
  expected_jobs: expectedJobs(selected, false) };
const jobs = [
  { name: "typecheck + lint", run_attempt: 1, status: "completed", conclusion: "success", started_at: new Date(start + 3_000).toISOString(),
    completed_at: new Date(start + 307_000).toISOString(), steps: [{ name: "Security, data and dispatch core with bounded affected tests", status: "completed", conclusion: "success", started_at: new Date(start + 93_000).toISOString(), completed_at: new Date(start + 307_000).toISOString() }] },
  { name: "CI", run_attempt: 1, status: "completed", conclusion: "success", completed_at: new Date(start + 313_000).toISOString() },
];

function fixture() {
  const issues: { number: number; body: string; title: string; labels: string[]; state: string; html_url: string }[] = [];
  const api = vi.fn(async (path: string, options?: { method?: string; body?: { body: string; title: string; labels: string[] } }) => {
    if (path.startsWith("/issues?")) return path.includes("labels=qa:process") ? structuredClone(issues) : [];
    if (path === "/issues" && options?.method === "POST" && options.body) {
      const item = { ...options.body, number: issues.length + 1, state: "open", html_url: "https://github.com/example/mausbot/issues/1" };
      issues.push(item); return structuredClone(item);
    }
    if (path.startsWith("/pulls?")) return [];
    if (path.includes("/jobs?")) return { jobs };
    if (path.includes("/ci.yml/runs?")) return { workflow_runs: [run] };
    throw new Error(`Unexpected API request: ${path}`);
  });
  return { api, issues };
}

describe("advisory process scan", () => {
  it("keeps a slow successful gate green and files one independent optimization case", async () => {
    const f = fixture(), state = {};
    await expect(verifyGate(outputs, { api: f.api, createdAt: start, now: () => now })).resolves.toBeUndefined();
    const result = await scanProcesses(state, { ...f, now, repository: "example/mausbot", publish: true });
    expect(result.outcome).toBe("optimization_needed");
    expect(result.findings[0].text).toContain("attempt-to-gate=313s");
    expect(result.findings[0].text).toContain("static-queue=3s");
    expect(result.findings[0].text).toContain('"seconds":214');
    expect(f.issues[0].labels).toEqual(["qa:process"]);
    await scanProcesses(state, { ...f, now, repository: "example/mausbot", publish: true });
    expect(f.issues).toHaveLength(1);
    expect(f.api.mock.calls.filter(([path]) => path.includes("/jobs?"))).toHaveLength(2);
  });

  it("measures reruns from their attempt and ignores wider lanes and the exact target", () => {
    expect(ciCase(run, [{ ...jobs[1], completed_at: new Date(start + 300_000).toISOString() }], true, now)).toBeNull();
    expect(ciCase(run, jobs, false, now)).toBeNull();
    const rerunStart = start + 10_000_000;
    const rerun = { ...run, run_attempt: 2, run_started_at: new Date(rerunStart).toISOString() };
    const gate = { ...jobs[1], run_attempt: 2, completed_at: new Date(rerunStart + 301_000).toISOString() };
    expect(ciCase(rerun, [gate], true, now)?.text).toContain("attempt-to-gate=301s; original-created-to-gate=10301s");
  });

  it("keeps concurrent workflow observation read-only while the queue publishes once", async () => {
    const f = fixture();
    const [observation, publication] = await Promise.all([
      scanProcesses({}, { ...f, now, repository: "example/mausbot" }),
      scanProcesses({}, { ...f, now, repository: "example/mausbot", publish: true }),
    ]);
    expect(observation.outcome).toBe("optimization_needed");
    expect(observation.handoffs).toEqual([]);
    expect(publication.handoffs).toHaveLength(1);
    expect(f.api.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it.each(["skipped", "cancelled"])("does not diagnose pending wide or cancelled work from a %s fast core", async (conclusion) => {
    const f = fixture();
    const api = async (path: string, options?: Parameters<typeof f.api>[1]) => {
      if (path.includes("/ci.yml/runs?")) return { workflow_runs: [{ ...run, status: "in_progress" }] };
      if (path.includes("/jobs?")) return { jobs: [{ ...jobs[0], steps: [{ ...jobs[0].steps[0], conclusion }] }] };
      return f.api(path, options);
    };
    const result = await scanProcesses({}, { api, now, repository: "example/mausbot", prs: [{ number: 1, head: { sha: run.head_sha }, labels: [] }], issues: [] });
    expect(result.findings).toEqual([]);
    expect(f.issues).toEqual([]);
  });

  it("records queue or setup latency when fast-core execution is not yet observed", async () => {
    const f = fixture();
    const api = async (path: string, options?: Parameters<typeof f.api>[1]) => {
      if (path.includes("/ci.yml/runs?")) return { workflow_runs: [{ ...run, status: "queued" }] };
      if (path.includes("/jobs?")) return { jobs: [] };
      return f.api(path, options);
    };
    const result = await scanProcesses({}, { api, now, repository: "example/mausbot", prs: [{ number: 1, head: { sha: run.head_sha }, labels: [] }], issues: [] });
    expect(result.findings.map((item) => item.rule)).toEqual(["ci-latency"]);
    expect(result.findings[0].text).toContain("Inspect queue/setup");
    expect(f.issues).toEqual([]);
  });

  it("does not diagnose a wider run with a skipped fast core or revive a resolved old run", async () => {
    const f = fixture();
    const wide = async (path: string, options?: Parameters<typeof f.api>[1]) => path.includes("/jobs?")
      ? { jobs: [{ ...jobs[0], steps: [{ ...jobs[0].steps[0], conclusion: "skipped" }] }, jobs[1]] } : f.api(path, options);
    expect((await scanProcesses({}, { api: wide, now, repository: "example/mausbot" })).outcome).toBe("passed");
    await scanProcesses({}, { ...f, now, repository: "example/mausbot", publish: true });
    f.issues[0].state = "closed";
    expect((await scanProcesses({}, { ...f, now, repository: "example/mausbot", publish: true })).outcome).toBe("passed");
    expect(f.issues).toHaveLength(1);
  });

  it("records PR and QA deadlines without permitting closure or quality holds", async () => {
    const pr = { number: 106, head: { sha: run.head_sha }, draft: true, created_at: new Date(start - 25 * 3_600_000).toISOString(), updated_at: new Date(start - 13 * 3_600_000).toISOString() };
    const qa = { number: 5, created_at: new Date(start - 31 * 60_000).toISOString(), labels: ["qa:untriaged"] };
    const findings = queueCases([qa], [pr], start);
    expect(findings.map((item) => item.rule)).toEqual(["pr-age", "pr-inactivity", "qa-triage"]);
    const f = fixture();
    await recordCases(findings, { api: f.api, now });
    expect(f.api.mock.calls.every(([path]) => path.startsWith("/issues"))).toBe(true);
    expect(holdsFor([{ number: 1, labels: ["qa", "qa:process", "qa:p0"] }, { number: 2, labels: ["qa:p0"] }], ["global"]).map((issue) => issue.number)).toEqual([2]);
    expect(queueCases([{ ...qa, labels: ["qa:verified"] }], [], start)).toEqual([]);
  });

  it("queues process cases already filed by the serialized publisher without refiling or reviving resolved cases", async () => {
    const f = fixture(), cases = [ciCase(run, jobs, true, now)!];
    const first = await recordCases(cases, { api: f.api, now });
    expect(await recordCases([], { api: f.api, now })).toEqual(first);
    expect(f.issues).toHaveLength(1);
    f.issues[0].state = "closed";
    expect(await recordCases(cases, { api: f.api, now })).toEqual([]);
    expect(f.issues).toHaveLength(1);
  });

  it.each(["qa-triage", "qa-repair"])("keeps %s on its original QA issue across renewed deadlines", async (rule) => {
    const f = fixture();
    const overdue = "2026-11-08T01:00:00Z", renewed = "2026-11-09T00:00:00Z";
    const qa = {
      number: 5, created_at: overdue, html_url: "https://github.com/example/mausbot/issues/5",
      labels: rule === "qa-triage" ? ["qa", "qa:untriaged"]
        : ["qa", "qa:triaged", "qa:p2", "qa:kind:flake", "qa:scope:global", "owner:back"],
      body: `{"triageEpoch":"${overdue}"}\nQA-Owner: mausbot-back\nQA-Due: ${overdue}\nQA-Next: reproduce`,
    };
    const original = queueCases([qa], [], now)[0];
    qa.body = qa.body.replaceAll(overdue, renewed);
    const updated = queueCases([qa], [], now)[0];
    expect(updated).toMatchObject({ rule, subject: "issue:5", key: original.key });
    expect(updated.text).toContain(renewed);
    expect(updated.text).not.toContain(overdue);
    f.issues.push({ number: 6, title: `[Process] ${rule}: issue:5:${overdue}`, state: "open", labels: ["qa:process"],
      html_url: "https://github.com/example/mausbot/issues/6", body: `Process-Rule: ${rule}\nProcess-Subject: issue:5:${overdue}\n` });
    const api = async (path: string, options?: Parameters<typeof f.api>[1]) => {
      if (path.includes("/ci.yml/runs?")) return { workflow_runs: [] };
      if (path.startsWith("/issues?") && !path.includes("labels=qa:process")) return [qa];
      return f.api(path, options);
    };
    const send = vi.fn(async (_message: string) => ({ submittedAt: new Date(now).toISOString() }));
    const result = await drainQueue({}, { api, recover: async () => ({ healthy: true }), send, now });
    expect(result.sent).toBe(true);
    expect(result.state.lastProcessScan).toMatchObject({ outcome: "optimization_needed", handoffs: [], findings: [updated] });
    expect(send.mock.calls[0][0]).toContain(`${qa.html_url}: overdue`);
    expect(send.mock.calls[0][0]).not.toContain("/issues/6");
    expect(f.issues).toHaveLength(1);
    expect(f.api.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    expect(holdsFor([qa], ["global"])).toEqual([]);
    expect((await drainQueue(result.state, { api, recover: async () => ({ healthy: true }), send, now })).sent).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retains scan observations for a safe retry when issue delivery fails", async () => {
    const f = fixture(), state = {};
    const unavailable = async (path: string, options?: Parameters<typeof f.api>[1]) => {
      if (options?.method === "POST") throw new Error("issue delivery unavailable");
      return f.api(path, options);
    };
    await expect(scanProcesses(state, { ...f, api: unavailable, now, repository: "example/mausbot", publish: true })).rejects.toThrow("issue delivery unavailable");
    expect(state).not.toHaveProperty("completedRuns");
    await scanProcesses(state, { ...f, now, repository: "example/mausbot", publish: true });
    expect(f.issues).toHaveLength(1);
  });

  it("detects procedural closures and distinguishes recovery from main adoption without mutating a PR", async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith("/pulls?")) return [103, 106].map((number) => ({ number, closed_at: new Date(now).toISOString(), merged_at: null,
        head: { ref: `saved-${number}`, sha: String(number).repeat(13).padEnd(40, "a").slice(0, 40) } }));
      if (path.includes("/comments?")) return [{ body: "Closing under the fixed 24-hour PR disposition policy." }];
      return { ahead_by: path.includes("103") ? 0 : 1 };
    });
    const result = await closureCases({}, { api, now });
    expect(result.findings[0].text).toContain("already included in main");
    expect(result.findings[1].text).toContain("reopen useful unadopted work on the same PR");
    expect(api.mock.calls.every((call) => call.length === 1)).toBe(true);
    expect((await closureCases({ closedPrs: result.checked }, { api, now })).findings).toEqual([]);
  });

  it("continues an ordinary handoff when the independent scanner is unavailable", async () => {
    const pr = { number: 106, draft: false, head: { sha: run.head_sha }, body: `QA-Handoff: ${run.head_sha}`, html_url: "https://github.com/example/mausbot/pull/106" };
    const send = vi.fn(async () => ({ submittedAt: new Date(now).toISOString() })), state = {};
    const scan = vi.fn(async () => { throw new Error("scan unavailable"); });
    const result = await drainQueue(state, { api: async (path: string) => path.startsWith("/pulls?") ? [pr] : [],
      recover: async () => ({ healthy: true }), scan, send, now });
    expect(result.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state).toHaveProperty("lastProcessScan.outcome", "incomplete");
    expect(scan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ publish: true }));
  });

  it("retains a scan failure receipt without contacting GitHub for an invalid source", () => {
    const directory = mkdtempSync(join(tmpdir(), "mausbot-process-scan-"));
    try {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./scan.mjs", import.meta.url))], {
        cwd: directory, env: { ...process.env, QA_RUN_ID: "not-a-run" }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(join(directory, "process-scan.json"), "utf8"))).toMatchObject({
        outcome: "incomplete", errors: [{ message: "A numeric CI run ID is required" }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps scan failure outside required checks and uses trusted main code", () => {
    const workflow = parse(readFileSync(".github/workflows/qa-report.yml", "utf8"));
    expect(workflow.jobs.scan["continue-on-error"]).toBe(true);
    expect(workflow.jobs.scan.steps[0].with.ref).toBe("main");
    expect(workflow.jobs.scan.permissions).toEqual({ contents: "read", actions: "read", issues: "read", "pull-requests": "read" });
    expect(workflow.jobs.report.needs).toBeUndefined();
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.jobs.scan.steps.find((step: { with?: { path?: string } }) => step.with?.path === "process-scan.json").if).toBe("always()");
    const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    expect(ci.jobs.static.steps.find((step: { name?: string }) => step.name === "Security, data and dispatch core with bounded affected tests").if).toBe("steps.scope.outputs.fast_pr == 'true'");
  });
});
