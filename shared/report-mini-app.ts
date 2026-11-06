import type { MiniAppDataBinding, MiniAppField, MiniAppFilter } from "./mini-app-data.ts";
import type { MiniAppDataset, MiniAppPublish } from "./mini-apps.ts";

export const REPORT_APPS = {
  x_ai_digest: { slug: "x-ai-digest", title: "Daily X AI digest", description: "Selected X AI updates with source and coverage notes." },
  github_activity: { slug: "github-activity", title: "GitHub activity", description: "Selected open-source projects and observed activity signals." },
} as const;
export type ReportKind = keyof typeof REPORT_APPS;
export type ReportCoverageStatus = "complete" | "partial" | "unknown";
export type ReportAttribution = "primary" | "vendor" | "secondary" | "curated";
export const REPORT_TABLE = "omb_report_editions_v1";

export const REPORT_COLUMNS = [
  ["report_kind", "VARCHAR"], ["edition_key", "VARCHAR"], ["item_index", "INTEGER"], ["edition_day", "DATE"],
  ["window_start_at", "VARCHAR"], ["window_end_at", "VARCHAR"], ["source_as_of_at", "VARCHAR"],
  ["coverage_status", "VARCHAR"], ["coverage_note", "VARCHAR"], ["item_count", "INTEGER"],
  ["content_sha256", "VARCHAR"], ["published_at", "VARCHAR"], ["category", "VARCHAR"],
  ["title", "VARCHAR"], ["summary", "VARCHAR"], ["why_it_matters", "VARCHAR"], ["verification_note", "VARCHAR"],
  ["source_label", "VARCHAR"], ["source_url", "VARCHAR"], ["source_published_at", "VARCHAR"],
  ["attribution", "VARCHAR"], ["repo_full_name", "VARCHAR"], ["repo_stars", "BIGINT"],
  ["repo_forks", "BIGINT"], ["repo_pushed_at", "VARCHAR"], ["weekly_star_increase", "BIGINT"],
  ["signal_source_url", "VARCHAR"], ["public_advisory_count", "INTEGER"],
  ["public_advisory_as_of_at", "VARCHAR"], ["selection_basis", "VARCHAR"],
] as const;

/** An edition belongs to one report kind and one nominal China-calendar day, independent of collection time. */
export interface ReportEditionInput {
  editionKey?: string;
  reportSummary?: string | null;
  windowStartAt: string | null;
  windowEndAt: string | null;
  sourceAsOfAt: string | null;
  coverageStatus: ReportCoverageStatus;
  coverageNote: string | null;
  items: ReportItemInput[];
}

/** Source URLs and dates are recorded claims; missing dates and metrics stay null. */
export interface ReportItemInput {
  category: string | null;
  title: string;
  summary: string;
  whyItMatters?: string | null;
  verificationNote?: string | null;
  sourceLabel: string;
  sourceUrl: string;
  sourcePublishedAt: string | null;
  attribution: ReportAttribution;
  repoFullName?: string | null;
  repoStars?: number | null;
  repoForks?: number | null;
  repoPushedAt?: string | null;
  weeklyStarIncrease?: number | null;
  signalSourceUrl?: string | null;
  publicAdvisoryCount?: number | null;
  publicAdvisoryAsOfAt?: string | null;
  selectionBasis?: string | null;
}

export interface ReportEditionReceipt {
  slug: string;
  datasetId: string;
  kind: ReportKind;
  editionKey: string;
  editionDay: string;
  itemCount: number;
  contentHash: string;
  publishedAt: string;
  replayed: boolean;
}

export interface ReportPrepareResult {
  kind: ReportKind;
  slug: string;
  dataset: MiniAppDataset;
  nominalEditionKey: string | null;
  publication: MiniAppPublish;
}

export interface ReportSourceResult extends ReportPrepareResult {
  routineId: string;
  producerBotId: string;
}

