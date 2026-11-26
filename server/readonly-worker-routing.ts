// Concurrent read-only worker routing, isolated SSE stream framing, cancellation/timeout
// cleanup, and persisted timeline merge adapter (T9 Slice 2).

import {
  allocateWorkerIds,
  authorizeWorkerToolCall,
  buildConcurrentWorkerMetadata,
  buildReadOnlyContextSnapshot,
  buildReadOnlyWorkerPrompt,
  buildWorkerIntakeMetadata,
  buildWorkerUserMessageDraft,
  evaluateReadOnlyWorkerEligibility,
  mergeWorkerReplyIntoTimeline,
  sanitizeWorkerSendTurnInput,
  WriteLockGuard,
  type ConcurrentWorkerMetadata,
  type ProgressiveIntakeMetadata,
  type ReadOnlyContextSnapshot,
  type ReadOnlyFallbackChannel,
  type ReadOnlyWorkerClassification,
  type ReadOnlyWorkerEligibilityDecision,
  type ReadOnlyWorkerEligibilityInput,
  type ReadOnlyWorkerLifecycleState,
  type ReadOnlyWorkerPolicy,
  type ReadOnlyWorkerRecord,
  type ReadOnlyWriteLockSnapshot,
  type TimelineMergeStore,
  type WorkerMessage,
} from "./readonly-worker.ts";
import { newId, type ProviderAdapter, type RuntimeEvent, type SendTurnInput } from "./contracts.ts";
import { escapeNotes } from "./peer-provenance.ts";
import { redactSecretsInText } from "./redact.ts";
import type { ResolvedSender } from "../shared/wire.ts";

export const READONLY_WORKER_REQUEST_REFUSAL =
  "Concurrent read-only worker cannot ask questions or request extra permissions. Ask in the main turn instead.";

export const DEFAULT_WORKER_TIMEOUT_MS = 30_000;

/** Isolated SSE frame emitted for in-thread concurrent workers; never collides with primary turn `kind: "runtime"`. */
export type ReadOnlyWorkerSseFrame =
  | {
      kind: "worker.runtime";
      threadId: string;
      workerId: string;
      parentTurnId?: string;
      replyToId: string;
      concurrentWorker: ConcurrentWorkerMetadata;
      event: RuntimeEvent;
    }
  | {
      kind: "worker.intake";
      threadId: string;
      workerId: string;
      messageId: string;
      replyToId: string;
      state: ReadOnlyWorkerLifecycleState;
      intake: ProgressiveIntakeMetadata;
      concurrentWorker: ConcurrentWorkerMetadata;
      error?: string;
    };

export interface WorkerRuntimeMeta {
  parentThreadId: string;
  workerId: string;
  workerTurnId: string;
  parentTurnId?: string;
  replyToId: string;
}

/** Maps an isolated execution-thread RuntimeEvent onto the parent thread inside a worker-scoped envelope. */
export function isolateWorkerRuntimeEvent(event: RuntimeEvent, meta: WorkerRuntimeMeta): RuntimeEvent {
  const itemScope = `${meta.workerTurnId}:`;
  const scopedItemId = event.itemId
    ? event.itemId.startsWith(itemScope)
      ? event.itemId
      : `${itemScope}${event.itemId}`
    : `${itemScope}msg`;

  const base = {
    ...event,
    threadId: meta.parentThreadId,
    turnId: meta.workerTurnId,
    itemId: scopedItemId,
  };

  if (base.type === "content.delta") {
    return { ...base, delta: redactSecretsInText(base.delta) };
  }
  if (base.type === "item.completed" && base.itemType === "assistant_text") {
    return { ...base, text: redactSecretsInText(base.text) };
  }
  if (base.type === "runtime.error" || base.type === "runtime.notice") {
    return { ...base, message: redactSecretsInText(base.message) };
  }
  return base;
}

export function toIsolatedWorkerSseFrame(event: RuntimeEvent, meta: WorkerRuntimeMeta): ReadOnlyWorkerSseFrame {
  return {
    kind: "worker.runtime",
    threadId: meta.parentThreadId,
    workerId: meta.workerId,
    ...(meta.parentTurnId ? { parentTurnId: meta.parentTurnId } : {}),
    replyToId: meta.replyToId,
    concurrentWorker: buildConcurrentWorkerMetadata({
      workerId: meta.workerId,
      parentTurnId: meta.parentTurnId,
    }),
    event: isolateWorkerRuntimeEvent(event, meta),
  };
}

