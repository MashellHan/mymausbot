import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodesignVerifyArgs,
  buildCompilePlan,
  buildOuterCodesignArgs,
  canReuseResidentWorktree,
  classifyDeliveryChanges,
  isPackageJsonDependencySame,
  parseDeliveryArgs,
  pruneOldDeliveryDirs,
  shouldSwitchAfterBuild,
} from "./desktop-delivery.mjs";
import { acquireDesktopBuildLock, inspectLocalConcurrency, releaseDesktopBuildLock } from "./local-concurrency.mjs";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fast desktop delivery orchestration", () => {
  it("selects fast-patch and only affected layers for server/ui/shared/scripts diffs", () => {
    expect(classifyDeliveryChanges(["server/web-push.ts"])).toEqual({
      mode: "fast-patch",
      reasons: [],
      layers: { ui: false, server: true, companion: false, skills: false, usageHelpers: false },
    });

    expect(classifyDeliveryChanges(["src/components/ChatView.tsx"])).toEqual({
      mode: "fast-patch",
      reasons: [],
      layers: { ui: true, server: false, companion: false, skills: false, usageHelpers: false },
    });

    expect(classifyDeliveryChanges(["shared/wire.ts"])).toEqual({
      mode: "fast-patch",
      reasons: [],
      layers: { ui: true, server: true, companion: true, skills: false, usageHelpers: false },
    });

    expect(classifyDeliveryChanges(["scripts/refresh-local-usage.py", "skills/pdf/SKILL.md"])).toEqual({
      mode: "fast-patch",
      reasons: [],
      layers: { ui: false, server: false, companion: false, skills: true, usageHelpers: true },
    });
  });

  it("falls back to full-build when electron/, lockfile, dependencies, or packaging inputs change", () => {
    const electronChange = classifyDeliveryChanges(["electron/main.mjs", "server/index.ts"]);
    expect(electronChange.mode).toBe("full-build");
    expect(electronChange.reasons).toContain("packager-input:electron/main.mjs");

    const lockChange = classifyDeliveryChanges(["pnpm-lock.yaml"]);
    expect(lockChange.mode).toBe("full-build");
    expect(lockChange.reasons).toContain("packager-input:pnpm-lock.yaml");

    const depChange = classifyDeliveryChanges(["package.json"], { packageJsonDepUnchanged: false });
    expect(depChange.mode).toBe("full-build");
    expect(depChange.reasons).toContain("package-json-dependencies");

    const scriptOnlyPkg = classifyDeliveryChanges(["package.json"], { packageJsonDepUnchanged: true });
    expect(scriptOnlyPkg.mode).toBe("fast-patch");

    expect(
      isPackageJsonDependencySame(
        JSON.stringify({ version: "0.1.169", dependencies: { zod: "4.6.7" }, scripts: { a: "1" } }),
        JSON.stringify({ version: "0.1.170", dependencies: { zod: "4.6.7" }, scripts: { a: "2" } }),
      ),
    ).toBe(true);
    expect(
      isPackageJsonDependencySame(
        JSON.stringify({ dependencies: { zod: "4.6.7" } }),
        JSON.stringify({ dependencies: { zod: "4.6.8" } }),
      ),
    ).toBe(false);
  });

  it("reuses resident worktree node_modules when lockfile sha matches and skips redundant tsc on CI-green builds", () => {
    expect(
      canReuseResidentWorktree({
        exists: true,
        hasNodeModules: true,
        lockfileSha: "abc",
        expectedLockfileSha: "abc",
      }),
    ).toEqual({ reuse: true, reason: "persistent-node-modules-valid" });

    expect(
      canReuseResidentWorktree({
        exists: true,
        hasNodeModules: true,
        lockfileSha: "old",
        expectedLockfileSha: "new",
      }),
    ).toEqual({ reuse: false, reason: "lockfile-hash-mismatch" });

    expect(
      buildCompilePlan({
        mode: "fast-patch",
        layers: { ui: false, server: true, companion: false, skills: false, usageHelpers: false },
        skipTsc: true,
      }),
    ).toEqual([{ name: "build-server", cmd: "pnpm", args: ["build:server:fast"] }]);

    expect(
      buildCompilePlan({
        mode: "full-build",
        layers: { ui: true, server: true, companion: true, skills: false, usageHelpers: false },
        skipTsc: true,
      }).map((step) => step.args),
    ).toEqual([["build:ui:fast"], ["build:server:fast"], ["build:companion"]]);

    expect(
      buildCompilePlan({
        mode: "full-build",
        layers: { ui: true, server: true, companion: true, skills: false, usageHelpers: false },
        skipTsc: false,
      }).map((step) => step.args),
    ).toEqual([["check:electron"], ["build"], ["build:server"], ["build:companion"]]);
  });

  it("constructs outer-only codesign commands, verify args, chained switch flags, and honors build locks", () => {
    expect(
      buildOuterCodesignArgs({ appPath: "/tmp/stage/mymausbot.app", entitlementsPath: "/tmp/entitlements.mac.plist" }),
    ).toEqual([
      "--force",
      "--sign",
      "-",
      "--entitlements",
      "/tmp/entitlements.mac.plist",
      "--options",
      "runtime",
      "--timestamp=none",
      "/tmp/stage/mymausbot.app",
    ]);
    expect(buildCodesignVerifyArgs({ appPath: "/tmp/stage/mymausbot.app" })).toEqual([
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      "/tmp/stage/mymausbot.app",
    ]);

    expect(shouldSwitchAfterBuild({ noSwitch: false, buildOk: true })).toBe(true);
    expect(shouldSwitchAfterBuild({ noSwitch: true, buildOk: true })).toBe(false);

    const parsed = parseDeliveryArgs(["deliver", "--no-switch", "--full-tsc", "--worktree", "/tmp/wt"]);
    expect(parsed.noSwitch).toBe(true);
    expect(parsed.skipTsc).toBe(false);
    expect(parsed.worktree).toBe("/tmp/wt");

    const lockDir = mkdtempSync(join(tmpdir(), "omb-delivery-lock-"));
    tempDirs.push(lockDir);
    const lock = acquireDesktopBuildLock({ label: "desktop-delivery:test", lockDir, env: { OMB_BUILD_LOCK: "1", CI: "true" } });
    expect(lock.bypassed).toBe(false);
    expect(lock.acquired).toBe(true);
    expect(inspectLocalConcurrency({ lockDir, env: {}, detectBuildProcess: () => false }).buildActive).toBe(true);
    lock.release();
    releaseDesktopBuildLock({ lockDir });

    const scratch = mkdtempSync(join(tmpdir(), "omb-delivery-prune-"));
    tempDirs.push(scratch);
    for (let i = 1; i <= 5; i += 1) {
      const dir = join(scratch, `main-000000${i}-delivery-20261126`);
      mkdirSync(dir);
      writeFileSync(join(dir, "stamp"), String(i));
    }
    const removed = pruneOldDeliveryDirs(scratch, 3);
    expect(removed).toHaveLength(2);
  });
});
