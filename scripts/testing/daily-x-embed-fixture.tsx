import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { DailyXWholePage } from "../../src/components/mini-apps/DailyXWholePage";
import { DAILY_X_APP_ID } from "../../src/components/mini-apps/daily-x-host";
import { setLocale } from "../../src/lib/i18n";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../shared/mini-apps";
import "../../src/styles.css";

if (new URLSearchParams(location.search).get("mode") === "blocked") {
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "frame-src 'self' about:";
  document.head.append(policy);
}
setLocale("en");
Object.defineProperty(window, "ogb", { value: { app: { blocksOpaqueFrameNavigation: true } } });
const app: MiniAppSummary = { id: DAILY_X_APP_ID, slug: "x-ai-digest", title: "Daily X", description: "Synthetic fixture",
  status: "active", revision: 6, templateVersion: 6, shippedTemplateKind: "x_ai_digest",
  publisherBotIds: [], createdAt: 1, updatedAt: 1 };
const datasetId = "fixture-daily-x";
const report: MiniAppDocument = {
  app, versions: [],
  html: `<main style="padding:16px"><h1>Synthetic saved report</h1>
    <label>Edition <select id="edition"></select></label><p id="edition-title">Reading editions…</p>
    <script>
      const select = document.getElementById("edition");
      const title = document.getElementById("edition-title");
      mausApp.query("editions", {}).then(result => {
        for (const [date, text] of result.rows) select.add(new Option(date, text));
        select.addEventListener("change", () => { title.textContent = select.value; });
        title.textContent = select.value;
      }).catch(error => { title.textContent = error.message; });
    </script></main>`,
  bindings: [{
    id: "report", datasetId, source: { schema: "main", table: "editions" },
    fields: { date: { column: "date", sourceType: "DATE", as: "date" }, title: { column: "title", sourceType: "VARCHAR", as: "text" } },
    queries: { editions: { kind: "rows", columns: ["date", "title"], parameters: {}, filters: [], orderBy: [], pageSize: 10 } },
  }],
};
const state: MiniAppState = { appId: DAILY_X_APP_ID, revision: 6, templateVersion: 6, status: "active", data: [{ datasetId, revision: 1 }] };
const fetchOriginal = window.fetch.bind(window);
window.fetch = (input, init) => {
  if (input !== `/api/mini-apps/${DAILY_X_APP_ID}/query` || init?.method !== "POST") return fetchOriginal(input, init);
  const query = JSON.parse(String(init.body));
  if (query.queryId !== "editions" || query.expectedRevision !== state.revision || query.expectedDataRevision !== 1) {
    return Promise.resolve(Response.json({ error: "Unexpected fixture query" }, { status: 400 }));
  }
  return Promise.resolve(Response.json({
    revision: 1, columns: [{ name: "date", type: "date" }, { name: "title", type: "text" }],
    rows: [["2026-11-18", "Latest synthetic edition"], ["2026-11-17", "Earlier synthetic edition"]],
  }));
};

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";
const root = document.getElementById("root")!;
root.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
createRoot(root).render(createElement(DailyXWholePage, { document: report, state, onRevoked: () => {} }));
