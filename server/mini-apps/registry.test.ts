import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniAppDataBinding, MiniAppNamedPage } from "../../shared/mini-app-data.ts";
import type { MiniAppPublish } from "../../shared/mini-apps.ts";
import type { LocalAgentActivityResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "../../shared/local-dashboard.ts";
import { AppDocs, APP_DOCS_SWEEP_GRACE_MS } from "../app-docs.ts";
import { DATA_DIR } from "../config.ts";
import { applicationDatabase, closeMessageDb } from "../message-db.ts";
import type { LocalDashboardProviders } from "../routes/local-dashboard.ts";
import { MiniApps, MINI_APPS_OWNER, miniAppDocRefs, type MiniAppActor } from "./registry.ts";

const DATASET = "7c39027b-cbb0-461a-aec8-0d7b6e553ec6";
const binding: MiniAppDataBinding = { id: "inventory", datasetId: DATASET, source: { schema: "main", table: "inventory" },
  fields: { item: { column: "item", sourceType: "VARCHAR", as: "text" } },
  queries: { stock: { kind: "rows", columns: ["item"], parameters: {}, filters: [], orderBy: [], pageSize: 10 } } };
const owner: MiniAppActor = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
const bot = (botId = "publisher"): MiniAppActor => ({ ...owner, botId });
const publication = (extra: Partial<MiniAppPublish> = {}): MiniAppPublish => ({ requestKey: "create", expectedRevision: 0,
  slug: "inventory", title: "Inventory", description: "Synthetic stock report", html: "<h1>Inventory</h1>", bindings: [binding], ...extra });
const teamsSnapshot: LocalAgentTeamsResponse = { status: "ready", updatedAt: 1000, teamCount: 0, teams: [] };
const activitySnapshot: LocalAgentActivityResponse = { agentId: "w6:p1", status: "ready", updatedAt: 1000, truncated: false, events: [] };
const usageSnapshot: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
  sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };
const dashboardProviders = () => ({
  agents: { get: vi.fn(async () => teamsSnapshot) },
  activity: { get: vi.fn(async (_agentId: string) => activitySnapshot) },
  usage: { get: vi.fn(async () => usageSnapshot) },
});

function fixture(maxBytes?: number, readers?: LocalDashboardProviders) {
  const docs = new AppDocs(join(DATA_DIR, "app-docs"), { maxBytes });
  const publishers = new Set(["publisher", "other"]);
  let revision = 1;
  const data = {
    validateBinding: vi.fn(async () => undefined),
    readNamed: vi.fn(async (): Promise<MiniAppNamedPage> => ({ columns: [{ name: "item", type: "text" }], rows: [["Pencil"]], revision })),
    listDatasets: vi.fn(async () => [{ datasetId: DATASET, storeId: "store", revision }]),
  };
  const apps = new MiniApps({ docs, data, validPublisher: (id) => publishers.has(id), dashboardProviders: readers });
  return { apps, docs, data, publishers, update: () => { revision++; } };
}

