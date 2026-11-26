// Context snapshots, prompt building, and shared timeline merge helpers for concurrent read-only workers.

import { newId } from "./contracts.ts";
import { selectReplay, type CompactionRecord, type ReplayEntry } from "./context-rebuild.ts";
import { contextText, isContextMessage } from "./delta-context.ts";
import { sinceFreshStart } from "./fresh-start.ts";
import { redactBotAuthored } from "./message-redaction.ts";
import { escapeNotes } from "./peer-provenance.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";
import type { ResolvedSender } from "../shared/wire.ts";

export type ReadOnlyWorkerClassification = "light-qa" | "readonly-query";

/** Structurally matches shared/progressive-intake.ts (Slice 1) for zero-conflict integration. */
export type ProgressiveIntakeMode =
  | "live-steer"
  | "progressive-continue"
  | "soft-redirect"
  | "readonly-concurrent"
  | "delegation-forward";

/** Structurally matches shared/progressive-intake.ts (Slice 1) for zero-conflict integration. */
export type ProgressiveIntakeState =
  | "received"
  | "folding"
  | "processing"
  | "answered"
  | "superseded";

/** Intake metadata attached to the triggering user message. */
export interface ProgressiveIntakeMetadata {
  mode: ProgressiveIntakeMode;
  state: ProgressiveIntakeState;
  targetTurnId?: string;
  workerTurnId?: string;
  updatedAt: number;
}

/** Provenance metadata attached to concurrent read-only worker replies. */
export interface ConcurrentWorkerMetadata {
  workerId: string;
  readOnly: true;
  parentTurnId?: string;
}

export type WorkerMessage = Message & {
  intake?: ProgressiveIntakeMetadata;
  concurrentWorker?: ConcurrentWorkerMetadata;
};

export interface ReadOnlyContextSnapshot {
  readonly threadId: string;
  readonly parentTurnId?: string;
  readonly cutoffMessageId: string | null;
  readonly capturedAt: number;
  readonly transcript: readonly ReplayEntry[];
  readonly inline: readonly ReplayEntry[];
  readonly representedIds: readonly string[];
  readonly dropped: number;
}

