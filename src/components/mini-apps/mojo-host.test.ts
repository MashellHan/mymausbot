import { expect, it } from "vitest";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { MOJO_APP_ID, MOJO_POETRY_URL, mojoHostEligible } from "./mojo-host";

const marker = '<meta name="openmausbot:mojo-view" content="quotes-v1">';
const selected: MiniAppSummary = { id: MOJO_APP_ID, slug: "mojo", title: "Mojo", description: "",
  status: "active", revision: 3, templateVersion: 3, publisherBotIds: [], createdAt: 1, updatedAt: 1 };
const document: MiniAppDocument = { app: selected, html: `<!doctype html><html><head>${marker}</head><body>Quotes</body></html>`,
  bindings: [], versions: [] };
const state: MiniAppState = { appId: MOJO_APP_ID, revision: 3, templateVersion: 3, status: "active", data: [] };
const eligible = (change: Partial<Parameters<typeof mojoHostEligible>[0]> = {}) => mojoHostEligible({
  selected, document, state, localOwner: true, nativeGuard: true, ...change,
});

it("admits only the fixed owner-approved Mojo document at its current empty head", () => {
  expect(MOJO_POETRY_URL).toBe("https://mao.hexly.ai/#poem=03");
  expect(eligible()).toBe(true);
  expect(eligible({ localOwner: false })).toBe(false);
  expect(eligible({ nativeGuard: false })).toBe(false);
  expect(eligible({ selected: { ...selected, id: "another-app" } })).toBe(false);
  expect(eligible({ document: { ...document, app: { ...selected, id: "another-app" } } })).toBe(false);
  expect(eligible({ state: { ...state, appId: "another-app" } })).toBe(false);
  expect(eligible({ selected: { ...selected, status: "archived" } })).toBe(false);
  expect(eligible({ document: { ...document, app: { ...selected, status: "archived" } } })).toBe(false);
  expect(eligible({ state: { ...state, status: "archived" } })).toBe(false);
  expect(eligible({ selected: { ...selected, revision: 4 } })).toBe(false);
  expect(eligible({ state: { ...state, revision: 4 } })).toBe(false);
  expect(eligible({ selected: { ...selected, templateVersion: 2 } })).toBe(false);
  expect(eligible({ state: { ...state, templateVersion: 2 } })).toBe(false);
  expect(eligible({ document: { ...document, bindings: [{} as MiniAppDocument["bindings"][number]] } })).toBe(false);
  expect(eligible({ state: { ...state, data: [{ datasetId: "data", revision: 1 }] } })).toBe(false);
});

it("requires exactly one compatibility marker in the HTML head", () => {
  expect(eligible({ document: { ...document, html: `<html><head></head><body>${marker}</body></html>` } })).toBe(false);
  expect(eligible({ document: { ...document, html: `<html><head>${marker}${marker}</head><body></body></html>` } })).toBe(false);
  expect(eligible({ document: { ...document, html: "<html><head></head><body>Old quote document</body></html>" } })).toBe(false);
});