export interface WorkerExecutionContext {
  readonly workerId: string;
  readonly workerTurnId: string;
  readonly executionThreadId: string;
  readonly threadId: string;
  readonly botId: string;
  readonly parentTurnId?: string;
  readonly replyToId: string;
  readonly query: string;
  readonly prompt: string;
  readonly snapshot: ReadOnlyContextSnapshot;
  readonly policy: ReadOnlyWorkerPolicy;
  readonly signal: AbortSignal;
  onEvent(event: RuntimeEvent): void;
  failClosed(reason: string): void;
}

export type WorkerExecutionResult = {
  ok: boolean;
  text?: string;
  error?: string;
};

export type ReadOnlyWorkerExecutor = (ctx: WorkerExecutionContext) => Promise<WorkerExecutionResult>;

export interface ProviderAdapterWorkerOptions {
  adapter: Pick<ProviderAdapter, "provider" | "sendTurn" | "interruptTurn" | "respondToRequest" | "onEvent">;
  instanceId?: string;
  model?: string;
  system?: string;
  cwd?: string;
  baseTurnInput?: Partial<Omit<SendTurnInput, "threadId" | "text">>;
  generateId?: () => string;
}

/** Executes a concurrent worker via a ProviderAdapter on a dedicated synthetic executionThreadId. */
export function createProviderAdapterWorkerExecutor(options: ProviderAdapterWorkerOptions): ReadOnlyWorkerExecutor {
  const { adapter } = options;
  const genId = options.generateId ?? newId;

  return async (ctx) => {
    const safeInput = sanitizeWorkerSendTurnInput(
      {
        ...options.baseTurnInput,
        executionThreadId: ctx.executionThreadId,
        botId: ctx.botId,
        text: ctx.prompt,
        transcript: ctx.snapshot.inline.map((entry) => ({ role: entry.role, text: entry.text })),
        ...(options.model ? { model: options.model } : {}),
        ...(options.system ? { system: options.system } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      ctx.policy,
    );

    let accumulated = "";
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    let startedTurnId: string | undefined;

    return await new Promise<WorkerExecutionResult>((resolve) => {
      const finish = (result: WorkerExecutionResult) => {
        if (settled) return;
        settled = true;
        ctx.signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        resolve(result);
      };

      const onAbort = () => {
        void adapter.interruptTurn(ctx.executionThreadId, startedTurnId).catch(() => {});
        finish({ ok: false, text: accumulated || undefined, error: "Worker aborted or timed out." });
      };

      if (ctx.signal.aborted) {
        finish({ ok: false, error: "Worker aborted before dispatch." });
        return;
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      unsubscribe = adapter.onEvent((event) => {
        if (event.threadId !== ctx.executionThreadId || settled) return;

        if (event.type === "request.opened") {
          const requestId = event.requestId;
          const decision = {
            behavior: event.requestType === "question" ? ("answer" as const) : ("deny" as const),
            message: READONLY_WORKER_REQUEST_REFUSAL,
          };
          if (requestId) {
            void adapter.respondToRequest(ctx.executionThreadId, requestId, decision).catch(() => {});
          }
          void adapter.interruptTurn(ctx.executionThreadId, event.turnId ?? startedTurnId).catch(() => {});
          const error = `Permission or question request "${event.tool}" denied by read-only worker policy.`;
          finish({ ok: false, text: accumulated || undefined, error });
          ctx.failClosed(error);
          return;
        }

        if (event.type === "item.started" && event.itemType === "tool") {
          const verdict = authorizeWorkerToolCall({
            tool: event.title ?? "",
            commandLine: event.summary,
            policy: ctx.policy,
          });
          if (!verdict.allowed) {
            void adapter.interruptTurn(ctx.executionThreadId, event.turnId ?? startedTurnId).catch(() => {});
            finish({ ok: false, text: accumulated || undefined, error: verdict.reason });
            ctx.failClosed(verdict.reason);
            return;
          }
        }

        if (event.type === "content.delta" && event.streamKind === "assistant_text") {
          accumulated += event.delta;
        } else if (event.type === "item.completed" && event.itemType === "assistant_text" && !accumulated) {
          accumulated = event.text;
        }

        ctx.onEvent(event);

        if (event.type === "turn.completed") {
          finish({
            ok: event.ok,
            text: accumulated || undefined,
            ...(event.ok ? {} : { error: event.stopReason ?? "Read-only worker turn failed." }),
          });
        } else if (event.type === "runtime.error" && event.terminal) {
          finish({ ok: false, text: accumulated || undefined, error: event.message });
        } else if (event.type === "session.exited") {
          finish({ ok: false, text: accumulated || undefined, error: event.reason ?? "Read-only worker session exited." });
        } else if (event.type === "cap.exhausted") {
          finish({ ok: false, text: accumulated || undefined, error: "Read-only worker exhausted its step budget." });
        }
      });

      void adapter
        .sendTurn(safeInput)
        .then((res) => {
          startedTurnId = res.turnId;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          ctx.onEvent({
            eventId: genId(),
            provider: adapter.provider,
            ...(options.instanceId ? { providerInstanceId: options.instanceId } : {}),
            threadId: ctx.executionThreadId,
            turnId: ctx.workerTurnId,
            createdAt: new Date().toISOString(),
            type: "runtime.error",
            terminal: true,
            message,
          });
          finish({ ok: false, error: message });
        });
    });
  };
}

export interface TextGeneratorWorkerOptions {
  generateText(prompt: string, opts: { signal: AbortSignal }): Promise<string>;
  provider?: string;
  chunkSize?: number;
  generateId?: () => string;
}

/** Lightweight tool-free concurrent worker executor emitting synthetic isolated streaming frames. */
export function createTextGeneratorWorkerExecutor(options: TextGeneratorWorkerOptions): ReadOnlyWorkerExecutor {
  const provider = options.provider ?? "readonly-worker";
  const chunkSize = Math.max(16, options.chunkSize ?? 64);
  const genId = options.generateId ?? newId;

  return async (ctx) => {
    const itemId = `${ctx.workerTurnId}:msg`;
    ctx.onEvent({
      eventId: genId(),
      provider,
      threadId: ctx.executionThreadId,
      turnId: ctx.workerTurnId,
      createdAt: new Date().toISOString(),
      type: "turn.started",
      requestMessageId: ctx.replyToId,
    });

    try {
      const answer = await options.generateText(ctx.prompt, { signal: ctx.signal });
      if (ctx.signal.aborted) {
        return { ok: false, error: "Worker aborted or timed out." };
      }
      for (let i = 0; i < answer.length; i += chunkSize) {
        const delta = answer.slice(i, i + chunkSize);
        ctx.onEvent({
          eventId: genId(),
          provider,
          threadId: ctx.executionThreadId,
          turnId: ctx.workerTurnId,
          itemId,
          createdAt: new Date().toISOString(),
          type: "content.delta",
          streamKind: "assistant_text",
          delta,
        });
      }
      ctx.onEvent({
        eventId: genId(),
        provider,
        threadId: ctx.executionThreadId,
        turnId: ctx.workerTurnId,
        itemId,
        createdAt: new Date().toISOString(),
        type: "item.completed",
        itemType: "assistant_text",
        text: answer,
      });
      ctx.onEvent({
        eventId: genId(),
        provider,
        threadId: ctx.executionThreadId,
        turnId: ctx.workerTurnId,
        createdAt: new Date().toISOString(),
        type: "turn.completed",
        ok: true,
      });
      return { ok: true, text: answer };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.onEvent({
        eventId: genId(),
        provider,
        threadId: ctx.executionThreadId,
        turnId: ctx.workerTurnId,
        createdAt: new Date().toISOString(),
        type: "turn.completed",
        ok: false,
        stopReason: message,
      });
      return { ok: false, error: message };
    }
  };
}

export interface ReadOnlyTimelineAdapter extends TimelineMergeStore {
  prepareUserMessage(input: {
    threadId: string;
    text: string;
    userMessageId?: string;
    parentTurnId?: string;
    workerTurnId: string;
    sendId?: string;
    sender?: ResolvedSender;
    replyToId?: string;
    now?: number;
  }): WorkerMessage;
  commitWorkerReply(input: {
    threadId: string;
    workerId: string;
    workerTurnId: string;
    parentTurnId?: string;
    userMessageId: string;
    userText: string;
    sendId?: string;
    sender?: ResolvedSender;
    replyText: string;
    itemId?: string;
    succeeded: boolean;
    now?: number;
  }): { userMessage: WorkerMessage; assistantMessage: WorkerMessage | null };
}

/** Builds a persistence adapter bridging concurrent worker messages into the shared thread timeline. */
export function createReadOnlyTimelineAdapter(deps: {
  store: TimelineMergeStore;
  markExternalContext?: (threadId: string) => void;
}): ReadOnlyTimelineAdapter {
  return {
    messagesFor: (threadId) => deps.store.messagesFor(threadId),
    appendMessage: (threadId, message) => deps.store.appendMessage(threadId, message),
    patchMessage: (threadId, messageId, patch) => deps.store.patchMessage(threadId, messageId, patch),

    prepareUserMessage(input) {
      const now = input.now ?? Date.now();
      const intake = buildWorkerIntakeMetadata({
        state: "processing",
        parentTurnId: input.parentTurnId,
        workerTurnId: input.workerTurnId,
        updatedAt: now,
      });
      if (input.userMessageId) {
        const existing = deps.store.messagesFor(input.threadId).find((m) => m.id === input.userMessageId);
        if (existing) {
          return (
            deps.store.patchMessage(input.threadId, existing.id, { intake }) ?? {
              ...existing,
              intake,
            }
          );
        }
      }
      return deps.store.appendMessage(
        input.threadId,
        buildWorkerUserMessageDraft({
          text: input.text,
          parentTurnId: input.parentTurnId,
          workerTurnId: input.workerTurnId,
          sendId: input.sendId,
          sender: input.sender,
          replyToId: input.replyToId,
          now,
        }),
      );
    },

    commitWorkerReply(input) {
      return mergeWorkerReplyIntoTimeline({
        store: deps.store,
        ...input,
        markExternalContext: deps.markExternalContext,
      });
    },
  };
}

export interface DispatchReadOnlyWorkerRequest extends Omit<ReadOnlyWorkerEligibilityInput, "activeWorkerCount"> {
  threadId: string;
  botId: string;
  parentTurnId?: string;
  primaryTaskHint?: string;
  userMessageId?: string;
  sendId?: string;
  sender?: ResolvedSender;
  replyToId?: string;
  timeoutMs?: number;
  excludedSnapshotIds?: ReadonlySet<string>;
}

export interface ReadOnlyWorkerOutcome {
  readonly workerId: string;
  readonly workerTurnId: string;
  readonly threadId: string;
  readonly replyToId: string;
  readonly state: "completed" | "failed" | "cancelled" | "timed_out";
  readonly text: string;
  readonly assistantMessageId?: string;
  readonly error?: string;
}

export type DispatchReadOnlyWorkerResult =
  | {
      accepted: true;
      workerId: string;
      workerTurnId: string;
      executionThreadId: string;
      userMessageId: string;
      replyToId: string;
      classification: ReadOnlyWorkerClassification;
      intake: ProgressiveIntakeMetadata;
      concurrentWorker: ConcurrentWorkerMetadata;
      done: Promise<ReadOnlyWorkerOutcome>;
    }
  | {
      accepted: false;
      decision: Extract<ReadOnlyWorkerEligibilityDecision, { eligible: false }>;
    };

export interface ReadOnlyWorkerCoordinatorDeps {
  timeline: ReadOnlyTimelineAdapter;
  execute: ReadOnlyWorkerExecutor;
  writeLockGuard?: WriteLockGuard;
  emitFrame?: (frame: ReadOnlyWorkerSseFrame) => void;
  maxConcurrentPerThread?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
  generateId?: () => string;
}

interface ActiveSlot {
  record: ReadOnlyWorkerRecord;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  cancelReason?: "cancelled" | "timed_out";
  settled: boolean;
}

export interface ReadOnlyWorkerCoordinator {
  canHandle(
    input: Omit<ReadOnlyWorkerEligibilityInput, "activeWorkerCount"> & { threadId: string },
  ): ReadOnlyWorkerEligibilityDecision;
  dispatch(request: DispatchReadOnlyWorkerRequest): Promise<DispatchReadOnlyWorkerResult>;
  cancelWorker(workerId: string, reason?: string): Promise<boolean>;
  cancelThreadWorkers(threadId: string, reason?: string): Promise<number>;
  activeWorkers(threadId?: string): ReadOnlyWorkerRecord[];
  statusSnapshot(threadId: string): {
    active: ReadOnlyWorkerRecord[];
    count: number;
    writeLock: ReadOnlyWriteLockSnapshot;
  };
  dispose(): Promise<void>;
}

/** Coordinates concurrent in-thread read-only workers with strict SSE, lock, timeout, and timeline isolation. */
export function createReadOnlyWorkerCoordinator(
  deps: ReadOnlyWorkerCoordinatorDeps,
): ReadOnlyWorkerCoordinator {
  const guard = deps.writeLockGuard ?? new WriteLockGuard();
  const maxPerThread = deps.maxConcurrentPerThread ?? 3;
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  const genId = deps.generateId ?? newId;

  const slotsByWorkerId = new Map<string, ActiveSlot>();
  const workerIdsByThread = new Map<string, Set<string>>();
  const settledOutcomes = new Map<string, Promise<ReadOnlyWorkerOutcome>>();

  const activeCountFor = (threadId: string): number => workerIdsByThread.get(threadId)?.size ?? 0;

  const emitIntakeFrame = (
    record: ReadOnlyWorkerRecord,
    intakeState: ProgressiveIntakeMetadata["state"],
    error?: string,
  ) => {
    deps.emitFrame?.({
      kind: "worker.intake",
      threadId: record.threadId,
      workerId: record.workerId,
      messageId: record.userMessageId,
      replyToId: record.replyToId,
      state: record.state,
      intake: buildWorkerIntakeMetadata({
        state: intakeState,
        parentTurnId: record.parentTurnId,
        workerTurnId: record.workerTurnId,
        updatedAt: record.updatedAt,
      }),
      concurrentWorker: buildConcurrentWorkerMetadata({
        workerId: record.workerId,
        parentTurnId: record.parentTurnId,
      }),
      ...(error ? { error: redactSecretsInText(error) } : {}),
    });
  };

  function releaseSlot(slot: ActiveSlot): void {
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
    slotsByWorkerId.delete(slot.record.workerId);
    const set = workerIdsByThread.get(slot.record.threadId);
    if (set) {
      set.delete(slot.record.workerId);
      if (set.size === 0) workerIdsByThread.delete(slot.record.threadId);
    }
    guard.unregisterWorker(slot.record.threadId, slot.record.workerId);
  }

  return {
    canHandle(input) {
      return evaluateReadOnlyWorkerEligibility({
        ...input,
        activeWorkerCount: activeCountFor(input.threadId),
        maxConcurrentWorkers: input.maxConcurrentWorkers ?? maxPerThread,
      });
    },

    async dispatch(request) {
      const decision = evaluateReadOnlyWorkerEligibility({
        ...request,
        activeWorkerCount: activeCountFor(request.threadId),
        maxConcurrentWorkers: request.maxConcurrentWorkers ?? maxPerThread,
      });
      if (!decision.eligible) {
        return { accepted: false, decision };
      }

      const ids = allocateWorkerIds(request.threadId, genId);
      guard.assertWorkerIsolated({
        threadId: request.threadId,
        workerId: ids.workerId,
        wantsWriteLock: false,
        wantsTurnResources: false,
        writesMemoryJournal: false,
        mutatesResumeCursor: false,
      });

      const snapshot = buildReadOnlyContextSnapshot({
        threadId: request.threadId,
        parentTurnId: request.parentTurnId,
        messages: deps.timeline.messagesFor(request.threadId),
        excludedIds: new Set([
          ...(request.excludedSnapshotIds ?? []),
          ...(request.userMessageId ? [request.userMessageId] : []),
        ]),
        capturedAt: now(),
      });

      const startedAt = now();
      const userMessage = deps.timeline.prepareUserMessage({
        threadId: request.threadId,
        text: request.text,
        userMessageId: request.userMessageId,
        parentTurnId: request.parentTurnId,
        workerTurnId: ids.workerTurnId,
        sendId: request.sendId,
        sender: request.sender,
        replyToId: request.replyToId,
        now: startedAt,
      });

      const prompt = buildReadOnlyWorkerPrompt({
        query: request.text,
        snapshot,
        primaryTaskHint: request.primaryTaskHint,
      });

      const record: ReadOnlyWorkerRecord = {
        workerId: ids.workerId,
        workerTurnId: ids.workerTurnId,
        executionThreadId: ids.executionThreadId,
        threadId: request.threadId,
        botId: request.botId,
        ...(request.parentTurnId ? { parentTurnId: request.parentTurnId } : {}),
        userMessageId: userMessage.id,
        replyToId: userMessage.id,
        query: request.text,
        classification: decision.classification,
        state: "running",
        startedAt,
        updatedAt: startedAt,
        accumulatedText: "",
      };

      const controller = new AbortController();
      const slot: ActiveSlot = { record, controller, settled: false };
      slotsByWorkerId.set(ids.workerId, slot);
      let threadSet = workerIdsByThread.get(request.threadId);
      if (!threadSet) {
        threadSet = new Set();
        workerIdsByThread.set(request.threadId, threadSet);
      }
      threadSet.add(ids.workerId);
      guard.registerWorker(request.threadId, ids.workerId);

      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      if (timeoutMs > 0) {
        slot.timer = setTimeout(() => {
          if (slot.settled) return;
          slot.cancelReason = "timed_out";
          controller.abort();
        }, timeoutMs);
        slot.timer.unref?.();
      }

      emitIntakeFrame(record, "processing");

      const done = (async (): Promise<ReadOnlyWorkerOutcome> => {
        let execResult: WorkerExecutionResult;
        try {
          execResult = await deps.execute({
            workerId: ids.workerId,
            workerTurnId: ids.workerTurnId,
            executionThreadId: ids.executionThreadId,
            threadId: request.threadId,
            botId: request.botId,
            parentTurnId: request.parentTurnId,
            replyToId: userMessage.id,
            query: request.text,
            prompt,
            snapshot,
            policy: decision.policy,
            signal: controller.signal,
            onEvent: (event) => {
              if (slot.settled) return;
              if (event.type === "content.delta" && event.streamKind === "assistant_text") {
                record.state = "streaming";
                record.accumulatedText += event.delta;
              } else if (event.type === "item.completed" && event.itemType === "assistant_text" && !record.accumulatedText) {
                record.accumulatedText = event.text;
              }
              record.updatedAt = now();
              deps.emitFrame?.(
                toIsolatedWorkerSseFrame(event, {
                  parentThreadId: request.threadId,
                  workerId: ids.workerId,
                  workerTurnId: ids.workerTurnId,
                  parentTurnId: request.parentTurnId,
                  replyToId: userMessage.id,
                }),
              );
            },
            failClosed: (reason) => {
              record.error = redactSecretsInText(reason);
              controller.abort();
            },
          });
        } catch (error) {
          execResult = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        slot.settled = true;
        const completedAt = now();
        record.completedAt = completedAt;
        record.updatedAt = completedAt;

        const finalText = (execResult.text ?? record.accumulatedText).trim();
        const finalState: ReadOnlyWorkerOutcome["state"] =
          slot.cancelReason === "timed_out"
            ? "timed_out"
            : slot.cancelReason === "cancelled"
              ? "cancelled"
              : execResult.ok
                ? "completed"
                : "failed";
        record.state = finalState;

        const errorText =
          finalState === "timed_out"
            ? (execResult.error ?? "Concurrent read-only worker timed out.")
            : finalState === "cancelled"
              ? (record.error ?? execResult.error ?? "Concurrent read-only worker was cancelled.")
              : finalState === "failed"
                ? (record.error ?? execResult.error ?? "Concurrent read-only worker failed.")
                : undefined;
        if (errorText) record.error = redactSecretsInText(errorText);

        let mergedAssistant: WorkerMessage | null = null;
        try {
          const merged = deps.timeline.commitWorkerReply({
            threadId: request.threadId,
            workerId: ids.workerId,
            workerTurnId: ids.workerTurnId,
            parentTurnId: request.parentTurnId,
            userMessageId: userMessage.id,
            userText: escapeNotes(request.text),
            sendId: request.sendId,
            sender: request.sender,
            replyText: finalState === "completed" ? finalText : "",
            itemId: `${ids.workerTurnId}:reply`,
            succeeded: finalState === "completed" && Boolean(finalText),
            now: completedAt,
          });
          mergedAssistant = merged.assistantMessage;
          if (mergedAssistant) record.assistantMessageId = mergedAssistant.id;
        } finally {
          releaseSlot(slot);
        }

        emitIntakeFrame(record, finalState === "completed" ? "answered" : "superseded", record.error);

        return {
          workerId: ids.workerId,
          workerTurnId: ids.workerTurnId,
          threadId: request.threadId,
          replyToId: userMessage.id,
          state: finalState,
          text: finalState === "completed" ? finalText : "",
          ...(mergedAssistant ? { assistantMessageId: mergedAssistant.id } : {}),
          ...(record.error ? { error: record.error } : {}),
        };
      })();

      settledOutcomes.set(ids.workerId, done);
      void done.finally(() => {
        settledOutcomes.delete(ids.workerId);
      });

      return {
        accepted: true,
        workerId: ids.workerId,
        workerTurnId: ids.workerTurnId,
        executionThreadId: ids.executionThreadId,
        userMessageId: userMessage.id,
        replyToId: userMessage.id,
        classification: decision.classification,
        intake: buildWorkerIntakeMetadata({
          state: "processing",
          parentTurnId: request.parentTurnId,
          workerTurnId: ids.workerTurnId,
          updatedAt: startedAt,
        }),
        concurrentWorker: buildConcurrentWorkerMetadata({
          workerId: ids.workerId,
          parentTurnId: request.parentTurnId,
        }),
        done,
      };
    },

    async cancelWorker(workerId, reason) {
      const slot = slotsByWorkerId.get(workerId);
      if (!slot || slot.settled) return false;
      slot.cancelReason = "cancelled";
      if (reason) slot.record.error = redactSecretsInText(reason);
      slot.controller.abort();
      await settledOutcomes.get(workerId)?.catch(() => undefined);
      return true;
    },

    async cancelThreadWorkers(threadId, reason) {
      const ids = [...(workerIdsByThread.get(threadId) ?? [])];
      if (ids.length === 0) return 0;
      const results = await Promise.all(ids.map((id) => this.cancelWorker(id, reason)));
      return results.filter(Boolean).length;
    },

    activeWorkers(threadId) {
      const all = [...slotsByWorkerId.values()].map((slot) => ({ ...slot.record }));
      return threadId ? all.filter((record) => record.threadId === threadId) : all;
    },

    statusSnapshot(threadId) {
      const active = this.activeWorkers(threadId);
      return {
        active,
        count: active.length,
        writeLock: guard.snapshot(threadId),
      };
    },

    async dispose() {
      const allIds = [...slotsByWorkerId.keys()];
      await Promise.all(allIds.map((id) => this.cancelWorker(id, "Coordinator disposed.")));
    },
  };
}

export interface ProgressiveReadOnlyIntakeHook {
  tryRouteReadOnlyConcurrent(request: DispatchReadOnlyWorkerRequest): Promise<
    | {
        handled: true;
        workerId: string;
        workerTurnId: string;
        userMessageId: string;
        replyToId: string;
        intake: ProgressiveIntakeMetadata;
        concurrentWorker: ConcurrentWorkerMetadata;
        done: Promise<ReadOnlyWorkerOutcome>;
      }
    | {
        handled: false;
        fallback: ReadOnlyFallbackChannel;
        decision: Extract<ReadOnlyWorkerEligibilityDecision, { eligible: false }>;
      }
  >;
}

/** Thin typed adapter for Slice 1 (progressive-intake / bot-messages) post-merge integration. */
export function createProgressiveReadOnlyIntakeHook(
  coordinator: Pick<ReadOnlyWorkerCoordinator, "dispatch">,
): ProgressiveReadOnlyIntakeHook {
  return {
    async tryRouteReadOnlyConcurrent(request) {
      const result = await coordinator.dispatch(request);
      if (!result.accepted) {
        return {
          handled: false,
          fallback: result.decision.fallback,
          decision: result.decision,
        };
      }
      return {
        handled: true,
        workerId: result.workerId,
        workerTurnId: result.workerTurnId,
        userMessageId: result.userMessageId,
        replyToId: result.replyToId,
        intake: result.intake,
        concurrentWorker: result.concurrentWorker,
        done: result.done,
      };
    },
  };
}
