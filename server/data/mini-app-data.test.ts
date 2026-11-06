import { mkdtempSync, mkdirSync, renameSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import * as DuckDB from "@duckdb/node-api";
import { afterEach, describe, expect, it } from "vitest";

import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import { createDataEngine } from "./engine.ts";
import { DataCatalog, type DataCatalogAccess } from "./catalog.ts";
import { DataSheetStore } from "./sheet.ts";
import { durablePromote, verifyDataSnapshot } from "./storage.ts";
import { loadData, type DataContext } from "./tools.ts";
import type { DataEngine } from "./types.ts";

const fixtures: Array<{ engines: DataEngine[]; databases: DatabaseSync[]; root: string }> = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-mini-app-data-"));
  const db = new DatabaseSync(join(root, "messages.db"));
  const databases = [db];
  let active = db;
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  const access: DataCatalogAccess = {
    getDatabase: () => active,
    withWrite: (write) => {
      active.exec("BEGIN IMMEDIATE");
      try { const result = write(active); active.exec("COMMIT"); return result; }
      catch (error) { active.exec("ROLLBACK"); throw error; }
    },
  };
  const makeEngine = () => createDataEngine({ botFolder: (id) => join(root, "bots", id), dataDir: root, binding: DuckDB, catalog: access });
  const engine = makeEngine();
  const engines = [engine];
  fixtures.push({ engines, databases, root });
  return {
    engine, root, catalog: new DataCatalog(access),
    makeEngine: () => { const next = makeEngine(); engines.push(next); return next; },
    replaceCatalog: async () => {
      const file = join(root, `restored-${databases.length}.db`);
      await backup(active, file);
      active = new DatabaseSync(file);
      databases.push(active);
    },
  };
}

