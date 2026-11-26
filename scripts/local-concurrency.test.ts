import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDesktopBuildLock,
  acquireLocalTestSlot,
  cleanupStaleLocks,
  effectiveLocalTestMaxSlots,
  findBlockedHeavyVitestArgs,
  inspectLocalConcurrency,
  parseConcurrencyCliArgs,
  releaseDesktopBuildLock,
  resolveLocalLockDir,
  runWithLocalTestSlot,
} from "./local-concurrency.mjs";
import { parseRunVitestArgs, runVitestWithGuard } from "./run-vitest.mjs";
import { collectTeamHealth } from "./team-health.mjs";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolatedLockDir(prefix = "omb-local-lock-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("cross-worktree local concurrency lock & desktop build priority", () => {
  it("resolves isolated lock directory from OMB_LOCAL_LOCK_DIR and enforces bounded slot locks", () => {
    const lockDir = isolatedLockDir();
    expect(resolveLocalLockDir({ OMB_LOCAL_LOCK_DIR: lockDir })).toBe(lockDir);

    const slot1 = acquireLocalTestSlot({
      label: "worktree-a",
      cwd: "/tmp/wt-a",
      lockDir,
      env: {},
      detectBuildProcess: () => false,
    });
    const slot2 = acquireLocalTestSlot({
      label: "worktree-b",
      cwd: "/tmp/wt-b",
      lockDir,
      env: {},
      detectBuildProcess: () => false,
    });

    expect(slot1.bypassed).toBe(false);
    expect(slot1.slot).toBe(1);
    expect(slot2.slot).toBe(2);
    expect(slot2.maxSlots).toBe(2);

    const lock1 = JSON.parse(readFileSync(join(lockDir, "slot-1.lock"), "utf8"));
    expect(lock1).toMatchObject({ pid: process.pid, label: "worktree-a", slot: 1 });
    expect(typeof lock1.startedAt).toBe("string");

    // A third concurrent runner waits cleanly and exits via safety timeout without deadlocking.
    const logs: string[] = [];
    let fakeNow = 1_000;
    const slot3 = acquireLocalTestSlot({
      label: "worktree-c",
      cwd: "/tmp/wt-c",
      lockDir,
      env: {},
      waitTimeoutMs: 50,
      pollIntervalMs: 25,
      now: () => fakeNow,
      sleep: (ms) => {
        fakeNow += ms;
      },
      detectBuildProcess: () => false,
      log: (msg) => logs.push(msg),
    });
    expect(slot3.timedOut).toBe(true);
    expect(slot3.slot).toBeNull();
    expect(logs.some((line) => line.includes("slot(s) busy"))).toBe(true);

    slot1.release();
    expect(existsSync(join(lockDir, "slot-1.lock"))).toBe(false);

    // Releasing frees slot 1 for the next queued runner.
    const slotNext = acquireLocalTestSlot({
      label: "worktree-c",
      lockDir,
      env: {},
      detectBuildProcess: () => false,
    });
    expect(slotNext.timedOut).toBe(false);
    expect(slotNext.slot).toBe(1);

    slotNext.release();
    slot2.release();
    expect(inspectLocalConcurrency({ lockDir, env: {}, detectBuildProcess: () => false }).activeTestCount).toBe(0);
  });

  it("cleans up stale PID locks automatically without human intervention", () => {
    const lockDir = isolatedLockDir();
    writeFileSync(
      join(lockDir, "slot-1.lock"),
      JSON.stringify({ kind: "test", slot: 1, pid: 999999, startedAt: new Date(1000).toISOString(), startedAtMs: 1000, label: "crashed" }),
    );
    writeFileSync(
      join(lockDir, "build.lock"),
      JSON.stringify({ kind: "build", pid: 888888, startedAt: new Date(1000).toISOString(), startedAtMs: 1000, label: "crashed-build" }),
    );

    const cleaned = cleanupStaleLocks({
      lockDir,
      nowMs: 2000,
      checkPidAlive: () => false,
    });
    expect(cleaned.removed.sort()).toEqual(["build.lock", "slot-1.lock"]);
    expect(existsSync(join(lockDir, "slot-1.lock"))).toBe(false);
    expect(existsSync(join(lockDir, "build.lock"))).toBe(false);
  });

  it("caps local tests to 1 slot when an active desktop build lock or build process exists", () => {
    const lockDir = isolatedLockDir();
    expect(effectiveLocalTestMaxSlots({ env: { OMB_LOCAL_TEST_MAX_SLOTS: "3" }, buildActive: false })).toBe(3);
    expect(effectiveLocalTestMaxSlots({ env: { OMB_LOCAL_TEST_MAX_SLOTS: "3" }, buildActive: true })).toBe(1);

    const buildLock = acquireDesktopBuildLock({
      label: "mausbot-front-release",
      lockDir,
      env: {},
    });
    expect(buildLock.acquired).toBe(true);
    expect(existsSync(join(lockDir, "build.lock"))).toBe(true);

    const logs: string[] = [];
    const slot1 = acquireLocalTestSlot({
      label: "dev-unit",
      lockDir,
      env: { OMB_LOCAL_TEST_MAX_SLOTS: "3" },
      pollIntervalMs: 1,
      detectBuildProcess: () => false,
      log: (msg) => logs.push(msg),
    });
    expect(slot1.buildActive).toBe(true);
    expect(slot1.maxSlots).toBe(1);
    expect(slot1.slot).toBe(1);
    expect(logs.some((line) => line.includes("Active desktop build detected (lockfile)"))).toBe(true);

    // Second slot must wait while build.lock is held, then timeout cleanly without deadlocking.
    let fakeNow = 0;
    const slot2 = acquireLocalTestSlot({
      label: "dev-unit-2",
      lockDir,
      env: {},
      waitTimeoutMs: 20,
      pollIntervalMs: 10,
      now: () => fakeNow,
      sleep: (ms) => {
        fakeNow += ms;
      },
      detectBuildProcess: () => false,
      log: () => {},
    });
    expect(slot2.timedOut).toBe(true);
    expect(slot2.maxSlots).toBe(1);

    // Detect external build process fallback even when no build.lock exists.
    buildLock.release();
    expect(existsSync(join(lockDir, "build.lock"))).toBe(false);

    // Explicit owner PID build locks persist for parent/build runners and can be released cleanly.
    const ownerBuildLock = acquireDesktopBuildLock({
      label: "cli-build-owner",
      pid: process.ppid > 1 ? process.ppid : process.pid,
      lockDir,
      env: {},
      checkPidAlive: () => true,
    });
    expect(ownerBuildLock.acquired).toBe(true);
    expect(releaseDesktopBuildLock({ lockDir })).toMatchObject({ released: true, removed: true });
    expect(existsSync(join(lockDir, "build.lock"))).toBe(false);

    const processStatus = inspectLocalConcurrency({
      lockDir,
      env: {},
      detectBuildProcess: () => true,
    });
    expect(processStatus.buildActive).toBe(true);
    expect(processStatus.buildSource).toBe("process");
    expect(processStatus.maxSlots).toBe(1);
    expect(processStatus.activeTestCount).toBe(1);

    slot1.release();
  });

  it("exposes local concurrency status from collectTeamHealth with isolated lockDir", () => {
    const lockDir = isolatedLockDir();
    const slot = acquireLocalTestSlot({
      label: "health-check",
      lockDir,
      env: {},
      detectBuildProcess: () => false,
    });
    const health = collectTeamHealth({ workspace: "w6", lockDir, includeProcessScan: false });
    expect(health.host.concurrency.lockDir).toBe(lockDir);
    expect(health.host.concurrency.activeTestCount).toBe(1);
    slot.release();
  });

  it("bypasses local locks automatically in CI environment", () => {
    const lockDir = isolatedLockDir();
    const testHandle = acquireLocalTestSlot({ lockDir, env: { CI: "true" } });
    const buildHandle = acquireDesktopBuildLock({ lockDir, env: { CI: "true" } });

    expect(testHandle.bypassed).toBe(true);
    expect(buildHandle.bypassed).toBe(true);
    expect(existsSync(join(lockDir, "slot-1.lock"))).toBe(false);
    expect(existsSync(join(lockDir, "build.lock"))).toBe(false);
  });

  it("blocks heavy e2e and server/index.test.ts targets during desktop build unless --allow-heavy is passed", () => {
    const lockDir = isolatedLockDir();
    const buildLock = acquireDesktopBuildLock({ label: "front-pack", lockDir, env: {} });
    try {
      expect(findBlockedHeavyVitestArgs(["server/foo.e2e.test.ts", "server/bar.test.ts"], { buildActive: true, allowHeavy: false }))
        .toEqual(["server/foo.e2e.test.ts"]);
      expect(findBlockedHeavyVitestArgs(["server/index.test.ts"], { buildActive: true, allowHeavy: true })).toEqual([]);

      expect(() =>
        runVitestWithGuard(["server/index.test.ts"], {
          lockDir,
          env: {},
          detectBuildProcess: () => false,
          spawn: () => {
            throw new Error("should not spawn blocked heavy suite");
          },
        }),
      ).toThrow(/HEAVY_TEST_BLOCKED_BY_BUILD|Refusing heavy Vitest/);

      let spawnedArgs: string[] = [];
      let spawnedEnv: Record<string, string | undefined> = {};
      const allowed = runVitestWithGuard(["--allow-heavy", "--label=heavy-e2e", "server/chat.e2e.test.ts"], {
        lockDir,
        env: {},
        detectBuildProcess: () => false,
        log: () => {},
        spawn: (_cmd, args, opts) => {
          spawnedArgs = args;
          spawnedEnv = (opts?.env ?? {}) as Record<string, string | undefined>;
          return { status: 0 } as never;
        },
      });
      expect(allowed.status).toBe(0);
      expect(allowed.slot.maxSlots).toBe(1);
      expect(spawnedArgs).toContain("run");
      expect(spawnedArgs).toContain("server/chat.e2e.test.ts");
      expect(spawnedEnv.OMB_VITEST_WORKERS).toBe("1");
      expect(existsSync(join(lockDir, "slot-1.lock"))).toBe(false);
    } finally {
      buildLock.release();
    }
  });

  it("supports CLI `run --label vitest -- <cmd>` slot wrapper with build lock yielding", () => {
    const lockDir = isolatedLockDir();
    expect(parseRunVitestArgs(["scripts/team-health.test.ts"])).toEqual({
      label: "vitest",
      allowHeavy: false,
      vitestArgs: ["run", "scripts/team-health.test.ts"],
    });
    expect(parseConcurrencyCliArgs(["run", "--label", "vitest", "--allow-heavy", "--", "vitest", "run", "a.test.ts"])).toEqual({
      command: "run",
      label: "vitest",
      explicitPid: undefined,
      cwd: process.cwd(),
      allowHeavy: true,
      trailingArgs: ["vitest", "run", "a.test.ts"],
    });

    const buildLock = acquireDesktopBuildLock({ label: "front-pack", lockDir, env: {} });
    try {
      expect(() =>
        runWithLocalTestSlot({
          commandArgs: ["./node_modules/.bin/vitest", "run", "scripts/testing/local-dashboard-ui.e2e.test.ts"],
          label: "vitest",
          lockDir,
          env: {},
          detectBuildProcess: () => false,
          spawn: () => ({ status: 0 } as never),
        }),
      ).toThrow(/Refusing heavy Vitest/);

      let activeDuringChild = false;
      const result = runWithLocalTestSlot({
        commandArgs: ["./node_modules/.bin/vitest", "run", "scripts/team-health.test.ts"],
        label: "vitest",
        lockDir,
        env: {},
        detectBuildProcess: () => false,
        log: () => {},
        spawn: () => {
          activeDuringChild = existsSync(join(lockDir, "slot-1.lock"));
          return { status: 0 } as never;
        },
      });
      expect(result.status).toBe(0);
      expect(activeDuringChild).toBe(true);
      expect(existsSync(join(lockDir, "slot-1.lock"))).toBe(false);
    } finally {
      buildLock.release();
    }
  });
});
