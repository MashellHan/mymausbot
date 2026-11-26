#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireDesktopBuildLock } from "./local-concurrency.mjs";

export function resolveDefaultDeliveryWorktree(repo = process.cwd(), env = process.env) {
  const override = env.OMB_DELIVERY_WORKTREE?.trim();
  if (override) return resolve(override);
  const resolvedRepo = resolve(repo);
  return join(dirname(resolvedRepo), `${basename(resolvedRepo)}-desktop-delivery-worktree`);
}

export const DEFAULT_TARGET_APP = join(homedir(), "Applications", "mymausbot.app");
export const OFFICIAL_APP = "/Applications/OpenMausBot.app";
export const DEFAULT_STATE_PATH = join(homedir(), ".openmausbot", "desktop-delivery-state.json");
export const MAX_DELIVERY_BACKUPS = 3;
export const USAGE_HELPER_NAMES = [
  "refresh-local-usage.py",
  "local_usage_models.py",
  "local_usage_contributions.py",
  "local_usage_profile.py",
  "local_usage_profile_private.py",
  "local_usage_ado.py",
  "local_usage_merged.py",
  "local_usage_github.py",
  "migrate-local-contributions.py",
];
const RETAINED_WORKTREE_PATHS = ["node_modules", "dist-native", "electron/resources/OpenMausBot Speech.app"];
const FULL_BUILD_PATTERNS = [
  /^electron\//,
  /^build\//,
  /^src\/locales\/.*\.json$/,
  /^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|electron-builder\.yml|vite\.config\.ts|tsconfig[^/]*|index\.html|rail\.html)$/,
  /^(?:patches|packages|third_party)\//,
  /^scripts\/(?:after-pack\.mjs|mark-module-scope\.mjs|prepare-|cua-)/,
];
const SERVER_SCRIPT_INPUTS = new Set([
  "scripts/bundle-server.mjs",
  "scripts/server-locale-plugin.mjs",
  "scripts/desktop-server-entry.mjs",
  "scripts/mcp-server.ts",
]);
const HELPER_SCRIPT_SET = new Set(USAGE_HELPER_NAMES.map((name) => `scripts/${name}`));

export function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function isPackageJsonDependencySame(beforeText, afterText) {
  try {
    const before = JSON.parse(beforeText);
    const after = JSON.parse(afterText);
    const keys = [
      "version",
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "packageManager",
      "engines",
      "main",
    ];
    return keys.every((key) => JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null));
  } catch {
    return false;
  }
}

export function classifyDeliveryChanges(changedFiles, { packageJsonDepUnchanged = false, forceFull = false } = {}) {
  const layers = { ui: false, server: false, companion: false, skills: false, usageHelpers: false };
  if (forceFull) return { mode: "full-build", reasons: ["forced-full-build"], layers };
  if (!Array.isArray(changedFiles)) return { mode: "full-build", reasons: ["missing-diff"], layers };

  const reasons = [];
  for (const file of changedFiles) {
    if (typeof file !== "string" || !file || file.startsWith("/")) {
      reasons.push(`unsafe-path:${String(file)}`);
      continue;
    }
    if (file === "package.json") {
      if (!packageJsonDepUnchanged) reasons.push("package-json-dependencies");
      continue;
    }
    if (FULL_BUILD_PATTERNS.some((pattern) => pattern.test(file))) {
      reasons.push(`packager-input:${file}`);
      continue;
    }
    if (/^(?:src|public)\//.test(file)) {
      layers.ui = true;
    } else if (/^(?:server|enterprise|announcements)\//.test(file)) {
      layers.server = true;
    } else if (file.startsWith("shared/")) {
      layers.ui = true;
      layers.server = true;
      layers.companion = true;
    } else if (file.startsWith("companion/")) {
      layers.companion = true;
    } else if (file.startsWith("skills/")) {
      layers.skills = true;
    } else if (file.startsWith("scripts/")) {
      if (HELPER_SCRIPT_SET.has(file)) layers.usageHelpers = true;
      if (SERVER_SCRIPT_INPUTS.has(file)) layers.server = true;
    } else if (/^(?:docs\/|[^/]+\.md$)/.test(file)) {
      // Documentation changes require no runtime resource rebuild.
    } else {
      reasons.push(`unclassified-input:${file}`);
    }
  }
  return {
    mode: reasons.length === 0 ? "fast-patch" : "full-build",
    reasons: [...new Set(reasons)],
    layers,
  };
}

