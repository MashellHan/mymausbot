import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { DataCatalog } from "./catalog.ts";

const fixtures: Array<{ db: DatabaseSync; dir: string }> = [];

function withWrite<T>(db: DatabaseSync, write: (db: DatabaseSync) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = write(db); db.exec("COMMIT"); return result; }
  catch (error) {
    try { db.exec("ROLLBACK"); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Catalog write and rollback failed", { cause: error });
    }
    throw error;
  }
}

function catalog(): DataCatalog {
  const dir = mkdtempSync(join(tmpdir(), "omb-data-catalog-"));
  const db = new DatabaseSync(join(dir, "messages.db"));
  fixtures.push({ db, dir });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  return new DataCatalog({
    getDatabase: () => db,
    withWrite: (write) => withWrite(db, write),
  });
}

afterEach(() => {
  for (const { db, dir } of fixtures.splice(0)) {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Data catalog", () => {
  it("preserves the first write error after a successful rollback", () => {
    const db = catalog().currentDatabase();
    db.exec("CREATE TABLE write_probe (value INTEGER)");
    const primary = Object.assign(new Error("first write failed"), { code: "EIO" });
    let caught: unknown;
    try { withWrite(db, (active) => { active.exec("INSERT INTO write_probe VALUES (1)"); throw primary; }); }
    catch (error) { caught = error; }
    expect(caught).toBe(primary);
    expect(db.prepare("SELECT COUNT(*) AS count FROM write_probe").get()).toMatchObject({ count: 0 });
    withWrite(db, (active) => active.exec("INSERT INTO write_probe VALUES (2)"));
    expect(db.prepare("SELECT value FROM write_probe").get()).toMatchObject({ value: 2 });
  });

  it("retains the first error and the rollback error when both fail", () => {
    const db = catalog().currentDatabase();
    const primary = Object.assign(new Error("first write failed"), { code: "EIO" });
    const primaryStack = primary.stack;
    let caught: unknown;
    try { withWrite(db, (active) => { active.exec("ROLLBACK"); throw primary; }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    const combined = caught as AggregateError;
    expect(combined.cause).toBe(primary);
    expect(combined.errors[0]).toBe(primary);
    expect(combined.errors[0].code).toBe("EIO");
    expect(combined.errors[0].stack).toBe(primaryStack);
    expect(combined.errors[1]).toMatchObject({ message: "cannot rollback - no transaction is active" });
  });

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
        withWrite: (write) => withWrite(active, write),
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
