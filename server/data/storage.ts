import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { validDataId } from "./catalog.ts";
import { DataFailure, type DataSnapshotManifest } from "./types.ts";

export const DATA_DB_FILE = "data.duckdb";
export const DATA_TMP_DIR = "data-tmp";

export function storeFolder(dataDir: string, storeId: string): string {
  if (!validDataId(storeId)) throw new Error("Invalid Data store identity.");
  return join(dataDir, "stores", storeId);
}

export function storeFile(dataDir: string, storeId: string): string {
  return join(storeFolder(dataDir, storeId), DATA_DB_FILE);
}

export function retainedStoreFile(folder: string): string {
  const file = join(folder, DATA_DB_FILE);
  try { const stat = lstatSync(file); if (stat.isFile() && stat.size > 0) return file; } catch {}
  throw new DataFailure({ code: "engine_unavailable", message: "Retained Data store is missing or is not a regular file." });
}

export async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function syncPath(path: string): void {
  // Node 24.22.2 on Windows uses FlushFileBuffers for fsync; it requires GENERIC_WRITE.
  const fd = openSync(path, process.platform === "win32" ? "r+" : "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path: string): void {
  // Windows cannot open directories through Node's file descriptor API; the file is synced and the source survives until the catalog switch.
  if (process.platform !== "win32") syncPath(path);
}

export async function durableCopy(source: string, target: string): Promise<string> {
  if (!lstatSync(source).isFile()) throw new Error("Data source is not a regular file.");
  if (existsSync(target)) throw new Error("Data snapshot target already exists.");
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  await copyFile(source, target);
  syncPath(target);
  const [original, copied] = await Promise.all([fileHash(source), fileHash(target)]);
  if (original !== copied) throw new Error("Data snapshot verification failed.");
  syncDirectory(parent);
  return copied;
}

export async function durablePromote(source: string, dataDir: string, storeId: string): Promise<string> {
  const finalDir = storeFolder(dataDir, storeId);
  const candidateDir = `${finalDir}.candidate`;
  if (existsSync(candidateDir) || existsSync(finalDir)) throw new Error("Data promotion destination already exists.");
  const parent = dirname(finalDir);
  mkdirSync(candidateDir, { recursive: true, mode: 0o700 });
  const sha256 = await durableCopy(source, join(candidateDir, DATA_DB_FILE));
  syncDirectory(candidateDir);
  renameSync(candidateDir, finalDir);
  syncDirectory(parent);
  return sha256;
}

export async function removeSourceStore(folder: string): Promise<void> {
  for (const name of [DATA_DB_FILE, `${DATA_DB_FILE}.wal`, DATA_TMP_DIR]) {
    await rm(join(folder, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

export async function verifyDataSnapshot(directory: string, manifest: DataSnapshotManifest): Promise<void> {
  if (manifest?.version !== 1 || !Array.isArray(manifest.stores)) throw new Error("Invalid Data snapshot manifest.");
  const seen = new Set<string>();
  for (const entry of manifest.stores) {
    if (!validDataId(entry.datasetId) || !validDataId(entry.storeId) || seen.has(entry.storeId) ||
        entry.path !== `stores/${entry.storeId}/${DATA_DB_FILE}` || !Number.isSafeInteger(entry.revision) || entry.revision < 0 ||
        !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error("Invalid Data snapshot store entry.");
    seen.add(entry.storeId);
    const folder = join(directory, "stores", entry.storeId);
    const file = join(folder, DATA_DB_FILE);
    if (!lstatSync(folder).isDirectory() || !lstatSync(file).isFile() || await fileHash(file) !== entry.sha256) {
      throw new Error("Data snapshot store verification failed.");
    }
  }
}
