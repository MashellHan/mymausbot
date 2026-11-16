// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { MOJO_APP_ID, MOJO_POETRY_FRAME_NAME, MOJO_POETRY_URL } from "./mojo-host";

const mounts = vi.hoisted(() => ({ quotes: 0, poetry: 0, quoteUnmounts: 0, poemUnmounts: 0 }));
vi.mock("./MiniAppFrame", async () => {
  const { createElement, useEffect } = await import("react");
  return { MiniAppFrame: () => {
    useEffect(() => { mounts.quotes++; return () => { mounts.quoteUnmounts++; }; }, []);
    return createElement("div", { "data-testid": "quote-frame" });
  } };
});
vi.mock("../published-apps/SiteFrame", async () => {
  const { createElement, useEffect } = await import("react");
  return { SiteFrame: ({ url, sandbox, frameName }: { url: string; sandbox: string; frameName: string }) => {
    useEffect(() => { mounts.poetry++; return () => { mounts.poemUnmounts++; }; }, []);
    return createElement("div", { "data-testid": "poetry-frame", "data-url": url, "data-sandbox": sandbox, "data-frame-name": frameName });
  } };
});

import { MojoWholePage } from "./MojoWholePage";

const app: MiniAppSummary = { id: MOJO_APP_ID, slug: "mojo", title: "Mojo", description: "",
  status: "active", revision: 3, templateVersion: 3, publisherBotIds: [], createdAt: 1, updatedAt: 1 };
const document: MiniAppDocument = { app, html: "<html></html>", bindings: [], versions: [] };
const state: MiniAppState = { appId: MOJO_APP_ID, revision: 3, templateVersion: 3, status: "active", data: [] };
let root: Root;
let host: HTMLDivElement;
const tab = (name: string) => host.querySelector<HTMLButtonElement>(`[data-mojo-tab="${name}"]`)!;
const panel = (name: string) => host.querySelector<HTMLElement>(`#mojo-panel-${name}`)!;
const navigation = () => host.querySelector<HTMLElement>("[data-mojo-navigation]")!;
const pointer = (target: HTMLElement, type: string, x: number, y: number, pointerId = 1, isPrimary = true) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType: "touch", pointerId, isPrimary, clientX: x, clientY: y });
  target.dispatchEvent(event);
};
const render = () => act(() => root.render(createElement(MojoWholePage, { document, state, onRevoked: vi.fn() })));

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(mounts, { quotes: 0, poetry: 0, quoteUnmounts: 0, poemUnmounts: 0 });
  host = window.document.createElement("div");
  window.document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps both sibling frames mounted and hides the inactive view", () => {
  render();
  const quote = host.querySelector("[data-testid=quote-frame]");
  expect(quote).not.toBeNull();
  expect(panel("poetry").hidden).toBe(true);
  expect(panel("poetry").hasAttribute("inert")).toBe(true);
  expect(host.querySelector("[data-testid=poetry-frame]")).toBeNull();
  expect(tab("quotes").getAttribute("aria-selected")).toBe("true");
  act(() => tab("poetry").click());
  const poem = host.querySelector<HTMLElement>("[data-testid=poetry-frame]");
  expect(poem?.dataset).toMatchObject({ url: MOJO_POETRY_URL, sandbox: "allow-scripts allow-same-origin", frameName: MOJO_POETRY_FRAME_NAME });
  expect(panel("quotes").hidden).toBe(true);
  expect(panel("quotes").hasAttribute("inert")).toBe(true);
  expect(panel("poetry").hidden).toBe(false);
  act(() => tab("quotes").click());
  expect(host.querySelector("[data-testid=quote-frame]")).toBe(quote);
  expect(host.querySelector("[data-testid=poetry-frame]")).toBe(poem);
  expect(panel("poetry").hidden).toBe(true);
  expect(panel("poetry").hasAttribute("inert")).toBe(true);
  expect(mounts).toMatchObject({ quotes: 1, poetry: 1, quoteUnmounts: 0, poemUnmounts: 0 });
});

it("switches by accessible keys and top-area horizontal touch without hijacking body or vertical motion", () => {
  render();
  act(() => tab("quotes").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  expect(tab("poetry").getAttribute("aria-selected")).toBe("true");
  expect(window.document.activeElement).toBe(tab("poetry"));
  act(() => tab("poetry").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
  expect(tab("quotes").getAttribute("aria-selected")).toBe("true");

  act(() => { pointer(navigation(), "pointerdown", 160, 10); pointer(navigation(), "pointermove", 155, 80);
    pointer(navigation(), "pointerup", 40, 90); });
  expect(tab("quotes").getAttribute("aria-selected")).toBe("true");
  act(() => { pointer(navigation(), "pointerdown", 160, 10); pointer(navigation(), "pointerdown", 150, 10, 2, false);
    pointer(navigation(), "pointerup", 40, 10); });
  expect(tab("quotes").getAttribute("aria-selected")).toBe("true");
  act(() => { pointer(navigation(), "pointerdown", 160, 10); pointer(navigation(), "pointercancel", 160, 10);
    pointer(navigation(), "pointerup", 40, 10); });
  expect(tab("quotes").getAttribute("aria-selected")).toBe("true");

  act(() => { pointer(navigation(), "pointerdown", 160, 10); pointer(navigation(), "pointerup", 40, 15); });
  expect(tab("poetry").getAttribute("aria-selected")).toBe("true");
  act(() => tab("quotes").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
  expect(tab("poetry").getAttribute("aria-selected")).toBe("true");
  act(() => { pointer(panel("poetry"), "pointerdown", 20, 10); pointer(panel("poetry"), "pointerup", 150, 10); });
  expect(tab("poetry").getAttribute("aria-selected")).toBe("true");
  act(() => { pointer(navigation(), "pointerdown", 30, 10); pointer(navigation(), "pointerup", 150, 12); });
  expect(tab("quotes").getAttribute("aria-selected")).toBe("true");
});

it("keeps an immediate new tap after a swipe when no synthetic click follows", () => {
  render();
  act(() => { pointer(navigation(), "pointerdown", 160, 10); pointer(navigation(), "pointerup", 40, 10); });
  expect(tab("poetry").getAttribute("aria-selected")).toBe("true");
  act(() => { pointer(tab("quotes"), "pointerdown", 30, 10); pointer(tab("quotes"), "pointerup", 31, 10);
    tab("quotes").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
  expect(tab("quotes").getAttribute("aria-selected")).toBe("true");
});
