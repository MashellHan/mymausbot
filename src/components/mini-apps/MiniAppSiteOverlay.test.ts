// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SiteFrame } from "../published-apps/SiteFrame";
import { MiniAppSiteOverlay } from "./MiniAppSiteOverlay";
import { createMiniAppSitePresentation, MINI_APP_REPORT_SITES, miniAppReleaseSite, type MiniAppReportSite, type MiniAppSiteView } from "./mini-app-site";
import { MOJO_POETRY_FRAME_NAME, MOJO_POETRY_URL } from "./mojo-host";

vi.mock("../published-apps/SiteFrame", async () => {
  const { createElement, useState } = await import("react");
  return {
    SiteFrame: ({ url, title, sandbox, frameName }: ComponentProps<typeof SiteFrame>) => {
      const [count, setCount] = useState(0);
      return createElement("button", {
        "data-url": url, "data-sandbox": sandbox, "data-name": frameName, "data-title": title,
        onClick: () => setCount(count + 1),
      }, count);
    },
  };
});

const viewport = { x: -20, y: 40, width: 500, height: 300 };
const show = { mausMiniApp: 1, type: "site-show", id: "request:1", site: "mojo-poetry", viewport };
let host: HTMLDivElement, frameBox: HTMLDivElement, iframe: HTMLIFrameElement, root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setLocale("en");
  host = document.createElement("div");
  frameBox = document.createElement("div");
  iframe = document.createElement("iframe");
  iframe.srcdoc = "<!doctype html><p>Mini App fixture</p>";
  root = createRoot(host);
  document.body.append(frameBox, host);
  frameBox.append(iframe);
  for (const element of [frameBox, iframe]) {
    Object.defineProperties(element, {
      clientWidth: { configurable: true, value: 360 },
      clientHeight: { configurable: true, value: 240 },
    });
  }
});
afterEach(() => { act(() => root.unmount()); host.remove(); frameBox.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const message = (data: unknown, source = iframe.contentWindow!, origin = "null") =>
  new MessageEvent("message", { data, source: source as unknown as MessageEventSource, origin });

it.each([
  ["mashellhan.mojo", "mojo-poetry-v1", "mojo-poetry"],
  ["mashellhan.x-ai-digest", "daily-x-site-v1", "daily-x"],
  ["mashellhan.github-activity", "github-activity-site-v1", "github-activity"],
])("enables only the fixed verified release capability and retains legacy views for %s", (packageId, capability, target) => {
  expect(miniAppReleaseSite(null)).toBeUndefined();
  expect(miniAppReleaseSite({ packageId, requires: [] })).toBeUndefined();
  expect(miniAppReleaseSite({ packageId, requires: [capability, "other-v1"] })).toBeUndefined();
  expect(miniAppReleaseSite({ packageId: "mashellhan.other", requires: [capability] })).toBeUndefined();
  expect(miniAppReleaseSite({ packageId, requires: [capability] })).toBe(target);
});

it("attaches just one fixed site lazily and clips it to the Mini frame while retaining view state on hide", () => {
  const ref = { current: frameBox };
  const render = (view: MiniAppSiteView) => root.render(createElement(MiniAppSiteOverlay, { frameBox: ref, view }));
  const onView = vi.fn(render);
  const site = createMiniAppSitePresentation({ site: "mojo-poetry", isCurrent: () => true, onView });
  const posted = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
  const send = (data: unknown) => act(() => { site.receive(message(data), iframe, true); });
  act(() => render(undefined));
  send({ ...show, viewport: null });
  expect(onView).not.toHaveBeenCalled();
  expect(host.children).toHaveLength(0);

  send(show);
  const overlay = host.firstElementChild as HTMLDivElement;
  expect(overlay.hidden).toBe(false);
  expect(overlay.inert).toBe(false);
  expect(overlay.style).toMatchObject({ left: "0px", top: "40px", width: "360px", height: "200px" });
  const remote = overlay.firstElementChild as HTMLButtonElement;
  expect(remote.dataset).toMatchObject({
    url: MOJO_POETRY_URL, sandbox: "allow-scripts allow-same-origin", name: MOJO_POETRY_FRAME_NAME, title: "Poetry",
  });
  act(() => remote.click());
  expect(remote.textContent).toBe("1");
  expect(posted).toHaveBeenLastCalledWith({ mausMiniApp: 1, type: "site-result", id: show.id }, "*");

  Object.defineProperty(frameBox, "clientWidth", { configurable: true, value: 200 });
  act(() => window.dispatchEvent(new Event("resize")));
  expect(overlay.style.width).toBe("200px");
  send({ ...show, viewport: null });
  expect(overlay.hidden).toBe(true);
  expect(overlay.inert).toBe(true);
  expect(overlay.firstElementChild).toBe(remote);
  send({ ...show, viewport: { x: 8, y: 48, width: 180, height: 160 } });
  expect(overlay.hidden).toBe(false);
  expect(overlay.style).toMatchObject({ left: "8px", top: "48px", width: "180px", height: "160px" });
  expect(overlay.firstElementChild).toBe(remote);
  expect(remote.textContent).toBe("1");

  act(() => site.retire());
  expect(host.children).toHaveLength(0);
  send(show);
  expect(host.children).toHaveLength(0);
  expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ error: "This site is unavailable." }), "*");
});

