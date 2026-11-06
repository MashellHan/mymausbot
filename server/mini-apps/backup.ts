import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDocs } from "../app-docs.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { DataEngine, DataSnapshotManifest } from "../data/types.ts";
import { closeMessageDb } from "../message-db.ts";

export const MINI_APP_SNAPSHOT_FILE = "mini-app-data.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

function fileHash(file: string): string {
  if (!lstatSync(file).isFile()) throw new Error("A Mini App snapshot contains a non-file store.");
  const hash = createHash("sha256");
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      hash.update(chunk.subarray(0, length));
    }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

/** The workspace maintenance gate remains held until every Data reader and writer, SQLite and resources are captured. */
export async function withMiniAppBackup<T>(dataDir: string, data: DataEngine, work: () => Promise<T>): Promise<T> {
  if (data.unavailable() !== null) {
    if (existsSync(join(dataDir, "stores"))) throw new Error("Data must be available to back up retained Mini App sources.");
    return work();
  }
  const backups = join(dataDir, ".backups");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(backups, "mini-app-data-"));
  const manifestPath = join(dataDir, MINI_APP_SNAPSHOT_FILE);
  try {
    return await data.withSnapshot(staging, async (manifest) => {
      closeMessageDb();
      writeFileAtomic(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      try { return await work(); }
      finally { rmSync(manifestPath, { force: true }); }
    });
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** A private local library cannot accompany a shared/team export, including its blobs in a shared content store. */
export function assertMiniAppExportPrivacy(dataDir: string, shared: boolean): void {
  if (!shared) return;
  const database = join(dataDir, "messages.db");
  if (!existsSync(database)) return;
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    if (["mini_apps", "mini_app_data_datasets"].some((table) => hasTable(db, table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())) {
      throw new Error("Local Mini Apps and their Data are private to the workspace owner and cannot be included in a shared team export.");
    }
  } finally { db.close(); }
}

/** Snapshot/restore validation rejects broken references before any workspace is replaced. */
export function verifyMiniAppSnapshot(dataDir: string): void {
  const database = join(dataDir, "messages.db");
  const storesDir = join(dataDir, "stores");
  if (!existsSync(database)) {
    if (existsSync(storesDir)) throw new Error("Mini App Data stores have no application catalog.");
    return;
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const datasets = hasTable(db, "mini_app_data_datasets") ? db.prepare("SELECT dataset_id, store_id, owner_id FROM mini_app_data_datasets").all() : [];
    const manifestPath = join(dataDir, MINI_APP_SNAPSHOT_FILE);
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as DataSnapshotManifest : undefined;
    if ((datasets.length || existsSync(storesDir)) && !manifest) throw new Error("Retained Data requires a coordinated snapshot manifest.");
    const stores = new Map<string, DataSnapshotManifest["stores"][number]>();
    const datasetIds = new Set<string>();
    if (manifest) {
      if (manifest.version !== 1 || !Array.isArray(manifest.stores) || manifest.stores.length !== datasets.length) throw new Error("Invalid Mini App Data snapshot manifest.");
      for (const entry of manifest.stores) {
        if (!UUID.test(entry.datasetId) || !UUID.test(entry.storeId) || stores.has(entry.storeId) || datasetIds.has(entry.datasetId) ||
            !Number.isSafeInteger(entry.revision) || entry.revision < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
            entry.path !== `stores/${entry.storeId}/data.duckdb`) throw new Error("Invalid Mini App Data snapshot entry.");
        const directory = join(storesDir, entry.storeId);
        if (!lstatSync(directory).isDirectory() || fileHash(join(directory, "data.duckdb")) !== entry.sha256 ||
            readdirSync(directory).some((name) => name !== "data.duckdb")) throw new Error("Mini App Data snapshot checksum or closed-store check failed.");
        stores.set(entry.storeId, entry);
        datasetIds.add(entry.datasetId);
      }
    }
    if (existsSync(storesDir) && (lstatSync(storesDir).isSymbolicLink() || readdirSync(storesDir).some((name) => !stores.has(name)))) {
      throw new Error("Unjournaled Data stores cannot enter a workspace backup.");
    }
    for (const dataset of datasets) {
      const entry = stores.get(String(dataset.store_id));
      if (!entry || entry.datasetId !== dataset.dataset_id || dataset.owner_id !== "workspace-owner") throw new Error("Mini App Data catalog references do not match the snapshot.");
    }
    if (hasTable(db, "mini_app_data_promotions") && db.prepare("SELECT 1 FROM mini_app_data_promotions LIMIT 1").get()) throw new Error("Finish Data promotion recovery before taking a backup.");
    if (!hasTable(db, "mini_apps")) return;
    const apps = db.prepare("SELECT id, template_version FROM mini_apps").all();
    if (apps.length && !hasTable(db, "mini_app_versions")) throw new Error("Mini App template history is missing.");
    if (!hasTable(db, "mini_app_versions")) return;
    const versions = db.prepare("SELECT app_id, version, doc, bindings FROM mini_app_versions").all();
    const docs = new AppDocs(join(dataDir, "app-docs"));
    for (const app of apps) if (!versions.some((version) => version.app_id === app.id && version.version === app.template_version)) throw new Error("A Mini App head references a missing template.");
    for (const version of versions) {
      if (!apps.some((app) => app.id === version.app_id) || !docs.read(String(version.doc))) throw new Error("A Mini App template is missing or corrupt.");
      const bindings = JSON.parse(String(version.bindings)) as Array<{ datasetId: string }>;
      if (!Array.isArray(bindings) || bindings.some((binding) => !binding || !datasetIds.has(binding.datasetId))) throw new Error("A Mini App template references missing Data.");
    }
  } finally { db.close(); }
}

export async function verifyMiniAppDataFiles(dataDir: string): Promise<void> {
  const manifestPath = join(dataDir, MINI_APP_SNAPSHOT_FILE);
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as DataSnapshotManifest;
  if (!manifest.stores.length) return;
  const { nativeRequire } = await import("../data/engine.ts");
  const binding = nativeRequire()("@duckdb/node-api") as typeof import("@duckdb/node-api");
  for (const entry of manifest.stores) {
    const instance = await binding.DuckDBInstance.create(join(dataDir, entry.path), {
      access_mode: "READ_ONLY", enable_external_access: "false", autoload_known_extensions: "false", autoinstall_known_extensions: "false", memory_limit: "128MiB", threads: "1",
    });
    try {
      const connection = await instance.connect();
      const timeout = setTimeout(() => connection.interrupt(), 10_000);
      try {
        const reader = await connection.runAndReadAll("SELECT revision FROM omb_data_internal.revision");
        const rows = reader.getRows();
        if (rows.length !== 1 || Number(rows[0]?.[0]) !== entry.revision) throw new Error("Data snapshot revision does not match its store.");
      } finally { clearTimeout(timeout); connection.disconnectSync(); }
    } finally { instance.closeSync(); }
  }
}
