import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runControlOmb } from "../../scripts/control-omb.ts";
import type { MiniAppNamedPage } from "../../shared/mini-app-data.ts";
import type { MiniAppDefaultsResult, MiniAppDocument, MiniAppMutationResult } from "../../shared/mini-apps.ts";
import { launchMiniAppsFixture } from "../testing/mini-apps-fixture.ts";

const records = (page: MiniAppNamedPage) => page.rows.map((row) => Object.fromEntries(page.columns.map((column, index) => [column.name, row[index]])));

it("opens five persisted defaults on existing Bot Data, preserves removals and follows ongoing writes", async () => {
  const fixture = await launchMiniAppsFixture({ defaultApps: true });
  const { api, url, dataDir, installed, bot, dataCall, publication } = fixture;
  const input = { bookkeepingHtml: publication.html };
  const ensure = (restore?: string) => api<MiniAppDefaultsResult>("POST", "/api/mini-apps/defaults", { ...input, ...(restore ? { restore } : {}) });
  try {
    expect(fixture.defaults?.issues).toEqual([]);
    expect(fixture.defaults?.apps).toHaveLength(5);
    expect(installed.app).toMatchObject({ title: "记账管家", publisherBotIds: [bot.id], revision: 1 });
    expect(existsSync(join(dataDir, "bots", bot.id, "data.duckdb"))).toBe(false);
    const { bot: unused } = await runControlOmb(["new-bot", "--name", "No Data fixture", "--url", url]) as { bot: { id: string } };
    const concurrent = await Promise.all([ensure(), ensure()]);
    for (const result of concurrent) expect(result.apps).toEqual(fixture.defaults!.apps);
    expect(existsSync(join(dataDir, "bots", unused.id, "data.duckdb"))).toBe(false);
    const query = (queryId: string, expectedRevision = 1) => api<MiniAppNamedPage>("POST", `/api/mini-apps/${installed.app.id}/query`, {
      queryId, parameters: { currency: "CNY", from: "2026-04-01", through: "2026-04-04" }, expectedRevision,
    });
    expect(records(await query("summary"))).toEqual([{ currency: "CNY", count: "6", net: "12.46" }]);
    expect(records(await query("trend_day_inflow"))).toEqual([{ currency: "CNY", bucket: "2026-04-03", count: "1", amount: "25.00" }]);
    expect(records(await query("largest_expenses"))[0]).toMatchObject({ amount: "-12.34", category: "Food" });
    await dataCall("data_sql", { sql: "CREATE OR REPLACE TABLE ledger_master AS SELECT * FROM ledger_master UNION ALL SELECT 'Baby', '2026-04-04', '-75.00', 'Card', 'Daily', 'CNY', 'Cream'" });
    expect(records(await query("outflow"))).toEqual([{ currency: "CNY", count: "4", amount: "-87.54" }]);

    const native = fixture.defaults!.apps.find((app) => app.dashboardIdentity === "usage")!;
    expect(native).toMatchObject({ title: "Work Tracker", dashboard: { kind: "usage" } });
    for (const app of [installed.app, native]) {
      await api("POST", `/api/mini-apps/${app.id}/archive`, { requestKey: `remove-${app.id}`, expectedRevision: app.revision });
    }
    await fixture.restart();
    const afterRestart = await ensure();
    for (const id of [installed.app.id, native.id]) expect(afterRestart.apps.find((app) => app.id === id)?.status).toBe("archived");
    const restored = await ensure("bookkeeping");
    expect(restored.apps.find((app) => app.id === installed.app.id)).toMatchObject({ status: "active", revision: 3 });
    expect(restored.apps.find((app) => app.id === native.id)).toMatchObject({ status: "archived", dashboard: null });
    expect(records(await query("outflow", 3))[0]?.amount).toBe("-87.54");
    expect((await ensure("usage")).apps.find((app) => app.id === native.id)).toMatchObject({ status: "active", dashboard: { kind: "usage" } });

    const doc = await api<MiniAppDocument>("GET", `/api/mini-apps/${installed.app.id}`);
    await api("POST", `/api/mini-apps/${installed.app.id}/publish`, { ...doc.app, requestKey: "invalid-extra-fields", html: doc.html, bindings: doc.bindings }, 400);
    const modified = await api<MiniAppMutationResult>("POST", `/api/mini-apps/${installed.app.id}/publish`, {
      requestKey: "customize", expectedRevision: 3, slug: doc.app.slug, title: "My ledger", description: "Custom page",
      html: "<p>My custom page</p>", bindings: doc.bindings, publisherBotIds: [],
    });
    expect((await ensure()).apps.find((app) => app.id === installed.app.id)).toEqual(modified.app);

    const pairing = await api<{ code: string }>("POST", "/api/auth/pairing", { scopes: ["admin", "client"] });
    const paired = await api<{ token: string }>("POST", "/api/auth/pair", { code: pairing.code, label: "Defaults phone fixture" });
    await api("POST", "/api/mini-apps/defaults", input, 403, { authorization: `Bearer ${paired.token}` });

    const x = fixture.defaults!.apps.find((app) => app.shippedTemplateKind === "x_ai_digest")!;
    const routine = (await api<{ routine: { id: string } }>("POST", "/api/routines", {
      name: "Daily X AI digest", prompt: "Collect the daily X AI report.", botId: bot.id,
      schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 }, enabled: false,
    }, 201)).routine;
    await api("PATCH", `/api/routines/${routine.id}`, { enabled: true });
    const connected = (await ensure()).apps.find((app) => app.id === x.id)!;
    expect(connected).toMatchObject({ revision: 2, publisherBotIds: [bot.id] });
    expect((await api<MiniAppDocument>("GET", `/api/mini-apps/${x.id}`)).bindings).toHaveLength(1);
    expect((await ensure()).apps.find((app) => app.id === x.id)?.revision).toBe(2);
  } finally {
    console.info(JSON.stringify({ logPath: fixture.logPath }));
    await fixture.close();
  }
}, 120_000);
