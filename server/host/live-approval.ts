import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { Assignment } from "../runtime/types.ts";
import type { BotRecord, Store } from "../store.ts";

export interface LiveApprovalDeps {
  store: Pick<Store, "projectBotForTask">;
  /** The level a bot's turn in a thread runs at. */
  turnLevel: (bot: BotRecord, peerInitiated: boolean, threadId: string) => ApprovalMode;
}

/** A running turn's approval decisions use the conversation's saved level at the moment each one is made, never a copy
 * taken when the turn started, judged on the engine the turn runs on. */
export function createLiveApprovalMode(deps: LiveApprovalDeps) {
  return (running: BotRecord, threadId: string, peerInitiated: boolean): ApprovalMode => {
    const saved = deps.store.projectBotForTask(running.id, threadId);
    return deps.turnLevel(saved ? { ...saved, modelSelection: running.modelSelection } : running, peerInitiated, threadId);
  };
}

export function createRecipientApprovalLevel(deps: {
  store: Pick<Store, "taskByThread">;
  assignment(id: string): Pick<Assignment, "assignee" | "status" | "requester"> | undefined;
  botForThread(botId: string, threadId: string): BotRecord | null;
  internal(threadId: string): boolean;
  liveMode: ReturnType<typeof createLiveApprovalMode>;
}) {
  return (botId: string, threadId: string, nodeId?: string): ApprovalMode | null => {
    if (!deps.store.taskByThread(botId, threadId)) return null;
    const bot = deps.botForThread(botId, threadId);
    if (!bot || bot.id !== botId) return null;
    if (!nodeId) return deps.liveMode(bot, threadId, deps.internal(threadId));
    const current = deps.assignment(nodeId);
    if (!current || current.assignee.botId !== botId || current.assignee.destination.threadId !== threadId
      || (current.status !== "running" && current.status !== "needs_input")) return null;
    return deps.liveMode(bot, threadId, current.status === "running" ? deps.internal(threadId) : current.requester.kind !== "person");
  };
}
