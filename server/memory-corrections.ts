import type { DatabaseSync } from "node:sqlite";
import { redactSecretsInText } from "./redact.ts";
import { jsonPayload } from "./memory-capture.ts";
import {
  makePlaybookRuleId,
  PLAYBOOK_MAX_RULES,
  shouldRetireRule,
  type PlaybookRule,
} from "./memory-playbook.ts";

function hasSecret(text: string): boolean {
  return Boolean(text) && redactSecretsInText(text) !== text;
}

export interface LearningTurnInput {
  userText: string;
  previousAssistantText?: string;
  owner?: boolean;
  webhook?: boolean;
  automation?: boolean;
  regenerated?: boolean;
  toolActivities?: ReadonlyArray<{ name: string; ok?: boolean; summary?: string }>;
}

export interface LearningSignal {
  detected: boolean;
  reasons: Array<"user-correction" | "regenerated" | "tool-recovery">;
  matchedTools: string[];
}

const EN_CORRECTION = /\b(no,\s*don'?t|don'?t\s+(?:do|use|add|write|say|include|mention)|stop\s+(?:doing|using|adding)|actually,\s*(?:use|do|please|always|never)|never\s+(?:use|do|run|edit|commit)|always\s+(?:use|do|reply|keep|put)|instead\s+of|from\s+now\s+on|next\s+time)\b/i;
const ZH_CORRECTION = /(不要再|别再|别用|不要用|以后(?:都|直接|别|不要|记得)|下次(?:直接|别|不要|记得)|不是这个|搞错了|改用|记住(?:以后|别|不要)|不要问了|直接修|直接fix)/i;
const ONE_SHOT_FORMATTING = /^(?:make\s+(?:that|it|this)\s+(?:shorter|longer|concise|brief|simpler)|translate\s+(?:that|this|above)\b|shorten\s+(?:this|that|it)|rewrite\s+(?:this|that|it)\s+in\b|简短一点|缩短一下|翻译成|帮我润色一下)[\s.!?。！？]*$/i;

export function detectLearningSignal(input: LearningTurnInput): LearningSignal {
  if (input.owner === false || input.webhook || input.automation) {
    return { detected: false, reasons: [], matchedTools: [] };
  }
  const text = (input.userText ?? "").trim();
  if (hasSecret(text)) {
    return { detected: false, reasons: [], matchedTools: [] };
  }
  const reasons: LearningSignal["reasons"] = [];
  const matchedTools: string[] = [];

  if (text && !ONE_SHOT_FORMATTING.test(text) && (EN_CORRECTION.test(text) || ZH_CORRECTION.test(text))) {
    reasons.push("user-correction");
  }
  if (input.regenerated) {
    reasons.push("regenerated");
  }
  if (input.toolActivities && input.toolActivities.length >= 2) {
    const failedTools = new Set<string>();
    for (const activity of input.toolActivities) {
      if (!activity.name) continue;
      if (activity.ok === false) {
        failedTools.add(activity.name);
      } else if (activity.ok === true && failedTools.has(activity.name)) {
        if (!matchedTools.includes(activity.name)) matchedTools.push(activity.name);
      }
    }
    if (matchedTools.length > 0) reasons.push("tool-recovery");
  }
  return { detected: reasons.length > 0, reasons, matchedTools };
}

const statsInitialized = new WeakSet<DatabaseSync>();