const fields = {
  reportKind: { column: "report_kind", sourceType: "VARCHAR", as: "text" },
  editionKey: { column: "edition_key", sourceType: "VARCHAR", as: "text" },
  itemIndex: { column: "item_index", sourceType: "INTEGER", as: "decimal", scale: 0 },
  editionDay: { column: "edition_day", sourceType: "DATE", as: "date" },
  windowStartAt: { column: "window_start_at", sourceType: "VARCHAR", as: "text" },
  windowEndAt: { column: "window_end_at", sourceType: "VARCHAR", as: "text" },
  sourceAsOfAt: { column: "source_as_of_at", sourceType: "VARCHAR", as: "text" },
  coverageStatus: { column: "coverage_status", sourceType: "VARCHAR", as: "text" },
  coverageNote: { column: "coverage_note", sourceType: "VARCHAR", as: "text" },
  itemCount: { column: "item_count", sourceType: "INTEGER", as: "decimal", scale: 0 },
  contentHash: { column: "content_sha256", sourceType: "VARCHAR", as: "text" },
  publishedAt: { column: "published_at", sourceType: "VARCHAR", as: "text" },
  category: { column: "category", sourceType: "VARCHAR", as: "text" },
  title: { column: "title", sourceType: "VARCHAR", as: "text" },
  summary: { column: "summary", sourceType: "VARCHAR", as: "text" },
  reportSummary: { column: "summary", sourceType: "VARCHAR", as: "text" },
  whyItMatters: { column: "why_it_matters", sourceType: "VARCHAR", as: "text" },
  verificationNote: { column: "verification_note", sourceType: "VARCHAR", as: "text" },
  sourceLabel: { column: "source_label", sourceType: "VARCHAR", as: "text" },
  sourceUrl: { column: "source_url", sourceType: "VARCHAR", as: "text" },
  sourcePublishedAt: { column: "source_published_at", sourceType: "VARCHAR", as: "text" },
  attribution: { column: "attribution", sourceType: "VARCHAR", as: "text" },
  repoFullName: { column: "repo_full_name", sourceType: "VARCHAR", as: "text" },
  repoStars: { column: "repo_stars", sourceType: "BIGINT", as: "decimal", scale: 0 },
  repoForks: { column: "repo_forks", sourceType: "BIGINT", as: "decimal", scale: 0 },
  repoPushedAt: { column: "repo_pushed_at", sourceType: "VARCHAR", as: "text" },
  weeklyStarIncrease: { column: "weekly_star_increase", sourceType: "BIGINT", as: "decimal", scale: 0 },
  signalSourceUrl: { column: "signal_source_url", sourceType: "VARCHAR", as: "text" },
  publicAdvisoryCount: { column: "public_advisory_count", sourceType: "INTEGER", as: "decimal", scale: 0 },
  publicAdvisoryAsOfAt: { column: "public_advisory_as_of_at", sourceType: "VARCHAR", as: "text" },
  selectionBasis: { column: "selection_basis", sourceType: "VARCHAR", as: "text" },
} as const satisfies Record<string, MiniAppField>;

export const REPORT_HEADER_FIELDS = ["editionKey", "editionDay", "windowStartAt", "windowEndAt", "sourceAsOfAt",
  "coverageStatus", "coverageNote", "reportSummary", "itemCount", "contentHash", "publishedAt"] as const;
export const REPORT_ITEM_FIELDS = ["itemIndex", "category", "title", "summary", "whyItMatters", "verificationNote",
  "sourceLabel", "sourceUrl", "sourcePublishedAt", "attribution", "repoFullName", "repoStars", "repoForks",
  "repoPushedAt", "weeklyStarIncrease", "signalSourceUrl", "publicAdvisoryCount", "publicAdvisoryAsOfAt",
  "selectionBasis"] as const;

export function reportMiniAppBinding(datasetId: string, kind: ReportKind): MiniAppDataBinding {
  const header: MiniAppFilter[] = [
    { field: "reportKind", op: "eq", literal: kind }, { field: "itemIndex", op: "eq", literal: "0" },
  ];
  const byEdition: MiniAppFilter = { field: "editionKey", op: "eq", parameter: "editionKey" };
  return {
    id: "report", datasetId, source: { schema: "main", table: REPORT_TABLE }, fields,
    queries: {
      current: { kind: "rows", columns: [...REPORT_HEADER_FIELDS], parameters: {}, filters: header,
        orderBy: [{ field: "editionKey", direction: "desc" }], pageSize: 1 },
      history: { kind: "rows", columns: ["editionKey", "editionDay", "coverageStatus", "itemCount", "publishedAt"],
        parameters: {}, filters: header, orderBy: [{ field: "editionKey", direction: "desc" }], pageSize: 50 },
      edition: { kind: "rows", columns: [...REPORT_HEADER_FIELDS], parameters: { editionKey: { type: "text" } },
        filters: [...header, byEdition], orderBy: [], pageSize: 1 },
      items: { kind: "rows", columns: [...REPORT_ITEM_FIELDS], parameters: { editionKey: { type: "text" } },
        filters: [{ field: "reportKind", op: "eq", literal: kind }, { field: "itemIndex", op: "gt", literal: "0" }, byEdition],
        orderBy: [{ field: "itemIndex", direction: "asc" }], pageSize: 30 },
    },
  };
}

export function reportPublicationDraft(kind: ReportKind, datasetId: string, html: string): MiniAppPublish {
  const app = REPORT_APPS[kind];
  return { requestKey: `report-install-v1:${kind}`, expectedRevision: 0, slug: app.slug, title: app.title,
    description: app.description, html, bindings: [reportMiniAppBinding(datasetId, kind)] };
}
