import {
  createProgressiveIntakeMeta,
  type ProgressiveIntakeMode,
  type ProgressiveIntakeState,
} from "../shared/progressive-intake.ts";
import type { FollowUp } from "../shared/follow-up.ts";
import type { SteerQueueReason } from "../shared/wire.ts";
import { admit, type AdmissionSteerBlock } from "./admission.ts";
import type { DirectSendReceipt } from "./direct-send.ts";
import { sinceFreshStart } from "./fresh-start.ts";
import { maskQuotedAndCode } from "./room-holds.ts";
import type { Message } from "./store.ts";

export interface BusyIntakeClassificationInput {
  text: string;
  carriesImages?: boolean;
  engineCanSteerImages?: boolean;
  pendingComputerSelection?: boolean;
  engineCanSteer?: boolean;
  followUp?: FollowUp;
  hasActiveDelegation?: boolean;
  fromApp?: boolean;
  /** False when the request originates from an automated/webhook/bot trigger rather than a human user or owner. */
  allowSoftRedirect?: boolean;
}

export interface BusyIntakeClassification {
  mode: ProgressiveIntakeMode;
  initialState: ProgressiveIntakeState;
  shouldInterrupt: boolean;
  redirect: boolean;
  allowDelegationForward: boolean;
  blockedBy?: AdmissionSteerBlock;
  chose?: Exclude<FollowUp, "steer">;
}

