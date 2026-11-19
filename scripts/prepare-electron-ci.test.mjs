import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  electronCachePath,
  electronCiCachePlan,
  electronDownloadUrl,
  prepareElectronCiRuntime,
  seedElectronArchiveCache,
} from "./prepare-electron-ci.mjs";

const require = createRequire(import.meta.url);
const requireFromElectron = createRequire(require.resolve("electron"));
const getDirectory = dirname(requireFromElectron.resolve("@electron/get"));

const digest = (value) => createHash("sha256").update(value).digest("hex");

function recovery(platform = "darwin", arch = "arm64", bytes = "official electron bytes") {
  return {
    archive: `electron-v43.7.9-${platform}-${arch}.zip`,
    digest: digest(bytes),
    platform,
    arch,
    mirror: "https://npmmirror.com/mirrors/electron/",
    directory: "{{ version }}",
  };
}

describe("CI Electron archive cache", () => {
  it("partitions the cache by platform, architecture, version and verified SHA", () => {
    const darwin = electronCiCachePlan(recovery(), { RUNNER_TEMP: "/fixture/tmp" });
    const linux = electronCiCachePlan(recovery("linux", "x64", "different bytes"), { RUNNER_TEMP: "/fixture/tmp" });
    expect(darwin).toEqual({
      eligible: true,
      key: `electron-archive-v1-darwin-arm64-electron-v43.7.9-darwin-arm64.zip-${digest("official electron bytes")}`,
      path: `/fixture/tmp/openmausbot-electron-cache/electron-archive-v1-darwin-arm64-electron-v43.7.9-darwin-arm64.zip-${digest("official electron bytes")}`,
      version: "43.7.9",
    });
    expect(linux.key).not.toBe(darwin.key);
    expect(linux.path).not.toBe(darwin.path);
    expect(electronCachePath("/cache", electronDownloadUrl(recovery()), recovery().archive)).toBe(
      "/cache/36015c644ea53166533d8291c2675bc7ee3c273a4d591717e6b444a4b99d1913/electron-v43.7.9-darwin-arm64.zip",
    );
  });

  it("keeps official runtime preparation for an unpinned version or architecture", async () => {
    const plan = electronCiCachePlan(null, { RUNNER_TEMP: "/fixture/tmp" }, "44.0.0");
    let seeded = 0;
    const result = await prepareElectronCiRuntime(null, plan, () => "/official/electron", async () => {
      seeded += 1;
      return "/cache/archive.zip";
    });
    expect(plan).toEqual({ eligible: false, key: "", path: "", version: "44.0.0" });
    expect(result).toEqual({ electron: "/official/electron", cacheReady: false });
    expect(seeded).toBe(0);
    await expect(prepareElectronCiRuntime(null, plan, () => {
      throw new Error("official Electron install failed");
    })).rejects.toThrow("official Electron install failed");
  });

  it("keeps a healthy installed runtime when no reusable archive exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "omb-electron-cache-"));
    const previous = process.env.electron_config_cache;
    try {
      const locked = recovery();
      const plan = electronCiCachePlan(locked, { OMB_ELECTRON_CACHE_ROOT: root });
      const result = await prepareElectronCiRuntime(locked, plan, () => "/installed/electron");
      expect(result).toEqual({ electron: "/installed/electron", cacheReady: false });
      expect(process.env.electron_config_cache).toBe(plan.path);
    } finally {
      if (previous === undefined) delete process.env.electron_config_cache;
      else process.env.electron_config_cache = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seeds the canonical official URL from a verified mirror archive", async () => {
    const root = await mkdtemp(join(tmpdir(), "omb-electron-cache-"));
    try {
      const locked = recovery();
      const mirror = electronCachePath(root, `https://npmmirror.com/mirrors/electron/43.7.9/${locked.archive}`, locked.archive);
      await mkdir(dirname(mirror), { recursive: true });
      await writeFile(mirror, "official electron bytes");
      const canonical = await seedElectronArchiveCache(locked, root);
      expect(canonical).toBe(electronCachePath(root, electronDownloadUrl(locked), locked.archive));
      expect(await readFile(canonical, "utf8")).toBe("official electron bytes");
      expect(digest(await readFile(canonical))).toBe(locked.digest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cleans an invalid cached copy without seeding it", async () => {
    const root = await mkdtemp(join(tmpdir(), "omb-electron-cache-"));
    try {
      const locked = recovery();
      const cached = electronCachePath(root, electronDownloadUrl(locked), locked.archive);
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(cached, "not official bytes");
      await expect(seedElectronArchiveCache(locked, root)).resolves.toBeNull();
      await expect(readFile(cached)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses @electron/get 5.1.0 cache validation and redownloads an invalid entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "omb-electron-get-"));
    try {
      const get = await import(pathToFileURL(join(getDirectory, "index.js")).href);
      const cacheModule = await import(pathToFileURL(join(getDirectory, "Cache.js")).href);
      const { getArtifactRemoteURL } = await import(pathToFileURL(join(getDirectory, "artifact-utils.js")).href);
      const bytes = "checksum-verified fixture";
      const archive = "electron-ci-fixture.zip";
      const details = {
        isGeneric: true,
        version: "43.7.9",
        artifactName: archive,
        checksums: { [archive]: digest(bytes) },
        cacheRoot: root,
        mirrorOptions: { mirror: "https://fixture.invalid/", customDir: "{{ version }}" },
      };
      const url = await getArtifactRemoteURL(details);
      const cache = new cacheModule.Cache(root);
      const cached = cache.getCachePath(url, archive);
      await mkdir(dirname(cached), { recursive: true });
      await writeFile(cached, "corrupt");
      let downloads = 0;
      const downloader = {
        async download(_url, destination) {
          downloads += 1;
          await writeFile(destination, bytes);
        },
      };
      const repaired = await get.downloadArtifact({ ...details, downloader });
      expect(await readFile(repaired, "utf8")).toBe(bytes);
      expect(downloads).toBe(1);
      expect(await readFile(cached, "utf8")).toBe(bytes);
      const reused = await get.downloadArtifact({
        ...details,
        downloader: { download: () => { throw new Error("valid cache must avoid download"); } },
      });
      expect(await readFile(reused, "utf8")).toBe(bytes);
      expect(downloads).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