describe("persistent Mini Apps", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("keeps independent template history, monotonic head revisions and exact receipts across restart", async () => {
    const { apps, update } = fixture();
    const first = await apps.publish(bot(), publication());
    const id = first.app.id;
    const secondInput = publication({ requestKey: "second", expectedRevision: 1, title: "Inventory v2", html: "<h1>Second version</h1>" });
    const second = await apps.publish(bot(), secondInput, id);
    expect(second.app).toMatchObject({ revision: 2, templateVersion: 2 });
    const rollback = { requestKey: "restore", expectedRevision: 2, templateVersion: 1 };
    expect((await apps.rollback(bot(), id, rollback)).app).toMatchObject({ revision: 3, templateVersion: 1, title: "Inventory" });
    update();
    expect(await apps.state(bot(), id)).toMatchObject({ revision: 3, data: [{ revision: 2 }] });
    expect(await apps.publish(bot(), secondInput, id)).toEqual({ app: second.app, replayed: true });
    await expect(apps.publish(bot(), { ...secondInput, html: "different" }, id)).rejects.toMatchObject({ status: 409 });
    await expect(apps.publish(bot(), publication({ requestKey: "stale", expectedRevision: 1 }), id)).rejects.toMatchObject({ status: 409 });
    closeMessageDb();
    expect(apps.document(owner, id).html).toBe("<h1>Inventory</h1>");
    expect(apps.document(owner, id).versions.map((version) => version.version)).toEqual([2, 1]);
    expect((await apps.rollback(owner, id, { ...rollback, requestKey: "restore-again", expectedRevision: 3 })).app.revision).toBe(4);
    expect(apps.archive(owner, id, { requestKey: "archive", expectedRevision: 4 }).app.revision).toBe(5);
    await expect(apps.query(owner, id, { expectedRevision: 5, queryId: "stock", parameters: {} })).rejects.toMatchObject({ status: 409 });
  });

  it("checks current authority before returning an old receipt and keeps apps after their publisher disappears", async () => {
    const { apps, publishers } = fixture();
    const first = await apps.publish(bot(), publication());
    await expect(apps.publish(bot("other"), publication())).rejects.toMatchObject({ status: 403 });
    const document = apps.document(owner, first.app.id);
    await apps.publish(owner, publication({ requestKey: "revoke", expectedRevision: 1, publisherBotIds: [] }), first.app.id);
    await expect(apps.publish(bot(), publication())).rejects.toMatchObject({ status: 403 });
    expect(() => apps.document(bot(), first.app.id)).toThrow("no current publisher grant");
    publishers.delete("publisher");
    expect(apps.document(owner, first.app.id).bindings).toEqual(document.bindings);
    expect(await apps.query(owner, first.app.id, { expectedRevision: 2, queryId: "stock", parameters: {} })).toMatchObject({ rows: [["Pencil"]] });
  });

  it("keeps archived apps discoverable but lets only the owner reactivate them", async () => {
    const { apps } = fixture();
    const { app } = await apps.publish(bot(), publication());
    const archive = { requestKey: "archive", expectedRevision: 1 };
    const archived = apps.archive(bot(), app.id, archive);
    expect(apps.archive(bot(), app.id, archive)).toEqual({ app: archived.app, replayed: true });
    expect(apps.document(bot(), app.id).app.status).toBe("archived");
    expect(apps.list(bot())).toHaveLength(1);
    await expect(apps.publish(bot(), publication({ requestKey: "reactivate", expectedRevision: 2 }), app.id)).rejects.toMatchObject({ status: 403 });
    await expect(apps.publish(bot(), publication())).rejects.toMatchObject({ status: 403 });
    await expect(apps.rollback(bot(), app.id, { requestKey: "reactivate", expectedRevision: 2, templateVersion: 1 })).rejects.toMatchObject({ status: 403 });
    await apps.rollback(owner, app.id, { requestKey: "owner-restore", expectedRevision: 2, templateVersion: 1 });
    expect((await apps.publish(bot(), publication({ requestKey: "after-restore", expectedRevision: 3 }), app.id)).app.status).toBe("active");
  });

  it("does not replay a racing rollback receipt after the owner archives the app", async () => {
    const { apps, data } = fixture();
    const { app } = await apps.publish(bot(), publication());
    await apps.publish(bot(), publication({ requestKey: "second", expectedRevision: 1 }), app.id);
    let finish!: () => void;
    const validation = new Promise<undefined>((resolve) => { finish = () => resolve(undefined); });
    data.validateBinding.mockImplementationOnce(() => validation);
    const rollback = { requestKey: "same-rollback", expectedRevision: 2, templateVersion: 1 };
    const pending = apps.rollback(bot(), app.id, rollback);
    const refused = expect(pending).rejects.toMatchObject({ status: 403 });
    await apps.rollback(bot(), app.id, rollback);
    apps.archive(owner, app.id, { requestKey: "archive", expectedRevision: 3 });
    finish();
    await refused;
    expect(apps.document(owner, app.id).app).toMatchObject({ revision: 4, status: "archived" });
  });

  it("limits delegated Data to the target app's current canonical binding", async () => {
    const { apps } = fixture();
    const delegated: MiniAppActor = { ...bot(), canBind: () => false };
    const { app } = await apps.publish(owner, publication({ publisherBotIds: ["publisher"] }));
    const reordered = { ...binding, source: { table: binding.source.table, schema: binding.source.schema } };
    await apps.publish(delegated, publication({ requestKey: "edit-html", expectedRevision: 1, html: "<p>New layout</p>", bindings: [reordered] }), app.id);
    for (const expanded of [
      { ...binding, source: { schema: "main", table: "private_inventory" } },
      { ...binding, fields: { item: { ...binding.fields.item!, column: "private_item" } } },
      { ...binding, queries: { stock: { ...binding.queries.stock!, pageSize: 20 } } },
    ]) {
      await expect(apps.publish(delegated, publication({ requestKey: "expand", expectedRevision: 2, bindings: [expanded] }), app.id)).rejects.toMatchObject({ status: 403 });
    }
    await expect(apps.publish(delegated, publication({ slug: "another-app" }))).rejects.toMatchObject({ status: 403 });
    await apps.publish(owner, publication({ requestKey: "narrow", expectedRevision: 2, bindings: [{ ...binding, source: { schema: "main", table: "public_inventory" } }] }), app.id);
    await expect(apps.rollback(delegated, app.id, { requestKey: "old-scope", expectedRevision: 3, templateVersion: 1 })).rejects.toMatchObject({ status: 403 });
  });

  it("rechecks delegated bindings when their validation yields to an owner scope change", async () => {
    const { apps, data } = fixture();
    const { app } = await apps.publish(owner, publication({ publisherBotIds: ["publisher"] }));
    const delegated: MiniAppActor = { ...bot(), canBind: () => false };
    let finish!: () => void;
    const validation = new Promise<undefined>((resolve) => { finish = () => resolve(undefined); });
    data.validateBinding.mockImplementationOnce(() => validation);
    const pending = apps.publish(delegated, publication({ requestKey: "waiting", expectedRevision: 1 }), app.id);
    const refused = expect(pending).rejects.toMatchObject({ status: 403 });
    await apps.publish(owner, publication({ requestKey: "revoke-binding", expectedRevision: 1, bindings: [] }), app.id);
    finish();
    await refused;
    expect(apps.document(owner, app.id).bindings).toEqual([]);
  });

  it("does not publish after its turn stops during asynchronous validation", async () => {
    const { apps, data } = fixture();
    let active = true;
    data.validateBinding.mockImplementation(async () => { active = false; });
    const actor = { ...bot(), assertActive: () => { if (!active) throw Object.assign(new Error("expired"), { status: 401 }); } };
    await expect(apps.publish(actor, publication())).rejects.toMatchObject({ status: 401 });
    expect(apps.list(owner)).toEqual([]);
    expect(miniAppDocRefs()).toEqual([]);
  });

  it("preserves the previous head on quota or transaction failures and rejects raw query authority", async () => {
    const { apps } = fixture(1500);
    const first = await apps.publish(owner, publication());
    const id = first.app.id;
    await expect(apps.publish(owner, publication({ requestKey: "large", expectedRevision: 1, html: "x".repeat(1600) }), id)).rejects.toMatchObject({ status: 413 });
    applicationDatabase().exec("CREATE TRIGGER reject_app_receipt BEFORE INSERT ON mini_app_receipts BEGIN SELECT RAISE(ABORT, 'disk fixture failure'); END");
    await expect(apps.publish(owner, publication({ requestKey: "fail", expectedRevision: 1, html: "changed" }), id)).rejects.toThrow("disk fixture failure");
    applicationDatabase().exec("DROP TRIGGER reject_app_receipt");
    expect(apps.document(owner, id).app.revision).toBe(1);
    expect(apps.document(owner, id).html).toBe("<h1>Inventory</h1>");
    await expect(apps.query(owner, id, { expectedRevision: 1, queryId: "stock", parameters: {}, sql: "SELECT secret" })).rejects.toMatchObject({ status: 400 });
    await expect(apps.query(owner, id, { expectedRevision: 1, queryId: "secret", parameters: {} })).rejects.toMatchObject({ status: 400 });
  });

  it("discards a query response from an earlier template or revoked turn", async () => {
    const { apps, data } = fixture();
    const { app } = await apps.publish(bot(), publication());
    data.readNamed.mockImplementation(async () => {
      apps.archive(owner, app.id, { requestKey: "during-read", expectedRevision: 1 });
      return { columns: [], rows: [], revision: 1 };
    });
    await expect(apps.query(bot(), app.id, { queryId: "stock", parameters: {}, expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("collects neither app history nor unrelated blobs when a retained reference is corrupt", async () => {
    const { apps, docs } = fixture();
    await apps.publish(owner, publication());
    const loose = docs.put({ source: "html", html: "<p>unreferenced</p>" });
    expect(loose.ok).toBe(true);
    const [doc] = miniAppDocRefs();
    writeFileSync(join(DATA_DIR, "app-docs", "doc", `${doc}.json`), "broken");
    expect(() => docs.sweep(miniAppDocRefs(), Date.now() + APP_DOCS_SWEEP_GRACE_MS + 1)).toThrow("references are unreadable");
    if (loose.ok) expect(docs.read(loose.doc)?.html).toContain("unreferenced");
  });

  it("migrates an installed record without the dashboard column", () => {
    const db = new DatabaseSync(join(DATA_DIR, "legacy-mini-apps.db"));
    try {
      db.exec(`CREATE TABLE mini_apps (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
        template_version INTEGER NOT NULL, publishers TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE(owner_id, slug));`);
      db.prepare("INSERT INTO mini_apps VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("legacy", MINI_APPS_OWNER, "legacy", "Legacy app", "", "active", 1, 1, "[]", 1, 1);
      const { docs, data } = fixture();
      const apps = new MiniApps({ docs, data, validPublisher: () => true,
        access: { database: () => db, write: (work) => work(db) } });
      expect(apps.list(owner)).toMatchObject([{ id: "legacy", dashboard: null, dashboardIdentity: null }]);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "dashboard_kind")).toBe(true);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "dashboard_identity")).toBe(true);
    } finally { db.close(); }
  });

  it("opens a no-Data dashboard when unrelated retained Data is unavailable", async () => {
    const { apps, data } = fixture();
    const { app } = await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team" }));
    data.listDatasets.mockRejectedValue(new Error("unrelated store is broken"));
    expect(await apps.state(owner, app.id)).toMatchObject({ appId: app.id, revision: 1, data: [] });
    expect(data.listDatasets).not.toHaveBeenCalled();
  });

  it("keeps native dashboards unbound even when an update omits its grant", async () => {
    const { apps, data } = fixture();
    await expect(apps.publish(owner, publication({ dashboardKind: "agent-team" }))).rejects.toMatchObject({ status: 400 });
    const { app } = await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team", publisherBotIds: ["publisher"] }));
    await expect(apps.publish(bot(), publication({ bindings: [binding], expectedRevision: 1, requestKey: "bot-add-data" }), app.id))
      .rejects.toMatchObject({ status: 400 });
    expect(data.validateBinding).not.toHaveBeenCalled();
    const botEdit = await apps.publish(bot(), publication({ bindings: [], expectedRevision: 1, requestKey: "bot-metadata",
      title: "Renamed dashboard", html: "<p>New fallback</p>" }), app.id);
    expect(botEdit.app.dashboard).toMatchObject({ renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"] });
    expect(apps.document(bot(), app.id).html).toBe("<p>New fallback</p>");
    expect((await apps.publish(owner, publication({ expectedRevision: 2, requestKey: "remove-grant", bindings: [], dashboardKind: null }), app.id))
      .app).toMatchObject({ dashboard: null, dashboardIdentity: "agent-team" });
    await expect(apps.publish(owner, publication({ expectedRevision: 3, requestKey: "data-after-revoke", dashboardKind: null }), app.id))
      .rejects.toMatchObject({ status: 400 });
    await expect(apps.publish(owner, publication({ expectedRevision: 3, requestKey: "wrong-kind", bindings: [],
      dashboardKind: "usage" }), app.id)).rejects.toMatchObject({ status: 409 });
    expect((await apps.publish(owner, publication({ expectedRevision: 3, requestKey: "owner-regrant", bindings: [],
      dashboardKind: "agent-team" }), app.id)).app).toMatchObject({ id: app.id, dashboard: { kind: "agent-team" } });
    await expect(apps.publish(bot(), publication({ expectedRevision: 4, requestKey: "bot-grant", bindings: [],
      dashboardKind: "agent-team" }), app.id)).rejects.toMatchObject({ status: 403 });
  });

  it("does not rollback a native dashboard to a Data-bound template", async () => {
    const { apps } = fixture();
    const { app } = await apps.publish(owner, publication());
    await apps.publish(owner, publication({ requestKey: "native", expectedRevision: 1, bindings: [], dashboardKind: "usage" }), app.id);
    await expect(apps.rollback(owner, app.id, { requestKey: "old-data", expectedRevision: 2, templateVersion: 1 }))
      .rejects.toMatchObject({ status: 400 });
    expect(apps.document(owner, app.id).app).toMatchObject({ revision: 2, dashboard: { kind: "usage" } });
    await apps.publish(owner, publication({ requestKey: "revoke", expectedRevision: 2, bindings: [], dashboardKind: null }), app.id);
    await expect(apps.rollback(owner, app.id, { requestKey: "old-data-after-revoke", expectedRevision: 3, templateVersion: 1 }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("scopes owner snapshots to the installed kind and never gives bots snapshot authority", async () => {
    const readers = dashboardProviders();
    const { apps } = fixture(undefined, readers);
    const team = (await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team", publisherBotIds: ["publisher"] }))).app;
    const usage = (await apps.publish(owner, publication({ requestKey: "usage", slug: "usage", bindings: [], dashboardKind: "usage" }))).app;
    expect(apps.dashboardCatalog(bot())).toMatchObject([
      { id: team.id, dashboardIdentity: "agent-team", dashboard: { kind: "agent-team", resources: ["teams", "activity"] } },
      { id: usage.id, dashboardIdentity: "usage", dashboard: { kind: "usage", resources: ["usage"] } },
    ]);
    await expect(apps.dashboardRead(bot(), team.id, { resource: "teams", expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(owner, team.id, { resource: "usage", expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(owner, usage.id, { resource: "activity", expectedRevision: 1, agentId: "w6:p1" }))
      .rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(owner, team.id, { resource: "activity", expectedRevision: 1, agentId: "bad" }))
      .rejects.toMatchObject({ status: 400 });
    expect(await apps.dashboardRead(owner, team.id, { resource: "teams", expectedRevision: 1 }))
      .toEqual({ appId: team.id, revision: 1, resource: "teams", snapshot: teamsSnapshot });
    expect(await apps.dashboardRead(owner, team.id, { resource: "activity", expectedRevision: 1, agentId: "w6:p1" }))
      .toEqual({ appId: team.id, revision: 1, resource: "activity", snapshot: activitySnapshot });
    expect(await apps.dashboardRead(owner, usage.id, { resource: "usage", expectedRevision: 1 }))
      .toEqual({ appId: usage.id, revision: 1, resource: "usage", snapshot: usageSnapshot });
    expect(readers.agents.get).toHaveBeenCalledTimes(1);
    expect(readers.activity.get).toHaveBeenCalledWith("w6:p1");
    expect(readers.usage.get).toHaveBeenCalledTimes(1);
  });

  it("drops a pending snapshot after a revision change, archive or owner revocation", async () => {
    const readers = dashboardProviders();
    const { apps } = fixture(undefined, readers);
    const { app } = await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team" }));
    let finish!: (snapshot: LocalAgentTeamsResponse) => void;
    readers.agents.get.mockImplementation(() => new Promise<LocalAgentTeamsResponse>((resolve) => { finish = resolve; }));
    const changed = apps.dashboardRead(owner, app.id, { resource: "teams", expectedRevision: 1 });
    await apps.publish(owner, publication({ requestKey: "rename", expectedRevision: 1, bindings: [], title: "Changed" }), app.id);
    finish(teamsSnapshot);
    await expect(changed).rejects.toMatchObject({ status: 409 });

    const archived = apps.dashboardRead(owner, app.id, { resource: "teams", expectedRevision: 2 });
    apps.archive(owner, app.id, { requestKey: "archive", expectedRevision: 2 });
    finish(teamsSnapshot);
    await expect(archived).rejects.toMatchObject({ status: 409 });
    expect(apps.dashboardCatalog(owner)).toEqual([]);
    await apps.rollback(owner, app.id, { requestKey: "restore", expectedRevision: 3, templateVersion: 1 });
    expect(apps.document(owner, app.id).app).toMatchObject({ id: app.id, revision: 4, dashboard: null, dashboardIdentity: "agent-team" });
    await expect(apps.dashboardRead(owner, app.id, { resource: "teams", expectedRevision: 4 })).rejects.toMatchObject({ status: 403 });
    const reinstalled = await apps.publish(owner, publication({ requestKey: "reinstall", expectedRevision: 4,
      bindings: [], dashboardKind: "agent-team" }), app.id);
    expect(reinstalled.app).toMatchObject({ id: app.id, revision: 5, dashboard: { kind: "agent-team" } });

    let active = true;
    const guardedOwner = { ...owner, assertActive: () => { if (!active) throw Object.assign(new Error("owner revoked"), { status: 403 }); } };
    const revoked = apps.dashboardRead(guardedOwner, app.id, { resource: "teams", expectedRevision: 5 });
    active = false;
    finish(teamsSnapshot);
    await expect(revoked).rejects.toMatchObject({ status: 403 });
  });

  it("does not return a pending snapshot after its dashboard grant is revoked", async () => {
    const readers = dashboardProviders();
    const { apps } = fixture(undefined, readers);
    const { app } = await apps.publish(owner, publication({ bindings: [], dashboardKind: "usage" }));
    let finish!: (snapshot: LocalUsageResponse) => void;
    readers.usage.get.mockImplementation(() => new Promise<LocalUsageResponse>((resolve) => { finish = resolve; }));
    const pending = apps.dashboardRead(owner, app.id, { resource: "usage", expectedRevision: 1 });
    const revoked = await apps.publish(owner, publication({ requestKey: "revoke", expectedRevision: 1,
      bindings: [], dashboardKind: null }), app.id);
    expect(revoked.app).toMatchObject({ dashboard: null, dashboardIdentity: "usage" });
    expect(apps.dashboardCatalog(bot())).toMatchObject([{ id: app.id, revision: 2, dashboardIdentity: "usage", dashboard: null }]);
    finish(usageSnapshot);
    await expect(pending).rejects.toMatchObject({ status: 409 });
  });

  it("keeps a custom slug collision distinct from a revocable built-in identity", async () => {
    const { apps } = fixture();
    const unrelated = (await apps.publish(owner, publication({ slug: "agent-team" }))).app;
    expect(unrelated).toMatchObject({ slug: "agent-team", dashboard: null, dashboardIdentity: null });
    await expect(apps.publish(owner, publication({ slug: "agent-team", bindings: [], dashboardKind: "agent-team", requestKey: "install" })))
      .rejects.toMatchObject({ status: 409 });
    expect(apps.document(owner, unrelated.id).app).toMatchObject({ dashboard: null, dashboardIdentity: null });
  });
});
