import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { electronRecovery, ensureElectronRuntime } from "./ensure-electron.mjs";

const require = createRequire(import.meta.url);
const GITHUB_RELEASES = "https://github.com/electron/electron/releases/download/";

function packageRecovery(platform = process.platform, arch = process.arch) {
  const entry = realpathSync(require.resolve("electron"));
  const packageDir = dirname(entry);
  const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const checksums = JSON.parse(readFileSync(join(packageDir, "checksums.json"), "utf8"));
  return { version, recovery: electronRecovery(version, platform, arch, checksums) };
}

function archiveVersion(recovery) {
  return recovery.archive.slice("electron-v".length, -`-${recovery.platform}-${recovery.arch}.zip`.length);
}

export function electronCiCachePlan(recovery, env = process.env, version = recovery ? archiveVersion(recovery) : undefined) {
  if (!recovery) return { eligible: false, key: "", path: "", version };
  const key = `electron-archive-v1-${recovery.platform}-${recovery.arch}-${recovery.archive}-${recovery.digest}`;
  const temporaryRoot = env.RUNNER_TEMP ? resolve(env.RUNNER_TEMP) : tmpdir();
  const base = env.OMB_ELECTRON_CACHE_ROOT ? resolve(env.OMB_ELECTRON_CACHE_ROOT) : join(temporaryRoot, "openmausbot-electron-cache");
  return { eligible: true, key, path: join(base, key), version: version ?? archiveVersion(recovery) };
}

export function electronDownloadUrl(recovery) {
  return `${GITHUB_RELEASES}v${recovery.archive.slice("electron-v".length, -`-${recovery.platform}-${recovery.arch}.zip`.length)}/${recovery.archive}`;
}

export function electronCachePath(cacheRoot, downloadUrl, fileName) {
  const url = new URL(downloadUrl);
  url.hash = "";
  url.search = "";
  url.pathname = posix.dirname(url.pathname);
  const directory = createHash("sha256").update(url.toString()).digest("hex");
  return join(cacheRoot, directory, fileName);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function archivesBelow(root, fileName, found = []) {
  if (!statSync(root, { throwIfNoEntry: false })) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) archivesBelow(path, fileName, found);
    else if (entry.isFile() && entry.name === fileName) found.push(path);
  }
  return found;
}

export async function seedElectronArchiveCache(recovery, cacheRoot) {
  const canonical = electronCachePath(cacheRoot, electronDownloadUrl(recovery), recovery.archive);
  const candidates = archivesBelow(cacheRoot, recovery.archive);
  for (const candidate of candidates) {
    if (await sha256(candidate) !== recovery.digest) {
      await rm(candidate, { force: true });
      continue;
    }
    if (candidate === canonical) return canonical;
    await mkdir(dirname(canonical), { recursive: true });
    const temporary = `${canonical}.omb-${process.pid}`;
    await rm(temporary, { force: true });
    await copyFile(candidate, temporary);
    if (await sha256(temporary) !== recovery.digest) {
      await rm(temporary, { force: true });
      throw new Error(`Copied Electron cache entry failed checksum: ${recovery.archive}`);
    }
    await rm(canonical, { force: true });
    await rename(temporary, canonical);
    return canonical;
  }
  return null;
}

function setCacheRoot(cacheRoot) {
  for (const name of Object.keys(process.env)) {
    if (name.toLowerCase() === "electron_config_cache") delete process.env[name];
  }
  process.env.electron_config_cache = cacheRoot;
}

export function writeElectronCacheOutputs(plan, output = process.env.GITHUB_OUTPUT) {
  if (!output) return;
  appendFileSync(output, `eligible=${plan.eligible}\nkey=${plan.key}\npath=${plan.path}\nversion=${plan.version}\n`);
}

export async function prepareElectronCiRuntime(
  recovery,
  plan,
  ensure = ensureElectronRuntime,
  seed = seedElectronArchiveCache,
) {
  if (recovery) {
    setCacheRoot(plan.path);
    console.log(`Electron runtime cache: ${plan.key}`);
  } else {
    console.log(`Electron runtime cache: disabled for ${plan.version}`);
  }
  const electron = ensure();
  if (!recovery) return { electron, cacheReady: false };
  const cached = await seed(recovery, plan.path);
  if (!cached) return { electron, cacheReady: false };
  if (await sha256(cached) !== recovery.digest) throw new Error(`The canonical Electron cache entry has the wrong checksum: ${cached}`);
  return { electron, cacheReady: true };
}

async function main() {
  const installed = packageRecovery();
  const plan = electronCiCachePlan(installed.recovery, process.env, installed.version);
  if (process.argv.includes("--plan")) return writeElectronCacheOutputs(plan);
  const result = await prepareElectronCiRuntime(installed.recovery, plan);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `cache-ready=${result.cacheReady}\n`);
  console.log(`Electron runtime ready: ${result.electron}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
