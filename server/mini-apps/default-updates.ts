import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BOOKKEEPING_FIELDS, createBookkeepingPublish, type BookkeepingColumns } from "../../shared/bookkeeping-mini-app.ts";
import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import type { DefaultMiniAppKind, MiniAppDocument, MiniAppPublish } from "../../shared/mini-apps.ts";
import { reportMiniAppBinding } from "../../shared/report-mini-app.ts";
import { createReportTemplate } from "../../shared/report-mini-app-template.ts";
import { DEFAULT_APPS } from "./default-documents.ts";
import { SHIPPED_TEMPLATE_SHA256 } from "./default-template-history.ts";

function bundledBookkeepingBinding(binding: MiniAppDataBinding): boolean {
  if (!BOOKKEEPING_FIELDS.every((field) => binding.fields[field])) return false;
  const table = { schema: binding.source.schema, name: binding.source.table, rowCount: 0,
    columns: BOOKKEEPING_FIELDS.map((field) => ({ name: binding.fields[field]!.column, type: binding.fields[field]!.sourceType })) };
  const columns = Object.fromEntries(BOOKKEEPING_FIELDS.map((field) => [field, binding.fields[field]!.column])) as BookkeepingColumns;
  const bundled = createBookkeepingPublish({ dataset: { datasetId: binding.datasetId, revision: 0, tables: [table] },
    table, columns, html: "", requestKey: "" }).bindings[0];
  return isDeepStrictEqual(binding, bundled);
}

export function defaultMiniAppUpdate(document: MiniAppDocument, kind: DefaultMiniAppKind, bookkeepingHtml: string): MiniAppPublish | null {
  if (kind === "agent-team" || kind === "usage" || document.app.shippedTemplateKind !== kind) return null;
  if (document.versions.some((version) => version.version > document.app.templateVersion)) return null;
  const hash = createHash("sha256").update(document.html).digest("hex");
  if (!SHIPPED_TEMPLATE_SHA256[kind].includes(hash) || document.bindings.length !== 1) return null;
  const binding = document.bindings[0]!;
  if (kind === "bookkeeping" ? !bundledBookkeepingBinding(binding)
    : !isDeepStrictEqual(binding, reportMiniAppBinding(binding.datasetId, kind))) return null;
  const html = kind === "bookkeeping" ? bookkeepingHtml : createReportTemplate(kind);
  const title = kind === "github_activity" && ["GitHub activity", "GitHub activity & discovery"].includes(document.app.title)
    ? DEFAULT_APPS.github_activity.title : document.app.title;
  if (html === document.html && title === document.app.title) return null;
  return { requestKey: randomUUID(), expectedRevision: document.app.revision, slug: document.app.slug, title,
    description: document.app.description, html, bindings: document.bindings,
    publisherBotIds: document.app.publisherBotIds, shippedTemplateKind: kind };
}
