import { describe, expect, it } from "vitest";
import {
  findPlaybookSkillGraduationCandidates,
  runBotSleepConsolidation,
  selectNextSleepBot,
  SLEEP_COOLDOWN_MS,
  SLEEP_IDLE_MIN_MS,
  SLEEP_MEMORY_DIET_BYTES,
} from "./memory-sleep.ts";
import type { PlaybookRule } from "./memory-playbook.ts";

describe("memory-sleep (Sleep-Time Compute v2)", () => {
  it("selects highest-priority idle bot while respecting busy, 30m idle, and 12h cooldown gates", () => {
    const now = 1_000_000_000;
    const picked = selectNextSleepBot({
      nowMs: now,
      bots: [
        {
          id: "bot-busy",
          memoryBytes: 12_000,
          busy: true,
          budget: { capturesSinceSleep: 10, correctionsSinceSleep: 5, unlinkedTopics: 2, lastActivityAt: now - SLEEP_IDLE_MIN_MS - 1 },
        },
        {
          id: "bot-cooldown",
          memoryBytes: 12_000,
          busy: false,
          budget: { capturesSinceSleep: 10, correctionsSinceSleep: 5, unlinkedTopics: 2, lastActivityAt: now - SLEEP_IDLE_MIN_MS - 1, lastSleepAt: now - SLEEP_COOLDOWN_MS + 60_000 },
        },
        {
          id: "bot-ready",
          memoryBytes: SLEEP_MEMORY_DIET_BYTES + 100,
          busy: false,
          budget: { capturesSinceSleep: 5, correctionsSinceSleep: 2, unlinkedTopics: 1, lastActivityAt: now - SLEEP_IDLE_MIN_MS - 5_000 },
        },
      ],
    });
    expect(picked).toEqual({
      botId: "bot-ready",
      reasons: ["captures", "corrections", "unlinked-topics", "memory-diet"],
    });
  });

  it("silently suppresses user-visible ideas for non-dreamer bots and preempts immediately when bot turns busy", async () => {
    let busy = false;
    const silent = await runBotSleepConsolidation({
      botId: "bot-worker",
      isDreamer: false,
      isBusy: () => busy,
      evolveTopics: async () => 2,
      runCrossThreadDream: async () => ({ learned: 3, ideas: ["Should never be shown to user"] }),
    });
    expect(silent.aborted).toBe(false);
    expect(silent.emittedUserIdeas).toEqual([]);

    busy = false;
    const preempted = await runBotSleepConsolidation({
      botId: "bot-worker",
      isDreamer: true,
      isBusy: () => busy,
      evolveTopics: async () => {
        busy = true;
        return 1;
      },
      runCrossThreadDream: async () => ({ learned: 1, ideas: ["Should be aborted"] }),
    });
    expect(preempted.aborted).toBe(true);
    expect(preempted.stepsRun).toEqual(["topic-evolution"]);
    expect(preempted.emittedUserIdeas).toEqual([]);
  });

  it("graduates clusters of >= 4 proven playbook rules (helpful >= 3, harmful === 0) into skill-review candidates", () => {
    const rules: PlaybookRule[] = Array.from({ length: 4 }, (_, i) => ({
      id: `pb-000${i}`,
      scopes: ["mini-apps"],
      when: `case ${i}`,
      instruction: `do step ${i}`,
      evidence: `ev ${i}`,
      helpful: 4,
      harmful: 0,
      createdAt: "2026-11-20",
      source: "playbook-learn",
    }));
    rules.push({
      id: "pb-harm",
      scopes: ["mini-apps"],
      when: "bad",
      instruction: "bad",
      evidence: "ev",
      helpful: 5,
      harmful: 1,
      createdAt: "2026-11-20",
      source: "playbook-learn",
    });

    const candidates = findPlaybookSkillGraduationCandidates(rules, ["mini-apps", "other-skill"]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.scope).toBe("mini-apps");
    expect(candidates[0]!.ruleIds).toEqual(["pb-0000", "pb-0001", "pb-0002", "pb-0003"]);
  });
});
