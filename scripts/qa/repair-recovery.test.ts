import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { recoverRepair } from "./repair-recovery.mjs";

const repository = "example/mausbot";
const repo = { id: 33, full_name: repository };
const association = { number: 12, base: { ref: "main", repo }, head: { ref: "fix/preview", repo, sha: "a".repeat(40) } };
const run = { id: 100, event: "pull_request", path: ".github/workflows/ci.yml", head_repository: repo, head_branch: "fix/preview",
  head_sha: "a".repeat(40), status: "completed", conclusion: "failure", run_attempt: 3, pull_requests: [association] };
const repair = { state: "open", number: 12, base: { ref: "main", repo }, head: { sha: run.head_sha, ref: run.head_branch, repo },
  labels: [{ name: "qa:repair" }], body: "QA-Repair: #7" };
const shard = "vitest (macos-latest, all shard 9/10)";
const job = { run_id: run.id, run_attempt: run.run_attempt, status: "completed", id: 9, name: shard, conclusion: "cancelled",
  runner_id: 0, runner_name: "", steps: [] as { name: string; conclusion: string }[] };
const gate = { ...job, id: 10, name: "CI", runner_id: 19, runner_name: "GitHub Actions", conclusion: "failure",
  steps: [{ name: "Enforce current PR controls, QA holds and required validation", conclusion: "failure" }] };
const annotation = { path: ".github", message: "The job was not acquired by Runner of type hosted even after multiple attempts", annotation_level: "failure" };
const issue = { number: 7, state: "open", labels: ["qa", "qa:p1", "qa:scope:global"] };

function fixture() {
  const data = { jobs: [job, gate, { ...job, id: 11, name: "typecheck + lint", conclusion: "success" }],
    annotations: [annotation], log: `2026-11-18T00:00:00Z Error: Required validation failed: ${shard}\n`,
    prs: [repair], currentPr: repair, latest: run, currentRun: run, activeHold: issue, newerRuns: [] as typeof run[], newerJobs: [] as typeof job[], issues: [issue] };
  const writes: string[] = [];
  const api = vi.fn(async (path: string, options?: { method?: string; raw?: boolean }) => {
    if (path === "/actions/runs/100/rerun-failed-jobs" && options?.method === "POST") { writes.push(path); return Buffer.alloc(0); }
    if (options?.method) throw new Error(`Unexpected write: ${path}`);
    if (path === "/pulls?state=open&base=main&head=example:fix%2Fpreview") return data.prs;
    if (path === "/actions/runs/100") return data.currentRun;
    if (path === "/issues/7") return data.activeHold;
    if (path === "/pulls/12") return data.currentPr;
    if (path === "/actions/runs/100/attempts/3/jobs?per_page=100&page=1") return { jobs: data.jobs };
    if (/^\/actions\/runs\/\d+\/attempts\/\d+\/jobs\?/.test(path)) return { jobs: data.newerJobs };
    if (path.startsWith("/check-runs/") && path.endsWith("/annotations?per_page=100&page=1")) return data.annotations;
    if (path === "/actions/jobs/10/logs" && options?.raw) return Buffer.from(data.log);
    if (path === "/issues?state=open&labels=qa&per_page=100&page=1") return data.issues;
    if (path === `/actions/workflows/ci.yml/runs?event=pull_request&branch=fix%2Fpreview&head_sha=${run.head_sha}&per_page=20`) return { workflow_runs: [...data.newerRuns, data.latest] };
    throw new Error(`Unexpected read: ${path}`);
  });
  return { data, api, writes };
}

