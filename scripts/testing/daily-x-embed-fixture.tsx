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
  policy.content = "frame-src 'none'";
  document.head.append(policy);
}
setLocale("en");
const app: MiniAppSummary = { id: DAILY_X_APP_ID, slug: "x-ai-digest", title: "Daily X", description: "Synthetic fixture",
  status: "active", revision: 6, templateVersion: 6, shippedTemplateKind: "x_ai_digest",
  publisherBotIds: [], createdAt: 1, updatedAt: 1 };
const report: MiniAppDocument = { app, html: "<p>Synthetic saved report</p>", bindings: [], versions: [] };
const state: MiniAppState = { appId: DAILY_X_APP_ID, revision: 6, templateVersion: 6, status: "active", data: [] };

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";
const root = document.getElementById("root")!;
root.style.cssText = "display:flex;flex-direction:column;height:100%;min-height:0";
createRoot(root).render(createElement(DailyXWholePage, { document: report, state, onRevoked: () => {} }));
