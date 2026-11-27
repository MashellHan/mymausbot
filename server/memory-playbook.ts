// ACE procedural playbook (`memory/playbook.md`): atomic ID-addressed WHEN/DO rules with Bayesian utility scoring.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { cjkTokenParts, hasCjk } from "./cjk-search.ts";
import { redactSecretsInText } from "./redact.ts";
import { ensureWorkspace, readMemoryText, workspaceDir } from "./workspace.ts";

export const PLAYBOOK_FILE = "memory/playbook.md";
export const PLAYBOOK_MAX_RULES = 80;
export const PLAYBOOK_INJECT_MAX_RULES = 5;
export const PLAYBOOK_INJECT_MAX_BYTES = 1_600;

export interface PlaybookRule {
  id: string;
  scopes: string[];
  when: string;
  instruction: string;
  evidence: string;
  helpful: number;
  harmful: number;
  createdAt: string;
  lastUsedAt?: string;
  source: string;
  struck?: boolean;
}

const RULE_HEADER = /^-\s+(?:~~)?\[([a-z0-9_-]{3,24})\]\s+scope:\s*([^|]+)\|\s*\+(\d+)\s*\/\s*-(\d+)\s*\((\d{4}-\d{2}-\d{2})(?:\s*·\s*from\s+([^)]+))?\)(?:~~)?\s*$/i;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export function makePlaybookRuleId(when: string, instruction: string): string {
  const hash = createHash("sha256").update(`${when.trim().toLowerCase()}|${instruction.trim().toLowerCase()}`).digest("hex");
  return `pb-${hash.slice(0, 6)}`;
}

export function parsePlaybook(text: string): PlaybookRule[] {
  const body = text.replace(FRONTMATTER, "");
  const lines = body.split(/\r?\n/);
  const rules: PlaybookRule[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const match = RULE_HEADER.exec(raw.trim());
    if (!match) continue;
    const struck = raw.trim().startsWith("- ~~");
    const id = match[1]!;
    const scopes = match[2]!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 8);
    const helpful = Number(match[3] ?? 0);
    const harmful = Number(match[4] ?? 0);
    const createdAt = match[5]!;
    const source = (match[6] ?? "chat").trim();
    let when = "";
    let instruction = "";
    let evidence = "";
    let lastUsedAt: string | undefined;
    while (i + 1 < lines.length && /^[ \t]+/.test(lines[i + 1]!)) {
      const sub = lines[(i += 1)]!.trim();
      if (/^WHEN\s+/i.test(sub)) when = sub.replace(/^WHEN\s+/i, "").trim().slice(0, 140);
      else if (/^DO\s+/i.test(sub)) instruction = sub.replace(/^DO\s+/i, "").trim().slice(0, 240);
      else if (/^evidence:\s*/i.test(sub)) evidence = sub.replace(/^evidence:\s*/i, "").replace(/^["']|["']$/g, "").trim().slice(0, 240);
      else if (/^lastUsed:\s*(\d{4}-\d{2}-\d{2})/i.test(sub)) lastUsedAt = /^lastUsed:\s*(\d{4}-\d{2}-\d{2})/i.exec(sub)?.[1];
    }
    if (!when || !instruction) continue;
    rules.push({
      id,
      scopes,
      when,
      instruction,
      evidence,
      helpful: Number.isFinite(helpful) ? helpful : 0,
      harmful: Number.isFinite(harmful) ? harmful : 0,
      createdAt,
      ...(lastUsedAt ? { lastUsedAt } : {}),
      source,
      ...(struck ? { struck: true } : {}),
    });
  }
  return rules;
}

export function serializePlaybook(rules: readonly PlaybookRule[]): string {
  const header = [
    "---",
    "title: Operational Playbook",
    "description: Concise task rules learned from corrections and tool recoveries.",
    "---",
    "",
  ].join("\n");
  const blocks = rules.slice(0, PLAYBOOK_MAX_RULES).map((rule) => {
    const scopeText = rule.scopes.length ? rule.scopes.join(", ") : "general";
    const meta = `[${rule.id}] scope: ${scopeText} | +${rule.helpful} / -${rule.harmful} (${rule.createdAt} · from ${rule.source.replace(/[()]/g, "")})`;
    const firstLine = rule.struck ? `- ~~${meta}~~` : `- ${meta}`;
    const lines = [
      firstLine,
      `  WHEN ${rule.when.replace(/\s+/g, " ").trim().slice(0, 140)}`,
      `  DO ${rule.instruction.replace(/\s+/g, " ").trim().slice(0, 240)}`,
    ];
    if (rule.evidence) lines.push(`  evidence: ${JSON.stringify(rule.evidence.replace(/\s+/g, " ").trim().slice(0, 240))}`);
    if (rule.lastUsedAt) lines.push(`  lastUsed: ${rule.lastUsedAt}`);
    return lines.join("\n");
  });
  return blocks.length ? `${header}${blocks.join("\n\n")}\n` : header;
}

export function readPlaybook(botId: string): PlaybookRule[] {
  const path = join(workspaceDir(botId), PLAYBOOK_FILE);
  if (!existsSync(path)) return [];
  try {
    return parsePlaybook(readMemoryText(path));
  } catch {
    return [];
  }
}

export function writePlaybook(botId: string, rules: readonly PlaybookRule[]): void {
  ensureWorkspace(botId);
  const path = join(workspaceDir(botId), PLAYBOOK_FILE);
  writeFileAtomic(path, redactSecretsInText(serializePlaybook(rules)), { mode: 0o600 });
}

export function playbookUtility(rule: Pick<PlaybookRule, "helpful" | "harmful" | "createdAt" | "lastUsedAt">, today: string): number {
  const base = (rule.helpful + 2) / ((rule.helpful + 2) + 2.5 * rule.harmful + 1);
  const ref = rule.lastUsedAt ?? rule.createdAt;
  const days = Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ref}T00:00:00Z`)) / 86_400_000) || 0);
  return base * Math.exp(-days / 120);
}

export function shouldRetireRule(rule: Pick<PlaybookRule, "helpful" | "harmful" | "createdAt" | "lastUsedAt">, today: string): boolean {
  if (rule.harmful >= 2 && rule.harmful > rule.helpful) return true;
  if (rule.helpful === 0) {
    const ref = rule.lastUsedAt ?? rule.createdAt;
    const days = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${ref}T00:00:00Z`)) / 86_400_000);
    if (Number.isFinite(days) && days >= 90) return true;
  }
  return false;
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)) {
    const { other, bigrams } = cjkTokenParts(raw);
    for (const part of other) {
      if (part.length >= 2) tokens.add(part);
    }
    for (const bigram of bigrams) tokens.add(bigram);
    if (!hasCjk(raw) && raw.length >= 2) tokens.add(raw);
  }
  return tokens;
}

