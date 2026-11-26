import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_LOCAL_TEST_MAX_SLOTS = 2;
export const DEFAULT_BUILD_WAIT_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 250;
export const DEFAULT_BUILD_STALE_MS = 30 * 60_000;

export function resolveLocalLockDir(env = process.env) {
  const override = env.OMB_LOCAL_LOCK_DIR?.trim();
  return override ? resolve(override) : join(tmpdir(), "openmausbot-local-locks");
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function defaultDetectDesktopBuildProcess() {
  try {
    const out = execFileSync("ps", ["-Ao", "pid,args"], { encoding: "utf8", timeout: 2000 });
    return out.split("\n").some((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const match = /^(\d+)\s+(.+)$/.exec(trimmed);
      if (!match) return false;
      const pid = Number(match[1]);
      if (pid === process.pid) return false;
      const args = match[2];
      return /(?:desktop-job.*build\.py|\belectron-builder\b|\bpnpm(?:\s+run)?\s+package(?::|\b))/.test(args);
    });
  } catch {
    return false;
  }
}

function readLockJson(filePath) {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function isLockActive(record, nowMs, staleMs, checkPidAlive) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return false;
  if (!checkPidAlive(record.pid)) return false;
  if (Number.isFinite(staleMs) && staleMs > 0 && Number.isFinite(record.startedAtMs)) {
    if (nowMs - record.startedAtMs > staleMs) return false;
  }
  return true;
}

export function cleanupStaleLocks({
  lockDir = resolveLocalLockDir(),
  nowMs = Date.now(),
  staleMs = DEFAULT_BUILD_STALE_MS,
  checkPidAlive = isProcessAlive,
} = {}) {
  if (!existsSync(lockDir)) return { removed: [] };
  const removed = [];
  for (const name of readdirSync(lockDir)) {
    if (!/^slot-\d+\.lock$/.test(name) && name !== "build.lock") continue;
    const filePath = join(lockDir, name);
    const record = readLockJson(filePath);
    if (!isLockActive(record, nowMs, staleMs, checkPidAlive)) {
      try {
        rmSync(filePath, { force: true });
        removed.push(name);
      } catch {
        // Another cleaner may have removed it concurrently.
      }
    }
  }
  return { removed };
}

export function readBuildLockState({
  lockDir = resolveLocalLockDir(),
  nowMs = Date.now(),
  staleMs = DEFAULT_BUILD_STALE_MS,
  checkPidAlive = isProcessAlive,
  detectBuildProcess = defaultDetectDesktopBuildProcess,
} = {}) {
  const buildLockPath = join(lockDir, "build.lock");
  let buildLock = null;
  if (existsSync(buildLockPath)) {
    const record = readLockJson(buildLockPath);
    if (isLockActive(record, nowMs, staleMs, checkPidAlive)) {
      buildLock = record;
    } else {
      rmSync(buildLockPath, { force: true });
    }
  }
  const processActive = !buildLock && detectBuildProcess();
  return {
    active: Boolean(buildLock) || processActive,
    source: buildLock ? "lockfile" : processActive ? "process" : null,
    buildLock,
    buildLockPath,
  };
}

export function effectiveLocalTestMaxSlots({
  env = process.env,
  buildActive = false,
} = {}) {
  const raw = Number(env.OMB_LOCAL_TEST_MAX_SLOTS);
  const configured = Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_LOCAL_TEST_MAX_SLOTS;
  return buildActive ? 1 : configured;
}

export function listActiveTestSlots({
  lockDir = resolveLocalLockDir(),
  nowMs = Date.now(),
  staleMs = DEFAULT_BUILD_STALE_MS,
  checkPidAlive = isProcessAlive,
} = {}) {
  if (!existsSync(lockDir)) return [];
  const active = [];
  for (const name of readdirSync(lockDir)) {
    if (!/^slot-\d+\.lock$/.test(name)) continue;
    const filePath = join(lockDir, name);
    const record = readLockJson(filePath);
    if (isLockActive(record, nowMs, staleMs, checkPidAlive)) {
      active.push({ name, filePath, ...record });
    } else {
      rmSync(filePath, { force: true });
    }
  }
  return active.sort((a, b) => a.slot - b.slot);
}

export function inspectLocalConcurrency({
  lockDir = resolveLocalLockDir(),
  env = process.env,
  nowMs = Date.now(),
  checkPidAlive = isProcessAlive,
  detectBuildProcess = defaultDetectDesktopBuildProcess,
} = {}) {
  cleanupStaleLocks({ lockDir, nowMs, checkPidAlive });
  const build = readBuildLockState({ lockDir, nowMs, checkPidAlive, detectBuildProcess });
  const slots = listActiveTestSlots({ lockDir, nowMs, checkPidAlive });
  const maxSlots = effectiveLocalTestMaxSlots({ env, buildActive: build.active });
  return {
    lockDir,
    maxSlots,
    buildActive: build.active,
    buildSource: build.source,
    buildLock: build.buildLock,
    activeTestCount: slots.length,
    activeSlots: slots,
  };
}

function tryCreateExclusiveLock(filePath, payload) {
  let fd;
  try {
    fd = openSync(filePath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function acquireDesktopBuildLock({
  label = "desktop-build",
  cwd = process.cwd(),
  pid = process.pid,
  lockDir = resolveLocalLockDir(),
  env = process.env,
  now = Date.now,
  checkPidAlive = isProcessAlive,
} = {}) {
  if (env.CI || env.OMB_LOCAL_LOCK_BYPASS === "1") {
    return { bypassed: true, release() {} };
  }
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const nowMs = now();
  const buildLockPath = join(lockDir, "build.lock");
  if (existsSync(buildLockPath)) {
    const existing = readLockJson(buildLockPath);
    if (!isLockActive(existing, nowMs, DEFAULT_BUILD_STALE_MS, checkPidAlive)) {
      rmSync(buildLockPath, { force: true });
    }
  }
  const record = {
    kind: "build",
    pid,
    startedAt: new Date(nowMs).toISOString(),
    startedAtMs: nowMs,
    label,
    cwd: resolve(cwd),
  };
  let acquired = tryCreateExclusiveLock(buildLockPath, record);
  if (!acquired) {
    const existing = readLockJson(buildLockPath);
    if (existing && existing.pid === pid) {
      writeFileSync(buildLockPath, JSON.stringify(record, null, 2) + "\n", "utf8");
      acquired = true;
    }
  }
  let released = false;
  return {
    bypassed: false,
    acquired,
    lockPath: buildLockPath,
    record,
    release() {
      if (released) return;
      released = true;
      const current = readLockJson(buildLockPath);
      if (current && current.pid === pid && current.startedAtMs === record.startedAtMs) {
        rmSync(buildLockPath, { force: true });
      }
    },
  };
}

export function releaseDesktopBuildLock({ lockDir = resolveLocalLockDir() } = {}) {
  const buildLockPath = join(lockDir, "build.lock");
  const existed = existsSync(buildLockPath);
  rmSync(buildLockPath, { force: true });
  return { released: true, removed: existed, lockPath: buildLockPath };
}

const syncSleep = (ms) => {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export function acquireLocalTestSlot({
  label = "local-test",
  cwd = process.cwd(),
  pid = process.pid,
  lockDir = resolveLocalLockDir(),
  env = process.env,
  waitTimeoutMs = Number(env.OMB_LOCAL_WAIT_TIMEOUT_MS) || DEFAULT_BUILD_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  now = Date.now,
  sleep = syncSleep,
  checkPidAlive = isProcessAlive,
  detectBuildProcess = defaultDetectDesktopBuildProcess,
  log = (msg) => console.error(msg),
} = {}) {
  if (env.CI || env.OMB_LOCAL_LOCK_BYPASS === "1") {
    return { bypassed: true, slot: 0, maxSlots: effectiveLocalTestMaxSlots({ env }), buildActive: false, release() {} };
  }
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const deadline = now() + Math.max(0, waitTimeoutMs);
  let loggedBuildYield = false;
  let loggedSlotWait = false;

  while (true) {
    const nowMs = now();
    cleanupStaleLocks({ lockDir, nowMs, checkPidAlive });
    const build = readBuildLockState({ lockDir, nowMs, checkPidAlive, detectBuildProcess });
    const maxSlots = effectiveLocalTestMaxSlots({ env, buildActive: build.active });

    if (build.active && !loggedBuildYield) {
      loggedBuildYield = true;
      log(`[local-concurrency] Active desktop build detected (${build.source}); yielding briefly and capping local test concurrency to 1 slot (${label}).`);
      sleep(Math.min(pollIntervalMs, Math.max(0, deadline - nowMs)));
    }

    for (let slot = 1; slot <= maxSlots; slot++) {
      const slotPath = join(lockDir, `slot-${slot}.lock`);
      const record = {
        kind: "test",
        slot,
        pid,
        startedAt: new Date(nowMs).toISOString(),
        startedAtMs: nowMs,
        label,
        cwd: resolve(cwd),
      };
      if (tryCreateExclusiveLock(slotPath, record)) {
        let released = false;
        return {
          bypassed: false,
          timedOut: false,
          slot,
          maxSlots,
          buildActive: build.active,
          lockPath: slotPath,
          record,
          release() {
            if (released) return;
            released = true;
            const current = readLockJson(slotPath);
            if (current && current.pid === pid && current.startedAtMs === record.startedAtMs) {
              rmSync(slotPath, { force: true });
            }
          },
        };
      }
    }

    if (nowMs >= deadline) {
      log(`[local-concurrency] Wait timeout (${waitTimeoutMs}ms) reached for ${label}; proceeding without holding a slot to avoid deadlock.`);
      return {
        bypassed: false,
        timedOut: true,
        slot: null,
        maxSlots,
        buildActive: build.active,
        release() {},
      };
    }

    if (!loggedSlotWait) {
      loggedSlotWait = true;
      log(`[local-concurrency] All ${maxSlots} local test slot(s) busy; waiting cleanly (${label})...`);
    }
    sleep(Math.min(pollIntervalMs, Math.max(1, deadline - nowMs)));
  }
}

function isHeavyVitestTarget(arg) {
  if (typeof arg !== "string" || !arg || arg.startsWith("-")) return false;
  const normalized = arg.replace(/\\/g, "/");
  return /\.e2e\.test\.[cm]?[jt]sx?$/.test(normalized)
    || normalized === "server/index.test.ts"
    || normalized.endsWith("/server/index.test.ts");
}

export function findBlockedHeavyVitestArgs(args, { buildActive = false, allowHeavy = false } = {}) {
  if (!buildActive || allowHeavy) return [];
  return (Array.isArray(args) ? args : []).filter(isHeavyVitestTarget);
}

export function runWithLocalTestSlot({
  commandArgs,
  label = "vitest",
  allowHeavy = false,
  cwd = process.cwd(),
  pid = process.pid,
  lockDir = resolveLocalLockDir(),
  env = process.env,
  detectBuildProcess = defaultDetectDesktopBuildProcess,
  acquireSlot = acquireLocalTestSlot,
  readBuild = readBuildLockState,
  spawn = spawnSync,
  log = (msg) => console.error(msg),
} = {}) {
  const args = Array.isArray(commandArgs) ? commandArgs : [];
  if (args.length === 0) {
    throw new Error("Missing command after `--` for local-concurrency run");
  }
  const hasBypass = Boolean(env.CI) || env.OMB_LOCAL_LOCK_BYPASS === "1";
  if (!hasBypass) {
    const build = readBuild({ lockDir, detectBuildProcess });
    const blocked = findBlockedHeavyVitestArgs(args, {
      buildActive: build.active,
      allowHeavy: allowHeavy || env.OMB_ALLOW_HEAVY_TESTS === "1",
    });
    if (blocked.length > 0) {
      const error = new Error(
        `[local-concurrency] Refusing heavy Vitest target(s) (${blocked.join(", ")}) while desktop build is active (${build.source}); re-run with --allow-heavy after packaging finishes.`,
      );
      error.code = "HEAVY_TEST_BLOCKED_BY_BUILD";
      error.blockedTargets = blocked;
      throw error;
    }
  }
  const slot = acquireSlot({ label, cwd, pid, lockDir, env, detectBuildProcess, log });
  try {
    const [cmd, ...cmdArgs] = args;
    const childEnv = slot.buildActive && !env.OMB_VITEST_WORKERS
      ? { ...env, OMB_VITEST_WORKERS: "1" }
      : env;
    const result = spawn(cmd, cmdArgs, { cwd, env: childEnv, stdio: "inherit" });
    if (result?.error) throw result.error;
    return { status: typeof result?.status === "number" ? result.status : 1, slot };
  } finally {
    slot.release();
  }
}

export function parseConcurrencyCliArgs(argv) {
  const [command = "status", ...rest] = argv;
  const separator = rest.indexOf("--");
  const optionTokens = separator === -1 ? rest : rest.slice(0, separator);
  const trailingArgs = separator === -1 ? [] : rest.slice(separator + 1);
  let label = "cli";
  let explicitPid;
  let cwd = process.cwd();
  let allowHeavy = false;
  for (let i = 0; i < optionTokens.length; i++) {
    if (optionTokens[i] === "--label" && optionTokens[i + 1]) label = optionTokens[++i];
    else if (optionTokens[i] === "--pid" && optionTokens[i + 1]) explicitPid = Number(optionTokens[++i]);
    else if (optionTokens[i] === "--cwd" && optionTokens[i + 1]) cwd = optionTokens[++i];
    else if (optionTokens[i] === "--allow-heavy") allowHeavy = true;
  }
  return { command, label, explicitPid, cwd, allowHeavy, trailingArgs };
}

function main() {
  const { command, label, explicitPid, cwd, allowHeavy, trailingArgs } = parseConcurrencyCliArgs(process.argv.slice(2));
  const ownerPid = Number.isInteger(explicitPid) && explicitPid > 0
    ? explicitPid
    : (process.ppid > 1 ? process.ppid : process.pid);
  if (command === "status") {
    console.log(JSON.stringify(inspectLocalConcurrency(), null, 2));
    return;
  }
  if (command === "cleanup") {
    console.log(JSON.stringify(cleanupStaleLocks(), null, 2));
    return;
  }
  if (command === "acquire-build") {
    const handle = acquireDesktopBuildLock({ label, cwd, pid: ownerPid });
    console.log(JSON.stringify({ acquired: handle.acquired ?? false, bypassed: handle.bypassed, pid: ownerPid, lockPath: handle.lockPath ?? null }, null, 2));
    return;
  }
  if (command === "release-build") {
    console.log(JSON.stringify(releaseDesktopBuildLock(), null, 2));
    return;
  }
  if (command === "run") {
    try {
      const outcome = runWithLocalTestSlot({
        commandArgs: trailingArgs,
        label: label === "cli" ? "vitest" : label,
        allowHeavy,
        cwd,
      });
      process.exitCode = outcome.status;
    } catch (error) {
      console.error(error?.message || String(error));
      process.exitCode = 1;
    }
    return;
  }
  throw new Error("Use status | cleanup | acquire-build [--label name] [--pid pid] [--cwd path] | release-build | run [--label name] [--allow-heavy] -- <cmd> ...");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
