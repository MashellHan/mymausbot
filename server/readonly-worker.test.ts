import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { READ_ONLY_AGENT_TOOL_NAMES } from "./agent-tool-policy.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection, SendTurnInput } from "./contracts.ts";
import {
  allocateWorkerIds,
  authorizeWorkerToolCall,
  buildConcurrentWorkerMetadata,
  buildReadOnlyContextSnapshot,
  buildReadOnlyWorkerPrompt,
  buildWorkerIntakeMetadata,
  createReadOnlyToolScope,
  createReadOnlyWorkerPolicy,
  DEFAULT_MAX_CONCURRENT_WORKERS,
  evaluateReadOnlyWorkerEligibility,
  MAX_READONLY_QUERY_CHARS,
  mergeWorkerReplyIntoTimeline,
  ReadOnlyWorkerIsolationError,
  sanitizeWorkerSendTurnInput,
  WriteLockGuard,
  type TimelineMergeStore,
  type WorkerMessage,
} from "./readonly-worker.ts";
import { bindSafetyFloor } from "./safety-floor-gate.ts";
import { Store } from "./store.ts";
import { allowsTool, narrowsNativeTools, parseToolScope } from "../shared/tool-scope.ts";
import { assertToolScopeSupported } from "../shared/tool-scope-support.ts";

function makeInMemoryTimelineStore(seed: WorkerMessage[] = []): TimelineMergeStore {
  const byThread = new Map<string, WorkerMessage[]>();
  byThread.set(
    "t-1",
    seed.map((m) => ({ ...m })),
  );
  let seq = 1;

  return {
    messagesFor(threadId) {
      return [...(byThread.get(threadId) ?? [])];
    },
    appendMessage(threadId, draft) {
      const list = byThread.get(threadId) ?? [];
      const created: WorkerMessage = {
        ...draft,
        id: `m-${seq++}`,
        at: draft.at ?? Date.now(),
      };
      list.push(created);
      byThread.set(threadId, list);
      return created;
    },
    patchMessage(threadId, messageId, patch) {
      const list = byThread.get(threadId);
      if (!list) return null;
      const idx = list.findIndex((m) => m.id === messageId);
      if (idx === -1) return null;
      const updated: WorkerMessage = { ...list[idx], ...patch };
      list[idx] = updated;
      return updated;
    },
  };
}

