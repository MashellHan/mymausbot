import { placeUnreadDivider } from "@/lib/unread-divider";
import { api } from "./api";
import { visibleMessages } from "./snapshot-navigation";
import type { Action, AppState, Message } from "./store";

export const MESSAGE_PAGE_SIZE = 200;
type OlderMessages = Extract<Action, { type: "olderMessages" }>;
type LoadOlderMessages = Extract<Action, { type: "loadOlderMessages" }>;
type TrimHeldMessages = Extract<Action, { type: "trimHeldMessages" }>;
type HeldOwner = { id: string; messages: Message[]; threadId: string; hasMore?: boolean; activeLeafId?: string | null; pinnedMessageId?: string };

export function reduceOlderMessages(state: AppState, action: OlderMessages): AppState {
  const { [action.threadId]: _done, ...loadingOlder } = state.loadingOlder;
  if ((state.transcriptGeneration[action.threadId] ?? 0) !== action.generation) return { ...state, loadingOlder };
  const current = [...state.bots, ...state.groups].find((owner) => owner.threadId === action.threadId);
  if (action.before !== undefined) {
    const held = current?.messages ?? [];
    const overlap = held.findIndex((message) => message.id === action.before);
    const overlapStart = action.messages.length - overlap;
    const canJoin = overlap >= 0 && overlapStart >= 0
      && action.messages.slice(overlapStart).every((message, index) => message.id === held[index]?.id);
    if (!canJoin) return { ...state, loadingOlder };
  }
  const prepend = <T extends HeldOwner>(owner: T): T => {
    const page = new Set(action.messages.map((message) => message.id));
    const held = new Set(owner.messages.filter((message) => page.has(message.id)).map((message) => message.id));
    return {
      ...owner,
      messages: [...action.messages.filter((message) => !held.has(message.id)), ...owner.messages],
      hasMore: action.hasMore,
    };
  };
  const bots = state.bots.map((bot) => (bot.threadId === action.threadId ? prepend(bot) : bot));
  const groups = state.groups.map((group) => (group.threadId === action.threadId ? prepend(group) : group));
  const owner = [...bots, ...groups].find((candidate) => candidate.threadId === action.threadId);
  const unreadDivider = placeUnreadDivider(state.unreadDivider, action.threadId, owner ? visibleMessages(owner) : [], action.hasMore);
  return { ...state, loadingOlder, bots, groups, unreadDivider };
}

export function loadOlderPage(action: LoadOlderMessages, current: AppState, inFlight: Set<string>,
  dispatch: (action: Action) => void, showError: (error: unknown) => void): void {
  if (inFlight.has(action.threadId)) return;
  inFlight.add(action.threadId);
  const owner = [...current.bots, ...current.groups].find((candidate) => candidate.threadId === action.threadId);
  const before = owner?.messages[0]?.id;
  const generation = current.transcriptGeneration[action.threadId] ?? 0;
  if (!before) {
    inFlight.delete(action.threadId);
    dispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: false });
    return;
  }
  void api<{ messages: Message[]; hasMore?: boolean }>(
    `/api/threads/${action.threadId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(before)}`,
  ).finally(() => inFlight.delete(action.threadId)).then((page) => dispatch({
    type: "olderMessages", threadId: action.threadId, generation, before, messages: page.messages ?? [], hasMore: Boolean(page.hasMore),
  })).catch((error) => {
    dispatch({ type: "olderMessages", threadId: action.threadId, generation, messages: [], hasMore: true });
    showError(error);
  });
}

export async function loadFullThread(threadId: string): Promise<{ messages: Message[]; activeLeafId: string | null }> {
  const messages: Message[] = [];
  let before: string | undefined;
  let activeLeafId: string | null = null;
  for (;;) {
    const page = await api<{ messages: Message[]; hasMore?: boolean; activeLeafId: string | null }>(
      `/api/threads/${threadId}/messages?limit=${MESSAGE_PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    );
    messages.unshift(...page.messages);
    activeLeafId = page.activeLeafId;
    if (!page.hasMore || !page.messages.length) break;
    before = page.messages[0]!.id;
  }
  return { messages, activeLeafId };
}

export const HELD_AFTER_LEAVING = MESSAGE_PAGE_SIZE;
export const HELD_FOR_PLACE = 3 * MESSAGE_PAGE_SIZE;

/** The newest rows of `owner`, from `keepFromId` when that is close enough to the end, never cutting off its pinned
 * message or the leaf of the branch it shows. */
export function trimmedHeld<T extends HeldOwner>(owner: T, keepFromId?: string): T {
  const total = owner.messages.length;
  let from = total - HELD_AFTER_LEAVING;
  if (from <= 0) return owner;
  for (const id of [keepFromId, owner.activeLeafId, owner.pinnedMessageId]) {
    const at = id ? owner.messages.findIndex((message) => message.id === id) : -1;
    if (at < 0 || at >= from) continue;
    if (id !== keepFromId && total - at > HELD_FOR_PLACE) return owner;
    if (total - at <= HELD_FOR_PLACE) from = at;
  }
  return from > 0 ? { ...owner, messages: owner.messages.slice(from), hasMore: true } : owner;
}

export function reduceTrimHeldMessages(state: AppState, { threadId, keepFromId }: TrimHeldMessages): AppState {
  const shown = state.activeView === "chat" &&
    [...state.bots, ...state.groups].some((owner) => owner.id === state.selectedId && owner.threadId === threadId);
  if (shown || state.forkPanel?.threadId === threadId) return state;
  let changed = false;
  const trim = <T extends HeldOwner>(owner: T): T => {
    if (owner.threadId !== threadId) return owner;
    const next = trimmedHeld(owner, keepFromId);
    changed ||= next !== owner;
    return next;
  };
  const bots = state.bots.map(trim);
  const groups = state.groups.map(trim);
  return changed ? { ...state, bots, groups } : state;
}
