import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { MiniAppNamedPage } from "../../shared/mini-app-data.ts";
import type { MiniAppMutationResult, MiniAppSources, MiniAppState } from "../../shared/mini-apps.ts";
import { runControlOmb } from "../../scripts/control-omb.ts";
import { callTool } from "../drivers/agents-call.ts";
import { createHarnessClient } from "../drivers/agents-client.ts";
import { launchMiniAppsFixture } from "../testing/mini-apps-fixture.ts";
import { assertMiniAppExportPrivacy } from "./backup.ts";

const records = (page: MiniAppNamedPage) => page.rows.map((row) => Object.fromEntries(page.columns.map((column, index) => [column.name, row[index]])));

it("keeps a reusable local library through Data refresh, publication, restart, backup and publisher deletion", async () => {
  const fixture = await launchMiniAppsFixture();
  const { api, dataCall, installed, publication, bot, dataset, url } = fixture;
  const root = `/api/mini-apps/${installed.app.id}`;
  const query = (queryId: string, parameters: Record<string, string> = {}, revision = 1, expectedDataRevision?: number) => api<MiniAppNamedPage>("POST", `${root}/query`, { queryId, parameters, expectedRevision: revision, expectedDataRevision });
  try {
    const coverage = records(await query("coverage"));
    expect(coverage.find((row) => row.currency === "CNY")).toMatchObject({ count: "7", datedCount: "6", amountCount: "5", firstDate: "2026-04-01", lastDate: "2026-04-04" });
    const filters = { from: "2026-04-01", through: "2026-04-04", currency: "CNY" };
    const outflow = await query("outflow", filters);
    expect(records(outflow)).toEqual([{ currency: "CNY", count: "3", amount: "-12.54" }]);
    expect(records(await query("summary", filters, 1, outflow.revision))).toEqual([{ currency: "CNY", count: "6", net: "12.46" }]);
    expect(records(await query("category_options", filters)).some((row) => row.category === "Transfer")).toBe(true);
    expect(records(await query("summary", { ...filters, category: "Transfer" }))).toEqual([{ currency: "CNY", count: "1", net: "25.00" }]);
    expect(records(await query("outflow", { ...filters, category: "Transfer" }))).toEqual([]);
    const currencies = records(await query("outflow", { from: filters.from, through: filters.through })).map((row) => row.currency);
    expect(currencies).toEqual(expect.arrayContaining(["CNY", "USD", "", null]));
    await api("POST", `${root}/query`, { queryId: "outflow", parameters: filters, expectedRevision: 1, sql: "SELECT * FROM secret" }, 400);

    await dataCall("data_sql", { sql: "CREATE TABLE inventory AS SELECT 'Pencil' AS item, 7::INTEGER AS quantity" });
    const stock = await api<MiniAppMutationResult>("POST", "/api/mini-apps", {
      requestKey: "stock-install", expectedRevision: 0, slug: "inventory", title: "Inventory", description: "Synthetic non-financial app", html: "<h1>Inventory</h1>",
      bindings: [{ id: "stock", datasetId: dataset.datasetId, source: { schema: "main", table: "inventory" },
        fields: { item: { column: "item", sourceType: "VARCHAR", as: "text" }, quantity: { column: "quantity", sourceType: "INTEGER", as: "decimal", scale: 0 } },
        queries: { stock: { kind: "rows", columns: ["item", "quantity"], parameters: {}, filters: [], orderBy: [], pageSize: 10 } } }], publisherBotIds: [bot.id],
    }, 201);
    expect(records(await api<MiniAppNamedPage>("POST", `/api/mini-apps/${stock.app.id}/query`, { queryId: "stock", parameters: {}, expectedRevision: 1 }))).toEqual([{ item: "Pencil", quantity: "7" }]);

    const { token } = await fixture.mint("agents");
    const authorization = { authorization: `Bearer ${token}` };
    const info = await api<{ apps: Array<{ id: string }> }>("POST", "/api/internal/mini-apps/info", {}, 200, authorization);
    expect(info.apps.map((app) => app.id)).toEqual(expect.arrayContaining([installed.app.id, stock.app.id]));
    const tool = async (name: string, args: Record<string, unknown>) => {
      const current = await fixture.mint("agents");
      const result = await callTool(name, args, { botId: bot.id, threadId: bot.activeTaskId, depth: 0, externalRuntime: false,
        sharedComputers: false, client: createHarnessClient(url, current.token) });
      expect(result.isError, result.text).not.toBe(true);
      return JSON.parse(result.text) as Record<string, any>;
    };
    expect((await tool("mini_app_connect", {})).dataset.datasetId).toBe(dataset.datasetId);
    const authored = await tool("mini_app_publish", { publication: { requestKey: "bot-create", expectedRevision: 0, slug: "bot-notes", title: "Local notes", description: "Synthetic bot-authored app", html: "<p>First</p>", bindings: [] } });
    expect(authored.app.publisherBotIds).toEqual([bot.id]);
    expect((await tool("mini_app_info", { app_id: authored.app.id })).html).toBe("<p>First</p>");
    await tool("mini_app_publish", { app_id: authored.app.id, publication: { requestKey: "bot-update", expectedRevision: 1, slug: "bot-notes", title: "Local notes", description: "Synthetic bot-authored app", html: "<p>Second</p>", bindings: [] } });
    expect((await tool("mini_app_rollback", { app_id: authored.app.id, requestKey: "bot-rollback", expectedRevision: 2, templateVersion: 1 })).app).toMatchObject({ revision: 3, templateVersion: 1 });
    expect((await tool("mini_app_archive", { app_id: authored.app.id, requestKey: "bot-archive", expectedRevision: 3 })).app.status).toBe("archived");
    const archivedAuth = { authorization: `Bearer ${(await fixture.mint("agents")).token}` };
    await api("POST", "/api/internal/mini-apps/publish", { app_id: authored.app.id, publication: { requestKey: "archived-publish", expectedRevision: 4, slug: "bot-notes", title: "Local notes", description: "Synthetic bot-authored app", html: "<p>Again</p>", bindings: [] } }, 403, archivedAuth);
    await api("POST", "/api/internal/mini-apps/rollback", { app_id: authored.app.id, requestKey: "archived-rollback", expectedRevision: 4, templateVersion: 1 }, 403, archivedAuth);
    const preview = await api<{ rows: unknown[][]; rowCount: number }>("POST", `/api/mini-apps/sources/${dataset.datasetId}/page`, { schema: "main", table: "ledger_master", offset: 0, limit: 3 });
    expect(preview.rowCount).toBe(10);
    expect(preview.rows).toHaveLength(3);
    await api("POST", `/api/mini-apps/sources/${dataset.datasetId}/page`, { schema: "main", table: 'ledger_master"; SELECT * FROM secret', offset: 0, limit: 3 }, 404);
    const currentAuth = { authorization: `Bearer ${(await fixture.mint("agents")).token}` };
    await api("POST", "/api/internal/mini-apps/info", { botId: "forged" }, 403, currentAuth);
    await api("PATCH", `/api/bots/${bot.id}`, { toolScope: { deny: ["mcp:agents:mini_app_info"] } });
    await api("POST", "/api/internal/mini-apps/info", {}, 403, currentAuth);
    await api("PATCH", `/api/bots/${bot.id}`, { toolScope: null });
    const { bot: outsider } = await runControlOmb(["new-bot", "--name", "Unrelated publisher", "--url", url]) as { bot: { id: string; activeTaskId: string } };
    const foreign = { authorization: `Bearer ${(await fixture.mint("agents", outsider.id, outsider.activeTaskId)).token}` };
    await api("POST", "/api/internal/mini-apps/info", { app_id: installed.app.id }, 403, foreign);
    const delegatedBinding = { id: "stock", datasetId: dataset.datasetId, source: { schema: "main", table: "inventory" },
      fields: { item: { column: "item", sourceType: "VARCHAR", as: "text" } },
      queries: { stock: { kind: "rows", columns: ["item"], parameters: {}, filters: [], orderBy: [], pageSize: 10 } } };
    const delegatedInput = { requestKey: "delegate-install", expectedRevision: 0, slug: "delegated-stock", title: "Delegated inventory",
      description: "Synthetic scoped editor", html: "<p>Stock</p>", bindings: [delegatedBinding] };
    const delegated = await api<MiniAppMutationResult>("POST", "/api/mini-apps", { ...delegatedInput, publisherBotIds: [outsider.id] }, 201);
    await api("POST", "/api/internal/mini-apps/publish", { app_id: delegated.app.id, publication: { ...delegatedInput, requestKey: "delegate-layout", expectedRevision: 1, html: "<p>New stock layout</p>" } }, 200, foreign);
    await api("POST", "/api/internal/mini-apps/publish", { app_id: delegated.app.id, publication: { ...delegatedInput, requestKey: "delegate-expand", expectedRevision: 2,
      bindings: [{ ...delegatedBinding, fields: { ...delegatedBinding.fields, quantity: { column: "quantity", sourceType: "INTEGER", as: "decimal", scale: 0 } } }] } }, 403, foreign);
    await api("POST", "/api/internal/mini-apps/publish", { publication: { ...delegatedInput, slug: "copied-scope", requestKey: "copy-grant" } }, 403, foreign);
    const pairing = await api<{ code: string }>("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    const paired = await api<{ token: string }>("POST", "/api/auth/pair", { code: pairing.code, label: "Mini App paired fixture" });
    await api("GET", "/api/mini-apps", undefined, 403, { authorization: `Bearer ${paired.token}` });

    const second = { ...publication, requestKey: "second", expectedRevision: 1, title: "Updated bookkeeping" };
    expect((await api<MiniAppMutationResult>("POST", `${root}/publish`, second)).app.revision).toBe(2);
    expect((await api<MiniAppMutationResult>("POST", `${root}/publish`, second)).replayed).toBe(true);
    await api("POST", `${root}/publish`, { ...second, title: "Conflict" }, 409);
    expect((await api<MiniAppMutationResult>("POST", `${root}/rollback`, { requestKey: "rollback", expectedRevision: 2, templateVersion: 1 })).app).toMatchObject({ revision: 3, templateVersion: 1 });
    const before = await query("outflow", filters, 3);
    await dataCall("data_sql", { sql: "CREATE OR REPLACE TABLE ledger_master AS SELECT * FROM ledger_master UNION ALL SELECT 'Food', '2026-04-04', '-1.00', 'Card', 'Daily', 'CNY', 'New record'" });
    await api("POST", `${root}/query`, { queryId: "outflow", parameters: filters, expectedRevision: 3, expectedDataRevision: before.revision }, 409);
    expect(records(await query("outflow", filters, 3))).toEqual([{ currency: "CNY", count: "4", amount: "-13.54" }]);
    expect((await api<MiniAppState>("GET", `${root}/state`)).revision).toBe(3);
    const beforeRestart = { authorization: `Bearer ${(await fixture.mint("agents")).token}` };
    await api("POST", "/api/internal/mini-apps/info", {}, 200, beforeRestart);
    await fixture.restart();
    await api("POST", "/api/internal/mini-apps/info", {}, 401, beforeRestart);
    expect(records(await query("outflow", filters, 3))[0]?.amount).toBe("-13.54");

    const backup = await api<{ id: string; summary: { bytes: number } }>("POST", "/api/workspace-backup/export", { password: "synthetic-mini-app-backup-passphrase" });
    expect(backup.id).toBeTypeOf("string");
    expect(existsSync(join(fixture.dataDir, "mini-app-data.json"))).toBe(false);
    await api("POST", `${root}/publish`, { ...publication, requestKey: "revoke-before-restore", expectedRevision: 3, publisherBotIds: [] });
    await api("DELETE", `/api/bots/${bot.id}`);
    expect((await api<MiniAppSources>("GET", "/api/mini-apps/sources")).datasets.some((source) => source.datasetId === dataset.datasetId)).toBe(true);
    expect(records(await query("outflow", filters, 4))[0]?.amount).toBe("-13.54");
    expect((await fixture.document()).app.revision).toBe(4);
    expect(() => assertMiniAppExportPrivacy(fixture.dataDir, true)).toThrow("private to the workspace owner");
    const downloaded = await fetch(url + `/api/workspace-backup/download/${backup.id}`);
    expect(downloaded.ok).toBe(true);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const uploaded = await fetch(url + "/api/workspace-backup/upload", { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) }, body: bytes });
    expect(uploaded.ok).toBe(true);
    const upload = await uploaded.json() as { id: string };
    const staged = await api<{ id: string }>("POST", "/api/workspace-backup/preview", { id: upload.id, password: "synthetic-mini-app-backup-passphrase" });
    await api("POST", "/api/workspace-backup/restore", { id: staged.id, confirmation: "REPLACE" });
    await fixture.restart();
    expect((await fixture.document()).app).toMatchObject({ revision: 3, templateVersion: 1, publisherBotIds: [] });
    expect(records(await query("outflow", filters, 3))[0]?.amount).toBe("-13.54");
    expect((await api<MiniAppSources>("GET", "/api/mini-apps/sources")).bots.some((source) => source.id === bot.id)).toBe(true);
    const restoredAuth = { authorization: `Bearer ${(await fixture.mint("agents")).token}` };
    await api("POST", "/api/internal/mini-apps/info", { app_id: installed.app.id }, 403, restoredAuth);
    await api("POST", "/api/internal/mini-apps/publish", { app_id: installed.app.id, publication: { ...publication, publisherBotIds: undefined, requestKey: "restore-grant", expectedRevision: 3 } }, 403, restoredAuth);
    await api("POST", `${root}/publish`, { ...publication, requestKey: "owner-regrant", expectedRevision: 3, publisherBotIds: [bot.id] });
    await api("POST", "/api/internal/mini-apps/info", { app_id: installed.app.id }, 200, restoredAuth);
  } finally { await fixture.close(); }
}, 120_000);
