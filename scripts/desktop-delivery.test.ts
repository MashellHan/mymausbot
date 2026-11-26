import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDedicatedWorktreeForReset,
  buildCodesignVerifyArgs,
  buildCompilePlan,
  buildOuterCodesignArgs,
  canReuseResidentWorktree,
  classifyDeliveryChanges,
  isPackageJsonDependencySame,
  matchTargetAppPids,
  parseDeliveryArgs,
  pruneOldDeliveryDirs,
  readElectronVersion,
  resolveDefaultDeliveryWorktree,
  resolveOsxSignPath,
  shouldSwitchAfterBuild,
  syncResidentWorktree,
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

  it("falls back to full-build when electron/, locales, lockfile, version, dependencies, or packaging inputs change", () => {
    const electronChange = classifyDeliveryChanges(["electron/main.mjs", "server/index.ts"]);
    expect(electronChange.mode).toBe("full-build");
    expect(electronChange.reasons).toContain("packager-input:electron/main.mjs");

    const localeChange = classifyDeliveryChanges(["src/locales/zh.json", "server/web-push.ts"]);
    expect(localeChange.mode).toBe("full-build");
    expect(localeChange.reasons).toContain("packager-input:src/locales/zh.json");

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
        JSON.stringify({ version: "0.1.169", dependencies: { zod: "4.6.7" }, scripts: { a: "2" } }),
      ),
    ).toBe(true);
    expect(
      isPackageJsonDependencySame(
        JSON.stringify({ version: "0.1.169", dependencies: { zod: "4.6.7" } }),
        JSON.stringify({ version: "0.1.170", dependencies: { zod: "4.6.7" } }),
      ),
    ).toBe(false);
    expect(
      isPackageJsonDependencySame(
        JSON.stringify({ version: "0.1.169", dependencies: { zod: "4.6.7" } }),
        JSON.stringify({ version: "0.1.169", dependencies: { zod: "4.6.8" } }),
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

  it("constructs outer-only codesign commands, resolves dynamic electron/@electron/osx-sign paths, and guards worktree resets", () => {
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

    const siblingDefault = resolveDefaultDeliveryWorktree("/workspace/OpenMausBot", {});
    expect(siblingDefault).toBe(join(dirname("/workspace/OpenMausBot"), `${basename("/workspace/OpenMausBot")}-desktop-delivery-worktree`));
    expect(resolveDefaultDeliveryWorktree("/workspace/OpenMausBot", { OMB_DELIVERY_WORKTREE: "/custom/wt" })).toBe("/custom/wt");

    const psSample = [
      "101 /Applications/OpenMausBot.app/Contents/MacOS/OpenMausBot",
      "202 /Users/tester/Applications/mymausbot.app/Contents/MacOS/mymausbot",
      "303 /Users/tester/Applications/mymausbot.app/Contents/Frameworks/mymausbot Helper.app/Contents/MacOS/mymausbot Helper",
    ].join("\n");
    expect(matchTargetAppPids(psSample, "/Users/tester/Applications/mymausbot.app")).toEqual([202]);

    const fakeWt = mkdtempSync(join(tmpdir(), "omb-delivery-wt-guard-"));
    tempDirs.push(fakeWt);
    const fakeRepo = mkdtempSync(join(tmpdir(), "omb-delivery-repo-guard-"));
    tempDirs.push(fakeRepo);
    expect(() => assertDedicatedWorktreeForReset(fakeRepo, fakeWt)).toThrow(/\.git/);
    expect(() => syncResidentWorktree({ repo: fakeRepo, worktree: fakeRepo, targetCommit: "a".repeat(40) })).toThrow(/must differ/);

    const osxSignTarget = join(fakeWt, "node_modules", ".pnpm", "@electron+osx-sign@1.9.0", "node_modules", "@electron", "osx-sign");
    mkdirSync(osxSignTarget, { recursive: true });
    mkdirSync(join(fakeWt, "node_modules", "electron"), { recursive: true });
    writeFileSync(join(fakeWt, "node_modules", "electron", "package.json"), JSON.stringify({ name: "electron", version: "44.0.1" }));
    expect(resolveOsxSignPath(fakeWt)).toBe(realpathSync(osxSignTarget).replace(realpathSync(fakeWt), fakeWt));
    expect(readElectronVersion(fakeWt)).toBe("44.0.1");

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