export function canReuseResidentWorktree({
  exists,
  hasNodeModules,
  lockfileSha,
  expectedLockfileSha,
  forceFresh = false,
}) {
  if (forceFresh) return { reuse: false, reason: "forced-fresh" };
  if (!exists) return { reuse: false, reason: "worktree-missing" };
  if (!hasNodeModules) return { reuse: false, reason: "node-modules-missing" };
  if (!lockfileSha || !expectedLockfileSha || lockfileSha !== expectedLockfileSha) {
    return { reuse: false, reason: "lockfile-hash-mismatch" };
  }
  return { reuse: true, reason: "persistent-node-modules-valid" };
}

export function buildCompilePlan({ mode, layers, skipTsc = true }) {
  const steps = [];
  if (mode === "full-build") {
    if (!skipTsc) steps.push({ name: "check-electron", cmd: "pnpm", args: ["check:electron"] });
    steps.push({ name: "build-ui", cmd: "pnpm", args: skipTsc ? ["build:ui:fast"] : ["build"] });
    steps.push({ name: "build-server", cmd: "pnpm", args: skipTsc ? ["build:server:fast"] : ["build:server"] });
    steps.push({ name: "build-companion", cmd: "pnpm", args: ["build:companion"] });
    return steps;
  }
  if (layers.ui) steps.push({ name: "build-ui", cmd: "pnpm", args: skipTsc ? ["build:ui:fast"] : ["build"] });
  if (layers.server) steps.push({ name: "build-server", cmd: "pnpm", args: skipTsc ? ["build:server:fast"] : ["build:server"] });
  if (layers.companion) steps.push({ name: "build-companion", cmd: "pnpm", args: ["build:companion"] });
  return steps;
}

export function buildOuterCodesignArgs({ appPath, entitlementsPath }) {
  return [
    "--force",
    "--sign",
    "-",
    "--entitlements",
    entitlementsPath,
    "--options",
    "runtime",
    "--timestamp=none",
    appPath,
  ];
}

export function buildCodesignVerifyArgs({ appPath }) {
  return ["--verify", "--deep", "--strict", "--verbose=2", appPath];
}

export function shouldSwitchAfterBuild({ noSwitch = false, buildOk = true } = {}) {
  return Boolean(buildOk && !noSwitch);
}

export function parseDeliveryArgs(argv) {
  let command = "deliver";
  let idx = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv[0];
    idx = 1;
  }
  const opts = {
    command,
    repo: process.cwd(),
    worktree: null,
    donor: null,
    targetRef: "origin/main",
    baseCommit: null,
    targetApp: DEFAULT_TARGET_APP,
    jobDir: null,
    statePath: DEFAULT_STATE_PATH,
    skipTsc: true,
    forceFull: false,
    forceFresh: false,
    noSwitch: false,
    dryRun: false,
    json: false,
    keepBackups: MAX_DELIVERY_BACKUPS,
  };
  for (let i = idx; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo" && argv[i + 1]) opts.repo = resolve(argv[++i]);
    else if (arg === "--worktree" && argv[i + 1]) opts.worktree = resolve(argv[++i]);
    else if (arg === "--donor" && argv[i + 1]) opts.donor = resolve(argv[++i]);
    else if (arg === "--target-ref" && argv[i + 1]) opts.targetRef = argv[++i];
    else if (arg === "--base-commit" && argv[i + 1]) opts.baseCommit = argv[++i];
    else if (arg === "--app" && argv[i + 1]) opts.targetApp = resolve(argv[++i]);
    else if (arg === "--job-dir" && argv[i + 1]) opts.jobDir = resolve(argv[++i]);
    else if (arg === "--state-file" && argv[i + 1]) opts.statePath = resolve(argv[++i]);
    else if (arg === "--keep-backups" && argv[i + 1]) opts.keepBackups = Math.max(1, Number(argv[++i]) || MAX_DELIVERY_BACKUPS);
    else if (arg === "--full-tsc") opts.skipTsc = false;
    else if (arg === "--ci-green") opts.skipTsc = true;
    else if (arg === "--force-full") opts.forceFull = true;
    else if (arg === "--fresh-worktree") opts.forceFresh = true;
    else if (arg === "--no-switch") opts.noSwitch = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.worktree) opts.worktree = resolveDefaultDeliveryWorktree(opts.repo);
  return opts;
}

