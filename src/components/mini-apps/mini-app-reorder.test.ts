// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINI_APP_LONG_PRESS_MS,
  applyMiniAppOrder,
  miniAppDropTargetAtPoint,
  reorderMiniAppByOffset,
  reorderMiniAppIds,
  useMiniAppLongPressReorder,
} from "./mini-app-reorder";

describe("mini-app-reorder helpers", () => {
  it("reorders ids before or after a target and ignores no-op moves", () => {
    expect(reorderMiniAppIds(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(reorderMiniAppIds(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(reorderMiniAppIds(["a", "b", "c"], "a", "b", "before")).toBeNull();
    expect(reorderMiniAppIds(["a", "b", "c"], "a", "a", "before")).toBeNull();
    expect(reorderMiniAppIds(["a", "b", "c"], "x", "a", "before")).toBeNull();
  });

  it("reorders by keyboard offset and applies saved order stably", () => {
    expect(reorderMiniAppByOffset(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(reorderMiniAppByOffset(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(reorderMiniAppByOffset(["a", "b", "c"], "a", -1)).toBeNull();
    expect(reorderMiniAppByOffset(["a", "b", "c"], "c", 1)).toBeNull();
    expect(applyMiniAppOrder([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], ["c", "a"]).map((x) => x.id))
      .toEqual(["c", "a", "b", "d"]);
  });

  it("computes nearest horizontal drop target in LTR and RTL", () => {
    const items = [
      { id: "a", left: 0, right: 100 },
      { id: "b", left: 104, right: 204 },
      { id: "c", left: 208, right: 308 },
    ];
    expect(miniAppDropTargetAtPoint(120, "a", items, false)).toEqual({ id: "b", place: "before" });
    expect(miniAppDropTargetAtPoint(290, "a", items, false)).toEqual({ id: "c", place: "after" });
    expect(miniAppDropTargetAtPoint(120, "a", items, true)).toEqual({ id: "b", place: "after" });
  });
});

describe("useMiniAppLongPressReorder", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function Harness({ onReorder, onSelect }: { onReorder: (ids: string[]) => void; onSelect: (id: string) => void }) {
    const tabListRef = useRef<HTMLDivElement>(null);
    const ids = ["a", "b", "c"];
    const { draggingId, dropTarget, startPress, consumeSuppressedClick } = useMiniAppLongPressReorder({
      appIds: ids,
      enabled: true,
      tabListRef,
      onReorder,
    });
    return createElement(
      "div",
      { ref: tabListRef },
      ids.map((id, index) =>
        createElement(
          "div",
          {
            key: id,
            "data-mini-app-item": id,
            "data-dragging": draggingId === id ? "true" : "false",
            "data-drop": dropTarget?.id === id ? dropTarget.place : "",
            ref: (node: HTMLDivElement | null) => {
              if (!node) return;
              node.getBoundingClientRect = () => ({
                left: index * 100,
                right: index * 100 + 96,
                top: 0,
                bottom: 80,
                width: 96,
                height: 80,
                x: index * 100,
                y: 0,
                toJSON: () => ({}),
              });
            },
          },
          createElement("button", {
            type: "button",
            "data-btn": id,
            onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => startPress(id, event),
            onClick: () => { if (!consumeSuppressedClick()) onSelect(id); },
          }, id),
        ),
      ),
    );
  }

  it("activates drag after long press, commits reorder on release, and suppresses accidental click", () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    act(() => root.render(createElement(Harness, { onReorder, onSelect })));

    const btnC = container.querySelector<HTMLButtonElement>('[data-btn="c"]')!;
    act(() => {
      btnC.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientX: 240, clientY: 40 }));
    });
    expect(container.querySelector('[data-mini-app-item="c"]')?.getAttribute("data-dragging")).toBe("false");

    act(() => { vi.advanceTimersByTime(MINI_APP_LONG_PRESS_MS + 10); });
    expect(container.querySelector('[data-mini-app-item="c"]')?.getAttribute("data-dragging")).toBe("true");

    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 15, clientY: 40 }));
    });
    expect(container.querySelector('[data-mini-app-item="a"]')?.getAttribute("data-drop")).toBe("before");

    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 15, clientY: 40 }));
    });
    expect(onReorder).toHaveBeenCalledWith(["c", "a", "b"]);

    act(() => { btnC.click(); });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not trigger drag on a quick click or when moved before long-press threshold", () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    act(() => root.render(createElement(Harness, { onReorder, onSelect })));

    const btnB = container.querySelector<HTMLButtonElement>('[data-btn="b"]')!;
    act(() => {
      btnB.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2, clientX: 120, clientY: 40 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 120, clientY: 40 }));
      btnB.click();
    });
    expect(onReorder).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith("b");
  });
});
