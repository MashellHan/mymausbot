import { describe, expect, it, vi } from "vitest";
import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import { githubDeepDiveBinding, reportMiniAppBinding } from "../../shared/report-mini-app.ts";
import { MINI_APP_DASHBOARD_RESOURCES, type MiniAppSummary } from "../../shared/mini-apps.ts";
import { pendingDefaultHtml } from "./default-documents.ts";
import { acceptsOptionalDailyXEditorial, bookkeepingReleaseQueriesMatch, reportReleaseQueriesMatch } from "./report-release-bindings.ts";
import { compareSemver3, isReleaseCompatible, miniAppReleaseMapping, MiniAppReleaseSource } from "./release-source.ts";

const app = (fields: Partial<MiniAppSummary> = {}): MiniAppSummary => ({
  id: "synthetic-app-id", slug: "fixture", title: "Test", description: "", status: "active",
  revision: 1, templateVersion: 1, publisherBotIds: [], createdAt: 0, updatedAt: 0, ...fields,
});

const agentTeam = app({ dashboardIdentity: "agent-team", dashboard: {
  kind: "agent-team", renderer: "native", htmlRole: "fallback-only",
  editableFields: ["title", "description"], resources: ["teams", "activity"],
} });
const activities = app({ dashboardIdentity: "usage", dashboard: {
  kind: "usage", renderer: "native", htmlRole: "fallback-only",
  editableFields: ["title", "description"], resources: MINI_APP_DASHBOARD_RESOURCES.usage,
} });
const hongguo = app({ nativeIdentity: "hongguo", nativeKind: "hongguo" });

const packages = [
  { entry: agentTeam, slug: "agent-team", capability: "agent-team-v1" },
  { entry: activities, slug: "work-tracker", capability: "usage-v1" },
  { entry: hongguo, slug: "hongguo", capability: "hongguo-v1" },
  { entry: app({ shippedTemplateKind: "mojo" }), slug: "mojo", capability: "mojo-poetry-v1" },
  { entry: app({ shippedTemplateKind: "x_ai_digest" }), slug: "x-ai-digest", capability: "daily-x-site-v1" },
  { entry: app({ shippedTemplateKind: "github_activity" }), slug: "github-activity", capability: "github-activity-site-v1" },
  { entry: app({ shippedTemplateKind: "bookkeeping" }), slug: "bookkeeping", capability: null },
] as const;