describe("hosted runner recovery for global repairs", () => {
  it("requests only failed jobs, including the gate, and ignores a repeated completion after a new attempt starts", async () => {
    const { data, api, writes } = fixture();
    data.jobs.push({ ...job, id: 12, name: "open-source edition builds without enterprise/" });
    data.log = data.log.trimEnd() + ", open-source edition builds without enterprise/\n";
    expect(await recoverRepair(run, repository, api)).toContain("Requested failed jobs");
    data.latest = { ...run, run_attempt: 4, status: "in_progress" };
    await recoverRepair(run, repository, api);
    expect(writes).toEqual(["/actions/runs/100/rerun-failed-jobs"]);
  });

  it.each([
    { run_attempt: 4 }, { event: "push" }, { conclusion: "cancelled" }, { status: "in_progress" },
    { head_repository: { full_name: "example/fork" } }, { path: ".github/workflows/other.yml" },
  ])("ignores an ineligible event before any API access (%j)", async (patch) => {
    const { api } = fixture();
    await recoverRepair({ ...run, ...patch }, repository, api);
    expect(api).not.toHaveBeenCalled();
  });

  const skips: [string, (data: ReturnType<typeof fixture>["data"]) => void][] = [
    ["ordinary PR", (d) => { d.prs = [{ ...repair, labels: [] }]; }],
    ["updated head during diagnosis", (d) => { d.currentPr = { ...repair, head: { ...repair.head, sha: "b".repeat(40) } }; }],
    ["unlinked hold", (d) => { d.currentPr = { ...repair, body: "QA-Repair: #8" }; }],
    ["resolved hold", (d) => { d.issues = []; }],
    ["area-only P1", (d) => { d.issues = [{ ...issue, labels: ["qa", "qa:p1", "qa:scope:usage"] }]; }],
    ["another run for the same head", (d) => { d.latest = { ...run, id: run.id + 1 }; }],
    ["a test also failed", (d) => { d.jobs.push({ ...job, id: 12, name: "test", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] }); }],
    ["assigned worker", (d) => { d.jobs[0] = { ...job, runner_id: 10 }; }],
    ["capacity notice without acquisition failure", (d) => { d.annotations = [{ ...annotation, annotation_level: "notice" }]; }],
    ["another failure annotation", (d) => { d.annotations.push({ ...annotation, message: "cancelled by user" }); }],
    ["different gate failure", (d) => { d.log = "2026-11-18T00:00:00Z Error: QA hold: #8"; }],
    ["mixed gate evidence", (d) => { d.log = d.log.trimEnd() + ", unrelated job\n"; }],
    ["wrong attempt", (d) => { d.jobs[0] = { ...job, run_attempt: 2 }; }],
  ];
  it.each(skips)("leaves %s for Lead", async (_name, update) => {
    const { data, api, writes } = fixture();
    update(data);
    await recoverRepair(run, repository, api);
    expect(writes).toEqual([]);
  });

  it.each([{ members: [] }, { members: [{ ...association, number: 16 }] },
    { members: [{ ...association, base: { ...association.base, ref: "other" } }] }])(
    "declines unproven or contradictory PR associations %j", async ({ members }) => {
      const { api, writes } = fixture();
      await recoverRepair({ ...run, pull_requests: members }, repository, api);
      expect(writes).toEqual([]);
    });

  it.each(["metadata", "source", "ambiguous"])("identifies a newer %s run by preflight", async (kind) => {
    const { data, api, writes } = fixture();
    data.newerRuns = [{ ...run, id: 101, run_attempt: 1 }];
    const newer = { ...job, run_id: 101, run_attempt: 1 };
    data.newerJobs = [{ ...newer, name: "CI", conclusion: "success" },
      { ...newer, name: kind === "ambiguous" ? "unknown" : "typecheck + lint", conclusion: kind === "source" ? "success" : "skipped" }];
    await recoverRepair(run, repository, api);
    expect(writes.length).toBe(kind === "metadata" ? 1 : 0);
  });

  it.each(["head", "label"])("refreshes the repair %s after issue pagination", async (change) => {
    const { data, api, writes } = fixture();
    const read = api.getMockImplementation()!;
    api.mockImplementation(async (path, options) => {
      if (path.startsWith("/issues?")) data.currentPr = change === "head"
        ? { ...repair, head: { ...repair.head, sha: "b".repeat(40) } } : { ...repair, labels: [] };
      return read(path, options);
    });
    await recoverRepair(run, repository, api);
    expect(writes).toEqual([]);
    expect(api.mock.calls.findIndex(([path]) => path === "/pulls/12"))
      .toBeGreaterThan(api.mock.calls.findIndex(([path]) => path.startsWith("/issues?")));
  });

  it.each(["new source", "advanced attempt", "closed hold", "demoted hold"])("declines %s during source-job inspection", async (change) => {
    const { data, api, writes } = fixture();
    const read = api.getMockImplementation()!;
    let listed = false;
    api.mockImplementation(async (path, options) => {
      const result = await read(path, options);
      if (path.startsWith("/actions/workflows/")) listed = true;
      if (listed && path.includes("/attempts/3/jobs")) {
        if (change === "new source") data.newerRuns = [{ ...run, id: 101, run_attempt: 1 }];
        if (change === "advanced attempt") data.currentRun = { ...run, run_attempt: 4 };
        if (change === "closed hold") data.activeHold = { ...issue, state: "closed" };
        if (change === "demoted hold") data.activeHold = { ...issue, labels: ["qa", "qa:p2"] };
      }
      return result;
    });
    await recoverRepair(run, repository, api);
    expect(writes).toEqual([]);
  });

  it("executes default-branch code on completed CI events with a per-run lock", () => {
    const workflow = parse(readFileSync(".github/workflows/qa-repair-recovery.yml", "utf8"));
    expect(workflow.on).toEqual({ workflow_run: { workflows: ["CI"], types: ["completed"] } });
    expect(workflow.concurrency.group).toContain("github.event.workflow_run.id");
    expect(workflow.jobs.recover.steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(workflow.jobs.recover.permissions).toEqual({ actions: "write", contents: "read", checks: "read", issues: "read", "pull-requests": "read" });
  });
});
