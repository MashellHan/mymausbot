import type { PlaybookRule } from "./memory-playbook.ts";

export const SLEEP_IDLE_MIN_MS = 30 * 60_000;
export const SLEEP_COOLDOWN_MS = 12 * 60 * 60_000;
export const SLEEP_MEMORY_DIET_BYTES = 8 * 1024;
export const SLEEP_MIN_CAPTURES_TRIGGER = 4;
export const SLEEP_MIN_CORRECTIONS_TRIGGER = 2;
export const SLEEP_SKILL_GRADUATION_MIN_RULES = 4;
export const SLEEP_SKILL_GRADUATION_MIN_HELPFUL = 3;

export interface BotSleepBudget {
  capturesSinceSleep: number;
  correctionsSinceSleep: number;
  unlinkedTopics: number;
  lastActivityAt: number;
  lastSleepAt?: number;
}

export interface SleepCandidateSelection {
  botId: string;
  reasons: Array<"captures" | "corrections" | "unlinked-topics" | "memory-diet">;
}

export function selectNextSleepBot(input: {
  bots: ReadonlyArray<{ id: string; memoryBytes: number; busy: boolean; budget: BotSleepBudget }>;
  nowMs: number;
}): SleepCandidateSelection | null {
  let best: { selection: SleepCandidateSelection; score: number } | null = null;
  for (const bot of input.bots) {
    if (bot.busy) continue;
    const idleMs = input.nowMs - bot.budget.lastActivityAt;
    if (idleMs < SLEEP_IDLE_MIN_MS) continue;
    if (bot.budget.lastSleepAt && input.nowMs - bot.budget.lastSleepAt < SLEEP_COOLDOWN_MS) continue;

    const reasons: SleepCandidateSelection["reasons"] = [];
    let score = 0;
    if (bot.budget.capturesSinceSleep >= SLEEP_MIN_CAPTURES_TRIGGER) {
      reasons.push("captures");
      score += bot.budget.capturesSinceSleep * 2;
    }
    if (bot.budget.correctionsSinceSleep >= SLEEP_MIN_CORRECTIONS_TRIGGER) {
      reasons.push("corrections");
      score += bot.budget.correctionsSinceSleep * 4;
    }
    if (bot.budget.unlinkedTopics >= 1) {
      reasons.push("unlinked-topics");
      score += bot.budget.unlinkedTopics * 3;
    }
    if (bot.memoryBytes >= SLEEP_MEMORY_DIET_BYTES) {
      reasons.push("memory-diet");
      score += 10;
    }
    if (!reasons.length) continue;
    if (!best || score > best.score) {
      best = { selection: { botId: bot.id, reasons }, score };
    }
  }
  return best?.selection ?? null;
}

export interface SkillGraduationCandidate {
  scope: string;
  ruleIds: string[];
  rules: PlaybookRule[];
}

export function findPlaybookSkillGraduationCandidates(
  rules: readonly PlaybookRule[],
  editableSkillNames: readonly string[],
): SkillGraduationCandidate[] {
  const editable = new Set(editableSkillNames.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const byScope = new Map<string, PlaybookRule[]>();
  for (const rule of rules) {
    if (rule.struck) continue;
    if (rule.helpful < SLEEP_SKILL_GRADUATION_MIN_HELPFUL || rule.harmful > 0) continue;
    for (const scope of rule.scopes) {
      const key = scope.trim().toLowerCase();
      if (!key) continue;
      if (editable.size > 0 && !editable.has(key)) continue;
      const list = byScope.get(key) ?? [];
      list.push(rule);
      byScope.set(key, list);
    }
  }
  const candidates: SkillGraduationCandidate[] = [];
  for (const [scope, group] of byScope) {
    if (group.length >= SLEEP_SKILL_GRADUATION_MIN_RULES) {
      candidates.push({ scope, ruleIds: group.map((r) => r.id), rules: group });
    }
  }
  return candidates.sort((a, b) => b.rules.length - a.rules.length);
}

export interface SleepStepOutcome {
  botId: string;
  aborted: boolean;
  stepsRun: string[];
  emittedUserIdeas: string[];
  graduationCandidates: SkillGraduationCandidate[];
}

export async function runBotSleepConsolidation(input: {
  botId: string;
  isDreamer: boolean;
  isBusy: () => boolean;
  signal?: AbortSignal;
  evolveTopics?: (signal: AbortSignal) => Promise<number>;
  runMemoryDiet?: (signal: AbortSignal) => Promise<number>;
  runCrossThreadDream?: (signal: AbortSignal) => Promise<{ learned: number; ideas: string[] }>;
  loadPlaybook?: () => readonly PlaybookRule[];
  editableSkillNames?: readonly string[];
}): Promise<SleepStepOutcome> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });

  const checkPreempt = (): boolean => {
    if (controller.signal.aborted || input.isBusy()) {
      controller.abort();
      return true;
    }
    return false;
  };

  const stepsRun: string[] = [];
  let emittedUserIdeas: string[] = [];
  let graduationCandidates: SkillGraduationCandidate[] = [];

  try {
    if (checkPreempt()) return { botId: input.botId, aborted: true, stepsRun, emittedUserIdeas, graduationCandidates };
    if (input.evolveTopics) {
      await input.evolveTopics(controller.signal);
      stepsRun.push("topic-evolution");
    }
    if (checkPreempt()) return { botId: input.botId, aborted: true, stepsRun, emittedUserIdeas, graduationCandidates };
    if (input.runMemoryDiet) {
      await input.runMemoryDiet(controller.signal);
      stepsRun.push("memory-diet");
    }
    if (checkPreempt()) return { botId: input.botId, aborted: true, stepsRun, emittedUserIdeas, graduationCandidates };
    if (input.runCrossThreadDream) {
      const dream = await input.runCrossThreadDream(controller.signal);
      stepsRun.push("cross-thread-dream");
      // Strictly gate user-visible ideas to the designated dreamer bot; all other bots consolidate silently.
      if (input.isDreamer) {
        emittedUserIdeas = dream.ideas;
      }
    }
    if (checkPreempt()) return { botId: input.botId, aborted: true, stepsRun, emittedUserIdeas, graduationCandidates };
    if (input.loadPlaybook) {
      graduationCandidates = findPlaybookSkillGraduationCandidates(
        input.loadPlaybook(),
        input.editableSkillNames ?? [],
      );
      stepsRun.push("skill-graduation-scan");
    }
    return { botId: input.botId, aborted: false, stepsRun, emittedUserIdeas, graduationCandidates };
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}
