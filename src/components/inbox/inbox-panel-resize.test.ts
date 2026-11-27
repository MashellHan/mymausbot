// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INBOX_DEFAULT_WIDTH, INBOX_MAX_WIDTH, INBOX_MIN_WIDTH, INBOX_WIDE_WIDTH, clampInboxPanelWidth, inboxPanelMaxWidth, useSidePanelResize } from "./inbox-panel-resize";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let latestWidth = 0;
let wideState = false;

function ResizablePanel({ storageKey = "test-inbox-width", defaultWidth = INBOX_DEFAULT_WIDTH }: { storageKey?: string; defaultWidth?: number }) {
  const { panelWidth, separatorRef, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd, onDoubleClick, resetToPreset } = useSidePanelResize({
    defaultWidth,
    wideWidth: INBOX_WIDE_WIDTH,
    wide: wideState,
    onWideChange: (next) => { wideState = next; },
    storageKey,
  });
  latestWidth = panelWidth;
  return createElement(
    "aside",
    { style: { width: panelWidth } },
    createElement("div", {
      ref: separatorRef,
      role: "separator",
      tabIndex: 0,
      onKeyDown: onSeparatorKeyDown,
      onPointerDown: onResizeStart,
      onPointerMove: onResizeMove,
      onPointerUp: onResizeEnd,
      onDoubleClick,
    }),
    createElement("button", { type: "button", "data-toggle-wide": "", onClick: () => resetToPreset(!wideState) }, "Toggle"),
  );
}

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  wideState = false;
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("side panel drag and keyboard resize", () => {
  it("clamps width between minimum and viewport-bounded maximum", () => {
    expect(inboxPanelMaxWidth(1440)).toBe(INBOX_MAX_WIDTH);
    expect(inboxPanelMaxWidth(800)).toBe(480);
    expect(clampInboxPanelWidth(100, 1440)).toBe(INBOX_MIN_WIDTH);
    expect(clampInboxPanelWidth(1200, 1440)).toBe(INBOX_MAX_WIDTH);
  });

  it("resizes with keyboard arrows, persists width, and resets on double-click or preset toggle", () => {
    act(() => root.render(createElement(ResizablePanel)));
    expect(latestWidth).toBe(INBOX_DEFAULT_WIDTH);

    const sep = () => host.querySelector<HTMLElement>("[role=separator]")!;
    act(() => sep().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(latestWidth).toBe(INBOX_DEFAULT_WIDTH + 32);
    expect(stored.get("test-inbox-width")).toBe(String(INBOX_DEFAULT_WIDTH + 32));

    act(() => sep().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(latestWidth).toBe(INBOX_DEFAULT_WIDTH);

    // Dragging past the wide midpoint marks wide = true and persists across remount.
    for (let i = 0; i < 8; i++) {
      act(() => sep().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    }
    expect(latestWidth).toBe(INBOX_DEFAULT_WIDTH + 256);
    expect(wideState).toBe(true);

    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(createElement(ResizablePanel)));
    expect(latestWidth).toBe(INBOX_DEFAULT_WIDTH + 256);

    // Double-clicking separator resets back to default and clears stored custom width.
    act(() => sep().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(latestWidth).toBe(INBOX_DEFAULT_WIDTH);
    expect(stored.has("test-inbox-width")).toBe(false);
    expect(wideState).toBe(false);
  });
});
