// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MobileSwipeReadRow,
  resolveSwipeRowRelease,
  toggleBotUnread,
  toggleGroupUnread,
} from "./MobileSwipeReadRow";

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

describe("resolveSwipeRowRelease", () => {
  it("triggers on full distance or fast medium swipe", () => {
    expect(resolveSwipeRowRelease(78, 0)).toBe("trigger");
    expect(resolveSwipeRowRelease(96, 0.1)).toBe("trigger");
    expect(resolveSwipeRowRelease(44, 0.45)).toBe("trigger");
    expect(resolveSwipeRowRelease(43, 0.9)).toBe("open");
    expect(resolveSwipeRowRelease(77, 0.44)).toBe("open");
  });

  it("opens between 40 and 77 without flick velocity, and closes below 40", () => {
    expect(resolveSwipeRowRelease(40, 0.1)).toBe("open");
    expect(resolveSwipeRowRelease(60, 0.2)).toBe("open");
    expect(resolveSwipeRowRelease(39, 0.8)).toBe("close");
    expect(resolveSwipeRowRelease(0, 0)).toBe("close");
  });
});

describe("toggleBotUnread", () => {
  it("dispatches markUnread when bot is currently read", async () => {
    const dispatch = vi.fn();
    const request = vi.fn();
    await toggleBotUnread({ id: "b1", threadId: "t1", unread: false }, false, dispatch, request);
    expect(dispatch).toHaveBeenCalledWith({ type: "markUnread", botId: "b1" });
    expect(request).not.toHaveBeenCalled();
  });

  it("marks unread bot threads read and dispatches botPatched", async () => {
    const dispatch = vi.fn();
    const patched = { id: "b1", unread: false };
    const request = vi.fn().mockResolvedValue({ bot: patched });
    await toggleBotUnread(
      {
        id: "b1",
        threadId: "t1",
        unread: true,
        tasks: [
          { threadId: "t1", title: "One", unread: true } as never,
          { threadId: "t2", title: "Two", unread: false } as never,
          { threadId: "t3", title: "Three", unread: true } as never,
        ],
      },
      true,
      dispatch,
      request,
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "/api/bots/b1/read", {
      method: "POST",
      body: JSON.stringify({ threadId: "t1" }),
    });
    expect(request).toHaveBeenNthCalledWith(2, "/api/bots/b1/read", {
      method: "POST",
      body: JSON.stringify({ threadId: "t3" }),
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "botPatched", bot: patched });
  });

  it("swallows request errors cleanly", async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      toggleBotUnread({ id: "b1", threadId: "t1", unread: true }, true, dispatch, request),
    ).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("toggleGroupUnread", () => {
  it("patches unread:true when group is currently read", async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue({ group: { id: "g1", unread: true } });
    await toggleGroupUnread({ id: "g1", threadId: "gt1", unread: false }, false, dispatch, request);
    expect(request).toHaveBeenCalledWith("/api/groups/g1", {
      method: "PATCH",
      body: JSON.stringify({ unread: true }),
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "groupPatched", group: { id: "g1", unread: true } });
  });

  it("marks unread group threads read and dispatches groupPatched", async () => {
    const dispatch = vi.fn();
    const request = vi.fn().mockResolvedValue({ group: { id: "g1", unread: false } });
    await toggleGroupUnread(
      {
        id: "g1",
        threadId: "gt1",
        unread: true,
        tasks: [
          { threadId: "gt1", title: "Main", unread: true } as never,
          { threadId: "gt2", title: "Side", unread: false } as never,
        ],
      },
      true,
      dispatch,
      request,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/groups/g1/read", {
      method: "POST",
      body: JSON.stringify({ threadId: "gt1" }),
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "groupPatched", group: { id: "g1", unread: false } });
  });

  it("falls back to group.threadId when tasks is omitted and swallows errors", async () => {
    const dispatch = vi.fn();
    const okRequest = vi.fn().mockResolvedValue({ group: { id: "g2", unread: false } });
    await toggleGroupUnread({ id: "g2", threadId: "gt-main", unread: true }, true, dispatch, okRequest);
    expect(okRequest).toHaveBeenCalledWith("/api/groups/g2/read", {
      method: "POST",
      body: JSON.stringify({ threadId: "gt-main" }),
    });

    const failingRequest = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(
      toggleGroupUnread({ id: "g2", threadId: "gt-main", unread: true }, true, dispatch, failingRequest),
    ).resolves.toBeUndefined();
  });
});

