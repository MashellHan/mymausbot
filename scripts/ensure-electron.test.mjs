import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { electronInstallEnvironment, electronRecovery } from "./ensure-electron.mjs";

const require = createRequire(import.meta.url);
const packageDir = dirname(realpathSync(require.resolve("electron")));
const requireFromElectron = createRequire(require.resolve("electron"));
const getDirectory = dirname(requireFromElectron.resolve("@electron/get"));
const checksums = JSON.parse(readFileSync(join(packageDir, "checksums.json"), "utf8"));

describe("original Electron runtime recovery", () => {
  it.each([
    ["darwin", "arm64", "dcf13726bbf45646c968bb67f48d24ecfb941af1b3c01217f84edaf50fee632a"],
    ["linux", "x64", "684c0beebab080d079c9ae26ba1f2e7af97c95e27772e8ded45ff02f25db17ec"],
    ["win32", "x64", "92171b4a51c8547e48c8cfeca63c655841994031aabf79db80658319d95fafe5"],
  ])("uses the published %s-%s bytes and the locked package checksum", (platform, arch, digest) => {
    const recovery = electronRecovery("43.7.9", platform, arch, checksums);
    expect(recovery).toEqual({
      archive: `electron-v43.7.9-${platform}-${arch}.zip`, digest, platform, arch,
      mirror: "https://npmmirror.com/mirrors/electron/", directory: "{{ version }}",
    });
  });

  it("pins the fallback child to the verified target and local checksums", () => {
    const recovery = electronRecovery("43.7.9", "linux", "x64", checksums);
    const inherited = {
      PATH: "/fixture/bin",
      electron_use_remote_checksums: "1",
      NPM_CONFIG_ELECTRON_USE_REMOTE_CHECKSUMS: "1",
      ELECTRON_CUSTOM_VERSION: "1.0.0",
      npm_config_electron_customversion: "1.0.0",
      NPM_CONFIG_ELECTRON_CUSTOM_VERSION: "1.0.0",
      npm_config_electron_custom_version: "1.0.0",
      npm_package_config_electron_customVersion: "1.0.0",
      npm_package_config_electron_custom_version: "1.0.0",
      ELECTRON_INSTALL_PLATFORM: "darwin",
      ELECTRON_INSTALL_ARCH: "arm64",
      Electron_Install_Arch: "arm64",
      npm_config_platform: "darwin",
      npm_config_arch: "arm64",
      ELECTRON_MIRROR: "https://untrusted.invalid/",
      NPM_CONFIG_ELECTRON_MIRROR: "https://untrusted.invalid/",
    };
    const env = electronInstallEnvironment(recovery, inherited);
    expect(env).toMatchObject({
      PATH: "/fixture/bin",
      ELECTRON_INSTALL_PLATFORM: "linux",
      ELECTRON_INSTALL_ARCH: "x64",
      ELECTRON_MIRROR: recovery.mirror,
      ELECTRON_CUSTOM_DIR: recovery.directory,
      npm_config_electron_mirror: recovery.mirror,
      npm_config_electron_customdir: recovery.directory,
    });
    const names = Object.keys(env).map((name) => name.toLowerCase());
    for (const name of [
      "electron_use_remote_checksums", "npm_config_electron_use_remote_checksums",
      "electron_custom_version", "npm_config_electron_customversion", "npm_config_electron_custom_version",
      "npm_package_config_electron_customversion", "npm_package_config_electron_custom_version",
      "npm_config_platform", "npm_config_arch",
    ]) {
      expect(names).not.toContain(name);
    }
    for (const name of ["electron_install_platform", "electron_install_arch", "electron_mirror"]) {
      expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
    }
    expect(inherited.ELECTRON_INSTALL_ARCH).toBe("arm64");
    expect(JSON.parse(readFileSync(join(getDirectory, "..", "package.json"), "utf8")).version).toBe("5.1.0");
    const artifactUtils = pathToFileURL(join(getDirectory, "artifact-utils.js")).href;
    const version = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { getArtifactVersion } from ${JSON.stringify(artifactUtils)}; process.stdout.write(getArtifactVersion({ version: "43.7.9" }));`,
    ], { env, encoding: "utf8" });
    expect(version.error).toBeUndefined();
    expect(version.status).toBe(0);
    expect(version.stdout).toBe("v43.7.9");
  });

  it("refuses an unreviewed version or a changed checksum", () => {
    expect(electronRecovery("43.7.10", "linux", "x64", checksums)).toBeNull();
    expect(electronRecovery("43.7.9", "linux", "arm64", checksums)).toBeNull();
    expect(() => electronRecovery("43.7.9", "linux", "x64", {
      ...checksums, "electron-v43.7.9-linux-x64.zip": "0".repeat(64),
    })).toThrow(/locked Electron checksum differs/);
  });

  it("prepares the same verified runtime in all three independent CI runners", () => {
    const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
    const preparingJobs = Object.entries(workflow.jobs)
      .filter(([, job]) => (job.steps ?? []).some((step) => step.name === "Prepare Electron test runtime"));
    expect(preparingJobs.map(([id]) => id)).toEqual(["vitest", "electron-smokes"]);
    const prepare = preparingJobs.flatMap(([, job]) => job.steps.filter((step) => step.name === "Prepare Electron test runtime"));
    expect(prepare).toHaveLength(2);
    expect(prepare.map((step) => step.run)).toEqual(Array(2).fill("node scripts/prepare-electron-ci.mjs"));
    for (const [, job] of preparingJobs) {
      const names = job.steps.map((step) => step.name);
      const resolveIndex = names.indexOf("Resolve Electron archive cache");
      const restoreIndex = names.indexOf("Restore Electron archive cache");
      const prepareIndex = names.indexOf("Prepare Electron test runtime");
      const saveIndex = names.indexOf("Save Electron archive cache");
      expect(resolveIndex).toBeGreaterThan(-1);
      expect(restoreIndex).toBe(resolveIndex + 1);
      expect(prepareIndex).toBe(restoreIndex + 1);
      expect(saveIndex).toBe(prepareIndex + 1);
      expect(job.steps[restoreIndex]).toMatchObject({
        uses: "actions/cache/restore@0057852bfaa89a56745cba8c7296529d2fc39830",
        "continue-on-error": true,
        with: { path: "${{ steps.electron-cache.outputs.path }}", key: "${{ steps.electron-cache.outputs.key }}" },
      });
      expect(job.steps[restoreIndex].if).toContain("steps.electron-cache.outputs.eligible == 'true'");
      expect(job.steps[prepareIndex].id).toBe("electron-cache-prepare");
      expect(job.steps[saveIndex]).toMatchObject({
        uses: "actions/cache/save@0057852bfaa89a56745cba8c7296529d2fc39830",
        "continue-on-error": true,
        with: { path: "${{ steps.electron-cache.outputs.path }}", key: "${{ steps.electron-cache.outputs.key }}" },
      });
      expect(job.steps[saveIndex].if).toContain("steps.electron-cache-prepare.outputs.cache-ready == 'true'");
    }
  });
});
