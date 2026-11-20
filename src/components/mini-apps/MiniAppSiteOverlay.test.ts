// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { SiteFrame } from "../published-apps/SiteFrame";
import { MiniAppSiteOverlay } from "./MiniAppSiteOverlay";
import { createMiniAppSitePresentation, MOJO_POETRY_CAPABILITY, releaseUsesMojoPoetry, type MiniAppSiteView } from "./mini-app-site";
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
afterEach(() => { act(() => root.unmount()); host.remove(); frameBox.remove(); vi.unstubAllGlobals(); });

const message = (data: unknown, source = iframe.contentWindow!, origin = "null") =>
  new MessageEvent("message", { data, source: source as unknown as MessageEventSource, origin });

it("keeps the existing Mojo wrapper unless the verified release needs the exact Poetry capability", () => {
  expect(releaseUsesMojoPoetry(null)).toBe(false);
  expect(releaseUsesMojoPoetry({ packageId: "mashellhan.mojo", requires: [] })).toBe(false);
  expect(releaseUsesMojoPoetry({ packageId: "mashellhan.other", requires: [MOJO_POETRY_CAPABILITY] })).toBe(false);
  expect(releaseUsesMojoPoetry({ packageId: "mashellhan.mojo", requires: [MOJO_POETRY_CAPABILITY] })).toBe(true);
});

it("attaches just one fixed site lazily and clips it to the Mini frame while retaining view state on hide", () => {
  const ref = { current: frameBox };
  const render = (view: MiniAppSiteView) => root.render(createElement(MiniAppSiteOverlay, { frameBox: ref, view }));
  const onView = vi.fn(render);
  const site = createMiniAppSitePresentation({ isCurrent: () => true, onView });
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
  const site = createMiniAppSitePresentation({ isCurrent: () => current, onView });
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
  expect(onView).toHaveBeenCalledWith(viewport);
  current = false;
  expect(site.checkCurrent()).toBe(false);
  expect(onView).toHaveBeenLastCalledWith(undefined);
  current = true;
  site.receive(message(show), iframe, true);
  expect(onView).toHaveBeenCalledTimes(2);
  expect(posted).toHaveBeenLastCalledWith(expect.objectContaining({ error: "This site is unavailable." }), "*");
  expect(createMiniAppSitePresentation({ isCurrent: () => false, onView }).receive(message(show), iframe, true)).toBe(true);
  expect(onView).toHaveBeenCalledTimes(2);
});
