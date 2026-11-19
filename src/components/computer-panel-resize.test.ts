// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_MIN_WIDTH, PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH, computerPanelMaxWidth, useComputerPanelResize } from "./computer-panel-resize";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let width = 0;

function Panel() {
  const { panelWidth, separatorRef, onSeparatorKeyDown } = useComputerPanelResize();
  width = panelWidth;
  return createElement("aside", null, createElement("div", { ref: separatorRef, role: "separator", tabIndex: 0, onKeyDown: onSeparatorKeyDown }));
}

const press = (key: string) => act(() => {
  host.querySelector("[role=separator]")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
});

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  vi.stubGlobal("innerWidth", 2560);
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("the computer panel's resize edge", () => {
  it("opens at the unchanged default despite an older narrow width and reaches the new maximum", () => {
    localStorage.setItem("omb-computer-panel-width", "400");
    act(() => root.render(createElement(Panel)));
    expect(width).toBe(PANEL_DEFAULT_WIDTH);
    for (let step = PANEL_DEFAULT_WIDTH; step < PANEL_MAX_WIDTH; step += 40) press("ArrowLeft");
    expect(width).toBe(PANEL_MAX_WIDTH);
    press("ArrowRight");
    expect(width).toBe(PANEL_MAX_WIDTH - 40);
    press("ArrowLeft");
    expect(width).toBe(PANEL_MAX_WIDTH);
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(createElement(Panel)));
    expect(width).toBe(PANEL_DEFAULT_WIDTH);
    expect(localStorage.getItem("omb-computer-panel-width")).toBe("400");
  });

  it("opens at the same default with no saved width and keeps an inline chat edge", () => {
    act(() => root.render(createElement(Panel)));
    expect(width).toBe(PANEL_DEFAULT_WIDTH);
    expect(computerPanelMaxWidth(1536)).toBe(PANEL_DEFAULT_WIDTH);
    expect(computerPanelMaxWidth(1920)).toBe(1344);
    expect(computerPanelMaxWidth(2560)).toBe(PANEL_MAX_WIDTH);
    expect(computerPanelMaxWidth(320)).toBe(320);
  });

  it("uses the measured chat row to clamp a controlled panel and recover the original choice", async () => {
    let room = 1800;
    let measure: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(read: () => void) { measure = read; }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      const panel = this.tagName === "ASIDE" ? this : this.parentElement?.querySelector<HTMLElement>(":scope > aside");
      const size = Number.parseFloat(panel?.style.width ?? "") || 0;
      return this.tagName === "MAIN" ? Math.max(0, room - size) : size;
    });
    function Row() {
      const { panelWidth, separatorRef } = useComputerPanelResize({ defaultWidth: 1152, width: 1152 });
      width = panelWidth;
      return createElement("div", null, createElement("main"), createElement("aside", { style: { width: panelWidth } },
        createElement("div", { ref: separatorRef, role: "separator" })));
    }
    await act(async () => root.render(createElement(Row)));
    expect(width).toBe(1152);
    room = 1000;
    // The browser reports both the row change and the resulting panel size change.
    act(() => measure?.());
    act(() => measure?.());
    expect(width).toBe(1000 - CHAT_MIN_WIDTH);
    room = 1800;
    act(() => measure?.());
    expect(width).toBe(1152);
    vi.restoreAllMocks();
  });

  it("supports a 1152px default while preserving pointer and keyboard resize", () => {
    function ControlledPanel({ initialWidth }: { initialWidth: number }) {
      const { panelWidth, separatorRef, onSeparatorKeyDown } = useComputerPanelResize({ defaultWidth: initialWidth });
      width = panelWidth;
      return createElement("aside", null, createElement("div", { ref: separatorRef, role: "separator", tabIndex: 0, onKeyDown: onSeparatorKeyDown }));
    }
    act(() => root.render(createElement(ControlledPanel, { initialWidth: 1152 })));
    expect(width).toBe(1152);
    press("ArrowLeft");
    expect(width).toBe(1192);
    press("ArrowRight");
    expect(width).toBe(1152);
  });
});
