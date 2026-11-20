import { isDeepStrictEqual } from "node:util";
import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import type { MiniAppReleaseQuerySlot } from "../../shared/mini-apps.ts";
import { githubDeepDiveBinding, reportMiniAppBinding, type ReportKind } from "../../shared/report-mini-app.ts";

const dailyXEditorial = {
  id: "editorial",
  source: { schema: "main", table: "daily_x_editor_notes" },
  fields: {
    editionKey: { column: "edition_key", sourceType: "VARCHAR", as: "text" },
    editorNote: { column: "editor_note", sourceType: "VARCHAR", as: "text" },
    updatedAt: { column: "updated_at", sourceType: "VARCHAR", as: "text" },
  },
  queries: { editorNote: {
    kind: "rows", parameters: { editionKey: { type: "text" } },
    filters: [{ field: "editionKey", op: "eq", parameter: "editionKey" }],
    orderBy: [{ field: "editionKey", direction: "asc" }], pageSize: 1,
    columns: ["editionKey", "editorNote", "updatedAt"],
  } },
} satisfies Omit<MiniAppDataBinding, "datasetId">;

export function acceptsOptionalDailyXEditorial(bindings: readonly MiniAppDataBinding[]): boolean {
  const [report, editorial] = bindings;
  if (!report || bindings.length > 2 || !isDeepStrictEqual(report, reportMiniAppBinding(report.datasetId, "x_ai_digest"))) return false;
  return !editorial || isDeepStrictEqual(editorial, { ...dailyXEditorial, datasetId: editorial.datasetId });
}

function portable({ id, source, fields, queries }: MiniAppDataBinding): MiniAppReleaseQuerySlot {
  return { id, source, fields, queries };
}

export function reportReleaseQueriesMatch(kind: ReportKind, slots: readonly MiniAppReleaseQuerySlot[]): boolean {
  const [report, optional] = slots;
  if (slots.length > 2 || !isDeepStrictEqual(report, portable(reportMiniAppBinding("", kind)))) return false;
  if (!optional) return true;
  if (kind === "x_ai_digest") return isDeepStrictEqual(optional, dailyXEditorial);
  return isDeepStrictEqual(optional, portable(githubDeepDiveBinding("")))
    || isDeepStrictEqual(optional, portable(githubDeepDiveBinding("", { catalog: true })));
}

export function bookkeepingReleaseQueriesMatch(binding: MiniAppDataBinding, slots: readonly MiniAppReleaseQuerySlot[]): boolean {
  const [ledger] = slots;
  if (slots.length !== 1 || !ledger || ledger.id !== binding.id || ledger.source.schema !== null || ledger.source.table !== null) return false;
  const types = (fields: MiniAppReleaseQuerySlot["fields"]) => Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [name, field.as === "decimal" ? { as: field.as, scale: field.scale } : { as: field.as }]),
  );
  return isDeepStrictEqual(ledger.queries, binding.queries) && isDeepStrictEqual(types(ledger.fields), types(binding.fields));
}
