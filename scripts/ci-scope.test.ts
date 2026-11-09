import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  ALL_OS, AREA_CHECKS, ciOutputs, FAST_AFFECTED_LIMIT, FULL_LANE_EVENTS, FULL_SCOPE, laneOf, LINUX_OS, MAIN_SCOPE, moveLinuxIntoStatic, PLATFORM_POLICY, QUEUED_SCOPE, readCheckPolicy, SELECTABLE_JOBS,
  selectCheckPlan, selectCiScope,
  pullRequestControls, selectPushScope, SRC_OUTSIDE_RENDERER, versionOnlyPackageJson, VITEST_SUBSETS, vitestMatrix, WINDOWS_LABEL, WINDOWS_OS, windowsReason,
} from "./ci-scope.mjs";
import { HOST_E2E } from "./testing/host-e2e.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
const scopeWithEventControls = ["--input-type=module", "-e", `import { runCiScope } from ${JSON.stringify(new URL("./ci-scope.mjs", import.meta.url).href)};
  await runCiScope({ fastPrEnabled: false, readPullRequest: async (pr) => ({ labels: (pr.labels ?? []).map(label => label.name), repairIds: [] }) });`];
const legacyPrScope = ["--input-type=module", "-e", `import { runCiScope } from ${JSON.stringify(new URL("./ci-scope.mjs", import.meta.url).href)};
  await runCiScope({ fastPrEnabled: false });`];
const ALL = ["macos-latest"];
const PR = ["ubuntu-latest"];
const LINUX = ["ubuntu-latest"];
const MAIN = ALL;
const SERVER_JOBS = ["vitest", "behavior-evals", "electron-smokes", "foss", "ui-smoke", "browser-identity", "browser-driver"];
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(source = "src/page.ts") {
  const directory = mkdtempSync(join(tmpdir(), "omb-ci-scope-"));
  temporaryDirectories.push(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci@example.invalid");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(directory, "scripts/testing"), { recursive: true });
  mkdirSync(join(directory, "server"), { recursive: true });
  writeFileSync(join(directory, "server/core.test.ts"), "");
  writeFileSync(join(directory, "scripts/guard.test.ts"), "");
  writeFileSync(join(directory, "scripts/testing/check-policy.json"), JSON.stringify({ version: 1, core: ["server/core.test.ts"], guards: ["scripts/guard.test.ts"], areas: [] }));
  git("add", "--", "server/core.test.ts", "scripts/guard.test.ts", "scripts/testing/check-policy.json");
  mkdirSync(dirname(join(directory, source)), { recursive: true });
  mkdirSync(join(directory, "docs"), { recursive: true });
  writeFileSync(join(directory, source), "source\n");
  git("add", "--", source);
  git("commit", "--quiet", "-m", "base");
  return { directory, git, base: git("rev-parse", "HEAD") };
}

function run(directory: string, event: string, payload: unknown) {
  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "output.txt");
  writeFileSync(eventPath, JSON.stringify(payload));
  const result = spawnSync(process.execPath, scopeWithEventControls, {
    cwd: directory,
    env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return { output: outputs(readFileSync(outputPath, "utf8")), stderr: result.stderr };
}

/** The GITHUB_OUTPUT lines ci-scope wrote, each value parsed. */
function outputs(text: string) {
  const parsed = Object.fromEntries(text.trimEnd().split("\n").map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(0, at) === "fast_files" ? line.slice(at + 1) : JSON.parse(line.slice(at + 1))];
  }));
  expect(typeof parsed.full_required).toBe("boolean");
  expect(parsed.expected_jobs).toEqual(expect.arrayContaining([expect.objectContaining({ id: "static" })]));
  expect(parsed.required_jobs.every((job: string) => parsed.jobs.includes(job))).toBe(true);
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => ["build", "jobs", "vitest_os", "packaged_server_os", "vitest_matrix", "linux_lanes", "boat_static", "platform_policy"].includes(key)));
}

const everything = () => ({ jobs: SELECTABLE_JOBS, build: true, vitest_os: ALL, packaged_server_os: [],
  vitest_matrix: vitestMatrix(ALL), platform_policy: PLATFORM_POLICY });
const staticOnly = (oses: string[], build: boolean) => ({ jobs: [], build, vitest_os: oses, packaged_server_os: [], vitest_matrix: vitestMatrix(oses) });
const MAIN_JOBS = ["vitest", "behavior-evals", "electron-smokes", "foss", "control-plane", "ui-smoke", "browser-identity"];
const mainLane = () => ({ jobs: MAIN_JOBS, build: true, vitest_os: MAIN, packaged_server_os: [],
  vitest_matrix: vitestMatrix(MAIN), platform_policy: PLATFORM_POLICY });

describe("vitest matrix", () => {
  it("gives the full lane four macOS all-E2E shards and keeps ordinary Ubuntu subset support", () => {
    const { include } = vitestMatrix(ALL);
    const count = (os: string) => include.filter((entry) => entry.os === os).length;
    expect([count("ubuntu-latest"), count("windows-latest"), count("macos-latest")]).toEqual([0, 0, 4]);
    expect(include[0]).toEqual({ os: "macos-latest", part: "all shard 1/4", shard: 1, shards: 4, files: "", e2e: "all", node_tests: true, workers: 1 });
    expect(include.filter((entry) => entry.node_tests).map((entry) => [entry.os, entry.shard]))
      .toEqual([["macos-latest", 1]]);
    expect(include.every((entry) => entry.e2e === "all")).toBe(true);
    expect(vitestMatrix(LINUX).include).toHaveLength(8);
  });

  it("keeps an ordinary PR fast scope on Ubuntu without a macOS job", () => {
    expect(ciOutputs({ checks: ["build"] }, LINUX)).toEqual(staticOnly(LINUX, true));
  });
});

const checks = (...areas: string[]) => [...new Set(areas.flatMap((area) => AREA_CHECKS[area as keyof typeof AREA_CHECKS]))].sort();

