// In-thread read-only concurrent worker domain logic (T9 Slice 2).
// Pure eligibility gating, strict workspace write-lock isolation, read-only tool
// authorization, immutable context snapshots, and shared timeline merge helpers.

import { isReadOnlyAgentTool, READ_ONLY_AGENT_TOOL_NAMES } from "./agent-tool-policy.ts";
import type { DriverKind, SendTurnInput } from "./contracts.ts";
import { floorReading } from "./safety-floor.ts";
import { safetyFloorBlock, safetyFloorClears, shellCommandOfToolCall } from "./safety-floor-gate.ts";
import type { FollowUp } from "../shared/follow-up.ts";
import { connectorCallsIn, isOutboundTool, isReadOnlyTool, KNOWN_READ_SLUGS } from "../shared/outbound.ts";
import { parseToolScope, type ToolScope } from "../shared/tool-scope.ts";
import { TOOL_SCOPE_SUPPORT } from "../shared/tool-scope-support.ts";
import type { ReadOnlyWorkerClassification } from "./readonly-worker-timeline.ts";

export {
  allocateWorkerIds,
  buildConcurrentWorkerMetadata,
  buildReadOnlyContextSnapshot,
  buildReadOnlyWorkerPrompt,
  buildWorkerAssistantMessageDraft,
  buildWorkerIntakeMetadata,
  buildWorkerUserMessageDraft,
  mergeWorkerReplyIntoTimeline,
  type ConcurrentWorkerMetadata,
  type MergeWorkerReplyInput,
  type MergeWorkerReplyResult,
  type ProgressiveIntakeMetadata,
  type ProgressiveIntakeMode,
  type ProgressiveIntakeState,
  type ReadOnlyContextSnapshot,
  type ReadOnlyWorkerClassification,
  type TimelineMergeStore,
  type WorkerMessage,
} from "./readonly-worker-timeline.ts";

export type ReadOnlyFallbackChannel =
  | "live-steer"
  | "progressive-continue"
  | "soft-redirect"
  | "refuse"
  | "safety-blocked";

export type ReadOnlyEligibilityRejectionCode =
  | "disabled"
  | "no_active_primary_turn"
  | "guarded_route"
  | "room_thread"
  | "confined_thread"
  | "explicit_restart"
  | "explicit_queue"
  | "explicit_steer"
  | "pending_interactive_card"
  | "non_plain_text_input"
  | "empty_message"
  | "message_too_complex"
  | "concurrency_limit_reached"
  | "safety_floor_blocked"
  | "goal_redirect_or_cancel"
  | "primary_task_continuation"
  | "primary_task_modification"
  | "write_or_side_effect_intent"
  | "ambiguous_intent";

export const DEFAULT_MAX_CONCURRENT_WORKERS = 3;
export const MAX_READONLY_QUERY_CHARS = 800;
export const MAX_READONLY_QUERY_LINES = 12;

export const NATIVE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "glob", "grep", "ls", "view", "find", "websearch", "web_search"]);

const DENIED_MCP_SERVERS: readonly string[] = [
  "mcp:computer:*",
  "mcp:browser:*",
  "mcp:phone:*",
  "mcp:device:*",
  "mcp:email:*",
  "mcp:data:*",
  "mcp:dweb:*",
];

/** Builds a valid read-only ToolScope respecting per-engine native vs MCP tool-scope capabilities. */
export function createReadOnlyToolScope(
  policy: ReadOnlyWorkerPolicy = createReadOnlyWorkerPolicy(),
  driver?: DriverKind | string,
): ToolScope {
  const support = driver
    ? TOOL_SCOPE_SUPPORT[driver as keyof typeof TOOL_SCOPE_SUPPORT]
    : "native-and-mcp";
  const agentAllows = policy.allowedIntegrations.includes("agents")
    ? [...policy.allowedAgentTools].map((name) => `mcp:agents:${name}`)
    : [];

  if (support === "mcp") {
    // MCP-only engines reject any scope that narrows `native:*`; keep `native:*` and clamp MCP via allow + deny.
    return {
      allow: ["native:*", ...agentAllows],
      deny: [...DENIED_MCP_SERVERS],
    };
  }

  const nativeAllows = [...policy.allowedNativeReadTools].map((name) => `native:${name}`);
  const scope: ToolScope = {
    allow: [...nativeAllows, ...agentAllows],
    deny: ["native:bash", "native:edit", "native:write", "native:ask_user", ...DENIED_MCP_SERVERS],
  };
  const parsed = parseToolScope(scope);
  if (!parsed.ok || !parsed.scope) {
    throw new Error(parsed.ok ? "Invalid empty read-only tool scope." : parsed.error);
  }
  return parsed.scope;
}