it("denies wrong senders and only attaches after initialization, valid geometry and current authorization", () => {
  let current = true;
  const onView = vi.fn();
  const site = createMiniAppSitePresentation({ site: "mojo-poetry", isCurrent: () => current, onView });
  const posted = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});

  expect(site.receive(message({ type: "other" }), iframe, true)).toBe(false);
  site.receive(message(show, window), iframe, true);
  site.receive(message(show, iframe.contentWindow!, "https://example.test"), iframe, true);
  site.receive(message({ ...show, id: "x".repeat(101) }), iframe, true);
  expect(posted).not.toHaveBeenCalled();

  site.receive(message(show), iframe, false);
  for (const data of [
    { ...show, site: "https://example.test/" }, { ...show, url: "https://example.test/" },
    { ...show, viewport: { ...viewport, origin: "https://example.test/" } },
    { ...show, viewport: { ...viewport, x: Infinity } }, { ...show, viewport: { ...viewport, width: -1 } },
    { ...show, viewport: { ...viewport, x: "0" } }, { ...show, viewport: { ...viewport, x: 2 ** 20 } },
    { ...show, viewport: { ...viewport, x: 1000 } }, { ...show, viewport: undefined },
  ]) site.receive(message(data), iframe, true);
  expect(posted).toHaveBeenCalledTimes(10);
  for (const [result] of posted.mock.calls) expect(result).toHaveProperty("error");
  expect(onView).not.toHaveBeenCalled();

  site.receive(message(show), iframe, true);
  expect(onView).toHaveBeenCalledWith({ site: "mojo-poetry", viewport });
  current = false;
  expect(site.checkCurrent()).toBe(false);
  expect(onView).toHaveBeenLastCalledWith(undefined);
  current = true;
  site.receive(message(show), iframe, true);
  expect(onView).toHaveBeenCalledTimes(2);
  expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ error: "This site is unavailable." }), "*");
  expect(createMiniAppSitePresentation({ site: "mojo-poetry", isCurrent: () => false, onView }).receive(message(show), iframe, true)).toBe(true);
  expect(onView).toHaveBeenCalledTimes(2);
});

function reportFixture(target: MiniAppReportSite) {
  let allowed = true;
  const frameBoxRef = { current: frameBox };
  const onGithubSelection = vi.fn();
  const site = createMiniAppSitePresentation({
    site: target, isCurrent: () => allowed, onGithubSelection,
    onView(view) { root.render(createElement(MiniAppSiteOverlay, { frameBox: frameBoxRef, view })); },
  });
  const received = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => {});
  const send = (opening: number, patch: Record<string, unknown> = {}) => act(() => {
    site.receive(message({ ...show, site: target, opening, ...patch }), iframe, true);
  });
  const overlay = () => host.querySelector<HTMLElement>("[data-mini-app-site]")!;
  const remote = () => host.querySelector<HTMLIFrameElement>("[data-mini-app-report-frame]")!;
  function watch() {
    const element = remote();
    const postMessage = vi.fn<(data: { nonce: string }, origin: string) => void>();
    const source = { postMessage } as unknown as Window;
    Object.defineProperty(element, "contentWindow", { configurable: true, value: source });
    const load = () => {
      act(() => element.dispatchEvent(new Event("load")));
      const last = postMessage.mock.calls.at(-1)!;
      expect(last[0]).toMatchObject({ [MINI_APP_REPORT_SITES[target].channel]: 1, type: "challenge" });
      expect(last[1]).toBe("https://mxhan.com");
      return last[0].nonce;
    };
    const notify = (data: Record<string, unknown>, sender = source, origin = "https://mxhan.com") => act(() => {
      window.dispatchEvent(message({ [MINI_APP_REPORT_SITES[target].channel]: 1, ...data }, sender, origin));
    });
    return { element, load, notify, source };
  }
  const phase = (opening: number, value: string) =>
    expect(received).toHaveBeenLastCalledWith({ mausMiniApp: 1, type: "site-status", site: target, opening, phase: value }, "*");
  return { allowed: (value: boolean) => { allowed = value; }, site, send, overlay, remote, watch, phase, received, onGithubSelection };
}

