import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { ciOutputs } from "../ci-scope.mjs";
import { expectedJobs } from "./contracts.mjs";
import { recheckHeldPr, recheckReleasedHolds } from "./hold-release.mjs";

const repository = "example/mausbot";
const repo = { id: 21, full_name: repository };
const base = "a".repeat(40), head = "b".repeat(40), merge = "c".repeat(40), tree = "d".repeat(40);
const live = { number: 12, state: "open", mergeable: true, mergeable_state: "blocked", labels: [] as { name: string }[],
  body: "", base: { ref: "main", sha: base, repo }, head: { ref: "topic", sha: head, repo } };
const run = { id: 100, event: "pull_request", path: ".github/workflows/ci.yml", head_repository: repo, head_branch: "topic", head_sha: head,
  run_attempt: 1, status: "completed", conclusion: "failure", created_at: "2026-11-18T04:30:00Z", pull_requests: [live] };
const worker = { run_id: 100, run_attempt: 1, id: 10, name: "typecheck + lint", conclusion: "success",
  status: "completed", started_at: run.created_at, steps: [] as { name: string; conclusion: string }[] };
const gate = { ...worker, id: 11, name: "CI", conclusion: "failure",
  steps: [{ name: "Enforce current PR controls, QA holds and required validation", conclusion: "failure" }] };
const issue = { number: 7, state: "closed", closed_at: "2026-11-18T04:35:00Z", updated_at: "2026-11-18T04:35:00Z",
  labels: [{ name: "qa" }, { name: "qa:p1" }, { name: "qa:scope:global" }] };

function fixture() {
  const selected = { ...ciOutputs({ checks: ["build"] }, ["ubuntu-latest"]), fast_pr: true };
  const outputs = { ...selected, full_required: false, reduced: false, required_jobs: [] as string[], qa_areas: ["usage"],
    expected_jobs: expectedJobs(selected, false), pr_number: 12, pr_head: head };
  const data = { run: structuredClone(run), pr: structuredClone(live), jobs: structuredClone([worker, gate]),
    issue: structuredClone(issue), open: [] as typeof issue[], currentBase: base, currentTree: tree,
    plan: { execution: { base, head, merge }, outputs }, log: "2026-11-18T04:32:00Z Error: QA hold: #7; Lead must triage or identify a fully validated repair\n" };
  const commit = { sha: merge, parents: [{ sha: base }, { sha: head }], commit: { tree: { sha: tree } } };
  const writes: string[] = [];
  const api = vi.fn(async (path: string, options?: { method?: string; raw?: boolean }) => {
    if (options?.method) {
      if (path !== "/actions/jobs/11/rerun" || options.method !== "POST" || !options.raw) throw new Error("Unexpected write");
      writes.push(path);
      data.run.status = "queued";
      return Buffer.alloc(0);
    }
    if (path === "/pulls/12") return data.pr;
    if (path.startsWith("/actions/workflows/ci.yml/runs?")) return { workflow_runs: [data.run] };
    if (path === "/actions/runs/100/attempts/1/jobs?per_page=100&page=1" || path === "/actions/runs/100/jobs?filter=all&per_page=100&page=1") return { jobs: data.jobs };
    if (path === "/actions/jobs/11/logs") return Buffer.from(data.log);
    if (path === "/issues/7") return data.issue;
    if (path === "/issues?state=open&labels=qa&per_page=100&page=1") return data.open;
    if (path === "/actions/runs/100/artifacts?per_page=100&page=1") return { artifacts: [] };
    if (path === "/branches/main") return { commit: { sha: data.currentBase } };
    if (path === "/git/ref/pull/12/merge") return { object: { sha: "e".repeat(40) } };
    if (path === `/commits/${"e".repeat(40)}`) return { ...commit, sha: "e".repeat(40), parents: [{ sha: data.currentBase }, { sha: head }], commit: { tree: { sha: data.currentTree } } };
    if (path === `/commits/${merge}`) return commit;
    throw new Error(`Unexpected read ${path}`);
  });
  const check = () => recheckHeldPr(live, { repository, api, loadPlan: async () => data.plan });
  return { data, api, writes, check };
}