/** Immutable runtime policy enforced for every concurrent read-only worker. */
export interface ReadOnlyWorkerPolicy {
  readonly readOnly: true;
  readonly approvalMode: "ask";
  readonly acquireWorkspaceWriteLock: false;
  readonly acquireTurnResources: false;
  readonly writeMemoryJournal: false;
  readonly mutateSessionCursor: false;
  readonly allowFileWrites: false;
  readonly allowShellExecution: false;
  readonly allowSideEffects: false;
  readonly allowComputerControl: false;
  readonly allowBrowserControl: false;
  readonly allowOutbound: false;
  readonly allowApprovalBypass: false;
  readonly allowSafetyFloorBypass: false;
  readonly allowedAgentTools: ReadonlySet<string>;
  readonly allowedNativeReadTools: ReadonlySet<string>;
  readonly allowedIntegrations: readonly ["agents"];
  readonly allowKnownConnectorReads: boolean;
}

export function createReadOnlyWorkerPolicy(options: { allowKnownConnectorReads?: boolean } = {}): ReadOnlyWorkerPolicy {
  return Object.freeze({
    readOnly: true,
    approvalMode: "ask",
    acquireWorkspaceWriteLock: false,
    acquireTurnResources: false,
    writeMemoryJournal: false,
    mutateSessionCursor: false,
    allowFileWrites: false,
    allowShellExecution: false,
    allowSideEffects: false,
    allowComputerControl: false,
    allowBrowserControl: false,
    allowOutbound: false,
    allowApprovalBypass: false,
    allowSafetyFloorBypass: false,
    allowedAgentTools: READ_ONLY_AGENT_TOOL_NAMES,
    allowedNativeReadTools: NATIVE_READ_ONLY_TOOLS,
    allowedIntegrations: ["agents"] as const,
    allowKnownConnectorReads: options.allowKnownConnectorReads === true,
  });
}

export interface ReadOnlyWorkerEligibilityInput {
  text: string;
  primaryTurnActive: boolean;
  enabled?: boolean;
  /** Guarded external sends preserve guarded_busy and never spin off concurrent workers. */
  guarded?: boolean;
  roomThread?: boolean;
  confined?: boolean;
  followUp?: FollowUp | null;
  hasPendingApproval?: boolean;
  hasPendingQuestion?: boolean;
  pendingComputerSelection?: boolean;
  carriesAttachments?: boolean;
  attachmentCount?: number;
  fromApp?: boolean;
  widgetPress?: boolean;
  hasPointedRefs?: boolean;
  setupRequest?: boolean;
  activeWorkerCount?: number;
  maxConcurrentWorkers?: number;
  allowKnownConnectorReads?: boolean;
}

export type ReadOnlyWorkerEligibilityDecision =
  | {
      eligible: true;
      classification: ReadOnlyWorkerClassification;
      reasonCode: "admitted_light_qa" | "admitted_readonly_query";
      policy: ReadOnlyWorkerPolicy;
    }
  | {
      eligible: false;
      classification: "rejected";
      fallback: ReadOnlyFallbackChannel;
      reasonCode: ReadOnlyEligibilityRejectionCode;
      reason: string;
    };

const SAFETY_COMMAND_SNIPPETS =
  /(?:rm\s+-[a-z]*[rR]|mkfs(?:\.[a-z0-9]+)?|diskutil\s+(?:erasedisk|erasevolume|reformat)|dd\s+if=|format\s+[a-z]:|:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:)/i;

