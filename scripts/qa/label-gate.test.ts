import { describe, expect, it, vi } from "vitest";
import { executedPullRequest } from "../ci-scope.mjs";
import { verifyGate } from "./gate.mjs";
import { runPlan } from "./github.mjs";
import { executionMatches, labelGate, ordinaryMetadata, reattestMetadata } from "./label-gate.mjs";

const repository = "MashellHan/mymausbot";
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const tree = "e".repeat(40);
const event = (label = "qa:triaged", action = "labeled", eventBase = base) => ({ action, number: 134,
  repository: { full_name: repository }, label: { name: label }, pull_request: { number: 134,
    head: { sha: head }, base: { sha: eventBase, ref: "main", repo: { full_name: repository } } } });
const pr = (labels: string[] = [], prBase = base) => ({ number: 134, state: "open", head: { sha: head },
  base: { sha: prBase, ref: "main", repo: { full_name: repository } }, labels: labels.map((name) => ({ name })), body: "" });
const source = { id: 50, event: "pull_request", path: ".github/workflows/ci.yml", head_sha: head,
  run_attempt: 1, status: "completed", conclusion: "success", created_at: "2026-11-09T06:00:00Z",
  pull_requests: [{ number: 134, head: { sha: head }, base: { sha: base } }] };
const jobs = [{ name: "typecheck + lint", run_attempt: 1, status: "completed", conclusion: "success" },
  { name: "CI", run_attempt: 1, status: "completed", conclusion: "success" }];
const plan = { version: 1, sha: merge, runId: 50, attempt: 1, execution: { merge, base, head },
  outputs: { pr_number: 134, pr_head: head } };
const commit = { sha: merge, parents: [{ sha: base }, { sha: head }], commit: { tree: { sha: tree } } };
const artifact = { id: 99, name: "qa-plan-attempt-1", expired: false, workflow_run: { id: 50 } };

function fixture({ request = event(), sourceRun = source, current = pr(), sourcePlan = plan, mergeCommit = commit,
  final = current, liveBase = base, liveMergeSha = merge }: { request?: ReturnType<typeof event>;
  sourceRun?: Omit<typeof source, "status" | "conclusion"> & { status: string; conclusion: string | null }; current?: ReturnType<typeof pr>;
  sourcePlan?: typeof plan | null; mergeCommit?: typeof commit; final?: ReturnType<typeof pr>;
  liveBase?: string; liveMergeSha?: string } = {}) {
  let prReads = 0;
  const api = vi.fn(async (path: string) => {
    if (path === "/pulls/134") return ++prReads === 1 ? current : final;
    if (path === "/branches/main") return { commit: { sha: liveBase } };
    if (path === "/git/ref/pull/134/merge") return { object: { sha: liveMergeSha } };
    if (path.startsWith("/actions/workflows/ci.yml/runs?")) return { workflow_runs: [sourceRun] };
    if (path === "/actions/runs/50/artifacts?per_page=100&page=1") return { artifacts: [artifact] };
    if (path === `/commits/${merge}`) return mergeCommit;
    if (path === `/commits/${liveMergeSha}`) return { sha: liveMergeSha,
      parents: [{ sha: liveBase }, { sha: head }], commit: { tree: { sha: tree } } };
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
    expect(executedPullRequest(head, () => `${merge} ${base} ${head}\n`)).toEqual({ merge, base, head });
    expect(() => executedPullRequest(head, () => `${merge} ${head} ${base}\n`)).toThrow("PR checkout");
    expect(executionMatches(plan, commit, { base, head }, { merge: commit })).toBe(true);
    const found = fixture();
    expect(await reattestMetadata({ event: found.request, repository, currentRunId: 100, api: found.api,
      loadJobs: found.loadJobs, loadPlan: found.loadPlan, verify: found.verify })).toEqual({ sourceRunId: 50, attempt: 1, head, base });
    expect(found.loadPlan).toHaveBeenCalledOnce();
    expect(found.verify).toHaveBeenCalledWith(plan.outputs, expect.objectContaining({ runId: 50, attempt: 1, deadlineMs: 0 }));
    expect(found.api.mock.calls.every(([path]) => !String(path).includes("/rerun"))).toBe(true);
  });

  it("loads a real run-attempt artifact when the API head H differs from executed merge M", async () => {
    const found = fixture();
    const readArtifact = vi.fn(async () => ({ "qa-plan.json": JSON.stringify(plan) }));
    await expect(runPlan(source, jobs, [artifact], { api: found.api, readArtifact })).rejects.toThrow("Missing current-run validation plan");
    expect(await reattestMetadata({ event: found.request, repository, currentRunId: 100, api: found.api,
      loadJobs: found.loadJobs, readArtifact, verify: found.verify })).toEqual({ sourceRunId: 50, attempt: 1, head, base });
    expect(readArtifact).toHaveBeenCalledWith(artifact, found.api);
    expect(found.verify).toHaveBeenCalledOnce();
    for (const invalid of [
      { ...plan, sha: head },
      { ...plan, execution: { ...plan.execution, head: "d".repeat(40) } },
      { ...plan, attempt: 2 },
    ]) {
      const bad = fixture();
      await expect(reattestMetadata({ event: bad.request, repository, currentRunId: 100, api: bad.api,
        loadJobs: bad.loadJobs, readArtifact: async () => ({ "qa-plan.json": JSON.stringify(invalid) }), verify: bad.verify }))
        .rejects.toThrow("Missing current-run validation plan");
      expect(bad.verify).not.toHaveBeenCalled();
    }
    const changedParent = fixture({ liveMergeSha: "f".repeat(40),
      mergeCommit: { ...commit, parents: [{ sha: "d".repeat(40) }, { sha: head }] } });
    await expect(reattestMetadata({ event: changedParent.request, repository, currentRunId: 100, api: changedParent.api,
      loadJobs: changedParent.loadJobs, readArtifact, verify: changedParent.verify })).rejects.toThrow("did not execute this PR base and head");
    const changedTree = fixture({ liveMergeSha: "f".repeat(40),
      mergeCommit: { ...commit, commit: { tree: { sha: "d".repeat(40) } } } });
    await expect(reattestMetadata({ event: changedTree.request, repository, currentRunId: 100, api: changedTree.api,
      loadJobs: changedTree.loadJobs, readArtifact, verify: changedTree.verify })).rejects.toThrow("did not execute this PR base and head");
  });

  it("rejects a base-only advance even when the run's mutable PR association has advanced", async () => {
    const nextBase = "d".repeat(40);
    const changed = fixture({ liveBase: nextBase, liveMergeSha: "f".repeat(40),
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

  it("reads a non-main target's live branch ref without an actions-write router", async () => {
    const request = event();
    request.pull_request.base.ref = "release/test";
    const current = pr();
    current.base.ref = "release/test";
    const found = fixture({ request, current });
    const api = vi.fn(async (path: string) => path === "/branches/release%2Ftest"
      ? { commit: { sha: base } } : found.api(path));
    expect(await reattestMetadata({ event: request, repository, currentRunId: 100, api,
      loadJobs: found.loadJobs, loadPlan: found.loadPlan, verify: found.verify })).toMatchObject({ base, head });
    expect(api).toHaveBeenCalledWith("/branches/release%2Ftest");
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