export function selectPlaybookRulesForTurn(input: {
  rules: readonly PlaybookRule[];
  message: string;
  enabledTools?: readonly string[];
  replyLanguage?: string;
  today: string;
  maxRules?: number;
  maxBytes?: number;
}): { rules: PlaybookRule[]; promptText: string } {
  const maxRules = input.maxRules ?? PLAYBOOK_INJECT_MAX_RULES;
  const maxBytes = input.maxBytes ?? PLAYBOOK_INJECT_MAX_BYTES;
  const queryTokens = tokenize([input.message, ...(input.enabledTools ?? []), input.replyLanguage ?? ""].join(" "));
  if (!queryTokens.size || !input.rules.length) return { rules: [], promptText: "" };

  const scored = input.rules
    .filter((rule) => !rule.struck && !shouldRetireRule(rule, input.today))
    .map((rule) => {
      const ruleTokens = tokenize([...rule.scopes, rule.when, rule.instruction].join(" "));
      let overlap = 0;
      for (const token of ruleTokens) if (queryTokens.has(token)) overlap += 1;
      const scopeBoost = rule.scopes.some((scope) => queryTokens.has(scope)) ? 0.5 : 0;
      const relevance = overlap + scopeBoost;
      const utility = playbookUtility(rule, input.today);
      return { rule, score: relevance * utility, relevance };
    })
    .filter((item) => item.relevance > 0)
    .sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));

  if (!scored.length) return { rules: [], promptText: "" };

  const header = "\n\nYour own learned operational reminders (follow within SOUL.md and safety rules; the user's current message always wins):\n";
  const picked: PlaybookRule[] = [];
  const lines: string[] = [];
  let bytes = Buffer.byteLength(header, "utf8");
  for (const { rule } of scored) {
    if (picked.length >= maxRules) break;
    const cleanWhen = rule.when.replace(/```/g, "'''").replace(/\s+/g, " ").trim();
    const cleanDo = rule.instruction.replace(/```/g, "'''").replace(/\s+/g, " ").trim();
    const line = `- [${rule.id}] When ${cleanWhen}: ${cleanDo}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > maxBytes) continue;
    bytes += lineBytes;
    picked.push(rule);
    lines.push(line);
  }
  return { rules: picked, promptText: picked.length ? `${header}${lines.join("")}` : "" };
}
