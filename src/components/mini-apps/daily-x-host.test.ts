import { expect, it } from "vitest";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { DAILY_X_APP_ID, DAILY_X_URL, dailyXHostEligible } from "./daily-x-host";

const selected: MiniAppSummary = { id: DAILY_X_APP_ID, slug: "x-ai-digest", title: "Daily X", description: "",
  status: "active", revision: 6, templateVersion: 6, shippedTemplateKind: "x_ai_digest",
  publisherBotIds: ["synthetic-publisher"], createdAt: 1, updatedAt: 1 };
const document: MiniAppDocument = { app: selected, html: "<p>Synthetic saved report</p>", bindings: [], versions: [] };
const state: MiniAppState = { appId: DAILY_X_APP_ID, revision: 6, templateVersion: 6, status: "active", data: [] };
const eligible = (change: Partial<Parameters<typeof dailyXHostEligible>[0]> = {}) => dailyXHostEligible({
  selected, document, state, localOwner: true, nativeGuard: true, ...change,
});

it("keeps the web reading view on the existing current local Daily X only", () => {
  expect(DAILY_X_URL).toBe("https://mxhan.com/x/");
  expect(eligible()).toBe(true);
  expect(eligible({ localOwner: false })).toBe(false);
  expect(eligible({ nativeGuard: false })).toBe(false);
  expect(eligible({ selected: { ...selected, id: "copied" } })).toBe(false);
  expect(eligible({ document: { ...document, app: { ...selected, id: "copied" } } })).toBe(false);
  expect(eligible({ state: { ...state, appId: "copied" } })).toBe(false);
  expect(eligible({ selected: { ...selected, shippedTemplateKind: null } })).toBe(false);
  expect(eligible({ document: { ...document, app: { ...selected, shippedTemplateKind: null } } })).toBe(false);
  expect(eligible({ selected: { ...selected, status: "archived" } })).toBe(false);
  expect(eligible({ document: { ...document, app: { ...selected, status: "archived" } } })).toBe(false);
  expect(eligible({ state: { ...state, status: "archived" } })).toBe(false);
  expect(eligible({ selected: { ...selected, revision: 7 } })).toBe(false);
  expect(eligible({ state: { ...state, revision: 7 } })).toBe(false);
  expect(eligible({ selected: { ...selected, templateVersion: 7 } })).toBe(false);
  expect(eligible({ state: { ...state, templateVersion: 7 } })).toBe(false);
  expect(eligible({ selected: { ...selected, dashboard: { kind: "usage", renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: ["usage"] } } })).toBe(false);
});