describe("released QA holds", () => {
  it("requests only the original gate after required checks pass and coalesces duplicate or overlapping wakeups", async () => {
    const { data, check, writes } = fixture();
    data.run.status = "in_progress";
    expect(await check()).toBe(false);
    data.run.status = "completed";
    expect(await check()).toBe(true);
    expect(await check()).toBe(false);
    expect(writes).toEqual(["/actions/jobs/11/rerun"]);
  });

  it("can resume a still-open P1 narrowed to a different area", async () => {
    const { data, check } = fixture();
    data.issue.state = "open";
    data.issue.labels[2] = { name: "qa:scope:agents" };
    data.open = [data.issue];
    expect(await check()).toBe(true);
  });

  const skips: [string, (data: ReturnType<typeof fixture>["data"]) => void][] = [
    ["another active hold", (d) => { d.open = [{ ...issue, number: 8, state: "open" }]; }],
    ["an unchanged applicable hold", (d) => { d.issue.state = "open"; d.open = [d.issue]; }],
    ["a closure before the gate started", (d) => { d.issue.closed_at = "2026-11-18T03:00:00Z"; }],
    ["a failed product job", (d) => { d.jobs[0].conclusion = "failure"; }],
    ["another gate error", (d) => { d.log += "2026-11-18T04:33:00Z Error: Required validation failed: worker"; }],
    ["another failed step", (d) => { d.jobs[1].steps.push({ name: "checkout", conclusion: "failure" }); }],
    ["missing required work", (d) => { d.plan.outputs.fast_pr = false; d.plan.outputs.expected_jobs.push({ id: "relay", name: "relay" }); }],
    ["new full CI control", (d) => { d.pr.labels.push({ name: "ci:full" }); }],
    ["missing PR association", (d) => { d.run.pull_requests = []; }],
    ["a different PR", (d) => { d.run.pull_requests[0].number = 29; }],
    ["a plan for another PR", (d) => { d.plan.outputs.pr_number = 99; }],
    ["a source based on older main", (d) => { d.plan.execution.base = "9".repeat(40); }],
    ["main advancing during this check", (d) => { d.currentBase = "9".repeat(40); }],
    ["different integrated tree", (d) => { d.currentTree = "9".repeat(40); }],
    ["closed PR", (d) => { d.pr.state = "closed"; }],
    ["behind PR", (d) => { d.pr.mergeable_state = "behind"; }],
    ["a replacement head", (d) => { d.pr.head.sha = "9".repeat(40); }],
  ];
  it.each(skips)("makes no write for %s", async (_name, update) => {
    const { data, check, writes } = fixture();
    update(data);
    expect(await check()).toBe(false);
    expect(writes).toEqual([]);
  });

  it("continues other PRs when one evidence read fails and reports the gap", async () => {
    const api = vi.fn(async (path: string) => path.startsWith("/issues?") ? [] : [live, { ...live, number: 42 }]);
    const check = vi.fn(async (pr: typeof live) => { if (pr.number === 12) throw new Error("read unavailable"); return false; });
    await expect(recheckReleasedHolds({ repository, api, check })).rejects.toThrow("PR #12: read unavailable");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("serializes trusted issue/CI wakeups and limits write permission to rerunning Actions", () => {
    const workflow = parse(readFileSync(".github/workflows/qa-hold-release.yml", "utf8"));
    expect(workflow.on).toEqual({ issues: { types: ["closed", "labeled", "unlabeled"] }, workflow_run: { workflows: ["CI"], types: ["completed"] } });
    expect(workflow.jobs.reconcile.concurrency).toEqual({ group: "qa-hold-release-reconcile", "cancel-in-progress": false });
    expect(workflow.jobs.reconcile.steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(workflow.jobs.reconcile.permissions).toEqual({ contents: "read", actions: "write", issues: "read", "pull-requests": "read" });
  });
});
