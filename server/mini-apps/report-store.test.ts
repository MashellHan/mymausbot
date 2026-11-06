import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as DuckDB from "@duckdb/node-api";
import { afterEach, describe, expect, it } from "vitest";

import { REPORT_COLUMNS, REPORT_TABLE, REPORT_ITEM_FIELDS, reportMiniAppBinding } from "../../shared/report-mini-app.ts";
import { createDataEngine } from "../data/engine.ts";
import type { DataEngine } from "../data/types.ts";
import { MINI_APPS_OWNER } from "./registry.ts";
import { parseReportEdition } from "./report-schema.ts";
import { ReportStore } from "./report-store.ts";

const fixtures: Array<{ root: string; db: DatabaseSync; data: DataEngine }> = [];
const now = Date.parse("2026-11-06T04:00:00Z");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-report-data-"));
  const db = new DatabaseSync(join(root, "messages.db"));
  db.exec("PRAGMA journal_mode = WAL");
  const data = createDataEngine({ botFolder: (botId) => join(root, "bots", botId), dataDir: root, binding: DuckDB,
    catalog: { getDatabase: () => db, withWrite: (write) => {
      db.exec("BEGIN IMMEDIATE");
      try { const result = write(db); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    } } });
  fixtures.push({ root, db, data });
  return { data, reports: new ReportStore(data, (kind) => `<main>${kind}</main>`, () => now) };
}