describe("evaluateReadOnlyWorkerEligibility", () => {
  beforeEach(() => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }));
  });

  it("admits independent lightweight Q&A and read-only queries while a primary turn runs", () => {
    const qaEnglish = evaluateReadOnlyWorkerEligibility({
      primaryTurnActive: true,
      text: "What's the difference between SSE and WebSocket?",
    });
    expect(qaEnglish.eligible).toBe(true);
    if (qaEnglish.eligible) {
      expect(qaEnglish.classification).toBe("light-qa");
      expect(qaEnglish.reasonCode).toBe("admitted_light_qa");
      expect(qaEnglish.policy.readOnly).toBe(true);
      expect(qaEnglish.policy.acquireWorkspaceWriteLock).toBe(false);
    }

    const qaChinese = evaluateReadOnlyWorkerEligibility({
      primaryTurnActive: true,
      text: "解释一下事件循环原理",
    });
    expect(qaChinese.eligible).toBe(true);
    if (qaChinese.eligible) {
      expect(qaChinese.classification).toBe("light-qa");
    }

    const readQuery = evaluateReadOnlyWorkerEligibility({
      primaryTurnActive: true,
      text: "Can you check git status?",
    });
    expect(readQuery.eligible).toBe(true);
    if (readQuery.eligible) {
      expect(readQuery.classification).toBe("readonly-query");
      expect(readQuery.reasonCode).toBe("admitted_readonly_query");
    }

    const cnProgressQuery = evaluateReadOnlyWorkerEligibility({
      primaryTurnActive: true,
      text: "帮我看下目前进度到哪了",
    });
    expect(cnProgressQuery.eligible).toBe(true);
    if (cnProgressQuery.eligible) {
      expect(cnProgressQuery.classification).toBe("readonly-query");
    }
  });

  it("rejects concurrent dispatch when gate prerequisites fail", () => {
    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, enabled: false, text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "disabled", fallback: "progressive-continue" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: false, text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "no_active_primary_turn", fallback: "progressive-continue" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, guarded: true, text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "guarded_route", fallback: "refuse" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, roomThread: true, text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "room_thread", fallback: "progressive-continue" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, confined: true, text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "confined_thread", fallback: "progressive-continue" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, followUp: "restart", text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "explicit_restart", fallback: "soft-redirect" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, followUp: "queue", text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "explicit_queue", fallback: "progressive-continue" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, followUp: "steer", text: "What is vitest?" }),
    ).toMatchObject({ eligible: false, reasonCode: "explicit_steer", fallback: "live-steer" });
  });

  it("rejects pending approvals/questions, non-plain-text inputs, oversized prompts, and capacity saturation", () => {
    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, hasPendingApproval: true, text: "What is X?" }),
    ).toMatchObject({ eligible: false, reasonCode: "pending_interactive_card" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, hasPendingQuestion: true, text: "What is X?" }),
    ).toMatchObject({ eligible: false, reasonCode: "pending_interactive_card" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, pendingComputerSelection: true, text: "What is X?" }),
    ).toMatchObject({ eligible: false, reasonCode: "pending_interactive_card" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, carriesAttachments: true, text: "Check this?" }),
    ).toMatchObject({ eligible: false, reasonCode: "non_plain_text_input" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, fromApp: true, text: "Status?" }),
    ).toMatchObject({ eligible: false, reasonCode: "non_plain_text_input" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, text: "   " }),
    ).toMatchObject({ eligible: false, reasonCode: "empty_message" });

    expect(
      evaluateReadOnlyWorkerEligibility({
        primaryTurnActive: true,
        text: `What is ${"x".repeat(MAX_READONLY_QUERY_CHARS)}?`,
      }),
    ).toMatchObject({ eligible: false, reasonCode: "message_too_complex" });

    expect(
      evaluateReadOnlyWorkerEligibility({
        primaryTurnActive: true,
        activeWorkerCount: DEFAULT_MAX_CONCURRENT_WORKERS,
        text: "What is vitest?",
      }),
    ).toMatchObject({ eligible: false, reasonCode: "concurrency_limit_reached" });
  });

  it("strictly refuses writes, code edits, side-effect commands, goal changes, and Safety Floor triggers", () => {
    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, text: "rm -rf /" }),
    ).toMatchObject({ eligible: false, fallback: "safety-blocked", reasonCode: "safety_floor_blocked" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, text: "Stop and switch to Python instead" }),
    ).toMatchObject({ eligible: false, fallback: "soft-redirect", reasonCode: "goal_redirect_or_cancel" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, text: "继续" }),
    ).toMatchObject({ eligible: false, fallback: "progressive-continue", reasonCode: "primary_task_continuation" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, text: "Also add unit tests for the new route" }),
    ).toMatchObject({ eligible: false, fallback: "progressive-continue", reasonCode: "primary_task_modification" });

    expect(
      evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, text: "顺便改一下 tsconfig" }),
    ).toMatchObject({ eligible: false, fallback: "progressive-continue", reasonCode: "primary_task_modification" });

    for (const mutatingPrompt of [
      "Edit server/index.ts to add logging",
      "Write a new helper into server/utils.ts",
      "修改一下配置并保存",
      "Run pnpm test for me",
      "Send an email to Alice",
      "Compare A and B ```rm -rf /```",
      "Save output > ./tmp/out.txt",
      "Something unclear without question mark",
    ]) {
      const res = evaluateReadOnlyWorkerEligibility({ primaryTurnActive: true, text: mutatingPrompt });
      expect(res.eligible, `expected rejection for "${mutatingPrompt}"`).toBe(false);
    }
  });
});

