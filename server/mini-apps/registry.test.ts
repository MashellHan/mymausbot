import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniAppDataBinding, MiniAppNamedPage } from "../../shared/mini-app-data.ts";
import type { MiniAppPublish } from "../../shared/mini-apps.ts";
import { AppDocs, APP_DOCS_SWEEP_GRACE_MS } from "../app-docs.ts";
import { DATA_DIR } from "../config.ts";
import { applicationDatabase, closeMessageDb } from "../message-db.ts";
import { MiniApps, miniAppDocRefs, type MiniAppActor } from "./registry.ts";

const DATASET = "7c39027b-cbb0-461a-aec8-0d7b6e553ec6";
const binding: MiniAppDataBinding = { id: "inventory", datasetId: DATASET, source: { schema: "main", table: "inventory" },
  fields: { item: { column: "item", sourceType: "VARCHAR", as: "text" } },
  queries: { stock: { kind: "rows", columns: ["item"], parameters: {}, filters: [], orderBy: [], pageSize: 10 } } };
const owner: MiniAppActor = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
const bot = (botId = "publisher"): MiniAppActor => ({ ...owner, botId });
const publication = (extra: Partial<MiniAppPublish> = {}): MiniAppPublish => ({ requestKey: "create", expectedRevision: 0,
  slug: "inventory", title: "Inventory", description: "Synthetic stock report", html: "<h1>Inventory</h1>", bindings: [binding], ...extra });

function fixture(maxBytes?: number) {
  const docs = new AppDocs(join(DATA_DIR, "app-docs"), { maxBytes });
  const publishers = new Set(["publisher", "other"]);
  let revision = 1;
  const data = {
    validateBinding: vi.fn(async () => undefined),
    readNamed: vi.fn(async (): Promise<MiniAppNamedPage> => ({ columns: [{ name: "item", type: "text" }], rows: [["Pencil"]], revision })),
    listDatasets: vi.fn(async () => [{ datasetId: DATASET, storeId: "store", revision }]),
  };
  const apps = new MiniApps({ docs, data, validPublisher: (id) => publishers.has(id) });
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
});