export function ensurePlaybookStats(db: DatabaseSync): void {
  if (statsInitialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS playbook_stats (
      bot_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      helpful_delta INTEGER NOT NULL DEFAULT 0,
      harmful_delta INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (bot_id, rule_id)
    );
  `);
  statsInitialized.add(db);
}

export interface PlaybookAttributionResult {
  outcome: "helpful" | "harmful" | "neutral";
  ruleIds: string[];
}

export function evaluatePriorPlaybookAttribution(input: {
  db: DatabaseSync;
  botId: string;
  injectedRuleIds: readonly string[];
  nextUserTurn: LearningTurnInput;
  today: string;
  nowMs?: number;
}): PlaybookAttributionResult {
  const uniqueIds = [...new Set(input.injectedRuleIds.filter(Boolean))];
  if (!uniqueIds.length || input.nextUserTurn.owner === false || input.nextUserTurn.webhook || input.nextUserTurn.automation) {
    return { outcome: "neutral", ruleIds: [] };
  }
  ensurePlaybookStats(input.db);
  const signal = detectLearningSignal(input.nextUserTurn);
  const outcome: "helpful" | "harmful" = signal.reasons.includes("user-correction") || signal.reasons.includes("regenerated")
    ? "harmful"
    : "helpful";
  const helpfulInc = outcome === "helpful" ? 1 : 0;
  const harmfulInc = outcome === "harmful" ? 1 : 0;
  const ts = input.nowMs ?? Date.now();
  const stmt = input.db.prepare(`
    INSERT INTO playbook_stats (bot_id, rule_id, helpful_delta, harmful_delta, last_used_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, rule_id) DO UPDATE SET
      helpful_delta = playbook_stats.helpful_delta + excluded.helpful_delta,
      harmful_delta = playbook_stats.harmful_delta + excluded.harmful_delta,
      last_used_at = excluded.last_used_at,
      updated_at = excluded.updated_at
  `);
  for (const ruleId of uniqueIds) {
    stmt.run(input.botId, ruleId, helpfulInc, harmfulInc, input.today, ts);
  }
  return { outcome, ruleIds: uniqueIds };
}

export function flushPlaybookStats(db: DatabaseSync, botId: string, rules: readonly PlaybookRule[], today: string): {
  rules: PlaybookRule[];
  changed: boolean;
  retiredIds: string[];
} {
  ensurePlaybookStats(db);
  const rows = db.prepare(
    "SELECT rule_id, helpful_delta, harmful_delta, last_used_at FROM playbook_stats WHERE bot_id = ?",
  ).all(botId) as Array<{ rule_id: string; helpful_delta: number; harmful_delta: number; last_used_at: string | null }>;
  if (!rows.length) return { rules: [...rules], changed: false, retiredIds: [] };

  const byId = new Map(rows.map((r) => [r.rule_id, r]));
  let changed = false;
  const retiredIds: string[] = [];
  const updated = rules.map((rule) => {
    const stat = byId.get(rule.id);
    if (!stat) return rule;
    changed = true;
    const next: PlaybookRule = {
      ...rule,
      helpful: Math.max(0, rule.helpful + stat.helpful_delta),
      harmful: Math.max(0, rule.harmful + stat.harmful_delta),
      ...(stat.last_used_at ? { lastUsedAt: stat.last_used_at } : {}),
    };
    if (!next.struck && shouldRetireRule(next, today)) {
      next.struck = true;
      retiredIds.push(next.id);
    }
    return next;
  });

  db.prepare("DELETE FROM playbook_stats WHERE bot_id = ?").run(botId);
  return { rules: updated, changed, retiredIds };
}

export type PlaybookDeltaOp =
  | { op: "ADD"; scopes: string[]; when: string; instruction: string; evidence: string }
  | { op: "REFINE"; ruleId: string; when?: string; instruction: string; evidence: string }
  | { op: "CONTRADICT"; ruleId: string; evidence: string }
  | { op: "NONE" };

export function distillPlaybookDeltaPrompt(input: {
  botName: string;
  today: string;
  existingRules: readonly PlaybookRule[];
  userText: string;
  previousAssistantText?: string;
  toolSummary?: string;
}): string {
  const active = input.existingRules
    .filter((r) => !r.struck)
    .slice(0, 30)
    .map((r) => `[${r.id}] scope:${r.scopes.join(",")} | WHEN ${r.when} | DO ${r.instruction}`)
    .join("\n");
  return [
    `You are the PLAYBOOK REFLEXION step for ${input.botName}. Today is ${input.today}.`,
    "Extract at most ONE durable operational rule from this correction or tool recovery.",
    "Return NONE for one-shot requests, secrets, or facts that belong in personal memory rather than a reusable procedure.",
    "",
    "Existing active rules:",
    active || "(none)",
    "",
    `Previous assistant reply: ${(input.previousAssistantText ?? "(none)").slice(0, 600)}`,
    `User message: ${input.userText.slice(0, 1200)}`,
    ...(input.toolSummary ? [`Tool recovery trace: ${input.toolSummary.slice(0, 600)}`] : []),
    "",
    "Respond with one JSON object only:",
    '{"op": "ADD|REFINE|CONTRADICT|NONE", "ruleId": "optional pb-xxxx", "scopes": ["..."], "when": "<=140 chars", "instruction": "<=240 chars", "evidence": "exact quote from user or tool trace"}',
  ].join("\n");
}

export function parsePlaybookDelta(rawText: string): PlaybookDeltaOp {
  const parsed = jsonPayload(rawText);
  if (!parsed || typeof parsed !== "object") return { op: "NONE" };
  const obj = parsed as Record<string, unknown>;
  const op = typeof obj.op === "string" ? obj.op.trim().toUpperCase() : "NONE";
  const evidence = typeof obj.evidence === "string" ? obj.evidence.replace(/\s+/g, " ").trim().slice(0, 240) : "";
  if (op === "ADD") {
    const when = typeof obj.when === "string" ? obj.when.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    const instruction = typeof obj.instruction === "string" ? obj.instruction.replace(/\s+/g, " ").trim().slice(0, 240) : "";
    const scopes = Array.isArray(obj.scopes)
      ? obj.scopes.filter((s): s is string => typeof s === "string").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 6)
      : ["general"];
    if (!when || !instruction || !evidence) return { op: "NONE" };
    return { op: "ADD", scopes: scopes.length ? scopes : ["general"], when, instruction, evidence };
  }
  if (op === "REFINE") {
    const ruleId = typeof obj.ruleId === "string" ? obj.ruleId.trim() : "";
    const instruction = typeof obj.instruction === "string" ? obj.instruction.replace(/\s+/g, " ").trim().slice(0, 240) : "";
    const when = typeof obj.when === "string" ? obj.when.replace(/\s+/g, " ").trim().slice(0, 140) : undefined;
    if (!ruleId || !instruction || !evidence) return { op: "NONE" };
    return { op: "REFINE", ruleId, ...(when ? { when } : {}), instruction, evidence };
  }
  if (op === "CONTRADICT") {
    const ruleId = typeof obj.ruleId === "string" ? obj.ruleId.trim() : "";
    if (!ruleId || !evidence) return { op: "NONE" };
    return { op: "CONTRADICT", ruleId, evidence };
  }
  return { op: "NONE" };
}

export function applyPlaybookDelta(input: {
  rules: readonly PlaybookRule[];
  delta: PlaybookDeltaOp;
  provenanceText: string;
  today: string;
  source?: string;
}): { rules: PlaybookRule[]; changed: boolean; affectedId?: string } {
  if (input.delta.op === "NONE") return { rules: [...input.rules], changed: false };
  const normProv = input.provenanceText.toLowerCase().replace(/\s+/g, " ");
  const normEv = input.delta.evidence.toLowerCase().replace(/\s+/g, " ");
  if (!normEv || hasSecret(input.delta.evidence) || !normProv.includes(normEv)) {
    return { rules: [...input.rules], changed: false };
  }

  const next = input.rules.map((r) => ({ ...r }));
  if (input.delta.op === "ADD") {
    if (hasSecret(input.delta.when) || hasSecret(input.delta.instruction)) return { rules: next, changed: false };
    const id = makePlaybookRuleId(input.delta.when, input.delta.instruction);
    const existing = next.find((r) => r.id === id);
    if (existing) {
      existing.struck = false;
      existing.helpful += 1;
      existing.lastUsedAt = input.today;
      return { rules: next, changed: true, affectedId: id };
    }
    next.unshift({
      id,
      scopes: input.delta.scopes,
      when: input.delta.when,
      instruction: input.delta.instruction,
      evidence: input.delta.evidence,
      helpful: 1,
      harmful: 0,
      createdAt: input.today,
      lastUsedAt: input.today,
      source: input.source ?? "playbook-learn",
    });
    return { rules: next.slice(0, PLAYBOOK_MAX_RULES), changed: true, affectedId: id };
  }

  if (input.delta.op === "REFINE") {
    if (hasSecret(input.delta.instruction) || (input.delta.when && hasSecret(input.delta.when))) return { rules: next, changed: false };
    const target = next.find((r) => r.id === input.delta.ruleId);
    if (!target) return { rules: next, changed: false };
    target.instruction = input.delta.instruction;
    if (input.delta.when) target.when = input.delta.when;
    target.evidence = input.delta.evidence;
    target.lastUsedAt = input.today;
    target.struck = false;
    return { rules: next, changed: true, affectedId: target.id };
  }

  const target = next.find((r) => r.id === input.delta.ruleId);
  if (!target) return { rules: next, changed: false };
  target.harmful += 1;
  target.lastUsedAt = input.today;
  if (shouldRetireRule(target, input.today)) target.struck = true;
  return { rules: next, changed: true, affectedId: target.id };
}