describe("MobileSwipeReadRow", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

  async function renderRow(props: {
    enabled: boolean;
    unread: boolean;
    onToggleUnread?: () => void;
    onOpenChat?: () => void;
  }) {
    const onToggleUnread = props.onToggleUnread ?? vi.fn<() => void>();
    const onOpenChat = props.onOpenChat ?? vi.fn<() => void>();
    await act(async () => {
      root.render(
        h(MobileSwipeReadRow, {
          enabled: props.enabled,
          unread: props.unread,
          onToggleUnread,
          children: h("button", { type: "button", "data-chat-btn": "", onClick: onOpenChat }, "Maus"),
        }),
      );
    });
    return { onToggleUnread, onOpenChat };
  }

  it("renders children unwrapped when disabled", async () => {
    await renderRow({ enabled: false, unread: false });
    expect(container.querySelector("[data-swipe-row]")).toBeNull();
    expect(container.querySelector("[data-swipe-action]")).toBeNull();
    expect(container.querySelector("[data-chat-btn]")?.textContent).toBe("Maus");
  });

  it("shows Mark as read when unread and Mark as unread when read", async () => {
    await renderRow({ enabled: true, unread: true });
    expect(container.querySelector("[data-swipe-action]")?.textContent).toContain("Mark as read");

    await renderRow({ enabled: true, unread: false });
    expect(container.querySelector("[data-swipe-action]")?.textContent).toContain("Mark as unread");
  });

  it("yields to vertical scroll and left swipe without activating swipe row", async () => {
    const { onToggleUnread } = await renderRow({ enabled: true, unread: true });
    const row = container.querySelector<HTMLElement>("[data-swipe-row]")!;
    const btn = container.querySelector<HTMLElement>("[data-chat-btn]")!;

    await act(async () => {
      dispatchTouch(btn, "touchstart", [{ identifier: 1, clientX: 40, clientY: 100 }]);
      dispatchTouch(btn, "touchmove", [{ identifier: 1, clientX: 46, clientY: 120 }]);
      dispatchTouch(btn, "touchmove", [{ identifier: 1, clientX: 160, clientY: 122 }]);
      dispatchTouch(btn, "touchend", [], [{ identifier: 1, clientX: 160, clientY: 122 }]);
    });
    expect(row.hasAttribute("data-swipe-row-open")).toBe(false);
    expect(row.hasAttribute("data-swipe-row-dragging")).toBe(false);
    expect(onToggleUnread).not.toHaveBeenCalled();

    const parentMoves = vi.fn();
    container.addEventListener("touchmove", parentMoves);
    await act(async () => {
      dispatchTouch(btn, "touchstart", [{ identifier: 2, clientX: 200, clientY: 100 }]);
      dispatchTouch(btn, "touchmove", [{ identifier: 2, clientX: 140, clientY: 102 }]);
      dispatchTouch(btn, "touchend", [], [{ identifier: 2, clientX: 140, clientY: 102 }]);
    });
    expect(parentMoves).toHaveBeenCalled();
    expect(row.hasAttribute("data-swipe-row-open")).toBe(false);
  });

  it("reveals on short swipe, suppresses row click to close, and triggers on action tap", async () => {
    const { onToggleUnread, onOpenChat } = await renderRow({ enabled: true, unread: true });
    const row = container.querySelector<HTMLElement>("[data-swipe-row]")!;
    const btn = container.querySelector<HTMLElement>("[data-chat-btn]")!;
    const actionBtn = container.querySelector<HTMLButtonElement>("[data-swipe-action]")!;

    await act(async () => {
      dispatchTouch(btn, "touchstart", [{ identifier: 1, clientX: 20, clientY: 100 }]);
      vi.advanceTimersByTime(300);
      dispatchTouch(btn, "touchmove", [{ identifier: 1, clientX: 76, clientY: 102 }]);
    });
    expect(row.hasAttribute("data-swipe-row-dragging")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(20);
      dispatchTouch(btn, "touchend", [], [{ identifier: 1, clientX: 76, clientY: 102 }]);
    });
    expect(row.hasAttribute("data-swipe-row-dragging")).toBe(false);
    expect(row.hasAttribute("data-swipe-row-open")).toBe(true);
    expect(onToggleUnread).not.toHaveBeenCalled();

    // Wait past click suppression window; tapping the revealed row should close it instead of opening chat.
    await act(async () => {
      vi.advanceTimersByTime(400);
      btn.click();
    });
    expect(onOpenChat).not.toHaveBeenCalled();
    expect(row.hasAttribute("data-swipe-row-open")).toBe(false);

    // Reveal again and tap the action button directly.
    await act(async () => {
      dispatchTouch(btn, "touchstart", [{ identifier: 2, clientX: 20, clientY: 100 }]);
      vi.advanceTimersByTime(300);
      dispatchTouch(btn, "touchmove", [{ identifier: 2, clientX: 72, clientY: 101 }]);
      vi.advanceTimersByTime(20);
      dispatchTouch(btn, "touchend", [], [{ identifier: 2, clientX: 72, clientY: 101 }]);
    });
    expect(row.hasAttribute("data-swipe-row-open")).toBe(true);

    await act(async () => {
      actionBtn.click();
    });
    expect(onToggleUnread).toHaveBeenCalledTimes(1);
    expect(onOpenChat).not.toHaveBeenCalled();
    expect(row.hasAttribute("data-swipe-row-open")).toBe(false);
  });

  it("caps rubber-band offset at 124px, auto-triggers on full swipe, and suppresses follow-up click", async () => {
    const { onToggleUnread, onOpenChat } = await renderRow({ enabled: true, unread: false });
    const row = container.querySelector<HTMLElement>("[data-swipe-row]")!;
    const btn = container.querySelector<HTMLElement>("[data-chat-btn]")!;

    await act(async () => {
      dispatchTouch(btn, "touchstart", [{ identifier: 1, clientX: 10, clientY: 100 }]);
      vi.advanceTimersByTime(200);
      dispatchTouch(btn, "touchmove", [{ identifier: 1, clientX: 260, clientY: 100 }]);
    });
    const foreground = btn.parentElement!;
    expect(foreground.style.transform).toBe("translate3d(124px, 0, 0)");

    await act(async () => {
      vi.advanceTimersByTime(20);
      dispatchTouch(btn, "touchend", [], [{ identifier: 1, clientX: 260, clientY: 100 }]);
    });
    expect(onToggleUnread).toHaveBeenCalledTimes(1);
    expect(row.hasAttribute("data-swipe-row-open")).toBe(false);

    // Immediate synthetic click right after swipe release must be suppressed.
    await act(async () => {
      btn.click();
    });
    expect(onOpenChat).not.toHaveBeenCalled();

    // After suppression expires, normal tap opens chat.
    await act(async () => {
      vi.advanceTimersByTime(400);
      btn.click();
    });
    expect(onOpenChat).toHaveBeenCalledTimes(1);
  });

  it("closes a revealed row on left swipe", async () => {
    await renderRow({ enabled: true, unread: true });
    const row = container.querySelector<HTMLElement>("[data-swipe-row]")!;
    const btn = container.querySelector<HTMLElement>("[data-chat-btn]")!;

    await act(async () => {
      dispatchTouch(btn, "touchstart", [{ identifier: 1, clientX: 20, clientY: 100 }]);
      vi.advanceTimersByTime(300);
      dispatchTouch(btn, "touchmove", [{ identifier: 1, clientX: 72, clientY: 100 }]);
      dispatchTouch(btn, "touchend", [], [{ identifier: 1, clientX: 72, clientY: 100 }]);
    });
    expect(row.hasAttribute("data-swipe-row-open")).toBe(true);

    await act(async () => {
      dispatchTouch(btn, "touchstart", [{ identifier: 2, clientX: 150, clientY: 100 }]);
      vi.advanceTimersByTime(60);
      dispatchTouch(btn, "touchmove", [{ identifier: 2, clientX: 90, clientY: 100 }]);
      dispatchTouch(btn, "touchend", [], [{ identifier: 2, clientX: 90, clientY: 100 }]);
    });
    expect(row.hasAttribute("data-swipe-row-open")).toBe(false);
  });
});
