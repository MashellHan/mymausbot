import type { AppPointedRef } from "../shared/app.ts";
import { appRow } from "./chat-apps.ts";
import type { AgentCardStore } from "./chat-widgets.ts";
import { preparePointed, type Pointed } from "./pointed.ts";
import { userError } from "./user-errors.ts";

export type RoomPick = { refs: AppPointedRef[]; blocks: Record<string, string> };

export function prepareRoomPointed(store: Pick<AgentCardStore, "messagesFor">, threadId: string, value: unknown): { ok: true; pick: RoomPick } | Extract<Pointed, { ok: false }> | null {
  const pointed = preparePointed(store, threadId, value);
  if (!pointed || !pointed.ok) return pointed;
  const byBot = new Map<string, { parts: unknown[]; numbers: number[] }>();
  for (const [index, part] of (value as Array<{ appId: string }>).entries()) {
    const botId = appRow(store, threadId, part.appId)?.from?.botId;
    if (!botId) return { ok: false, status: 404, ...userError("serverError.page.notHere") };
    const own = byBot.get(botId) ?? { parts: [], numbers: [] };
    own.parts.push(part);
    own.numbers.push(index + 1);
    byBot.set(botId, own);
  }
  const blocks: Record<string, string> = {};
  for (const [botId, group] of byBot) {
    const own = byBot.size === 1 ? pointed : preparePointed(store, threadId, group.parts, group.numbers);
    if (!own?.ok) return own ?? { ok: false, status: 404, ...userError("serverError.page.notHere") };
    blocks[botId] = own.block;
  }
  return { ok: true, pick: { refs: pointed.refs, blocks } };
}

export function roomPickBots(pick: RoomPick | undefined): string[] {
  return pick ? Object.keys(pick.blocks) : [];
}

export function undeliveredPickBots(pick: RoomPick | undefined, responders: ReadonlyArray<{ id: string }>): string[] {
  return roomPickBots(pick).filter((id) => !responders.some((responder) => responder.id === id));
}

export function pointedResponders<T extends { id: string; hidden?: boolean }>(pick: RoomPick | undefined, members: T[], named: () => T[]): T[] {
  const ids = roomPickBots(pick);
  const pageBots = members.filter((member) => !member.hidden && ids.includes(member.id));
  return pageBots.length ? [...pageBots, ...named().filter((member) => !pageBots.includes(member))] : [];
}

export function copyRoomPick(pick: RoomPick): RoomPick {
  return { ...pick, blocks: { ...pick.blocks } };
}

export function takeRoomPick(holder: { pick?: RoomPick } | undefined, botId: string): string {
  const blocks = holder?.pick?.blocks;
  if (!blocks || !Object.hasOwn(blocks, botId)) return "";
  const block = blocks[botId]!;
  delete blocks[botId];
  return block;
}
