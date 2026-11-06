import { expect, it } from "vitest";
import { reportKindForRoutine } from "./report-routine.ts";

it("recognizes existing report Automations without choosing unrelated GitHub or AI work", () => {
  const kind = (name: string, prompt = "Gather the report.") => reportKindForRoutine({ name, prompt });
  expect(kind("X 每日 AI 动态")).toBe("x_ai_digest");
  expect(kind("AI 早报（新闻版 + 开源版）")).toBe("github_activity");
  expect(kind("GitHub active projects report")).toBe("github_activity");
  expect(kind("Merge GitHub upstream updates")).toBeNull();
  expect(kind("AI weekly review")).toBeNull();
  expect(kind("Daily report", 'Use mini_app_report kind "x_ai_digest".')).toBe("x_ai_digest");
  expect(kind("Daily report", "Use mini_app_report x_ai_digest and github_activity.")).toBeNull();
  expect(kind("Daily report", "Review x_ai_digest source code.")).toBeNull();
  expect(kind("X AI and GitHub digest")).toBeNull();
});
