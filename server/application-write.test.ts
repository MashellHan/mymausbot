import { beforeEach, describe, expect, it } from "vitest";
import { applicationDatabase, closeMessageDb, withApplicationWrite } from "./message-db.ts";

describe("durable application writes", () => {
  beforeEach(() => {
    closeMessageDb();
    applicationDatabase().exec("DROP TABLE IF EXISTS application_write_probe; CREATE TABLE application_write_probe (value TEXT)");
  });

  it("commits the returned value under FULL synchronization and restores the normal mode", () => {
    const result = withApplicationWrite((db) => {
      expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
      db.prepare("INSERT INTO application_write_probe VALUES (?)").run("persisted");
      return 42;
    });
    expect(result).toBe(42);
    expect(applicationDatabase().prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    closeMessageDb();
    expect(applicationDatabase().prepare("SELECT * FROM application_write_probe").all()).toEqual([{ value: "persisted" }]);
  });

  it("rolls back failed writes and rejects nested durable transactions", () => {
    expect(() => withApplicationWrite((db) => {
      db.prepare("INSERT INTO application_write_probe VALUES (?)").run("discarded");
      withApplicationWrite(() => undefined);
    })).toThrow("cannot join another transaction");
    expect(applicationDatabase().isTransaction).toBe(false);
    expect(applicationDatabase().prepare("SELECT * FROM application_write_probe").all()).toEqual([]);
    expect(applicationDatabase().prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
  });
});
