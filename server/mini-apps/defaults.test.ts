import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as DuckDB from "@duckdb/node-api";
import { afterEach, expect, it } from "vitest";
import type { MiniAppDefaultsInput, MiniAppDocument, MiniAppPublish } from "../../shared/mini-apps.ts";
import { createReportTemplate } from "../../shared/report-mini-app-template.ts";
import { AppDocs } from "../app-docs.ts";
import { createDataEngine } from "../data/engine.ts";
import type { Routine } from "../routines.ts";
import { DefaultMiniApps } from "./defaults.ts";
import { MiniApps, type MiniAppActor } from "./registry.ts";
import { ReportStore } from "./report-store.ts";
import { reportAppsForBot } from "./report-apps.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const owner: MiniAppActor = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
const input: MiniAppDefaultsInput = { bookkeepingHtml: "<h1>Ledger</h1>" };
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