describe("CI path scope", () => {
  it("runs only the docs tests, without the build, for documentation, its evidence and the docs site", () => {
    expect(selectCiScope([
      "README.md", "AGENTS.md", "docs/guide.md", "docs/nested/guide.md", ".github/FUNDING.yml", "apps/docs/content/index.mdx",
      ".agents/team/playbook.md", ".agents/team/roles/leader.md", ".agents/team/roles/upstream.md",
      "docs/verification/evidence/mentions/rtl-dom.json", "docs/screenshots/home.png",
    ])).toEqual({ areas: ["docs"], checks: ["docs-tests"] });
  });

  it("runs a test under scripts/ wherever the suite runs, without the build", () => {
    expect(selectCiScope(["scripts/generate-locale.test.mjs", "scripts/testing/control-omb-ui.e2e.test.ts"]))
      .toEqual({ areas: ["script-tests"], checks: ["browser-identity", "host-tests", "ui-smoke"] });
  });

  it("runs the build, macOS full tests and renderer smoke for a wider renderer change", () => {
    expect(selectCiScope(["src/App.tsx", "public/icon.svg", "cloud-buy-preview.html", "src/locales/en.json", "docs/guide.md"]))
      .toEqual({ areas: ["docs", "web"], checks: ["build", "docs-tests", "host-tests", "ui-smoke"] });
  });

  it("runs the locale tests alone for translations, their tests and their hashes", () => {
    expect(selectCiScope(["src/locales/de.json", "src/locales/source-hashes.json", "src/locales/words.test.ts"]))
      .toEqual({ areas: ["locales"], checks: ["build", "locale-tests"] });
    expect(selectCiScope(["src/locales/index.ts"]).areas).toEqual(["web"]);
  });

  it.each([
    ["server/index.ts"], ["shared/types.ts"], ["companion/src/index.ts"], ["enterprise/license.ts"], ["evals/runners/run-evals.ts"],
    ["skills/pdf/SKILL.md"], ["Dockerfile"], ["deploy/podman/run.sh"],
    ...SRC_OUTSIDE_RENDERER.map((file) => [file]),
  ])("runs every check that runs the server for %j", (file) => {
    expect(selectCiScope([file])).toEqual({ areas: ["server"], checks: checks("server") });
  });

  it.each([["electron/cua.mjs"], ["electron/shared-computer-access.mjs"], ["electron/capabilities.cjs"], ["electron/screen-status.mjs"]])(
    "selects the macOS desktop contracts without retired Windows smoke for %j", (file) => {
      expect(selectCiScope([file])).toEqual({ areas: ["windows-computer-control"], checks: checks("server", "windows-computer-control") });
      expect(selectCiScope([file]).checks).not.toContain("windows-cua");
    });

  it.each([["electron/main.mjs"], ["build/icon.icns"], ["electron-builder.yml"], ["index.html"], ["rail.html"]])("runs the server's checks for the desktop's %j", (file) => {
    expect(selectCiScope([file])).toEqual({ areas: ["desktop"], checks: checks("server") });
  });

  it("runs only the control-plane job for the control plane", () => {
    expect(selectCiScope(["cloudflare/control-plane/src/index.ts"])).toEqual({ areas: ["control-plane"], checks: ["control-plane"] });
  });

  it("keeps broker-only changes on their own checked and tested job", () => {
    expect(selectCiScope(["cloudflare/composio-broker/src/index.ts"]))
      .toEqual({ areas: ["broker"], checks: ["build", "control-plane"] });
    expect(ciOutputs(selectCiScope(["cloudflare/composio-broker/src/index.ts"]), LINUX).jobs).toEqual(["control-plane"]);
  });

  it.each([["relay/src/server.ts"], ["relay/pnpm-lock.yaml"], ["relay/Dockerfile"], ["relay/deploy/Caddyfile"], ["relay/README.md"]])(
    "runs only the relay job for the relay's %j", (file) => {
      expect(selectCiScope([file])).toEqual({ areas: ["relay"], checks: ["relay"] });
    });

  it("runs the server's checks and the relay's for the shared E2E vectors, which the relay keeps a pinned copy of", () => {
    expect(selectCiScope(["companion/src/e2e/vectors/v1.json"])).toEqual({ areas: ["e2e-vectors"], checks: [...checks("server"), "relay"].sort() });
    expect(selectCiScope(["companion/src/e2e/noise.ts"])).toEqual({ areas: ["server"], checks: checks("server") });
  });

  it("selects every area's checks for a change across areas", () => {
    expect(selectCiScope(["src/App.tsx", "src/locales/de.json", "cloudflare/control-plane/src/index.ts"]))
      .toEqual({ areas: ["control-plane", "locales", "web"], checks: ["build", "control-plane", "host-tests", "locale-tests", "ui-smoke"] });
  });

  it("keeps filenames containing newlines as one path that can affect anything", () => {
    expect(selectCiScope(["src/first.md\nsecond.md"])).toEqual(FULL_SCOPE);
    expect(selectCiScope(["first\nsecond.md"])).toEqual(FULL_SCOPE);
  });

  it.each([
    [], [""], ["docs/../server/file.md"], ["./src/App.tsx"],
    [".agents/team/playbook.mjs"], [".agents/team/roles/leader.json"], [".agents/hooks/pre-push.sh"], [".agents/team/unknown.md"],
    [".agents/team/playbook.md", ".github/workflows/ci.yml"],
    [".github/workflows/ci.yml"], ["scripts/ci-scope.mjs"], ["scripts/testing/host-e2e.ts"], [".gitattributes"],
    ["package.json"], ["pnpm-lock.yaml"], ["pnpm-workspace.yaml"], ["tsconfig.json"], ["vite.config.ts"], [".oxlintrc.json"],
    ["third_party/browser/agent-browser-windows-stdio.patch"], ["scripts/testing/ci-retry-runner.ts"], ["unknown/file"], ["src/App.tsx", "package.json"],
  ])("runs everything for %j", (...files) => {
    expect(selectCiScope(files)).toEqual(FULL_SCOPE);
  });

  it("lists every check in some area and every check of an area in the full scope", () => {
    const named = new Set(Object.values(AREA_CHECKS).flat());
    for (const job of SELECTABLE_JOBS.filter((job) => job !== "vitest")) expect(named.has(job), job).toBe(true);
    for (const check of named) expect(check in VITEST_SUBSETS || FULL_SCOPE.checks.includes(check), check).toBe(true);
  });
});

