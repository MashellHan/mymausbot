import { afterEach, expect, it, vi } from "vitest";
import type { AppState, BotAnnouncement, Group } from "./store";
import { markShownBotRead, markShownGroupRead } from "./shown-read";

afterEach(() => vi.unstubAllGlobals());

it("reads only the shown bot conversation and its open fork", () => {
  vi.stubGlobal("document", { hasFocus: () => true });
  const bot = { id: "bot", unread: true, tasks: [
    { threadId: "main", unread: true, updatedAt: 1 },
    { threadId: "fork", unread: true, updatedAt: 2 },
    { threadId: "background", unread: true, updatedAt: 3 },
  ] } as BotAnnouncement;
  const state = { activeView: "chat", selectedId: "bot", bots: [{ id: "bot", threadId: "main" }],
    forkPanel: { kind: "bot", ownerId: "bot", threadId: "fork" } } as unknown as AppState;
  const sendRead = vi.fn();
  markShownBotRead(state, bot, new Map(), sendRead);
  expect(sendRead.mock.calls.map(([owner, thread]) => [owner, thread])).toEqual([["bot", "main"], ["bot", "fork"]]);
  expect(bot.tasks?.map((task) => task.unread)).toEqual([false, false, true]);
  expect(bot.unread).toBe(true);
});

it("reads only the shown room conversation and its open fork", () => {
  vi.stubGlobal("document", { hasFocus: () => true });
  const fetch = vi.fn().mockResolvedValue({});
  vi.stubGlobal("fetch", fetch);
  const group = { id: "room", unread: true, tasks: [
    { threadId: "main", unread: true }, { threadId: "fork", unread: true }, { threadId: "background", unread: true },
  ] } as Partial<Group> & { id: string };
  const state = { activeView: "chat", selectedId: "room", groups: [{ id: "room", threadId: "main" }],
    forkPanel: { kind: "group", ownerId: "room", threadId: "fork" } } as unknown as AppState;
  markShownGroupRead(state, group);
  expect(fetch.mock.calls.map(([path, init]) => [path, JSON.parse(init.body).threadId])).toEqual([
    ["/api/groups/room/read", "main"], ["/api/groups/room/read", "fork"],
  ]);
  expect(group.tasks?.map((task) => task.unread)).toEqual([false, false, true]);
  expect(group.unread).toBe(true);
});
