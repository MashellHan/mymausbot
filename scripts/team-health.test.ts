import { describe, expect, it } from "vitest";
import { analyzeTranscriptRows, detectAnomalies } from "./team-health.mjs";

describe("team-health monitor", () => {
  it("computes LLM latency, manage_task polls, local tsc/build runs, and errors within window", () => {
    const base = Date.UTC(2026, 10, 26, 8, 0, 0);
    const iso = (sec: number) => new Date(base + sec * 1000).toISOString();
    const rows = [
      { type: "USER_INPUT", created_at: iso(0), content: "Implement feature" },
      {
        type: "PLANNER_RESPONSE",
        created_at: iso(10),
        model: "gemini-4-hydrogen-high",
        input_tokens: 40_000,
        cache_read_tokens: 60_000,
        tool_calls: [
          { name: "read_file", args: { Path: "a.ts" } },
          { name: "run_command", args: { CommandLine: "pnpm typecheck --project server" } },
        ],
      },
      { type: "GENERIC", created_at: iso(25), content: "done" },
      {
        type: "PLANNER_RESPONSE",
        created_at: iso(35),
        model: "gemini-4-hydrogen-high",
        input_tokens: 45_000,
        cache_read_tokens: 65_000,
        tool_calls: [
          { name: "manage_task", args: { Action: "status" } },
          { name: "edit_file", args: { Path: "a.ts" } },
          { name: "run_command", args: { CommandLine: "npx vitest run a.test.ts" } },
        ],
      },
      { type: "ERROR_MESSAGE", created_at: iso(40), error: "Error 502, Message: Upstream Gemini conversion failed" },
    ];

    const stats = analyzeTranscriptRows(rows, base - 60_000);
    expect(stats.model).toBe("gemini-4-hydrogen-high");
    expect(stats.contextK).toBe(110);
    expect(stats.llmCalls).toBe(2);
    expect(stats.avgLlmSec).toBe(10);
    expect(stats.polls).toBe(1);
    expect(stats.tscRuns).toBe(1);
    expect(stats.vitestRuns).toBe(1);
    expect(stats.reads).toBe(1);
    expect(stats.edits).toBe(1);
    expect(stats.errors).toBe(1);
  });

  it("flags CPU saturation, poll loops, dev local builds, worktree bloat, and backup cap violations", () => {
    const anomalies = detectAnomalies({
      load1m: 62.5,
      cpuCount: 10,
      totalWorktrees: 18,
      staleWorktrees: 2,
      deliveryBackups: 5,
      stuckTscCount: 2,
      seats: [
        { name: "mausbot-back", polls: 6, tscRuns: 4, buildRuns: 0, errors: 6, reads: 120, edits: 0, llmCalls: 50 },
        { name: "mausbot-front", polls: 5, tscRuns: 1, buildRuns: 2, errors: 0, reads: 10, edits: 4, llmCalls: 15 },
      ],
    });
    const codes = anomalies.map((a) => a.code);
    expect(codes).toContain("cpu-saturation");
    expect(codes).toContain("feature-dev-tsc");
    expect(codes).toContain("poll-loop");
    expect(codes).toContain("dev-local-build");
    expect(codes).toContain("upstream-errors");
    expect(codes).toContain("read-only-spin");
    expect(codes).toContain("worktree-bloat");
    expect(codes).toContain("backup-cap-exceeded");
    expect(anomalies.filter((a) => a.code === "poll-loop").map((a) => a.seat)).toEqual(["mausbot-back"]);
    expect(anomalies.filter((a) => a.code === "dev-local-build").map((a) => a.seat)).toEqual(["mausbot-back"]);
  });

  it("alerts when total worktrees exceed 15 even if none are stale yet", () => {
    const anomalies = detectAnomalies({
      load1m: 1,
      cpuCount: 10,
      totalWorktrees: 16,
      staleWorktrees: 0,
      deliveryBackups: 0,
      stuckTscCount: 0,
      seats: [],
    });
    expect(anomalies.map((a) => a.code)).toContain("worktree-bloat");
  });
});