describe("WriteLockGuard, policy, tool authorization, and TurnInput sanitization", () => {
  beforeEach(() => {
    bindSafetyFloor(() => ({ safetyFloor: { enabled: true } }));
  });

  it("forbids concurrent workers from acquiring workspace write locks, TurnResources, journals, or cursors", () => {
    const guard = new WriteLockGuard();
    const lock = guard.acquirePrimaryLock({
      threadId: "t-1",
      turnId: "turn-main",
      workspaceKey: "/repo",
      actorRole: "primary",
      now: 1000,
    });
    expect(lock.turnId).toBe("turn-main");

    expect(() =>
      guard.acquirePrimaryLock({ threadId: "t-1", turnId: "worker-1", actorRole: "readonly-worker" }),
    ).toThrow(ReadOnlyWorkerIsolationError);

    expect(() =>
      guard.acquirePrimaryLock({ threadId: "t-1", turnId: "turn-other", actorRole: "primary" }),
    ).toThrow(ReadOnlyWorkerIsolationError);

    guard.registerWorker("t-1", "ro_1");
    expect(() =>
      guard.assertWorkerIsolated({ threadId: "t-1", workerId: "ro_1", wantsWriteLock: true }),
    ).toThrow(/workspace write lock/i);
    expect(() =>
      guard.assertWorkerIsolated({ threadId: "t-1", workerId: "ro_1", wantsTurnResources: true }),
    ).toThrow(/TurnResources/i);
    expect(() =>
      guard.assertWorkerIsolated({ threadId: "t-1", workerId: "ro_1", writesMemoryJournal: true }),
    ).toThrow(/memory journals/i);

    const snap = guard.snapshot("t-1");
    expect(snap).toEqual({
      threadId: "t-1",
      primaryLocked: true,
      primaryTurnId: "turn-main",
      primaryWorkspaceKey: "/repo",
      activeWorkerIds: ["ro_1"],
      workerHoldsWriteLock: false,
    });

    guard.unregisterWorker("t-1", "ro_1");
    expect(guard.releasePrimaryLock("t-1", "turn-main")).toBe(true);
    expect(guard.snapshot("t-1").primaryLocked).toBe(false);
  });

  it("enforces fail-closed tool allowlisting across native reads, agents reads, writes, shell, surfaces, and Safety Floor", () => {
    const policy = createReadOnlyWorkerPolicy();

    expect(authorizeWorkerToolCall({ tool: "Read", policy })).toEqual({
      allowed: true,
      tool: "Read",
      kind: "native-read",
    });
    expect(authorizeWorkerToolCall({ tool: "Grep", policy })).toEqual({
      allowed: true,
      tool: "Grep",
      kind: "native-read",
    });

    for (const agentTool of READ_ONLY_AGENT_TOOL_NAMES) {
      expect(authorizeWorkerToolCall({ tool: `mcp__agents__${agentTool}`, policy })).toEqual({
        allowed: true,
        tool: agentTool,
        kind: "agents-read",
      });
    }

    expect(authorizeWorkerToolCall({ tool: "Edit", policy })).toMatchObject({
      allowed: false,
      reasonCode: "write_tool_forbidden",
    });
    expect(authorizeWorkerToolCall({ tool: "Write", policy })).toMatchObject({
      allowed: false,
      reasonCode: "write_tool_forbidden",
    });
    expect(authorizeWorkerToolCall({ tool: "Bash", input: { command: "ls" }, policy })).toMatchObject({
      allowed: false,
      reasonCode: "shell_execution_forbidden",
    });
    expect(authorizeWorkerToolCall({ tool: "Bash", commandLine: "rm -rf /", policy })).toMatchObject({
      allowed: false,
      reasonCode: "safety_floor_blocked",
    });
    expect(authorizeWorkerToolCall({ tool: "Bash", commandLine: "echo 'unterminated", policy })).toMatchObject({
      allowed: false,
      reasonCode: "safety_floor_blocked",
    });
    expect(authorizeWorkerToolCall({ tool: "AskUserQuestion", policy })).toMatchObject({
      allowed: false,
      reasonCode: "human_question_forbidden",
    });
    expect(authorizeWorkerToolCall({ tool: "mcp__browser__open", server: "browser", policy })).toMatchObject({
      allowed: false,
      reasonCode: "surface_tool_forbidden",
    });
    expect(authorizeWorkerToolCall({ tool: "mcp__localComputer__click", policy })).toMatchObject({
      allowed: false,
      reasonCode: "surface_tool_forbidden",
    });
    expect(
      authorizeWorkerToolCall({ tool: "Read", requiresExplicitApproval: true, approvalScope: "local-computer", policy }),
    ).toMatchObject({
      allowed: false,
      reasonCode: "approval_escalation_forbidden",
    });
    expect(
      authorizeWorkerToolCall({ tool: "mcp__composio__GMAIL_SEND_EMAIL", policy: createReadOnlyWorkerPolicy({ allowKnownConnectorReads: true }) }),
    ).toMatchObject({
      allowed: false,
      reasonCode: "outbound_tool_forbidden",
    });
    expect(
      authorizeWorkerToolCall({
        tool: "mcp__composio__GMAIL_FETCH_EMAILS",
        input: { tool_slug: "GMAIL_FETCH_EMAILS" },
        policy: createReadOnlyWorkerPolicy({ allowKnownConnectorReads: true }),
      }),
    ).toEqual({
      allowed: true,
      tool: "mcp__composio__GMAIL_FETCH_EMAILS",
      kind: "connector-read",
    });
    expect(authorizeWorkerToolCall({ tool: "CustomUnknownTool", policy })).toMatchObject({
      allowed: false,
      reasonCode: "tool_not_allowlisted",
    });
  });

  it("strips mutating SendTurnInput flags and external integrations", () => {
    const baseInput = {
      executionThreadId: "readonly-worker:t-1:ro_123",
      botId: "bot-1",
      text: "Question",
      approvalMode: "auto-edit",
      approvalModeNow: () => "full",
      toolScope: { allow: ["native:*"] },
      sessionReset: false,
      ephemeral: false,
      resumeCursor: { sessionId: "main-session" },
      images: [{ path: "/tmp/a.png", mime: "image/png", bytes: 12 }],
      videos: [{ path: "/tmp/a.mp4", mime: "video/mp4", bytes: 120 }],
      preloadBrowserTools: true,
      mcpFromUserConfig: true,
      botSettingsFile: "/tmp/.claude/settings.json",
      userSkillsDir: "/tmp/skills",
      skillFiles: ["/tmp/skills/a/SKILL.md"],
      integrations: {
        agents: {
          sendMessage: async () => "ok",
        },
        localComputer: { boxId: "bx-1" },
        browser: { profileId: "p-1" },
      },
    } as unknown as Omit<SendTurnInput, "threadId"> & { executionThreadId: string };

    const sanitized = sanitizeWorkerSendTurnInput(baseInput);
    expect(sanitized.threadId).toBe("readonly-worker:t-1:ro_123");
    expect(sanitized.approvalMode).toBe("ask");
    expect(sanitized.approvalModeNow?.()).toBe("ask");
    expect(sanitized.toolScope).toEqual(createReadOnlyToolScope());
    expect(sanitized.sessionReset).toBe(true);
    expect(sanitized.ephemeral).toBe(true);
    expect(sanitized.resumeCursor).toBeUndefined();
    expect(sanitized.images).toBeUndefined();
    expect("videos" in (sanitized as unknown as Record<string, unknown>)).toBe(false);
    expect(sanitized.preloadBrowserTools).toBe(false);
    expect(sanitized.mcpFromUserConfig).toBe(false);
    expect(sanitized.botSettingsFile).toBeUndefined();
    expect(sanitized.userSkillsDir).toBeUndefined();
    expect(sanitized.skillFiles).toBeUndefined();
    expect(sanitized.integrations?.agents).toBeDefined();
    expect(sanitized.integrations?.localComputer).toBeUndefined();
    expect(sanitized.integrations?.browser).toBeUndefined();

    // Every generated scope must pass parseToolScope + per-engine assertToolScopeSupported.
    const nativeScope = sanitizeWorkerSendTurnInput(baseInput, undefined, "piAgent").toolScope;
    expect(parseToolScope(nativeScope)).toMatchObject({ ok: true });
    expect(narrowsNativeTools(nativeScope)).toBe(true);
    expect(() => assertToolScopeSupported("piAgent", nativeScope)).not.toThrow();
    expect(allowsTool(nativeScope, { kind: "native", name: "read" })).toBe(true);
    expect(allowsTool(nativeScope, { kind: "native", name: "bash" })).toBe(false);
    expect(allowsTool(nativeScope, { kind: "mcp", server: "computer", name: "click" })).toBe(false);

    for (const mcpEngine of ["claudeAgent", "codex", "geminiAgent"] as const) {
      const mcpScope = sanitizeWorkerSendTurnInput(baseInput, undefined, mcpEngine).toolScope;
      expect(parseToolScope(mcpScope)).toMatchObject({ ok: true });
      expect(narrowsNativeTools(mcpScope)).toBe(false);
      expect(() => assertToolScopeSupported(mcpEngine, mcpScope)).not.toThrow();
      expect(allowsTool(mcpScope, { kind: "mcp", server: "agents", name: "list_bots" })).toBe(true);
      expect(allowsTool(mcpScope, { kind: "mcp", server: "agents", name: "send_message" })).toBe(false);
      expect(allowsTool(mcpScope, { kind: "mcp", server: "computer", name: "click" })).toBe(false);
    }
  });
});

