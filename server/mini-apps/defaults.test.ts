import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as DuckDB from "@duckdb/node-api";
import { afterEach, expect, it, vi } from "vitest";
import type { MiniAppDefaultsInput, MiniAppDocument, MiniAppPublish } from "../../shared/mini-apps.ts";
import { createReportTemplate } from "../../shared/report-mini-app-template.ts";
import { AppDocs } from "../app-docs.ts";
import { createDataEngine } from "../data/engine.ts";
import type { Routine } from "../routines.ts";
import { DefaultMiniApps } from "./defaults.ts";
import { MiniApps, type MiniAppActor } from "./registry.ts";
import { ReportStore } from "./report-store.ts";
import { reportAppsForBot } from "./report-apps.ts";
import { DEFAULT_APPS, pendingDefaultHtml } from "./default-documents.ts";
import { SHIPPED_TEMPLATE_SHA256 } from "./default-template-history.ts";

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
  expect(result.apps).toHaveLength(6);
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
  expect(result.apps).toHaveLength(5);
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
  expect(SHIPPED_TEMPLATE_SHA256.bookkeeping).toContain("31138080fea253d60cbd5286788fae32258530ebd238f3510a43c2358603aed1");
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
