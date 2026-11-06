import { describe, expect, it } from "vitest";
import { parsePublish } from "../server/mini-apps/validation.ts";
import { REPORT_APPS, REPORT_COLUMNS, REPORT_HEADER_FIELDS, REPORT_ITEM_FIELDS, reportMiniAppBinding,
  reportPublicationDraft, type ReportKind } from "./report-mini-app.ts";

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
});