describe("CI outputs", () => {
  it("runs a wider renderer change on macOS", () => {
    const out = ciOutputs(selectCiScope(["src/App.tsx"]), ALL);
    expect(out).toEqual({ jobs: ["vitest", "ui-smoke"], build: true, vitest_os: ALL, packaged_server_os: [],
      vitest_matrix: vitestMatrix(ALL), platform_policy: PLATFORM_POLICY });
  });

  it("runs a wider server change's tests and specialists on macOS", () => {
    expect(ciOutputs(selectCiScope(["server/index.ts"]), ALL)).toEqual({ jobs: SERVER_JOBS, build: true, vitest_os: ALL,
      packaged_server_os: [], vitest_matrix: vitestMatrix(ALL), platform_policy: PLATFORM_POLICY });
  });

  it("runs the locale tests in their own shards, with the Electron node tests, when no full Linux run covers them", () => {
    const out = ciOutputs(selectCiScope(["src/locales/de.json"]), PR);
    expect(out.jobs).toEqual(["vitest"]);
    expect(VITEST_SUBSETS["locale-tests"].files).toEqual([
      "src/",
      "electron/menu.test.mjs",
      "electron/updater.test.mjs",
      "scripts/generate-locale.test.mjs",
      "scripts/testing/bot-tools-ui.e2e.test.ts",
      "scripts/testing/key-readback.e2e.test.ts",
      "scripts/testing/one-workspace-ui.e2e.test.ts",
      "scripts/testing/secret-card-descriptions.test.ts",
      "scripts/testing/team-own-chat.e2e.test.ts",
      "server/body-thread-guards.e2e.test.ts",
      "server/client-notifications.e2e.test.ts",
      "server/cloud-connections.e2e.test.ts",
      "server/cloud-lending-browser.e2e.test.ts",
      "server/cloud-lending-chrome.e2e.test.ts",
      "server/cloud-lending-memory.e2e.test.ts",
      "server/cloud-lending.e2e.test.ts",
      "server/cloud-send-kinds.e2e.test.ts",
      "server/cloud-send-move.e2e.test.ts",
      "server/cloud-send-rooms.e2e.test.ts",
      "server/cloud-send-routine-merge.e2e.test.ts",
      "server/cloud-send-store.e2e.test.ts",
      "server/cloud-send.e2e.test.ts",
      "server/cloud-sync.e2e.test.ts",
      "server/cloud-team-browser.e2e.test.ts",
      "server/cloud-team-connections.e2e.test.ts",
      "server/cloud-team-engine-homes.e2e.test.ts",
      "server/cloud-team-gateway-mcp.e2e.test.ts",
      "server/cloud-team-inbox.e2e.test.ts",
      "server/cloud-team-open-reach.e2e.test.ts",
      "server/cloud-team-owners.e2e.test.ts",
      "server/cloud-team-people.e2e.test.ts",
      "server/cloud-team-phones.e2e.test.ts",
      "server/cloud-team-pictures.e2e.test.ts",
      "server/cloud-team-private.e2e.test.ts",
      "server/cloud-team-profile.e2e.test.ts",
      "server/cloud-team-requests.e2e.test.ts",
      "server/cloud-team-setup-request.e2e.test.ts",
      "server/cloud-team.e2e.test.ts",
      "server/host/brief-words.test.ts",
      "server/host/lending-lifts.test.ts",
      "server/lent-folders.e2e.test.ts",
      "server/one-home-keep.e2e.test.ts",
      "server/one-home-outdated.e2e.test.ts",
      "server/one-home-retry.e2e.test.ts",
      "server/one-home-session.e2e.test.ts",
      "server/one-home-trial-key.e2e.test.ts",
      "server/one-home-two-desks.e2e.test.ts",
      "server/one-home.e2e.test.ts",
      "server/parked-cards.e2e.test.ts",
      "server/question-cards.e2e.test.ts",
      "server/shared-computers.e2e.test.ts",
      "server/team-move.e2e.test.ts",
      "server/use-my-mac.e2e.test.ts",
      "server/workspace-banner.e2e.test.ts",
      "scripts/server-locale-plugin.test.ts",
      "server/server-lines.test.ts",
      "server/host/devs-reports.test.ts",
      "server/automation-reports.test.ts",
      "server/incidents.test.ts",
      "server/routine-run-card.test.ts",
      "server/host/chief-notices-retry.test.ts",
      "server/connector-card-text.test.ts",
      "server/host/secret-cards.test.ts",
      "server/notify.test.ts",
      "server/room-lines.test.ts",
      "server/post-to-room.test.ts",
      "server/teammate-lines.test.ts",
      "server/chat-notices.test.ts",
      "server/recall-disclosure.test.ts",
      "server/routine-cron-text.test.ts",
      "server/routine-requests.test.ts",
      "server/cloud-send-arrived.test.ts",
      "server/cloud-team-bot-access.e2e.test.ts",
      "server/cloud-team-one-answer.e2e.test.ts",
      "server/cloud-team-preference.e2e.test.ts",
      "server/cloud-team-rules.e2e.test.ts",
      "server/cloud-team-rules-running-turn.e2e.test.ts",
      "server/outside-work-threads.e2e.test.ts",
      "server/own-home.e2e.test.ts",
      "server/places-elsewhere.e2e.test.ts",
      "server/question-routing.e2e.test.ts",
      "server/team-protocol.e2e.test.ts",
      "server/team-small-fixes.e2e.test.ts",
      "server/team-mausbot-followup.e2e.test.ts",
      "server/team-no-ai.e2e.test.ts",
      "server/team-refused-handoff.e2e.test.ts",
      "server/two-places.e2e.test.ts",
      "scripts/ci-workflow.test.ts",
      "scripts/pre-push-check.test.ts",
      "server/host/wait-words.test.ts",
      "server/place-inbox.e2e.test.ts",
      "server/bot-api-team.e2e.test.ts",
      "server/cloud-team-first-look.e2e.test.ts",
      "server/cloud-team-mausbot-own-chat.e2e.test.ts",
      "server/connector-stayed.e2e.test.ts",
      "server/email/host.test.ts",
      "server/host/outside-lineage.test.ts",
      "server/memory-move.test.ts",
      "server/outside-lineage.e2e.test.ts",
      "server/same-name-mentions.e2e.test.ts",
      "server/skill-switch.test.ts",
    ]);
    expect(out.vitest_matrix.include).toEqual([1, 2].map((shard) => ({
      os: "ubuntu-latest", part: `locale tests ${shard}/2`, shard, shards: 2,
      files: VITEST_SUBSETS["locale-tests"].files.join(" "), e2e: "all", node_tests: shard === 1, workers: 4,
    })));
    expect(ciOutputs(selectCiScope(["src/locales/de.json", "src/App.tsx"]), ALL).vitest_matrix).toEqual(vitestMatrix(ALL));
  });

  it("runs the docs tests in one job for docs, and skips the build", () => {
    const out = ciOutputs(selectCiScope(["docs/analytics.md"]), PR);
    expect(out).toMatchObject({ jobs: ["vitest"] });
    expect(out.vitest_matrix.include).toEqual([{
      os: "ubuntu-latest", part: "docs tests", shard: 1, shards: 1, files: VITEST_SUBSETS["docs-tests"].files.join(" "), e2e: "all", node_tests: false, workers: 4,
    }]);
    expect(ciOutputs(selectCiScope(["docs/analytics.md", "src/locales/de.json"]), PR).vitest_matrix.include.map((entry: { part: string }) => entry.part))
      .toEqual(["locale tests 1/2", "locale tests 2/2", "docs tests"]);
  });

  it("skips the build and every job when nothing is selected, keeping a full matrix for the skipped vitest job", () => {
    expect(ciOutputs({ checks: [] }, PR)).toEqual(staticOnly(PR, false));
  });

  it("runs every job, on every platform the event covers, for the full scope", () => {
    expect(ciOutputs(FULL_SCOPE, ALL)).toEqual(everything(ALL));
    expect(() => ciOutputs(FULL_SCOPE, PR)).toThrow("Retired full test platform");
  });

  it("puts all portable and host E2E files in macOS full shards", () => {
    const shards = ciOutputs({ checks: ["host-tests"] }, ALL).vitest_matrix.include;
    expect(shards).toHaveLength(4);
    expect(shards.every((entry: { os: string; e2e: string }) => entry.os === "macos-latest" && entry.e2e === "all")).toBe(true);
  });

  it("runs the macOS full shards and applicable specialist jobs for main", () => {
    const out = ciOutputs(MAIN_SCOPE, MAIN);
    expect(out).toEqual(mainLane());
    expect(out.vitest_matrix.include.map((entry: { os: string }) => entry.os)).toEqual(Array(4).fill("macos-latest"));
    expect(out.packaged_server_os).toEqual([]);
    for (const job of ["windows-cua", "package-linux", "browser-driver", "cloudflared-linux-arm64"]) expect(out.jobs, job).not.toContain(job);
    expect(MAIN_SCOPE.checks.every((check) => FULL_SCOPE.checks.includes(check))).toBe(true);
  });

  it("rejects a retired full platform while preserving Ubuntu ordinary selections", () => {
    expect(() => ciOutputs(FULL_SCOPE, LINUX)).toThrow("Retired full test platform");
    expect(() => ciOutputs(FULL_SCOPE, WINDOWS_OS)).toThrow("Retired full test platform");
    expect(ciOutputs({ checks: ["docs-tests"] }, LINUX).vitest_os).toEqual(LINUX);
    expect(LINUX_OS).toEqual(LINUX);
    expect(WINDOWS_OS).toEqual(["ubuntu-latest", "windows-latest"]);
  });

  it("runs only the broker's control-plane checks for a commit the merge queue already tested", () => {
    expect(ciOutputs(QUEUED_SCOPE, MAIN)).toEqual({ ...staticOnly(MAIN, false), jobs: ["control-plane"] });
  });

  it("names each event's lane: pull request, main and full macOS", () => {
    expect(laneOf("pull_request")).toBe("pr");
    expect(laneOf("push")).toBe("main");
    expect(laneOf("merge_group")).toBe("main");
    for (const event of FULL_LANE_EVENTS) expect(laneOf(event), event).toBe("full");
    expect(FULL_LANE_EVENTS).toEqual(["schedule", "workflow_dispatch"]);
    expect(ALL_OS).toEqual(ALL);
  });
});

