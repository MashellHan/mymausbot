import { describe, expect, it } from "vitest";
import { ALL_OS, ciOutputs, FULL_SCOPE, MAIN_SCOPE, VITEST_SHARDS } from "./ci-scope.mjs";
import { expectedJobs, MERGE_JOBS } from "./qa/contracts.mjs";
import { githubApi, judgeRun, waitForReleaseCi } from "./release-ci.mjs";

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const BUMP_BRANCH_SHA = "c".repeat(40);
const OTHER = "d".repeat(40);
const TREE = "1".repeat(40);
const PARENT_TREE = "2".repeat(40);

type Step = { status?: string; conclusion?: string | null };
type Job = { name: string; conclusion: string | null; status?: string; run_attempt?: number; steps?: Step[] };
type Run = {
  id: number; event: string; status: string; head_branch: string; head_sha: string; created_at: string;
  run_attempt?: number; head_commit?: { tree_id: string };
};
type Commit = { tree: string; parents: string[]; files: string[] };

const started: Step[] = [{ status: "completed", conclusion: "success" }];
const vitest = (os: string, conclusion: string | null, steps: Step[] = started, shard = 1): Job =>
  ({ name: `vitest (${os}, ${os === "macos-latest" ? "all " : ""}shard ${shard}/${VITEST_SHARDS[os as keyof typeof VITEST_SHARDS]})`, conclusion, steps });
const shards = (os: string): Job[] =>
  Array.from({ length: VITEST_SHARDS[os as keyof typeof VITEST_SHARDS] }, (_, i) => vitest(os, "success", started, i + 1));
