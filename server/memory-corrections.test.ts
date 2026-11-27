import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  applyPlaybookDelta,
  detectLearningSignal,
  evaluatePriorPlaybookAttribution,
  flushPlaybookStats,
  parsePlaybookDelta,
} from "./memory-corrections.ts";
import type { PlaybookRule } from "./memory-playbook.ts";

describe("memory-corrections (Reflexion loop & ACE attribution)", () => {
  it("detects EN/ZH user corrections and tool-failure recoveries while filtering one-shot & non-owner turns", () => {
    expect(detectLearningSignal({ userText: "以后直接fix 不要问了" })).toEqual({
      detected: true,
      reasons: ["user-correction"],
      matchedTools: [],
    });
    expect(detectLearningSignal({ userText: "No, don't run local tsc — always let CI typecheck." })).toEqual({
      detected: true,
      reasons: ["user-correction"],
      matchedTools: [],
    });
    expect(detectLearningSignal({
      userText: "check status",
      toolActivities: [
        { name: "bash", ok: false, summary: "command not found" },
        { name: "bash", ok: true, summary: "ok" },
      ],
    })).toEqual({
      detected: true,
      reasons: ["tool-recovery"],
      matchedTools: ["bash"],
    });

    // Hard negative filters
    expect(detectLearningSignal({ userText: "Make that shorter." }).detected).toBe(false);
    expect(detectLearningSignal({ userText: "简短一点" }).detected).toBe(false);
    expect(detectLearningSignal({ userText: "以后不要用了", owner: false }).detected).toBe(false);
    expect(detectLearningSignal({ userText: "don't use that", webhook: true }).detected).toBe(false);
    expect(detectLearningSignal({ userText: "never share sk-1234567890abcdefghijklmnop" }).detected).toBe(false);
  });

  it("attributes +helpful/-harmful in SQLite playbook_stats and auto-retires harmful rules on flush", () => {
    const db = new DatabaseSync(":memory:");
    const baseRules: PlaybookRule[] = [{
      id: "pb-abc123",
      scopes: ["git"],
      when: "pushing PRs",
      instruction: "run local full build",
      evidence: "old rule",
      helpful: 0,
      harmful: 1,
      createdAt: "2026-11-20",
      source: "chat",
    }];

    const attr1 = evaluatePriorPlaybookAttribution({
      db,
      botId: "bot-1",
      injectedRuleIds: ["pb-abc123"],
      nextUserTurn: { userText: "No, don't run local builds!" },
      today: "2026-11-27",
    });
    expect(attr1).toEqual({ outcome: "harmful", ruleIds: ["pb-abc123"] });

    const flushed = flushPlaybookStats(db, "bot-1", baseRules, "2026-11-27");
    expect(flushed.changed).toBe(true);
    expect(flushed.retiredIds).toEqual(["pb-abc123"]);
    expect(flushed.rules[0]!.harmful).toBe(2);
    expect(flushed.rules[0]!.struck).toBe(true);
  });

  it("applies ADD / REFINE / CONTRADICT deltas only when evidence passes provenance check", () => {
    const delta = parsePlaybookDelta(JSON.stringify({
      op: "ADD",
      scopes: ["workflow", "pr"],
      when: "fixing bugs in repo",
      instruction: "Fix directly without asking for confirmation first.",
      evidence: "以后直接fix 不要问了",
    }));

    const rejected = applyPlaybookDelta({
      rules: [],
      delta,
      provenanceText: "unrelated conversation text",
      today: "2026-11-27",
    });
    expect(rejected.changed).toBe(false);

    const added = applyPlaybookDelta({
      rules: [],
      delta,
      provenanceText: "User: 以后直接fix 不要问了",
      today: "2026-11-27",
    });
    expect(added.changed).toBe(true);
    expect(added.rules).toHaveLength(1);
    const id = added.affectedId!;

    const refined = applyPlaybookDelta({
      rules: added.rules,
      delta: {
        op: "REFINE",
        ruleId: id,
        instruction: "Fix bugs in isolated worktrees directly without pausing to ask.",
        evidence: "直接fix",
      },
      provenanceText: "User: 以后直接fix 不要问了",
      today: "2026-11-27",
    });
    expect(refined.changed).toBe(true);
    expect(refined.rules[0]!.instruction).toContain("isolated worktrees");
  });
});
