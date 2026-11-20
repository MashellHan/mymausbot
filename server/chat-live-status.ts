import { newId, type RuntimeEvent } from "./contracts.ts";
import { isTurnAutomationAction } from "../shared/turn-progress.ts";

export type AutomationObserver = <T>(action: string, run: () => T) => T;

type ChatTurnOwner = { generation: string; messageId?: string; turnId?: string; stopped?: boolean };

export function activeChatTurn(turnId: string | undefined, owner: ChatTurnOwner | undefined, generation: string): string | undefined {
  return owner?.generation === generation && !owner.stopped && turnId === owner.turnId ? turnId : undefined;
}

export function publicChatStatus(event: RuntimeEvent, owner: ChatTurnOwner | undefined, generation: string | undefined): RuntimeEvent {
  if (event.type === "turn.progress" && event.automation) return { ...event, automation: undefined };
  if (event.type !== "turn.started") return event;
  const requestMessageId = owner?.generation === generation && !owner?.stopped ? owner?.messageId : undefined;
  return requestMessageId === event.requestMessageId ? event : { ...event, requestMessageId };
}

export function observeAutomation(
  threadId: string,
  activeTurn: () => string | null | undefined,
  broadcast: (frame: { kind: "runtime"; event: RuntimeEvent }) => void,
): AutomationObserver {
  return (action, run) => {
    if (!isTurnAutomationAction(action)) return run();
    const turnId = activeTurn();
    if (!turnId) return run();
    const itemId = newId();
    const report = (phase: "started" | "finished") => {
      if (activeTurn() !== turnId) return;
      broadcast({ kind: "runtime", event: {
        eventId: newId(), provider: "harness", createdAt: new Date().toISOString(), threadId, turnId, itemId,
        type: "turn.progress", activity: "tool", automation: { action, phase },
      } });
    };
    const finish = () => report("finished");
    report("started");
    try {
      const result = run();
      if (result instanceof Promise) return result.finally(finish) as typeof result;
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  };
}
