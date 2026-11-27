// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideDrawerSwipeAction,
  shouldIgnoreDrawerSwipeTarget,
  useMobileDrawerSwipe,
  type MobileDrawerSwipeResult,
} from "./use-mobile-drawer-swipe";

function makeTouchList(points: Array<{ identifier?: number; clientX: number; clientY: number }>) {
  const list = points.map((p, i) => ({
    identifier: p.identifier ?? i,
    clientX: p.clientX,
    clientY: p.clientY,
  }));
  return Object.assign(list, { item: (index: number) => list[index] ?? null });
}

function dispatchTouch(
  target: EventTarget,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  touches: Array<{ identifier?: number; clientX: number; clientY: number }>,
  changedTouches = touches,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: makeTouchList(touches) });
  Object.defineProperty(event, "changedTouches", { value: makeTouchList(changedTouches) });
  target.dispatchEvent(event);
}

describe("decideDrawerSwipeAction", () => {
  it("opens from Chat on right swipe past distance or velocity threshold", () => {
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: 68, vx: 0.1 })).toBe("open");
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: 32, vx: 0.35 })).toBe("open");
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: 31, vx: 0.9 })).toBe("none");
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: 67, vx: 0.34 })).toBe("none");
  });

  it("opens from Chat on deliberate left swipe past distance or velocity threshold", () => {
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: -68, vx: -0.1 })).toBe("open");
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: -36, vx: -0.35 })).toBe("open");
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: -35, vx: -1.0 })).toBe("none");
    expect(decideDrawerSwipeAction({ drawerOpen: false, dx: -67, vx: -0.34 })).toBe("none");
  });

  it("closes List on left swipe and ignores right swipe", () => {
    expect(decideDrawerSwipeAction({ drawerOpen: true, dx: -68, vx: -0.1 })).toBe("close");
    expect(decideDrawerSwipeAction({ drawerOpen: true, dx: -32, vx: -0.35 })).toBe("close");
    expect(decideDrawerSwipeAction({ drawerOpen: true, dx: -31, vx: -0.9 })).toBe("none");
    expect(decideDrawerSwipeAction({ drawerOpen: true, dx: -67, vx: -0.34 })).toBe("none");
    expect(decideDrawerSwipeAction({ drawerOpen: true, dx: 120, vx: 1.2 })).toBe("none");
  });
});

