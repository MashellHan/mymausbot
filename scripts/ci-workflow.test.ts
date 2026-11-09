import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EVALS_LANE, PACKAGED_SERVER_LANE, vitestLane } from "./ci-linux-lanes.mjs";
import { SELECTABLE_JOBS, vitestMatrix } from "./ci-scope.mjs";
import { interpolate } from "./testing/github-expression.ts";
import { verifyGate } from "./qa/gate.mjs";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const requiredRuntimeJobs = ["vitest", "behavior-evals", "packaged-server", "windows-cua", "electron-smokes", "relay"];
const prContext = (action: string | null, label: string | null, { number = 134, base = "a".repeat(40), head = "b".repeat(40), runId = 42 }: {
  number?: number | null; base?: string | null; head?: string | null; runId?: number;
} = {}) => ({ github: { event_name: "pull_request", event: { action, label: label === null ? null : { name: label },
  pull_request: { number, base: { sha: base }, head: { sha: head } } }, run_id: runId, ref: "refs/pull/134/merge" } });
const decision = (context: Parameters<typeof interpolate>[1]) => ({
  group: interpolate(workflow.concurrency.group, context),
  cancel: interpolate(workflow.concurrency["cancel-in-progress"], context),
  static: interpolate(workflow.jobs.static.if, context),
  gateName: interpolate(workflow.jobs.gate.name, context),
  gate: interpolate(workflow.jobs.gate.if.replace(/!cancelled\(\)\s*&&\s*/, ""), context),
});

function runGate(state: ReturnType<typeof gateState>) {
  return verifyGate(state.outputs, { deadlineMs: 0, api: async (path: string) => path.startsWith("/issues?") ? [] : { jobs: state.jobs } });
}

function gateState(selected: string[]) {
  const required = requiredRuntimeJobs.filter((job) => selected.includes(job));
  return {
    outputs: { expected_jobs: ["static", ...required].map((id) => ({ id, name: id })), required_jobs: required, qa_areas: ["global"], full_required: false, reduced: false },
    jobs: ["static", ...requiredRuntimeJobs].map((name) => ({ name, run_attempt: 1, status: "completed", conclusion: name === "static" || required.includes(name) ? "success" : "skipped" })),
  };
}

