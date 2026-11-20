import { describe, expect, it } from "vitest";
import { parsePublish } from "../server/mini-apps/validation.ts";
import { GITHUB_DEEP_DIVE_TABLE, REPORT_APPS, REPORT_COLUMNS, REPORT_HEADER_FIELDS, REPORT_ITEM_FIELDS,
  githubDeepDiveBinding, reportMiniAppBinding, reportPublicationDraft, type ReportKind } from "./report-mini-app.ts";

const DATASET = "dd2dba36-739b-42ba-bbad-e134920138a8";

describe("report Mini App contract", () => {
  it.each(["x_ai_digest", "github_activity"] as ReportKind[])("binds only the %s series through four named reads", (kind) => {
    const binding = reportMiniAppBinding(DATASET, kind);
    expect(binding.source).toEqual({ schema: "main", table: "omb_report_editions_v1" });
    expect(Object.keys(binding.queries)).toEqual(["current", "history", "edition", "items"]);
    expect(binding.queries.current).toMatchObject({ kind: "rows", columns: REPORT_HEADER_FIELDS, pageSize: 1,
      filters: [{ field: "reportKind", op: "eq", literal: kind }, { field: "itemIndex", op: "eq", literal: "0" }],
      orderBy: [{ field: "editionKey", direction: "desc" }] });
    expect(binding.queries.history).toMatchObject({ pageSize: 50, orderBy: [{ field: "editionKey", direction: "desc" }] });
    expect(binding.queries.edition).toMatchObject({ parameters: { editionKey: { type: "text" } }, pageSize: 1 });
    expect(binding.queries.items).toMatchObject({ kind: "rows", columns: REPORT_ITEM_FIELDS,
      parameters: { editionKey: { type: "text" } }, pageSize: 30,
      filters: [{ field: "reportKind", op: "eq", literal: kind }, { field: "itemIndex", op: "gt", literal: "0" },
        { field: "editionKey", op: "eq", parameter: "editionKey" }] });
    expect(binding.fields.reportSummary).toEqual({ column: "summary", sourceType: "VARCHAR", as: "text" });
    expect(new Set(Object.values(binding.fields).map((field) => field.column))).toEqual(new Set(REPORT_COLUMNS.map(([name]) => name)));
  });

  it("returns a stable install draft with no owner-only publisher grant or fabricated edition", () => {
    expect(REPORT_APPS.github_activity).toMatchObject({ slug: "github-activity", title: "Github Rending" });
    for (const kind of Object.keys(REPORT_APPS) as ReportKind[]) {
      const draft = reportPublicationDraft(kind, DATASET, "<main>Fixture report</main>");
      expect(parsePublish(draft)).toEqual(draft);
      expect(draft).toMatchObject({ expectedRevision: 0, slug: REPORT_APPS[kind].slug,
        requestKey: `report-install-v1:${kind}`, bindings: [{ datasetId: DATASET }] });
      expect(draft).not.toHaveProperty("publisherBotIds");
      expect(draft).not.toHaveProperty("edition");
      expect(draft).not.toHaveProperty("routineId");
      expect(draft).not.toHaveProperty("botId");
    }
  });

  it("defines the scoped chunked GitHub deep-dive extension binding on the producer dataset", () => {
    const binding = githubDeepDiveBinding(DATASET);
    expect(binding.id).toBe("deepDive");
    expect(binding.datasetId).toBe(DATASET);
    expect(binding.source).toEqual({ schema: "main", table: GITHUB_DEEP_DIVE_TABLE });
    expect(binding.fields).toEqual({
      editionKey: { column: "edition_key", sourceType: "VARCHAR", as: "text" },
      repo: { column: "repo", sourceType: "VARCHAR", as: "text" },
      schemaVersion: { column: "schema_version", sourceType: "INTEGER", as: "decimal", scale: 0 },
      partIndex: { column: "part_index", sourceType: "INTEGER", as: "decimal", scale: 0 },
      partCount: { column: "part_count", sourceType: "INTEGER", as: "decimal", scale: 0 },
      payloadChunk: { column: "payload_chunk", sourceType: "VARCHAR", as: "text" },
    });
    expect(Object.keys(binding.queries)).toEqual(["deep_dive"]);
    expect(binding.queries.deep_dive).toEqual({
      kind: "rows",
      columns: ["editionKey", "repo", "schemaVersion", "partIndex", "partCount", "payloadChunk"],
      parameters: { editionKey: { type: "text" }, repo: { type: "text" } },
      filters: [
        { field: "editionKey", op: "eq", parameter: "editionKey" },
        { field: "repo", op: "eq", parameter: "repo" },
        { field: "schemaVersion", op: "eq", literal: "1" },
      ],
      orderBy: [{ field: "partIndex", direction: "asc" }],
      pageSize: 16,
    });
    const combined = {
      ...reportPublicationDraft("github_activity", DATASET, "<main>Fixture</main>"),
      bindings: [reportMiniAppBinding(DATASET, "github_activity"), binding],
    };
    expect(parsePublish(combined)).toEqual(combined);

    const catalogBinding = githubDeepDiveBinding(DATASET, { catalog: true });
    expect(catalogBinding.source).toEqual({ schema: "main", table: GITHUB_DEEP_DIVE_TABLE });
    expect(catalogBinding.fields).toEqual(binding.fields);
    expect(Object.keys(catalogBinding.queries)).toEqual(["deep_dive", "deep_dive_catalog"]);
    expect(catalogBinding.queries.deep_dive).toEqual(binding.queries.deep_dive);
    expect(catalogBinding.queries.deep_dive_catalog).toEqual({
      kind: "rows",
      columns: ["repo"],
      parameters: { editionKey: { type: "text" } },
      filters: [
        { field: "editionKey", op: "eq", parameter: "editionKey" },
        { field: "schemaVersion", op: "eq", literal: "1" },
        { field: "partIndex", op: "eq", literal: "0" },
      ],
      orderBy: [{ field: "repo", direction: "asc" }],
      pageSize: 16,
    });
    const combinedWithCatalog = {
      ...reportPublicationDraft("github_activity", DATASET, "<main>Fixture</main>"),
      bindings: [reportMiniAppBinding(DATASET, "github_activity"), catalogBinding],
    };
    expect(parsePublish(combinedWithCatalog)).toEqual(combinedWithCatalog);
  });
});
