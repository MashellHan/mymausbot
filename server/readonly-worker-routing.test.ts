import { describe, expect, it } from "vitest";

import type { ProviderAdapter, RequestOutcome, RuntimeEvent, SendTurnInput } from "./contracts.ts";
import { WriteLockGuard, type TimelineMergeStore, type WorkerMessage } from "./readonly-worker.ts";
import {
  createProgressiveReadOnlyIntakeHook,
  createProviderAdapterWorkerExecutor,
  createReadOnlyTimelineAdapter,
  createReadOnlyWorkerCoordinator,
  createTextGeneratorWorkerExecutor,
  isolateWorkerRuntimeEvent,
  READONLY_WORKER_REQUEST_REFUSAL,
  type ReadOnlyWorkerSseFrame,
} from "./readonly-worker-routing.ts";

function makeMemoryTimeline(threadId = "t-1", seed: WorkerMessage[] = []): TimelineMergeStore {
  const byThread = new Map<string, WorkerMessage[]>([[threadId, seed.map((m) => ({ ...m }))]]);
  let nextId = 1;
  return {
    messagesFor(id) {
      return [...(byThread.get(id) ?? [])];
    },
    appendMessage(id, draft) {
      const list = byThread.get(id) ?? [];
      const created: WorkerMessage = { ...draft, id: `msg-${nextId++}`, at: draft.at ?? Date.now() };
      list.push(created);
      byThread.set(id, list);
      return created;
    },
    patchMessage(id, messageId, patch) {
      const list = byThread.get(id);
      if (!list) return null;
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx === -1) return null;
      const updated = { ...list[idx], ...patch };
      list[idx] = updated;
      return updated;
    },
  };
}

class MockReadOnlyAdapter implements Pick<ProviderAdapter, "provider" | "sendTurn" | "interruptTurn" | "respondToRequest" | "onEvent"> {
  readonly provider = "claude";
  readonly sentInputs: SendTurnInput[] = [];
  readonly interrupted: Array<{ threadId: string; turnId?: string }> = [];
  readonly requestResponses: Array<{ threadId: string; requestId: string; behavior: string; message?: string }> = [];
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private turnSeq = 1;

  onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async sendTurn(input: SendTurnInput): Promise<{ turnId: string }> {
    this.sentInputs.push(input);
    return { turnId: `adapter-turn-${this.turnSeq++}` };
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<void> {
    this.interrupted.push({ threadId, turnId });
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: { behavior: "allow" | "deny" | "answer"; message?: string; always?: boolean },
  ): Promise<RequestOutcome> {
    this.requestResponses.push({ threadId, requestId, behavior: decision.behavior, message: decision.message });
    return decision.behavior === "answer" ? "answered" : decision.behavior === "allow" ? "allowed-once" : "rejected";
  }
}

describe("createReadOnlyWorkerCoordinator & SSE frame isolation", () => {
  it("runs concurrent in-thread read-only queries alongside an active primary write lock without cross-talk", async () => {
    const store = makeMemoryTimeline("t-1", [
      { id: "m-0", role: "user", kind: "text", text: "Migrate database layer", at: 10 },
      { id: "m-main", role: "bot", kind: "text", text: "Migrating tables...", turnId: "turn-main", requestPending: true, at: 11 },
    ]);
    const guard = new WriteLockGuard();
    guard.acquirePrimaryLock({ threadId: "t-1", turnId: "turn-main", workspaceKey: "/repo", actorRole: "primary" });

    const frames: ReadOnlyWorkerSseFrame[] = [];
    const externalMarks: string[] = [];
    let counter = 1;

    const coordinator = createReadOnlyWorkerCoordinator({
      timeline: createReadOnlyTimelineAdapter({ store, markExternalContext: (id) => externalMarks.push(id) }),
      writeLockGuard: guard,
      emitFrame: (frame) => frames.push(frame),
      generateId: () => `id0000000000${counter++}`,
      execute: createTextGeneratorWorkerExecutor({
        chunkSize: 16,
        generateText: async (prompt) => {
          expect(prompt).toContain("Migrate database layer");
          return "SSE pushes one-way events over HTTP with automatic reconnect.";
        },
      }),
    });

    const dispatched = await coordinator.dispatch({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      primaryTaskHint: "Database migration",
      text: "What's the difference between SSE and polling?",
    });

    expect(dispatched.accepted).toBe(true);
    if (!dispatched.accepted) return;

    expect(dispatched.executionThreadId).toBe(`readonly-worker:t-1:${dispatched.workerId}`);
    expect(dispatched.replyToId).toBe(dispatched.userMessageId);
    expect(dispatched.concurrentWorker).toEqual({
      workerId: dispatched.workerId,
      readOnly: true,
      parentTurnId: "turn-main",
    });

    // Primary lock remains exclusively owned by turn-main; active worker never holds write lock.
    expect(coordinator.statusSnapshot("t-1").writeLock).toMatchObject({
      primaryLocked: true,
      primaryTurnId: "turn-main",
      workerHoldsWriteLock: false,
    });

    const outcome = await dispatched.done;
    expect(outcome.state).toBe("completed");
    expect(outcome.replyToId).toBe(dispatched.userMessageId);
    expect(outcome.assistantMessageId).toBeTruthy();

    // Runtime frames were isolated into worker.runtime envelopes (never primary `runtime` frames)
    // and carried worker-scoped turnId/itemId and replyToId anchors.
    const runtimeFrames = frames.filter((f): f is Extract<ReadOnlyWorkerSseFrame, { kind: "worker.runtime" }> => f.kind === "worker.runtime");
    expect(runtimeFrames.length).toBeGreaterThanOrEqual(3);
    for (const frame of runtimeFrames) {
      expect(frame.threadId).toBe("t-1");
      expect(frame.replyToId).toBe(dispatched.userMessageId);
      expect(frame.concurrentWorker).toEqual({
        workerId: dispatched.workerId,
        readOnly: true,
        parentTurnId: "turn-main",
      });
      expect(frame.event.turnId).toBe(dispatched.workerTurnId);
      expect(frame.event.itemId?.startsWith(`${dispatched.workerTurnId}:`)).toBe(true);
    }

    const intakeFrames = frames.filter((f): f is Extract<ReadOnlyWorkerSseFrame, { kind: "worker.intake" }> => f.kind === "worker.intake");
    expect(intakeFrames.map((f) => f.intake.state)).toEqual(["processing", "answered"]);
    expect(externalMarks).toEqual(["t-1"]);
    expect(coordinator.statusSnapshot("t-1").count).toBe(0);
    expect(guard.snapshot("t-1").primaryLocked).toBe(true);
  });

  it("isolates runtime events with secret redaction and worker-scoped IDs", () => {
    const isolated = isolateWorkerRuntimeEvent(
      {
        eventId: "e-1",
        provider: "claude",
        threadId: "readonly-worker:t-1:ro_1",
        turnId: "provider-turn",
        itemId: "item-1",
        createdAt: "2026-11-26T00:00:00.000Z",
        type: "content.delta",
        streamKind: "assistant_text",
        delta: "Token sk-ant-api03-1234567890abcdefghij1234567890 leaked",
      },
      {
        parentThreadId: "t-1",
        workerId: "ro_1",
        workerTurnId: "worker-ro_1",
        parentTurnId: "turn-main",
        replyToId: "u-9",
      },
    );

    expect(isolated.threadId).toBe("t-1");
    expect(isolated.turnId).toBe("worker-ro_1");
    expect(isolated.itemId).toBe("worker-ro_1:item-1");
    if (isolated.type === "content.delta") {
      expect(isolated.delta).not.toContain("sk-ant-api03-1234567890abcdefghij1234567890");
    }
  });

  it("denies adapter permission/question cards fail-closed and blocks non-read tool execution mid-stream", async () => {
    const store = makeMemoryTimeline("t-1");
    const adapter = new MockReadOnlyAdapter();
    const coordinator = createReadOnlyWorkerCoordinator({
      timeline: createReadOnlyTimelineAdapter({ store }),
      execute: createProviderAdapterWorkerExecutor({
        adapter,
        baseTurnInput: {
          resumeCursor: { main: true },
          approvalMode: "full",
          preloadBrowserTools: true,
        } as unknown as Partial<Omit<SendTurnInput, "threadId" | "text">>,
      }),
    });

    // Case 1: Adapter opens an interactive permission card -> immediately denied & interrupted.
    const first = await coordinator.dispatch({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      text: "Check package scripts",
    });
    expect(first.accepted).toBe(true);
    if (!first.accepted) return;

    await Promise.resolve();
    expect(adapter.sentInputs[0]).toMatchObject({
      threadId: first.executionThreadId,
      approvalMode: "ask",
      sessionReset: true,
      ephemeral: true,
      resumeCursor: undefined,
      preloadBrowserTools: false,
    });

    adapter.emit({
      eventId: "ev-req",
      provider: "claude",
      threadId: first.executionThreadId,
      turnId: "adapter-turn-1",
      requestId: "req-1",
      createdAt: new Date().toISOString(),
      type: "request.opened",
      requestType: "permission",
      tool: "Bash",
      summary: "Run ls",
    });

    const outcome1 = await first.done;
    expect(outcome1.state).toBe("failed");
    expect(outcome1.error).toContain("denied by read-only worker policy");
    expect(adapter.requestResponses[0]).toEqual({
      threadId: first.executionThreadId,
      requestId: "req-1",
      behavior: "deny",
      message: READONLY_WORKER_REQUEST_REFUSAL,
    });
    expect(adapter.interrupted[0]).toEqual({ threadId: first.executionThreadId, turnId: "adapter-turn-1" });

    // Case 2: Adapter emits a disallowed write tool item.started -> aborted fail-closed.
    const second = await coordinator.dispatch({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      text: "Check package.json",
    });
    expect(second.accepted).toBe(true);
    if (!second.accepted) return;

    await Promise.resolve();
    adapter.emit({
      eventId: "ev-tool",
      provider: "claude",
      threadId: second.executionThreadId,
      turnId: "adapter-turn-2",
      itemId: "tool-1",
      createdAt: new Date().toISOString(),
      type: "item.started",
      itemType: "tool",
      title: "Edit",
      summary: "Edit package.json",
    });

    const outcome2 = await second.done;
    expect(outcome2.state).toBe("failed");
    expect(outcome2.error).toContain("forbidden in read-only concurrent mode");

    // Case 3: Allowed read tool followed by answer completes cleanly.
    const third = await coordinator.dispatch({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      text: "Read README title",
    });
    expect(third.accepted).toBe(true);
    if (!third.accepted) return;

    await Promise.resolve();
    adapter.emit({
      eventId: "ev-read-start",
      provider: "claude",
      threadId: third.executionThreadId,
      turnId: "adapter-turn-3",
      itemId: "tool-read",
      createdAt: new Date().toISOString(),
      type: "item.started",
      itemType: "tool",
      title: "Read",
    });
    adapter.emit({
      eventId: "ev-delta",
      provider: "claude",
      threadId: third.executionThreadId,
      turnId: "adapter-turn-3",
      itemId: "msg-1",
      createdAt: new Date().toISOString(),
      type: "content.delta",
      streamKind: "assistant_text",
      delta: "OpenMausBot",
    });
    adapter.emit({
      eventId: "ev-done",
      provider: "claude",
      threadId: third.executionThreadId,
      turnId: "adapter-turn-3",
      createdAt: new Date().toISOString(),
      type: "turn.completed",
      ok: true,
    });

    const outcome3 = await third.done;
    expect(outcome3).toMatchObject({
      state: "completed",
      text: "OpenMausBot",
    });
  });

  it("handles cancellation, timeout cleanup, concurrency cap, and Slice-1 intake hook fallback", async () => {
    const store = makeMemoryTimeline("t-1");
    const frames: ReadOnlyWorkerSseFrame[] = [];

    const coordinator = createReadOnlyWorkerCoordinator({
      timeline: createReadOnlyTimelineAdapter({ store }),
      emitFrame: (frame) => frames.push(frame),
      maxConcurrentPerThread: 1,
      execute: async (ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            resolve({ ok: false, error: "Aborted" });
          });
        }),
    });

    const hook = createProgressiveReadOnlyIntakeHook(coordinator);

    // Non-read-only intent cleanly delegates back to fallback channel for Slice 1.
    const rejected = await hook.tryRouteReadOnlyConcurrent({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      text: "Also modify server/index.ts",
    });
    expect(rejected.handled).toBe(false);
    if (!rejected.handled) {
      expect(rejected.fallback).toBe("progressive-continue");
    }

    // Active worker can be cancelled explicitly and frees capacity slot.
    const active = await hook.tryRouteReadOnlyConcurrent({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      text: "What is MCP?",
    });
    expect(active.handled).toBe(true);
    if (!active.handled) return;

    const secondWhileBusy = await hook.tryRouteReadOnlyConcurrent({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      text: "What is SSE?",
    });
    expect(secondWhileBusy).toMatchObject({
      handled: false,
      decision: { reasonCode: "concurrency_limit_reached" },
    });

    expect(await coordinator.cancelWorker(active.workerId, "User closed panel")).toBe(true);
    const cancelledOutcome = await active.done;
    expect(cancelledOutcome.state).toBe("cancelled");
    expect(cancelledOutcome.error).toBe("User closed panel");
    expect(coordinator.statusSnapshot("t-1").count).toBe(0);

    // Timeout cleanup releases slot and transitions intake state to superseded.
    const timedOut = await coordinator.dispatch({
      threadId: "t-1",
      botId: "bot-1",
      parentTurnId: "turn-main",
      primaryTurnActive: true,
      text: "What is SSE?",
      timeoutMs: 15,
    });
    expect(timedOut.accepted).toBe(true);
    if (!timedOut.accepted) return;
    const timeoutOutcome = await timedOut.done;
    expect(timeoutOutcome.state).toBe("timed_out");
    expect(coordinator.statusSnapshot("t-1").count).toBe(0);

    await coordinator.dispose();
  });
});