function run(cmd, args, { cwd, env = process.env, timeout = 300_000 } = {}) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function gitOut(cwd, ...args) {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}

function codesignCdHash(appPath) {
  const res = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", appPath], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`codesign -d failed for ${appPath}: ${res.stderr}`);
  const line = res.stderr.split("\n").find((entry) => entry.startsWith("CDHash="));
  if (!line) throw new Error(`Missing CDHash for ${appPath}`);
  return line.slice("CDHash=".length).trim();
}

export function pruneOldDeliveryDirs(scratchDir, keep = MAX_DELIVERY_BACKUPS) {
  if (!existsSync(scratchDir)) return [];
  const entries = readdirSync(scratchDir)
    .filter((name) => /-delivery-/.test(name))
    .map((name) => {
      const fullPath = join(scratchDir, name);
      return { name, fullPath, mtimeMs: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed = [];
  for (const stale of entries.slice(keep)) {
    rmSync(stale.fullPath, { recursive: true, force: true });
    removed.push(stale.fullPath);
  }
  return removed;
}

export function resolveOsxSignPath(worktree) {
  const pnpmDir = join(worktree, "node_modules", ".pnpm");
  if (existsSync(pnpmDir)) {
    const entry = readdirSync(pnpmDir)
      .filter((name) => name.startsWith("@electron+osx-sign@"))
      .sort()
      .at(-1);
    if (entry) {
      const candidate = join(pnpmDir, entry, "node_modules", "@electron", "osx-sign");
      if (existsSync(candidate)) return candidate;
    }
  }
  const direct = join(worktree, "node_modules", "@electron", "osx-sign");
  if (existsSync(direct)) return direct;
  throw new Error(`Could not resolve @electron/osx-sign under ${worktree}`);
}

export function readElectronVersion(worktree) {
  const pkgPath = join(worktree, "node_modules", "electron", "package.json");
  if (!existsSync(pkgPath)) throw new Error(`Missing installed electron package.json at ${pkgPath}`);
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (typeof version !== "string" || !version) throw new Error(`Invalid Electron version in ${pkgPath}`);
  return version;
}

export function assertDedicatedWorktreeForReset(repo, worktree) {
  const resolvedRepo = resolve(repo);
  const resolvedWorktree = resolve(worktree);
  if (resolvedWorktree === resolvedRepo) {
    throw new Error(`Refusing destructive git clean/reset on source repo itself: ${resolvedWorktree}`);
  }
  const gitMarker = join(resolvedWorktree, ".git");
  if (!existsSync(gitMarker)) {
    throw new Error(`Refusing git clean/reset without ${gitMarker} (would target parent repository)`);
  }
  const topLevel = gitOut(resolvedWorktree, "rev-parse", "--show-toplevel");
  if (resolve(topLevel) !== resolvedWorktree) {
    throw new Error(`Refusing git clean/reset: toplevel ${topLevel} does not match worktree ${resolvedWorktree}`);
  }
}

export function syncResidentWorktree({ repo, worktree, targetCommit, donor = null, forceFresh = false }) {
  if (resolve(worktree) === resolve(repo)) {
    throw new Error(`Delivery worktree must differ from source repository: ${worktree}`);
  }
  const lockBytes = execFileSync("/usr/bin/git", ["show", `${targetCommit}:pnpm-lock.yaml`], { cwd: repo });
  const targetLockSha = createHash("sha256").update(lockBytes).digest("hex");
  const currentLockSha = existsSync(join(worktree, "pnpm-lock.yaml")) ? sha256File(join(worktree, "pnpm-lock.yaml")) : null;
  const check = canReuseResidentWorktree({
    exists: existsSync(join(worktree, ".git")),
    hasNodeModules: existsSync(join(worktree, "node_modules")),
    lockfileSha: currentLockSha,
    expectedLockfileSha: targetLockSha,
    forceFresh,
  });

  if (!existsSync(worktree)) {
    gitOut(repo, "worktree", "add", "--detach", worktree, targetCommit);
  } else {
    assertDedicatedWorktreeForReset(repo, worktree);
    gitOut(worktree, "reset", "--hard", "HEAD");
    gitOut(worktree, "clean", "-fdx", "-e", "node_modules", "-e", "dist-native", "-e", "electron/resources/OpenMausBot Speech.app");
    gitOut(worktree, "checkout", "--detach", targetCommit);
  }

  if (!check.reuse) {
    const donorLock = donor && existsSync(join(donor, "pnpm-lock.yaml")) ? sha256File(join(donor, "pnpm-lock.yaml")) : null;
    if (donor && donorLock === targetLockSha) {
      for (const rel of RETAINED_WORKTREE_PATHS) {
        const src = join(donor, rel);
        const dest = join(worktree, rel);
        if (existsSync(src)) {
          rmSync(dest, { recursive: true, force: true });
          mkdirSync(dirname(dest), { recursive: true });
          run("/bin/cp", ["-cRp", src, dest], { cwd: worktree, timeout: 600_000 });
        }
      }
    } else {
      run("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree, timeout: 600_000 });
    }
  }
  return { reusedNodeModules: check.reuse, lockfileSha256: targetLockSha, reason: check.reason };
}

function stageFastPatch({ worktree, targetApp, stagedApp, layers, jobDir }) {
  run("/usr/bin/codesign", buildCodesignVerifyArgs({ appPath: targetApp }), { cwd: worktree, timeout: 120_000 });
  rmSync(stagedApp, { recursive: true, force: true });
  mkdirSync(dirname(stagedApp), { recursive: true });
  run("/bin/cp", ["-cRp", targetApp, stagedApp], { cwd: worktree, timeout: 120_000 });

  const resources = join(stagedApp, "Contents", "Resources");
  const syncTree = (srcRel, destRel) => {
    const src = join(worktree, srcRel);
    const dest = join(resources, destRel);
    if (!existsSync(src)) throw new Error(`Missing compiled output: ${src}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    run("/bin/cp", ["-cRp", src, dest], { cwd: worktree, timeout: 120_000 });
  };
  rmSync(join(resources, "app-update.yml"), { force: true });
  rmSync(join(resources, "default_app.asar"), { force: true });
  if (layers.ui) syncTree("dist", "ui");
  if (layers.server) {
    rmSync(join(worktree, "dist-server", "server"), { recursive: true, force: true });
    syncTree("dist-server", "server");
  }
  if (layers.companion) syncTree("dist-companion", "companion");
  if (layers.skills) syncTree("skills", "skills");
  if (layers.usageHelpers) {
    const helperDir = join(resources, "usage-helpers");
    rmSync(helperDir, { recursive: true, force: true });
    mkdirSync(helperDir, { recursive: true });
    const hashes = {};
    for (const name of USAGE_HELPER_NAMES) {
      const src = join(worktree, "scripts", name);
      if (!existsSync(src)) continue;
      const dest = join(helperDir, name);
      cpSync(src, dest);
      chmodSync(dest, 0o644);
      hashes[name] = sha256File(dest);
    }
    chmodSync(helperDir, 0o555);
    const hashFile = join(jobDir, "signed-helper-hashes.json");
    writeFileSync(hashFile, `${JSON.stringify(hashes, null, 2)}\n`);
    run("pnpm", ["check:delivery", "signed-helpers", helperDir, hashFile], { cwd: worktree, timeout: 30_000 });
  }

  run(
    "/usr/bin/codesign",
    buildOuterCodesignArgs({ appPath: stagedApp, entitlementsPath: join(worktree, "build", "entitlements.mac.plist") }),
    { cwd: worktree, timeout: 120_000 },
  );
  run("/usr/bin/codesign", buildCodesignVerifyArgs({ appPath: stagedApp }), { cwd: worktree, timeout: 120_000 });
}

function stageFullPackage({ worktree, stagedApp, jobDir }) {
  const pkgOut = join(jobDir, "package");
  rmSync(pkgOut, { recursive: true, force: true });
  run("pnpm", ["exec", "electron-builder", "--mac", "--arm64", "--dir", "--publish", "never", `-c.directories.output=${pkgOut}`], {
    cwd: worktree,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    timeout: 600_000,
  });
  const builtApp = join(pkgOut, "mac-arm64", "mymausbot.app");
  const signArgs = {
    osxSignPath: resolveOsxSignPath(worktree),
    app: builtApp,
    electronVersion: readElectronVersion(worktree),
    entitlements: join(worktree, "build", "entitlements.mac.plist"),
  };
  run(
    "node",
    [
      "--input-type=module",
      "-e",
      [
        'import { createRequire } from "node:module";',
        "const opts = JSON.parse(process.argv[1]);",
        "const require = createRequire(import.meta.url);",
        "const { signAsync } = require(opts.osxSignPath);",
        'await signAsync({ app: opts.app, identity: "-", identityValidation: false, platform: "darwin", version: opts.electronVersion, preAutoEntitlements: false, preEmbedProvisioningProfile: false, strictVerify: true, optionsForFile: () => ({ entitlements: opts.entitlements, hardenedRuntime: true, timestamp: "none" }) });',
      ].join(" "),
      JSON.stringify(signArgs),
    ],
    { cwd: worktree, timeout: 300_000 },
  );
  run("/usr/bin/codesign", buildCodesignVerifyArgs({ appPath: builtApp }), { cwd: worktree, timeout: 120_000 });
  rmSync(stagedApp, { recursive: true, force: true });
  mkdirSync(dirname(stagedApp), { recursive: true });
  run("/bin/cp", ["-cRp", builtApp, stagedApp], { cwd: worktree, timeout: 120_000 });
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

export function matchTargetAppPids(psOutput, targetApp) {
  const prefix = `${resolve(targetApp)}/Contents/MacOS/`;
  const pids = [];
  for (const line of String(psOutput || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.search(/\s/);
    if (space < 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const comm = trimmed.slice(space).trim();
    if (Number.isInteger(pid) && pid > 0 && comm.startsWith(prefix)) {
      pids.push(pid);
    }
  }
  return pids;
}

function runningAppPids(targetApp) {
  const out = run("/bin/ps", ["-axo", "pid=,comm="]);
  return matchTargetAppPids(out, targetApp);
}

async function stopTargetAppProcesses(targetApp, timeoutMs = 40_000) {
  for (const pid of runningAppPids(targetApp)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have exited between ps and kill.
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (runningAppPids(targetApp).length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return runningAppPids(targetApp);
}

async function assertLiveIdle({ targetApp }) {
  const state = await fetchJson("http://127.0.0.1:8799/api/bots?messages=0");
  if (Object.values(state.botQueuedMessages ?? {}).some(Boolean)) throw new Error("Bot messages are queued");
  const agents = [...(state.bots ?? []), ...((state.bots ?? []).flatMap((bot) => bot.tasks ?? [])), ...(state.groups ?? [])];
  for (const agent of agents) {
    if (agent.busy || agent.working || agent.waitingForTeammates || agent.pendingPermission || agent.pendingQuestion || agent.activeTurn || agent.queue || agent.busyBotId || (agent.activity && agent.activity !== "idle")) {
      throw new Error(`Active work on ${agent.name || agent.id}`);
    }
  }
  const pairing = await fetchJson("http://127.0.0.1:8799/api/auth/pairing");
  if (pairing.pairings?.length) throw new Error("Open pairing codes active");
  const routinesPath = join(homedir(), ".openmausbot", "routines.json");
  if (existsSync(routinesPath)) {
    const routines = JSON.parse(readFileSync(routinesPath, "utf8"));
    const active = (routines.runs ?? []).find((r) => !["completed", "failed", "cancelled", "missed"].includes(r.status));
    if (active) throw new Error(`Active routine run: ${active.id}`);
  }
  const uid = process.getuid();
  const writerStatus = spawnSync("/bin/launchctl", ["print", `gui/${uid}/com.openmausbot.local-usage-refresh`], { encoding: "utf8" });
  if (writerStatus.status === 0 && !writerStatus.stdout.includes("state = not running")) {
    throw new Error("Scheduled 300s usage writer is running");
  }
  const envInfo = await fetchJson("http://127.0.0.1:8799/.well-known/openmausbot/environment");
  run("/usr/bin/codesign", buildCodesignVerifyArgs({ appPath: targetApp }), { timeout: 60_000 });
  return { environmentId: envInfo.environmentId };
}

async function atomicSwitchAndVerify({ worktree, stagedApp, targetApp, jobDir, expectedCdHash, expectedEnvironmentId }) {
  if (resolve(targetApp) === OFFICIAL_APP) throw new Error(`Refusing to modify official app at ${OFFICIAL_APP}`);
  const uid = process.getuid();
  const plist = join(homedir(), "Library", "LaunchAgents", "com.openmausbot.local-usage-refresh.plist");
  const hasPlist = existsSync(plist);
  const evidence = join(jobDir, `switch-${Date.now()}`);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  const beforeInv = join(evidence, "before-inventory.json");
  const beforeRoutines = join(evidence, "before-routines.json");
  const routinesSrc = join(homedir(), ".openmausbot", "routines.json");
  writeFileSync(beforeInv, JSON.stringify(await fetchJson("http://127.0.0.1:8799/api/mini-apps"), null, 2));
  if (existsSync(routinesSrc)) cpSync(routinesSrc, beforeRoutines);

  let bootedOut = false;
  let switched = false;
  const parked = join(jobDir, "rollback-after-quit", "mymausbot.app");
  try {
    if (hasPlist) {
      spawnSync("/bin/launchctl", ["bootout", `gui/${uid}/com.openmausbot.local-usage-refresh`], { encoding: "utf8" });
      bootedOut = true;
    }
    const remaining = await stopTargetAppProcesses(targetApp, 40_000);
    if (remaining.length > 0) throw new Error("Previous app process did not quit cleanly");

    const wsSrc = join(homedir(), ".openmausbot");
    const wsCopy = join(evidence, "closed-workspace");
    run("/bin/cp", ["-cRp", wsSrc, wsCopy], { cwd: worktree, timeout: 180_000 });
    run("pnpm", ["check:delivery", "closed-sqlite", wsSrc, wsCopy], { cwd: worktree, timeout: 60_000 });

    mkdirSync(parked, { recursive: true, mode: 0o700 });
    renameSync(join(targetApp, "Contents"), join(parked, "Contents"));
    try {
      renameSync(join(stagedApp, "Contents"), join(targetApp, "Contents"));
    } catch (error) {
      renameSync(join(parked, "Contents"), join(targetApp, "Contents"));
      throw error;
    }
    switched = true;
    run("/usr/bin/codesign", buildCodesignVerifyArgs({ appPath: targetApp }), { cwd: worktree, timeout: 60_000 });
    const actualCdHash = codesignCdHash(targetApp);
    if (actualCdHash !== expectedCdHash) throw new Error(`CDHash mismatch: expected ${expectedCdHash}, got ${actualCdHash}`);

    run("/usr/bin/open", ["-n", "-a", targetApp], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeout: 15_000 });
    const healthDeadline = Date.now() + 40_000;
    let health = null;
    while (Date.now() < healthDeadline) {
      try {
        health = await fetchJson("http://127.0.0.1:8799/api/health");
        const env = await fetchJson("http://127.0.0.1:8799/.well-known/openmausbot/environment");
        if (health?.app === "openmausbot" && health?.static === true && env?.environmentId === expectedEnvironmentId) break;
      } catch {
        health = null;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!health) throw new Error("Timed out waiting for /api/health after restart");

    const afterInv = join(evidence, "after-inventory.json");
    const afterRoutines = join(evidence, "after-routines.json");
    writeFileSync(afterInv, JSON.stringify(await fetchJson("http://127.0.0.1:8799/api/mini-apps"), null, 2));
    run("pnpm", ["check:delivery", "inventory", beforeInv, afterInv], { cwd: worktree, timeout: 30_000 });
    if (existsSync(routinesSrc) && existsSync(beforeRoutines)) {
      cpSync(routinesSrc, afterRoutines);
      run("pnpm", ["check:delivery", "routines", beforeRoutines, afterRoutines], { cwd: worktree, timeout: 30_000 });
    }
    return { health, cdhash: actualCdHash, evidence };
  } catch (error) {
    if (switched && existsSync(join(parked, "Contents")) && !existsSync(join(stagedApp, "Contents"))) {
      try {
        const failedPids = await stopTargetAppProcesses(targetApp, 20_000);
        if (failedPids.length === 0) {
          renameSync(join(targetApp, "Contents"), join(stagedApp, "Contents"));
          renameSync(join(parked, "Contents"), join(targetApp, "Contents"));
          run("/usr/bin/open", ["-n", "-a", targetApp], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeout: 15_000 });
        }
      } catch {
        // Leave original rollback intact for manual recovery if swap-back fails.
      }
    }
    throw error;
  } finally {
    if (bootedOut && hasPlist) {
      spawnSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    }
  }
}

export async function runDesktopDelivery(opts) {
  gitOut(opts.repo, "fetch", "origin", "main");
  const targetCommit = gitOut(opts.repo, "rev-parse", "--verify", opts.targetRef);
  const priorState = existsSync(opts.statePath) ? JSON.parse(readFileSync(opts.statePath, "utf8")) : null;
  const baseCommit = opts.baseCommit || priorState?.sourceCommit || null;

  let changedFiles = null;
  let packageJsonDepUnchanged = false;
  if (baseCommit && /^[0-9a-f]{40}$/.test(baseCommit)) {
    try {
      const out = gitOut(opts.repo, "diff", "--name-only", baseCommit, targetCommit);
      changedFiles = out ? out.split("\n").filter(Boolean) : [];
      if (changedFiles.includes("package.json")) {
        packageJsonDepUnchanged = isPackageJsonDependencySame(
          gitOut(opts.repo, "show", `${baseCommit}:package.json`),
          gitOut(opts.repo, "show", `${targetCommit}:package.json`),
        );
      }
    } catch {
      changedFiles = null;
    }
  }

  const plan = classifyDeliveryChanges(changedFiles, { packageJsonDepUnchanged, forceFull: opts.forceFull });
  if (plan.mode === "fast-patch" && !existsSync(opts.targetApp)) {
    plan.mode = "full-build";
    plan.reasons.push("live-app-missing");
  }
  const compileSteps = buildCompilePlan({ mode: plan.mode, layers: plan.layers, skipTsc: opts.skipTsc });

  const scratchRoot = join(opts.repo, ".omb-scratch");
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const jobDir = opts.jobDir || join(scratchRoot, `main-${targetCommit.slice(0, 9)}-delivery-${stamp}`);
  const summary = {
    targetCommit,
    baseCommit,
    worktree: opts.worktree,
    mode: plan.mode,
    reasons: plan.reasons,
    layers: plan.layers,
    compileSteps,
    switchAfterBuild: shouldSwitchAfterBuild({ noSwitch: opts.noSwitch }),
    jobDir,
  };
  if (opts.dryRun) return summary;

  const lock = acquireDesktopBuildLock({ label: `desktop-delivery:${targetCommit.slice(0, 9)}`, cwd: opts.worktree });
  const releaseLock = () => lock.release();
  process.once("SIGINT", () => { releaseLock(); process.exit(130); });
  process.once("SIGTERM", () => { releaseLock(); process.exit(143); });
  try {
    mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const worktreeStatus = syncResidentWorktree({
      repo: opts.repo,
      worktree: opts.worktree,
      targetCommit,
      donor: opts.donor,
      forceFresh: opts.forceFresh,
    });
    for (const step of compileSteps) {
      run(step.cmd, step.args, { cwd: opts.worktree, timeout: 600_000 });
    }
    const stagedApp = join(jobDir, "stage", "mymausbot.app");
    if (plan.mode === "fast-patch") {
      stageFastPatch({ worktree: opts.worktree, targetApp: opts.targetApp, stagedApp, layers: plan.layers, jobDir });
    } else {
      stageFullPackage({ worktree: opts.worktree, stagedApp, jobDir });
    }
    const stagedCdHash = codesignCdHash(stagedApp);
    let switchResult = null;
    if (summary.switchAfterBuild) {
      const { environmentId } = await assertLiveIdle({ targetApp: opts.targetApp });
      switchResult = await atomicSwitchAndVerify({
        worktree: opts.worktree,
        stagedApp,
        targetApp: opts.targetApp,
        jobDir,
        expectedCdHash: stagedCdHash,
        expectedEnvironmentId: environmentId,
      });
      mkdirSync(dirname(opts.statePath), { recursive: true, mode: 0o700 });
      writeFileSync(
        opts.statePath,
        `${JSON.stringify({ sourceCommit: targetCommit, cdhash: stagedCdHash, mode: plan.mode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        { mode: 0o600 },
      );
      pruneOldDeliveryDirs(scratchRoot, opts.keepBackups);
    }
    return { ...summary, worktreeStatus, stagedApp, stagedCdHash, switchResult };
  } finally {
    releaseLock();
  }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  const opts = parseDeliveryArgs(process.argv.slice(2));
  const result = await runDesktopDelivery(opts);
  console.log(JSON.stringify(result, null, 2));
}
