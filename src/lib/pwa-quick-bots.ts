import { botUnreadCount } from "@/lib/bot-unread";
import type { Bot } from "@/state/store";

export const MAX_QUICK_SWITCH_BOTS = 8;

export interface QuickSwitchBotItem {
  bot: Bot;
  pinned: boolean;
  waiting: boolean;
  busy: boolean;
  unread: boolean;
  selected: boolean;
  lastActivityAt: number;
}

function latestBotTimestamp(bot: Bot): number {
  const lastMsgAt = bot.messages.at(-1)?.at ?? 0;
  let maxTaskAt = 0;
  for (const task of bot.tasks ?? []) {
    const ts = task.updatedAt ?? task.createdAt ?? 0;
    if (ts > maxTaskAt) maxTaskAt = ts;
  }
  return Math.max(lastMsgAt, maxTaskAt, bot.turnStartedAt ?? 0);
}

function rankOf(item: Omit<QuickSwitchBotItem, "selected">): number {
  if (item.pinned) return 0;
  if (item.waiting) return 1;
  if (item.busy) return 2;
  if (item.unread) return 3;
  return 4;
}

/**
 * Selects up to `MAX_QUICK_SWITCH_BOTS` visible bots for the mobile quick-switcher strip:
 * pinned -> waiting-on-you -> busy -> unread -> most recent, always keeping the active bot visible.
 * Returns `[]` when the workspace has fewer than 2 visible bots so single-bot users see zero extra chrome.
 */
export function selectQuickSwitchBots(input: {
  bots: readonly Bot[];
  selectedBotId: string;
  pinnedBotId?: string;
  maxItems?: number;
}): QuickSwitchBotItem[] {
  const visible = input.bots.filter((bot) => !bot.hidden);
  if (visible.length < 2) return [];
  const limit = Math.max(2, input.maxItems ?? MAX_QUICK_SWITCH_BOTS);

  const items: QuickSwitchBotItem[] = visible.map((bot) => {
    const waiting =
      bot.activity === "waiting-on-you" ||
      Boolean(bot.tasks?.some((task) => task.activity === "waiting-on-you" && task.archivedAt === undefined));
    const busy =
      !waiting &&
      (Boolean(bot.busy) ||
        Boolean(bot.tasks?.some((task) => task.busy === true && task.archivedAt === undefined)));
    return {
      bot,
      pinned: Boolean(input.pinnedBotId && bot.id === input.pinnedBotId),
      waiting,
      busy,
      unread: botUnreadCount(bot) > 0,
      selected: bot.id === input.selectedBotId,
      lastActivityAt: latestBotTimestamp(bot),
    };
  });

  items.sort((a, b) => {
    const diff = rankOf(a) - rankOf(b);
    if (diff !== 0) return diff;
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
    return a.bot.name.localeCompare(b.bot.name);
  });

  const sliced = items.slice(0, limit);
  if (input.selectedBotId && !sliced.some((item) => item.selected)) {
    const active = items.find((item) => item.selected);
    if (active) {
      sliced[sliced.length - 1] = active;
    }
  }
  return sliced;
}
