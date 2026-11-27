import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniAppDataBinding, MiniAppNamedPage } from "../../shared/mini-app-data.ts";
import type { MiniAppPublish } from "../../shared/mini-apps.ts";
import type { LocalAgentActivityResponse, LocalAgentConfigurationResponse, LocalAgentSkillDocumentResponse,
  LocalAgentTeamRulesResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "../../shared/local-dashboard.ts";
import { AppDocs, APP_DOCS_SWEEP_GRACE_MS } from "../app-docs.ts";
import { DATA_DIR } from "../config.ts";
import { applicationDatabase, closeMessageDb } from "../message-db.ts";
import type { LocalDashboardProviders } from "../routes/local-dashboard.ts";
import { MiniApps, MINI_APPS_OWNER, miniAppDocRefs, type MiniAppActor } from "./registry.ts";

const DATASET = "7c39027b-cbb0-461a-aec8-0d7b6e553ec6";
const reviewedHtml = readFileSync(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8");
const binding: MiniAppDataBinding = { id: "inventory", datasetId: DATASET, source: { schema: "main", table: "inventory" },
  fields: { item: { column: "item", sourceType: "VARCHAR", as: "text" } },
  queries: { stock: { kind: "rows", columns: ["item"], parameters: {}, filters: [], orderBy: [], pageSize: 10 } } };
const owner: MiniAppActor = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
const bot = (botId = "publisher"): MiniAppActor => ({ ...owner, botId });
const publication = (extra: Partial<MiniAppPublish> = {}): MiniAppPublish => ({ requestKey: "create", expectedRevision: 0,
  slug: "inventory", title: "Inventory", description: "Synthetic stock report", html: "<h1>Inventory</h1>", bindings: [binding], ...extra });
const occupantId = "o1234567890abcdef";
const teamsSnapshot: LocalAgentTeamsResponse = { status: "ready", updatedAt: 1000, teamCount: 1, teams: [{
  id: "w6", name: "Fixture team", agentCount: 1, activeAgentCount: 1, agents: [{ id: "w6:p1", occupantId,
    name: "Fixture agent", kind: "codex", role: null, model: null, reasoningEffort: null, contextUsed: null,
    contextWindow: null, state: "working", taskHint: null }],
}] };
const activitySnapshot: LocalAgentActivityResponse = { agentId: "w6:p1", status: "ready", updatedAt: 1000, truncated: false, events: [] };
const configurationSnapshot: LocalAgentConfigurationResponse = { agentId: "w6:p1", teamId: "w6", occupantId,
  agent: { status: "unverified", markdown: null }, skillReferences: "unverified", skillDiscovery: "unavailable", skills: [] };
const skillSnapshot: LocalAgentSkillDocumentResponse = { agentId: "w6:p1", teamId: "w6", occupantId,
  skillId: "s1234567890abcdef", status: "unavailable", markdown: null };
const teamRulesSnapshot: LocalAgentTeamRulesResponse = { teamId: "w6", status: "unverified", markdown: null };
const usageSnapshot: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
  sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };
const dashboardProviders = () => ({
  agents: { get: vi.fn(async () => teamsSnapshot) },
  activity: { get: vi.fn(async (_agentId: string) => activitySnapshot) },
  configuration: { getAgent: vi.fn(async (_agentId: string) => configurationSnapshot),
    getSkill: vi.fn(async (_agentId: string, _skillId: string) => skillSnapshot),
    getTeamRules: vi.fn(async (_teamId: string) => teamRulesSnapshot) },
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

  it("serves state() and query() from version bindings without reading the HTML document from disk", async () => {
    const { apps, docs } = fixture();
    const { app } = await apps.publish(owner, publication());
    const readSpy = vi.spyOn(docs, "read");
    const st = await apps.state(owner, app.id);
    expect(st).toMatchObject({ appId: app.id, revision: 1, templateVersion: 1, data: [{ datasetId: DATASET, revision: 1 }] });
    const res = await apps.query(owner, app.id, { expectedRevision: 1, queryId: "stock", parameters: {} });
    expect(res).toMatchObject({ rows: [["Pencil"]] });
    expect(readSpy).not.toHaveBeenCalled();
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
      expect(apps.list(owner)).toMatchObject([{ id: "legacy", dashboard: null, dashboardIdentity: null,
        shippedTemplateKind: null, icon: null, responsibleBotId: null, capabilities: [] }]);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "dashboard_kind")).toBe(true);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "dashboard_identity")).toBe(true);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "native_kind")).toBe(true);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "native_identity")).toBe(true);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "shipped_template_kind")).toBe(true);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "responsible_bot_id")).toBe(true);
      expect(db.prepare("PRAGMA table_info(mini_apps)").all().some((column) => column.name === "icon")).toBe(true);
    } finally { db.close(); }
  });

  it("keeps explicit responsibility separate from grants and verified Bot template development", async () => {
    const { apps } = fixture();
    const ownerMade = await apps.publish(owner, publication({ requestKey: "owner-create", publisherBotIds: ["publisher"] }));
    expect(apps.developedBy("publisher")).not.toContain(ownerMade.app.id);
    expect(ownerMade.app.responsibleBotId).toBeNull();
    await expect(apps.publish(bot(), publication({ requestKey: "self-assign", expectedRevision: 1,
      responsibleBotId: "publisher" }), ownerMade.app.id)).rejects.toMatchObject({ status: 403 });
    const titleOnly = await apps.publish(bot(), publication({ requestKey: "title-only", expectedRevision: 1,
      title: "Inventory title", capabilities: ["Review inventory quantities"] }), ownerMade.app.id);
    expect(apps.developedBy("publisher")).not.toContain(ownerMade.app.id);
    expect(titleOnly.app.capabilities).toEqual(["Review inventory quantities"]);
    const assigned = await apps.publish(owner, publication({ requestKey: "assign", expectedRevision: 2,
      responsibleBotId: "publisher" }), ownerMade.app.id);
    expect(assigned.app.responsibleBotId).toBe("publisher");
    await expect(apps.publish(owner, publication({ requestKey: "unknown", expectedRevision: 3,
      responsibleBotId: "unknown" }), ownerMade.app.id)).rejects.toMatchObject({ status: 400 });
    const revised = await apps.publish(bot(), publication({ requestKey: "real-layout", expectedRevision: 3,
      html: "<h1>Updated inventory</h1>" }), ownerMade.app.id);
    expect(revised.app.responsibleBotId).toBe("publisher");
    expect(apps.developedBy("publisher")).toContain(ownerMade.app.id);
    const botMade = await apps.publish(bot(), publication({ requestKey: "bot-create", slug: "bot-inventory" }));
    expect(apps.developedBy("publisher")).toContain(botMade.app.id);
    closeMessageDb();
    expect(apps.developedBy("publisher")).toEqual(new Set([ownerMade.app.id, botMade.app.id]));
  });

  it("rehydrates only successful Bot creation and changed-template receipts once at startup", async () => {
    const { apps } = fixture();
    const created = await apps.publish(bot(), publication({ requestKey: "slug-create", slug: "created-by-bot" }));
    const ownerMade = await apps.publish(owner, publication({ requestKey: "owner-create", slug: "owner-made",
      publisherBotIds: ["publisher"] }));
    await apps.publish(bot(), publication({ requestKey: "title-only", slug: "owner-made", expectedRevision: 1,
      title: "Changed title" }), ownerMade.app.id);
    const changed = await apps.publish(owner, publication({ requestKey: "owner-two", slug: "owner-two",
      publisherBotIds: ["publisher"] }));
    await apps.publish(bot(), publication({ requestKey: "layout", slug: "owner-two", expectedRevision: 1,
      html: "<h1>Changed template</h1>" }), changed.app.id);
    applicationDatabase().exec("DELETE FROM mini_app_development; DELETE FROM mini_app_recommendation_meta");
    closeMessageDb();
    expect(apps.developedBy("publisher")).toEqual(new Set([created.app.id, changed.app.id]));
    expect(applicationDatabase().prepare("SELECT key FROM mini_app_recommendation_meta").all()).toHaveLength(1);
  });

  it("opens a no-Data dashboard when unrelated retained Data is unavailable", async () => {
    const { apps, data } = fixture();
    const { app } = await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team" }));
    data.listDatasets.mockRejectedValue(new Error("unrelated store is broken"));
    expect(await apps.state(owner, app.id)).toMatchObject({ appId: app.id, revision: 1, data: [] });
    expect(data.listDatasets).not.toHaveBeenCalled();
  });

  it("keeps Hongguo identity and local playback history through restart, revocation and archive", async () => {
    const { apps } = fixture();
    const native = await apps.publish(owner, publication({ bindings: [], slug: "hongguo", nativeKind: "hongguo",
      publisherBotIds: ["publisher"] }));
    const id = native.app.id;
    expect(native.app).toMatchObject({ nativeKind: "hongguo", nativeIdentity: "hongguo" });
    expect(() => apps.requireHongguo(owner, id, 1)).not.toThrow();
    expect(() => apps.requireHongguo(bot(), id, 1)).toThrow("Only the workspace owner");
    await expect(apps.publish(bot(), publication({ slug: "hongguo", bindings: [], expectedRevision: 1, requestKey: "bot-native",
      nativeKind: null }), id)).rejects.toMatchObject({ status: 403 });
    await expect(apps.publish(owner, publication({ slug: "hongguo", bindings: [binding], expectedRevision: 1,
      requestKey: "bind-native" }), id)).rejects.toMatchObject({ status: 400 });
    const entry = { seriesId: "series-1", seriesTitle: "Drama", coverUrl: null, episodeId: "ep-1",
      episodeNumber: 1, episodeTitle: "Episode 1", positionSeconds: 42, durationSeconds: 200 };
    expect(() => apps.hongguoHistory(owner, id, { action: "save", expectedRevision: 1,
      entry: { ...entry, coverUrl: "https://example.com/private.png" } })).toThrow("Invalid Hongguo history request");
    expect(apps.hongguoHistory(owner, id, { action: "save", expectedRevision: 1, entry }).entries).toMatchObject([
      { ...entry, updatedAt: expect.any(Number) }]);
    expect(apps.hongguoPreferences(owner, id, { expectedRevision: 1, autoplayNext: false }).autoplayNext).toBe(false);
    closeMessageDb();
    expect(apps.hongguoHistory(owner, id, { action: "list", expectedRevision: 1 })).toMatchObject({
      entries: [{ seriesId: "series-1", positionSeconds: 42 }], autoplayNext: false });
    const revoked = await apps.publish(owner, publication({ slug: "hongguo", bindings: [], expectedRevision: 1,
      requestKey: "revoke-native", nativeKind: null }), id);
    expect(revoked.app).toMatchObject({ nativeKind: null, nativeIdentity: "hongguo", revision: 2 });
    expect(() => apps.hongguoHistory(owner, id, { action: "list", expectedRevision: 2 })).toThrow("no Hongguo grant");
    const restored = await apps.publish(owner, publication({ slug: "hongguo", bindings: [], expectedRevision: 2,
      requestKey: "restore-native", nativeKind: "hongguo" }), id);
    expect(restored.app.revision).toBe(3);
    apps.hongguoHistory(owner, id, { action: "save", expectedRevision: 3,
      entry: { ...entry, seriesId: "series-2", episodeId: "ep-2" } });
    expect(apps.hongguoHistory(owner, id, { action: "delete", expectedRevision: 3, seriesId: "series-2" }).entries)
      .toMatchObject([{ seriesId: "series-1" }]);
    expect(apps.hongguoHistory(owner, id, { action: "clear", expectedRevision: 3 }).entries).toEqual([]);
    apps.hongguoHistory(owner, id, { action: "save", expectedRevision: 3, entry });
    const archived = apps.archive(owner, id, { requestKey: "archive", expectedRevision: 3 });
    expect(archived.app).toMatchObject({ nativeKind: null, nativeIdentity: "hongguo", status: "archived" });
    expect(() => apps.requireHongguo(owner, id, 4)).toThrow("archived");
    expect(applicationDatabase().prepare("SELECT COUNT(*) AS count FROM mini_app_hongguo_history WHERE app_id = ?")
      .get(id)).toMatchObject({ count: 1 });
  });

  it("keeps owner-assigned shipped provenance through Bot edits and template lifecycle without granting dashboard access", async () => {
    const { apps } = fixture();
    const first = await apps.publish(owner, publication({ shippedTemplateKind: "bookkeeping", publisherBotIds: ["publisher"] }));
    const id = first.app.id;
    await expect(apps.dashboardRead(owner, id, { resource: "teams", expectedRevision: 1 }))
      .rejects.toMatchObject({ status: 403 });
    const edited = publication({ requestKey: "bot-edit", expectedRevision: 1, title: "Custom ledger", html: "<p>Edited layout</p>",
      bindings: [{ ...binding, source: { schema: "main", table: "new_ledger" } }] });
    expect((await apps.publish(bot(), edited, id)).app).toMatchObject({ shippedTemplateKind: "bookkeeping", revision: 2 });
    expect((await apps.publish(bot(), edited, id)).replayed).toBe(true);
    await expect(apps.publish(bot(), publication({ requestKey: "bot-label", expectedRevision: 2,
      shippedTemplateKind: "github_activity" }), id)).rejects.toMatchObject({ status: 403 });
    await expect(apps.publish(owner, publication({ requestKey: "other-label", expectedRevision: 2,
      shippedTemplateKind: "x_ai_digest" }), id)).rejects.toMatchObject({ status: 409 });
    await expect(apps.publish(owner, publication({ requestKey: "native", expectedRevision: 2,
      bindings: [], dashboardKind: "agent-team" }), id)).rejects.toMatchObject({ status: 400 });
    expect((await apps.rollback(owner, id, { requestKey: "rollback", expectedRevision: 2, templateVersion: 1 })).app)
      .toMatchObject({ shippedTemplateKind: "bookkeeping", revision: 3 });
    expect(apps.archive(owner, id, { requestKey: "archive", expectedRevision: 3 }).app)
      .toMatchObject({ shippedTemplateKind: "bookkeeping", status: "archived" });
    closeMessageDb();
    expect(apps.document(owner, id).app).toMatchObject({ shippedTemplateKind: "bookkeeping", status: "archived" });
    const unrelated = await apps.publish(owner, publication({ slug: "x-ai-digest", requestKey: "custom-slug" }));
    expect(unrelated.app.shippedTemplateKind).toBeNull();
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
    const setCreatedAt = applicationDatabase().prepare("UPDATE mini_apps SET created_at = ? WHERE id = ?");
    setCreatedAt.run(2, team.id);
    setCreatedAt.run(1, usage.id);
    const catalog = apps.dashboardCatalog(bot());
    expect(catalog.map((app) => app.id)).toEqual([usage.id, team.id]);
    expect(catalog).toHaveLength(2);
    expect(catalog.find((app) => app.id === team.id)).toMatchObject({
      dashboardIdentity: "agent-team", dashboard: { kind: "agent-team", resources: ["teams", "activity"] },
    });
    expect(catalog.find((app) => app.id === usage.id)).toMatchObject({
      dashboardIdentity: "usage", dashboard: { kind: "usage", resources: ["usage"] },
    });
    await expect(apps.dashboardRead(bot(), team.id, { resource: "teams", expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(owner, team.id, { resource: "usage", expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(owner, usage.id, { resource: "activity", expectedRevision: 1, agentId: "w6:p1", occupantId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(owner, team.id, { resource: "activity", expectedRevision: 1, agentId: "bad" }))
      .rejects.toMatchObject({ status: 400 });
    expect(await apps.dashboardRead(owner, team.id, { resource: "teams", expectedRevision: 1 }))
      .toEqual({ appId: team.id, revision: 1, resource: "teams", snapshot: teamsSnapshot });
    expect(await apps.dashboardRead(owner, team.id, { resource: "activity", expectedRevision: 1, agentId: "w6:p1", occupantId }))
      .toEqual({ appId: team.id, revision: 1, resource: "activity", snapshot: activitySnapshot });
    expect(await apps.dashboardRead(owner, usage.id, { resource: "usage", expectedRevision: 1 }))
      .toEqual({ appId: usage.id, revision: 1, resource: "usage", snapshot: usageSnapshot });
    expect(readers.agents.get).toHaveBeenCalledTimes(3);
    expect(readers.activity.get).toHaveBeenCalledWith("w6:p1");
    expect(readers.usage.get).toHaveBeenCalledTimes(1);
  });

  it("keeps reviewed Agent Team versions active through publication, rollback and revocation without activating old fallback", async () => {
    const readers = dashboardProviders();
    const { apps } = fixture(undefined, readers);
    const old = (await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team" }))).app;
    expect(old.dashboard).toMatchObject({ renderer: "native", resources: ["teams", "activity"] });
    const first = (await apps.publish(owner, publication({ requestKey: "reviewed", expectedRevision: 1,
      bindings: [], dashboardKind: "agent-team", publisherBotIds: ["publisher"], html: reviewedHtml }), old.id, true)).app;
    expect(first).toMatchObject({ id: old.id, revision: 2, dashboard: { renderer: "html", htmlRole: "primary" } });
    expect(apps.document(owner, old.id).html).toBe(reviewedHtml);
    await expect(apps.publish(bot(), publication({ requestKey: "bot-page", expectedRevision: 2,
      bindings: [], html: "<p>Bot replacement</p>" }), old.id)).rejects.toMatchObject({ status: 403 });
    await expect(apps.rollback(bot(), old.id, { requestKey: "bot-rollback", expectedRevision: 2,
      templateVersion: 1 })).rejects.toMatchObject({ status: 403 });
    const second = (await apps.publish(owner, publication({ requestKey: "publisher-vB", expectedRevision: 2,
      bindings: [], html: "<p>Published vB</p>" }), old.id)).app;
    expect(second).toMatchObject({ id: old.id, revision: 3, dashboard: { renderer: "html" } });
    expect(apps.document(owner, old.id).html).toBe("<p>Published vB</p>");
    const back = (await apps.rollback(owner, old.id, { requestKey: "back", expectedRevision: 3, templateVersion: 2 })).app;
    expect(back).toMatchObject({ revision: 4, templateVersion: 2, dashboard: { renderer: "html" } });
    expect(apps.document(owner, old.id).html).toBe(reviewedHtml);
    const fallback = (await apps.rollback(owner, old.id, { requestKey: "old", expectedRevision: 4, templateVersion: 1 })).app;
    expect(fallback).toMatchObject({ revision: 5, dashboard: { renderer: "native" } });
    const revoked = (await apps.publish(owner, publication({ requestKey: "revoke", expectedRevision: 5,
      bindings: [], dashboardKind: null }), old.id)).app;
    expect(revoked.dashboard).toBeNull();
    await expect(apps.dashboardRead(owner, old.id, { resource: "teams", expectedRevision: 6 })).rejects.toMatchObject({ status: 403 });
  });

  it("keeps the trusted Activities renderer tied to its template bytes and the current owner grant", async () => {
    const { apps } = fixture(undefined, dashboardProviders());
    const html = "<h1>Released Activities fixture</h1>";
    const initial = publication({ html, slug: "usage", dashboardKind: "usage", bindings: [], publisherBotIds: ["publisher"] });
    const first = (await apps.publish(owner, initial)).app;
    expect(first.dashboard?.renderer).toBe("native");
    const db = applicationDatabase();
    db.prepare("UPDATE mini_app_versions SET dashboard_html = 1 WHERE app_id = ? AND version = 1").run(first.id);
    db.prepare("UPDATE mini_apps SET dashboard_html = 1 WHERE id = ?").run(first.id);
    expect(apps.document(owner, first.id).app.dashboard).toMatchObject({ kind: "usage", renderer: "html", resources: ["usage"] });
    expect(await apps.state(owner, first.id)).toMatchObject({ data: [] });

    const edit = { ...initial, expectedRevision: 1, title: "Renamed Activities", requestKey: "rename" };
    await expect(apps.publish(bot(), { ...edit, dashboardKind: undefined, publisherBotIds: undefined,
      html: "<h1>Bot replacement</h1>" }, first.id)).rejects.toMatchObject({ status: 403 });
    const renamed = (await apps.publish(owner, edit, first.id)).app;
    expect(renamed).toMatchObject({ id: first.id, dashboard: { renderer: "html" } });
    const custom = (await apps.publish(owner, { ...edit, expectedRevision: 2, requestKey: "custom",
      html: "<h1>Custom fallback</h1>" }, first.id)).app;
    expect(custom).toMatchObject({ dashboard: { renderer: "native" } });
    await expect(apps.rollback(bot(), first.id, { expectedRevision: 3, templateVersion: 1, requestKey: "bot-restore" }))
      .rejects.toMatchObject({ status: 403 });
    expect((await apps.rollback(owner, first.id, { expectedRevision: 3, templateVersion: 1, requestKey: "owner-restore" })).app)
      .toMatchObject({ revision: 4, dashboard: { renderer: "html" } });
    expect((await apps.publish(owner, { ...edit, expectedRevision: 4, dashboardKind: null, requestKey: "revoke" }, first.id)).app)
      .toMatchObject({ dashboardIdentity: "usage", dashboard: null });
    await expect(apps.dashboardRead(owner, first.id, { resource: "usage", expectedRevision: 5 })).rejects.toMatchObject({ status: 403 });
    expect((await apps.publish(owner, { ...edit, expectedRevision: 5, requestKey: "regrant" }, first.id)).app)
      .toMatchObject({ revision: 6, dashboard: { renderer: "html" } });
    expect(await apps.dashboardRead(owner, first.id, { resource: "usage", expectedRevision: 6 }))
      .toEqual({ appId: first.id, revision: 6, resource: "usage", snapshot: usageSnapshot });
  });

  it("checks the exact current occupant before and after each Agent Team detail read", async () => {
    const readers = dashboardProviders();
    const { apps } = fixture(undefined, readers);
    const { app } = await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team", html: reviewedHtml }), undefined, true);
    expect(app.dashboard).toMatchObject({ renderer: "html", resources: ["teams", "activity", "configuration", "team-rules", "skill"] });
    const base = { expectedRevision: 1, agentId: "w6:p1", occupantId };
    expect(await apps.dashboardRead(owner, app.id, { resource: "configuration", ...base }))
      .toMatchObject({ resource: "configuration", snapshot: configurationSnapshot });
    expect(await apps.dashboardRead(owner, app.id, { resource: "skill", ...base, skillId: skillSnapshot.skillId }))
      .toMatchObject({ resource: "skill", snapshot: skillSnapshot });
    expect(await apps.dashboardRead(owner, app.id, { resource: "team-rules", expectedRevision: 1, teamId: "w6" }))
      .toMatchObject({ resource: "team-rules", snapshot: teamRulesSnapshot });
    await expect(apps.dashboardRead(owner, app.id, { resource: "configuration", ...base,
      occupantId: "o0000000000000000" })).rejects.toMatchObject({ status: 409 });
    expect(readers.configuration.getAgent).toHaveBeenCalledTimes(1);
    readers.agents.get.mockResolvedValueOnce(teamsSnapshot).mockResolvedValueOnce({ ...teamsSnapshot,
      teams: [{ ...teamsSnapshot.teams[0]!, agents: [{ ...teamsSnapshot.teams[0]!.agents[0]!, occupantId: "o0000000000000000" }] }] });
    await expect(apps.dashboardRead(owner, app.id, { resource: "activity", ...base })).rejects.toMatchObject({ status: 409 });
  });

  it("uses fast getRoster() when available so detail reads do not trigger full transcript/SQLite refreshes", async () => {
    const getRoster = vi.fn(async () => teamsSnapshot);
    const readers = { ...dashboardProviders(), agents: { get: vi.fn(async () => teamsSnapshot), getRoster } };
    const { apps } = fixture(undefined, readers);
    const { app } = await apps.publish(owner, publication({ bindings: [], dashboardKind: "agent-team", html: reviewedHtml }), undefined, true);
    expect(await apps.dashboardRead(owner, app.id, { resource: "team-rules", expectedRevision: 1, teamId: "w6" }))
      .toMatchObject({ resource: "team-rules", snapshot: teamRulesSnapshot });
    expect(getRoster).toHaveBeenCalledTimes(2);
    expect(readers.agents.get).not.toHaveBeenCalled();
    getRoster.mockResolvedValueOnce(teamsSnapshot).mockResolvedValueOnce({
      ...teamsSnapshot,
      teams: [{ ...teamsSnapshot.teams[0]!, agents: [{ ...teamsSnapshot.teams[0]!.agents[0]!, occupantId: "o0000000000000000" }] }],
    });
    await expect(apps.dashboardRead(owner, app.id, { resource: "activity", expectedRevision: 1, agentId: "w6:p1", occupantId }))
      .rejects.toMatchObject({ status: 409 });
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

  it("stores, preserves, clears, rolls back, replays, and validates custom Mini App icons", async () => {
    const { apps } = fixture();
    const created = await apps.publish(bot(), {
      ...publication({ slug: "work-secretary", title: "Work Secretary", requestKey: "create-preset" }),
      icon: "microsoft",
    });
    const id = created.app.id;
    expect(created.app.icon).toEqual({ kind: "preset", name: "microsoft" });
    await expect(apps.publish(bot(), {
      ...publication({ slug: "work-secretary", title: "Work Secretary", requestKey: "create-preset" }),
      icon: { kind: "preset", name: "microsoft" },
    })).resolves.toMatchObject({ app: created.app, replayed: true });

    const preserved = await apps.publish(owner, publication({
      requestKey: "preserve-icon",
      expectedRevision: 1,
      slug: "work-secretary",
      title: "Work Secretary v2",
      publisherBotIds: ["publisher"],
    }), id);
    expect(preserved.app.icon).toEqual({ kind: "preset", name: "microsoft" });

    const emoji = await apps.publish(bot(), {
      ...publication({ requestKey: "set-emoji", expectedRevision: 2, slug: "work-secretary", title: "Work Secretary v3" }),
      icon: { kind: "emoji", value: "📊", tone: "#2563EB" },
    }, id);
    expect(emoji.app.icon).toEqual({ kind: "emoji", value: "📊", tone: "#2563eb" });

    const shorthandEmoji = await apps.publish(bot(), {
      ...publication({ requestKey: "shorthand-emoji", expectedRevision: 3, slug: "work-secretary", title: "Work Secretary v4" }),
      icon: "🚀",
    }, id);
    expect(shorthandEmoji.app.icon).toEqual({ kind: "emoji", value: "🚀" });

    const cleared = await apps.publish(owner, publication({
      requestKey: "clear-icon",
      expectedRevision: 4,
      slug: "work-secretary",
      title: "Work Secretary v5",
      icon: null,
    }), id);
    expect(cleared.app.icon).toBeNull();

    const rolledBack = await apps.rollback(bot(), id, {
      requestKey: "rollback-to-emoji",
      expectedRevision: 5,
      templateVersion: 3,
    });
    expect(rolledBack.app.icon).toEqual({ kind: "emoji", value: "📊", tone: "#2563eb" });
    expect(await apps.rollback(bot(), id, {
      requestKey: "rollback-to-emoji",
      expectedRevision: 5,
      templateVersion: 3,
    })).toEqual({ app: rolledBack.app, replayed: true });

    closeMessageDb();
    expect(apps.document(owner, id).app.icon).toEqual({ kind: "emoji", value: "📊", tone: "#2563eb" });

    for (const invalidIcon of [
      "<svg></svg>",
      "https://example.com/icon.png",
      "unknown-preset",
      "not-an-emoji",
      { kind: "svg", value: "<svg/>" },
      { kind: "preset", name: "microsoft", tone: "javascript:alert(1)" },
      { kind: "emoji", value: "<b>x</b>" },
      { kind: "emoji", value: "📊🚀" },
    ]) {
      await expect(apps.publish(bot(), {
        ...publication({ requestKey: `bad-${Math.random()}`, expectedRevision: 6, slug: "work-secretary" }),
        icon: invalidIcon,
      }, id)).rejects.toMatchObject({ status: 400 });
    }

    const db = applicationDatabase();
    db.prepare("UPDATE mini_apps SET icon = ? WHERE id = ?").run("{corrupt-json", id);
    db.prepare("UPDATE mini_app_versions SET icon = ? WHERE app_id = ? AND version = 1").run('{"kind":"svg"}', id);
    expect(apps.list(owner).find((item) => item.id === id)?.icon).toBeNull();
    expect(apps.document(owner, id).app.icon).toBeNull();
    const rolledCorrupt = await apps.rollback(bot(), id, {
      requestKey: "rollback-corrupt-icon",
      expectedRevision: 6,
      templateVersion: 1,
    });
    expect(rolledCorrupt.app.icon).toBeNull();
  });

  it("persists owner-defined mini app sort_order across reads and appends unlisted apps stably", async () => {
    const { apps } = fixture();
    const first = (await apps.publish(owner, publication({ requestKey: "order-1", slug: "alpha", title: "Alpha" }))).app;
    const second = (await apps.publish(owner, publication({ requestKey: "order-2", slug: "beta", title: "Beta" }))).app;
    const third = (await apps.publish(owner, publication({ requestKey: "order-3", slug: "gamma", title: "Gamma" }))).app;
    expect(apps.list(owner).map((a) => a.id)).toEqual([first.id, second.id, third.id]);

    expect(() => apps.reorder(bot(), [third.id, first.id])).toThrow("Only the workspace owner can reorder Mini Apps.");

    const reordered = apps.reorder(owner, [third.id, "nonexistent", first.id, third.id]);
    expect(reordered.map((a) => a.id)).toEqual([third.id, first.id, second.id]);

    closeMessageDb();
    expect(apps.list(owner).map((a) => a.id)).toEqual([third.id, first.id, second.id]);
  });
});
