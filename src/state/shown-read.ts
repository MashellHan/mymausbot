import { botShowsUnread } from "@/lib/bot-unread";
import type { AppState, BotAnnouncement, Group } from "./store";

export function markShownBotRead(
  state: AppState,
  bot: BotAnnouncement,
  readsInFlight: Map<string, { covers: number; again: boolean }>,
  sendRead: (botId: string, threadId: string | undefined, key: string, covers: number) => void,
): void {
  const selected = state.bots.find((candidate) => candidate.id === bot.id);
  const shown = selected?.switchingTo ?? selected?.threadId;
  const panel = state.forkPanel;
  if (bot.id !== state.selectedId || state.activeView !== "chat" || !document.hasFocus()) return;
  const visible = [...new Set([shown, panel?.kind === "bot" && panel.ownerId === bot.id ? panel.threadId : undefined])]
    .filter((threadId): threadId is string => Boolean(threadId));
  for (const threadId of visible) {
    const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (bot.tasks || !bot.unread)) continue;
    if (task) task.unread = false;
    const read = `${bot.id}:${threadId}`, newest = task?.updatedAt ?? 0, open = readsInFlight.get(read);
    if (!open) sendRead(bot.id, threadId, read, newest);
    else if (newest > open.covers) readsInFlight.set(read, { covers: newest, again: true });
  }
  bot.unread = botShowsUnread(bot);
}

export function markShownGroupRead(state: AppState, group: Partial<Group> & { id: string }): void {
  if (group.id !== state.selectedId || state.activeView !== "chat" || !document.hasFocus()) return;
  const shown = state.groups.find((candidate) => candidate.id === group.id)?.threadId;
  const panel = state.forkPanel;
  const visible = [...new Set([shown, panel?.kind === "group" && panel.ownerId === group.id ? panel.threadId : undefined])]
    .filter((threadId): threadId is string => Boolean(threadId));
  for (const threadId of visible) {
    const task = group.tasks?.find((candidate) => candidate.threadId === threadId);
    if (!task?.unread && (group.tasks || !group.unread)) continue;
    if (task) task.unread = false;
    fetch(`/api/groups/${group.id}/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) }).catch(() => {});
  }
  group.unread = group.tasks ? group.tasks.some((task) => task.unread) : false;
}