const SOFT_REDIRECT_EN = [
  /\b(?:cancel|abort|scrap|abandon|discard|drop|forget|ignore)\s+(?:that|this|the\s+(?:previous|prior|current|old|above|first|last|plan|approach|refactor|search|task)|what\s+you(?:'re|\s+are)\s+doing)\b/i,
  /(?:^|[.!?;]\s*)(?:never\s*mind|scratch\s+that|start\s+over)\b/i,
  /\b(?:change|switch)\s+(?:direction|course|approach|plans?|tactics?)\b/i,
  /(?:^|[.!?;]\s*|,\s*)stop\s+(?:doing\s+that|that|this|the\s+(?:previous|prior|current|old|above|refactor|search|task)|what\s+you(?:'re|\s+are)\s+doing)\b/i,
  /\b(?:do\s+(?:this|the\s+following|\S+(?:\s+\S+){0,5})\s+instead|instead\s*[,:]?\s*(?:switch\s+to|focus\s+on|work\s+on|do|use|write|check)|rather\s+than\s+(?:continuing|that))\b/i,
];

const SOFT_REDIRECT_ZH = [
  /(?:取消|放弃|作废|中止|停掉)(?:当前|刚才|之前|上面|那个|这个)?(?:任务|计划|方案|重构|搜索|分析|步骤)?[，,、\s]*(?:改(?:做|成|为|用)|直接|重新|换|只)/,
  /(?:别做了|不做了|重来|重新开始|换个方向)/,
  /(?:^|[，,。！？；\s])算了[，,。\s]*(?:直接|改|换|先|别)/,
  /(?:先停下?|停掉)(?:当前|刚才|这个|那个)(?:工作|任务|处理|重构|搜索)/,
  /(?:不要|别)继续(?:当前|刚才|这个|那个)?[，,、\s]*(?:改|换|直接)/,
];

/** Recognizes explicit mid-turn cancellation + direction changes on unquoted text without misfiring on bare stops or narrow coding instructions. */
export function isSoftRedirectIntent(text: string): boolean {
  const surface = maskQuotedAndCode(text).trim();
  if (!surface) return false;
  return SOFT_REDIRECT_EN.some((pattern) => pattern.test(surface)) || SOFT_REDIRECT_ZH.some((pattern) => pattern.test(surface));
}

export function classifyBusyIntake(input: BusyIntakeClassificationInput): BusyIntakeClassification {
  const admission = admit("direct-busy", {
    carriesImages: input.carriesImages,
    engineCanSteerImages: input.engineCanSteerImages,
    pendingComputerSelection: input.pendingComputerSelection,
    engineCanSteer: input.engineCanSteer,
    followUp: input.followUp,
  });

  if (input.followUp === "queue" || input.pendingComputerSelection) {
    return {
      mode: "progressive-continue",
      initialState: "received",
      shouldInterrupt: false,
      redirect: false,
      allowDelegationForward: false,
      ...(admission.action === "queue" && admission.blockedBy ? { blockedBy: admission.blockedBy } : {}),
      ...(admission.action === "queue" && admission.chose ? { chose: admission.chose } : {}),
    };
  }

  const redirect = !input.fromApp && input.allowSoftRedirect !== false && (input.followUp === "restart" || isSoftRedirectIntent(input.text));
  const allowDelegationForward = Boolean(input.hasActiveDelegation && !input.fromApp && !input.carriesImages);

  if (redirect) {
    return {
      mode: "soft-redirect",
      initialState: "received",
      shouldInterrupt: true,
      redirect: true,
      allowDelegationForward,
      chose: admission.action === "queue" ? admission.chose : undefined,
    };
  }

  if (admission.action === "steer") {
    return {
      mode: "live-steer",
      initialState: "processing",
      shouldInterrupt: false,
      redirect: false,
      allowDelegationForward,
    };
  }

  return {
    mode: "progressive-continue",
    initialState: "received",
    shouldInterrupt: false,
    redirect: false,
    allowDelegationForward,
    ...(admission.action === "queue" && admission.blockedBy ? { blockedBy: admission.blockedBy } : {}),
    ...(admission.action === "queue" && admission.chose ? { chose: admission.chose } : {}),
  };
}

function clipSummaryText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Summarizes work already done in the running or just-settled turn so coalesced follow-ups or soft redirects preserve completed artifacts without re-starting blind. */
export function extractTurnProgressSummary(
  messages: readonly Message[],
  targetTurnId?: string,
  maxChars = 1_200,
): string {
  if (messages.length === 0) return "";
  const window = sinceFreshStart(messages);

  let slice: readonly Message[] = targetTurnId
    ? window.filter((message) => message.turnId === targetTurnId)
    : [];

  if (slice.length === 0) {
    const anchorIdx = window.findLastIndex(
      (message) => message.role === "user" && message.intake?.state !== "received" && message.intake?.state !== "folding",
    );
    slice = anchorIdx >= 0 ? window.slice(anchorIdx + 1) : window;
  }

  const toolSteps: string[] = [];
  const assistantNotes: string[] = [];
  for (const message of slice) {
    if (message.role !== "bot") continue;
    if (message.kind === "activity" && message.tool?.name) {
      const name = message.tool.name.trim();
      if (!name || name.startsWith("Stopped") || name.startsWith("retrying")) continue;
      const status = message.tool.ok === true ? "ok" : message.tool.ok === false ? "failed" : "step";
      const output = message.tool.output ? `: ${clipSummaryText(message.tool.output.replace(/\s+/g, " "), 120)}` : "";
      toolSteps.push(`- [${status}] ${name}${output}`);
    } else if (message.kind === "text" && message.text?.trim()) {
      assistantNotes.push(clipSummaryText(message.text, 500));
    }
  }

  const parts: string[] = [];
  if (toolSteps.length > 0) {
    parts.push(`Completed tool steps:\n${toolSteps.slice(-6).join("\n")}`);
  }
  if (assistantNotes.length > 0) {
    parts.push(`Assistant progress:\n${assistantNotes.slice(-2).join("\n")}`);
  }
  if (parts.length === 0) return "";
  return clipSummaryText(parts.join("\n\n"), maxChars);
}

export function buildProgressiveContinuationPrompt(input: {
  followUpPrompts: readonly string[];
  progressSummary?: string;
}): string {
  const combined = input.followUpPrompts.join("\n\n");
  const summary = input.progressSummary?.trim();
  if (!summary) return combined;
  return [
    "[Progressive continuation — carry forward the completed work below and incorporate all user follow-ups]",
    summary,
    "",
    combined,
  ].join("\n\n");
}

export function buildSoftRedirectPrompt(input: {
  latestPrompt: string;
  supersededText?: string;
  progressSummary?: string;
}): string {
  const header = ["[Course correction — previous in-flight work was gracefully interrupted at the user's direction]"];
  if (input.supersededText?.trim()) {
    header.push(`Superseded instruction: ${clipSummaryText(input.supersededText.replace(/\s+/g, " "), 240)}`);
  }
  if (input.progressSummary?.trim()) {
    header.push(`Preserve any reusable artifacts below and pivot to the latest instruction:\n${input.progressSummary.trim()}`);
  }
  return [...header, input.latestPrompt].join("\n\n");
}

export function buildDelegatedForwardPrompt(input: {
  userText: string;
  redirect?: boolean;
  assignmentId?: string;
}): string {
  const tag = input.assignmentId ? ` (assignment ${input.assignmentId})` : "";
  const heading = input.redirect
    ? `[User direction change forwarded to delegated work${tag} — pivot without restarting cleanly completed parts]`
    : `[User follow-up forwarded to delegated work${tag} — incorporate seamlessly into your active work]`;
  return `${heading}\n\n${input.userText}`;
}

export function buildInitialIntakeMeta(classification: BusyIntakeClassification, targetTurnId?: string, now = Date.now()) {
  return createProgressiveIntakeMeta({
    mode: classification.mode,
    state: classification.initialState,
    ...(targetTurnId ? { targetTurnId } : {}),
    updatedAt: now,
  });
}

export interface ProgressiveIntakeStore {
  activePath(threadId: string): Message[];
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

export interface BusySendIntakeParams {
  store: ProgressiveIntakeStore & {
    appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
    setTaskAskedAt(botId: string, threadId: string, at: number): void;
  };
  threadMaps: { track<T extends { delete(threadId: string): unknown; keys(): IterableIterator<string> }>(map: T): T };
}

export interface ProgressiveIntakeTracker {
  bindTurnStarted(threadId: string, turnId: string, queuedRowIds: ReadonlySet<string>, ownerMessageId?: string): void;
  matchesRedirectError(threadId: string, turnId?: string): boolean;
  consumeRedirectStop(threadId: string, completedTurnId?: string): boolean;
  settleCompletedTurn(threadId: string, completedTurnId: string | undefined, stopped: boolean, queuedRowIds: ReadonlySet<string>): void;
  markSoftRedirect(threadId: string, turnId?: string, generation?: string): void;
  saveRedirectContext(threadId: string, queueId: string, ctx: { supersededText?: string; progressSummary?: string }): void;
  clearRedirectContext(threadId: string, queueIds?: readonly string[]): void;
  formatDrainedPrompt(input: {
    threadId: string;
    group: ReadonlyArray<{ messageId: string; prompt: string }>;
    appended: readonly Message[];
    defaultPrompt: string;
  }): string;
  supersedePriorUser(threadId: string, ownerMessageId: string | undefined, targetTurnId: string | undefined, queuedRowIds: ReadonlySet<string>, now?: number): string | undefined;
  recordUserRow(input: {
    store: {
      appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
      patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
      setTaskAskedAt?(botId: string, threadId: string, at: number): void;
    };
    botId?: string;
    threadId: string;
    text: string;
    replyToId?: string;
    sendId?: string;
    dataContext?: Message["dataContext"];
    app?: { fromApp?: Message["fromApp"]; pointed?: Message["pointed"] };
    sender?: Message["sender"];
    intake: NonNullable<Message["intake"]>;
    steered?: true;
    spoken?: Pick<Message, "via" | "callId">;
  }): Message;
  queuedMatchReceipt(input: {
    botId: string;
    threadId: string;
    text: string;
    replyToId?: string;
    acceptedMessage: Message;
    queued: { id: string; text: string; replyToId?: string; reason?: SteerQueueReason } | null;
    waitWords: (threadId: string, reason: SteerQueueReason | undefined) => string | undefined;
  }): DirectSendReceipt;
}

export function createProgressiveIntakeTracker(
  store: ProgressiveIntakeStore,
  threadMaps: { track<T extends { delete(threadId: string): unknown; keys(): IterableIterator<string> }>(map: T): T },
): ProgressiveIntakeTracker {
  const softRedirectInterrupts = threadMaps.track(new Map<string, { turnId?: string; generation?: string }>());
  const progressiveRedirectContexts = threadMaps.track(new Map<string, Map<string, { supersededText?: string; progressSummary?: string }>>());

  const clearRedirect = (threadId: string, queueIds?: readonly string[]) => {
    if (!queueIds) {
      progressiveRedirectContexts.delete(threadId);
      return;
    }
    const byThread = progressiveRedirectContexts.get(threadId);
    if (!byThread) return;
    for (const queueId of queueIds) byThread.delete(queueId);
    if (byThread.size === 0) progressiveRedirectContexts.delete(threadId);
  };

  return {
    bindTurnStarted(threadId, turnId, queuedRowIds, ownerMessageId) {
      const now = Date.now();
      for (const row of store.activePath(threadId)) {
        if (row.role !== "user" || row.intake?.state !== "processing" || queuedRowIds.has(row.id) || row.intake.targetTurnId) continue;
        if (row.id !== ownerMessageId && row.steered === true) continue;
        const bound = createProgressiveIntakeMeta({ ...row.intake, state: "processing", targetTurnId: turnId, updatedAt: now });
        store.patchMessage(threadId, row.id, { intake: bound });
      }
    },
    matchesRedirectError(threadId, turnId) {
      const stop = softRedirectInterrupts.get(threadId);
      return Boolean(stop && (!stop.turnId || !turnId || stop.turnId === turnId));
    },
    consumeRedirectStop(threadId, completedTurnId) {
      const stop = softRedirectInterrupts.get(threadId);
      const matched = Boolean(stop && (!stop.turnId || !completedTurnId || stop.turnId === completedTurnId));
      if (matched) softRedirectInterrupts.delete(threadId);
      return matched;
    },
    settleCompletedTurn(threadId, completedTurnId, stopped, queuedRowIds) {
      const settleAt = Date.now();
      for (const msg of store.activePath(threadId)) {
        if (msg.role !== "user" || msg.intake?.state !== "processing" || queuedRowIds.has(msg.id)) continue;
        if (completedTurnId && msg.intake.targetTurnId && msg.intake.targetTurnId !== completedTurnId) continue;
        const settled = createProgressiveIntakeMeta({ ...msg.intake, state: stopped ? "superseded" : "answered", updatedAt: settleAt });
        store.patchMessage(threadId, msg.id, { intake: settled });
      }
    },
    markSoftRedirect(threadId, turnId, generation) {
      softRedirectInterrupts.set(threadId, { turnId, generation });
    },
    saveRedirectContext(threadId, queueId, ctx) {
      if (!ctx.progressSummary && !ctx.supersededText) return;
      const byThread = progressiveRedirectContexts.get(threadId) ?? new Map<string, { supersededText?: string; progressSummary?: string }>();
      byThread.set(queueId, ctx);
      progressiveRedirectContexts.set(threadId, byThread);
    },
    clearRedirectContext: clearRedirect,
    formatDrainedPrompt({ threadId, group, appended, defaultPrompt }) {
      const mode = appended.at(-1)?.intake?.mode;
      const byThread = progressiveRedirectContexts.get(threadId);
      const redirectCtx = byThread ? group.map((item) => byThread.get(item.messageId)).find((ctx) => ctx !== undefined) : undefined;
      clearRedirect(threadId, group.map((item) => item.messageId));
      if (!mode) return defaultPrompt;
      if (mode === "soft-redirect") {
        return buildSoftRedirectPrompt({
          latestPrompt: defaultPrompt,
          supersededText: redirectCtx?.supersededText,
          progressSummary: redirectCtx?.progressSummary,
        });
      }
      if (mode === "progressive-continue" && redirectCtx?.progressSummary) {
        return buildProgressiveContinuationPrompt({
          followUpPrompts: group.map((item) => item.prompt),
          progressSummary: redirectCtx.progressSummary,
        });
      }
      return defaultPrompt;
    },
    supersedePriorUser(threadId, ownerMessageId, targetTurnId, queuedRowIds, now = Date.now()) {
      const path = store.activePath(threadId);
      const priorUser = (ownerMessageId ? path.find((m) => m.id === ownerMessageId) : undefined)
        ?? path.findLast((m) => m.role === "user" && !queuedRowIds.has(m.id));
      if (priorUser && priorUser.intake?.state !== "superseded") {
        const superseded = createProgressiveIntakeMeta({
          ...(priorUser.intake ?? { mode: "live-steer", targetTurnId }),
          state: "superseded",
          updatedAt: now,
        });
        store.patchMessage(threadId, priorUser.id, { intake: superseded });
      }
      return priorUser?.text;
    },
    recordUserRow({ store: targetStore, botId, threadId, text, replyToId, sendId, dataContext, app, sender, intake, steered, spoken }) {
      const message = targetStore.appendMessage(threadId, {
        role: "user",
        kind: "text",
        text,
        replyToId,
        sendId,
        ...(dataContext ? { dataContext } : {}),
        ...(app?.fromApp ? { fromApp: app.fromApp } : {}),
        ...(app?.pointed ? { pointed: app.pointed } : {}),
        ...(steered ? { steered } : {}),
        sender,
        intake,
        ...spoken,
      });
      if (botId) targetStore.setTaskAskedAt?.(botId, threadId, message.at);
      return message;
    },
    queuedMatchReceipt({ threadId, text, replyToId, acceptedMessage, queued, waitWords }) {
      if (queued) {
        if (queued.text !== text || queued.replyToId !== replyToId) {
          throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
        }
        return {
          ok: true as const,
          queued: true as const,
          queueId: queued.id,
          threadId,
          message: acceptedMessage,
          ...(acceptedMessage.intake ? { intake: acceptedMessage.intake } : {}),
          ...(queued.reason ? { reason: queued.reason, why: waitWords(threadId, queued.reason) } : {}),
        };
      }
      const canonical = { ok: true as const, threadId, message: acceptedMessage };
      return acceptedMessage.steered ? { ...canonical, steered: true as const } : canonical;
    },
  };
}
