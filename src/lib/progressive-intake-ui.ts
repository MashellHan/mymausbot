import type { RuntimeEvent } from "../../shared/runtime-events";
import type { Message } from "@/state/store";
import type { LocaleKey } from "@/locales";

/** Mirrors `shared/progressive-intake.ts` without touching Slice 1's file. */
export type ProgressiveIntakeMode =
  | "live-steer"
  | "progressive-continue"
  | "soft-redirect"
  | "readonly-concurrent"
  | "delegation-forward";

export type ProgressiveIntakeState =
  | "received"
  | "folding"
  | "processing"
  | "answered"
  | "superseded";

export interface MessageIntake {
  mode: ProgressiveIntakeMode;
  state: ProgressiveIntakeState;
  targetTurnId?: string;
  workerTurnId?: string;
  updatedAt: number;
}

export interface ConcurrentWorkerMeta {
  workerId: string;
  readOnly: true;
  parentTurnId?: string;
}

export type RuntimeEventWithIntake = RuntimeEvent & {
  replyToId?: string;
  requestMessageId?: string;
  concurrentWorker?: ConcurrentWorkerMeta;
};

const STATE_ORDER: Readonly<Record<ProgressiveIntakeState, number>> = {
  received: 0,
  folding: 1,
  processing: 2,
  answered: 3,
  superseded: 3,
};

export function createOptimisticIntake({
  busy,
  followUp,
  at = Date.now(),
}: {
  busy?: boolean;
  followUp?: "steer" | "queue" | "restart";
  at?: number;
}): MessageIntake | undefined {
  if (!busy) return undefined;
  const mode: ProgressiveIntakeMode =
    followUp === "steer"
      ? "live-steer"
      : followUp === "restart"
        ? "soft-redirect"
        : "progressive-continue";
  return { mode, state: "received", updatedAt: at };
}

export function mergeMessageIntake(
  previous: MessageIntake | undefined,
  incoming: MessageIntake | undefined,
): MessageIntake | undefined {
  if (!incoming) return previous;
  if (!previous) return incoming;
  const prevRank = STATE_ORDER[previous.state];
  const nextRank = STATE_ORDER[incoming.state];
  if (nextRank > prevRank) return incoming;
  if (nextRank === prevRank && incoming.updatedAt >= previous.updatedAt) return incoming;
  return previous;
}

export function isConcurrentWorkerMessage(
  message: Pick<Message, "role" | "kind" | "concurrentWorker">,
): boolean {
  return message.role === "bot" && message.kind === "text" && Boolean(message.concurrentWorker);
}

export function concurrentWorkerAnchorId(
  message: Pick<Message, "replyToId" | "requestMessageId">,
): string | undefined {
  return message.replyToId ?? message.requestMessageId;
}

export function hasConcurrentWorkerReplyFor(
  userMessageId: string,
  transcript: readonly Pick<Message, "role" | "kind" | "replyToId" | "requestMessageId" | "concurrentWorker">[],
): boolean {
  return transcript.some(
    (candidate) =>
      isConcurrentWorkerMessage(candidate) && concurrentWorkerAnchorId(candidate) === userMessageId,
  );
}

export function deriveMessageIntake(
  message: Pick<Message, "id" | "role" | "kind" | "at" | "intake" | "steered" | "queued">,
  transcript: readonly Pick<
    Message,
    "id" | "role" | "kind" | "at" | "replyToId" | "requestMessageId" | "turnId" | "concurrentWorker"
  >[],
  options: { busy?: boolean } = {},
): MessageIntake | undefined {
  if (message.role !== "user" || message.kind !== "text") return undefined;
  const base =
    message.intake ??
    (options.busy && message.id.startsWith("optimistic-")
      ? createOptimisticIntake({ busy: true, at: message.at })
      : undefined);
  if (!base) return undefined;
  if (base.state === "answered" || base.state === "superseded") return base;

  let answeredAt: number | undefined;
  for (const candidate of transcript) {
    if (candidate.role !== "bot" || candidate.kind !== "text") continue;
    if (candidate.id.startsWith("live:")) continue;
    const anchored =
      candidate.replyToId === message.id ||
      candidate.requestMessageId === message.id ||
      (Boolean(base.workerTurnId) && candidate.turnId === base.workerTurnId);
    if (!anchored) continue;
    if (answeredAt === undefined || candidate.at > answeredAt) answeredAt = candidate.at;
  }
  if (answeredAt !== undefined) {
    return { ...base, state: "answered", updatedAt: Math.max(base.updatedAt, answeredAt) };
  }
  return base;
}

export interface IntakeStatusView {
  state: ProgressiveIntakeState;
  mode: ProgressiveIntakeMode;
  labelKey: LocaleKey;
}

export function intakeStatusView(
  intake: MessageIntake,
  options: { hasConcurrentWorkerReply?: boolean } = {},
): IntakeStatusView {
  const labelKey: LocaleKey =
    intake.state === "answered"
      ? options.hasConcurrentWorkerReply || intake.mode === "readonly-concurrent"
        ? "chat.intake.answeredWorker"
        : "chat.intake.answered"
      : intake.state === "folding"
        ? "chat.intake.folding"
        : intake.state === "processing"
          ? "chat.intake.processing"
          : intake.state === "superseded"
            ? "chat.intake.superseded"
            : "chat.intake.received";
  return { state: intake.state, mode: intake.mode, labelKey };
}

export interface AnchoredReplyGroup<T extends Pick<Message, "id" | "role" | "kind" | "replyToId" | "requestMessageId" | "concurrentWorker"> = Message> {
  anchorId: string;
  anchor: T;
  primaryReplies: T[];
  concurrentReplies: T[];
  allReplies: T[];
  hasActiveLiveReply: boolean;
}

/** Groups anchored primary and concurrent worker replies by triggering user message without mutating reading order. */
export function groupThreadRepliesByAnchor<
  T extends Pick<Message, "id" | "role" | "kind" | "replyToId" | "requestMessageId" | "concurrentWorker">,
>(messages: readonly T[]): {
  groups: AnchoredReplyGroup<T>[];
  byAnchor: Map<string, AnchoredReplyGroup<T>>;
  unanchoredBotReplies: T[];
} {
  const byAnchor = new Map<string, AnchoredReplyGroup<T>>();
  const groups: AnchoredReplyGroup<T>[] = [];
  const unanchoredBotReplies: T[] = [];

  for (const message of messages) {
    if (message.role === "user" && message.kind === "text") {
      const group: AnchoredReplyGroup<T> = {
        anchorId: message.id,
        anchor: message,
        primaryReplies: [],
        concurrentReplies: [],
        allReplies: [],
        hasActiveLiveReply: false,
      };
      byAnchor.set(message.id, group);
      groups.push(group);
      continue;
    }
    if (message.role !== "bot" || message.kind !== "text") continue;
    const targetId = concurrentWorkerAnchorId(message);
    const group = targetId ? byAnchor.get(targetId) : undefined;
    if (!group) {
      unanchoredBotReplies.push(message);
      continue;
    }
    group.allReplies.push(message);
    if (message.concurrentWorker) group.concurrentReplies.push(message);
    else group.primaryReplies.push(message);
    if (message.id.startsWith("live:")) group.hasActiveLiveReply = true;
  }

  return { groups, byAnchor, unanchoredBotReplies };
}
