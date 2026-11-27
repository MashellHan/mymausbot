import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  MINI_APP_KV_MAX_BYTES_PER_APP,
  MINI_APP_KV_MAX_KEYS_PER_APP,
  MINI_APP_KV_MAX_VALUE_BYTES,
  MINI_APP_KV_MAX_WRITES_PER_MINUTE,
  MiniAppKvStore,
} from "./kv.ts";
import { MINI_APPS_OWNER, ensureMiniApps, type MiniAppActor } from "./registry.ts";

function setupDb() {
  const db = new DatabaseSync(":memory:");
  ensureMiniApps(db);
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO mini_apps (id, owner_id, slug, title, description, status, revision, template_version, publishers, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `);
  insert.run("11111111-1111-4111-8111-111111111111", MINI_APPS_OWNER, "app-a", "App A", "desc", "active", 2, 1, now, now);
  insert.run("22222222-2222-4222-8222-222222222222", MINI_APPS_OWNER, "app-b", "App B", "desc", "active", 1, 1, now, now);
  insert.run("33333333-3333-4333-8333-333333333333", MINI_APPS_OWNER, "app-archived", "Archived", "desc", "archived", 3, 1, now, now);
  const store = new MiniAppKvStore({
    database: () => db,
    write: (fn) => fn(db),
  });
  const owner: MiniAppActor = { writeAllowed: true, assertActive: () => {}, canBind: () => true };
  const bot: MiniAppActor = { botId: "bot-1", writeAllowed: true, assertActive: () => {}, canBind: () => true };
  return { db, store, owner, bot };
}

describe("MiniAppKvStore", () => {
  it("stores, reads, filters, and deletes scoped per-app preferences with cross-app isolation", () => {
    const { store, owner } = setupDb();
    const appA = "11111111-1111-4111-8111-111111111111";
    const appB = "22222222-2222-4222-8222-222222222222";

    store.set(owner, appA, { entries: { theme: "compact", sort: ["date", "desc"] }, expectedRevision: 2 });
    store.set(owner, appB, { entries: { theme: "expanded" }, expectedRevision: 1 });

    expect(store.get(owner, appA).entries).toEqual({ theme: "compact", sort: ["date", "desc"] });
    expect(store.get(owner, appA, { keys: ["theme"] }).entries).toEqual({ theme: "compact" });
    expect(store.get(owner, appB).entries).toEqual({ theme: "expanded" });

    store.delete(owner, appA, { keys: ["sort"], expectedRevision: 2 });
    expect(store.get(owner, appA).entries).toEqual({ theme: "compact" });
    expect(store.get(owner, appB).entries).toEqual({ theme: "expanded" });
  });

  it("enforces key regex, 4 KiB value limit, 64 keys / 64 KiB per-app quota, and 60 writes/min rate limit", () => {
    const { store, owner } = setupDb();
    const appA = "11111111-1111-4111-8111-111111111111";

    expect(() => store.set(owner, appA, { entries: { "bad key!": 1 } })).toThrow(/Invalid KV key/);
    expect(() => store.set(owner, appA, { entries: { big: "a".repeat(MINI_APP_KV_MAX_VALUE_BYTES + 10) } })).toThrow(/4 KiB/);

    // Exceed 64 KiB total quota across 20 keys of ~3.5 KiB each
    const bigEntries: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      bigEntries[`k${i}`] = "x".repeat(3500);
    }
    expect(Object.keys(bigEntries).length * 3500).toBeGreaterThan(MINI_APP_KV_MAX_BYTES_PER_APP);
    expect(() => store.set(owner, appA, { entries: bigEntries })).toThrow(/64 KiB/);

    // Exceed 64 keys limit
    const tooMany: Record<string, number> = {};
    for (let i = 0; i < MINI_APP_KV_MAX_KEYS_PER_APP; i += 1) tooMany[`key_${i}`] = i;
    store.set(owner, appA, { entries: tooMany }, 1000);
    expect(() => store.set(owner, appA, { entries: { key_extra: 1 } }, 1001)).toThrow(/64 keys/);

    // Rate limit 60 writes/min
    const appB = "22222222-2222-4222-8222-222222222222";
    for (let i = 0; i < MINI_APP_KV_MAX_WRITES_PER_MINUTE; i += 1) {
      store.set(owner, appB, { entries: { counter: i } }, 5000 + i);
    }
    expect(() => store.set(owner, appB, { entries: { counter: 999 } }, 5000 + MINI_APP_KV_MAX_WRITES_PER_MINUTE)).toThrow(/Too many preference writes/);
  });

  it("blocks bots, archived apps, and stale revisions", () => {
    const { store, owner, bot } = setupDb();
    const appA = "11111111-1111-4111-8111-111111111111";
    const archived = "33333333-3333-4333-8333-333333333333";

    expect(() => store.get(bot, appA)).toThrow(/Only the local workspace owner/);
    expect(() => store.set(bot, appA, { entries: { x: 1 } })).toThrow(/Only the local workspace owner/);
    expect(() => store.get(owner, archived)).toThrow(/Archived Mini Apps/);
    expect(() => store.set(owner, appA, { entries: { x: 1 }, expectedRevision: 99 })).toThrow(/revision changed/);
  });
});