describe("CI concurrency", () => {
  it("supersedes old PR checks but never cancels a running main or merge-queue run", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on).toHaveProperty("merge_group");
    expect(decision(prContext("synchronize", null))).toMatchObject({ group: "ci-pr-134", cancel: true });
    expect(decision({ github: { event_name: "push", ref: "refs/heads/main" } })).toMatchObject({ group: "ci-refs/heads/main", cancel: false });
    expect(decision({ github: { event_name: "merge_group", event: { merge_group: { head_ref: "refs/heads/queue" } } } }))
      .toMatchObject({ group: "ci-refs/heads/queue", cancel: false });
  });

  it("keeps main's pushes to one running and one waiting run, and gives every other run a group no push joins", () => {
    // One group for every main push: GitHub keeps the running run and only
    // the newest waiting one, so a burst of merges cannot pile up runs. A
    // merge group has its own ref; the nightly run and each manual run (the
    // release lane among them) are named by event and branch, so a push
    // never replaces one that is waiting.
    expect(decision({ github: { event_name: "schedule", ref: "refs/heads/main" } }).group).toBe("ci-schedule-refs/heads/main");
    expect(decision({ github: { event_name: "workflow_dispatch", ref: "refs/heads/release/v1" } }).group).toBe("ci-workflow_dispatch-refs/heads/release/v1");
  });

  it.each(["qa:triaged", "qa:p1", "qa:kind:product", "qa:scope:agents", "owner:upstream", "bug"])(
    "does not cancel checks or publish a CI check for %s metadata", (label) => {
      for (const action of ["labeled", "unlabeled"]) {
        expect(decision(prContext(action, label))).toEqual({
          group: "ci-metadata-134-42", cancel: false, static: false, gateName: "PR metadata ignored", gate: false,
        });
      }
    },
  );

  it("keeps ignored metadata runs separate from each other and all validation jobs behind static", () => {
    expect(decision(prContext("labeled", "qa:triaged", { runId: 42 })).group)
      .not.toBe(decision(prContext("labeled", "owner:upstream", { runId: 43 })).group);
    for (const [id, job] of Object.entries(workflow.jobs as Record<string, { needs?: unknown }>)) {
      if (id !== "static" && id !== "gate") expect(job.needs, id).toBeDefined();
    }
  });

  it.each(["ci:full", "qa:repair", "windows", "upstream-sync"])("runs required checks when %s is added or removed", (label) => {
    for (const action of ["labeled", "unlabeled"]) {
      expect(decision(prContext(action, label))).toEqual({
        group: "ci-pr-134", cancel: true, static: true, gateName: "CI", gate: true,
      });
    }
  });

  it("runs validation for incomplete or unknown label events", () => {
    for (const context of [
      prContext("labeled", null),
      prContext(null, "qa:triaged"),
      prContext("edited", "qa:triaged"),
      prContext("labeled", "qa:triaged", { number: null }),
      prContext("labeled", "qa:triaged", { base: null }),
      prContext("labeled", "qa:triaged", { head: null }),
    ]) expect(decision(context)).toMatchObject({ cancel: true, static: true, gateName: "CI", gate: true });
  });

  it("runs the full lane once daily at 05:00 China time", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "0 21 * * *" }]);
  });

  it("stops a closed PR's run by joining ci.yml's PR group", () => {
    const stop = parse(readFileSync(new URL("../.github/workflows/ci-stop-closed.yml", import.meta.url), "utf8"));
    expect(stop.on).toEqual({ pull_request: { types: ["closed"] } });
    expect(stop.concurrency).toEqual({ group: "ci-pr-${{ github.event.pull_request.number }}", "cancel-in-progress": true });
    expect(decision(prContext("synchronize", null)).group).toBe("ci-pr-134");
  });

  it("never lets a merged PR's stop run join main's group", () => {
    // A merged PR's closed event reports the base branch as github.ref, so a
    // ref-named group would cancel main's CI on every merge.
    const stop = parse(readFileSync(new URL("../.github/workflows/ci-stop-closed.yml", import.meta.url), "utf8"));
    expect(stop.concurrency.group).not.toContain("github.ref");
    expect(stop.concurrency.group).toContain("github.event.pull_request.number");
    expect(stop.permissions).toEqual({});
  });

  it("creates the required check immediately so a new full request replaces old green evidence", () => {
    expect(workflow.jobs.gate.if).toContain("!cancelled()");
    expect(workflow.jobs.gate.needs).toBeUndefined();
    expect(decision(prContext("labeled", "ci:full"))).toMatchObject({ group: "ci-pr-134", gateName: "CI", gate: true });
    expect(workflow.jobs.gate.steps.some((step: { run?: string }) => step.run === "node scripts/qa/gate.mjs")).toBe(true);
  });

  it("schedules one read-only final gate over the selected platform matrix", () => {
    expect(decision(prContext("synchronize", null)).gateName).toBe("CI");
    expect(workflow.jobs.gate.strategy).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.vitest.strategy.matrix).toBe("${{ fromJSON(needs.static.outputs.vitest_matrix) }}");
    expect(workflow.jobs.vitest.strategy["max-parallel"]).toBe(4);
    expect(workflow.jobs.vitest["timeout-minutes"]).toBe("${{ matrix.os == 'ubuntu-latest' && 25 || 30 }}");
  });

  it("runs each selected platform's own shards, and its e2e files, from ci-scope's matrix", () => {
    expect(workflow.jobs.static.outputs.vitest_matrix).toBe("${{ steps.scope.outputs.vitest_matrix }}");
    expect(workflow.jobs.vitest.name).toBe("vitest (${{ matrix.os }}, ${{ matrix.part }})");
    const run = (workflow.jobs.vitest.steps as { name?: string; run?: string; env?: Record<string, string> }[])
      .find((step) => step.name === "Run tests")!;
    expect(run.run).toContain("pnpm exec vitest run ${{ matrix.files }} --shard=${{ matrix.shard }}/${{ matrix.shards }} ");
    expect(run.env?.OMB_VITEST_E2E).toBe("${{ matrix.e2e }}");
    expect(run.env?.OMB_VITEST_SUBSET).toBe("${{ matrix.files }}");
    expect(run.env?.OMB_VITEST_WORKERS).toBe("${{ matrix.workers }}");
    const { include } = vitestMatrix(["macos-latest", "ubuntu-latest", "windows-latest"]);
    for (const os of ["macos-latest", "ubuntu-latest", "windows-latest"]) {
      const shards = include.filter((entry) => entry.os === os);
      expect(shards.map((entry) => entry.shard)).toEqual(Array.from({ length: shards[0]!.shards }, (_, i) => i + 1));
      expect(new Set(shards.map((entry) => entry.e2e))).toEqual(new Set([os === "ubuntu-latest" ? "all" : "host"]));
    }
    const units = (workflow.jobs.vitest.steps as { name?: string; if?: string; "timeout-minutes"?: number }[]).find((step) => step.name === "Broker and Electron unit tests")!;
    expect(units["timeout-minutes"]).toBe(5);
    // Once per platform's full run, and beside the locale tests, never once per shard.
    expect(units.if).toBe("matrix.node_tests");
    // Browser jobs keep one job per platform, and the packaged server one per platform without the macOS smokes.
    expect(workflow.jobs["browser-identity"].strategy.matrix.os).toBe("${{ fromJSON(needs.static.outputs.vitest_os) }}");
    expect(workflow.jobs["browser-driver"].strategy.matrix.os).toBe("${{ fromJSON(needs.static.outputs.vitest_os) }}");
    expect(workflow.jobs["packaged-server"].strategy.matrix.os).toBe("${{ fromJSON(needs.static.outputs.packaged_server_os) }}");
  });

  it("keeps each PR to one macOS job", () => {
    const macosJobs = Object.entries(workflow.jobs as Record<string, { "runs-on": string; strategy?: { matrix?: { os?: unknown } } }>)
      .filter(([, job]) => job["runs-on"] === "macos-latest" || JSON.stringify(job.strategy?.matrix?.os ?? "").includes("macos"))
      .map(([name]) => name);
    expect(macosJobs.sort()).toEqual(["electron-smokes"]);
    const smokes = workflow.jobs["electron-smokes"].steps.map((step: { run?: string }) => step.run);
    expect(smokes).toContain("pnpm test:packaged-server");
  });

  it("checks delegated approval modes on the receipt's work thread, not the selected sibling", () => {
    const smoke = readFileSync(new URL("./smoke-approval-modes.cjs", import.meta.url), "utf8");
    const delegated = smoke.slice(smoke.indexOf("const peerTarget ="), smoke.indexOf("const customCalls ="));
    expect(delegated).toContain("const peerWorkThreadId = peerResponse.body.receipts[0].threadId;");
    expect(delegated).toContain("assert.notEqual(peerWorkThreadId, peerThread.threadId);");
    expect(delegated).toContain("task.threadId === peerWorkThreadId)?.busy === false");
    expect(delegated).toContain("/tasks/${peerWorkThreadId}`");
    expect(delegated).toContain("assert.equal(askPeerResponse.body.receipts[0].threadId, peerWorkThreadId);");
    expect(delegated).toContain("/api/threads/${peerWorkThreadId}/messages");
    expect(delegated).toContain("/api/threads/${peerWorkThreadId}/respond");
    expect(delegated).toContain("const customThreadId = customResponse.body.receipts[0].threadId;");
    expect(delegated).toContain("/api/threads/${customThreadId}/messages");
    expect(delegated).toContain("/api/threads/${customThreadId}/respond");
    expect(delegated).not.toContain("pendingCard((await api(\"/api/bots\"))");
    expect(delegated).not.toContain("/tasks/${peerThread.threadId}`");
  });

  it("makes a release wait for its commit's CI gate before any draft", () => {
    const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
    expect(release.jobs.assemble.needs).toContain("ci");
    expect(release.jobs.ci.needs).toBe("prepare");
    expect(release.jobs.ci.permissions).toEqual({ actions: "write", contents: "write" });
    const wait = release.jobs.ci.steps.find((step: { run?: string }) => step.run === "node scripts/release-ci.mjs");
    expect(wait.if).toBe("${{ !inputs.ship_without_ci }}");
    expect(wait.env).toMatchObject({ SHA: "${{ needs.prepare.outputs.sha }}", VERSION: "${{ needs.prepare.outputs.version }}" });
    // The script reads ci.yml's gate by its job name.
    expect(readFileSync(new URL("./release-ci.mjs", import.meta.url), "utf8"))
      .toContain(`job.name === "${decision({ github: { event_name: "workflow_dispatch", ref: "refs/heads/release/v1" } }).gateName}"`);
    // The release lane is a branch, so its runs get their own concurrency group.
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  it("checks out every module the release gate imports", () => {
    const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
    const checkout = release.jobs.ci.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
    const sparse = (checkout.with["sparse-checkout"] as string).split("\n").map((line) => line.trim()).filter(Boolean);
    const imports = [...readFileSync(new URL("./release-ci.mjs", import.meta.url), "utf8").matchAll(/^import .* from "\.\/([^"]+)";$/gm)]
      .map((match) => `scripts/${match[1]}`);
    expect(imports).toContain("scripts/ci-scope.mjs");
    expect(sparse.sort()).toEqual(["scripts/release-ci.mjs", ...imports].sort());
  });

  it("builds the Windows Defender check's installer exactly as the release's Windows job does", () => {
    const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
    const check = parse(readFileSync(new URL("../.github/workflows/windows-defender-check.yml", import.meta.url), "utf8"));
    type Step = { uses?: string; with?: unknown; run?: string; shell?: string };
    const toolchainToInstaller = (steps: Step[]) => steps.slice(1, steps.findIndex((step) => step.run === "pnpm package:win") + 1)
      .map(({ uses, with: inputs, run, shell }) => ({ uses, with: inputs, run, shell }));
    expect(toolchainToInstaller(check.jobs.check.steps).at(-1)?.run).toBe("pnpm package:win");
    expect(toolchainToInstaller(check.jobs.check.steps)).toEqual(toolchainToInstaller(release.jobs.windows.steps));
    expect(check.jobs.check["runs-on"]).toBe(release.jobs.windows["runs-on"]);
  });

  it("lets the scope read the previous commit's CI and a pull request's labels, and nothing more", () => {
    // ci-scope.mjs runs a push's docs- or version-only diff without the runtime
    // jobs only when the commit before it has its own green run, and a PR's
    // Windows jobs when it carries the windows label.
    expect(workflow.jobs.static.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read", issues: "read" });
    const scope = workflow.jobs.static.steps.find((step: { id?: string }) => step.id === "scope");
    expect(scope.env).toEqual({ GH_TOKEN: "${{ github.token }}", MAUSBOT_CI_MODE: "${{ vars.MAUSBOT_CI_MODE }}", OMB_CI_LINUX_IN_STATIC: "${{ runner.environment == 'self-hosted' }}" });
    for (const [name, job] of Object.entries(workflow.jobs) as [string, { permissions?: unknown }][]) {
      if (name === "gate") expect(job.permissions).toEqual({ contents: "read", actions: "read", issues: "read", "pull-requests": "read" });
      else if (name !== "static") expect(job.permissions, name).toBeUndefined();
    }
  });

  it("reports every known flaky test that needed a retry in the vitest job summary", () => {
    const steps = workflow.jobs.vitest.steps as { name?: string; run?: string; if?: string; env?: Record<string, string> }[];
    const tests = steps.findIndex((step) => step.name === "Run tests");
    const report = steps.findIndex((step) => step.run === "node scripts/testing/ci-retry-summary.mjs");
    expect(report).toBe(tests + 1);
    expect(steps[report]!.if).toBe("${{ !cancelled() }}");
    // The runner context exists only at step level, never in a job's env.
    expect(workflow.jobs.vitest.env).toBeUndefined();
    for (const step of [steps[tests]!, steps[report]!]) {
      expect(step.env?.OMB_VITEST_RETRY_LOG).toBe("${{ github.workspace }}/qa-results/vitest-retries.jsonl");
    }
    expect(readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8")).toContain('runner: "./scripts/testing/ci-retry-runner.ts"');
  });

  it.each(requiredRuntimeJobs)("fails closed for every required %s outcome when selected", async (job) => {
    for (const result of ["success", "failure", "cancelled", "skipped"]) {
      const state = gateState(SELECTABLE_JOBS);
      state.jobs.find((item) => item.name === job)!.conclusion = result;
      if (result === "success") await expect(runGate(state)).resolves.toBeUndefined();
      else await expect(runGate(state)).rejects.toThrow("Required validation failed");
    }
  });

  it("fails a broken source guard in static, before any runner is asked for", () => {
    const steps = workflow.jobs.static.steps as { name?: string; run?: string; if?: string }[];
    const guards = steps.find((step) => step.name === "Source guards")!;
    expect(guards.if).toBeUndefined();
    const named = guards.run!.split(" ").filter((word) => /\.test\.ts$|\/$/.test(word));
    // A name vitest cannot match would silently drop that guard.
    for (const path of named) expect(existsSync(new URL(`../${path}`, import.meta.url)), path).toBe(true);
    expect(named).toContain("src/locales/");
    expect(named).toContain("scripts/testing/file-size-ratchet.test.ts");
    expect(steps.some((step) => step.run === "pnpm typecheck")).toBe(true);
    // Every test the guards run stays in the suite: vitest's include has them, so the shards still deal them out.
    expect(workflow.jobs.vitest.needs).toBe("static");
  });

  it.each(requiredRuntimeJobs)("allows an unselected %s to be skipped", async (job) => {
    const others = SELECTABLE_JOBS.filter((name) => name !== job);
    await expect(runGate(gateState(others))).resolves.toBeUndefined();
  });

  it("accepts successful preflight when the selected plan has no runtime jobs", async () => {
    await expect(runGate(gateState([]))).resolves.toBeUndefined();
  });

  it("rejects failed preflight and missing or malformed selection", async () => {
    for (const result of ["failure", "cancelled", "skipped"]) {
      const state = gateState([]);
      state.jobs[0]!.conclusion = result;
      await expect(runGate(state)).rejects.toThrow("Required validation failed");
    }
    for (const expected of [undefined, [], "yes", true, {}, [1], null]) {
      const state = gateState([]);
      Object.assign(state.outputs, { expected_jobs: expected });
      await expect(runGate(state)).rejects.toThrow();
    }
  });

  it("rejects a selected required job absent from the plan or observed execution", async () => {
    const state = gateState(["vitest"]);
    state.outputs.required_jobs.push("new-required-job");
    await expect(runGate(state)).rejects.toThrow("Missing required validation plan");
    const missing = gateState(["vitest"]);
    missing.jobs = missing.jobs.filter((item) => item.name !== "vitest");
    await expect(runGate(missing)).rejects.toThrow("Incomplete required validation");
  });

  it("validates selection and docs before fanout for a source change", () => {
    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "labeled", "unlabeled"]);
    expect(decision(prContext("synchronize", null)).static).toBe(true);
    expect(workflow.jobs.static.steps[0].with["fetch-depth"]).toBe(0);
    expect(workflow.jobs.static.steps.find((step: { id?: string }) => step.id === "scope").run).toBe("node scripts/ci-scope.mjs");
    expect(workflow.jobs.static.outputs).toEqual({
      full_required: "${{ steps.scope.outputs.full_required }}",
      required_jobs: "${{ steps.scope.outputs.required_jobs }}",
      expected_jobs: "${{ steps.scope.outputs.expected_jobs }}",
      reduced: "${{ steps.scope.outputs.reduced }}",
      qa_areas: "${{ steps.scope.outputs.qa_areas }}",
      repair_ids: "${{ steps.scope.outputs.repair_ids }}",
      shadow: "${{ steps.scope.outputs.shadow }}",
      fast_pr: "${{ steps.scope.outputs.fast_pr }}",
      fast_files: "${{ steps.scope.outputs.fast_files }}",
      deferred_files: "${{ steps.scope.outputs.deferred_files }}",
      jobs: "${{ steps.scope.outputs.jobs }}",
      vitest_os: "${{ steps.scope.outputs.vitest_os }}",
      vitest_matrix: "${{ steps.scope.outputs.vitest_matrix }}",
      packaged_server_os: "${{ steps.scope.outputs.packaged_server_os }}",
    });
    const steps = workflow.jobs.static.steps as Step[];
    const planUpload = steps.findIndex((step) => step.with?.name?.startsWith("qa-plan-attempt-"));
    expect(planUpload).toBeGreaterThan(steps.findIndex((step) => step.id === "scope"));
    expect(planUpload).toBeLessThan(steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile"));
    const fast = steps.find((step) => step.name === "Security, data and dispatch core with bounded affected tests")!;
    expect(fast.if).toBe("steps.scope.outputs.fast_pr == 'true'");
    expect(fast.run).toBe("node scripts/testing/fast-static-overlap.mjs run");
    expect(fast.env).toMatchObject({ OMB_VITEST_E2E: "all", OMB_VITEST_WORKERS: 2,
      OMB_VITEST_SUBSET: "${{ steps.scope.outputs.fast_files }}", OMB_FAST_TYPECHECK: "${{ steps.scope.outputs.build }}" });
    expect(steps[steps.indexOf(fast) + 1]?.if).toBe("always() && steps.scope.outputs.fast_pr == 'true'");
    const built = (workflow.jobs.static.steps as { if?: string; run?: string }[]).filter((step) => step.if?.includes("outputs.build"));
    expect(built.map((step) => [step.if, step.run])).toEqual([
      ["always() && steps.scope.outputs.build == 'true' && steps.scope.outputs.fast_pr == 'true'", "node scripts/testing/fast-static-overlap.mjs typecheck-result"],
      ["steps.scope.outputs.build == 'true' && steps.scope.outputs.fast_pr != 'true'", "pnpm typecheck"],
      ["steps.scope.outputs.build == 'true' && steps.scope.outputs.fast_pr != 'true'", "pnpm check:electron"],
      ["steps.scope.outputs.build == 'true' && steps.scope.outputs.fast_pr != 'true'", "pnpm exec vite build"],
    ]);
    expect(steps.find((step) => step.name === "pnpm typecheck (parallel result)")?.run)
      .toBe("node scripts/testing/fast-static-overlap.mjs typecheck-result");
    expect(workflow.jobs.static.steps.some((step: { run?: string }) =>
      step.run === "pnpm exec vitest run scripts/ci-scope.test.ts scripts/ci-linux-lanes.test.ts scripts/ci-workflow.test.ts scripts/testing/verification-docs.test.ts scripts/check.test.ts scripts/typecheck.test.ts scripts/check-electron-entrypoints.test.ts scripts/check-local-app.test.ts scripts/qa/qa.test.ts",
    )).toBe(true);
    for (const [name, job] of Object.entries(workflow.jobs) as [string, { needs?: string | string[]; if?: string }][]) {
      if (["static", "gate", "shadow"].includes(name)) continue;
      // The one deploy job: after the control-plane checks, on main pushes only. It is
      // not part of the merge gate.
      if (name === "deploy-composio-broker") {
        expect(job.needs).toEqual(["control-plane"]);
        expect(job.if).toBe("github.event_name == 'push' && github.ref == 'refs/heads/main'");
        expect(workflow.jobs.gate.needs).toBeUndefined();
        // Without the Cloudflare token the deploy is skipped with a warning, not failed:
        // every step after the token check waits on it.
        const [check, ...rest] = job.steps as { id?: string; if?: string; env?: Record<string, string>; run?: string }[];
        expect(check.id).toBe("token");
        expect(check.env).toEqual({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}" });
        expect(check.run).toContain("::warning");
        for (const step of rest) expect(step.if).toBe("steps.token.outputs.present == 'true'");
        // The broker is typechecked and tested in the same checkout it deploys.
        const runs = rest.map((step) => step.run);
        const deploy = rest.findIndex((step) => (step as { uses?: string }).uses?.startsWith("cloudflare/wrangler-action@"));
        expect(runs.indexOf("pnpm broker:check")).toBeGreaterThan(-1);
        expect(runs.indexOf("pnpm broker:check")).toBeLessThan(deploy);
        expect(runs.indexOf("pnpm broker:test")).toBeGreaterThan(-1);
        expect(runs.indexOf("pnpm broker:test")).toBeLessThan(deploy);
        continue;
      }
      expect(job.needs).toBe("static");
      expect(job.if).toBe(`contains(needs.static.outputs.jobs, '"${name}"')`);
    }
    // ci-scope selects exactly the jobs the workflow has.
    expect(Object.keys(workflow.jobs).filter((name) => !["static", "gate", "shadow", "deploy-composio-broker"].includes(name)).sort())
      .toEqual([...SELECTABLE_JOBS].sort());
  });

  it("pins every external action to a full commit SHA", () => {
    const uses = (Object.values(workflow.jobs) as { steps?: { uses?: string }[] }[])
      .flatMap((job) => job.steps ?? []).flatMap((step) => (step.uses && !step.uses.startsWith("./") ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
  });

  it("keeps the redundant Windows workflow available only for manual debugging", () => {
    const smoke = parse(readFileSync(new URL("../.github/workflows/shared-terminal-smoke.yml", import.meta.url), "utf8"));
    expect(smoke.on).toEqual({ workflow_dispatch: null });
    const commands = smoke.jobs.windows.steps.map((step: { run?: string }) => step.run);
    expect(commands).toContain("node --test electron/shared-computer-access.node-test.mjs");
    expect(commands).toContain("pnpm exec vitest run server/shared-computers.e2e.test.ts");
  });
});

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; shell?: string; env?: Record<string, string>; with?: Record<string, string> };

/** The contexts a run's static job is routed by: a pull request from `author`, a push, a merge group or a scheduled run. */
function runContext({ boat = "on", event = "pull_request", actor = "milind-soni", triggering = actor, author = actor, head = "milind-soni/OpenMausBot" }: {
  boat?: string | null; event?: string; actor?: string; triggering?: string; author?: string; head?: string | null;
} = {}) {
  return {
    vars: boat === null ? {} : { BOAT_CI: boat },
    github: {
      event_name: event, actor, triggering_actor: triggering, repository: "milind-soni/OpenMausBot", repository_owner: "milind-soni",
      event: event === "pull_request" ? { pull_request: { user: { login: author }, head: { repo: head === null ? null : { full_name: head } } } } : {},
    },
  };
}

describe("CI on Boat", () => {
  const routed = (context: ReturnType<typeof runContext>) => ({
    runsOn: interpolate(workflow.jobs.static["runs-on"], context),
    name: interpolate(workflow.jobs.static.name, context),
    timeout: interpolate(String(workflow.jobs.static["timeout-minutes"]), context),
  });
  const boat = { runsOn: "boat-xlarge", name: "typecheck + lint + Linux tests (Boat)", timeout: 45 };
  const github = (timeout: number) => ({ runsOn: "ubuntu-latest", name: "typecheck + lint", timeout });

  it.each([
    ["the owner's push to main", { event: "push" }],
    ["a merge group the owner queued", { event: "merge_group" }],
  ])("runs the static job, with the Linux work, on one Boat VM for %s", (_, run) => {
    expect(routed(runContext(run))).toEqual(boat);
  });

  it.each([
    ["for the owner's pull request", {}, 15],
    ["while BOAT_CI is not set", { boat: null }, 15],
    ["while BOAT_CI is off", { boat: "off" }, 15],
    ["for a fork's pull request", { head: "someone/OpenMausBot", author: "someone", actor: "someone" }, 15],
    ["for a fork's pull request the owner started", { head: "someone/OpenMausBot", author: "someone" }, 15],
    ["for a deleted fork's pull request", { head: null }, 15],
    ["for a teammate's pull request on this repository", { author: "teammate", actor: "teammate" }, 15],
    ["for the owner's pull request that a teammate pushed to", { actor: "teammate" }, 15],
    ["for the owner's pull request that a teammate re-ran", { triggering: "teammate" }, 15],
    ["for a push a bot made", { event: "push", actor: "github-actions[bot]" }, 45],
    ["for the nightly run", { event: "schedule" }, 45],
    ["for a manual run, the release lane among them", { event: "workflow_dispatch" }, 45],
  ])("keeps every job on GitHub's runners %s", (_, run, timeout) => {
    expect(routed(runContext(run))).toEqual(github(timeout));
  });

  it("does the Linux work in the static job only where ci-scope moved it there, without Boat's extra rights or desktop", () => {
    const steps = workflow.jobs.static.steps as Step[];
    const boatOnly = steps.slice(steps.findIndex((step) => step.name === "Remove what Boat installs and GitHub's runners lack"));
    expect(boatOnly.map((step) => step.if)).toEqual([
      "steps.scope.outputs.linux_lanes", "steps.scope.outputs.linux_lanes", "steps.scope.outputs.linux_lanes",
      "${{ !cancelled() && steps.scope.outputs.linux_lanes }}", "failure() && steps.scope.outputs.linux_lanes", "always() && steps.scope.outputs.linux_lanes",
    ]);
    const lanes = boatOnly.find((step) => step.run === "node scripts/ci-linux-lanes.mjs")!;
    expect(lanes.env).toMatchObject({ OMB_CI_LINUX_LANES: "${{ steps.scope.outputs.linux_lanes }}", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" });
    expect(lanes.shell).toBe("setpriv --inh-caps=-all --ambient-caps=-all -- env -u DISPLAY -u XAUTHORITY bash --noprofile --norc -eo pipefail {0}");
    expect(boatOnly.find((step) => step.run?.startsWith("sudo rm -f "))!.run).toContain("/usr/bin/bwrap");
    // The same report and artifact as the vitest and behavior-evals jobs.
    const report = (workflow.jobs.vitest.steps as Step[]).find((step) => step.run === "node scripts/testing/ci-retry-summary.mjs")!;
    expect(boatOnly.find((step) => step.run === "node scripts/testing/ci-retry-summary.mjs")!.env).toEqual(report.env);
    const upload = (workflow.jobs["behavior-evals"].steps as Step[]).find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(boatOnly.at(-2)).toEqual({ ...upload, if: "failure() && steps.scope.outputs.linux_lanes" });
  });

  it("runs on Boat exactly the commands the Linux jobs run on GitHub's runners", () => {
    const steps = (job: string) => workflow.jobs[job].steps as Step[];
    const work = (job: string) => steps(job).filter((step) => step.run && step.run !== "pnpm install --frozen-lockfile").map((step) => step.run);
    for (const entry of vitestMatrix(["ubuntu-latest"]).include.slice(0, 2)) {
      const context = { matrix: entry, runner: { temp: "/t" }, github: { workspace: "/w" } };
      const tests = steps("vitest").find((step) => step.name === "Run tests")!;
      const units = steps("vitest").find((step) => step.name === "Broker and Electron unit tests")!;
      const lane = vitestLane(entry, "/w/qa-results/vitest-retries.jsonl");
      expect(lane.commands).toEqual([interpolate(tests.run!, context), ...(entry.node_tests ? [units.run] : [])]);
      expect(lane.env).toEqual(Object.fromEntries(Object.entries(tests.env!).map(([key, value]) => [key, interpolate(value, context)])));
    }
    expect(EVALS_LANE.commands).toEqual(work("behavior-evals"));
    expect(PACKAGED_SERVER_LANE.commands).toEqual(work("packaged-server"));
  });

  it("starts Boat VMs from no other workflow", () => {
    const directory = new URL("../.github/workflows/", import.meta.url);
    const onBoat = readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))
      .filter((file) => /runs-on:[^\n]*boat|'boat(?:-\w+)?'/.test(readFileSync(new URL(file, directory), "utf8")));
    expect(onBoat).toEqual(["ci.yml"]);
  });
});
