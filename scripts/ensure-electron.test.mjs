import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { electronRecovery } from "./ensure-electron.mjs";

const require = createRequire(import.meta.url);
const packageDir = dirname(realpathSync(require.resolve("electron")));
const checksums = JSON.parse(readFileSync(join(packageDir, "checksums.json"), "utf8"));

describe("original Electron runtime recovery", () => {
  it.each([
    ["darwin", "arm64", "dcf13726bbf45646c968bb67f48d24ecfb941af1b3c01217f84edaf50fee632a"],
    ["linux", "x64", "684c0beebab080d079c9ae26ba1f2e7af97c95e27772e8ded45ff02f25db17ec"],
    ["win32", "x64", "92171b4a51c8547e48c8cfeca63c655841994031aabf79db80658319d95fafe5"],
  ])("uses the published %s-%s bytes and the locked package checksum", (platform, arch, digest) => {
    const recovery = electronRecovery("43.7.9", platform, arch, checksums);
    expect(recovery).toEqual({
      archive: `electron-v43.7.9-${platform}-${arch}.zip`, digest,
      mirror: "https://npmmirror.com/mirrors/electron/", directory: "{{ version }}",
    });
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
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      .filter((step) => step.name === "Prepare Electron test runtime");
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.run)).toEqual(Array(3).fill("node scripts/ensure-electron.mjs"));
  });
});