const gate = (conclusion: string | null): Job => ({ name: "CI", status: "completed", conclusion, run_attempt: 1, steps: started });
const fullSelection = ciOutputs(FULL_SCOPE, ALL_OS);
const fullExpected = expectedJobs(fullSelection);
const planFor = (run: Run, full = true) => {
  const selection = full ? fullSelection : ciOutputs(MAIN_SCOPE, ALL_OS);
  return { version: 1, runId: run.id, attempt: run.run_attempt ?? 1, sha: run.head_sha,
    ...(run.event === "push" || run.event === "merge_group" ? { plan: { full, candidate: false, admitted: false, reduced: false, scope: full ? FULL_SCOPE : MAIN_SCOPE } } : {}),
    outputs: { ...selection, full_required: full, reduced: false, qa_areas: ["global"],
      required_jobs: selection.jobs.filter((id) => MERGE_JOBS.includes(id)), expected_jobs: expectedJobs(selection, full) } };
};
const green = (): Job[] => [gate("success"), ...fullExpected.map((item) => ({ name: item.name, conclusion: "success", status: "completed", run_attempt: 1, steps: started }))];
const mainLane = (): Job[] => [gate("success"), ...shards("ubuntu-latest")];
/** A docs- or version-only run: the gate passes with vitest skipped. */
const scoped = (): Job[] => [gate("success"), { name: "vitest (${{ matrix.os }}, shard ${{ matrix.shard }}/4)", conclusion: "skipped", steps: [] }];
/** A real test failure: the shard started and failed. */
const red = (): Job[] => [gate("failure"), vitest("ubuntu-latest", "failure", [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }])];
/** macOS "failed to be acquired": the shard never started a step. */
const runnerLost = (): Job[] => [gate("failure"), vitest("ubuntu-latest", "success"), vitest("macos-latest", "failure", [])];
const cancelled = (): Job[] => [];

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "openmausbot", private: true, version, scripts: { test: "vitest run" }, ...extra }, null, 2)}\n`;

/** A scripted GitHub. Each poll (one sleep) moves to the next state. */
function fakeGitHub(polls: Array<{ runs: Run[]; jobs?: Record<number, Job[]>; plans?: Record<number, "main" | null> }>, setup: {
  commits?: Record<string, Commit>; files?: Record<string, string>;
} = {}) {
  const calls: string[] = [];
  let poll = 0;
  let clock = 0;
  const state = () => polls[Math.min(poll, polls.length - 1)]!;
  const commits: Record<string, Commit> = setup.commits ?? {
    [SHA]: { tree: TREE, parents: [PARENT], files: ["server/index.ts"] },
    [PARENT]: { tree: PARENT_TREE, parents: [OTHER], files: ["src/App.tsx"] },
  };
  const api = {
    async runsForCommit(sha: string) { return state().runs.filter((run) => run.head_sha === sha); },
    async recentRuns() { return state().runs.filter((run) => run.status === "completed"); },
    async runJobs(runId: number) { return state().jobs?.[runId] ?? []; },
    async runPlan(source: Run) { return state().plans?.[source.id] === null ? null : planFor(source, state().plans?.[source.id] !== "main"); },
    async commit(sha: string) {
      const commit = commits[sha];
      if (!commit) throw new Error(`GET /commits/${sha}: HTTP 404`);
      return commit;
    },
    async fileAt(path: string, sha: string) { return setup.files?.[`${sha}:${path}`] ?? null; },
    async rerunFailedJobs(runId: number) { calls.push(`rerun ${runId}`); },
    async pointBranch(branch: string, sha: string) { calls.push(`branch ${branch} ${sha === SHA ? "@sha" : sha}`); },
    async dispatchCi(branch: string) { calls.push(`dispatch ${branch}`); },
    async deleteBranch(branch: string) { calls.push(`delete ${branch}`); },
  };
  const options = {
    api, sha: SHA, version: "0.1.94", log: () => {}, maxWaitMs: 10 * 60_000,
    now: () => clock, sleep: async (ms: number) => { clock += ms; poll += 1; },
  };
  return { calls, options };
}

const run = (id: number, event: string, status: string, head_branch = "main", minute = 0, extra: Partial<Run> = {}): Run =>
  ({ id, event, status, head_branch, head_sha: SHA, created_at: `2026-10-02T10:${String(minute).padStart(2, "0")}:00Z`, run_attempt: 1, ...extra });
const LANE = ["branch release-ci/v0.1.94 @sha", "dispatch release-ci/v0.1.94", "delete release-ci/v0.1.94"];

/** The release commit only bumps package.json's version from PARENT. */
const versionBump = {
  commits: {
    [SHA]: { tree: TREE, parents: [PARENT], files: ["package.json"] },
    [PARENT]: { tree: PARENT_TREE, parents: [OTHER], files: ["server/index.ts"] },
  },
  files: { [`${PARENT}:package.json`]: pkg("0.1.93"), [`${SHA}:package.json`]: pkg("0.1.94") },
};

describe("what a CI run proves", () => {
  it("is green only when the gate and every macOS all-E2E shard passed", () => {
    const source = run(1, "push", "completed");
    expect(judgeRun(green(), planFor(source), source)).toBe("green");
    expect(judgeRun([gate("success"), ...Array.from({ length: 4 }, (_, i) => ({
      name: `vitest (macos-latest, shard ${i + 1}/4)`, conclusion: "success", steps: started,
    }))], planFor(source), source)).toBe("partial");
    expect(judgeRun(scoped())).toBe("scoped");
    expect(judgeRun([gate("success")])).toBe("scoped");
    expect(judgeRun([gate("success"), vitest("ubuntu-latest", "success"), vitest("windows-latest", "skipped")])).toBe("scoped");
  });

  it("is partial for retired Linux shards or an incomplete macOS full set", () => {
    expect(judgeRun(mainLane())).toBe("partial");
    const source = run(1, "push", "completed");
    expect(judgeRun(green().filter((job) => job.name !== "vitest (macos-latest, all shard 8/8)"), planFor(source), source)).toBe("partial");
    expect(judgeRun([...mainLane(), ...shards("windows-latest")])).toBe("partial");
  });

  it("rejects a MAIN_SCOPE plan even when eight all-E2E shard names and the gate pass", () => {
    const source = run(1, "push", "completed");
    expect(judgeRun(green(), planFor(source, false), source)).toBe("partial");
    expect(judgeRun(green(), null, source)).toBe("partial");
  });

  it("rejects a bound four-shard plan after the full selection grows to eight", () => {
    const source = run(1, "push", "completed");
    const plan = planFor(source);
    const rows = plan.outputs.vitest_matrix.include.slice(0, 4).map((entry, index) => ({ ...entry, part: `all shard ${index + 1}/4`, shards: 4 }));
    const outputs = { ...plan.outputs, vitest_matrix: { include: rows } };
    expect(judgeRun(green(), { ...plan, outputs: { ...outputs, expected_jobs: expectedJobs(outputs) } }, source)).toBe("partial");
  });

  it("requires source identity and every full specialist job to pass", () => {
    const source = run(1, "workflow_dispatch", "completed");
    const plan = planFor(source);
    expect(judgeRun(green(), plan, source)).toBe("green");
    for (const patch of [{ runId: 2 }, { sha: OTHER }, { attempt: 2 }]) {
      expect(judgeRun(green(), { ...plan, ...patch }, source)).toBe("partial");
    }
    for (const id of ["relay", "browser-driver", "foss", "ui-smoke", "browser-identity"]) {
      const specialist = fullExpected.find((item) => item.id === id)!;
      expect(judgeRun(green().filter((job) => job.name !== specialist.name), plan, source)).toBe("partial");
      expect(judgeRun(green().map((job) => job.name === specialist.name ? { ...job, conclusion: "failure" } : job), plan, source)).toBe("partial");
    }
  });

  it("tells a runner that never came from a test that failed", () => {
    expect(judgeRun(runnerLost())).toBe("runner-lost");
    expect(judgeRun(red())).toBe("red");
    // one lost runner does not excuse a real failure next to it
    expect(judgeRun([...runnerLost(), vitest("windows-latest", "failure")])).toBe("red");
    // a job that failed in "Set up job" did get a runner
    expect(judgeRun([gate("failure"), vitest("macos-latest", "failure", [{ status: "completed", conclusion: "failure" }])])).toBe("red");
    // the gate alone failing (a static check) is red
    expect(judgeRun([gate("failure"), { name: "preflight", conclusion: "failure", steps: started }])).toBe("red");
    expect(judgeRun([gate("failure")])).toBe("red");
  });

  it("reports a cancelled or missing gate as no verdict", () => {
    expect(judgeRun([])).toBe("no gate job");
    expect(judgeRun([gate("cancelled")])).toBe("cancelled");
  });
});

describe("release CI gate", () => {
  it("passes on the commit's own green run without starting anything", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "push", "completed")], jobs: { 1: green() } }]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 1, via: "commit" });
    expect(calls).toEqual([]);
  });

  it("starts its own lane when the current commit has only a non-full main plan", async () => {
    const source = run(1, "push", "completed");
    const lane = run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5);
    const { calls, options } = fakeGitHub([
      { runs: [source], jobs: { 1: green() }, plans: { 1: "main" } },
      { runs: [source, lane], jobs: { 1: green(), 2: green() }, plans: { 1: "main" } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it.each(["workflow_dispatch", "schedule"])("waits for a %s run that is still going, then passes", async (event) => {
    const { calls, options } = fakeGitHub([
      { runs: [run(1, event, "queued")] },
      { runs: [run(1, event, "in_progress")] },
      { runs: [run(1, event, "completed")], jobs: { 1: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 1, via: "commit" });
    expect(calls).toEqual([]);
  });

  it("counts a re-run that passed after a failed first attempt", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(1, "workflow_dispatch", "in_progress", "main", 0, { run_attempt: 2 })] },
      { runs: [run(1, "workflow_dispatch", "completed", "main", 0, { run_attempt: 2 })], jobs: { 1: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 1, via: "commit" });
    expect(calls).toEqual([]);
  });

  it("stops on a red gate instead of retrying it", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "push", "completed")], jobs: { 1: red() } }]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("failed: run 1") });
    expect(calls).toEqual([]);
  });

  it("ignores pull-request runs, which test a merge ref rather than this commit", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(9, "pull_request", "completed")], jobs: { 9: green() } },
      { runs: [run(9, "pull_request", "completed"), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 9: green(), 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it.each([
    ["no CI run at all", [] as Run[]],
    ["a run a newer merge replaced", [run(1, "push", "completed")]],
  ])("starts CI in its own lane when there is %s, and cleans the lane up", async (_, first) => {
    const { calls, options } = fakeGitHub([
      { runs: first, jobs: { 1: cancelled() } },
      { runs: [...first, run(2, "workflow_dispatch", "queued", "release-ci/v0.1.94", 5)], jobs: { 1: cancelled() } },
      { runs: [...first, run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 1: cancelled(), 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("fails when its own lane's CI fails, and still cleans the lane up", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [] },
      { runs: [run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94")], jobs: { 2: red() } },
    ]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("release lane did not pass (red)") });
    expect(calls.at(-1)).toBe("delete release-ci/v0.1.94");
  });

  it("gives up after the wait limit with no verdict", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "workflow_dispatch", "in_progress")] }]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("within 10 minutes") });
    expect(calls).toEqual([]);
  });
});

describe("a run of Linux's shards alone is no proof", () => {
  it.each(["push", "merge_group"])("starts CI in the lane after the commit's green %s run", async (event) => {
    const { calls, options } = fakeGitHub([
      { runs: [run(1, event, "completed")], jobs: { 1: mainLane() } },
      { runs: [run(1, event, "completed"), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 1: mainLane(), 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("starts the lane at once instead of waiting for a push's run that is still going", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(1, "push", "in_progress")] },
      { runs: [run(1, "push", "in_progress"), run(2, "workflow_dispatch", "in_progress", "release-ci/v0.1.94", 5)] },
      { runs: [run(1, "push", "completed"), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 1: mainLane(), 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("still stops on the commit's red push run", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "push", "completed")], jobs: { 1: red() } }]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("failed: run 1") });
    expect(calls).toEqual([]);
  });

  it("fails the release when its own lane ran only some platforms", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [] },
      { runs: [run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94")], jobs: { 2: mainLane() } },
    ]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("release lane did not pass (partial)") });
    expect(calls).toEqual(LANE);
  });

  it("passes on the nightly run of a commit with the same tree", async () => {
    const { calls, options } = fakeGitHub([{
      runs: [
        run(1, "push", "completed"),
        run(8, "schedule", "completed", "main", 0, { head_sha: OTHER, head_commit: { tree_id: TREE } }),
      ],
      jobs: { 1: mainLane(), 8: green() },
    }]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 8, via: "tree" });
    expect(calls).toEqual([]);
  });
});

describe("a run that skipped the tests is no proof", () => {
  it("does not pass on the commit's own run whose vitest was skipped, and runs CI in the lane", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(1, "push", "completed")], jobs: { 1: scoped() } },
      { runs: [run(1, "push", "completed"), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 1: scoped(), 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("does not pass on a same-tree run whose vitest was skipped", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(7, "workflow_dispatch", "completed", "release/v0.1.94", 0, { head_sha: BUMP_BRANCH_SHA, head_commit: { tree_id: TREE } })], jobs: { 7: scoped() } },
      { runs: [run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });
});

describe("reusing a run on the same tree", () => {
  it("passes on the bump branch's green manual run when main did not move", async () => {
    const { calls, options } = fakeGitHub([{
      runs: [
        run(1, "push", "completed"),
        run(7, "workflow_dispatch", "completed", "release/v0.1.94", 0, { head_sha: BUMP_BRANCH_SHA, head_commit: { tree_id: TREE } }),
      ],
      jobs: { 1: scoped(), 7: green() },
    }]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 7, via: "tree" });
    expect(calls).toEqual([]);
  });

  it("ignores same-tree pull-request runs and runs on other trees", async () => {
    const { calls, options } = fakeGitHub([
      {
        runs: [
          run(8, "pull_request", "completed", "release/v0.1.94", 0, { head_sha: BUMP_BRANCH_SHA, head_commit: { tree_id: TREE } }),
          run(9, "push", "completed", "main", 0, { head_sha: OTHER, head_commit: { tree_id: "9".repeat(40) } }),
        ],
        jobs: { 8: green(), 9: green() },
      },
      { runs: [run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });
});

describe("a version-only bump reuses its parent's CI", () => {
  it("passes on the parent's green push run", async () => {
    const { calls, options } = fakeGitHub([{
      runs: [run(1, "push", "completed"), run(5, "push", "completed", "main", 0, { head_sha: PARENT })],
      jobs: { 1: scoped(), 5: green() },
    }], versionBump);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 5, via: "parent" });
    expect(calls).toEqual([]);
  });

  it("passes on a green run on the parent's tree", async () => {
    const { options } = fakeGitHub([{
      runs: [run(6, "merge_group", "completed", "gh-readonly-queue/main/pr-1", 0, { head_sha: OTHER, head_commit: { tree_id: PARENT_TREE } })],
      jobs: { 6: green() },
    }], versionBump);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 6, via: "parent" });
  });

  it("waits for the parent's nightly run that is still going", async () => {
    const parentRun = (status: string) => run(5, "schedule", status, "main", 0, { head_sha: PARENT });
    const { calls, options } = fakeGitHub([
      { runs: [run(1, "push", "completed"), parentRun("in_progress")], jobs: { 1: scoped() } },
      { runs: [run(1, "push", "completed"), parentRun("in_progress")], jobs: { 1: scoped() } },
      { runs: [run(1, "push", "completed"), parentRun("completed")], jobs: { 1: scoped(), 5: green() } },
    ], versionBump);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 5, via: "parent" });
    expect(calls).toEqual([]);
  });

  it("never passes on a red parent: it runs CI on the release commit instead", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(1, "push", "completed"), run(5, "push", "completed", "main", 0, { head_sha: PARENT })], jobs: { 1: scoped(), 5: red() } },
      {
        runs: [run(1, "push", "completed"), run(5, "push", "completed", "main", 0, { head_sha: PARENT }), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)],
        jobs: { 1: scoped(), 5: red(), 2: red() },
      },
    ], versionBump);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("release lane did not pass") });
    expect(calls).toEqual(LANE);
  });

  it("never passes on a parent's run of Linux's shards alone", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(5, "push", "completed", "main", 0, { head_sha: PARENT })], jobs: { 5: mainLane() } },
      { runs: [run(5, "push", "completed", "main", 0, { head_sha: PARENT }), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 5: mainLane(), 2: green() } },
    ], versionBump);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("never passes on a parent run that skipped its tests", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(5, "push", "completed", "main", 0, { head_sha: PARENT })], jobs: { 5: scoped() } },
      { runs: [run(5, "push", "completed", "main", 0, { head_sha: PARENT }), run(2, "workflow_dispatch", "in_progress", "release-ci/v0.1.94", 5)], jobs: { 5: scoped() } },
    ], versionBump);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("within 10 minutes") });
    expect(calls).toEqual(LANE);
  });

  it.each([
    ["a dependency changed with the version", { [`${SHA}:package.json`]: pkg("0.1.94", { dependencies: { zod: "4" } }) }, ["package.json"]],
    ["a script changed with the version", { [`${SHA}:package.json`]: pkg("0.1.94").replace("vitest run", "vitest run --bail") }, ["package.json"]],
    ["the version did not change", { [`${SHA}:package.json`]: pkg("0.1.93") }, ["package.json"]],
    ["a code file changed too", {}, ["package.json", "server/index.ts"]],
    ["the lockfile changed too", {}, ["package.json", "pnpm-lock.yaml"]],
  ])("does not reuse the parent when %s", async (_, files, changed) => {
    const { calls, options } = fakeGitHub([
      { runs: [run(5, "push", "completed", "main", 0, { head_sha: PARENT })], jobs: { 5: green() } },
      { runs: [run(5, "push", "completed", "main", 0, { head_sha: PARENT }), run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 5: green(), 2: green() } },
    ], {
      commits: { ...versionBump.commits, [SHA]: { tree: TREE, parents: [PARENT], files: changed } },
      files: { ...versionBump.files, ...files },
    });
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("does not reuse a parent of a merge commit", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [run(5, "push", "completed", "main", 0, { head_sha: PARENT })], jobs: { 5: green() } },
      { runs: [run(2, "workflow_dispatch", "completed", "release-ci/v0.1.94", 5)], jobs: { 2: green() } },
    ], { ...versionBump, commits: { ...versionBump.commits, [SHA]: { tree: TREE, parents: [PARENT, OTHER], files: ["package.json"] } } });
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("falls back to the commit's own CI when GitHub cannot describe the commit", async () => {
    const { options } = fakeGitHub([{ runs: [run(1, "push", "completed")], jobs: { 1: green() } }], { commits: {} });
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 1, via: "commit" });
  });
});

describe("a runner that never came", () => {
  const lane = (status: string, run_attempt = 1) => run(2, "workflow_dispatch", status, "release-ci/v0.1.94", 5, { run_attempt });

  it("re-runs the release lane's failed jobs once and keeps waiting", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [] },
      { runs: [lane("completed")], jobs: { 2: runnerLost() } },
      // GitHub has not picked the re-run up yet: still attempt 1
      { runs: [lane("completed")], jobs: { 2: runnerLost() } },
      { runs: [lane("in_progress", 2)] },
      { runs: [lane("completed", 2)], jobs: { 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(["branch release-ci/v0.1.94 @sha", "dispatch release-ci/v0.1.94", "rerun 2", "delete release-ci/v0.1.94"]);
  });

  it("stops when the lane's re-run loses its runner again", async () => {
    const { calls, options } = fakeGitHub([
      { runs: [] },
      { runs: [lane("completed")], jobs: { 2: runnerLost() } },
      { runs: [lane("in_progress", 2)] },
      { runs: [lane("completed", 2)], jobs: { 2: runnerLost() } },
    ]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false, reason: expect.stringContaining("release lane did not pass (runner-lost)") });
    expect(calls).toEqual(["branch release-ci/v0.1.94 @sha", "dispatch release-ci/v0.1.94", "rerun 2", "delete release-ci/v0.1.94"]);
  });

  it.each([
    ["push", "main"],
    ["workflow_dispatch", "main"],
    ["merge_group", "gh-readonly-queue/main/pr-1"],
  ])("never re-runs a %s run on %s in its own queue: it starts CI in the lane", async (event, branch) => {
    // A re-run of main's run would join main's concurrency group and cancel
    // the newest merge's waiting run.
    const lost = run(1, event, "completed", branch);
    const { calls, options } = fakeGitHub([
      { runs: [lost], jobs: { 1: runnerLost() } },
      { runs: [lost, lane("in_progress")], jobs: { 1: runnerLost() } },
      { runs: [lost, lane("completed")], jobs: { 1: runnerLost(), 2: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 2, via: "commit" });
    expect(calls).toEqual(LANE);
  });

  it("waits for another manual run on the commit before starting the lane", async () => {
    const lost = run(1, "push", "completed");
    const { calls, options } = fakeGitHub([
      { runs: [lost, run(3, "workflow_dispatch", "in_progress", "main", 2)], jobs: { 1: runnerLost() } },
      { runs: [lost, run(3, "workflow_dispatch", "completed", "main", 2)], jobs: { 1: runnerLost(), 3: green() } },
    ]);
    expect(await waitForReleaseCi(options)).toEqual({ ok: true, runId: 3, via: "commit" });
    expect(calls).toEqual([]);
  });

  it("never re-runs a real test failure", async () => {
    const { calls, options } = fakeGitHub([{ runs: [run(1, "push", "completed")], jobs: { 1: red() } }]);
    expect(await waitForReleaseCi(options)).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe("GitHub calls", () => {
  it("recovers a release lane from a failed-only rerun with a copied preflight and its original plan", async () => {
    const first = { created_at: "2026-11-05T12:18:00Z", started_at: "2026-11-05T12:18:19Z", completed_at: "2026-11-05T12:22:32Z" };
    const next = { created_at: "2026-11-05T12:47:31Z", started_at: "2026-11-05T12:47:32Z", completed_at: "2026-11-05T12:47:34Z" };
    const staticJob = green().find((job) => job.name === "typecheck + lint")!;
    const relayJob = green().find((job) => job.name === "relay typecheck + tests + fuzz + audit")!;
    const original = { ...staticJob, ...first, id: 10 };
    const copied = { ...original, id: 11, run_attempt: 2, created_at: next.created_at };
    const failedRelay = { ...relayJob, ...first, id: 20, conclusion: "failure", steps: [] };
    const recoveredRelay = { ...relayJob, ...next, id: 21, run_attempt: 2 };
    const failedGate = { ...gate("failure"), ...first, id: 30 };
    const recoveredGate = { ...gate("success"), ...next, id: 31, run_attempt: 2 };
    const others = green().filter((job) => !["CI", original.name, relayJob.name].includes(job.name));
    let rows = [...others, failedGate, recoveredGate, original, copied, failedRelay, recoveredRelay];
    const attempt = (number: number) => run(7, "workflow_dispatch", "completed", "release-ci/v0.1.94", 0, { run_attempt: number });
    const plan = planFor(attempt(1));
    const requests: string[] = [];
    const readNames: string[] = [];
    let phase = 0;
    const fetchImpl = async (url: string, init: { method: string }) => {
      const path = url.replace("https://api.github.com/repos/o/r", "");
      requests.push(`${init.method} ${path}`);
      if (path.startsWith("/commits/")) return Response.json({ commit: { tree: { sha: TREE } }, parents: [{ sha: PARENT }], files: [{ filename: "server/index.ts" }] });
      if (path.includes("/runs?head_sha=")) return Response.json({ workflow_runs: phase ? [attempt(phase)] : [] });
      if (path.includes("/runs?status=completed")) return Response.json({ workflow_runs: [] });
      if (path.includes("/jobs?filter=all")) return Response.json({ jobs: phase === 1 ? [failedGate, original, failedRelay] : rows });
      if (path.includes("/artifacts?")) return Response.json({ artifacts: [{ id: 9, name: "qa-plan-attempt-1", workflow_run: { id: 7, head_sha: SHA } }] });
      if (path.endsWith("/dispatches")) { phase = 1; return new Response(null, { status: 204 }); }
      if (path.endsWith("/rerun-failed-jobs")) { phase = 2; return new Response(null, { status: 201 }); }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (init.method === "POST") return Response.json({}, { status: 201 });
      throw new Error(path);
    };
    const api = githubApi({ token: "t", repository: "o/r", fetchImpl: fetchImpl as typeof fetch,
      artifactReader: async (artifact: { name: string }) => { readNames.push(artifact.name); return { "qa-plan.json": JSON.stringify(plan) }; } });
    let clock = 0;
    expect(await waitForReleaseCi({ api, sha: SHA, version: "0.1.94", now: () => clock, sleep: async (ms: number) => { clock += ms; }, log: () => {}, maxWaitMs: 10 * 60_000 }))
      .toEqual({ ok: true, runId: 7, via: "commit" });
    expect(requests).toContain("POST /actions/runs/7/rerun-failed-jobs");
    expect(requests).toContain("GET /actions/runs/7/jobs?filter=all&per_page=100&page=1");
    expect(readNames).toEqual(["qa-plan-attempt-1"]);
    const normalized = await api.runJobs(7, 2);
    expect(normalized.find((job) => job.name === original.name)).toMatchObject({ id: 10, run_attempt: 1 });
    expect(normalized.find((job) => job.name === relayJob.name)).toMatchObject({ id: 21, run_attempt: 2, priorFailures: [{ attempt: 1, conclusion: "failure" }] });
    rows = rows.filter((job) => job !== original);
    await expect(api.runJobs(7, 2)).rejects.toThrow("Ambiguous workflow job execution");
    rows = [...rows, original, { ...original, id: 12 }];
    await expect(api.runJobs(7, 2)).rejects.toThrow("Ambiguous workflow job execution");
  });

  it("loads the plan from the producing run and rejects a different source SHA", async () => {
    const source = run(7, "workflow_dispatch", "completed");
    const requests: string[] = [];
    let plan = planFor(source);
    const fetchImpl = async (url: string) => {
      const path = url.replace("https://api.github.com/repos/o/r", "");
      requests.push(path);
      if (path.includes("/jobs?")) return Response.json({ jobs: green() });
      if (path.includes("/artifacts?")) return Response.json({ artifacts: [{ id: 9, name: "qa-plan-attempt-1", expired: false, workflow_run: { id: 7 } }] });
      throw new Error(path);
    };
    const api = githubApi({ token: "t", repository: "o/r", fetchImpl: fetchImpl as typeof fetch,
      artifactReader: async () => ({ "qa-plan.json": JSON.stringify(plan) }) });
    const jobs = await api.runJobs(7, 1);
    expect(await api.runPlan(source, jobs)).toEqual(plan);
    plan = { ...plan, sha: OTHER };
    await expect(api.runPlan(source, jobs)).rejects.toThrow("Missing current-run validation plan");
    expect(requests).toEqual(["/actions/runs/7/jobs?filter=all&per_page=100&page=1",
      "/actions/runs/7/artifacts?per_page=100&page=1", "/actions/runs/7/artifacts?per_page=100&page=1"]);
  });

  it("moves an existing lane branch instead of failing, and reads jobs from the latest attempt", async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
      requests.push(`${init.method} ${url.replace("https://api.github.com/repos/o/r", "")} ${init.body ?? ""}`.trim());
      if (init.method === "POST" && url.endsWith("/git/refs")) return new Response("{}", { status: 422 });
      if (url.includes("/jobs")) return Response.json({ jobs: green() });
      return new Response(null, { status: 204 });
    };
    const api = githubApi({ token: "t", repository: "o/r", fetchImpl: fetchImpl as typeof fetch });
    await api.pointBranch("release-ci/v1.2.3", SHA);
    expect(await api.runJobs(7, 1)).toEqual(green().map((job) => ({ ...job, priorFailures: [] })));
    await api.dispatchCi("release-ci/v1.2.3");
    expect(requests).toEqual([
      `POST /git/refs {"ref":"refs/heads/release-ci/v1.2.3","sha":"${SHA}"}`,
      `PATCH /git/refs/heads/release-ci/v1.2.3 {"sha":"${SHA}","force":true}`,
      "GET /actions/runs/7/jobs?filter=all&per_page=100&page=1",
      'POST /actions/workflows/ci.yml/dispatches {"ref":"release-ci/v1.2.3"}',
    ]);
  });

  it("reads a commit, a file at a commit, finished runs per release event, and re-runs failed jobs", async () => {
    const requests: string[] = [];
    const fetchImpl = async (url: string, init: { method: string }) => {
      const path = url.replace("https://api.github.com/repos/o/r", "");
      requests.push(`${init.method} ${path}`);
      if (path.startsWith("/commits/")) return Response.json({ commit: { tree: { sha: TREE } }, parents: [{ sha: PARENT }], files: [{ filename: "package.json" }] });
      if (path.startsWith("/contents/")) return Response.json({ encoding: "base64", content: Buffer.from(pkg("0.1.94")).toString("base64") });
      if (path.includes("status=completed")) return Response.json({ workflow_runs: [{ id: path.length }] });
      // the re-run endpoint answers 201 with no body
      return new Response(null, { status: 201 });
    };
    const api = githubApi({ token: "t", repository: "o/r", fetchImpl: fetchImpl as typeof fetch });
    expect(await api.commit(SHA)).toEqual({ tree: TREE, parents: [PARENT], files: ["package.json"] });
    expect(JSON.parse((await api.fileAt("package.json", SHA))!).version).toBe("0.1.94");
    expect(await api.recentRuns()).toHaveLength(4);
    await api.rerunFailedJobs(42);
    expect(requests).toEqual([
      `GET /commits/${SHA}`,
      `GET /contents/package.json?ref=${SHA}`,
      "GET /actions/workflows/ci.yml/runs?status=completed&event=push&per_page=100",
      "GET /actions/workflows/ci.yml/runs?status=completed&event=merge_group&per_page=100",
      "GET /actions/workflows/ci.yml/runs?status=completed&event=schedule&per_page=100",
      "GET /actions/workflows/ci.yml/runs?status=completed&event=workflow_dispatch&per_page=100",
      "POST /actions/runs/42/rerun-failed-jobs",
    ]);
  });

  it("tries a 5xx or a dropped connection again, but not a 4xx", async () => {
    const answers: Array<() => Response> = [
      () => new Response(null, { status: 500 }),
      () => { throw new TypeError("fetch failed"); },
      () => new Response(null, { status: 204 }),
    ];
    const waits: number[] = [];
    let calls = 0;
    const fetchImpl = async () => answers[calls++]!();
    const api = githubApi({ token: "t", repository: "o/r", fetchImpl: fetchImpl as typeof fetch, retryDelaysMs: [1, 2, 3], sleep: async (ms: number) => { waits.push(ms); } });
    await api.dispatchCi("release-ci/v1.2.3");
    expect(calls).toBe(3);
    expect(waits).toEqual([1, 2]);

    const always500 = githubApi({ token: "t", repository: "o/r", fetchImpl: (async () => new Response(null, { status: 502 })) as typeof fetch, retryDelaysMs: [1, 1], sleep: async () => {} });
    await expect(always500.dispatchCi("x")).rejects.toThrow("HTTP 502");

    let forbidden = 0;
    const no = githubApi({ token: "t", repository: "o/r", fetchImpl: (async () => { forbidden++; return new Response(null, { status: 403 }); }) as typeof fetch, retryDelaysMs: [1, 1], sleep: async () => {} });
    await expect(no.dispatchCi("x")).rejects.toThrow("HTTP 403");
    expect(forbidden).toBe(1);
  });
});
