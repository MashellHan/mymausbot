import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { readLocalAntigravityConfig, resolveLocalAntigravityCli } from "./antigravity-local.ts";
import { resolveAntigravityRuntime, retryOnWindowsFileLock, transientWindowsFileError } from "./antigravity-runtime.ts";

const withCode = (code: string) => Object.assign(new Error(code), { code });
const scratch: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function makeExecutable(directory: string, name: string, content = "#!/bin/sh\nexit 0\n"): string {
  const file = join(directory, name);
  writeFileSync(file, content);
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return file;
}

afterEach(async () => {
  while (scratch.length) await removeTempDir(scratch.pop()!);
});

describe("installing the Antigravity runtime on Windows", () => {
  it("knows the refusals Windows gives for a file something still holds open", () => {
    for (const code of ["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]) expect(transientWindowsFileError(withCode(code)), code).toBe(true);
    expect(transientWindowsFileError(withCode("ENOENT"))).toBe(false);
    expect(transientWindowsFileError(new Error("plain"))).toBe(false);
    expect(transientWindowsFileError(null)).toBe(false);
  });

  it("retries a rename that Windows refuses while the runtime is still exiting, with growing delays", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retryOnWindowsFileLock(
      async () => {
        calls += 1;
        if (calls < 3) throw withCode("EPERM");
        return "renamed";
      },
      { sleep: async (ms) => { delays.push(ms); } },
    );
    expect(result).toBe("renamed");
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("gives up after the attempts with the original error, and never retries other errors", async () => {
    let calls = 0;
    await expect(retryOnWindowsFileLock(async () => {
      calls += 1;
      throw withCode("EBUSY");
    }, { attempts: 4, sleep: async () => {} })).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(4);

    calls = 0;
    await expect(retryOnWindowsFileLock(async () => {
      calls += 1;
      throw withCode("ENOENT");
    }, { sleep: async () => {} })).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("caps the delay at two seconds so a long lock does not turn into a long wait per attempt", async () => {
    const delays: number[] = [];
    await expect(retryOnWindowsFileLock(async () => {
      throw withCode("EPERM");
    }, { attempts: 8, sleep: async (ms) => { delays.push(ms); } })).rejects.toMatchObject({ code: "EPERM" });
    expect(delays).toEqual([250, 500, 1000, 2000, 2000, 2000, 2000]);
  });

});

describe("local agy CLI detection and configuration", () => {
  it("reports unconfigured when no local Gemini API-key setup exists", async () => {
    const home = makeTempDir("omb-agy-local-empty-");
    const config = await readLocalAntigravityConfig({ HOME: home, PATH: "" });
    expect(config.configured).toBe(false);
    expect(config.baseUrl).toBeUndefined();
    expect(config.modelContextWindows.size).toBe(0);
    expect(await resolveLocalAntigravityCli({ HOME: home, PATH: home })).toBeNull();
  });

  it("reads ~/.gemini/.env and customModelsConfig without returning API key values", async () => {
    const home = makeTempDir("omb-agy-local-cfg-");
    const geminiDir = join(home, ".gemini");
    const cliDir = join(geminiDir, "antigravity-cli");
    mkdirSync(cliDir, { recursive: true });
    const sentinelKey = "synthetic-secret-must-never-appear";
    writeFileSync(join(geminiDir, ".env"), [
      "# local proxy config",
      `GEMINI_API_KEY="${sentinelKey}"`,
      `GOOGLE_GEMINI_BASE_URL='http://127.0.0.1:7024'`,
    ].join("\n"));
    writeFileSync(join(cliDir, "settings.json"), JSON.stringify({
      customModelsConfig: {
        customModels: {
          "gemini-4-neon-256k": {
            maxTokens: 262144,
            modelName: "gemini-api://127.0.0.1:7024/models/gemini-4-neon",
          },
          "gemini-4-neon-1m": {
            maxTokens: 1048576.9,
            modelName: "gemini-api://127.0.0.1:7024/models/gemini-4-neon",
          },
          "gemini-4-carbon": {
            maxTokens: 524288,
            modelName: "gemini-api://127.0.0.1:7024/models/gemini-4-carbon",
          },
        },
      },
    }));

    const config = await readLocalAntigravityConfig({ HOME: home });
    expect(config.configured).toBe(true);
    expect(config.baseUrl).toBe("http://127.0.0.1:7024");
    expect(config.modelContextWindows.get("gemini-4-neon")).toBe(1048576);
    expect(config.modelContextWindows.get("gemini-4-carbon")).toBe(524288);
    expect(JSON.stringify(config)).not.toContain(sentinelKey);

    const overridden = await readLocalAntigravityConfig({
      HOME: home,
      AGY_RAVEN_BASE_URL: "http://127.0.0.1:9000",
    });
    expect(overridden.baseUrl).toBe("http://127.0.0.1:9000");
  });

  it("derives loopback baseUrl from customModelsConfig and accepts gemini-api-key authType", async () => {
    const home = makeTempDir("omb-agy-local-derive-");
    const geminiDir = join(home, ".gemini");
    const cliDir = join(geminiDir, "antigravity-cli");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(geminiDir, "settings.json"), JSON.stringify({
      security: { auth: { selectedType: "gemini-api-key" } },
    }));
    writeFileSync(join(cliDir, "settings.json"), JSON.stringify({
      customModelsConfig: {
        customModels: {
          neon: {
            maxTokens: 1048576,
            modelName: "gemini-api://127.0.0.1:7024/models/gemini-4-neon",
          },
        },
      },
    }));

    // Missing API key must stay unconfigured even with baseUrl and authType present.
    expect((await readLocalAntigravityConfig({ HOME: home })).configured).toBe(false);

    const withKey = await readLocalAntigravityConfig({ HOME: home, GEMINI_API_KEY: "synthetic-key" });
    expect(withKey.configured).toBe(true);
    expect(withKey.baseUrl).toBe("http://127.0.0.1:7024");
  });

  it("resolves local agy only when both executable and local config exist, keeping official precedence", async () => {
    const dir = makeTempDir("omb-agy-runtime-local-");
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    const baseDir = join(dir, "data");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    const agyName = process.platform === "win32" ? "agy.cmd" : "agy";
    const agyPath = makeExecutable(bin, agyName);

    // Executable alone without local API-key config still fails with official setup error.
    await expect(resolveAntigravityRuntime("agy", { HOME: home, PATH: bin }, baseDir))
      .rejects.toMatchObject({ status: 409 });

    // Adding local API-key config enables local-cli resolution.
    writeFileSync(join(home, ".gemini", ".env"), 'GEMINI_API_KEY="synthetic"\nGOOGLE_GEMINI_BASE_URL="http://127.0.0.1:7024"\n');
    const local = await resolveAntigravityRuntime("agy", { HOME: home, PATH: bin }, baseDir);
    expect(local).toMatchObject({
      executablePath: agyPath,
      harnessPath: "",
      source: "local-cli",
      version: null,
      localBaseUrl: "http://127.0.0.1:7024",
    });

    // Unrecognized custom binary still fails rather than falling back to local agy.
    await expect(resolveAntigravityRuntime(join(dir, "custom-acp"), { HOME: home, PATH: bin }, baseDir))
      .rejects.toThrow(/custom Antigravity ACP executable/u);

    // Official agy_acp_server pair on PATH takes precedence over local agy.
    const officialName = process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
    const harnessName = process.platform === "win32" ? "localharness_external.exe" : "localharness_external";
    const officialPath = makeExecutable(bin, officialName);
    const harnessPath = makeExecutable(bin, harnessName);
    const preferred = await resolveAntigravityRuntime("agy", { HOME: home, PATH: bin }, baseDir);
    expect(preferred).toMatchObject({
      executablePath: officialPath,
      harnessPath,
      source: "path",
    });
  });

  it("prefers an explicit legacy agy path before scanning PATH", async () => {
    const dir = makeTempDir("omb-agy-runtime-preferred-");
    const home = join(dir, "home");
    const pathBin = join(dir, "path-bin");
    const customBin = join(dir, "custom-bin");
    const baseDir = join(dir, "data");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    mkdirSync(pathBin, { recursive: true });
    mkdirSync(customBin, { recursive: true });
    writeFileSync(join(home, ".gemini", ".env"), 'GEMINI_API_KEY="synthetic"\nGOOGLE_GEMINI_BASE_URL="http://127.0.0.1:7024"\n');
    const agyName = process.platform === "win32" ? "agy.cmd" : "agy";
    const pathAgy = makeExecutable(pathBin, agyName);
    const customAgy = makeExecutable(customBin, agyName);

    const direct = await resolveLocalAntigravityCli({ HOME: home, PATH: pathBin }, customAgy);
    expect(direct?.executablePath).toBe(customAgy);

    const resolved = await resolveAntigravityRuntime(customAgy, { HOME: home, PATH: pathBin }, baseDir);
    expect(resolved).toMatchObject({
      executablePath: customAgy,
      source: "local-cli",
    });

    // Missing explicit legacy path still falls back to PATH.
    const fallback = await resolveAntigravityRuntime(join(dir, "missing", agyName), { HOME: home, PATH: pathBin }, baseDir);
    expect(fallback).toMatchObject({
      executablePath: pathAgy,
      source: "local-cli",
    });
  });
});