function freezeEntries(entries: readonly ReplayEntry[]): readonly ReplayEntry[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

function formatSnapshotEntry(message: WorkerMessage): { role: "user" | "assistant"; text: string } {
  const text = escapeNotes(redactSecretsInText(contextText(message)));
  if (message.concurrentWorker?.readOnly) {
    return {
      role: "assistant",
      text: `[Concurrent read-only worker reply (${message.concurrentWorker.workerId})]: ${text}`,
    };
  }
  return { role: message.role === "user" ? "user" : "assistant", text };
}

/** Captures an immutable, secret-redacted read-only conversation snapshot up to cutoff without mutating store state. */
export function buildReadOnlyContextSnapshot(input: {
  threadId: string;
  parentTurnId?: string;
  messages: readonly WorkerMessage[];
  compaction?: CompactionRecord & { id: string };
  excludedIds?: ReadonlySet<string>;
  budgetBytes?: number;
  maxMessages?: number;
  capturedAt?: number;
}): ReadOnlyContextSnapshot {
  const active = sinceFreshStart(input.messages);
  const cutoffMessageId = active.at(-1)?.id ?? null;
  const history: ReplayEntry[] = active
    .filter((message) => isContextMessage(message))
    .map((message) => {
      const formatted = formatSnapshotEntry(message);
      return { id: message.id, role: formatted.role, text: formatted.text };
    });

  const replayed = selectReplay(history, {
    ...(input.budgetBytes !== undefined ? { budgetBytes: input.budgetBytes } : {}),
    ...(input.maxMessages !== undefined ? { maxMessages: input.maxMessages } : {}),
    ...(input.compaction ? { compaction: input.compaction } : {}),
    ...(input.excludedIds ? { excludedIds: input.excludedIds } : {}),
  });

  return Object.freeze({
    threadId: input.threadId,
    ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
    cutoffMessageId,
    capturedAt: input.capturedAt ?? Date.now(),
    transcript: freezeEntries(replayed.transcript),
    inline: freezeEntries(replayed.inline),
    representedIds: Object.freeze([...replayed.representedIds]),
    dropped: replayed.dropped,
  });
}

export function buildReadOnlyWorkerPrompt(input: {
  query: string;
  snapshot: ReadOnlyContextSnapshot;
  primaryTaskHint?: string;
}): string {
  const taskLine = input.primaryTaskHint
    ? `Active primary turn (${input.snapshot.parentTurnId ?? "active"}): ${JSON.stringify(redactSecretsInText(input.primaryTaskHint))}.`
    : `An active primary turn (${input.snapshot.parentTurnId ?? "active"}) is running concurrently on this thread.`;
  const historyLines = input.snapshot.inline.map(
    (entry) => `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`,
  );
  return [
    "[Read-only concurrent worker turn: you share a read-only snapshot of this conversation while a primary turn runs independently. Do NOT claim to edit files, run commands, perform side effects, or override the primary turn's goals. Answer only the user's question accurately and concisely.]",
    taskLine,
    ...(historyLines.length
      ? ["", "[Conversation snapshot (read-only):]", ...historyLines, "[End of conversation snapshot]"]
      : []),
    "",
    "[User question to answer now:]",
    escapeNotes(input.query),
  ].join("\n");
}

export function buildWorkerIntakeMetadata(input: {
  state: ProgressiveIntakeState;
  parentTurnId?: string;
  workerTurnId: string;
  updatedAt?: number;
}): ProgressiveIntakeMetadata {
  return {
    mode: "readonly-concurrent",
    state: input.state,
    ...(input.parentTurnId ? { targetTurnId: input.parentTurnId } : {}),
    workerTurnId: input.workerTurnId,
    updatedAt: input.updatedAt ?? Date.now(),
  };
}

export function buildConcurrentWorkerMetadata(input: {
  workerId: string;
  parentTurnId?: string;
}): ConcurrentWorkerMetadata {
  return {
    workerId: input.workerId,
    readOnly: true,
    ...(input.parentTurnId ? { parentTurnId: input.parentTurnId } : {}),
  };
}

export function buildWorkerUserMessageDraft(input: {
  text: string;
  parentTurnId?: string;
  workerTurnId: string;
  sendId?: string;
  sender?: ResolvedSender;
  replyToId?: string;
  now?: number;
}): Omit<WorkerMessage, "id" | "at"> & { at?: number } {
  const now = input.now ?? Date.now();
  return {
    role: "user",
    kind: "text",
    text: input.text,
    ...(input.sendId ? { sendId: input.sendId } : {}),
    ...(input.sender ? { sender: input.sender } : {}),
    ...(input.replyToId ? { replyToId: input.replyToId } : {}),
    intake: buildWorkerIntakeMetadata({
      state: "processing",
      parentTurnId: input.parentTurnId,
      workerTurnId: input.workerTurnId,
      updatedAt: now,
    }),
    at: now,
  };
}

export function buildWorkerAssistantMessageDraft(input: {
  workerId: string;
  workerTurnId: string;
  parentTurnId?: string;
  replyToId: string;
  text: string;
  itemId?: string;
  succeeded: boolean;
  now?: number;
}): Omit<WorkerMessage, "id" | "at"> & { at?: number } {
  const now = input.now ?? Date.now();
  const scrubbed = redactBotAuthored({
    role: "bot",
    kind: "text",
    text: redactSecretsInText(input.text),
    replyToId: input.replyToId,
    requestMessageId: input.replyToId,
    turnId: input.workerTurnId,
    ...(input.itemId ? { itemId: input.itemId } : {}),
    turnSucceeded: input.succeeded,
    ...(input.succeeded ? { turnCompletedAt: now } : {}),
  } as Omit<Message, "id" | "at"> & { at?: number });

  return {
    ...scrubbed,
    at: now,
    concurrentWorker: buildConcurrentWorkerMetadata({
      workerId: input.workerId,
      parentTurnId: input.parentTurnId,
    }),
  };
}

export interface TimelineMergeStore {
  messagesFor(threadId: string): WorkerMessage[];
  appendMessage(threadId: string, message: Omit<WorkerMessage, "id" | "at"> & { at?: number }): WorkerMessage;
  patchMessage(threadId: string, messageId: string, patch: Partial<WorkerMessage>): WorkerMessage | null;
}

export interface MergeWorkerReplyInput {
  store: TimelineMergeStore;
  threadId: string;
  workerId: string;
  workerTurnId: string;
  parentTurnId?: string;
  userMessageId: string;
  userText?: string;
  sendId?: string;
  sender?: ResolvedSender;
  replyText: string;
  itemId?: string;
  succeeded: boolean;
  now?: number;
  markExternalContext?: (threadId: string) => void;
}

export interface MergeWorkerReplyResult {
  userMessage: WorkerMessage;
  assistantMessage: WorkerMessage | null;
}

/**
 * Persists or updates a concurrent read-only worker reply into the parent thread timeline.
 * Never mutates the active primary turn's requestPending flag, turnId, or resumeCursors.
 */
export function mergeWorkerReplyIntoTimeline(input: MergeWorkerReplyInput): MergeWorkerReplyResult {
  const now = input.now ?? Date.now();
  const existing = input.store.messagesFor(input.threadId);

  let userMessage = existing.find((message) => message.id === input.userMessageId);
  const terminalState: ProgressiveIntakeState = input.succeeded ? "answered" : "superseded";
  const nextIntake = buildWorkerIntakeMetadata({
    state: terminalState,
    parentTurnId: input.parentTurnId,
    workerTurnId: input.workerTurnId,
    updatedAt: now,
  });

  if (userMessage) {
    userMessage = input.store.patchMessage(input.threadId, userMessage.id, { intake: nextIntake }) ?? {
      ...userMessage,
      intake: nextIntake,
    };
  } else {
    userMessage = input.store.appendMessage(
      input.threadId,
      {
        ...buildWorkerUserMessageDraft({
          text: input.userText ?? "",
          parentTurnId: input.parentTurnId,
          workerTurnId: input.workerTurnId,
          sendId: input.sendId,
          sender: input.sender,
          now,
        }),
        intake: nextIntake,
      },
    );
  }

  const trimmedReply = input.replyText.trim();
  const existingReply = existing.find(
    (message) =>
      message.role === "bot" &&
      message.kind === "text" &&
      message.concurrentWorker?.workerId === input.workerId &&
      message.replyToId === userMessage.id,
  );

  let assistantMessage: WorkerMessage | null = null;
  if (trimmedReply) {
    const draft = buildWorkerAssistantMessageDraft({
      workerId: input.workerId,
      workerTurnId: input.workerTurnId,
      parentTurnId: input.parentTurnId,
      replyToId: userMessage.id,
      text: trimmedReply,
      itemId: input.itemId ?? `${input.workerTurnId}:reply`,
      succeeded: input.succeeded,
      now,
    });
    if (existingReply) {
      assistantMessage =
        input.store.patchMessage(input.threadId, existingReply.id, {
          text: draft.text,
          turnSucceeded: draft.turnSucceeded,
          turnCompletedAt: draft.turnCompletedAt,
          concurrentWorker: draft.concurrentWorker,
        }) ?? existingReply;
    } else {
      assistantMessage = input.store.appendMessage(input.threadId, draft);
    }
    if (input.succeeded) input.markExternalContext?.(input.threadId);
  }

  return { userMessage, assistantMessage };
}

export function allocateWorkerIds(parentThreadId: string, generateId: () => string = newId): {
  workerId: string;
  workerTurnId: string;
  executionThreadId: string;
} {
  const workerId = `ro_${generateId().slice(0, 12)}`;
  return {
    workerId,
    workerTurnId: `worker-${workerId}`,
    executionThreadId: `readonly-worker:${parentThreadId}:${workerId}`,
  };
}
