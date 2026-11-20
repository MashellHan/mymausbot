import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as DuckDB from "@duckdb/node-api";
import { afterEach, expect, it, vi } from "vitest";
import type { MiniAppDefaultsInput, MiniAppDocument, MiniAppPublish } from "../../shared/mini-apps.ts";
import { githubDeepDiveBinding, reportMiniAppBinding } from "../../shared/report-mini-app.ts";
import { createReportTemplate } from "../../shared/report-mini-app-template.ts";
import { AppDocs } from "../app-docs.ts";
import { createDataEngine } from "../data/engine.ts";
import type { Routine } from "../routines.ts";
import { DefaultMiniApps } from "./defaults.ts";
import { MiniApps, type MiniAppActor } from "./registry.ts";
import { ReportStore } from "./report-store.ts";
import { hasReportBindingForProducer, reportAppsForBot } from "./report-apps.ts";
import { dispatchRoutineReportTurn } from "../routine-report-publication.ts";
import { DEFAULT_APPS, pendingDefaultHtml } from "./default-documents.ts";
import { REVIEWED_AGENT_TEAM_HTML_SHA256, SHIPPED_TEMPLATE_SHA256 } from "./default-template-history.ts";

vi.mock("./default-template-history.ts", async (original) => {
  const history = await original<typeof import("./default-template-history.ts")>();
  const { SHIPPED_TEMPLATE_SHA256 } = history;
  const { createHash } = await import("node:crypto");
  const digest = (html: string) => createHash("sha256").update(html).digest("hex");
  return { ...history, SHIPPED_TEMPLATE_SHA256: {
    bookkeeping: [...SHIPPED_TEMPLATE_SHA256.bookkeeping, digest("<h1>Ledger</h1>")],
    x_ai_digest: [...SHIPPED_TEMPLATE_SHA256.x_ai_digest, digest("<h1>Bundled report</h1>")],
    github_activity: [...SHIPPED_TEMPLATE_SHA256.github_activity, digest("<h1>Bundled report</h1>")],
  } };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const owner: MiniAppActor = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
const input: MiniAppDefaultsInput = { bookkeepingHtml: "<h1>Ledger</h1>" };
const bundledTeamHtml = readFileSync(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8");
const teamInput: MiniAppDefaultsInput = { ...input, agentTeamHtml: bundledTeamHtml };
const legacyTeamHtml = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Built-in dashboard</title><body>Open this app in the OpenMausBot desktop app.</body></html>';
const bundledBookkeepingHtml = readFileSync(new URL("../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");
const ledgerSql = 'CREATE TABLE ledger_master ("分类" VARCHAR, "时间" VARCHAR, "金额" VARCHAR, "账户" VARCHAR, "账本" VARCHAR, "货币" VARCHAR, "备注" VARCHAR)';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-default-apps-"));
  const database = new DatabaseSync(join(root, "registry.db"));
  const bots = [{ id: "ledger" }, { id: "reports" }];
  const routines: Routine[] = [];
  const write = <T>(work: (db: DatabaseSync) => T): T => work(database);
  const data = createDataEngine({ dataDir: root, botFolder: (id) => join(root, "bots", id), binding: DuckDB,
    catalog: { getDatabase: () => database, withWrite: write } });
  const apps = new MiniApps({ data, docs: new AppDocs(join(root, "docs")), validPublisher: (id) => bots.some((bot) => bot.id === id),
    access: { database: () => database, write } });
  const deps = { apps, data, bots: () => bots, routines: () => ({ listRoutines: () => routines }), reports: new ReportStore(data, createReportTemplate) };
  const defaults = new DefaultMiniApps(deps);
  cleanups.push(async () => { await data.closeAll(); database.close(); rmSync(root, { recursive: true, force: true }); });
  return { data, apps, bots, routines, defaults, restarted: () => new DefaultMiniApps(deps) };
}

function publication(document: MiniAppDocument): MiniAppPublish {
  return { requestKey: "edit", expectedRevision: document.app.revision, slug: document.app.slug, title: document.app.title,
    description: document.app.description, html: document.html, bindings: document.bindings };
}

it("keeps custom slugs, removals and revoked dashboard grants across default initialization", async () => {
  const { defaults, apps, restarted } = fixture();
  const custom = await apps.publish(owner, { requestKey: "custom", expectedRevision: 0, slug: "usage", title: "My usage notes",
    description: "Custom", html: "<p>Custom</p>", bindings: [] });
  const result = await defaults.ensure(owner, input);
  expect(result.issues).toEqual([]);
  expect(result.apps).toHaveLength(7);
  expect(result.apps.find((app) => app.id === custom.app.id)).toEqual(custom.app);
  const native = result.apps.find((app) => app.dashboardIdentity === "usage")!;
  expect(native.slug).toBe("usage-included-1");
  const revoked = await apps.publish(owner, { ...publication(apps.document(owner, native.id)), dashboardKind: null }, native.id);
  const book = result.apps.find((app) => app.shippedTemplateKind === "bookkeeping")!;
  apps.archive(owner, book.id, { requestKey: "remove", expectedRevision: book.revision });
  const again = await restarted().ensure(owner, input);
  expect(again.apps.find((app) => app.id === native.id)).toEqual(revoked.app);
  expect(again.apps.find((app) => app.id === book.id)?.status).toBe("archived");
  expect((await defaults.ensure(owner, { ...input, restore: "usage" })).apps.find((app) => app.id === native.id)?.dashboard?.kind).toBe("usage");
  expect((await defaults.ensure(owner, { ...input, restore: "bookkeeping" })).apps.find((app) => app.id === book.id)?.status).toBe("active");
});

it("migrates only the installed placeholder to reviewed Agent Team HTML", async () => {
  expect(REVIEWED_AGENT_TEAM_HTML_SHA256).toBe(createHash("sha256").update(teamInput.agentTeamHtml!).digest("hex"));
  const { defaults, apps } = fixture();
  const initial = await defaults.ensure(owner, input);
  const old = initial.apps.find((app) => app.dashboardIdentity === "agent-team")!;
  expect(old.dashboard).toMatchObject({ renderer: "native" });
  const migrated = await defaults.ensure(owner, teamInput);
  expect(migrated.issues).toEqual([]);
  const team = migrated.apps.find((app) => app.id === old.id)!;
  expect(team).toMatchObject({ revision: 2, dashboard: { renderer: "html", htmlRole: "primary" } });
  expect(apps.document(owner, old.id).html).toBe(teamInput.agentTeamHtml);
  expect((await defaults.ensure(owner, teamInput)).apps.find((app) => app.id === old.id)?.revision).toBe(2);

  const custom = (await apps.publish(owner, { ...publication(apps.document(owner, old.id)),
    requestKey: "custom-team", html: "<p>Custom vB</p>" }, old.id)).app;
  expect((await defaults.ensure(owner, teamInput)).apps.find((app) => app.id === old.id)).toEqual(custom);
  const revoked = (await apps.publish(owner, { ...publication(apps.document(owner, old.id)),
    requestKey: "revoke-team", dashboardKind: null }, old.id)).app;
  expect((await defaults.ensure(owner, teamInput)).apps.find((app) => app.id === old.id)).toEqual(revoked);
  expect(() => defaults.ensure(owner, { ...input, agentTeamHtml: "<p>Unreviewed</p>" })).toThrow("not reviewed");
});

it("adopts the exact historical stock fallback while preserving metadata-only history and refusing custom rollback history", async () => {
  expect(createHash("sha256").update(legacyTeamHtml).digest("hex"))
    .toBe("c3740f8ef57d3b00e6956bd9a168a45a4622afeb4e94edf817958939706c56ee");
  const createLegacy = async () => {
    const context = fixture();
    const first = (await context.apps.publish(owner, { requestKey: "legacy-team", expectedRevision: 0,
      slug: "agent-team", title: "Owner title", description: "Owner description", html: legacyTeamHtml,
      bindings: [], publisherBotIds: ["ledger"], dashboardKind: "agent-team" })).app;
    return { ...context, first };
  };
  const installed = await createLegacy();
  expect(installed.apps.canAdoptAgentTeamDefault(owner, installed.first.id)).toBe(true);
  const adopted = (await installed.defaults.ensure(owner, teamInput)).apps.find((app) => app.id === installed.first.id)!;
  expect(adopted).toMatchObject({ id: installed.first.id, revision: 2, title: "Owner title",
    description: "Owner description", publisherBotIds: ["ledger"], dashboard: { renderer: "html" } });
  expect(installed.apps.document(owner, adopted.id).html).toBe(bundledTeamHtml);

  const metadata = await createLegacy();
  await metadata.apps.publish(owner, { ...publication(metadata.apps.document(owner, metadata.first.id)),
    requestKey: "title-only", title: "Personal title" }, metadata.first.id);
  expect(metadata.apps.canAdoptAgentTeamDefault(owner, metadata.first.id)).toBe(true);
  const after = (await metadata.defaults.ensure(owner, teamInput)).apps.find((app) => app.id === metadata.first.id)!;
  expect(after).toMatchObject({ revision: 3, title: "Personal title", publisherBotIds: ["ledger"], dashboard: { renderer: "html" } });

  const custom = await createLegacy();
  await custom.apps.publish(owner, { ...publication(custom.apps.document(owner, custom.first.id)),
    requestKey: "custom-page", html: "<p>Personal page</p>" }, custom.first.id);
  await custom.apps.rollback(owner, custom.first.id, { requestKey: "old-page", expectedRevision: 2, templateVersion: 1 });
  expect(custom.apps.canAdoptAgentTeamDefault(owner, custom.first.id)).toBe(false);
  const unchanged = (await custom.defaults.ensure(owner, teamInput)).apps.find((app) => app.id === custom.first.id)!;
  expect(unchanged).toMatchObject({ revision: 3, dashboard: { renderer: "native" } });
  expect(custom.apps.document(owner, unchanged.id).html).toBe(legacyTeamHtml);
});

it("installs Hongguo by owner identity and restores its revoked grant only when asked", async () => {
  const { defaults, apps, restarted } = fixture();
  const slugOnly = await apps.publish(owner, { requestKey: "custom-hongguo", expectedRevision: 0,
    slug: "hongguo", title: "My notes", description: "Custom", html: "<p>Notes</p>", bindings: [] });
  const initial = await defaults.ensure(owner, input);
  expect(initial.issues).toEqual([]);
  expect(initial.apps.find((app) => app.id === slugOnly.app.id)?.nativeKind).toBeNull();
  const native = initial.apps.find((app) => app.nativeIdentity === "hongguo")!;
  expect(native).toMatchObject({ slug: "hongguo-included-1", nativeKind: "hongguo", publisherBotIds: [] });
  const revoked = await apps.publish(owner, { ...publication(apps.document(owner, native.id)),
    requestKey: "revoke-hongguo", nativeKind: null }, native.id);
  expect((await restarted().ensure(owner, input)).apps.find((app) => app.id === native.id)).toEqual(revoked.app);
  expect((await defaults.ensure(owner, { ...input, restore: "hongguo" })).apps.find((app) => app.id === native.id))
    .toMatchObject({ revision: 3, nativeKind: "hongguo", nativeIdentity: "hongguo" });
});

it("waits for one unambiguous ledger and connects it without creating unrelated stores", async () => {
  const { defaults, data, apps } = fixture();
  const initial = await defaults.ensure(owner, input);
  const app = initial.apps.find((entry) => entry.shippedTemplateKind === "bookkeeping")!;
  expect(await data.listBotSources("workspace-owner", ["ledger", "reports"])).toEqual([]);
  const first = await data.forBot("ledger"), second = await data.forBot("reports");
  await first.run(ledgerSql, { connection: "bot", businessMutation: true });
  await second.run(ledgerSql, { connection: "bot", businessMutation: true });
  const ambiguous = await defaults.ensure(owner, input);
  expect(ambiguous.issues).toEqual([{ kind: "bookkeeping", error: expect.stringContaining("More than one existing ledger") }]);
  expect(apps.document(owner, app.id).bindings).toEqual([]);
  expect(await data.listDatasets("workspace-owner")).toEqual([]);
  await second.run("DROP TABLE ledger_master", { connection: "bot", businessMutation: true });
  expect((await defaults.ensure(owner, input)).issues).toEqual([]);
  const connected = apps.document(owner, app.id);
  expect(connected.app).toMatchObject({ revision: 2, publisherBotIds: ["ledger"] });
  expect(connected.bindings[0]?.source.table).toBe("ledger_master");
  expect((await data.listDatasets("workspace-owner"))).toHaveLength(1);
  expect((await defaults.ensure(owner, input)).apps.find((entry) => entry.id === app.id)?.revision).toBe(2);
  await first.run(`INSERT INTO ledger_master VALUES
    ('Food', '2026-04-04', '-0.10', 'Card', 'Daily', 'CNY', 'First'),
    ('Food', '2026-04-04', '-0.20', 'Card', 'Daily', 'RMB', 'Second'),
    ('Food', '2026-04-04', '-10.00', 'Card', 'Daily', 'USD', 'Foreign')`, { connection: "bot", businessMutation: true });
  const amounts = await apps.query(owner, app.id, { queryId: "outflow", expectedRevision: 2, parameters: { currencies: ["CNY", "RMB"] } });
  expect(amounts.rows).toEqual([["CNY", "1", "-0.10"], ["RMB", "1", "-0.20"]]);
});

it("does not assign a report source when multiple producer Bots match", async () => {
  const { defaults, routines, data } = fixture();
  const routine = (id: string, botId: string): Routine => ({ id, botId, name: "Daily X AI report", prompt: "Gather sources.",
    enabled: true, target: "bot", runOn: "maus", schedule: { type: "interval", everyMinutes: 1440, anchorAt: 1 },
    durationMinutes: 0, nextRunAt: null, createdAt: 1, updatedAt: 1 });
  routines.push(routine("one", "ledger"), routine("two", "reports"));
  const result = await defaults.ensure(owner, input);
  expect(result.apps).toHaveLength(6);
  expect(result.issues).toEqual([{ kind: "x_ai_digest", error: expect.stringContaining("More than one Bot") }]);
  expect(result.apps.find((app) => app.shippedTemplateKind === "x_ai_digest")?.publisherBotIds).toEqual([]);
  expect(await data.listBotSources("workspace-owner", ["ledger", "reports"])).toEqual([]);
  routines.pop();
  expect((await defaults.ensure(owner, input)).apps.find((app) => app.shippedTemplateKind === "x_ai_digest")?.publisherBotIds).toEqual(["ledger"]);
});

it("keeps owner titles and descriptions when a waiting default gains its ledger", async () => {
  const { defaults, apps, data } = fixture();
  const app = (await defaults.ensure(owner, input)).apps.find((entry) => entry.shippedTemplateKind === "bookkeeping")!;
  await apps.publish(owner, { ...publication(apps.document(owner, app.id)), title: "Family budget", description: "Our household records" }, app.id);
  await (await data.forBot("ledger")).run(ledgerSql, { connection: "bot", businessMutation: true });
  const connected = (await defaults.ensure(owner, input)).apps.find((entry) => entry.id === app.id)!;
  expect(connected).toMatchObject({ title: "Family budget", description: "Our household records", revision: 3, publisherBotIds: ["ledger"] });
  expect(apps.document(owner, app.id).bindings).toHaveLength(1);
  expect((await defaults.ensure(owner, input)).apps.find((entry) => entry.id === app.id)).toEqual(connected);
});

it("does not add apps for Bots or read-only actors", () => {
  const { defaults, apps } = fixture();
  expect(() => defaults.ensure({ ...owner, botId: "ledger" }, input)).toThrow("Only the local workspace owner");
  expect(() => defaults.ensure({ ...owner, writeAllowed: false }, input)).toThrow("Only the local workspace owner");
  expect(() => defaults.ensure(owner, { ...input, restore: "unknown" })).toThrow("Pass the bundled");
  expect(apps.list(owner)).toEqual([]);
});

it("updates an untouched bundled page in place without rediscovering Data or restoring publisher grants", async () => {
  expect(SHIPPED_TEMPLATE_SHA256.bookkeeping).toContain("2cdf85124737205c693df442bff7e8da5190aa8df8c7e42dde4b901be96789e9");
  expect(SHIPPED_TEMPLATE_SHA256.bookkeeping).not.toContain(createHash("sha256").update(bundledBookkeepingHtml).digest("hex"));
  const { defaults, apps, data, restarted } = fixture();
  const ledger = await data.forBot("ledger");
  await ledger.run(ledgerSql, { connection: "bot", businessMutation: true });
  await ledger.run(`INSERT INTO ledger_master VALUES
    ('Food', '2025-03-01', '-12.34', 'Card', 'Daily', 'CNY', 'Lunch')`, { connection: "bot", businessMutation: true });
  const app = (await defaults.ensure(owner, input)).apps.find((entry) => entry.shippedTemplateKind === "bookkeeping")!;
  const before = apps.document(owner, app.id);
  await apps.publish(owner, { ...publication(before), title: "Family ledger", description: "Our records", publisherBotIds: [] }, app.id);
  await (await data.forBot("reports")).run(ledgerSql, { connection: "bot", businessMutation: true });
  const updatedInput = { bookkeepingHtml: bundledBookkeepingHtml };
  const result = await restarted().ensure(owner, updatedInput);
  expect(result.issues).toEqual([]);
  const updated = apps.document(owner, app.id);
  expect(updated.app).toMatchObject({ id: app.id, slug: app.slug, title: "Family ledger", description: "Our records",
    publisherBotIds: [], revision: 3, templateVersion: 3 });
  expect(updated.html).toBe(updatedInput.bookkeepingHtml);
  expect(updated.bindings).toEqual(before.bindings);
  expect(new Set(updated.versions.map((version) => version.version))).toEqual(new Set([1, 2, 3]));
  expect((await data.listDatasets("workspace-owner"))).toHaveLength(1);
  expect((await apps.query(owner, app.id, { queryId: "summary", parameters: {}, expectedRevision: 3 })).rows)
    .toEqual([["CNY", "1", "-12.34"]]);
  await defaults.ensure(owner, updatedInput);
  expect(apps.document(owner, app.id)).toEqual(updated);
  await apps.rollback(owner, app.id, { requestKey: "keep-previous-page", expectedRevision: 3, templateVersion: 2 });
  const rollback = apps.document(owner, app.id);
  await defaults.ensure(owner, updatedInput);
  expect(apps.document(owner, app.id)).toEqual(rollback);
});

it("preserves custom pages and query edits, and only updates a removed app when explicitly restored", async () => {
  const { defaults, apps, data } = fixture();
  await (await data.forBot("ledger")).run(ledgerSql, { connection: "bot", businessMutation: true });
  const app = (await defaults.ensure(owner, input)).apps.find((entry) => entry.shippedTemplateKind === "bookkeeping")!;
  const original = apps.document(owner, app.id);
  const updatedInput = { bookkeepingHtml: "<main>Updated ledger</main>" };
  const custom = await apps.publish(owner, { ...publication(original), html: "<main>My custom page</main>" }, app.id);
  expect((await defaults.ensure(owner, updatedInput)).apps.find((entry) => entry.id === app.id)).toEqual(custom.app);
  const bindings = structuredClone(original.bindings);
  bindings[0]!.queries.details!.pageSize = 10;
  const customQuery = await apps.publish(owner, { ...publication(apps.document(owner, app.id)),
    requestKey: "query-edit", html: input.bookkeepingHtml, bindings }, app.id);
  expect((await defaults.ensure(owner, updatedInput)).apps.find((entry) => entry.id === app.id)).toEqual(customQuery.app);
  await apps.publish(owner, { ...publication(apps.document(owner, app.id)), requestKey: "bundled-page", bindings: original.bindings }, app.id);
  const current = apps.document(owner, app.id);
  apps.archive(owner, app.id, { requestKey: "remove", expectedRevision: current.app.revision });
  const archived = apps.document(owner, app.id);
  await defaults.ensure(owner, updatedInput);
  expect(apps.document(owner, app.id)).toEqual(archived);
  await defaults.ensure(owner, { ...updatedInput, restore: "bookkeeping" });
  expect(apps.document(owner, app.id)).toMatchObject({ html: updatedInput.bookkeepingHtml, bindings: original.bindings,
    app: { id: app.id, status: "active", revision: archived.app.revision + 1 } });
});

it("upgrades bundled report pages without changing their retained editions or publisher grants", async () => {
  const hashes = {
    x_ai_digest: { previous: "01072481dd6d85afb991ca835c153f401f1a59a5844eb502dd4bd9ee69194523",
      current: "c13dd3fa12979df58d3b6679f6a6496628c643a30a02b7119d376804324e5651" },
    github_activity: { previous: "8d80cef615e76ccb5a8a65861c5f966a69ff430a1ad5718924aa03d1712f8cc7",
      current: "963f24b2e95a62e725e605365ca081cb4b19a8dad6a126d137d2871cdc53d0f7" },
  };
  for (const kind of ["x_ai_digest", "github_activity"] as const) {
    expect(SHIPPED_TEMPLATE_SHA256[kind]).toContain(hashes[kind].previous);
    expect(createHash("sha256").update(createReportTemplate(kind)).digest("hex")).toBe(hashes[kind].current);
    expect(SHIPPED_TEMPLATE_SHA256[kind]).toContain(hashes[kind].current);
    const { defaults, apps, data } = fixture();
    const reports = new ReportStore(data, () => "<h1>Bundled report</h1>");
    const source = await reports.prepare("reports", kind);
    await reports.publish("reports", kind, { editionKey: "2025-03-01", windowStartAt: null, windowEndAt: null,
      sourceAsOfAt: null, coverageStatus: "partial", coverageNote: "Synthetic fixture", items: [{
        title: "Fixture project", summary: "A retained report item", sourceLabel: "Fixture source",
        sourceUrl: "https://github.com/example/project", sourcePublishedAt: null, attribution: "primary",
        repoFullName: "example/project", selectionBasis: "Synthetic fixture",
      }] });
    const published = await apps.publish(owner, { ...source.publication, requestKey: `install-${kind}`, shippedTemplateKind: kind,
      title: kind === "github_activity" ? "GitHub activity" : "My AI digest", publisherBotIds: [] });
    const before = apps.document(owner, published.app.id);
    const dataBefore = (await apps.state(owner, published.app.id)).data;
    const result = await defaults.ensure(owner, input);
    expect(result.issues).toEqual([]);
    const updated = apps.document(owner, published.app.id);
    expect(updated.html).toBe(createReportTemplate(kind));
    expect(updated.bindings).toEqual(before.bindings);
    expect(new Set(updated.versions.map((version) => version.version))).toEqual(new Set([1, 2]));
    expect((await apps.state(owner, published.app.id)).data).toEqual(dataBefore);
    const edition = await apps.query(owner, published.app.id, { queryId: "current", parameters: {}, expectedRevision: 2 });
    expect(edition.rows).toHaveLength(1);
    expect(edition.rows[0]).toContain("2025-03-01");
    expect(updated.app).toMatchObject({ id: published.app.id, revision: 2, publisherBotIds: [],
      title: kind === "github_activity" ? DEFAULT_APPS.github_activity.title : "My AI digest" });
    const state = await apps.state(owner, published.app.id);
    await defaults.ensure(owner, input);
    expect(await apps.state(owner, published.app.id)).toEqual(state);
  }
});

it("connects a stock report waiting under its previous name without replacing custom or removed pages", async () => {
  const { defaults, apps, routines } = fixture();
  const app = (await defaults.ensure(owner, input)).apps.find((entry) => entry.shippedTemplateKind === "github_activity")!;
  const legacyHtml = pendingDefaultHtml("github_activity").replaceAll(DEFAULT_APPS.github_activity.title, "GitHub activity");
  const custom = await apps.publish(owner, { ...publication(apps.document(owner, app.id)),
    html: `${legacyHtml}<p>My report notes</p>` }, app.id);
  routines.push({ id: "github", botId: "reports", name: "GitHub discovery report", prompt: "Gather sources.",
    enabled: true, target: "bot", runOn: "maus", schedule: { type: "interval", everyMinutes: 1440, anchorAt: 1 },
    durationMinutes: 0, nextRunAt: null, createdAt: 1, updatedAt: 1 });
  expect((await defaults.ensure(owner, input)).apps.find((entry) => entry.id === app.id)).toEqual(custom.app);
  const legacy = await apps.publish(owner, { ...publication(apps.document(owner, app.id)),
    requestKey: "previous-default", title: "GitHub activity", html: legacyHtml }, app.id);
  const archived = apps.archive(owner, app.id, { requestKey: "remove", expectedRevision: legacy.app.revision });
  expect((await defaults.ensure(owner, input)).apps.find((entry) => entry.id === app.id)).toEqual(archived.app);
  const restored = await defaults.ensure(owner, { ...input, restore: "github_activity" });
  expect(restored.issues).toEqual([]);
  expect(restored.apps.find((entry) => entry.id === app.id)).toMatchObject({ title: DEFAULT_APPS.github_activity.title,
    revision: archived.app.revision + 1, status: "active", publisherBotIds: ["reports"] });
  const connected = apps.document(owner, app.id);
  expect(connected.bindings).toHaveLength(1);
  expect(connected.html).toBe(createReportTemplate("github_activity"));
  expect((await defaults.ensure(owner, input)).apps.find((entry) => entry.id === app.id)).toEqual(connected.app);
});

it("advertises only the producer's current exact report binding without relying on a fixed slug", async () => {
  const { apps, data, bots } = fixture();
  const deps = { apps, data, bots: () => bots, localEnabled: () => true };
  expect(await reportAppsForBot(deps, "reports")).toEqual([]);
  expect(await data.listBotSources("workspace-owner", ["reports"])).toEqual([]);
  const source = await new ReportStore(data, createReportTemplate).prepare("reports", "x_ai_digest");
  const { app } = await apps.publish(owner, { ...source.publication, slug: "x-ai-digest-included-1",
    shippedTemplateKind: "x_ai_digest", publisherBotIds: ["reports"] });
  expect(await reportAppsForBot(deps, "reports")).toEqual([{ slug: app.slug, status: "active",
    shippedTemplateKind: "x_ai_digest", publisherBotIds: ["reports"], reportBoundToProducer: true }]);
  expect(await reportAppsForBot({ ...deps, localEnabled: () => false }, "reports")).toEqual([]);
  expect(await reportAppsForBot(deps, "ledger")).toEqual([]);
  const changed = apps.document(owner, app.id);
  changed.bindings[0]!.queries.current!.pageSize = 2;
  await apps.publish(owner, publication(changed), app.id);
  expect((await reportAppsForBot(deps, "reports"))[0]?.reportBoundToProducer).toBe(false);
  const current = apps.document(owner, app.id);
  await apps.publish(owner, { ...publication(current), requestKey: "revoke", publisherBotIds: [] }, app.id);
  expect(await reportAppsForBot(deps, "reports")).toEqual([]);
});

it("keeps reportAppsForBot, chunked deep_dive reads, and the Automation prompt chain working for github_activity with the producer-owned deepDive binding", async () => {
  const { apps, data, bots } = fixture();
  const deps = { apps, data, bots: () => bots, localEnabled: () => true };
  const source = await new ReportStore(data, createReportTemplate).prepare("reports", "github_activity");
  const botDb = await data.forBot("reports");
  await botDb.run(`CREATE TABLE main.github_deep_dive_v1 (
    edition_key VARCHAR NOT NULL,
    repo VARCHAR NOT NULL,
    schema_version INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    part_count INTEGER NOT NULL,
    payload_chunk VARCHAR NOT NULL,
    PRIMARY KEY (edition_key, repo, schema_version, part_index)
  )`, { connection: "bot", businessMutation: true });
  const chunk0 = "A".repeat(1500);
  const chunk1 = "B".repeat(1500);
  await botDb.run(`INSERT INTO main.github_deep_dive_v1 VALUES
    ('2026-11-20', 'dream-num/univer', 1, 1, 2, '${chunk1}'),
    ('2026-11-20', 'dream-num/univer', 1, 0, 2, '${chunk0}')`, { connection: "bot", businessMutation: true });
  const deepDive = githubDeepDiveBinding(source.dataset.datasetId);
  const { app } = await apps.publish(owner, {
    ...source.publication,
    requestKey: "github-deep-dive-positive",
    slug: "github-activity",
    shippedTemplateKind: "github_activity",
    publisherBotIds: ["reports"],
    bindings: [reportMiniAppBinding(source.dataset.datasetId, "github_activity"), deepDive],
  });
  expect(await reportAppsForBot(deps, "reports")).toEqual([{
    slug: app.slug, status: "active", shippedTemplateKind: "github_activity",
    publisherBotIds: ["reports"], reportBoundToProducer: true,
  }]);
  expect(await reportAppsForBot(deps, "ledger")).toEqual([]);
  const chunkPage = await apps.query(owner, app.id, {
    queryId: "deep_dive",
    parameters: { editionKey: "2026-11-20", repo: "dream-num/univer" },
    expectedRevision: app.revision,
  });
  expect(chunkPage.rows).toEqual([
    ["2026-11-20", "dream-num/univer", "1", "0", "2", chunk0],
    ["2026-11-20", "dream-num/univer", "1", "1", "2", chunk1],
  ]);
  // Multi-page (>16 parts) chunked read preserves partIndex asc order across nextCursor.
  const multiValues = Array.from({ length: 18 }, (_, i) => `('2026-11-20', 'example/big', 1, ${17 - i}, 18, 'part-${17 - i}')`).join(", ");
  await botDb.run(`INSERT INTO main.github_deep_dive_v1 VALUES ${multiValues}`, { connection: "bot", businessMutation: true });
  const page1 = await apps.query(owner, app.id, {
    queryId: "deep_dive",
    parameters: { editionKey: "2026-11-20", repo: "example/big" },
    expectedRevision: app.revision,
  });
  expect(page1.rows).toHaveLength(16);
  expect(page1.nextCursor).toBeTruthy();
  const page2 = await apps.query(owner, app.id, {
    queryId: "deep_dive",
    parameters: { editionKey: "2026-11-20", repo: "example/big" },
    expectedRevision: app.revision,
    cursor: page1.nextCursor!,
  });
  expect(page2.rows).toHaveLength(2);
  expect(page2.nextCursor).toBeUndefined();
  expect([...page1.rows, ...page2.rows].map((r) => r[3])).toEqual(Array.from({ length: 18 }, (_, i) => String(i)));

  // Real Automation prompt-chain proof: [Installed report edition] is injected when 2-binding github_activity is bound.
  const basePrompt = "[Scheduled routine \"GitHub discovery report\" — do this now:]\nCollect open-source updates.";
  const dispatched: string[] = [];
  const run = { id: "run-gh-1", routineId: "routine-gh", botId: "reports", target: "bot" as const, runOn: "maus" as const, status: "running" as const, triggerSource: "schedule" as const };
  const routine: Routine = { id: "routine-gh", botId: "reports", name: "GitHub discovery report", prompt: "Collect open-source updates.",
    enabled: true, target: "bot", runOn: "maus", schedule: { type: "interval", everyMinutes: 1440, anchorAt: 1 }, durationMinutes: 0, nextRunAt: null, createdAt: 1, updatedAt: 1 };
  await dispatchRoutineReportTurn(basePrompt, "reports", "thread-gh", {
    routines: { runForThread: () => run, listRoutines: () => [routine] },
    botForId: (id) => (id === "reports" ? { id: "reports" } : null),
    reportAppsForBot: (botId) => reportAppsForBot(deps, botId),
    localEnabled: () => true,
    writeAllowed: () => true,
    stopped: () => false,
  }, async (prompt) => { dispatched.push(prompt); });
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]).toContain("[Installed report edition]");
  expect(dispatched[0]).toContain("mini_app_report with action \"publish\", kind \"github_activity\"");

  // Negative admission cases: report must remain first, deepDive must match exact schema/query, datasetId must match producer, no 3rd binding.
  await apps.publish(owner, {
    ...publication(apps.document(owner, app.id)),
    requestKey: "github-deep-dive-swapped",
    bindings: [deepDive, reportMiniAppBinding(source.dataset.datasetId, "github_activity")],
  }, app.id);
  expect((await reportAppsForBot(deps, "reports"))[0]?.reportBoundToProducer).toBe(false);

  const legacyContentJsonBinding = {
    id: "deepDive",
    datasetId: source.dataset.datasetId,
    source: { schema: "main", table: "github_deep_dive_v1" },
    fields: {
      editionKey: { column: "edition_key", sourceType: "VARCHAR", as: "text" as const },
      repo: { column: "repo", sourceType: "VARCHAR", as: "text" as const },
      schemaVersion: { column: "schema_version", sourceType: "INTEGER", as: "decimal" as const, scale: 0 },
      contentJson: { column: "content_json", sourceType: "VARCHAR", as: "text" as const },
    },
    queries: {
      deep_dive: {
        kind: "rows" as const,
        columns: ["editionKey", "repo", "schemaVersion", "contentJson"],
        parameters: { editionKey: { type: "text" as const }, repo: { type: "text" as const } },
        filters: [
          { field: "editionKey", op: "eq" as const, parameter: "editionKey" },
          { field: "repo", op: "eq" as const, parameter: "repo" },
          { field: "schemaVersion", op: "eq" as const, literal: "1" },
        ],
        orderBy: [],
        pageSize: 1,
      },
    },
  };
  expect(
    hasReportBindingForProducer(
      [reportMiniAppBinding(source.dataset.datasetId, "github_activity"), legacyContentJsonBinding],
      source.dataset.datasetId,
      "github_activity",
    ),
  ).toBe(false);

  const unorderedDeepDive = githubDeepDiveBinding(source.dataset.datasetId);
  unorderedDeepDive.queries.deep_dive!.orderBy = [];
  await apps.publish(owner, {
    ...publication(apps.document(owner, app.id)),
    requestKey: "github-deep-dive-unordered",
    bindings: [reportMiniAppBinding(source.dataset.datasetId, "github_activity"), unorderedDeepDive],
  }, app.id);
  expect((await reportAppsForBot(deps, "reports"))[0]?.reportBoundToProducer).toBe(false);

  const mutatedDeepDive = githubDeepDiveBinding(source.dataset.datasetId);
  mutatedDeepDive.queries.deep_dive!.pageSize = 2;
  await apps.publish(owner, {
    ...publication(apps.document(owner, app.id)),
    requestKey: "github-deep-dive-mutated",
    bindings: [reportMiniAppBinding(source.dataset.datasetId, "github_activity"), mutatedDeepDive],
  }, app.id);
  expect((await reportAppsForBot(deps, "reports"))[0]?.reportBoundToProducer).toBe(false);

  const extraThird = { ...githubDeepDiveBinding(source.dataset.datasetId), id: "deepDiveExtra", queries: { deep_dive_extra: githubDeepDiveBinding(source.dataset.datasetId).queries.deep_dive! } };
  await apps.publish(owner, {
    ...publication(apps.document(owner, app.id)),
    requestKey: "github-deep-dive-third-binding",
    bindings: [reportMiniAppBinding(source.dataset.datasetId, "github_activity"), deepDive, extraThird],
  }, app.id);
  expect((await reportAppsForBot(deps, "reports"))[0]?.reportBoundToProducer).toBe(false);

  const ledgerDb = await data.forBot("ledger");
  await ledgerDb.run(`CREATE TABLE main.github_deep_dive_v1 (
    edition_key VARCHAR NOT NULL,
    repo VARCHAR NOT NULL,
    schema_version INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    part_count INTEGER NOT NULL,
    payload_chunk VARCHAR NOT NULL
  )`, { connection: "bot", businessMutation: true });
  const foreignDataset = (await data.promoteForBot("ledger", "workspace-owner")).datasetId;
  await apps.publish(owner, {
    ...publication(apps.document(owner, app.id)),
    requestKey: "github-deep-dive-foreign",
    bindings: [reportMiniAppBinding(source.dataset.datasetId, "github_activity"), githubDeepDiveBinding(foreignDataset)],
  }, app.id);
  expect((await reportAppsForBot(deps, "reports"))[0]?.reportBoundToProducer).toBe(false);

  const rejectedDispatched: string[] = [];
  await dispatchRoutineReportTurn(basePrompt, "reports", "thread-gh", {
    routines: { runForThread: () => run, listRoutines: () => [routine] },
    botForId: (id) => (id === "reports" ? { id: "reports" } : null),
    reportAppsForBot: (botId) => reportAppsForBot(deps, botId),
    localEnabled: () => true,
    writeAllowed: () => true,
    stopped: () => false,
  }, async (prompt) => { rejectedDispatched.push(prompt); });
  expect(rejectedDispatched).toEqual([basePrompt]);

  // x_ai_digest remains strictly limited to the single canonical report binding.
  const xSource = await new ReportStore(data, createReportTemplate).prepare("reports", "x_ai_digest");
  const { app: xApp } = await apps.publish(owner, {
    ...xSource.publication,
    requestKey: "x-extra-binding-rejected",
    slug: "x-ai-digest-extra",
    shippedTemplateKind: "x_ai_digest",
    publisherBotIds: ["reports"],
    bindings: [reportMiniAppBinding(xSource.dataset.datasetId, "x_ai_digest"), deepDive],
  });
  expect((await reportAppsForBot(deps, "reports")).find((entry) => entry.slug === xApp.slug)?.reportBoundToProducer).toBe(false);
});