const GOAL_REDIRECT_OR_CANCEL =
  /^(?:stop|cancel|abort|halt|never\s*mind|forget\s+it|scratch\s+that|hold\s+on|wait(?:\s+a\s+sec)?)\b|(?:\b(?:instead\s+of|switch\s+(?:over\s+)?to|change\s+(?:the\s+)?(?:plan|goal|direction|approach|target)|do\s+.+\s+instead|don't\s+use\s+.+\s+use)\b)|(?:取消|算了|停止|停一下|暂停|别做了|不要这样|改用|换成|重新来|换个方案|改变计划|调整目标)/i;

const PRIMARY_CONTINUATION =
  /^(?:yes|yep|yeah|ok(?:ay)?|sure|sounds\s+good|go\s+ahead|go\s+on|do\s+it|continue|proceed|please\s+do|confirm(?:ed)?|approve(?:d)?|retry|try\s+again|好的|可以|行|继续|执行吧|确认|同意|批准|按这个来|重试)[!.\s，。！]*$/i;

const PRIMARY_MODIFICATION =
  /(?:^\s*(?:also|and\s+also|oh\s+also|btw|additionally|remember\s+to|don't\s+forget\s+to|make\s+sure\s+(?:to|you))\b|\b(?:for\s+that\s+task|in\s+that\s+file|on\s+that\s+pr|in\s+the\s+current\s+task)\b.*?\b(?:add|include|use|change|update|make\s+sure|skip)\b|(?:顺便(?:把|改|加|修)|另外(?:记得|请|加上|修改)|别忘了|再帮我(?:改|加|修)))/i;

const WRITE_OR_MUTATION_INTENT =
  /(?:\b(?:edit|write|overwrite|append|prepend|insert|replace|add|create|mkdir|touch|modify|change|update|patch|refactor|fix|implement|build|scaffold|delete|remove|unlink|rename|move|migrate|format|lint\s+--fix|install|uninstall|upgrade|downgrade|deploy|publish|commit|push|merge|rebase|cherry-pick|checkout|reset|stash|revert)\b|(?:修改|改动|改一下|改下|编辑|写入|写一个|写个|新建|新增|添加|加上|补充|创建|生成文件|覆盖|删除|删掉|移除|重命名|重构|修复|修一下|实现|保存|格式化|安装|卸载|部署|发布|提交|推送|合并))/i;

const EXECUTION_OR_SIDE_EFFECT_INTENT =
  /(?:\b(?:run|exec|execute|spawn|kill|restart|start\s+(?:server|service|app|vm)|stop\s+(?:server|service|app|vm)|npm|pnpm|yarn|bun|pytest|vitest|cargo|pip|brew|apt|curl|wget|ssh|scp|docker|podman|bash|sh|zsh|powershell|pwsh|cmd|sudo)\b|(?:send\s+(?:an?\s+)?(?:email|mail|message|dm|reply|slack|tweet|post)|post\s+to|tweet|schedule|book|buy|purchase|pay|transfer|charge|refund|dial|call\s+phone|click|type\s+into|open\s+(?:browser|url|page)|take\s+(?:a\s+)?screenshot|update\s+memory|write\s+memory|save\s+memory|manage\s+skill|install\s+skill|connect\s+(?:app|account)|authorize|revoke)\b|(?:运行|执行|跑一下|脚本|终端|命令行|重启|启动服务|发邮件|发消息|发送|推送|下单|支付|转账|打开浏览器|点击|截屏|截图|写入记忆|修改记忆|安装技能|授权))/i;

const SHELL_SYNTAX_OR_REDIRECT = /```|(?:^|[\s;])(?:>|>>|2>|&>)\s*\S|\|\s*(?:tee|sh|bash|zsh|xargs)\b|&&|\$\(/;

const FILE_WRITE_TARGET_HINT = /\b(?:to|into)\s+[~./]?[\w.-]+\/[\w./-]+/i;

const READONLY_QUERY_PATTERN =
  /(?:\b(?:status|progress|state|summarize|summary|list|show|inspect|view|read|check|search|find|grep|look\s*up|where\s+is|which\s+file|git\s+(?:status|log|diff|branch|show)|ls|cat|head|tail|wc|pwd)\b|(?:进度|状态|到哪一步|怎么样了|查看|查一下|看一下|帮我看|读取|列出|总结|汇总|搜索|查找|检视|目录|有哪些))/i;

const LIGHT_QA_PATTERN =
  /(?:[?？]$|\b(?:what|why|how|when|who|where|which|explain|define|compare|difference\s+between|meaning\s+of|translate|convert|calculate|is\s+it\s+true|does\s+\w+\s+support|can\s+\w+|are\s+\w+)\b|^(?:hi|hello|hey|thanks|thank\s+you|thx|ty)\b|(?:是什么|为什么|怎么理解|啥意思|什么意思|区别是什么|区别在哪|如何工作|解释一下|原理|翻译成|换算))/i;

function reject(
  fallback: ReadOnlyFallbackChannel,
  reasonCode: ReadOnlyEligibilityRejectionCode,
  reason: string,
): ReadOnlyWorkerEligibilityDecision {
  return { eligible: false, classification: "rejected", fallback, reasonCode, reason };
}

function triggersSafetyFloor(text: string): boolean {
  if (SAFETY_COMMAND_SNIPPETS.test(text)) return true;
  if (safetyFloorBlock(text) !== null) return true;
  const reading = floorReading(text);
  // Natural language contractions ("What's") yield read: false when lexed as shell;
  // only confirmed safety-floor verdicts block here, while real tool calls fail closed on read: false.
  return reading.read && reading.verdict !== null;
}

/** Pure fail-closed eligibility gate deciding if a mid-turn send may spawn an in-thread read-only worker. */
export function evaluateReadOnlyWorkerEligibility(
  input: ReadOnlyWorkerEligibilityInput,
): ReadOnlyWorkerEligibilityDecision {
  if (input.enabled === false) {
    return reject("progressive-continue", "disabled", "Read-only concurrent workers are disabled.");
  }
  if (!input.primaryTurnActive) {
    return reject("progressive-continue", "no_active_primary_turn", "No active primary turn requires concurrent offloading.");
  }
  if (input.guarded) {
    return reject("refuse", "guarded_route", "Guarded external requests must not bypass guarded_busy mutual exclusion.");
  }
  if (input.roomThread) {
    return reject("progressive-continue", "room_thread", "Room channels serialize speakers and queue concurrent sends.");
  }
  if (input.confined) {
    return reject("progressive-continue", "confined_thread", "Confined threads remain strictly serialized.");
  }
  if (input.followUp === "restart") {
    return reject("soft-redirect", "explicit_restart", "Explicit restart requests redirect the primary turn.");
  }
  if (input.followUp === "queue") {
    return reject("progressive-continue", "explicit_queue", "Explicit queue choice defers to progressive continuation.");
  }
  if (input.followUp === "steer") {
    return reject("live-steer", "explicit_steer", "Explicit steer choice routes into the active turn.");
  }
  if (input.hasPendingApproval || input.hasPendingQuestion || input.pendingComputerSelection) {
    return reject(
      "progressive-continue",
      "pending_interactive_card",
      "Pending approval, question, or surface selection cards forbid concurrent worker execution.",
    );
  }
  if (
    input.carriesAttachments ||
    (input.attachmentCount ?? 0) > 0 ||
    input.fromApp ||
    input.widgetPress ||
    input.hasPointedRefs ||
    input.setupRequest
  ) {
    return reject(
      "progressive-continue",
      "non_plain_text_input",
      "Attachments, app payloads, pointed refs, and setup requests route through the progressive path.",
    );
  }

  const trimmed = input.text.trim();
  if (!trimmed) {
    return reject("progressive-continue", "empty_message", "Empty message cannot be dispatched.");
  }
  const lineCount = trimmed.split(/\r?\n/).length;
  if (trimmed.length > MAX_READONLY_QUERY_CHARS || lineCount > MAX_READONLY_QUERY_LINES) {
    return reject(
      "progressive-continue",
      "message_too_complex",
      "Long or multi-section prompts fall back to progressive continuation.",
    );
  }

  const maxWorkers = input.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS;
  if ((input.activeWorkerCount ?? 0) >= maxWorkers) {
    return reject(
      "progressive-continue",
      "concurrency_limit_reached",
      "Thread reached its concurrent read-only worker limit.",
    );
  }

  if (triggersSafetyFloor(trimmed)) {
    return reject("safety-blocked", "safety_floor_blocked", "Blocked by Safety Floor invariant.");
  }
  if (GOAL_REDIRECT_OR_CANCEL.test(trimmed)) {
    return reject(
      "soft-redirect",
      "goal_redirect_or_cancel",
      "Message cancels or redirects the active primary task goal.",
    );
  }
  if (PRIMARY_CONTINUATION.test(trimmed)) {
    return reject(
      "progressive-continue",
      "primary_task_continuation",
      "Confirmation or continuation belongs to the active primary task.",
    );
  }
  if (PRIMARY_MODIFICATION.test(trimmed)) {
    return reject(
      "progressive-continue",
      "primary_task_modification",
      "Follow-up modifies or amends the active primary task scope.",
    );
  }
  if (
    WRITE_OR_MUTATION_INTENT.test(trimmed) ||
    EXECUTION_OR_SIDE_EFFECT_INTENT.test(trimmed) ||
    SHELL_SYNTAX_OR_REDIRECT.test(trimmed) ||
    FILE_WRITE_TARGET_HINT.test(trimmed)
  ) {
    return reject(
      "progressive-continue",
      "write_or_side_effect_intent",
      "Message requires file mutation, command execution, or external side effects.",
    );
  }

  const policy = createReadOnlyWorkerPolicy({ allowKnownConnectorReads: input.allowKnownConnectorReads });
  if (READONLY_QUERY_PATTERN.test(trimmed)) {
    return {
      eligible: true,
      classification: "readonly-query",
      reasonCode: "admitted_readonly_query",
      policy,
    };
  }
  if (LIGHT_QA_PATTERN.test(trimmed)) {
    return {
      eligible: true,
      classification: "light-qa",
      reasonCode: "admitted_light_qa",
      policy,
    };
  }

  return reject(
    "progressive-continue",
    "ambiguous_intent",
    "Intent could not be verified as conflict-free read-only or lightweight Q&A.",
  );
}

export type IsolationErrorCode =
  | "write_lock_forbidden"
  | "resource_claim_forbidden"
  | "tool_forbidden"
  | "approval_bypass_forbidden"
  | "safety_floor_blocked";

export class ReadOnlyWorkerIsolationError extends Error {
  readonly code: IsolationErrorCode;

  constructor(code: IsolationErrorCode, message: string) {
    super(message);
    this.name = "ReadOnlyWorkerIsolationError";
    this.code = code;
  }
}

export interface PrimaryWriteLock {
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceKey?: string;
  readonly acquiredAt: number;
}

export interface ReadOnlyWriteLockSnapshot {
  threadId: string;
  primaryLocked: boolean;
  primaryTurnId?: string;
  primaryWorkspaceKey?: string;
  activeWorkerIds: readonly string[];
  workerHoldsWriteLock: false;
}

/** Enforces that concurrent read-only workers never acquire primary workspace write locks or TurnResources. */
export class WriteLockGuard {
  private readonly primaryLocks = new Map<string, PrimaryWriteLock>();
  private readonly activeWorkers = new Map<string, Set<string>>();

  acquirePrimaryLock(input: {
    threadId: string;
    turnId: string;
    workspaceKey?: string;
    actorRole?: "primary" | "readonly-worker";
    now?: number;
  }): PrimaryWriteLock {
    if (input.actorRole === "readonly-worker") {
      throw new ReadOnlyWorkerIsolationError(
        "write_lock_forbidden",
        `Concurrent read-only worker cannot acquire workspace write lock for thread ${input.threadId}.`,
      );
    }
    const existing = this.primaryLocks.get(input.threadId);
    if (existing && existing.turnId !== input.turnId) {
      throw new ReadOnlyWorkerIsolationError(
        "write_lock_forbidden",
        `Thread ${input.threadId} write lock is already held by turn ${existing.turnId}.`,
      );
    }
    const lock: PrimaryWriteLock = {
      threadId: input.threadId,
      turnId: input.turnId,
      ...(input.workspaceKey ? { workspaceKey: input.workspaceKey } : {}),
      acquiredAt: input.now ?? Date.now(),
    };
    this.primaryLocks.set(input.threadId, lock);
    return lock;
  }

  releasePrimaryLock(threadId: string, turnId: string): boolean {
    const existing = this.primaryLocks.get(threadId);
    if (!existing || existing.turnId !== turnId) return false;
    this.primaryLocks.delete(threadId);
    return true;
  }

  registerWorker(threadId: string, workerId: string): void {
    let set = this.activeWorkers.get(threadId);
    if (!set) {
      set = new Set();
      this.activeWorkers.set(threadId, set);
    }
    set.add(workerId);
  }

  unregisterWorker(threadId: string, workerId: string): void {
    const set = this.activeWorkers.get(threadId);
    if (!set) return;
    set.delete(workerId);
    if (set.size === 0) this.activeWorkers.delete(threadId);
  }

  assertWorkerIsolated(input: {
    threadId: string;
    workerId: string;
    wantsWriteLock?: boolean;
    wantsTurnResources?: boolean;
    writesMemoryJournal?: boolean;
    mutatesResumeCursor?: boolean;
  }): void {
    if (input.wantsWriteLock) {
      throw new ReadOnlyWorkerIsolationError(
        "write_lock_forbidden",
        `Worker ${input.workerId} cannot acquire primary workspace write lock.`,
      );
    }
    if (input.wantsTurnResources) {
      throw new ReadOnlyWorkerIsolationError(
        "resource_claim_forbidden",
        `Worker ${input.workerId} cannot claim TurnResources computer/browser/phone seats.`,
      );
    }
    if (input.writesMemoryJournal || input.mutatesResumeCursor) {
      throw new ReadOnlyWorkerIsolationError(
        "write_lock_forbidden",
        `Worker ${input.workerId} cannot mutate memory journals or session resumeCursors.`,
      );
    }
    const held = this.primaryLocks.get(input.threadId);
    if (held && held.turnId === input.workerId) {
      throw new ReadOnlyWorkerIsolationError(
        "write_lock_forbidden",
        `Worker ${input.workerId} illegally holds primary write lock.`,
      );
    }
  }

  snapshot(threadId: string): ReadOnlyWriteLockSnapshot {
    const primary = this.primaryLocks.get(threadId);
    return {
      threadId,
      primaryLocked: Boolean(primary),
      ...(primary ? { primaryTurnId: primary.turnId } : {}),
      ...(primary?.workspaceKey ? { primaryWorkspaceKey: primary.workspaceKey } : {}),
      activeWorkerIds: [...(this.activeWorkers.get(threadId) ?? [])],
      workerHoldsWriteLock: false,
    };
  }
}

export type ToolAuthorizationRejection =
  | "invalid_policy"
  | "approval_escalation_forbidden"
  | "human_question_forbidden"
  | "safety_floor_blocked"
  | "shell_execution_forbidden"
  | "write_tool_forbidden"
  | "outbound_tool_forbidden"
  | "surface_tool_forbidden"
  | "integration_forbidden"
  | "tool_not_allowlisted";

export type ToolAuthorizationResult =
  | { allowed: true; tool: string; kind: "native-read" | "agents-read" | "connector-read" }
  | { allowed: false; reasonCode: ToolAuthorizationRejection; reason: string };

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "sh",
  "zsh",
  "shell",
  "exec",
  "execute",
  "run_command",
  "terminal",
  "cmd",
  "powershell",
  "pwsh",
  "composio_remote_bash_tool",
  "composio_remote_workbench",
]);

const WRITE_TOOL_NAMES = new Set([
  "edit",
  "write",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "apply_patch",
  "patch",
  "delete_file",
  "remove_file",
  "unlink",
  "move_file",
  "rename_file",
  "create_file",
  "write_file",
  "mkdir",
  "rm",
  "touch",
  "chmod",
  "chown",
  "memory_update",
  "memory_log",
  "skill_manage",
  "attach_file",
  "show_widget",
  "update_widget",
  "show_html",
  "update_html",
  "post_to_room",
  "propose_profile",
]);

const INTERACTIVE_ASK_TOOLS = new Set(["askuserquestion", "ask_user"]);
const DISALLOWED_SERVERS = new Set([
  "localComputer",
  "local-computer",
  "computer",
  "browser",
  "phone",
  "device",
  "email",
  "data",
  "dweb",
]);

function checkCommandSafety(commandLine: string | undefined): { blocked: boolean; reason?: string } {
  if (!commandLine) return { blocked: false };
  if (safetyFloorBlock(commandLine) !== null || !safetyFloorClears(commandLine)) {
    return { blocked: true, reason: "Command blocked or unreadable under active Safety Floor." };
  }
  const reading = floorReading(commandLine);
  if (!reading.read || reading.verdict !== null) {
    return { blocked: true, reason: reading.read ? `Blocked by safety floor: ${reading.verdict!.label}.` : "Unreadable command blocked by safety floor." };
  }
  return { blocked: false };
}

/** Fail-closed runtime tool authorization check for concurrent read-only workers. */
export function authorizeWorkerToolCall(call: {
  tool: string;
  server?: string;
  input?: Record<string, unknown>;
  commandLine?: string;
  origin?: "tool" | "output";
  requiresExplicitApproval?: boolean;
  approvalScope?: string;
  policy?: ReadOnlyWorkerPolicy;
}): ToolAuthorizationResult {
  const policy = call.policy ?? createReadOnlyWorkerPolicy();
  if (!policy.readOnly || policy.approvalMode !== "ask" || policy.allowApprovalBypass || policy.allowSafetyFloorBypass) {
    return { allowed: false, reasonCode: "invalid_policy", reason: "Worker policy is not strictly read-only." };
  }
  if (call.requiresExplicitApproval || call.approvalScope === "local-computer" || call.origin === "output") {
    return {
      allowed: false,
      reasonCode: "approval_escalation_forbidden",
      reason: "Concurrent read-only workers cannot widen sandboxes or escalate privileges.",
    };
  }

  const rawTool = call.tool.trim();
  if (!rawTool) {
    return { allowed: false, reasonCode: "tool_not_allowlisted", reason: "Empty tool name is refused." };
  }

  const cmd = call.commandLine ?? (call.input ? shellCommandOfToolCall(call.input) : undefined);
  const safety = checkCommandSafety(cmd);
  if (safety.blocked) {
    return { allowed: false, reasonCode: "safety_floor_blocked", reason: safety.reason! };
  }

  const normalized = rawTool.toLowerCase();
  const bare = normalized.replace(/^mcp__[^_]+__/, "");

  if (INTERACTIVE_ASK_TOOLS.has(bare)) {
    return {
      allowed: false,
      reasonCode: "human_question_forbidden",
      reason: "Concurrent read-only workers cannot open interactive AskUserQuestion cards.",
    };
  }
  if (SHELL_TOOL_NAMES.has(bare) || cmd !== undefined) {
    return {
      allowed: false,
      reasonCode: "shell_execution_forbidden",
      reason: `Shell execution tool "${rawTool}" is forbidden in read-only concurrent mode.`,
    };
  }
  if (WRITE_TOOL_NAMES.has(bare)) {
    return {
      allowed: false,
      reasonCode: "write_tool_forbidden",
      reason: `Write/mutation tool "${rawTool}" is forbidden in read-only concurrent mode.`,
    };
  }
  if (isOutboundTool(rawTool)) {
    return {
      allowed: false,
      reasonCode: "outbound_tool_forbidden",
      reason: `Outbound tool "${rawTool}" is forbidden in read-only concurrent mode.`,
    };
  }

  let server = call.server;
  let action = rawTool;
  if (rawTool.startsWith("mcp__")) {
    const [, parsedServer = "", ...rest] = rawTool.split("__");
    server ??= parsedServer;
    action = rest.join("__");
  }

  if (server) {
    if (DISALLOWED_SERVERS.has(server)) {
      return {
        allowed: false,
        reasonCode: "surface_tool_forbidden",
        reason: `Surface integration "${server}" is not permitted for concurrent read-only workers.`,
      };
    }
    if (server === "agents") {
      if (isReadOnlyAgentTool(action) && policy.allowedAgentTools.has(action)) {
        return { allowed: true, tool: action, kind: "agents-read" };
      }
      return {
        allowed: false,
        reasonCode: "tool_not_allowlisted",
        reason: `Built-in agent tool "${action}" is not in READ_ONLY_AGENT_TOOL_NAMES.`,
      };
    }
    if ((server === "composio" || server === "composioOwn" || server === "own_apps") && policy.allowKnownConnectorReads) {
      const calls = connectorCallsIn(action, call.input);
      if (calls.length > 0 && calls.every((one) => KNOWN_READ_SLUGS.has(one.slug) || isReadOnlyTool(one.slug))) {
        return { allowed: true, tool: rawTool, kind: "connector-read" };
      }
      return {
        allowed: false,
        reasonCode: "write_tool_forbidden",
        reason: `Connector tool "${action}" includes non-read operations.`,
      };
    }
    return {
      allowed: false,
      reasonCode: "integration_forbidden",
      reason: `MCP server "${server}" is not permitted by read-only worker policy.`,
    };
  }

  if (policy.allowedAgentTools.has(rawTool) && isReadOnlyAgentTool(rawTool)) {
    return { allowed: true, tool: rawTool, kind: "agents-read" };
  }
  if (policy.allowedNativeReadTools.has(normalized)) {
    return { allowed: true, tool: rawTool, kind: "native-read" };
  }

  return {
    allowed: false,
    reasonCode: "tool_not_allowlisted",
    reason: `Tool "${rawTool}" is not in the concurrent read-only allowlist.`,
  };
}

/** Strips mutating, stateful, and external-surface options before passing SendTurnInput to a worker adapter. */
export function sanitizeWorkerSendTurnInput(
  input: Omit<SendTurnInput, "threadId"> & { executionThreadId: string },
  policy: ReadOnlyWorkerPolicy = createReadOnlyWorkerPolicy(),
  driver?: DriverKind | string,
): SendTurnInput {
  const safeAgents = policy.allowedIntegrations.includes("agents") ? input.integrations?.agents : undefined;
  const { executionThreadId, videos: _videos, ...rest } = input as Omit<SendTurnInput, "threadId"> & {
    executionThreadId: string;
    videos?: unknown;
  };
  return {
    ...rest,
    threadId: executionThreadId,
    approvalMode: "ask",
    approvalModeNow: () => "ask",
    toolScope: createReadOnlyToolScope(policy, driver),
    sessionReset: true,
    ephemeral: true,
    resumeCursor: undefined,
    images: undefined,
    preloadBrowserTools: false,
    mcpFromUserConfig: false,
    botSettingsFile: undefined,
    userSkillsDir: undefined,
    skillFiles: undefined,
    ...(safeAgents ? { integrations: { agents: safeAgents } } : { integrations: undefined }),
  };
}

export type ReadOnlyWorkerLifecycleState =
  | "queued"
  | "running"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface ReadOnlyWorkerRecord {
  readonly workerId: string;
  readonly workerTurnId: string;
  readonly executionThreadId: string;
  readonly threadId: string;
  readonly botId: string;
  readonly parentTurnId?: string;
  readonly userMessageId: string;
  readonly replyToId: string;
  readonly query: string;
  readonly classification: ReadOnlyWorkerClassification;
  state: ReadOnlyWorkerLifecycleState;
  readonly startedAt: number;
  updatedAt: number;
  completedAt?: number;
  assistantMessageId?: string;
  accumulatedText: string;
  error?: string;
}
