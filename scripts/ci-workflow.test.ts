import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SELECTABLE_JOBS, ciOutputs, LINUX_OS, vitestMatrix } from "./ci-scope.mjs";
import { evaluate, interpolate } from "./testing/github-expression.ts";
import { executionComplete, expectedJobs } from "./qa/contracts.mjs";
import { verifyGate } from "./qa/gate.mjs";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const requiredRuntimeJobs = ["vitest", "behavior-evals", "electron-smokes", "control-plane", "relay", "pwa-relay"];
const prContext = (action: string | null, label: string | null, { number = 134, base = "a".repeat(40), head = "b".repeat(40), baseRef = "main", runId = 42 }: {
  number?: number | null; base?: string | null; head?: string | null; baseRef?: string; runId?: number;
} = {}) => ({ github: { event_name: "pull_request", event: { action, label: label === null ? null : { name: label },
  pull_request: { number, base: { sha: base, ref: baseRef }, head: { sha: head } } }, run_id: runId, ref: "refs/pull/134/merge" } });
const decision = (context: Parameters<typeof interpolate>[1]) => ({
  group: interpolate(workflow.concurrency.group, context),
  cancel: interpolate(workflow.concurrency["cancel-in-progress"], context),
  static: interpolate(workflow.jobs.static.if, context),
  gateName: interpolate(workflow.jobs.gate.name, context),
  gate: interpolate(workflow.jobs.gate.if.replace(/!cancelled\(\)/, "true"), context),
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

  it("validates the model manifest before anything lands on main", () => {
    const step = workflow.jobs.static.steps.find((candidate: { name?: string }) => candidate.name === "Validate the model manifest");
    expect(step.run).toContain("scripts/check-model-manifest.mjs");
    expect(workflow.on.pull_request).toBeDefined();
  });

  it.each(["qa:triaged", "qa:p1", "qa:kind:product", "qa:scope:agents", "owner:upstream", "bug", "upstream-sync"])(
    "keeps %s metadata separate while its required proof gate stays pending", (label) => {
      for (const action of ["labeled", "unlabeled"]) {
        expect(decision(prContext(action, label))).toEqual({
          group: "ci-metadata-134-42", cancel: false, static: false, gateName: "CI", gate: true,
        });
      }
    },
  );

  it("keeps ordinary metadata proofs separate from each other and all test jobs behind static", () => {
    expect(decision(prContext("labeled", "qa:triaged", { runId: 42 })).group)
      .not.toBe(decision(prContext("labeled", "owner:upstream", { runId: 43 })).group);
    for (const [id, job] of Object.entries(workflow.jobs as Record<string, { needs?: unknown }>)) {
      if (id !== "static" && id !== "gate") expect(job.needs, id).toBeDefined();
    }
  });

  it("keeps label checks read-only for a PR targeting a non-main base", () => {
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.gate.permissions).toEqual({ contents: "read", actions: "read", issues: "read", "pull-requests": "read" });
    expect(decision(prContext("labeled", "ci:full", { baseRef: "release/test" })))
      .toMatchObject({ group: "ci-pr-134", cancel: true, static: true, gateName: "CI", gate: true });
  });

  it.each(["ci:full", "qa:repair", "windows"])("runs required checks when %s is added or removed", (label) => {
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
    expect(workflow.jobs.gate.steps.some((step: { run?: string }) => step.run === "node scripts/qa/label-gate.mjs")).toBe(true);
    expect(decision(prContext("labeled", "qa:triaged"))).toMatchObject({ gateName: "CI", gate: true, static: false });
  });

  it("schedules one read-only final gate over the selected platform matrix", () => {
    expect(decision(prContext("synchronize", null)).gateName).toBe("CI");
    expect(workflow.jobs.gate.strategy).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.vitest.strategy.matrix).toBe("${{ fromJSON(needs.static.outputs.vitest_matrix) }}");
    expect(workflow.jobs.vitest.strategy["max-parallel"]).toBe(4);
    const timeout = workflow.jobs.vitest["timeout-minutes"];
    const fullMac = { os: "macos-latest", files: "" };
    const pr = { event_name: "pull_request" };
    expect(interpolate(timeout, { matrix: fullMac, github: pr })).toBe(45);
    for (const event_name of ["push", "merge_group", "schedule", "workflow_dispatch"]) {
      expect(interpolate(timeout, { matrix: fullMac, github: { event_name } })).toBe(31);
    }
    expect(interpolate(timeout, { matrix: { ...fullMac, files: "server/a.test.ts" }, github: pr })).toBe(30);
    expect(interpolate(timeout, { matrix: { os: "ubuntu-latest" }, github: pr })).toBe(25);
    expect(workflow.jobs.gate["timeout-minutes"]).toBe(180);
    // Ubuntu 26.04 (today's ubuntu-latest) lets bubblewrap box the Cloud e2e fixtures; the Linux shards keep 24.04.
    expect(workflow.jobs.vitest["runs-on"]).toBe("${{ matrix.os == 'ubuntu-latest' && 'ubuntu-24.04' || matrix.os }}");
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
    expect(run.env?.OMB_VITEST_FIRST_SHARD_SECONDS).toBe("${{ matrix.os == 'macos-latest' && matrix.files == '' && '120' || '0' }}");
    const { include } = vitestMatrix(["macos-latest"]);
    expect(include.map((entry) => entry.shard)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(include.every((entry) => entry.e2e === "all")).toBe(true);
    expect(include.filter((entry) => entry.node_tests).map((entry) => entry.shard)).toEqual([1]);
    for (const matrix of include) {
      expect(interpolate(run.env!.OMB_VITEST_FIRST_SHARD_SECONDS, { matrix })).toBe("120");
    }
    for (const matrix of [{ os: "ubuntu-latest", files: "" }, { os: "macos-latest", files: "server/a.test.ts" }]) {
      expect(interpolate(run.env!.OMB_VITEST_FIRST_SHARD_SECONDS, { matrix })).toBe("0");
    }
    const units = (workflow.jobs.vitest.steps as { name?: string; if?: string; run?: string; "timeout-minutes"?: number }[]).find((step) => step.name === "Electron unit tests")!;
    expect(units["timeout-minutes"]).toBe(5);
    expect(units.run).toBe("pnpm test:electron");
    expect(units.if).toBe("matrix.node_tests");
    expect(workflow.jobs.vitest.steps.indexOf(units)).toBeLessThan(workflow.jobs.vitest.steps.indexOf(run));
    expect(workflow.jobs["control-plane"].steps.filter((step: { run?: string }) => step.run === "pnpm broker:test")).toHaveLength(1);
    expect(workflow.jobs.vitest.steps.some((step: { run?: string }) => step.run?.includes("broker:test"))).toBe(false);
    expect(workflow.jobs["browser-identity"].strategy.matrix.os).toBe("${{ fromJSON(needs.static.outputs.vitest_os) }}");
    expect(workflow.jobs["browser-driver"].strategy.matrix.os).toBe("${{ fromJSON(needs.static.outputs.vitest_os) }}");
    expect(workflow.jobs["packaged-server"]).toBeUndefined();
  });

  it("keeps the ordinary PR fast selection on Ubuntu and the packaged smoke in macOS full", () => {
    const ordinary = ciOutputs({ checks: ["build"] }, LINUX_OS);
    expect(ordinary.jobs).toEqual([]);
    expect(ordinary.vitest_os).toEqual(["ubuntu-latest"]);
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
    const modules = new Set(["scripts/release-ci.mjs"]);
    for (const file of modules) {
      for (const [, path] of readFileSync(file, "utf8").matchAll(/^import .* from "(\.[^"]+)";$/gm)) {
        modules.add(posix.normalize(`${posix.dirname(file)}/${path}`));
      }
    }
    expect(modules).toContain("scripts/ci-integration.mjs");
    expect(sparse.sort()).toEqual([...modules].sort());
  });

  it("builds the Windows Defender check's installer without coupling release.yml to Windows packaging", () => {
    const pkgWin = parse(readFileSync(new URL("../.github/workflows/package-win.yml", import.meta.url), "utf8"));
    const check = parse(readFileSync(new URL("../.github/workflows/windows-defender-check.yml", import.meta.url), "utf8"));
    type Step = { uses?: string; with?: unknown; run?: string; shell?: string };
    const toolchainToInstaller = (steps: Step[]) => steps.slice(1, steps.findIndex((step) => step.run === "pnpm package:win") + 1)
      .map(({ uses, with: inputs, run, shell }) => ({ uses, with: inputs, run, shell }));
    expect(toolchainToInstaller(check.jobs.check.steps).at(-1)?.run).toBe("pnpm package:win");
    expect(toolchainToInstaller(check.jobs.check.steps)).toEqual(toolchainToInstaller(pkgWin.jobs.package.steps));
    expect(check.jobs.check["runs-on"]).toBe(pkgWin.jobs.package["runs-on"]);
  });

  it("keeps desktop release packaging macOS-only while retaining CI gating, feeds, and tag dispatches", () => {
    const release = parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
    expect(Object.keys(release.jobs)).toEqual(["prepare", "ci", "mac", "assemble"]);
    expect(release.jobs.assemble.needs).toEqual(["prepare", "ci", "mac"]);
    expect(Object.keys(release.on.workflow_dispatch.inputs)).toEqual(["ref", "publish", "ship_without_ci"]);
    const requiredStep = release.jobs.assemble.steps.find((step: { name?: string }) => step.name === "Refuse an incomplete installer or updater set");
    expect(requiredStep.run).toContain("latest-mac.yml");
    expect(requiredStep.run).toContain("mymausbot-intel.dmg");
    expect(requiredStep.run).toContain("mymausbot.dmg");
    for (const removed of ["latest.yml", "latest-linux.yml", "setup.exe", "amd64.deb", "AppImage", "SHA256SUMS-ubuntu-x64.txt"]) {
      expect(requiredStep.run).not.toContain(removed);
    }
    const feedStep = release.jobs.assemble.steps.find((step: { name?: string }) => step.name === "Verify every feed hash against the actual bytes");
    expect(feedStep.run).toContain("latest-mac.yml");
    expect(feedStep.run).not.toContain("latest.yml");
    expect(feedStep.run).not.toContain("latest-linux.yml");
    const publishStep = release.jobs.assemble.steps.find((step: { name?: string }) => step.name === "Publish (only when asked to)");
    expect(publishStep.run).toContain("npm-package.yml docker.yml connector-release.yml");
    const keychainStep = release.jobs.mac.steps.find((step: { name?: string }) => step.name === "Import the Developer ID certificate into a throwaway keychain");
    expect(keychainStep.run).toContain('KEYCHAIN="$RUNNER_TEMP/release.keychain-db"');
    expect(keychainStep.run).toContain("security import");
    expect(keychainStep.run).toContain("security set-key-partition-list");
    expect(keychainStep.run).toContain("printf 'CSC_KEYCHAIN=%s\\n' \"$KEYCHAIN\" >> \"$GITHUB_ENV\"");
    expect(keychainStep.run).not.toContain("list-keychains");
    expect(keychainStep.run).not.toContain("login.keychain");
    const rawRelease = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(rawRelease).not.toContain("list-keychains");
    expect(rawRelease).not.toContain("login.keychain");
    const macGateStep = release.jobs.mac.steps.find((step: { name?: string }) => step.name === "Gate: the signature must verify BEFORE notarization");
    expect(macGateStep.run).toContain("release/mac-arm64/mymausbot.app");
    expect(macGateStep.run).toContain("release/mac/mymausbot.app");
    expect(macGateStep.run).toContain("codesign --verify --deep --strict");
    const notarizeStep = release.jobs.mac.steps.find((step: { name?: string }) => step.name === "Notarize all four artifacts");
    expect(notarizeStep.run).toContain("xcrun notarytool");
    const readmeTop = readFileSync(new URL("../README.md", import.meta.url), "utf8").split("## Why")[0];
    expect(readmeTop).toContain("MashellHan/mymausbot/releases/latest/download/mymausbot.dmg");
    expect(readmeTop).toContain("MashellHan/mymausbot/releases/latest/download/mymausbot-intel.dmg");
    expect(readmeTop).not.toContain("mymausbot-setup.exe");
    expect(readmeTop).not.toContain("mymausbot-amd64.deb");
  });

  it("lets scope read main CI baseline evidence and live issue labels without any write permission", () => {
    expect(workflow.jobs.static.permissions).toEqual({ contents: "read", actions: "read", issues: "read" });
    const scope = workflow.jobs.static.steps.find((step: { id?: string }) => step.id === "scope");
    expect(scope.env).toEqual({ GH_TOKEN: "${{ github.token }}", MAUSBOT_CI_MODE: "${{ vars.MAUSBOT_CI_MODE }}", OMB_CI_EXECUTION_BINDING: "1" });
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

  it("checks all FOSS projects fresh and sequentially within one bounded macOS heap", () => {
    const foss = workflow.jobs.foss;
    const steps = foss.steps as Step[];
    const removed = steps.findIndex((step) => step.name === "Delete the enterprise folder");
    const checked = steps.findIndex((step) => step.name === "pnpm typecheck");
    const tested = steps.findIndex((step) => step.run?.startsWith("pnpm exec vitest run server/enterprise.test.ts"));
    expect(foss["runs-on"]).toBe("macos-latest");
    expect(removed).toBeGreaterThan(-1);
    expect(checked).toBeGreaterThan(removed);
    expect(tested).toBeGreaterThan(checked);
    expect(steps[checked]!.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=4096" });
    expect(steps[checked]!.run!.trim().split("\n")).toEqual([
      "pnpm typecheck --project ui --fresh",
      "pnpm typecheck --project server --fresh",
      "pnpm typecheck --project phone-protocol --fresh",
    ]);
    expect(steps[checked]).not.toHaveProperty("continue-on-error");
    expect(workflow.jobs.static.steps.some((step: Step) => step.run === "pnpm typecheck")).toBe(true);
    const contract = expectedJobs().find((item) => item.id === "foss")!;
    const job = { name: contract.name, status: "completed", conclusion: "success", steps: steps.map((step) => ({
      name: step.name ?? `Run ${step.run}`, conclusion: "success",
    })) };
    expect(executionComplete([contract], [job], new Set([contract.artifact]))).toBe(true);
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
    expect(fast.if).toBe("steps.scope.outputs.fast_pr == 'true' || steps.scope.outputs.focused_push == 'true'");
    expect(fast.run).toBe("mkdir -p qa-results\nnode scripts/testing/fast-static-overlap.mjs run\n");
    expect(fast.env).toMatchObject({ OMB_VITEST_E2E: "all", OMB_VITEST_WORKERS: 4,
      OMB_VITEST_RETRY_LOG: "${{ github.workspace }}/qa-results/vitest-retries.jsonl",
      OMB_VITEST_SUBSET: "${{ steps.scope.outputs.fast_files }}", OMB_FAST_TYPECHECK: "${{ steps.scope.outputs.build }}" });
    expect(steps[steps.indexOf(fast) + 1]?.with?.name).toContain("'focused' || 'fast'");
    const generated = steps.find((step) => step.name === "Validate generated Settings places")!;
    expect(generated).toMatchObject({ if: "steps.scope.outputs.settings_places == 'true'", run: "pnpm exec vitest run src/components/settings/settings-places.test.ts" });
    expect(steps.indexOf(generated)).toBeLessThan(steps.indexOf(fast));
    const result = steps.find((step) => step.name === "pnpm typecheck (parallel result)")!;
    expect(result.if).toContain("steps.fast.outcome");
    expect(result.run).toBe("node scripts/testing/fast-static-overlap.mjs typecheck-result");
    const contracts = steps.find((step) => step.name === "Verify CI selection and documentation references")!;
    expect(contracts.run).toContain("scripts/ci-scope.test.ts scripts/ci-workflow.test.ts");
    expect(contracts.run).toContain("scripts/qa/*.test.ts scripts/release-ci.test.ts");
    expect(steps.indexOf(result)).toBeLessThan(steps.indexOf(contracts));
    expect(steps.indexOf(steps.find((step) => step.run === "pnpm typecheck")!)).toBeLessThan(steps.indexOf(contracts));
    expect(workflow.jobs.gate.steps.at(-1).env.OMB_CI_EXECUTION_BINDING).toBe("1");
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
        // The required control-plane dependency checked and tested this exact checkout.
        const runs = rest.map((step) => step.run);
        expect(runs).not.toContain("pnpm broker:check");
        expect(runs).not.toContain("pnpm broker:test");
        const checked = workflow.jobs["control-plane"].steps.map((step: { run?: string }) => step.run);
        expect(checked).toContain("pnpm broker:check");
        expect(checked).toContain("pnpm broker:test");
        expect(checked.indexOf("pnpm broker:check")).toBeLessThan(checked.indexOf("pnpm broker:test"));
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

describe("trusted CI follow-up", () => {
  const listener = parse(readFileSync(".github/workflows/qa-report.yml", "utf8"));
  const repository = "o/r";
  const jobs = (event_name: string, event: Parameters<typeof evaluate>[1], ref = "refs/heads/main") =>
    Object.entries(listener.jobs).filter(([, job]) => evaluate((job as { if: string }).if, { github: { event_name, event, repository, ref } }))
      .map(([name]) => name);
  const sha = "d26942a074c92528f2be9c8f56c516c8112310e3";
  const completion = (event: string, conclusion = "success", run_attempt = 1, repo = repository, head_branch = "main", display_title = "Merge pull request #1083") => ({
    workflow_run: { event, conclusion, run_attempt, head_branch, head_sha: sha, path: ".github/workflows/ci.yml", display_title, head_repository: { full_name: repo } },
  });

  it("uses one completion listener, one full schedule, and no contributor or Boat automation", () => {
    const directory = ".github/workflows";
    const listeners = readdirSync(directory).filter((file) => file.endsWith(".yml")).filter((file) =>
      parse(readFileSync(`${directory}/${file}`, "utf8")).on?.workflow_run?.workflows?.includes("CI"));
    expect(listeners).toEqual(["qa-report.yml"]);
    expect(listener.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"] });
    expect(listener.on.schedule).toBeUndefined();
    expect(workflow.on.schedule).toEqual([{ cron: "0 21 * * *" }]);
    expect(existsSync(`${directory}/contributors.yml`)).toBe(false);
    expect(workflow.jobs.static).toMatchObject({ name: "typecheck + lint", "runs-on": "ubuntu-latest", "timeout-minutes": 15 });
    expect(readFileSync(`${directory}/ci.yml`, "utf8")).not.toMatch(/BOAT_CI|boat-xlarge|linux_lanes/);
  });

  it("reports trusted main, scans only the scheduled or manual path, and rechecks only eligible failures", () => {
    expect(jobs("workflow_run", completion("pull_request"))).toEqual([]);
    expect(jobs("workflow_run", completion("pull_request", "failure"))).toEqual(["reconcile", "recover"]);
    expect(jobs("workflow_run", completion("pull_request", "failure", 4))).toEqual(["reconcile"]);
    expect(jobs("workflow_run", completion("pull_request", "failure", 1, "fork/r"))).toEqual([]);
    expect(jobs("workflow_run", completion("push"))).toEqual(["report"]);
    const marker = interpolate(workflow["run-name"], { github: { event_name: "push", sha } });
    expect(marker).toBe(`Focused main integration ${sha}`);
    for (const conclusion of ["success", "failure", "cancelled"]) {
      expect(jobs("workflow_run", completion("push", conclusion, 1, repository, "main", String(marker)))).toEqual([]);
    }
    expect(jobs("workflow_run", completion("push", "success", 1, repository, "main", `Focused main integration ${"f".repeat(40)}`))).toEqual(["report"]);
    expect(interpolate(workflow["run-name"], { github: { event_name: "schedule", sha } })).toBe("");
    expect(jobs("workflow_run", completion("schedule"))).toEqual(["scan", "report"]);
    expect(jobs("workflow_run", completion("schedule", "success", 1, "fork/r"))).toEqual([]);
    expect(jobs("workflow_run", completion("workflow_dispatch", "success", 1, repository, "release-ci/v1"))).toEqual([]);
    expect(jobs("workflow_dispatch", {})).toEqual(["scan", "report"]);
    expect(jobs("workflow_dispatch", {}, "refs/heads/topic")).toEqual([]);
  });

  it("retains real QA hold release events and scoped trusted-main permissions", () => {
    expect(interpolate(listener["run-name"], { github: { event: { issue: { number: 88 } } } })).toBe("QA report hold-88");
    expect(interpolate(listener["run-name"], { github: { event: { workflow_run: { id: 44657511451 } } } })).toBe("QA report 44657511451");
    expect(interpolate(listener["run-name"], { inputs: { run_id: "44657511451" } })).toBe("QA report 44657511451");
    const issue = { labels: [{ name: "qa" }] };
    expect(jobs("issues", { action: "closed", issue })).toEqual(["reconcile"]);
    expect(jobs("issues", { action: "labeled", issue, label: { name: "qa:scope:usage" } })).toEqual(["reconcile"]);
    expect(jobs("issues", { action: "unlabeled", issue: { labels: [] }, label: { name: "qa" } })).toEqual(["reconcile"]);
    expect(jobs("issues", { action: "labeled", issue, label: { name: "documentation" } })).toEqual([]);
    expect(jobs("issues", { action: "closed", issue: { labels: [{ name: "bug" }] } })).toEqual([]);
    expect(listener.permissions).toEqual({});
    for (const job of Object.values(listener.jobs) as { steps: Step[] }[]) {
      expect(job.steps[0].with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    }
  });
});
