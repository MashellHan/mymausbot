#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireLocalTestSlot,
  defaultDetectDesktopBuildProcess,
  findBlockedHeavyVitestArgs,
  readBuildLockState,
  resolveLocalLockDir,
} from "./local-concurrency.mjs";

export function parseRunVitestArgs(argv) {
  let label = "vitest";
  let allowHeavy = false;
  const vitestArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-heavy") allowHeavy = true;
    else if (arg === "--label" && argv[i + 1]) label = argv[++i];
    else if (arg.startsWith("--label=")) label = arg.slice(8) || label;
    else vitestArgs.push(arg);
  }
  if (vitestArgs.length > 0 && !vitestArgs.some((arg) => arg === "run" || arg === "watch" || arg === "bench" || arg === "related" || arg === "list")) {
    vitestArgs.unshift("run");
  } else if (vitestArgs.length === 0) {
    vitestArgs.push("run");
  }
  return { label, allowHeavy, vitestArgs };
}

export function resolveVitestEntrypoint(cwd = process.cwd()) {
  const localPkgEntry = join(cwd, "node_modules", "vitest", "vitest.mjs");
  if (existsSync(localPkgEntry)) return localPkgEntry;
  const localBin = join(cwd, "node_modules", ".bin", "vitest");
  if (existsSync(localBin)) return localBin;
  return "vitest";
}

export function runVitestWithGuard(argv = process.argv.slice(2), {
  cwd = process.cwd(),
  lockDir = resolveLocalLockDir(),
  env = process.env,
  detectBuildProcess = defaultDetectDesktopBuildProcess,
  readBuild = readBuildLockState,
  acquireSlot = acquireLocalTestSlot,
  spawn = spawnSync,
  log = (msg) => console.error(msg),
} = {}) {
  const { label, allowHeavy, vitestArgs } = parseRunVitestArgs(argv);
  const hasBypass = Boolean(env.CI) || env.OMB_LOCAL_LOCK_BYPASS === "1";
  if (!hasBypass) {
    const build = readBuild({ lockDir, detectBuildProcess });
    const blocked = findBlockedHeavyVitestArgs(vitestArgs, {
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

  const slot = acquireSlot({ label, cwd, lockDir, env, detectBuildProcess, log });
  try {
    const entry = resolveVitestEntrypoint(cwd);
    const workers = env.OMB_VITEST_WORKERS || (slot.buildActive ? "1" : "1");
    const cmd = entry.endsWith(".mjs") ? process.execPath : entry;
    const cmdArgs = entry.endsWith(".mjs") ? [entry, ...vitestArgs] : vitestArgs;
    const result = spawn(cmd, cmdArgs, {
      cwd,
      stdio: "inherit",
      env: { ...env, OMB_VITEST_WORKERS: workers },
    });
    if (result?.error) throw result.error;
    return { status: typeof result?.status === "number" ? result.status : 1, slot, vitestArgs };
  } finally {
    slot.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outcome = runVitestWithGuard(process.argv.slice(2));
    process.exitCode = outcome.status;
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