describe("independent Mini App compatibility", () => {
  it("orders canonical release versions beyond machine integer precision", () => {
    expect(compareSemver3("9007199254740993.0.0", "9007199254740992.0.0")).toBeGreaterThan(0);
    expect(compareSemver3("1.0.100", "1.0.99")).toBeGreaterThan(0);
    expect(compareSemver3("1.99.0", "1.100.0")).toBeLessThan(0);
  });

  it.each(packages)("requires the exact installed identity and capability for $slug", ({ entry, slug, capability }) => {
    const mapping = miniAppReleaseMapping(entry)!;
    expect(mapping.packageId).toBe(`mashellhan.${slug}`);
    const exact = capability ? [capability] : [];
    expect(isReleaseCompatible(entry, mapping, exact)).toBe(true);
    expect(isReleaseCompatible({ ...entry, status: "archived" }, mapping, exact)).toBe(false);
    expect(isReleaseCompatible(entry, mapping, [...exact, "future-v1"])).toBe(false);
    expect(isReleaseCompatible(app(), mapping, exact)).toBe(false);
    if (capability) {
      expect(isReleaseCompatible(entry, mapping, [])).toBe(false);
      expect(isReleaseCompatible(entry, mapping, [capability, capability])).toBe(false);
    }
    for (const other of packages.filter((candidate) => candidate.slug !== slug && candidate.capability)) {
      expect(isReleaseCompatible(entry, mapping, [other.capability!])).toBe(false);
    }
  });

  it("disallows HTML release activation after dashboard or media-grant revocation", () => {
    for (const { entry, capability } of packages.slice(0, 3)) {
      const revoked = { ...entry, dashboard: null, nativeKind: null };
      const mapping = miniAppReleaseMapping(revoked)!;
      expect(isReleaseCompatible(revoked, mapping, [capability!])).toBe(false);
    }
  });

  it.each(["bookkeeping", "x_ai_digest", "github_activity"] as const)("keeps %s pending until its existing Data source binds", async (kind) => {
    const entry = app({ shippedTemplateKind: kind });
    const read = vi.fn(async () => { throw new Error("Unbound stock defaults should not request releases."); });
    const source = new MiniAppReleaseSource({ reader: { listReleases: read, viewRelease: read, readAsset: read } });
    const html = pendingDefaultHtml(kind);
    expect(await source.checkUpdate(entry, html, [])).toEqual({ installedVersion: null, status: "unavailable", available: null });
    await expect(source.fetchVerifiedUpdate(entry, html, [], { appVersion: "1.0.0", sourceCommit: "a".repeat(40) }))
      .rejects.toMatchObject({ status: 409 });
    expect(read).not.toHaveBeenCalled();
  });

  it("recognizes separately bound optional Daily X notes without widening the named query", () => {
    const report = reportMiniAppBinding("report-source-fixture", "x_ai_digest");
    const notes: MiniAppDataBinding = {
      id: "editorial", datasetId: "editorial-source-fixture", source: { schema: "main", table: "daily_x_editor_notes" },
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
    };
    expect(acceptsOptionalDailyXEditorial([report])).toBe(true);
    expect(acceptsOptionalDailyXEditorial([report, notes])).toBe(true);
    expect(acceptsOptionalDailyXEditorial([report, { ...notes, source: { ...notes.source, table: "other_table" } }])).toBe(false);
    expect(acceptsOptionalDailyXEditorial([report, { ...notes,
      queries: { editorNote: { ...notes.queries.editorNote!, pageSize: 2 } } }])).toBe(false);
    expect(acceptsOptionalDailyXEditorial([report, notes, { ...notes, id: "another-slot" }])).toBe(false);
    const { datasetId: _reportId, ...reportSlot } = report;
    const { datasetId: _notesId, ...notesSlot } = notes;
    expect(reportReleaseQueriesMatch("x_ai_digest", [reportSlot, notesSlot])).toBe(true);
    expect(reportReleaseQueriesMatch("x_ai_digest", [reportSlot])).toBe(true);
    expect(reportReleaseQueriesMatch("x_ai_digest", [notesSlot])).toBe(false);
  });

  it("checks report and ledger package queries without replacing any local Data binding", () => {
    const portable = ({ id, source, fields, queries }: MiniAppDataBinding) => ({ id, source, fields, queries });
    const report = portable(reportMiniAppBinding("report-data", "github_activity"));
    const detail = portable(githubDeepDiveBinding("report-data"));
    const detailWithCatalog = portable(githubDeepDiveBinding("report-data", { catalog: true }));
    expect(reportReleaseQueriesMatch("github_activity", [report, detail])).toBe(true);
    expect(reportReleaseQueriesMatch("github_activity", [report, detailWithCatalog])).toBe(true);
    expect(reportReleaseQueriesMatch("github_activity", [report, { ...detail, source: { ...detail.source, table: "unrelated" } }])).toBe(false);
    const local: MiniAppDataBinding = { id: "ledger", datasetId: "ledger-data", source: { schema: "custom", table: "records" },
      fields: { amount: { column: "金额", sourceType: "DECIMAL(14,2)", as: "decimal", scale: 2 } },
      queries: { rows: { kind: "rows", parameters: {}, columns: ["amount"], filters: [], orderBy: [], pageSize: 1 } } };
    const ledger = { id: local.id, source: { schema: null, table: null },
      fields: { amount: { column: "amount", sourceType: "DECIMAL(18,2)", as: "decimal" as const, scale: 2 } }, queries: local.queries };
    expect(bookkeepingReleaseQueriesMatch(local, [ledger])).toBe(true);
    expect(bookkeepingReleaseQueriesMatch(local, [{ ...ledger, queries: {} }])).toBe(false);
    expect(bookkeepingReleaseQueriesMatch(local, [{ ...ledger, source: local.source }])).toBe(false);
  });
});