it("keeps Daily X inert until the allowlisted site answers the live opening challenge and replaces it on retry", () => {
  vi.useFakeTimers();
  const f = reportFixture("daily-x");
  f.send(0);
  f.send(1, { site: "github-activity" });
  f.send(1, { viewport: null });
  f.send(1, { path: "https://example.test/" });
  expect(f.remote()).toBeNull();
  f.send(1);
  const overlay = f.overlay();
  const remote = f.watch(), nonce = remote.load();
  expect(remote.element.getAttribute("src")).toBe(MINI_APP_REPORT_SITES["daily-x"].url);
  expect(remote.element.getAttribute("name")).toBe(MINI_APP_REPORT_SITES["daily-x"].name);
  expect(remote.element.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-popups");
  expect(remote.element.getAttribute("allow")).toContain("camera 'none'");
  expect(remote.element.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(overlay.style.width).toBe("360px");
  expect(overlay.inert).toBe(true);
  const ready = { type: "ready", path: "/x/20261120/", nonce };
  remote.notify(ready, window);
  remote.notify(ready, remote.source, "https://example.test");
  remote.notify({ ...ready, nonce: "expired" });
  expect(overlay.inert).toBe(true);
  remote.notify(ready);
  f.phase(1, "ready");
  expect(overlay.inert).toBe(false);
  f.send(1, { viewport: { ...viewport, width: 140 } });
  expect(overlay.style.width).toBe("120px");
  expect(overlay.inert).toBe(false);
  remote.notify({ type: "leaving", path: ready.path });
  f.phase(1, "loading");
  expect(overlay.inert).toBe(true);
  act(() => vi.advanceTimersByTime(10_000));
  f.phase(1, "failed");
  remote.notify(ready);
  expect(overlay.inert).toBe(true);
  f.send(2, { retry: true });
  expect(f.remote()).not.toBe(remote.element);
  const retry = f.watch();
  retry.notify({ ...ready, nonce: retry.load(), path: "/github/" });
  f.phase(2, "failed");
  expect(overlay.inert).toBe(true);
});

it("pauses the report handshake when the retained Mini App panel is parked", () => {
  vi.useFakeTimers();
  const f = reportFixture("daily-x");
  f.send(1);
  const remote = f.watch(), previous = remote.load();
  const resize = (width: number) => {
    for (const element of [frameBox, iframe]) Object.defineProperty(element, "clientWidth", { configurable: true, value: width });
    act(() => window.dispatchEvent(new Event("resize")));
  };
  const ready = { type: "ready", path: "/x/20261120/" };
  resize(0);
  expect(f.overlay().hidden).toBe(true);
  expect(f.remote()).toBe(remote.element);
  f.send(1, { viewport: { ...viewport, width: 200 } });
  expect(f.received).toHaveBeenLastCalledWith({ mausMiniApp: 1, type: "site-result", id: show.id }, "*");
  f.send(2, { retry: true });
  expect(f.received).toHaveBeenLastCalledWith(expect.objectContaining({ error: "This site is unavailable." }), "*");
  const before = f.received.mock.calls.length;
  remote.notify({ ...ready, nonce: previous });
  act(() => vi.advanceTimersByTime(10_000));
  expect(f.received.mock.calls).toHaveLength(before);
  resize(360);
  expect(f.remote()).toBe(remote.element);
  expect(f.overlay().style.width).toBe("180px");
  const fresh = remote.load();
  expect(fresh).not.toBe(previous);
  remote.notify({ ...ready, nonce: previous });
  expect(f.overlay().inert).toBe(true);
  remote.notify({ ...ready, nonce: fresh });
  expect(f.overlay().inert).toBe(false);
});

it("retains GitHub across hide, ignores prior openings and only reopens the Web path for a valid new Saved selection", () => {
  const f = reportFixture("github-activity");
  f.send(1);
  const first = f.watch();
  const selection = { editionKey: "2026-11-20", repo: "example/project" };
  const ready = { type: "ready", path: "/github/20261120/example/project/", ...selection };
  const nonce = first.load();
  first.notify({ ...ready, nonce });
  f.phase(1, "ready");
  expect(f.onGithubSelection).toHaveBeenCalledWith(selection);
  expect(f.site.setGithubSelection({ editionKey: "2026-11-21", repo: "example/incorrect-while-open" })).toBe(false);
  f.send(1, { viewport: null });
  expect(f.overlay().hidden).toBe(true);
  first.notify({ ...ready, nonce });
  f.send(1);
  expect(f.received).toHaveBeenLastCalledWith(expect.objectContaining({ error: "This site is unavailable." }), "*");
  expect(f.overlay().hidden).toBe(true);

  f.send(2);
  expect(f.remote()).toBe(first.element);
  expect(f.overlay().inert).toBe(true);
  first.notify({ ...ready, nonce });
  expect(f.onGithubSelection).toHaveBeenCalledTimes(1);
  const fresh = first.load();
  first.notify({ ...ready, nonce: fresh });
  f.phase(2, "ready");
  f.send(1, { viewport: null });
  expect(f.overlay().inert).toBe(false);
  f.send(2, { viewport: null });
  expect(f.site.setGithubSelection({ editionKey: "2026-11-21", repo: "example/other" })).toBe(true);
  f.send(3);
  const next = f.watch();
  expect(next.element).not.toBe(first.element);
  expect(next.element.getAttribute("src")).toBe("https://mxhan.com/github/20261121/example/other/");
  const nextNonce = next.load();
  first.notify({ ...ready, nonce: nextNonce });
  expect(f.overlay().inert).toBe(true);
  expect(f.onGithubSelection).toHaveBeenCalledTimes(1);
  f.allowed(false);
  next.notify({ type: "ready", path: "/github/20261121/example/other/", nonce: nextNonce });
  expect(f.onGithubSelection).toHaveBeenCalledTimes(1);
  expect(f.remote()).toBeNull();
});

it("enforces exact SQLGlot demo edition/repo context on ready while retaining leaving/shown/nonce handling", () => {
  const f = reportFixture("github-activity");
  f.send(1);
  const remote = f.watch();
  const firstNonce = remote.load();
  remote.notify({ type: "ready", path: "/github/demo/sqlglot-query-lab/", nonce: firstNonce, editionKey: "2026-11-22", repo: "tobymao/sqlglot" });
  f.phase(1, "ready");
  expect(f.overlay().inert).toBe(false);
  expect(f.onGithubSelection).toHaveBeenLastCalledWith({ editionKey: "2026-11-22", repo: "tobymao/sqlglot" });

  remote.notify({ type: "leaving", path: "/github/demo/sqlglot-query-lab/" });
  f.phase(1, "loading");
  expect(f.overlay().inert).toBe(true);

  remote.notify({ type: "shown", path: "/github/demo/sqlglot-query-lab/" });
  const shownNonce = remote.load();
  remote.notify({ type: "ready", path: "/github/demo/sqlglot-query-lab/", nonce: firstNonce, editionKey: "2026-11-22", repo: "tobymao/sqlglot" });
  expect(f.overlay().inert).toBe(true);
  remote.notify({ type: "ready", path: "/github/demo/sqlglot-query-lab/", nonce: shownNonce, editionKey: "2026-11-22", repo: "unionai-oss/pandera" });
  f.phase(1, "failed");
  expect(f.overlay().inert).toBe(true);

  f.send(2, { retry: true });
  const retry = f.watch();
  const retryNonce = retry.load();
  retry.notify({ type: "ready", path: "/github/demo/sqlglot-query-lab/", nonce: retryNonce });
  f.phase(2, "failed");
  expect(f.overlay().inert).toBe(true);
});

it("enforces exact Hypothesis demo edition/repo context on ready while rejecting superseded path and uppercase repo", () => {
  const f = reportFixture("github-activity");
  f.send(1);
  const remote = f.watch();
  const firstNonce = remote.load();
  remote.notify({ type: "ready", path: "/github/demo/hypothesis-orders/", nonce: firstNonce, editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });
  f.phase(1, "ready");
  expect(f.overlay().inert).toBe(false);
  expect(f.onGithubSelection).toHaveBeenLastCalledWith({ editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });

  remote.notify({ type: "leaving", path: "/github/demo/hypothesis-orders/" });
  f.phase(1, "loading");
  expect(f.overlay().inert).toBe(true);

  remote.notify({ type: "shown", path: "/github/demo/hypothesis-orders/" });
  const shownNonce = remote.load();
  remote.notify({ type: "ready", path: "/github/demo/hypothesis-orders/", nonce: firstNonce, editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });
  expect(f.overlay().inert).toBe(true);
  remote.notify({ type: "ready", path: "/github/demo/hypothesis-orders/", nonce: shownNonce, editionKey: "2026-11-23", repo: "HypothesisWorks/hypothesis" });
  f.phase(1, "failed");
  expect(f.overlay().inert).toBe(true);

  f.send(2, { retry: true });
  const retry = f.watch();
  const retryNonce = retry.load();
  retry.notify({ type: "ready", path: "/github/demo/hypothesis-orders-lab/", nonce: retryNonce, editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" });
  f.phase(2, "failed");
  expect(f.overlay().inert).toBe(true);
});