afterEach(async () => {
  for (const { root, db, data } of fixtures.splice(0)) {
    await data.closeAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const xEdition = (editionKey = "2026-11-05") => ({ editionKey, windowStartAt: "2026-11-04T00:00:00Z",
  windowEndAt: "2026-11-05T00:00:00Z", sourceAsOfAt: null, coverageStatus: "partial", coverageNote: "Selected public items, not a complete archive.",
  items: [{ category: "AI", title: "A model's 'quoted' update", summary: "One selected update.", sourceLabel: "Example News",
    sourceUrl: "https://example.com/news/1", sourcePublishedAt: null, attribution: "vendor" }] });

describe("retained report editions", () => {
  it("installs an empty physical source, keeps immutable revisions and independent X/GitHub heads", async () => {
    const { data, reports } = fixture();
    const prepared = await reports.prepare("producer", "x_ai_digest");
    const binding = reportMiniAppBinding(prepared.dataset.datasetId, "x_ai_digest");
    const read = (kind: "x_ai_digest" | "github_activity", queryId: string, parameters: Record<string, string> = {}) =>
      data.readNamed({ ownerId: MINI_APPS_OWNER, binding: reportMiniAppBinding(prepared.dataset.datasetId, kind), queryId,
        parameters, scope: "synthetic-report" });
    expect(prepared.dataset.tables.find((table) => table.name === "omb_report_editions_v1")).toMatchObject({ schema: "main", rowCount: 0 });
    expect(prepared.publication).toMatchObject({ expectedRevision: 0, slug: "x-ai-digest", bindings: [binding] });
    expect(prepared.publication.shippedTemplateKind).toBeUndefined();
    expect((await read("x_ai_digest", "current")).rows).toEqual([]);
    expect((await reports.prepare("producer", "github_activity")).dataset.datasetId).toBe(prepared.dataset.datasetId);

    const first = await reports.publish("producer", "x_ai_digest", xEdition());
    expect(first).toMatchObject({ editionKey: "2026-11-05", itemCount: 1, replayed: false });
    const revision = (await data.listDatasets(MINI_APPS_OWNER))[0]!.revision;
    expect(revision).toBeGreaterThan(prepared.dataset.revision);
    expect(await reports.publish("producer", "x_ai_digest", xEdition())).toEqual({ ...first, replayed: true });
    expect((await data.listDatasets(MINI_APPS_OWNER))[0]!.revision).toBe(revision);
    await expect(reports.publish("producer", "x_ai_digest", { ...xEdition(), reportSummary: "Conflicting rewrite" }))
      .rejects.toMatchObject({ status: 409 });
    expect((await data.listDatasets(MINI_APPS_OWNER))[0]!.revision).toBe(revision);

    await reports.publish("producer", "x_ai_digest", xEdition("2026-11-04"));
    const current = await read("x_ai_digest", "current");
    expect(current.rows[0]?.[0]).toBe("2026-11-05");
    expect((await read("x_ai_digest", "history")).rows.map((row) => row[0])).toEqual(["2026-11-05", "2026-11-04"]);
    const items = await read("x_ai_digest", "items", { editionKey: "2026-11-05" });
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]?.[REPORT_ITEM_FIELDS.indexOf("sourceUrl")]).toBe("https://example.com/news/1");
    expect(items.rows[0]?.[REPORT_ITEM_FIELDS.indexOf("sourcePublishedAt")]).toBeNull();

    const github = await reports.publish("producer", "github_activity", { editionKey: "2026-11-06",
      reportSummary: "Selected repositories, no local trend.", windowStartAt: null, windowEndAt: null, sourceAsOfAt: null,
      coverageStatus: "unknown", coverageNote: "Selection is not a measured cross-period trend.", items: [{
        category: "Tools", title: "Example project", summary: "One selected repository.", sourceLabel: "GitHub",
        sourceUrl: "https://github.com/example/project", sourcePublishedAt: null, attribution: "curated",
        repoFullName: "example/project", repoStars: 100, weeklyStarIncrease: 12,
        signalSourceUrl: "https://github.com/trending?since=weekly", selectionBasis: "GitHub Trending weekly selection",
        publicAdvisoryCount: 0, publicAdvisoryAsOfAt: "2026-11-06T03:00:00Z",
      }] });
    expect(github.replayed).toBe(false);
    expect((await read("x_ai_digest", "current")).rows[0]?.[0]).toBe("2026-11-05");
    expect((await read("github_activity", "current")).rows[0]?.[0]).toBe("2026-11-06");
  });

  it("rejects an old same-column table without the required edition key", async () => {
    const { data, reports } = fixture();
    const database = await data.forBot("producer");
    await database.run(`CREATE TABLE main.${REPORT_TABLE} (${REPORT_COLUMNS.map(([name, type]) => `${name} ${type}`).join(", ")})`,
      { connection: "bot", businessMutation: true });
    await expect(reports.prepare("producer", "x_ai_digest")).rejects.toMatchObject({ status: 409 });
  });

  it("rejects unsafe URLs and binds an Automation edition to its scheduled China day", async () => {
    const { reports } = fixture();
    const unsafe = { ...xEdition(), items: [{ ...xEdition().items[0], sourceUrl: "http://127.0.0.1/private" }] };
    await expect(reports.publish("producer", "x_ai_digest", unsafe)).rejects.toMatchObject({ status: 400 });
    await expect(reports.publish("producer", "x_ai_digest", xEdition("2026-11-04"), Date.parse("2026-11-05T01:00:00Z")))
      .rejects.toMatchObject({ status: 400 });
    const { editionKey: _unused, ...withoutDay } = xEdition();
    const scheduled = await reports.publish("producer", "x_ai_digest", withoutDay, Date.parse("2026-11-05T01:00:00Z"));
    expect(scheduled.editionKey).toBe("2026-11-05");
    expect(await reports.publish("producer", "x_ai_digest", xEdition())).toEqual({ ...scheduled, replayed: true });
  });

  it("retains one known bound for partial or unknown coverage and requires both for complete coverage", async () => {
    const { data, reports } = fixture();
    const prepared = await reports.prepare("producer", "x_ai_digest");
    const start = "2026-11-04T00:00:00Z";
    const end = "2026-11-05T00:00:00Z";
    for (const [coverageStatus, editionKey, windowStartAt, windowEndAt] of [
      ["partial", "2026-11-01", "2026-10-31T00:00:00.000Z", null],
      ["partial", "2026-11-02", null, "2026-11-02T00:00:00.000Z"],
      ["unknown", "2026-11-03", "2026-11-02T00:00:00.000Z", null],
      ["unknown", "2026-11-04", null, "2026-11-04T00:00:00.000Z"],
    ] as const) {
      const edition = { ...xEdition(editionKey), coverageStatus, windowStartAt, windowEndAt };
      expect(parseReportEdition("x_ai_digest", edition)).toMatchObject({ coverageStatus, windowStartAt, windowEndAt });
      await reports.publish("producer", "x_ai_digest", edition);
      const page = await data.readNamed({ ownerId: MINI_APPS_OWNER,
        binding: reportMiniAppBinding(prepared.dataset.datasetId, "x_ai_digest"), queryId: "edition",
        parameters: { editionKey }, scope: "synthetic-report" });
      const header = Object.fromEntries(page.columns.map((column, index) => [column.name, page.rows[0]?.[index]]));
      expect(header).toMatchObject({ coverageStatus, windowStartAt, windowEndAt });
    }
    for (const [windowStartAt, windowEndAt] of [[start, null], [null, end]] as const) {
      const edition = { ...xEdition(), coverageStatus: "complete", windowStartAt, windowEndAt };
      expect(() => parseReportEdition("x_ai_digest", edition)).toThrow("Report coverage window is incomplete or invalid.");
      await expect(reports.publish("producer", "x_ai_digest", edition)).rejects.toMatchObject({ status: 400 });
    }
    await expect(reports.publish("producer", "x_ai_digest", {
      ...xEdition(), coverageStatus: "complete", windowStartAt: end, windowEndAt: start,
    })).rejects.toMatchObject({ status: 400 });
    expect(parseReportEdition("x_ai_digest", { ...xEdition(), coverageStatus: "complete" }).coverageStatus).toBe("complete");
  });
});
