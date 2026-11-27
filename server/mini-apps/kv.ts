import type { DatabaseSync } from "node:sqlite";
import { MINI_APPS_OWNER, ensureMiniApps, type MiniAppActor } from "./registry.ts";
import { appFailure } from "./validation.ts";

export const MINI_APP_KV_NAMESPACES = ["prefs", "view-state"] as const;
export type MiniAppKvNamespace = typeof MINI_APP_KV_NAMESPACES[number];

export const MINI_APP_KV_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
export const MINI_APP_KV_MAX_VALUE_BYTES = 4 * 1024;
export const MINI_APP_KV_MAX_KEYS_PER_APP = 64;
export const MINI_APP_KV_MAX_BYTES_PER_APP = 64 * 1024;
export const MINI_APP_KV_MAX_WRITES_PER_MINUTE = 60;

const kvInitialized = new WeakSet<DatabaseSync>();

export function ensureMiniAppKv(db: DatabaseSync): void {
  if (kvInitialized.has(db)) return;
  ensureMiniApps(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS mini_app_kv (
      owner_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      namespace TEXT NOT NULL CHECK(namespace IN ('prefs', 'view-state')),
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(owner_id, app_id, namespace, key),
      FOREIGN KEY(app_id) REFERENCES mini_apps(id) ON DELETE CASCADE
    );
  `);
  kvInitialized.add(db);
}

export interface MiniAppKvSnapshot {
  appId: string;
  namespace: MiniAppKvNamespace;
  entries: Record<string, unknown>;
  totalBytes: number;
  keyCount: number;
}

function validateNamespace(raw: unknown): MiniAppKvNamespace {
  if (raw === undefined || raw === "prefs") return "prefs";
  if (raw === "view-state") return "view-state";
  throw appFailure(400, "KV namespace must be 'prefs' or 'view-state'.", "invalid_kv_namespace");
}

function validateKey(key: string): string {
  if (typeof key !== "string" || !MINI_APP_KV_KEY_PATTERN.test(key)) {
    throw appFailure(400, `Invalid KV key '${String(key).slice(0, 32)}'.`, "invalid_kv_key");
  }
  return key;
}

function assertActiveOwnerApp(db: DatabaseSync, actor: MiniAppActor, appId: string, expectedRevision?: number): void {
  actor.assertActive();
  if (actor.botId) {
    throw appFailure(403, "Only the local workspace owner can access Mini App preferences storage.", "kv_owner_only");
  }
  const row = db.prepare("SELECT status, revision FROM mini_apps WHERE owner_id = ? AND id = ?").get(MINI_APPS_OWNER, appId) as { status: string; revision: number } | undefined;
  if (!row) throw appFailure(404, "Mini App not found.");
  if (row.status !== "active") throw appFailure(409, "Archived Mini Apps cannot read or modify preferences.", "app_archived");
  if (expectedRevision !== undefined && row.revision !== expectedRevision) {
    throw appFailure(409, "Mini App revision changed. Refresh and try again.", "revision_conflict");
  }
}

export class MiniAppKvStore {
  private readonly writeRates = new Map<string, number[]>();
  private readonly dbAccess: { database(): DatabaseSync; write<T>(work: (db: DatabaseSync) => T): T };

  constructor(dbAccess: { database(): DatabaseSync; write<T>(work: (db: DatabaseSync) => T): T }) {
    this.dbAccess = dbAccess;
  }

  private checkWriteRate(appId: string, now: number): void {
    const recent = (this.writeRates.get(appId) ?? []).filter((ts) => now - ts < 60_000);
    if (recent.length >= MINI_APP_KV_MAX_WRITES_PER_MINUTE) {
      throw appFailure(429, "Too many preference writes. Wait a minute and try again.", "kv_rate_limited");
    }
    recent.push(now);
    this.writeRates.set(appId, recent);
  }

  get(actor: MiniAppActor, appId: string, options: { namespace?: unknown; keys?: string[]; expectedRevision?: number } = {}): MiniAppKvSnapshot {
    const namespace = validateNamespace(options.namespace);
    const db = this.dbAccess.database();
    ensureMiniAppKv(db);
    assertActiveOwnerApp(db, actor, appId, options.expectedRevision);
    const requestedKeys = options.keys ? options.keys.map(validateKey) : null;
    const rows = db.prepare(
      "SELECT key, value_json, byte_length FROM mini_app_kv WHERE owner_id = ? AND app_id = ? AND namespace = ? ORDER BY key ASC",
    ).all(MINI_APPS_OWNER, appId, namespace) as Array<{ key: string; value_json: string; byte_length: number }>;
    const keySet = requestedKeys ? new Set(requestedKeys) : null;
    const entries: Record<string, unknown> = {};
    let totalBytes = 0;
    let keyCount = 0;
    for (const row of rows) {
      totalBytes += row.byte_length;
      keyCount += 1;
      if (keySet && !keySet.has(row.key)) continue;
      try {
        entries[row.key] = JSON.parse(row.value_json);
      } catch {
        entries[row.key] = null;
      }
    }
    return { appId, namespace, entries, totalBytes, keyCount };
  }

  set(
    actor: MiniAppActor,
    appId: string,
    input: { namespace?: unknown; entries: Record<string, unknown>; expectedRevision?: number },
    now = Date.now(),
  ): MiniAppKvSnapshot {
    if (!actor.writeAllowed) throw appFailure(403, "This actor cannot modify Mini App preferences.");
    const namespace = validateNamespace(input.namespace);
    if (!input.entries || typeof input.entries !== "object" || Array.isArray(input.entries)) {
      throw appFailure(400, "KV entries must be a key-value object.");
    }
    const pairs = Object.entries(input.entries);
    if (pairs.length === 0) {
      return this.get(actor, appId, { namespace, expectedRevision: input.expectedRevision });
    }
    if (pairs.length > MINI_APP_KV_MAX_KEYS_PER_APP) {
      throw appFailure(413, `A single write may update at most ${MINI_APP_KV_MAX_KEYS_PER_APP} keys.`, "kv_quota_exceeded");
    }
    const serialized: Array<{ key: string; json: string; bytes: number }> = [];
    for (const [rawKey, value] of pairs) {
      const key = validateKey(rawKey);
      let json: string;
      try {
        json = JSON.stringify(value === undefined ? null : value);
      } catch {
        throw appFailure(400, `KV value for '${key}' is not JSON-serializable.`);
      }
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > MINI_APP_KV_MAX_VALUE_BYTES) {
        throw appFailure(413, `KV value for '${key}' exceeds the 4 KiB per-key limit.`, "kv_quota_exceeded");
      }
      serialized.push({ key, json, bytes });
    }

    return this.dbAccess.write((db) => {
      ensureMiniAppKv(db);
      assertActiveOwnerApp(db, actor, appId, input.expectedRevision);
      this.checkWriteRate(appId, now);

      const existingRows = db.prepare(
        "SELECT namespace, key, byte_length FROM mini_app_kv WHERE owner_id = ? AND app_id = ?",
      ).all(MINI_APPS_OWNER, appId) as Array<{ namespace: string; key: string; byte_length: number }>;

      const sizes = new Map<string, number>();
      for (const row of existingRows) {
        sizes.set(`${row.namespace}:${row.key}`, row.byte_length);
      }
      for (const item of serialized) {
        sizes.set(`${namespace}:${item.key}`, item.bytes);
      }
      if (sizes.size > MINI_APP_KV_MAX_KEYS_PER_APP) {
        throw appFailure(413, `Mini App KV storage is limited to ${MINI_APP_KV_MAX_KEYS_PER_APP} keys.`, "kv_quota_exceeded");
      }
      let nextTotalBytes = 0;
      for (const size of sizes.values()) nextTotalBytes += size;
      if (nextTotalBytes > MINI_APP_KV_MAX_BYTES_PER_APP) {
        throw appFailure(413, "Mini App KV storage exceeds the 64 KiB per-app quota.", "kv_quota_exceeded");
      }

      const upsert = db.prepare(`
        INSERT INTO mini_app_kv (owner_id, app_id, namespace, key, value_json, byte_length, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, app_id, namespace, key)
        DO UPDATE SET value_json = excluded.value_json, byte_length = excluded.byte_length, updated_at = excluded.updated_at
      `);
      for (const item of serialized) {
        upsert.run(MINI_APPS_OWNER, appId, namespace, item.key, item.json, item.bytes, now);
      }
      return this.get(actor, appId, { namespace });
    });
  }

  delete(
    actor: MiniAppActor,
    appId: string,
    input: { namespace?: unknown; keys: string[]; expectedRevision?: number },
    now = Date.now(),
  ): MiniAppKvSnapshot {
    if (!actor.writeAllowed) throw appFailure(403, "This actor cannot modify Mini App preferences.");
    const namespace = validateNamespace(input.namespace);
    if (!Array.isArray(input.keys)) throw appFailure(400, "KV keys must be an array of strings.");
    const keys = input.keys.map(validateKey);
    return this.dbAccess.write((db) => {
      ensureMiniAppKv(db);
      assertActiveOwnerApp(db, actor, appId, input.expectedRevision);
      this.checkWriteRate(appId, now);
      const del = db.prepare("DELETE FROM mini_app_kv WHERE owner_id = ? AND app_id = ? AND namespace = ? AND key = ?");
      for (const key of keys) {
        del.run(MINI_APPS_OWNER, appId, namespace, key);
      }
      return this.get(actor, appId, { namespace });
    });
  }

  deleteAllForApp(appId: string): void {
    this.dbAccess.write((db) => {
      ensureMiniAppKv(db);
      db.prepare("DELETE FROM mini_app_kv WHERE owner_id = ? AND app_id = ?").run(MINI_APPS_OWNER, appId);
    });
  }
}
