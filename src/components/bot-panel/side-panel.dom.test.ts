// @vitest-environment happy-dom
// A side panel's way out: the real panel goes at once (focus and keys with it), and an inert copy slides out after it.
import { createElement, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { leaveSidePanel, sidePanelCls, useSidePanelLeave } from "./side-panel";

let row: HTMLDivElement;
let finish: () => void;
const animate = vi.fn(() => ({ finished: new Promise<void>((resolve) => { finish = resolve; }) }));

function panel(): HTMLElement {
  const aside = document.createElement("aside");
  aside.id = "bot-panel";
  aside.setAttribute("role", "dialog");
  aside.tabIndex = -1;
  aside.innerHTML = '<h2 id="bot-settings-title">Scout</h2><button type="button">Close</button>'
    + '<svg><defs><linearGradient id="mascot-grad"></linearGradient></defs></svg><iframe src="about:blank"></iframe>';
  aside.getBoundingClientRect = () => ({ width: 320 }) as DOMRect;
  row.append(document.createElement("main"), aside);
  return aside;
}
const copies = () => row.querySelectorAll<HTMLElement>("[data-side-panel-leaving]");

beforeEach(() => {
  delete document.documentElement.dataset.reducedMotion;
  row = document.createElement("div");
  document.body.append(row);
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
  animate.mockClear();
});
afterEach(() => {
  row.remove();
  delete (HTMLElement.prototype as { animate?: unknown }).animate;
  vi.restoreAllMocks();
});

describe("closing a side panel beside the chat", () => {
  it("leaves an inert, unnamed, non-focusable copy that slides out over its width and then goes", async () => {
    const opener = document.createElement("button");
    row.append(opener);
    opener.focus();
    const aside = panel();
    aside.style.position = "static";
    leaveSidePanel(aside);
    aside.remove();
    await Promise.resolve();
    const [copy] = copies();
    expect(copy).toBeDefined();
    expect(copy!.getAttribute("aria-hidden")).toBe("true");
    expect(copy!.inert).toBe(true);
    expect(copy!.style.pointerEvents).toBe("none");
    expect(copy!.hasAttribute("role")).toBe(false);
    expect(copy!.hasAttribute("tabindex")).toBe(false);
    expect([...copy!.querySelectorAll("[id]")].map((node) => node.id)).toEqual(["mascot-grad"]);
    expect(copy!.querySelector("iframe")).toBeNull();
    expect(copy!.id).toBe("");
    copy!.querySelector("button")?.focus();
    expect(document.activeElement).not.toBe(copy!.querySelector("button"));
    expect(animate).toHaveBeenCalledWith(
      [{ marginInlineEnd: "0px", opacity: 1 }, { marginInlineEnd: "-320px", opacity: 0 }],
      expect.objectContaining({ duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }),
    );
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(copies()).toHaveLength(0);
  });

  it("leaves nothing with reduced motion (attribute or OS preference), or when another bot's panel takes its place", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    const first = panel();
    first.style.position = "static";
    leaveSidePanel(first);
    first.remove();
    await Promise.resolve();
    expect(copies()).toHaveLength(0);

    delete document.documentElement.dataset.reducedMotion;
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
    } as MediaQueryList));
    const mediaReduced = panel();
    mediaReduced.style.position = "static";
    leaveSidePanel(mediaReduced);
    mediaReduced.remove();
    await Promise.resolve();
    expect(copies()).toHaveLength(0);
    matchMedia.mockRestore();

    const second = panel();
    second.style.position = "static";
    leaveSidePanel(second);
    second.remove();
    row.append(document.createElement("aside"));
    await Promise.resolve();
    expect(copies()).toHaveLength(0);
    expect(animate).not.toHaveBeenCalled();
  });

  it("leaves nothing for a floating overlay or narrow mobile sheet viewport", async () => {
    for (const position of ["absolute", "fixed"]) {
      const floating = panel();
      floating.style.position = position;
      leaveSidePanel(floating);
      floating.remove();
      await Promise.resolve();
      expect(copies()).toHaveLength(0);
    }
    expect(animate).not.toHaveBeenCalled();
  });

  it("gives the room at once to a panel that arrives while the copy is still sliding out", async () => {
    const aside = panel();
    aside.style.position = "static";
    leaveSidePanel(aside);
    aside.remove();
    await Promise.resolve();
    expect(copies()).toHaveLength(1);
    row.append(document.createElement("aside"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copies()).toHaveLength(0);
  });

  it("preserves focus return on unmount while leaving an inert copy that cleans up when finished", async () => {
    const opener = document.createElement("button");
    row.append(opener);
    opener.focus();

    function Panel() {
      const ref = useRef<HTMLElement | null>(null);
      useSidePanelLeave(ref);
      useEffect(() => {
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        ref.current?.focus();
        return () => { previous?.focus(); };
      }, []);
      return createElement("aside", { ref, tabIndex: -1, role: "dialog", style: { position: "static" } },
        createElement("button", { type: "button" }, "Close"));
    }

    const mountPoint = document.createElement("div");
    mountPoint.style.display = "contents";
    row.append(mountPoint);
    const root = createRoot(mountPoint);
    flushSync(() => root.render(createElement(Panel)));
    const aside = mountPoint.querySelector("aside")!;
    aside.getBoundingClientRect = () => ({ width: 320 }) as DOMRect;
    expect(document.activeElement).toBe(aside);

    flushSync(() => root.render(null));
    await Promise.resolve();
    expect(document.activeElement).toBe(opener);
    const [copy] = copies();
    expect(copy).toBeDefined();
    expect(copy!.inert).toBe(true);
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(copies()).toHaveLength(0);
    flushSync(() => root.unmount());
  });
});

describe("the panel's way in", () => {
  it("slides in as a sheet below md and at its full width from md up, keeping panel widths and reduced-motion rules", () => {
    for (const overlay of [false, true]) {
      const cls = sidePanelCls(overlay, true);
      expect(cls).toContain("animate-sheet-in");
      expect(cls).toContain("md:animate-panel-beside-in");
      expect(cls).toContain("md:w-(--side-panel-w)");
      expect(cls).toContain("[--side-panel-w:320px]");
      expect(cls).toContain("motion-reduce:animate-none");
    }
    expect(sidePanelCls(true, true)).toContain("md:inset-auto");
    expect(sidePanelCls(false, true)).toContain("md:static");
    expect(sidePanelCls(false, false)).toContain("[--side-panel-w:min(420px,42vw)]");
  });
});
