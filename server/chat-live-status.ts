import { newId, type RuntimeEvent } from "./contracts.ts";
import { isTurnAutomationAction } from "../shared/turn-progress.ts";

export type StartAutomationStatus = (action: string) => (() => void) | undefined;

type ChatTurnOwner = {
  generation: string;
  messageId?: string;
  turnId?: string | null;
  stopped?: boolean;
  personLine?: true;
  automation?: unknown;
};

export function activeChatTurn(turnId: string | undefined, owner: ChatTurnOwner | undefined, generation: string): string | undefined {
  return owner?.generation === generation && !owner.stopped && turnId === owner.turnId ? turnId : undefined;
}

export function publicChatStatus(event: RuntimeEvent, owner: ChatTurnOwner | undefined, generation: string | undefined): RuntimeEvent {
  if (event.type === "turn.progress" && event.automation) return { ...event, automation: undefined };
  if (event.type !== "turn.started") return event;
  const requestMessageId = owner?.personLine && owner.generation === generation && !owner.stopped && !owner.automation
    ? owner.messageId : undefined;
  return requestMessageId === event.requestMessageId ? event : { ...event, requestMessageId };
}

export function automationStatus(
  threadId: string,
  activeTurn: () => string | null | undefined,
  broadcast: (frame: { kind: "runtime"; event: RuntimeEvent }) => void,
): StartAutomationStatus {
  return (action) => {
    if (!isTurnAutomationAction(action)) return undefined;
    const turnId = activeTurn();
    if (!turnId) return undefined;
    const itemId = newId();
    const report = (phase: "started" | "finished") => {
      if (activeTurn() !== turnId) return;
      broadcast({ kind: "runtime", event: {
        eventId: newId(), provider: "harness", createdAt: new Date().toISOString(), threadId, turnId, itemId,
        type: "turn.progress", activity: "tool", automation: { action, phase },
      } });
    };
    report("started");
    return () => report("finished");
  };
}
