import { describe, expect, it } from "vitest";
import type { Bot } from "@/state/store";
import { selectQuickSwitchBots } from "./pwa-quick-bots";

function makeBot(id: string, name: string, overrides: Partial<Bot> = {}): Bot {
  return {
    id,
    name,
    threadId: `t-${id}`,
    messages: [],
    ...overrides,
  } as Bot;
}

describe("selectQuickSwitchBots", () => {
  it("returns empty array when fewer than 2 visible bots exist", () => {
    expect(
      selectQuickSwitchBots({
        bots: [makeBot("a", "Alpha"), makeBot("h", "Hidden", { hidden: true })],
        selectedBotId: "a",
      }),
    ).toEqual([]);
  });

  it("orders pinned -> waiting -> busy -> unread -> recency and excludes hidden bots", () => {
    const bots = [
      makeBot("recent", "Recent", { messages: [{ id: "m1", role: "bot", kind: "text", text: "hi", at: 900 } as Bot["messages"][number]] }),
      makeBot("unread", "Unread", { unread: true, messages: [{ id: "m2", role: "bot", kind: "text", text: "hi", at: 100 } as Bot["messages"][number]] }),
      makeBot("busy", "Busy", { busy: true }),
      makeBot("waiting", "Waiting", { activity: "waiting-on-you" }),
      makeBot("pinned", "Pinned"),
      makeBot("hidden", "Hidden", { hidden: true, busy: true }),
    ];
    const items = selectQuickSwitchBots({
      bots,
      selectedBotId: "recent",
      pinnedBotId: "pinned",
    });
    expect(items.map((item) => item.bot.id)).toEqual(["pinned", "waiting", "busy", "unread", "recent"]);
  });

  it("retains the currently selected bot inside the capped slice even if older than top-N", () => {
    const bots = Array.from({ length: 12 }, (_, idx) =>
      makeBot(`b-${idx}`, `Bot ${idx}`, {
        messages: [{ id: `m-${idx}`, role: "bot", kind: "text", text: "x", at: (idx + 1) * 100 } as Bot["messages"][number]],
      }),
    );
    const items = selectQuickSwitchBots({
      bots,
      selectedBotId: "b-0",
      maxItems: 5,
    });
    expect(items).toHaveLength(5);
    expect(items.some((item) => item.bot.id === "b-0" && item.selected)).toBe(true);
  });
});