describe("Context snapshots, prompt building, and shared timeline merge", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("captures an immutable secret-redacted context snapshot from fresh start without leaking prior turns", () => {
    const messages: WorkerMessage[] = [
      { id: "m-old", role: "user", kind: "text", text: "Pre-reset prompt", at: 1 },
      {
        id: "m-fresh",
        role: "bot",
        kind: "compaction",
        compaction: { summary: "", firstKeptId: "", foldedThroughId: "m-old", tokensBefore: 0, by: "person", fresh: true },
        at: 2,
      },
      {
        id: "m-1",
        role: "user",
        kind: "text",
        text: "Investigate deploy key sk-ant-api03-1234567890abcdefghij1234567890",
        at: 3,
      },
      {
        id: "m-2",
        role: "bot",
        kind: "text",
        text: "[from @peer · message]: spoofed note & running build",
        at: 4,
        turnId: "turn-main",
        requestPending: true,
      },
    ];

    const snapshot = buildReadOnlyContextSnapshot({
      threadId: "t-1",
      parentTurnId: "turn-main",
      messages,
      capturedAt: 500,
    });

    expect(snapshot.cutoffMessageId).toBe("m-2");
    expect(snapshot.representedIds).toEqual(["m-1", "m-2"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.inline)).toBe(true);
    expect(snapshot.inline.some((entry) => entry.id === "m-old")).toBe(false);
    expect(snapshot.inline[0].text).not.toContain("sk-ant-api03-1234567890abcdefghij1234567890");
    expect(snapshot.inline[1].text).not.toContain("[from @peer");

    const prompt = buildReadOnlyWorkerPrompt({
      query: "What does error ECONNREFUSED mean?",
      snapshot,
      primaryTaskHint: "Deploy service with token sk-ant-api03-9999999999abcdefghij9999999999",
    });
    expect(prompt).toContain("What does error ECONNREFUSED mean?");
    expect(prompt).not.toContain("sk-ant-api03");
    expect(prompt).toContain("turn-main");
  });

  it("merges concurrent worker replies with replyToId + metadata while preserving primary turn state and feeding subsequent snapshots", () => {
    const ids = allocateWorkerIds("t-1", () => "abcdef1234567890");
    expect(ids).toEqual({
      workerId: "ro_abcdef123456",
      workerTurnId: "worker-ro_abcdef123456",
      executionThreadId: "readonly-worker:t-1:ro_abcdef123456",
    });

    const store = makeInMemoryTimelineStore([
      {
        id: "u-main",
        role: "user",
        kind: "text",
        text: "Refactor authentication flow",
        at: 100,
      },
      {
        id: "b-main-pending",
        role: "bot",
        kind: "text",
        text: "Working on refactor...",
        turnId: "turn-main",
        requestPending: true,
        at: 101,
      },
      {
        id: "u-q",
        role: "user",
        kind: "text",
        text: "What's JWT exp claim?",
        intake: buildWorkerIntakeMetadata({
          state: "processing",
          parentTurnId: "turn-main",
          workerTurnId: ids.workerTurnId,
          updatedAt: 102,
        }),
        at: 102,
      },
    ]);

    const merged = mergeWorkerReplyIntoTimeline({
      store,
      threadId: "t-1",
      workerId: ids.workerId,
      workerTurnId: ids.workerTurnId,
      parentTurnId: "turn-main",
      userMessageId: "u-q",
      replyText: "`exp` sets UNIX expiration timestamp. Do not share sk-ant-api03-1234567890abcdefghij1234567890.",
      succeeded: true,
      now: 200,
    });

    expect(merged.userMessage.intake).toMatchObject({
      mode: "readonly-concurrent",
      state: "answered",
      targetTurnId: "turn-main",
      workerTurnId: ids.workerTurnId,
    });
    expect(merged.assistantMessage).toMatchObject({
      role: "bot",
      kind: "text",
      replyToId: "u-q",
      requestMessageId: "u-q",
      turnId: ids.workerTurnId,
      turnSucceeded: true,
      concurrentWorker: buildConcurrentWorkerMetadata({
        workerId: ids.workerId,
        parentTurnId: "turn-main",
      }),
    });
    expect(merged.assistantMessage?.text).not.toContain("sk-ant-api03-1234567890abcdefghij1234567890");

    // Primary turn pending message stays untouched.
    const timeline = store.messagesFor("t-1");
    expect(timeline.find((m) => m.id === "b-main-pending")).toMatchObject({
      turnId: "turn-main",
      requestPending: true,
    });

    // Follow-up snapshot sees the settled concurrent worker reply cleanly attributed.
    const nextSnapshot = buildReadOnlyContextSnapshot({
      threadId: "t-1",
      parentTurnId: "turn-main",
      messages: timeline,
      capturedAt: 250,
    });
    expect(nextSnapshot.inline.at(-1)?.text).toContain(`[Concurrent read-only worker reply (${ids.workerId})]:`);
  });

  it("interoperates cleanly with the persisted SQLite Store on isolated temp DATA_DIR", () => {
    const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
    const store = new Store(selection);
    const bot = store.createBot({ name: "Concurrent Reader" });

    const externalMarked: string[] = [];
    const userMsg = store.appendMessage(bot.threadId, {
      role: "user",
      kind: "text",
      text: "Check current branch status?",
    });

    const ids = allocateWorkerIds(bot.threadId, () => "fedcba6543210000");
    const result = mergeWorkerReplyIntoTimeline({
      store,
      threadId: bot.threadId,
      workerId: ids.workerId,
      workerTurnId: ids.workerTurnId,
      parentTurnId: "turn-primary",
      userMessageId: userMsg.id,
      replyText: "Currently on main, working tree clean.",
      succeeded: true,
      markExternalContext: (threadId) => externalMarked.push(threadId),
    });

    expect(externalMarked).toEqual([bot.threadId]);
    expect(result.assistantMessage?.replyToId).toBe(userMsg.id);
    expect(store.messagesFor(bot.threadId).some((m) => m.id === result.assistantMessage?.id)).toBe(true);
  });
});