afterEach(async () => {
  for (const { engines, databases, root } of fixtures.splice(0)) {
    for (const engine of engines) await engine.closeAll();
    for (const database of databases) database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const binding = (datasetId: string): MiniAppDataBinding => ({
  id: "ledger", datasetId, source: { schema: "main", table: "synthetic_ledger" },
  fields: {
    day: { column: "day_text", sourceType: "VARCHAR", as: "date" },
    amount: { column: "amount_text", sourceType: "VARCHAR", as: "decimal", scale: 2 },
    category: { column: "category_text", sourceType: "VARCHAR", as: "text" },
  },
  queries: {
    outflow: {
      kind: "aggregate", groupBy: ["category"], measures: [{ name: "amount", op: "sum", field: "amount" }],
      parameters: {}, filters: [{ field: "amount", op: "lt", literal: "0" }],
      orderBy: [{ field: "amount", direction: "asc" }], pageSize: 10,
    },
    quality: {
      kind: "aggregate", groupBy: [], measures: [
        { name: "allRows", op: "count" }, { name: "validAmounts", op: "count", field: "amount" },
        { name: "validDays", op: "count", field: "day" },
      ], parameters: {}, filters: [], orderBy: [], pageSize: 10,
    },
    rows: {
      kind: "rows", columns: ["day", "amount", "category"], parameters: {}, filters: [],
      orderBy: [{ field: "day", direction: "asc" }], pageSize: 1,
    },
    large: {
      kind: "rows", columns: ["amount"], parameters: {}, filters: [{ field: "category", op: "eq", literal: "Large" }],
      orderBy: [], pageSize: 10,
    },
  },
});

const firstRows = `CREATE TABLE synthetic_ledger AS SELECT * FROM (VALUES
  ('2025-01-02', '-0.10', 'Food'), ('2025-01-03', '-0.20', 'Food'),
  ('bad-date', 'not-an-amount', 'Unsorted'), ('2025-01-04', '0.40', 'Transfer'),
  ('2025-01-05', '1.005', 'Invalid'), ('2025-01-06', '9007199254740993.12', 'Large')
) AS rows(day_text, amount_text, category_text)`;

describe("promoted Mini App Data", () => {
  it("parses strict timestamp text as dates for coverage, filters and buckets", async () => {
    const { engine } = fixture();
    const writer = await engine.forBot("writer");
    await writer.run(`CREATE TABLE synthetic_ledger AS SELECT * FROM (VALUES
      ('2024-11-07 19:25:25', '-10.00', 'Food'), ('2026-11-06', '-2.00', 'Food'),
      ('2024-02-30 12:00:00', '-1.00', 'Invalid'), ('2025-01-01 99:99:99', '-1.00', 'Invalid'),
      ('05/11/2025', '-1.00', 'Ambiguous'), (NULL, '-1.00', 'Missing')
    ) AS rows(day_text, amount_text, category_text)`, { connection: "bot", businessMutation: true });
    await writer.run(`CREATE TABLE native_ledger AS SELECT * FROM (VALUES
      (TIMESTAMP '2024-11-07 19:25:25', DATE '2024-11-07', '-10.00', 'Food'),
      (TIMESTAMP '2026-11-06 00:00:00', DATE '2026-11-06', '-2.00', 'Food'),
      (NULL::TIMESTAMP, NULL::DATE, '-1.00', 'Missing')
    ) AS rows(native_timestamp, native_date, amount_text, category_text)`, { connection: "bot", businessMutation: true });
    const promoted = await engine.promoteForBot("writer", "owner");
    const dataBinding = binding(promoted.datasetId);
    dataBinding.queries.coverage = {
      kind: "aggregate", groupBy: [], measures: [
        { name: "dated", op: "count", field: "day" }, { name: "first", op: "min", field: "day" },
        { name: "last", op: "max", field: "day" },
      ], parameters: {}, filters: [], orderBy: [], pageSize: 10,
    };
    dataBinding.queries.selected = {
      kind: "rows", columns: ["day", "category"], parameters: { from: { type: "date" } },
      filters: [{ field: "day", op: "gte", parameter: "from" }], orderBy: [{ field: "day", direction: "asc" }], pageSize: 10,
    };
    dataBinding.queries.monthly = {
      kind: "aggregate", groupBy: [], timeBucket: { field: "day", unit: "month", name: "month" },
      measures: [{ name: "count", op: "count" }], parameters: {}, filters: [],
      orderBy: [{ field: "month", direction: "asc" }], pageSize: 10,
    };
    await engine.validateBinding("owner", dataBinding);
    const read = (queryId: string, parameters: Record<string, string> = {}) => engine.readNamed({
      ownerId: "owner", binding: dataBinding, queryId, parameters, scope: "app-mount",
    });
    expect((await read("coverage")).rows).toEqual([["2", "2024-11-07", "2026-11-06"]]);
    expect((await read("selected", { from: "2025-01-01" })).rows).toEqual([["2026-11-06", "Food"]]);
    expect((await read("monthly")).rows).toEqual([["2024-11-01", "1"], ["2026-11-01", "1"], [null, "4"]]);
    for (const [column, sourceType] of [["native_timestamp", "TIMESTAMP"], ["native_date", "DATE"]] as const) {
      const nativeBinding: MiniAppDataBinding = { ...dataBinding, source: { schema: "main", table: "native_ledger" },
        fields: { ...dataBinding.fields, day: { column, sourceType, as: "date" } } };
      await engine.validateBinding("owner", nativeBinding);
      expect((await engine.readNamed({ ownerId: "owner", binding: nativeBinding, queryId: "coverage", parameters: {}, scope: "app-mount" })).rows)
        .toEqual([["2", "2024-11-07", "2026-11-06"]]);
    }
  });

  it("keeps exact decimal reads and the same authoring store after bot deletion", async () => {
    const { engine, root } = fixture();
    const writer = await engine.forBot("writer");
    await writer.run(firstRows, { connection: "bot", businessMutation: true });
    const sourceFile = join(root, "bots", "writer", "data.duckdb");
    const promoted = await engine.promoteForBot("writer", "owner");
    expect(promoted.revision).toBe(1);
    expect(existsSync(sourceFile)).toBe(false);
    expect(existsSync(join(root, "stores", promoted.storeId, "data.duckdb"))).toBe(true);
    expect(await engine.forBot("writer")).toBe(writer);

    const dataBinding = binding(promoted.datasetId);
    await engine.validateBinding("owner", dataBinding);
    const outflow = await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "outflow", parameters: {}, scope: "app-mount" });
    expect(outflow.rows).toEqual([["Food", "-0.30"]]);
    const quality = await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "quality", parameters: {}, scope: "app-mount", expectedRevision: outflow.revision });
    expect(quality.rows).toEqual([["6", "4", "5"]]);
    expect((await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "large", parameters: {}, scope: "app-mount" })).rows).toEqual([["9007199254740993.12"]]);
    expect(outflow.revision).toBe(1);

    const events: Array<{ datasetId: string; revision: number }> = [];
    engine.onChanged((event) => events.push(event));
    await writer.materialise("SELECT * FROM synthetic_ledger", "q_1", { connection: "bot" });
    expect((await writer.listSourceTables()).map(({ schema, name }) => [schema, name])).toEqual([["main", "synthetic_ledger"]]);
    await writer.dropResult("q_1");
    expect(events).toEqual([]);
    const csv = join(root, "synthetic.csv");
    writeFileSync(csv, `day_text,amount_text,category_text\n2025-01-02,-0.10,Food\n2025-01-03,-0.20,Food\nbad-date,not-an-amount,Unsorted\n2025-01-04,0.40,Transfer\n2025-01-05,1.005,Invalid\n2025-01-06,9007199254740993.12,Large\n`);
    const context = {
      database: writer, sheet: new DataSheetStore({ botId: "writer", dir: join(root, "bots", "writer") }),
      connection: "bot", by: "bot", signal: new AbortController().signal,
      compileChart: () => { throw new Error("unused"); }, validateVegaLite: async () => ({}),
      renderer: { svg: async () => "", png: async () => Buffer.alloc(0) }, exportRoots: () => [root],
    } satisfies DataContext;
    await loadData(context, { source: csv, name: "synthetic_ledger", kind: "csv", options: { all_varchar: true } });
    expect(events).toEqual([{ datasetId: promoted.datasetId, revision: 2 }]);
    expect((await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "outflow", parameters: {}, scope: "app-mount" })).revision).toBe(2);

    expect(await engine.withBotDeletion("writer", () => { rmSync(join(root, "bots", "writer"), { recursive: true, force: true }); return true; })).toBe(true);
    expect(await engine.listDatasets("owner")).toMatchObject([{ datasetId: promoted.datasetId, revision: 2 }]);
    expect((await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "outflow", parameters: {}, scope: "app-mount" })).rows).toEqual([["Food", "-0.30"]]);
    await expect(engine.forDataset(promoted.datasetId, "another-owner")).rejects.toMatchObject({ error: { code: "source_not_found" } });
  });

  it("pins cursors and query groups to one revision and rejects views", async () => {
    const { engine } = fixture();
    const writer = await engine.forBot("writer");
    await writer.run(firstRows, { connection: "bot", businessMutation: true });
    const promoted = await engine.promoteForBot("writer", "owner");
    const dataBinding = binding(promoted.datasetId);
    const first = await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "rows", parameters: {}, scope: "app-mount" });
    expect(first.nextCursor).toBeTypeOf("string");
    await writer.run("CREATE OR REPLACE TABLE synthetic_ledger AS SELECT * FROM synthetic_ledger", { connection: "bot", businessMutation: true });
    await expect(engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "rows", parameters: {}, scope: "app-mount", cursor: first.nextCursor })).rejects.toMatchObject({ error: { code: "write_refused" } });
    await expect(engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "quality", parameters: {}, scope: "app-mount", expectedRevision: first.revision })).rejects.toMatchObject({ error: { code: "write_refused" } });
    await writer.run("CREATE VIEW synthetic_view AS SELECT * FROM synthetic_ledger", { connection: "bot", businessMutation: true });
    expect((await writer.listSourceTables()).map(({ name }) => name)).toEqual(["synthetic_ledger"]);
    await expect(engine.validateBinding("owner", { ...dataBinding, source: { schema: "main", table: "synthetic_view" } })).rejects.toMatchObject({ error: { code: "spec_invalid" } });
  });

  it("holds all Data writes through the backup callback and verifies the captured bytes", async () => {
    const { engine, root } = fixture();
    const writer = await engine.forBot("writer");
    await writer.run(firstRows, { connection: "bot", businessMutation: true });
    const promoted = await engine.promoteForBot("writer", "owner");
    const snapshot = join(root, "backup-staging");
    let completed = false;
    let pending: Promise<unknown> | undefined;
    const manifest = await engine.withSnapshot(snapshot, async (captured) => {
      pending = writer.run("CREATE TABLE later AS SELECT 1", { connection: "bot", businessMutation: true }).then(() => { completed = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(completed).toBe(false);
      await verifyDataSnapshot(snapshot, captured);
      expect(captured.stores).toMatchObject([{ datasetId: promoted.datasetId, revision: 1 }]);
      return captured;
    });
    await pending;
    expect(completed).toBe(true);
    await verifyDataSnapshot(snapshot, manifest);
    const file = join(snapshot, manifest.stores[0]!.path);
    const bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from("tampered")]));
    await expect(verifyDataSnapshot(snapshot, manifest)).rejects.toThrow(/verification failed/);
  });

  it("rejects lossy floating source values instead of rounding them", async () => {
    const { engine } = fixture();
    const writer = await engine.forBot("writer");
    await writer.run(`CREATE TABLE synthetic_floats AS SELECT * FROM (VALUES
      (1.25::DOUBLE), (1.005::DOUBLE), (1000000000000000::DOUBLE), ('NaN'::DOUBLE)
    ) AS rows(value)`, { connection: "bot", businessMutation: true });
    const promoted = await engine.promoteForBot("writer", "owner");
    const dataBinding: MiniAppDataBinding = {
      id: "float_quality", datasetId: promoted.datasetId, source: { schema: "main", table: "synthetic_floats" },
      fields: { value: { column: "value", sourceType: "DOUBLE", as: "decimal", scale: 2 } },
      queries: { quality: { kind: "aggregate", groupBy: [], measures: [{ name: "allRows", op: "count" }, { name: "valid", op: "count", field: "value" }], parameters: {}, filters: [], orderBy: [], pageSize: 10 } },
    };
    expect((await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "quality", parameters: {}, scope: "app-mount" })).rows).toEqual([["4", "1"]]);
  });

  it("recovers an interrupted pre-switch promotion from the original store", async () => {
    const { engine, root, catalog, makeEngine } = fixture();
    await (await engine.forBot("writer")).run(firstRows, { connection: "bot", businessMutation: true });
    await engine.closeAll();
    const promotion = catalog.beginPromotion("writer", "owner");
    const candidate = join(root, "stores", `${promotion.storeId}.candidate`);
    mkdirSync(candidate, { recursive: true });
    writeFileSync(join(candidate, "data.duckdb"), "partial copy");
    const restarted = makeEngine();
    const result = await (await restarted.forBot("writer")).run("SELECT count(*) FROM synthetic_ledger", { connection: "panel" });
    expect(result.rows).toEqual([["6"]]);
    expect(catalog.promotions()).toEqual([]);
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(join(root, "bots", "writer", "data.duckdb"))).toBe(true);
  });

  it("recovers a switched journal using the verified destination", async () => {
    const { engine, root, catalog, makeEngine } = fixture();
    await (await engine.forBot("writer")).run(firstRows, { connection: "bot", businessMutation: true });
    await engine.closeAll();
    const promotion = catalog.beginPromotion("writer", "owner");
    const sourceFile = join(root, "bots", "writer", "data.duckdb");
    const sha256 = await durablePromote(sourceFile, root, promotion.storeId);
    catalog.switchPromotion({ ...promotion, botId: "writer", sha256 });
    const restarted = makeEngine();
    const result = await (await restarted.forDataset(promotion.datasetId, "owner")).run("SELECT count(*) FROM synthetic_ledger", { connection: "panel" });
    expect(result.rows).toEqual([["6"]]);
    expect(catalog.promotions()).toEqual([]);
    expect(existsSync(sourceFile)).toBe(false);
    expect(existsSync(join(root, "stores", promotion.storeId, "data.duckdb"))).toBe(true);
  });

  it("invalidates old store handles and cursors when SQLite is restored", async () => {
    const { engine, replaceCatalog } = fixture();
    const writer = await engine.forBot("writer");
    await writer.run(firstRows, { connection: "bot", businessMutation: true });
    const promoted = await engine.promoteForBot("writer", "owner");
    const dataBinding = binding(promoted.datasetId);
    const page = await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "rows", parameters: {}, scope: "app-mount" });
    await replaceCatalog();
    expect((await engine.forDataset(promoted.datasetId, "owner")).listSourceTables).toBeTypeOf("function");
    await expect(writer.run("SELECT 1", { connection: "bot" })).rejects.toMatchObject({ error: { code: "engine_unavailable" } });
    await expect(engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "rows", parameters: {}, scope: "app-mount", cursor: page.nextCursor })).rejects.toMatchObject({ error: { code: "invalid_input" } });
    expect((await engine.readNamed({ ownerId: "owner", binding: dataBinding, queryId: "quality", parameters: {}, scope: "app-mount" })).rows).toEqual([["6", "4", "5"]]);
  });

  it("never recreates a missing promoted file through its dataset, bot alias or snapshot", async () => {
    const { engine, root } = fixture();
    await (await engine.forBot("writer")).run(firstRows, { connection: "bot", businessMutation: true });
    const promoted = await engine.promoteForBot("writer", "owner");
    await engine.closeAll();
    const folder = join(root, "stores", promoted.storeId);
    const file = join(folder, "data.duckdb");
    renameSync(file, join(root, "moved.duckdb"));
    await expect((await engine.forDataset(promoted.datasetId, "owner")).run("SELECT 1", { connection: "panel" })).rejects.toMatchObject({ error: { code: "engine_unavailable" } });
    await expect((await engine.forBot("writer")).run("SELECT 1", { connection: "bot" })).rejects.toMatchObject({ error: { code: "engine_unavailable" } });
    await expect(engine.listDatasets("owner")).rejects.toMatchObject({ error: { code: "engine_unavailable" } });
    await expect(engine.withSnapshot(join(root, "backup-staging"), async () => true)).rejects.toMatchObject({ error: { code: "engine_unavailable" } });
    expect(existsSync(file)).toBe(false);
    rmSync(folder, { recursive: true });
    await expect((await engine.forDataset(promoted.datasetId, "owner")).run("SELECT 1", { connection: "panel" })).rejects.toMatchObject({ error: { code: "engine_unavailable" } });
    expect(existsSync(folder)).toBe(false);
  });

  it("resolves the promoted alias after a queued promotion before bot deletion", async () => {
    const { engine, root } = fixture();
    await (await engine.forBot("writer")).run(firstRows, { connection: "bot", businessMutation: true });
    let promotion!: ReturnType<DataEngine["promoteForBot"]>;
    let deletion!: Promise<boolean>;
    await engine.withSnapshot(join(root, "backup-staging"), async () => {
      promotion = engine.promoteForBot("writer", "owner");
      await new Promise((resolve) => setImmediate(resolve));
      deletion = engine.withBotDeletion("writer", () => { rmSync(join(root, "bots", "writer"), { recursive: true, force: true }); return true; });
    });
    const dataset = await promotion;
    expect(await deletion).toBe(true);
    const retained = await engine.forDataset(dataset.datasetId, "owner");
    expect((await retained.run("SELECT count(*) FROM synthetic_ledger", { connection: "panel" })).rows).toEqual([["6"]]);
  });
});
