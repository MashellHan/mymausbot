import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group } from "@/state/store";
import {
  computeSnapshotDigest,
  createPwaSnapshotScheduler,
  SNAPSHOT_IDLE_DEBOUNCE_MS,
  SNAPSHOT_SETTLE_FLUSH_MS,
  SNAPSHOT_STREAM_CHECKPOINT_MS,
} from "./pwa-snapshot-scheduler";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Maus",
    threadId: "t-1",
    messages: [{ id: "m-1", role: "bot", kind: "text", text: "Hello", at: 1 }],
    busy: false,
    ...overrides,
  } as Bot;
}

describe("pwa-snapshot-scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores transient UI changes and optimistic messages in the structural digest", () => {
    const baseBot = makeBot();
    const d1 = computeSnapshotDigest({ selectedId: "bot-1", bots: [baseBot], groups: [], sections: ["A"] });
    const d2 = computeSnapshotDigest({
      selectedId: "bot-1",
      bots: [
        makeBot({
          messages: [
            ...baseBot.messages,
            { id: "optimistic-1", role: "user", kind: "text", text: "Queued", at: 2 } as Bot["messages"][number],
          ],
        }),
      ],
      groups: [],
      sections: ["A"],
    });
    expect(d1).toBe(d2);
  });

  it("suppresses per-token IDB writes during a 10s stream and flushes promptly on settle", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = createPwaSnapshotScheduler({ persist, now: () => Date.now() });

    // First live snapshot commits immediately
    scheduler.notify({ selectedId: "bot-1", bots: [makeBot()], groups: [], sections: [], config: null });
    expect(persist).toHaveBeenCalledTimes(1);

    // 100 streaming token updates over 10 seconds (< 12s checkpoint)
    let text = "Hello";
    for (let i = 0; i < 100; i += 1) {
      vi.advanceTimersByTime(100);
      text += "x";
      scheduler.notify({
        selectedId: "bot-1",
        bots: [makeBot({ busy: true, messages: [{ id: "m-2", role: "bot", kind: "text", text, at: 2 } as Bot["messages"][number]] })],
        groups: [],
        sections: [],
        config: null,
      });
    }
    expect(persist).toHaveBeenCalledTimes(1);

    // Turn settles -> flushes within SNAPSHOT_SETTLE_FLUSH_MS
    scheduler.notify({
      selectedId: "bot-1",
      bots: [makeBot({ busy: false, messages: [{ id: "m-2", role: "bot", kind: "text", text, at: 2 } as Bot["messages"][number]] })],
      groups: [],
      sections: [],
      config: null,
    });
    vi.advanceTimersByTime(SNAPSHOT_SETTLE_FLUSH_MS);
    expect(persist).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("writes periodic 12s safety checkpoints during a long 25s stream plus final settle write", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = createPwaSnapshotScheduler({ persist, now: () => Date.now() });

    scheduler.notify({ selectedId: "bot-1", bots: [makeBot()], groups: [], sections: [], config: null });
    expect(persist).toHaveBeenCalledTimes(1);

    for (let sec = 1; sec <= 25; sec += 1) {
      vi.advanceTimersByTime(1_000);
      scheduler.notify({
        selectedId: "bot-1",
        bots: [
          makeBot({
            busy: true,
            messages: [{ id: "m-stream", role: "bot", kind: "text", text: "a".repeat(sec * 10), at: sec } as Bot["messages"][number]],
          }),
        ],
        groups: [],
        sections: [],
        config: null,
      });
    }
    // Initial write + t=12s checkpoint + t=24s checkpoint
    expect(persist).toHaveBeenCalledTimes(3);

    // Settle at t=25s
    scheduler.notify({
      selectedId: "bot-1",
      bots: [
        makeBot({
          busy: false,
          messages: [{ id: "m-stream", role: "bot", kind: "text", text: "a".repeat(260), at: 26 } as Bot["messages"][number]],
        }),
      ],
      groups: [],
      sections: [],
      config: null,
    });
    vi.advanceTimersByTime(SNAPSHOT_SETTLE_FLUSH_MS);
    expect(persist).toHaveBeenCalledTimes(4);
    scheduler.dispose();
  });

  it("flushes immediately on flushNow() (e.g. visibilitychange hidden / pagehide) and debounces idle edits", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = createPwaSnapshotScheduler({ persist, now: () => Date.now() });

    scheduler.notify({ selectedId: "bot-1", bots: [makeBot()], groups: [] as Group[], sections: [], config: null });
    expect(persist).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    scheduler.notify({
      selectedId: "bot-1",
      bots: [makeBot({ busy: true, messages: [{ id: "m-3", role: "bot", kind: "text", text: "partial", at: 3 } as Bot["messages"][number]] })],
      groups: [],
      sections: [],
      config: null,
    });
    expect(persist).toHaveBeenCalledTimes(1);

    scheduler.flushNow();
    expect(persist).toHaveBeenCalledTimes(2);
    // Repeated flushNow on clean state is a no-op
    scheduler.flushNow();
    expect(persist).toHaveBeenCalledTimes(2);

    // Settle first, then an idle edit debounces at SNAPSHOT_IDLE_DEBOUNCE_MS
    scheduler.notify({
      selectedId: "bot-1",
      bots: [makeBot({ busy: false, messages: [{ id: "m-3", role: "bot", kind: "text", text: "partial", at: 3 } as Bot["messages"][number]] })],
      groups: [],
      sections: [],
      config: null,
    });
    scheduler.notify({
      selectedId: "bot-1",
      bots: [makeBot({ busy: false, name: "Maus 2" })],
      groups: [],
      sections: [],
      config: null,
    });
    vi.advanceTimersByTime(SNAPSHOT_IDLE_DEBOUNCE_MS - 50);
    expect(persist).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(50);
    expect(persist).toHaveBeenCalledTimes(3);
    expect(SNAPSHOT_STREAM_CHECKPOINT_MS).toBe(12_000);
    scheduler.dispose();
  });
});
