import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";

vi.mock("./Avatar", () => ({
  BotAvatar: ({ bot, size }: { bot: { name?: string }; size?: number }) =>
    createElement("span", { "data-mock-bot-avatar": bot.name ?? "", "data-size": String(size ?? "") }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => false }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("./unread-notice", () => ({
  useBotUnread: (bot: { id: string }) => ({ unread: bot.id === "bot-unread", noticing: false }),
}));

import { PhoneBotCardGrid } from "./PhoneBotCardGrid";
import type { BotRowProps } from "./Sidebar";

function makeBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Atlas",
    title: "Planner",
    color: "green",
    engine: "claude",
    model: "claude-sonnet-4-6",
    workspace: "/tmp/atlas",
    threadId: "t-1",
    activeLeafId: null,
    messages: [{ id: "m-1", role: "assistant", text: "Ready to ship", at: Date.now() } as Bot["messages"][number]],
    busy: false,
    ...overrides,
  } as Bot;
}

function makeRowProps(bot: Bot, extra: Partial<BotRowProps> = {}): BotRowProps {
  return {
    bot,
    selected: false,
    drafting: false,
    deleting: false,
    mascotMotion: null,
    reveal: null,
    pendingQueued: {},
    routineRuns: {},
    instances: [],
    liveCall: null,
    density: "comfortable",
    query: "",
    locale: "en",
    dispatch: vi.fn(),
    onMenu: vi.fn(),
    ...extra,
  };
}

beforeEach(() => setLocale("en"));

describe("PhoneBotCardGrid", () => {
  it("returns empty markup when there are no bots", () => {
    expect(renderToStaticMarkup(createElement(PhoneBotCardGrid, { bots: [], row: (bot) => makeRowProps(bot) }))).toBe("");
  });

  it("renders a 2-column card grid with 48px avatars, unread dot, working dot, and data-sidebar-bot-row", () => {
    const bots = [
      makeBot({ id: "bot-unread", name: "Nova", busy: false }),
      makeBot({ id: "bot-working", name: "Pulse", busy: true }),
    ];
    const html = renderToStaticMarkup(
      createElement(PhoneBotCardGrid, {
        bots,
        row: (bot) => makeRowProps(bot, { selected: bot.id === "bot-working" }),
      }),
    );

    expect(html).toContain('data-phone-bot-grid=""');
    expect(html).toContain("grid-cols-2");
    expect(html).toContain('data-sidebar-bot-row="bot-unread"');
    expect(html).toContain('data-sidebar-bot-row="bot-working"');
    expect(html).toContain('data-mock-bot-avatar="Nova" data-size="48"');
    expect(html).toContain('data-mock-bot-avatar="Pulse" data-size="48"');
    expect(html).toContain('data-testid="card-unread-dot"');
    expect(html).toContain("bg-accent");
    expect(html).toContain('data-testid="working-dot"');
    expect(html).toContain("Ready to ship");
    expect(html).toContain("Working");
    expect(html).toContain("bg-card");
    expect(html).toContain("border-hairline");
    expect(html).toContain("rounded-2xl");
    expect(html).toContain("active:scale-[0.98]");
  });

  it("renders a waiting badge when a bot is waiting for approval", () => {
    const waitingBot = makeBot({
      id: "bot-waiting",
      name: "Guard",
      activity: "waiting-on-you",
    });
    const html = renderToStaticMarkup(
      createElement(PhoneBotCardGrid, { bots: [waitingBot], row: (bot) => makeRowProps(bot) }),
    );
    expect(html).toContain('data-testid="waiting-dot"');
    expect(html).toContain("Waiting for you…");
  });
});
