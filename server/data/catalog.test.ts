import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { DataCatalog } from "./catalog.ts";

const fixtures: Array<{ db: DatabaseSync; dir: string }> = [];

function catalog(): DataCatalog {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-catalog-"));
  const db = new DatabaseSync(join(dir, "messages.db"));
  fixtures.push({ db, dir });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  return new DataCatalog({
    getDatabase: () => db,
    withWrite: (write) => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = write(db); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  });
}

afterEach(() => {
  for (const { db, dir } of fixtures.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Data catalog", () => {
  it("switches a whole store and its bot alias atomically under one owner", () => {
    const data = catalog();
    const promotion = data.beginPromotion("producer", "owner-a");
    expect(data.forBot("producer")).toBeNull();
    expect(data.promotions()).toMatchObject([{ ...promotion, botId: "producer", phase: "copying", sha256: null }]);
    data.switchPromotion({ ...promotion, botId: "producer", sha256: "a".repeat(64) });
    expect(data.forBot("producer")).toEqual(promotion);
    expect(data.forDataset(promotion.datasetId, "owner-a")).toEqual(promotion);
    expect(data.forDataset(promotion.datasetId, "owner-b")).toBeNull();
    expect(data.promotions()[0]?.phase).toBe("switched");
    data.finishPromotion(promotion.storeId);
    data.detachBot("producer");
    expect(data.forBot("producer")).toBeNull();
    expect(data.forDataset(promotion.datasetId, "owner-a")).toEqual(promotion);
  });

  it("does not claim a store when a catalog switch fails", () => {
    const data = catalog();
    const promotion = data.beginPromotion("producer", "owner-a");
    expect(() => data.switchPromotion({ ...promotion, botId: "wrong", sha256: "b".repeat(64) })).toThrow(/journal changed/);
    expect(data.stores()).toEqual([]);
    expect(data.forBot("producer")).toBeNull();
    expect(data.promotions()[0]?.phase).toBe("copying");
  });

  it("initializes the catalog again when the owning SQLite handle is replaced", () => {
    const first = mkdtempSync(join(tmpdir(), "omb-data-catalog-first-"));
    const second = mkdtempSync(join(tmpdir(), "omb-data-catalog-restored-"));
    const original = new DatabaseSync(join(first, "messages.db"));
    const restored = new DatabaseSync(join(second, "messages.db"));
    let active = original;
    try {
      const data = new DataCatalog({
        getDatabase: () => active,
        withWrite: (write) => {
          active.exec("BEGIN IMMEDIATE");
          try { const result = write(active); active.exec("COMMIT"); return result; }
          catch (error) { active.exec("ROLLBACK"); throw error; }
        },
      });
      data.beginPromotion("producer", "owner");
      expect(data.promotions()).toHaveLength(1);
      active = restored;
      expect(data.promotions()).toEqual([]);
      expect(data.beginPromotion("another", "owner").storeId).toBeTypeOf("string");
    } finally {
      original.close(); restored.close();
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});