describe("Boat static and ordinary Ubuntu subsets", () => {
  it("keeps full Mac work in its jobs when static runs on Boat", () => {
    const out = moveLinuxIntoStatic(ciOutputs(FULL_SCOPE, ALL));
    expect(out).toEqual({ ...everything(ALL), boat_static: true });
    expect(out.linux_lanes).toBeUndefined();
  });

  it("keeps macOS main behavior evals and full shards outside Boat static", () => {
    const out = moveLinuxIntoStatic(ciOutputs(MAIN_SCOPE, MAIN));
    expect(out.jobs).toEqual(MAIN_JOBS);
    expect(out.boat_static).toBe(true);
  });

  it("runs a docs or translation change's subset there, and nothing when nothing is selected", () => {
    const docs = moveLinuxIntoStatic(ciOutputs({ checks: ["docs-tests"] }, LINUX));
    expect(docs.jobs).toEqual([]);
    expect(docs.linux_lanes).toEqual({ vitest: ciOutputs({ checks: ["docs-tests"] }, LINUX).vitest_matrix.include, evals: false, packaged_server: false });
    expect(moveLinuxIntoStatic(ciOutputs({ checks: [] }, LINUX))).toEqual({ ...staticOnly(LINUX, false), boat_static: true });
  });

  it("keeps selected Mac work outside Boat static in a wider PR", () => {
    const { directory, git, base } = fixture("src/App.tsx");
    writeFileSync(join(directory, "src/App.tsx"), "changed\n");
    git("commit", "--quiet", "-am", "renderer");
    const eventPath = join(directory, "event.json");
    const outputPath = join(directory, "output.txt");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } } }));
    const result = spawnSync(process.execPath, scopeWithEventControls, {
      cwd: directory, encoding: "utf8", timeout: 5_000,
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, OMB_CI_LINUX_IN_STATIC: "true" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(outputs(readFileSync(outputPath, "utf8"))).toEqual(moveLinuxIntoStatic(ciOutputs(selectCiScope(["src/App.tsx"]), ALL)));
    expect(result.stdout).not.toContain("Linux vitest lane");
  });
});

describe("Windows on a pull request", () => {
  const reason = (files: string[], lines: string[] = [], labels: string[] = []) =>
    windowsReason({ files, labels, hostE2e: Object.keys(HOST_E2E), lines: () => lines });

  it("runs for the windows label whatever changed", () => {
    expect(WINDOWS_LABEL).toBe("windows");
    expect(reason(["docs/guide.md"], [], ["bug", "windows"])).toBe('the "windows" label');
    expect(reason(["server/index.ts"], [], ["Windows-ish"])).toBeNull();
  });

  it.each([
    "electron/main.mjs", "build/installer.nsh", "electron-builder.yml", "maus.ps1", "scripts/build-cua-win.mjs",
    "scripts/smoke-cua-win-embedded.mjs", "server/win32-paths.ts", "server/shell/windows.ts", "server/foo.win32.test.ts",
    ".github/workflows/package-win.yml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".gitattributes", "vite.config.ts",
    "third_party/browser/agent-browser-windows-stdio.patch", ".github/workflows/ci.yml", "scripts/ci-scope.mjs",
    "scripts/testing/host-e2e.ts", "scripts/testing/vitest-shard-weights.json", "server/testing/host-timeout.ts",
    "scripts/prepare-cloudflared.mjs", "scripts/after-pack.mjs", ...Object.keys(HOST_E2E),
  ])("runs for %s", (file) => {
    expect(reason(["src/App.tsx", file])).toBe(file);
  });

  it.each([
    "server/index.ts", "src/components/WindowFrame.tsx", "server/darwin.ts", "server/twin.ts", "scripts/verify-sidebar.ts",
    "scripts/testing/rail-preview.tsx", "scripts/control-omb.ts", ".github/workflows/boat.yml", "tsconfig.json", "server/delta-context.e2e.test.ts",
  ])("waits for main for %s alone", (file) => {
    expect(reason([file])).toBeNull();
  });

  it.each([
    ['+  if (process.platform === "win32") return;'], ["-  // Windows keeps a running process's folder"], ["+  const shell = \"powershell.exe\";"],
    ["+  join(env.USERPROFILE, x)"], ["+  spawn(cmd, args, { windowsHide: true })"], ["+  path.win32.join(a, b)"], ["+    runs-on: windows-latest"],
  ])("runs for a changed line %j", (line) => {
    expect(reason(["server/index.ts"], ["diff --git a/server/index.ts b/server/index.ts", line])).toBe(`the changed line ${JSON.stringify(line)}`);
  });

  it("reads only added and removed lines, not file headers or a window", () => {
    expect(reason(["server/index.ts"], [
      "--- a/server/Windows.ts", "+++ b/server/Windows.ts", "@@ -1 +1 @@ Windows", " Windows context", "+const frame = window.open(url);",
      "-  new BrowserWindow()", "+// two windows side by side",
    ])).toBeNull();
  });

  it("reads the lines only when no label or path decided, and runs Windows when they cannot be read", () => {
    const unread = () => { throw new Error("diff too large"); };
    expect(windowsReason({ files: ["electron/main.mjs"], lines: unread })).toBe("electron/main.mjs");
    expect(windowsReason({ files: ["server/index.ts"], lines: unread })).toBe("a change whose lines could not be read (diff too large)");
  });
});

/** Relative imports, `@/` included, that load code when run; `import type` loads nothing. */
const IMPORT = /(?:^|[^\w$.])(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']|(?:^|[^\w$.])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/gm;
const CODE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|node-test)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|testing|fixtures)\//;

function codeFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? codeFiles(path) : CODE.test(entry.name) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string) {
  const base = (specifier.startsWith("@/") ? join(ROOT, "src", specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null)
    ?.replace(/\?.*$/, "");
  if (!base) return null;
  const candidates = [base, base.replace(/\.js$/, ".ts"), ...["ts", "tsx", "mjs", "cjs", "js"].map((extension) => `${base}.${extension}`),
    ...["ts", "tsx", "js"].map((extension) => join(base, `index.${extension}`))];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const importsOf = new Map<string, string[]>();
function imports(file: string) {
  if (!importsOf.has(file)) {
    importsOf.set(file, CODE.test(file)
      ? [...readFileSync(file, "utf8").matchAll(IMPORT)].flatMap((match) => resolveImport(file, match[1] ?? match[2]) ?? [])
      : []);
  }
  return importsOf.get(file)!;
}

/** Every repository file the given files load, transitively, themselves included. */
function importClosure(entries: string[]) {
  const seen = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    pending.push(...imports(file).filter((target) => !seen.has(target)));
  }
  return [...seen].map((file) => relative(ROOT, file).split("\\").join("/"));
}

describe("the repository's import graph", () => {
  it("lists every renderer file the server, Electron, the companion, evals, the workers or the macOS frame smoke load", () => {
    const frameSmoke = readFileSync(join(ROOT, "scripts/smoke-app-frames.mjs"), "utf8");
    expect(frameSmoke).toContain('resolveDir: join(ROOT, "src/components/app")');
    expect(frameSmoke).toContain("from \\\"./app-frame-host.ts\\\"");
    const runtime = ["server", "shared", "electron", "companion", "enterprise", "evals", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)))
      .filter((file) => !TEST_FILE.test(relative(ROOT, file).split("\\").join("/")));
    expect(runtime.length).toBeGreaterThan(500);
    // The language packs the server reads its lines from stay locale changes (SRC_OUTSIDE_RENDERER says why).
    const loaded = importClosure([...runtime, join(ROOT, "src/components/app/app-frame-host.ts")])
      .filter((file) => file.startsWith("src/") && !/^src\/locales\/[^/]+\.json$/.test(file));
    expect(loaded.sort()).toEqual([...SRC_OUTSIDE_RENDERER].sort());
  });

  it("runs every test outside the renderer that reads a translation other than English with the locale tests", () => {
    const files = ["server", "shared", "electron", "companion", "enterprise", "evals", "scripts", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)))
      // The selection names the catalogs without reading them.
      .filter((file) => !/[/\\]ci-scope\.(?:mjs|test\.ts)$/.test(file));
    const mentionsTranslations = (file: string) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/locales/g)].some((match) => !/^locales\W{1,6}en\.json/.test(text.slice(match.index, match.index + 24)));
    };
    const readers = new Set(files.filter(mentionsTranslations));
    const affected = files
      .filter((file) => /\.test\.[cm]?[jt]s$/.test(file))
      .filter((file) => importClosure([file]).some((loaded) => /^src\/locales\/(?!en\.json$)/.test(loaded) || readers.has(join(ROOT, loaded))))
      .map((file) => relative(ROOT, file).split("\\").join("/"));
    expect(affected).toContain("scripts/generate-locale.test.mjs");
    expect(affected).toContain("server/host/brief-words.test.ts");
    // The Electron node tests, which compare their own copy of some strings with every catalog, run on the locale tests' first shard.
    expect(affected.filter((file) => !VITEST_SUBSETS["locale-tests"].files.some((filter) => file.includes(filter)))).toEqual([]);
  });

  it("runs every test that reads the docs with the docs tests or in static", () => {
    const ci = parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"));
    const inStatic = (ci.jobs.static.steps as { run?: string }[]).flatMap((step) => step.run?.startsWith("pnpm exec vitest run ") ? step.run.split(" ").slice(4) : []);
    expect(inStatic).toContain("scripts/testing/verification-docs.test.ts");
    // A docs path a test reads from the repository root: join(ROOT, "docs", ...), new URL("docs/...", ROOT) or read("docs/...").
    const DOCS_READ = /(?:(?:join|resolve)\(\s*ROOT\s*,\s*|new URL\(\s*|\bread\w*\(\s*)["'`]((?:apps\/docs|docs)\b[^"'`]*|[A-Z][A-Z_]+\.md)["'`]/g;
    const readers = ["server", "shared", "electron", "companion", "enterprise", "evals", "scripts", "src", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)))
      .filter((file) => /\.(?:test|node-test)\.[cm]?[jt]sx?$/.test(file) && !file.endsWith("ci-scope.test.ts"))
      .filter((file) => [...readFileSync(file, "utf8").replace(/(["'`])\s*,\s*(["'`])/g, "/").matchAll(DOCS_READ)]
        .some((match) => existsSync(join(ROOT, match[1]))))
      .map((file) => relative(ROOT, file).split("\\").join("/"))
      .sort();
    expect(readers).toEqual([...VITEST_SUBSETS["docs-tests"].files, ...inStatic.filter((file) => file === "scripts/testing/verification-docs.test.ts")].sort());
  });

  it("never loads a test file from other code, so a test under scripts/ affects only the jobs that run it", () => {
    const code = ["server", "shared", "electron", "companion", "enterprise", "evals", "scripts", "src", "cloudflare"]
      .flatMap((directory) => codeFiles(join(ROOT, directory)));
    const loaders = code.filter((file) => imports(file).some((target) => /\.test\.[cm]?[jt]sx?$/.test(target)));
    expect(loaders.map((file) => relative(ROOT, file))).toEqual([]);
  });
});

describe("CI scope CLI", () => {
  it.each(["docs/guide.md", ".agents/team/playbook.md", ".agents/team/roles/leader.md"])("runs only the docs tests for a PR changing %s", (source) => {
    const { directory, git, base } = fixture(source);
    writeFileSync(join(directory, source), "updated guide\n");
    git("commit", "--quiet", "-am", "docs");
    const { output, stderr } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toEqual(ciOutputs({ checks: ["docs-tests"] }, LINUX));
    expect(output).toMatchObject({ jobs: ["vitest"] });
    expect(stderr).toBe("");
  });

  it("ignores base-only server changes after the pull request diverges", () => {
    const { directory, git, base: common } = fixture("server/original.ts");
    writeFileSync(join(directory, "server/original.ts"), "base-only change\n");
    git("commit", "--quiet", "-am", "base change");
    const base = git("rev-parse", "HEAD");
    git("checkout", "--quiet", "--detach", common);
    writeFileSync(join(directory, "docs/guide.md"), "PR-only guide\n");
    git("add", "--", "docs/guide.md");
    git("commit", "--quiet", "-m", "PR docs");
    const { output, stderr } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toEqual(ciOutputs({ checks: ["docs-tests"] }, LINUX));
    expect(output).toMatchObject({ jobs: ["vitest"] });
    expect(stderr).toBe("");
  });

  it.each(["delete", "rename"])("retains the original source path on %s", (change) => {
    const source = "server/original.ts";
    const { directory, git, base } = fixture(source);
    if (change === "delete") git("rm", "--", source);
    else git("mv", "--", source, "docs/renamed.md");
    git("commit", "--quiet", "-m", change);
    const { output, stderr } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toEqual(ciOutputs(selectCiScope([source]), ALL));
    expect(stderr).toBe("");
  });

  it("runs wider renderer work on macOS and translation subsets on Ubuntu", () => {
    for (const [source, jobs, oses] of [["src/App.tsx", ["vitest", "ui-smoke"], ALL], ["src/locales/de.json", ["vitest"], []]] as const) {
      const { directory, git, base } = fixture(source);
      writeFileSync(join(directory, source), "changed\n");
      git("commit", "--quiet", "-am", "change");
      const { output, stderr } = run(directory, "pull_request", {
        pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
      });
      expect(output).toEqual(ciOutputs(selectCiScope([source]), source === "src/App.tsx" ? ALL : LINUX));
      expect(output.jobs).toEqual(jobs);
      expect(output.vitest_matrix.include.filter((entry: { files: string }) => !entry.files).map((entry: { os: string }) => entry.os))
        .toEqual(oses.flatMap((os) => Array(os === "macos-latest" ? 4 : 8).fill(os)));
      expect(stderr).toBe("");
    }
  });

  it("reads filenames with spaces without turning source into docs", () => {
    const source = "src/first second.md";
    const { directory, git, base } = fixture(source);
    writeFileSync(join(directory, source), "changed\n");
    git("commit", "--quiet", "-am", "change");
    const { output } = run(directory, "pull_request", {
      pull_request: { base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } },
    });
    expect(output).toEqual(ciOutputs({ checks: AREA_CHECKS.web }, ALL));
  });

  it.each(["missing", "invalid", "unavailable", "empty"])("falls back loudly for a %s diff", (kind) => {
    const { directory, base } = fixture();
    const payload = kind === "missing" ? {} : {
      pull_request: { base: { sha: base }, head: { sha: kind === "invalid" ? "--help" : kind === "unavailable" ? "f".repeat(40) : base } },
    };
    const { output, stderr } = run(directory, "pull_request", payload);
    expect(output).toEqual(everything(ALL));
    expect(stderr).toContain("using all checks");
  });

  it.each(["schedule", "workflow_dispatch"])("runs everything on every platform for %s", (event) => {
    const { directory } = fixture("docs/guide.md");
    expect(run(directory, event, {}).output).toEqual(everything(ALL));
  });

  it("retains main's checks for a readable docs merge group", () => {
    const { directory, git, base } = fixture("docs/guide.md");
    writeFileSync(join(directory, "docs/guide.md"), "updated\n");
    git("commit", "-qam", "docs");
    expect(run(directory, "merge_group", { merge_group: { base_sha: base, head_sha: git("rev-parse", "HEAD") } }).output).toEqual(mainLane());
  });
});

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ name: "openmausbot", private: true, version, scripts: { test: "vitest run" }, ...extra }, null, 2)}\n`;

describe("version-only package.json", () => {
  it("is only a changed top-level version", () => {
    expect(versionOnlyPackageJson(pkg("0.1.100"), pkg("0.1.101"))).toBe(true);
    // the bump writes package.json with npm pkg set; formatting is not a change
    expect(versionOnlyPackageJson(pkg("0.1.100"), JSON.stringify(JSON.parse(pkg("0.1.101"))))).toBe(true);
  });

  it.each([
    ["the same version", pkg("0.1.100"), pkg("0.1.100")],
    ["a dependency added", pkg("0.1.100"), pkg("0.1.101", { dependencies: { zod: "4" } })],
    ["a script changed", pkg("0.1.100"), pkg("0.1.101").replace("vitest run", "vitest run --bail")],
    ["a nested version changed", pkg("0.1.100", { engines: { version: "1" } }), pkg("0.1.101", { engines: { version: "2" } })],
    ["other keys reordered", pkg("0.1.100"), JSON.stringify({ private: true, name: "openmausbot", version: "0.1.101", scripts: { test: "vitest run" } })],
    ["no version before", JSON.stringify({ name: "x" }), JSON.stringify({ name: "x", version: "1.0.0" })],
    ["not JSON", "{", pkg("0.1.101")],
    ["not an object", "[]", "[]"],
  ])("is false for %s", (_, before, after) => {
    expect(versionOnlyPackageJson(before, after)).toBe(false);
  });

  it("scopes a push by its own files", () => {
    const show = (rev: string) => (rev === "before" ? pkg("0.1.100") : pkg("0.1.101"));
    expect(selectPushScope(["package.json"], show)).toEqual({ runtime: false });
    expect(selectPushScope(["docs/ci.md", "README.md"], show)).toEqual({ runtime: false });
    expect(selectPushScope(["package.json", "pnpm-lock.yaml"], show)).toEqual({ runtime: true });
    expect(selectPushScope(["package.json", "docs/ci.md"], show)).toEqual({ runtime: true });
    expect(selectPushScope(["server/index.ts"], show)).toEqual({ runtime: true });
    expect(selectPushScope(["package.json"], () => pkg("0.1.100"))).toEqual({ runtime: true });
    expect(selectPushScope(["package.json"], () => { throw new Error("missing"); })).toEqual({ runtime: true });
  });

  it("never narrows a push the way it narrows a pull request", () => {
    const show = () => pkg("0.1.100");
    for (const file of ["apps/docs/content/index.mdx", "src/locales/de.json", "src/App.tsx", "cloudflare/control-plane/src/index.ts", "server/index.ts"]) {
      expect(selectPushScope([file], show), file).toEqual({ runtime: true });
    }
    expect(selectPushScope([], show)).toEqual({ runtime: true });
  });
});

type FakeRun = { id?: number; event: string; status: string; conclusion: string | null };

/** A GitHub that answers the CI runs of one commit and the jobs of one run; the
 * script under test runs asynchronously so this server can answer it. */
async function fakeRunsApi(runs: Record<string, FakeRun[]>, jobs: Record<number, Array<{ name: string; conclusion: string | null }>> = {}) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
    const url = new URL(request.url!, "http://x");
    const sha = url.searchParams.get("head_sha") ?? "";
    const runId = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(url.pathname)?.[1];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(runId ? { jobs: jobs[Number(runId)] ?? [] } : { workflow_runs: runs[sha] ?? [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function runPush(directory: string, payload: unknown, env: Record<string, string | undefined>) {
  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "output.txt");
  writeFileSync(eventPath, JSON.stringify(payload));
  const childEnv: Record<string, string | undefined> = { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, ...env };
  for (const [key, value] of Object.entries(childEnv)) if (value === undefined) delete childEnv[key];
  const stderr = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [script], { cwd: directory, env: childEnv as NodeJS.ProcessEnv, encoding: "utf8", timeout: 10_000 },
      (error, _stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stderr)));
  });
  return { output: outputs(readFileSync(outputPath, "utf8")), stderr };
}

describe("CI scope CLI on a push to main", () => {
  function pushFixture(change: (directory: string) => void) {
    const { directory, git } = fixture("server/index.ts");
    writeFileSync(join(directory, "package.json"), pkg("0.1.100"));
    git("add", "--", "package.json");
    git("commit", "--quiet", "-m", "package");
    const before = git("rev-parse", "HEAD");
    change(directory);
    git("add", "--all");
    git("commit", "--quiet", "-m", "change");
    return { directory, before, after: git("rev-parse", "HEAD") };
  }
  const bump = (directory: string) => writeFileSync(join(directory, "package.json"), pkg("0.1.101"));
  const docs = (directory: string) => writeFileSync(join(directory, "docs/guide.md"), "guide\n");
  const code = (directory: string) => writeFileSync(join(directory, "server/index.ts"), "changed\n");
  const green = [{ event: "push", status: "completed", conclusion: "success" }];
  const runsOf = (sha: string) => `GET /repos/o/r/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100 Bearer t`;
  const github = (api: { url: string }) => ({ GITHUB_API_URL: api.url, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });

  it.each([["the version bump", bump], ["a docs-only merge", docs]])("skips the runtime jobs for %s after a green commit", async (_, change) => {
    const { directory, before, after } = pushFixture(change);
    const api = await fakeRunsApi({ [before]: [{ event: "pull_request", status: "completed", conclusion: "failure" }, ...green] });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(staticOnly(MAIN, true));
      expect(stderr).toBe("");
      expect(api.requests).toEqual([runsOf(after), runsOf(before)]);
    } finally {
      await api.close();
    }
  });

  it.each([["a code change", code, everything(ALL)], ["the version bump", bump, ciOutputs(QUEUED_SCOPE, MAIN)]])("retains postmerge coverage for %s the merge queue already passed", async (_, change, selection) => {
    const { directory, before, after } = pushFixture(change);
    // The queue lands its group's commit once the gate passes, before the run's last job has finished.
    const api = await fakeRunsApi({ [after]: [{ id: 77, event: "merge_group", status: "in_progress", conclusion: null }] }, {
      77: [{ name: "vitest (ubuntu-latest, shard 1/8)", conclusion: "success" }, { name: "CI", conclusion: "success" }],
    });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(selection);
      expect(stderr).toBe("");
    } finally {
      await api.close();
    }
  });

  it.each([
    ["failed its gate", [{ name: "CI", conclusion: "failure" }]],
    ["has not passed its gate yet", [{ name: "CI", conclusion: null }]],
  ])("runs main's checks for a commit whose merge-group run %s", async (_, gateJobs) => {
    const { directory, before, after } = pushFixture(code);
    const api = await fakeRunsApi({ [after]: [{ id: 78, event: "merge_group", status: "completed", conclusion: "failure" }] }, { 78: gateJobs });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(everything(ALL));
      expect(stderr).toBe("");
      expect(api.requests).toEqual([runsOf(after), "GET /repos/o/r/actions/runs/78/jobs?per_page=100 Bearer t"]);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["was replaced by this push", [{ event: "push", status: "completed", conclusion: "cancelled" }]],
    ["failed", [{ event: "push", status: "completed", conclusion: "failure" }]],
    ["never ran", []],
    ["only passed as a pull request", [{ event: "pull_request", status: "completed", conclusion: "success" }]],
  ])("runs main's checks for a version bump when the commit before it %s", async (_, runs) => {
    const { directory, before, after } = pushFixture(bump);
    const api = await fakeRunsApi({ [before]: runs });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(mainLane());
      expect(stderr).toContain("has no green CI run of its own");
    } finally {
      await api.close();
    }
  });

  it("runs main's checks when the pushed commit's CI cannot be read", async () => {
    const { directory, before, after } = pushFixture(bump);
    const { output, stderr } = await runPush(directory, { before, after }, { GH_TOKEN: undefined, GITHUB_REPOSITORY: undefined });
    expect(output).toEqual(mainLane());
    expect(stderr).toContain("using main's checks");
  });

  it.each([
    ["a code change", code],
    ["a version bump with a dependency", (directory: string) => writeFileSync(join(directory, "package.json"), pkg("0.1.101", { dependencies: { zod: "4" } }))],
    ["a version bump with code", (directory: string) => { bump(directory); code(directory); }],
  ])("selects main or full checks for %s without reading predecessor CI", async (kind, change) => {
    const { directory, before, after } = pushFixture(change);
    const api = await fakeRunsApi({ [before]: green });
    try {
      const { output, stderr } = await runPush(directory, { before, after }, github(api));
      expect(output).toEqual(everything(ALL));
      expect(stderr).toBe("");
      expect(api.requests).toEqual([runsOf(after)]);
    } finally {
      await api.close();
    }
  });

  it.each([
    ["a missing payload", {}],
    ["a new branch", { before: "0".repeat(40), after: "f".repeat(40) }],
    ["an unknown commit", { before: "f".repeat(40), after: "e".repeat(40) }],
  ])("falls back loudly to full checks for %s", async (_, payload) => {
    const { directory } = fixture();
    const { output, stderr } = await runPush(directory, payload, {});
    expect(output).toEqual(everything(ALL));
    expect(stderr).toContain("using all checks");
  });
});

describe("CI scope CLI on a pull request's Windows jobs", () => {
  function serverChange(content: string, file = "server/paths.ts") {
    const { directory, git, base } = fixture(file);
    writeFileSync(join(directory, file), content);
    git("commit", "--quiet", "-am", "change");
    return { directory, payload: { pull_request: { number: 7, base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } } } };
  }

  /** A GitHub that answers one pull request's labels, or fails with `status`. */
  async function fakeLabelsApi(labels: string[], status = 200) {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.authorization}`);
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(status === 200 ? { labels: labels.map((name) => ({ name })), body: "" } : { message: "nope" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { env: { GITHUB_API_URL: url, GH_TOKEN: "t", GITHUB_REPOSITORY: "o/r" }, requests, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  async function runPullRequest(directory: string, payload: unknown, env: Record<string, string> = {}, fast = false) {
    const eventPath = join(directory, "event.json");
    const outputPath = join(directory, "output.txt");
    writeFileSync(eventPath, JSON.stringify(payload));
    const localApi = env.GH_TOKEN ? null : await fakeLabelsApi([]);
    try {
      const childEnv: NodeJS.ProcessEnv = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, ...env, ...localApi?.env };
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(process.execPath, fast ? [script] : legacyPrScope, { cwd: directory, env: childEnv, encoding: "utf8", timeout: 10_000 },
          (error, out, err) => (error ? reject(new Error(`${error.message}\n${err}`)) : resolve({ stdout: out, stderr: err })));
      });
      return { output: outputs(readFileSync(outputPath, "utf8")), plan: JSON.parse(readFileSync(join(directory, "qa-plan.json"), "utf8")), stdout, stderr };
    } finally { await localApi?.close(); }
  }

  const serverJobs = () => ciOutputs(selectCiScope(["server/paths.ts"]), ALL);

  it("records the executed merge base when the PR event still names an older base", async () => {
    const { directory, git, base: eventBase } = fixture("server/paths.ts");
    git("switch", "-c", "feature");
    writeFileSync(join(directory, "server/paths.ts"), "changed source\n");
    git("commit", "--quiet", "-am", "source");
    const head = git("rev-parse", "HEAD");
    git("switch", "-c", "current-base", eventBase);
    writeFileSync(join(directory, "docs/guide.md"), "new base guidance\n");
    git("add", "--", "docs/guide.md");
    git("commit", "--quiet", "-m", "base advanced");
    const currentBase = git("rev-parse", "HEAD");
    git("merge", "--quiet", "--no-ff", "--no-edit", "feature");
    const merge = git("rev-parse", "HEAD");
    const payload = { pull_request: { number: 7, base: { sha: eventBase }, head: { sha: head } } };
    const { output, plan, stderr } = await runPullRequest(directory, payload, { OMB_CI_EXECUTION_BINDING: "1" });
    expect(stderr).toBe("");
    expect(output).toEqual(serverJobs());
    expect(plan.execution).toEqual({ merge, base: currentBase, head });
  });

  it("runs wider macOS validation for a changed line that names Windows", async () => {
    const { directory, payload } = serverChange('if (process.platform === "win32") quote();\n');
    const { output, stdout, stderr } = await runPullRequest(directory, payload);
    expect(output).toEqual(serverJobs());
    expect(stdout).toContain("CI scope: server ->");
    expect(stderr).toBe("");
  });

  it("uses the same macOS wider selection for server work without Windows text", async () => {
    const { directory, payload } = serverChange("export const greeting = \"hello\";\n");
    const { output, stdout, stderr } = await runPullRequest(directory, payload);
    expect(output).toEqual(serverJobs());
    expect(stdout).toContain("CI scope: server ->");
    expect(stderr).toBe("");
  });

  it("uses the hosted static core for an ordinary PR even when rollout is shadow", async () => {
    const { directory, payload } = serverChange("export const greeting = \"hello\";\n");
    const { output, plan, stderr } = await runPullRequest(directory, payload, { MAUSBOT_CI_MODE: "shadow" }, true);
    expect(stderr).toBe("");
    expect(output.jobs).toEqual([]);
    expect(plan.outputs).toMatchObject({ fast_pr: true, full_required: false, reduced: false, required_jobs: [], fast_files: "server/core.test.ts" });
    expect(plan.outputs.expected_jobs).toEqual([expect.objectContaining({ id: "static", fast: true, name: "typecheck + lint" })]);
    expect(plan.plan).toMatchObject({ fast: true, candidate: false, admitted: false, scope: { checks: ["build"] } });
  });

  it("selects both Room contracts for either file or their shared fixture", () => {
    const policy = readCheckPolicy();
    const fixture = "server/testing/room-coordination-fixture.ts";
    const rooms = ["server/room-coordination.e2e.test.ts", "server/room-coordination-followon.e2e.test.ts"];
    expect(policy.core).toHaveLength(26);
    expect(policy.areas.find((area) => area.id === "room-coordination"))
      .toMatchObject({ sources: [fixture, ...rooms], tests: rooms, admitted: false });
    for (const source of [fixture, ...rooms]) {
      const plan = selectCheckPlan({ files: [source], policy, fastPr: true });
      expect(plan.edit).toEqual([...rooms].sort());
      expect(plan.fastFiles).toEqual([...new Set([...policy.core, ...rooms])].sort());
      expect(plan.deferred).toEqual([]);
    }
    const combined = selectCheckPlan({
      files: [".github/workflows/ci.yml", "scripts/ci-scope.test.ts", "scripts/ci-workflow.test.ts",
        "scripts/testing/check-policy.json", fixture, ...rooms],
      policy,
      fastPr: true,
    });
    expect(combined.fastFiles).toEqual([...new Set([...policy.core, "scripts/ci-scope.test.ts", "scripts/ci-workflow.test.ts", ...rooms])].sort());
    expect(combined.fastFiles).toHaveLength(policy.core.length + FAST_AFFECTED_LIMIT);
    expect(combined.deferred).toEqual([]);
  });

  it("runs every platform for the sensitive desktop app", async () => {
    const { directory, payload } = serverChange("app\n", "electron/main.mjs");
    expect((await runPullRequest(directory, payload)).output).toEqual(everything(ALL));
  });

  it("uses current windows control to request macOS full validation", async () => {
    const { directory, payload } = serverChange("export const greeting = \"hello\";\n");
    const api = await fakeLabelsApi(["bug", "windows"]);
    try {
      const { output, stderr } = await runPullRequest(directory, payload, api.env);
      expect(output).toEqual(everything(ALL));
      expect(stderr).toBe("");
      expect(api.requests).toEqual(["GET /repos/o/r/issues/7 Bearer t"]);
    } finally {
      await api.close();
    }
  });

  it("selects full validation for upstream-sync alone and restores the normal plan after removal", async () => {
    const { directory, payload } = serverChange("export const greeting = \"hello\";\n");
    for (const [action, labels, full] of [
      ["labeled", ["upstream-sync"], true],
      ["unlabeled", [], false],
    ] as const) {
      const api = await fakeLabelsApi([...labels]);
      try {
        const event = { ...payload, action, label: { name: "upstream-sync" } };
        const { output, plan, stderr } = await runPullRequest(directory, event, api.env, true);
        expect(stderr).toBe("");
        expect(plan.outputs.full_required).toBe(full);
        expect(plan.outputs.fast_pr).toBe(!full);
        expect(plan.plan.full).toBe(full);
        expect(output.vitest_os).toEqual(full ? ALL : LINUX);
        expect(api.requests).toEqual(["GET /repos/o/r/issues/7 Bearer t"]);
      } finally { await api.close(); }
    }
  });

  it("keeps a Windows-labelled PR full when upstream-sync is removed", async () => {
    const { directory, payload } = serverChange("updated guide\n", "docs/guide.md");
    for (const [action, labels] of [
      ["labeled", ["windows", "upstream-sync"]],
      ["unlabeled", ["windows"]],
    ] as const) {
      const api = await fakeLabelsApi([...labels]);
      try {
        const event = { ...payload, action, label: { name: "upstream-sync" } };
        const { output, plan, stderr } = await runPullRequest(directory, event, api.env, true);
        expect(stderr).toBe("");
        expect(plan.outputs.fast_pr).toBe(false);
        expect(plan.plan.full).toBe(true);
        expect(plan.outputs.full_required).toBe(true);
        expect(output.vitest_os).toEqual(ALL);
        expect(api.requests).toEqual(["GET /repos/o/r/issues/7 Bearer t"]);
      } finally {
        await api.close();
      }
    }
  });

  it("requires full validation when GitHub cannot answer current PR controls", async () => {
    const { directory, payload } = serverChange("export const greeting = \"hello\";\n");
    const api = await fakeLabelsApi([], 502);
    try {
      const labelled = { pull_request: { ...payload.pull_request, labels: [{ name: "windows" }] } };
      const { output, stderr } = await runPullRequest(directory, labelled, api.env);
      expect(output).toEqual(everything(ALL));
      expect(stderr).toContain("requiring full validation because current PR controls are unavailable (HTTP 502");
    } finally {
      await api.close();
    }
  });

  it("reads force-full labels even when the change selects no Windows job", async () => {
    const { directory, git, base } = fixture("src/App.tsx");
    writeFileSync(join(directory, "src/App.tsx"), "if (navigator.platform === \"win32\") {}\n");
    git("commit", "--quiet", "-am", "renderer");
    const api = await fakeLabelsApi(["windows"]);
    try {
      const payload = { pull_request: { number: 7, base: { sha: base }, head: { sha: git("rev-parse", "HEAD") } } };
      const { output } = await runPullRequest(directory, payload, api.env);
      expect(output).toEqual(everything(ALL));
      expect(api.requests).toEqual(["GET /repos/o/r/issues/7 Bearer t"]);
    } finally {
      await api.close();
    }
  });

  it("reads repair exemptions from the current body and grants none on an unavailable snapshot", async () => {
    const pr = { number: 7, labels: [], body: "QA-Repair: #12" };
    expect(await pullRequestControls(pr, async () => ({ labels: [{ name: "qa:repair" }], body: "QA-Repair: #34" }))).toEqual({ labels: ["qa:repair"], repairIds: [34] });
    expect(await pullRequestControls(pr, async () => { throw new Error("offline"); })).toEqual({ labels: ["ci:full"], repairIds: [] });
  });
});
