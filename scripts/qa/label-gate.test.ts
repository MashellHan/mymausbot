import { describe, expect, it, vi } from "vitest";
import { executedPullRequest } from "../ci-scope.mjs";
import { verifyGate } from "./gate.mjs";
import { executionMatches, labelGate, ordinaryMetadata, reattestMetadata } from "./label-gate.mjs";

const repository = "MashellHan/mymausbot";
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const event = (label = "qa:triaged", action = "labeled", eventBase = base) => ({ action, number: 134,
  repository: { full_name: repository }, label: { name: label }, pull_request: { number: 134,
    head: { sha: head }, base: { sha: eventBase, repo: { full_name: repository } } } });
const pr = (labels: string[] = [], prBase = base) => ({ number: 134, state: "open", head: { sha: head },
  base: { sha: prBase, repo: { full_name: repository } }, labels: labels.map((name) => ({ name })), body: "" });
const source = { id: 50, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head,
  run_attempt: 1, status: "completed", conclusion: "success", created_at: "2026-11-09T06:00:00Z",
  pull_requests: [{ number: 134, head: { sha: head }, base: { sha: base } }] };
const jobs = [{ name: "typecheck + lint", run_attempt: 1, status: "completed", conclusion: "success" },
  { name: "CI", run_attempt: 1, status: "completed", conclusion: "success" }];
const plan = { execution: { merge, base, head }, outputs: { pr_number: 134, pr_head: head } };
const commit = { sha: merge, parents: [{ sha: base }, { sha: head }] };

function fixture({ request = event(), sourceRun = source, current = pr(), sourcePlan = plan, mergeCommit = commit,
  final = current }: { request?: ReturnType<typeof event>;
  sourceRun?: Omit<typeof source, "status" | "conclusion"> & { status: string; conclusion: string | null }; current?: ReturnType<typeof pr>;
  sourcePlan?: typeof plan | null; mergeCommit?: typeof commit; final?: ReturnType<typeof pr> } = {}) {
  let prReads = 0;
  const api = vi.fn(async (path: string) => {
    if (path === "/pulls/134") return ++prReads === 1 ? current : final;
    if (path.startsWith("/actions/workflows/ci.yml/runs?")) return { workflow_runs: [sourceRun] };
    if (path === "/actions/runs/50/artifacts?per_page=100&page=1") return { artifacts: [] };
    if (path === `/commits/${merge}`) return mergeCommit;
    if (path === "/actions/runs/50") return sourceRun;
    throw new Error(`Unexpected API request: ${path}`);
  });
  const loadJobs = vi.fn(async () => jobs);
  const loadPlan = vi.fn(async () => sourcePlan);
  const verify = vi.fn(async () => undefined);
  return { request, api, loadJobs, loadPlan, verify };
}

