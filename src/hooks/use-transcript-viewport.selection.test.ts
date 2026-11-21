// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  state: {
    focusMessage: null as null | { threadId: string; messageId: string; nonce: number; consumed: boolean },
    loadingOlder: {} as Record<string, true>,
  },
  dispatch: vi.fn(),
}));
vi.mock("@/state/store-select", async (importOriginal) => (await import("@/testing/plain-store-select")).plainStoreSelect(await importOriginal()));
vi.mock("@/state/store", () => ({ useStore: () => store }));
vi.mock("@/lib/focus-message", () => ({ useFocusMessage: () => {} }));

import { useTranscriptViewport } from "./use-transcript-viewport";
import { forgetTranscriptPositions } from "@/lib/transcript-follow";
import { TRANSCRIPT_WINDOW_MAX } from "@/lib/transcript-window";

type Row = { id: string; role?: "user" | "bot"; lines: [string, string] };
const makeRows = (count: number, prefix = "m"): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`,
    role: index % 2 === 0 ? "user" : "bot",
    lines: [`Line one of ${prefix}${index}`, `Line two of ${prefix}${index}`],
  }));

let viewport!: ReturnType<typeof useTranscriptViewport<Row>>;
function Harness({
  threadId = "thread-1",
  messages,
}: {
  threadId?: string;
  messages: readonly Row[];
}) {
  viewport = useTranscriptViewport({
    ownerId: "bot-1",
    threadId,
    messages,
    pinOn: [false],
  });
  return createElement(
    "div",
    {
      ref: viewport.scrollRef,
      ...viewport.scrollHandlers,
      style: { height: "400px", overflowY: "auto" },
    },
    createElement(
      "div",
      { ref: viewport.transcriptRef, role: "log" },
      viewport.windowedMessages.map((row) =>
        createElement(
          "div",
          { key: row.id, "data-mid": row.id, className: "contents" },
          createElement("p", null, row.lines[0]),
          createElement("p", null, row.lines[1]),
        ),
      ),
    ),
  ) as ReactNode;
}

let container: HTMLDivElement;
let root: Root;

function render(props: { threadId?: string; messages: readonly Row[] }) {
  flushSync(() => {
    root.render(createElement(Harness, props));
  });
}

function selectCrossLine(startId: string, endId: string) {
  const startRow = container.querySelector<HTMLElement>(`[data-mid="${startId}"]`)!;
  const endRow = container.querySelector<HTMLElement>(`[data-mid="${endId}"]`)!;
  const startNode = startRow.querySelectorAll("p")[0]!.firstChild!;
  const endNode = endRow.querySelectorAll("p")[1]!.firstChild!;
  const selection = document.getSelection()!;
  selection.setBaseAndExtent(startNode, 5, endNode, 8);
  return String(selection);
}

beforeEach(() => {
  forgetTranscriptPositions();
  store.state.focusMessage = null;
  store.state.loadingOlder = {};
  store.dispatch.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  flushSync(() => root.unmount());
  container.remove();
});

describe("useTranscriptViewport cross-line selection retention", () => {
  it("keeps cross-line saved text copyable after scrolling out of the original window", () => {
    const messages = makeRows(500);
    render({ messages });

    // Select across lines spanning saved messages near the bottom of the initial window (m380..m499).
    const expectedText = selectCrossLine("m480", "m482");
    expect(expectedText).toContain("one of m480");
    expect(expectedText).toContain("Line two");
    expect(expectedText).toContain("m482");

    // Step earlier twice: without selection hold, the 240-row window would become [140, 380) and unmount m480..m482.
    flushSync(() => viewport.showEarlier());
    flushSync(() => viewport.showEarlier());

    expect(viewport.hiddenCount).toBe(140);
    expect(container.querySelector('[data-mid="m480"]')).not.toBeNull();
    expect(container.querySelector('[data-mid="m482"]')).not.toBeNull();
    expect(String(document.getSelection())).toBe(expectedText);
  });

  it("releases held rows when selection is cleared and resumes bounded windowing", () => {
    const messages = makeRows(700);
    render({ messages });

    const expectedText = selectCrossLine("m680", "m682");
    flushSync(() => viewport.showEarlier());
    flushSync(() => viewport.showEarlier());
    expect(String(document.getSelection())).toBe(expectedText);
    expect(viewport.windowedMessages.length).toBeGreaterThan(TRANSCRIPT_WINDOW_MAX);

    // Clear the selection and take another scroll step: window should return to TRANSCRIPT_WINDOW_MAX.
    document.getSelection()!.removeAllRanges();
    flushSync(() => viewport.showEarlier());

    expect(viewport.windowedMessages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
    expect(container.querySelector('[data-mid="m680"]')).toBeNull();
  });

  it("sets selection aside past the hold cap and restores it on return, unless cleared or switched", () => {
    const messages = makeRows(1_200);
    render({ messages });

    const expectedText = selectCrossLine("m1180", "m1182");
    // Step far up past SELECTION_HOLD_MAX (480 rows).
    for (let step = 0; step < 6; step++) flushSync(() => viewport.showEarlier());

    expect(viewport.windowedMessages.length).toBeLessThanOrEqual(TRANSCRIPT_WINDOW_MAX);
    expect(document.getSelection()!.isCollapsed).toBe(true);

    // Scroll back down to the selected rows: selection comes back copyable.
    for (let step = 0; step < 6 && viewport.laterCount > 0; step++) flushSync(() => viewport.showLater());
    expect(String(document.getSelection())).toBe(expectedText);
  });

  it("does not leak set-aside or held selection across conversation switches", () => {
    const threadA = makeRows(1_200, "a");
    const threadB = makeRows(300, "b");
    render({ threadId: "thread-a", messages: threadA });

    selectCrossLine("a1180", "a1182");
    for (let step = 0; step < 6; step++) flushSync(() => viewport.showEarlier());
    expect(document.getSelection()!.isCollapsed).toBe(true);

    // Switch to thread B and back to thread A: set-aside selection was dropped by the switch.
    render({ threadId: "thread-b", messages: threadB });
    expect(document.getSelection()!.isCollapsed).toBe(true);
    render({ threadId: "thread-a", messages: threadA });
    expect(document.getSelection()!.isCollapsed).toBe(true);
  });

  it("drops a set-aside selection when the reader clicks elsewhere", () => {
    const messages = makeRows(1_200);
    render({ messages });

    selectCrossLine("m1180", "m1182");
    for (let step = 0; step < 6; step++) flushSync(() => viewport.showEarlier());
    expect(document.getSelection()!.isCollapsed).toBe(true);

    window.dispatchEvent(new Event("pointerdown"));
    for (let step = 0; step < 6 && viewport.laterCount > 0; step++) flushSync(() => viewport.showLater());
    expect(document.getSelection()!.isCollapsed).toBe(true);
  });

  it("holds the current window while dragging a selection past the hold cap, then releases on pointerup", () => {
    const messages = makeRows(1_200);
    render({ messages });

    const expectedText = selectCrossLine("m1180", "m1182");
    flushSync(() => {
      viewport.scrollHandlers.onPointerDown({
        button: 0,
        target: container.querySelector('[data-mid="m1180"]')!,
        nativeEvent: { offsetX: 10 },
      } as never);
    });
    for (let step = 0; step < 6; step++) flushSync(() => viewport.showEarlier());

    // While dragging, the window stays on the held rows instead of dropping the selection mid-drag.
    expect(String(document.getSelection())).toBe(expectedText);

    window.dispatchEvent(new Event("pointerup"));
    for (let step = 0; step < 6; step++) flushSync(() => viewport.showEarlier());
    expect(document.getSelection()!.isCollapsed).toBe(true);
  });

  it("keeps search focus working cleanly when a selection exists", () => {
    const messages = makeRows(1_200);
    render({ messages });

    const expectedText = selectCrossLine("m1180", "m1182");
    store.state.focusMessage = { threadId: "thread-1", messageId: "m200", nonce: 1, consumed: false };
    render({ messages });

    expect(container.querySelector('[data-mid="m200"]')).not.toBeNull();
    expect(document.getSelection()!.isCollapsed).toBe(true);

    // Jumping back to latest restores the set-aside selection once m1180..m1182 return.
    flushSync(() => viewport.jumpToLatest());
    expect(String(document.getSelection())).toBe(expectedText);
  });
});
