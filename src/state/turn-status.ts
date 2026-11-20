// What each thread's running turn is doing right now, read from the live runtime frames: the engine's own report of a
// tool call (turn.progress), reasoning or reply text streaming, and the turn's end. Held per thread outside the app
// reducer, so a frame re-renders only the chat that shows that thread, and only when what it shows changes.
import { useSyncExternalStore } from "react";

import type { RuntimeEvent } from "../../shared/runtime-events";
import { isTurnAutomationAction, progressKey, type TurnAutomationAction, type TurnProgressActivity, type TurnProgressFields } from "../../shared/turn-progress";

export type LiveStatus =
  | ({ activity: TurnProgressActivity } & Omit<TurnProgressFields, "type" | "activity" | "automation">)
  | { activity: "thinking" | "reply"; itemId?: undefined };

type StartedTool = { id: string; activity: TurnProgressActivity };
export interface TurnLive {
  turnId?: string;
  requestMessageId?: string;
  startedTools?: readonly StartedTool[];
  automation?: readonly { id: string; action: TurnAutomationAction }[];
  waiting?: "resource" | "retry";
  /** The newest turn this thread showed has completed, failed or stopped. */
  ended: boolean;
  status: LiveStatus | null;
}

const UNKNOWN: TurnLive = { ended: false, status: null };
const MAX_THREADS = 500;
const threads = new Map<string, TurnLive>();
const lastFrames = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();

function sameStatus(a: LiveStatus | null, b: LiveStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return ("bytes" in a ? a.bytes : undefined) === ("bytes" in b ? b.bytes : undefined) && progressKey(a) === progressKey(b);
}

function put(threadId: string, next: TurnLive): void {
  const current = threads.get(threadId);
  if (current && current.turnId === next.turnId && current.ended === next.ended && sameStatus(current.status, next.status) &&
      current.requestMessageId === next.requestMessageId && current.startedTools === next.startedTools &&
      current.automation === next.automation && current.waiting === next.waiting) return;
  threads.delete(threadId);
  threads.set(threadId, next);
  if (threads.size > MAX_THREADS) threads.delete(threads.keys().next().value!);
  for (const listener of Array.from(listeners.get(threadId) ?? [])) listener();
}

/** One live runtime frame. A row in the chat supersedes the status it came from, except the row of the very tool call
 * the status describes: "Writing index.html · 14 KB" outlasts the call's own chip until the call finishes. */
export function noteTurnEvent(event: RuntimeEvent): void {
  const { threadId } = event;
  lastFrames.delete(threadId);
  lastFrames.set(threadId, Date.now());
  if (lastFrames.size > MAX_THREADS) lastFrames.delete(lastFrames.keys().next().value!);
  const current = threads.get(threadId);
  const sameTurn = current && (!event.turnId || event.turnId === current.turnId);
  const turnId = event.turnId ?? current?.turnId;
  const live: TurnLive = sameTurn ? current : { turnId, ended: false, status: null };
  if (event.type !== "turn.started" && current?.turnId && event.turnId && !sameTurn && !current.ended) return;
  if (event.type !== "turn.started" && sameTurn && current.ended) return;
  switch (event.type) {
    case "turn.started":
      return put(threadId, { turnId, requestMessageId: event.requestMessageId, ended: false, status: null });
    case "turn.completed":
    case "cap.exhausted":
    case "session.exited":
      return put(threadId, { turnId, ended: true, status: null });
    case "runtime.error":
      if (event.terminal) put(threadId, { turnId, ended: true, status: null });
      return;
    case "turn.progress": {
      const { activity, tool, file, bytes, itemId, target, detail, quiet, tail, automation } = event;
      if (automation) {
        if (!sameTurn || !event.turnId || !itemId || !isTurnAutomationAction(automation.action)) return;
        const actions = live.automation ?? [];
        const active = actions.find(({ id }) => id === itemId);
        if (automation.phase === "started" && !active) {
          put(threadId, { ...live, automation: [...actions, { id: itemId, action: automation.action }] });
        } else if (automation.phase === "finished" && active?.action === automation.action) {
          put(threadId, { ...live, automation: actions.filter(({ id }) => id !== itemId) });
        }
        return;
      }
      return put(threadId, { ...live, ended: false, status: {
        activity, ...(tool ? { tool } : {}), ...(file ? { file } : {}), ...(bytes !== undefined ? { bytes } : {}), ...(itemId ? { itemId } : {}),
        ...(target ? { target } : {}), ...(detail ? { detail } : {}), ...(quiet ? { quiet } : {}), ...(tail?.length ? { tail } : {}),
      } });
    }
    case "content.delta":
      return put(threadId, { ...live, waiting: undefined, ended: false,
        status: event.streamKind === "assistant_text" && !event.synthetic ? { activity: "reply" }
          : event.streamKind === "reasoning_text" ? { activity: "thinking" } : null });
    case "item.started": {
      const status = live.status?.itemId && live.status.itemId === event.itemId ? live.status : null;
      if (event.itemType !== "tool") return put(threadId, { ...live, ended: false, status });
      const id = event.itemId ?? event.eventId;
      const activity = event.step?.activity ?? (status && status.activity !== "reply" && status.activity !== "thinking" ? status.activity : "tool");
      const startedTools = [...(live.startedTools ?? []).filter((step) => step.id !== id), { id, activity }];
      return put(threadId, { ...live, ended: false, status, waiting: undefined, startedTools });
    }
    case "item.completed": {
      const startedTools = event.itemType !== "tool" ? live.startedTools
        : event.itemId ? live.startedTools?.filter((step) => step.id !== event.itemId) : undefined;
      return put(threadId, { ...live, status: null, startedTools });
    }
    case "request.opened":
      return put(threadId, { ...live, status: null });
    case "turn.wait_started":
      return put(threadId, { ...live, waiting: "resource" });
    case "turn.wait_ended":
      return put(threadId, { ...live, waiting: undefined });
    case "turn.retrying":
      return put(threadId, { ...live, status: null, startedTools: undefined, automation: undefined, waiting: "retry" });
    default:
      if (live !== current) put(threadId, live);
  }
}

export function turnLive(threadId: string | null | undefined): TurnLive {
  return (threadId && threads.get(threadId)) || UNKNOWN;
}

/** When this thread last sent any live frame, or, before its first one, when this window first asked. Read on a clock
 * rather than subscribed, so streamed text never re-renders. */
export function silentSince(threadId: string): number {
  const at = lastFrames.get(threadId);
  if (at !== undefined) return at;
  const now = Date.now();
  lastFrames.set(threadId, now);
  return now;
}

function subscribe(threadId: string | null | undefined, listener: () => void): () => void {
  if (!threadId) return () => {};
  let set = listeners.get(threadId);
  if (!set) listeners.set(threadId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(threadId);
  };
}

export function useTurnLive(threadId: string | null | undefined): TurnLive {
  return useSyncExternalStore(
    (listener) => subscribe(threadId, listener),
    () => turnLive(threadId),
    () => turnLive(threadId),
  );
}

/** Tests only. */
export function resetTurnLive(): void {
  threads.clear();
  lastFrames.clear();
}