describe("shouldIgnoreDrawerSwipeTarget", () => {
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it("ignores form controls, contenteditable, sliders, and swipe opt-out attributes", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const editableChild = document.createElement("span");
    editable.append(editableChild);

    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");

    const ignored = document.createElement("div");
    ignored.setAttribute("data-swipe-ignore", "");
    const ignoredChild = document.createElement("span");
    ignored.append(ignoredChild);

    const action = document.createElement("button");
    action.setAttribute("data-swipe-action", "read");

    const plain = document.createElement("div");
    host.append(input, textarea, select, editable, slider, ignored, action, plain);

    expect(shouldIgnoreDrawerSwipeTarget(input, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(textarea, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(select, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(editableChild, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(slider, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(ignoredChild, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(action, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(plain, host)).toBe(false);
  });

  it("ignores horizontally scrollable ancestors up to the container", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowX = "auto";
    Object.defineProperty(scroller, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 300, configurable: true });
    const inner = document.createElement("code");
    scroller.append(inner);

    const nonScroller = document.createElement("div");
    nonScroller.style.overflowX = "auto";
    Object.defineProperty(nonScroller, "scrollWidth", { value: 302, configurable: true });
    Object.defineProperty(nonScroller, "clientWidth", { value: 300, configurable: true });
    const innerNonScroll = document.createElement("span");
    nonScroller.append(innerNonScroll);

    const hiddenOverflow = document.createElement("div");
    hiddenOverflow.style.overflowX = "hidden";
    Object.defineProperty(hiddenOverflow, "scrollWidth", { value: 600, configurable: true });
    Object.defineProperty(hiddenOverflow, "clientWidth", { value: 300, configurable: true });

    host.append(scroller, nonScroller, hiddenOverflow);

    expect(shouldIgnoreDrawerSwipeTarget(inner, host)).toBe(true);
    expect(shouldIgnoreDrawerSwipeTarget(innerNonScroll, host)).toBe(false);
    expect(shouldIgnoreDrawerSwipeTarget(hiddenOverflow, host)).toBe(false);
  });

  it("ignores when text is currently selected", () => {
    const plain = document.createElement("div");
    host.append(plain);
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "selected text",
    } as Selection);
    expect(shouldIgnoreDrawerSwipeTarget(plain, host)).toBe(true);
  });
});

describe("useMobileDrawerSwipe", () => {
  let root: Root;
  let container: HTMLDivElement;
  let latest: MobileDrawerSwipeResult;
  let onOpen: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  interface HarnessProps {
    enabled: boolean;
    drawerOpen: boolean;
  }

  function Harness({ enabled, drawerOpen }: HarnessProps) {
    latest = useMobileDrawerSwipe({
      enabled,
      drawerOpen,
      onOpen,
      onClose,
    });
    return h(
      "div",
      { "data-swipe-root": "", ...latest.touchHandlers },
      h("div", { "data-chat": "" }),
      h("div", { "data-swipe-row-open": "" }, h("span", { "data-open-row-child": "" })),
      h("div", { "data-swipe-row-dragging": "" }, h("span", { "data-dragging-row-child": "" })),
    );
  }

  async function renderHarness(props: HarnessProps) {
    await act(async () => {
      root.render(h(Harness, props));
    });
    const swipeRoot = container.querySelector<HTMLElement>("[data-swipe-root]")!;
    Object.defineProperty(swipeRoot, "clientWidth", { value: 400, configurable: true });
    return swipeRoot;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onOpen = vi.fn();
    onClose = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tracks live dragProgress on right swipe in Chat and opens on release", async () => {
    const swipeRoot = await renderHarness({ enabled: true, drawerOpen: false });
    const chat = swipeRoot.querySelector("[data-chat]")!;

    await act(async () => {
      dispatchTouch(chat, "touchstart", [{ identifier: 1, clientX: 20, clientY: 200 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(latest.dragging).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(50);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 120, clientY: 204 }]);
    });
    expect(latest.dragProgress).toBeCloseTo(0.25, 5);
    expect(latest.dragging).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(50);
      dispatchTouch(chat, "touchend", [], [{ identifier: 1, clientX: 120, clientY: 204 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(latest.dragging).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens on deliberate left swipe in Chat without backwards visual dragProgress", async () => {
    const swipeRoot = await renderHarness({ enabled: true, drawerOpen: false });
    const chat = swipeRoot.querySelector("[data-chat]")!;

    await act(async () => {
      dispatchTouch(chat, "touchstart", [{ identifier: 1, clientX: 300, clientY: 200 }]);
      vi.advanceTimersByTime(60);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 210, clientY: 202 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(latest.dragging).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(40);
      dispatchTouch(chat, "touchend", [], [{ identifier: 1, clientX: 210, clientY: 202 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("tracks live dragProgress on left swipe in List and closes on release", async () => {
    const swipeRoot = await renderHarness({ enabled: true, drawerOpen: true });
    const chat = swipeRoot.querySelector("[data-chat]")!;

    await act(async () => {
      dispatchTouch(chat, "touchstart", [{ identifier: 1, clientX: 300, clientY: 200 }]);
      vi.advanceTimersByTime(80);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 200, clientY: 204 }]);
    });
    expect(latest.dragProgress).toBeCloseTo(0.75, 5);
    expect(latest.dragging).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(80);
      dispatchTouch(chat, "touchend", [], [{ identifier: 1, clientX: 200, clientY: 204 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(latest.dragging).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("aborts immediately on vertical scroll movement", async () => {
    const swipeRoot = await renderHarness({ enabled: true, drawerOpen: false });
    const chat = swipeRoot.querySelector("[data-chat]")!;

    await act(async () => {
      dispatchTouch(chat, "touchstart", [{ identifier: 1, clientX: 100, clientY: 100 }]);
      vi.advanceTimersByTime(20);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 106, clientY: 118 }]);
      vi.advanceTimersByTime(40);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 260, clientY: 120 }]);
      vi.advanceTimersByTime(20);
      dispatchTouch(chat, "touchend", [], [{ identifier: 1, clientX: 260, clientY: 120 }]);
    });

    expect(latest.dragProgress).toBeNull();
    expect(latest.dragging).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores right swipe and active swipe rows when drawerOpen is true", async () => {
    const swipeRoot = await renderHarness({ enabled: true, drawerOpen: true });
    const chat = swipeRoot.querySelector("[data-chat]")!;
    const openRowChild = swipeRoot.querySelector("[data-open-row-child]")!;
    const draggingRowChild = swipeRoot.querySelector("[data-dragging-row-child]")!;

    await act(async () => {
      dispatchTouch(chat, "touchstart", [{ identifier: 1, clientX: 40, clientY: 120 }]);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 180, clientY: 122 }]);
      dispatchTouch(chat, "touchend", [], [{ identifier: 1, clientX: 180, clientY: 122 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    for (const target of [openRowChild, draggingRowChild]) {
      await act(async () => {
        dispatchTouch(target, "touchstart", [{ identifier: 2, clientX: 300, clientY: 120 }]);
        dispatchTouch(target, "touchmove", [{ identifier: 2, clientX: 150, clientY: 122 }]);
        dispatchTouch(target, "touchend", [], [{ identifier: 2, clientX: 150, clientY: 122 }]);
      });
      expect(latest.dragProgress).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it("resets cleanly on touchcancel without firing open or close", async () => {
    const swipeRoot = await renderHarness({ enabled: true, drawerOpen: false });
    const chat = swipeRoot.querySelector("[data-chat]")!;

    await act(async () => {
      dispatchTouch(chat, "touchstart", [{ identifier: 1, clientX: 20, clientY: 200 }]);
      vi.advanceTimersByTime(40);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 180, clientY: 202 }]);
    });
    expect(latest.dragProgress).toBeCloseTo(0.4, 5);
    expect(latest.dragging).toBe(true);

    await act(async () => {
      dispatchTouch(chat, "touchcancel", [], [{ identifier: 1, clientX: 180, clientY: 202 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(latest.dragging).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", async () => {
    const swipeRoot = await renderHarness({ enabled: false, drawerOpen: false });
    const chat = swipeRoot.querySelector("[data-chat]")!;

    await act(async () => {
      dispatchTouch(chat, "touchstart", [{ identifier: 1, clientX: 20, clientY: 200 }]);
      dispatchTouch(chat, "touchmove", [{ identifier: 1, clientX: 200, clientY: 200 }]);
      dispatchTouch(chat, "touchend", [], [{ identifier: 1, clientX: 200, clientY: 200 }]);
    });
    expect(latest.dragProgress).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