describe("required CI decision for label events", () => {
  it("routes only a complete, known ordinary metadata event to source-evidence reattestation", async () => {
    const reattest = vi.fn(async () => ({ sourceRunId: 50 }));
    const runRequired = vi.fn(async () => undefined);
    expect(ordinaryMetadata(event())).toBe(true);
    expect(ordinaryMetadata(event("owner:backend", "unlabeled"))).toBe(true);
    expect(ordinaryMetadata(event("CI:FULL"))).toBe(false);
    expect(ordinaryMetadata(event(""))).toBe(false);
    expect(ordinaryMetadata({ ...event(), pull_request: { ...event().pull_request, head: { sha: "bad" } } })).toBe(false);
    await labelGate({ eventName: "pull_request", event: event(), reattest, runRequired });
    expect(reattest).toHaveBeenCalledOnce();
    expect(runRequired).not.toHaveBeenCalled();
    await labelGate({ eventName: "pull_request", event: event("upstream-sync", "unlabeled"), reattest, runRequired });
    await labelGate({ eventName: "pull_request", event: event(""), reattest, runRequired });
    expect(runRequired).toHaveBeenCalledTimes(2);
  });

  it("records the checked-out merge parents and reattests only a matching successful source attempt", async () => {
    expect(executedPullRequest(base, head, () => `${merge} ${base} ${head}\n`)).toEqual({ merge, base, head });
    expect(() => executedPullRequest(base, head, () => `${merge} ${head} ${base}\n`)).toThrow("PR checkout");
    expect(executionMatches(plan, commit, { base, head })).toBe(true);
    const found = fixture();
    expect(await reattestMetadata({ event: found.request, repository, currentRunId: 100, api: found.api,
      loadJobs: found.loadJobs, loadPlan: found.loadPlan, verify: found.verify })).toEqual({ sourceRunId: 50, attempt: 1, head, base });
    expect(found.loadPlan).toHaveBeenCalledOnce();
    expect(found.verify).toHaveBeenCalledWith(plan.outputs, expect.objectContaining({ runId: 50, attempt: 1, deadlineMs: 0 }));
    expect(found.api.mock.calls.every(([path]) => !String(path).includes("/rerun"))).toBe(true);
  });

  it("rejects a base-only advance even when the run's mutable PR association has advanced", async () => {
    const nextBase = "d".repeat(40);
    const changed = fixture({ request: event("qa:triaged", "labeled", nextBase), current: pr([], nextBase), final: pr([], nextBase),
      sourceRun: { ...source, pull_requests: [{ number: 134, head: { sha: head }, base: { sha: nextBase } }] } });
    await expect(reattestMetadata({ event: changed.request, repository, currentRunId: 100, api: changed.api,
      loadJobs: changed.loadJobs, loadPlan: changed.loadPlan, verify: changed.verify })).rejects.toThrow("did not execute this PR base and head");
    expect(changed.verify).not.toHaveBeenCalled();
  });

  it("skips a newer metadata proof run and uses the latest actual source preflight", async () => {
    const found = fixture();
    const metadata = { ...source, id: 75 };
    const api = vi.fn(async (path: string) => path.startsWith("/actions/workflows/ci.yml/runs?")
      ? { workflow_runs: [{ ...metadata, id: 125 }, metadata, source] } : found.api(path));
    const loadJobs = vi.fn(async (id: number) => id === 75
      ? [{ name: "vars.BOAT_CI expression", run_attempt: 1, status: "completed", conclusion: "skipped" }]
      : jobs);
    expect(await reattestMetadata({ event: found.request, repository, currentRunId: 100, api,
      loadJobs, loadPlan: found.loadPlan, verify: found.verify })).toMatchObject({ sourceRunId: 50 });
    expect(loadJobs).toHaveBeenCalledWith(75, 1, api);
    expect(loadJobs).toHaveBeenCalledWith(50, 1, api);
    expect(loadJobs).not.toHaveBeenCalledWith(125, 1, api);
  });

  it("keeps the required metadata check unsatisfied on a missing plan or changed late control", async () => {
    const active = fixture({ sourceRun: { ...source, status: "in_progress", conclusion: null } });
    await expect(reattestMetadata({ event: active.request, repository, currentRunId: 100, api: active.api,
      loadJobs: active.loadJobs, loadPlan: active.loadPlan, verify: active.verify, maxWaitMs: 0 })).rejects.toThrow("did not complete");
    const missing = fixture({ sourcePlan: null });
    await expect(reattestMetadata({ event: missing.request, repository, currentRunId: 100, api: missing.api,
      loadJobs: missing.loadJobs, loadPlan: missing.loadPlan, verify: missing.verify })).rejects.toThrow("Missing exact source CI plan");
    const late = fixture({ final: pr(["ci:full"]) });
    await expect(reattestMetadata({ event: late.request, repository, currentRunId: 100, api: late.api,
      loadJobs: late.loadJobs, loadPlan: late.loadPlan, verify: late.verify })).rejects.toThrow("controls changed");
    const noExecution = fixture({ sourcePlan: { ...plan, execution: { ...plan.execution, merge: "" } } });
    await expect(reattestMetadata({ event: noExecution.request, repository, currentRunId: 100, api: noExecution.api,
      loadJobs: noExecution.loadJobs, loadPlan: noExecution.loadPlan, verify: noExecution.verify })).rejects.toThrow("Missing immutable");
  });

  it("does not reuse a completed source run with a failed CI gate or unreadable current PR", async () => {
    const failed = fixture({ sourceRun: { ...source, conclusion: "failure" } });
    await expect(reattestMetadata({ event: failed.request, repository, currentRunId: 100, api: failed.api,
      loadJobs: failed.loadJobs, loadPlan: failed.loadPlan, verify: failed.verify })).rejects.toThrow("Source CI failure");
    const unreadable = fixture();
    unreadable.api.mockRejectedValueOnce(new Error("GitHub unavailable"));
    await expect(reattestMetadata({ event: unreadable.request, repository, currentRunId: 100, api: unreadable.api,
      loadJobs: unreadable.loadJobs, loadPlan: unreadable.loadPlan, verify: unreadable.verify })).rejects.toThrow("GitHub unavailable");
  });

  it("requires full validation for a current upstream-sync control", async () => {
    const outputs = { qa_areas: ["global"], expected_jobs: [{ id: "static", name: "typecheck + lint" }], required_jobs: [],
      full_required: false, fast_pr: false, pr_number: 134, pr_head: head };
    const api = vi.fn(async (path: string) => path === "/pulls/134" ? pr(["upstream-sync"]) : []);
    await expect(verifyGate(outputs, { api, runId: 50, attempt: 1, deadlineMs: 0 })).rejects.toThrow("Current PR controls require a fresh full CI run");
  });
});
