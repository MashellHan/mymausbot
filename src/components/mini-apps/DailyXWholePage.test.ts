// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { DAILY_X_APP_ID, DAILY_X_FRAME_NAME, DAILY_X_URL } from "./daily-x-host";

vi.mock("./MiniAppFrame", () => ({ MiniAppFrame: ({ state, onRevoked }: { state: MiniAppState; onRevoked(): void }) =>
  createElement("button", { "data-testid": "saved-report", "data-revision": state.revision, onClick: onRevoked }, "Saved report") }));

import { DailyXWholePage } from "./DailyXWholePage";

const app: MiniAppSummary = { id: DAILY_X_APP_ID, slug: "x-ai-digest", title: "Daily X", description: "",
  status: "active", revision: 6, templateVersion: 6, shippedTemplateKind: "x_ai_digest",
  publisherBotIds: [], createdAt: 1, updatedAt: 1 };
const document: MiniAppDocument = { app, html: "<p>Synthetic saved report</p>", bindings: [], versions: [] };
const state: MiniAppState = { appId: DAILY_X_APP_ID, revision: 6, templateVersion: 6, status: "active", data: [] };
let root: Root;
let host: HTMLDivElement;
let revoked: () => void;
const frame = () => host.querySelector<HTMLIFrameElement>("[data-daily-x-frame]");
const render = () => act(() => root.render(createElement(DailyXWholePage, { document, state, onRevoked: revoked })));
const watchPosts = (site: HTMLIFrameElement) => {
  Object.defineProperty(site, "contentWindow", { configurable: true, value: window });
  return vi.spyOn(window, "postMessage").mockImplementation(() => {});
};
const message = (type: string, path: string, nonce?: string, origin = "https://mxhan.com",
  source: MessageEventSource | null = frame()?.contentWindow ?? null) =>
  act(() => window.dispatchEvent(new MessageEvent("message", { origin, source, data: { xreport: 1, type, path, nonce } })));
const load = (site: HTMLIFrameElement, post: ReturnType<typeof vi.spyOn>) => {
  act(() => site.dispatchEvent(new Event("load")));
  const [challenge, target] = post.mock.calls.at(-1)! as [{ xreport: number; type: string; nonce: string }, string];
  expect(challenge).toMatchObject({ xreport: 1, type: "challenge" });
  expect(target).toBe("https://mxhan.com");
  return challenge.nonce;
};

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = window.document.createElement("div");
  window.document.body.append(host);
  root = createRoot(host);
  revoked = vi.fn<() => void>();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps the public site in a bounded frame and requires its own positive ready message", () => {
  render();
  const site = frame()!;
  expect(site.getAttribute("src")).toBe(DAILY_X_URL);
  expect(site.getAttribute("name")).toBe(DAILY_X_FRAME_NAME);
  expect(site.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups");
  expect(site.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(site.getAttribute("allow")).toContain("camera 'none'");
  expect(site.getAttribute("allow")).not.toContain("'self'");
  const post = watchPosts(site);
  message("ready", "/x/20261117/", "stale");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const nonce = load(site, post);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  message("ready", "/x/20261117/");
  message("ready", "/x/20261117/", nonce, "https://other.example");
  message("ready", "/x/20261117/", nonce, "https://mxhan.com", null);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  message("ready", "/x/20261117/", nonce);
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(frame()).toBe(site);
  message("leaving", "/x/20261117/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const next = load(site, post);
  message("ready", "/x/20261116/2119569027937063405/", next);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("keeps initial pageshow readiness pending until the load's current challenge returns", () => {
  render();
  const site = frame()!;
  const post = watchPosts(site);
  message("shown", "/x/20261117/");
  const early = (post.mock.calls.at(-1)![0] as { nonce: string }).nonce;
  message("ready", "/x/20261117/", early);
  expect(host.querySelector('[role="status"]')).toBeNull();
  const loaded = load(site, post);
  expect(loaded).not.toBe(early);
  message("ready", "/x/20261117/", early);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  message("ready", "/x/20261117/", loaded);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("requires a fresh challenge after every load and times out when a later document stays silent", () => {
  vi.useFakeTimers();
  render();
  const site = frame()!;
  const post = watchPosts(site);
  const first = load(site, post);
  message("ready", "/x/20261117/", first);
  expect(host.querySelector('[role="status"]')).toBeNull();
  const next = load(site, post);
  expect(next).not.toBe(first);
  message("ready", "/x/20261117/", first);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  act(() => vi.advanceTimersByTime(10_000));
  expect(host.querySelector('[data-testid="daily-x-failed"]')).not.toBeNull();
});

it("renews readiness when a restored document announces pageshow", () => {
  render();
  const site = frame()!;
  const post = watchPosts(site);
  const first = load(site, post);
  message("ready", "/x/20261117/", first);
  message("shown", "/x/20261117/");
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  const restored = (post.mock.calls.at(-1)![0] as { nonce: string }).nonce;
  expect(restored).not.toBe(first);
  message("ready", "/x/20261117/", first);
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  message("ready", "/x/20261117/", restored);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it("times out without a site message, retries only on request, and retains the saved report as fallback", () => {
  vi.useFakeTimers();
  render();
  const first = frame();
  act(() => vi.advanceTimersByTime(10_000));
  expect(host.querySelector('[data-testid="daily-x-failed"]')).not.toBeNull();
  expect(frame()).toBeNull();
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="daily-x-failed"] button')!.click());
  expect(frame()).not.toBe(first);
  message("ready", "/x/astryx/");
  expect(host.querySelector('[data-testid="daily-x-failed"]')).not.toBeNull();
  act(() => host.querySelectorAll<HTMLButtonElement>('[data-testid="daily-x-failed"] button')[1]!.click());
  expect(host.querySelector('[data-testid="saved-report"]')?.getAttribute("data-revision")).toBe("6");
  act(() => host.querySelector<HTMLButtonElement>('[data-testid="saved-report"]')!.click());
  expect(revoked).toHaveBeenCalledOnce();
});
