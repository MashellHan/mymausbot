import { describe, expect, it } from "vitest";
import { weeklyUsageTrend } from "./local-usage-trends";
import type { UsageTrendDay } from "./local-usage-view";

const counts = { prs: 1, knownPrs: 1, commits: 2, knownCommits: 2 };
const day = (date: string, patch: Partial<UsageTrendDay> = {}): UsageTrendDay => ({
  day: date, ...counts, coverage: "ready", tokenStatus: "ready", newTokens: 3, cacheRead: 4, totalTokens: 7,
  categories: { work: counts, personal: { prs: 0, knownPrs: 0, commits: 0, knownCommits: 0 },
    unclassified: { prs: 0, knownPrs: 0, commits: 0, knownCommits: 0 } },
  wow: { prs: null, commits: null, newTokens: null, totalTokens: null }, ...patch,
});

describe("Monday-based Usage weeks", () => {
  it("keeps partial boundary weeks and sums only the selected real dates", () => {
    const daily = [day("2026-11-01"), ...Array.from({ length: 7 }, (_, index) => day(`2026-11-0${index + 2}`)), day("2026-11-09")];
    const weeks = weeklyUsageTrend(daily);
    expect(weeks.map(({ day, endDay, prs, commits, totalTokens }) => ({ day, endDay, prs, commits, totalTokens }))).toEqual([
      { day: "2026-11-01", endDay: "2026-11-01", prs: 1, commits: 2, totalTokens: 7 },
      { day: "2026-11-02", endDay: "2026-11-08", prs: 7, commits: 14, totalTokens: 49 },
      { day: "2026-11-09", endDay: "2026-11-09", prs: 1, commits: 2, totalTokens: 7 },
    ]);
    expect(weeks.reduce((total, week) => total + week.totalTokens!, 0)).toBe(daily.reduce((total, day) => total + day.totalTokens!, 0));
    expect(weeks[1]?.categories.work.commits).toBe(14);
  });

  it("keeps observed lower bounds, missing dates, partial tokens and confirmed zero distinct", () => {
    const missing = { prs: null, knownPrs: null, commits: null, knownCommits: null };
    const week = weeklyUsageTrend([day("2026-11-02"), day("2026-11-03", { ...missing, coverage: "unavailable", tokenStatus: "unavailable",
      newTokens: null, cacheRead: null, totalTokens: null, categories: { work: missing, personal: missing, unclassified: missing } })])[0]!;
    expect(week).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 2,
      coverage: "partial", tokenStatus: "partial", totalTokens: 7, categories: { work: { prs: null, knownPrs: 1 } } });
    const unknown = day("2026-11-09", { ...missing, coverage: "unavailable", tokenStatus: "unavailable", totalTokens: null });
    expect(weeklyUsageTrend([unknown])[0]).toMatchObject({ coverage: "unavailable", tokenStatus: "unavailable", totalTokens: null });
    expect(weeklyUsageTrend([day("2026-11-09", { ...counts, prs: 0, knownPrs: 0, commits: 0, knownCommits: 0, totalTokens: 0 })])[0])
      .toMatchObject({ prs: 0, commits: 0, totalTokens: 0, coverage: "ready", tokenStatus: "ready" });
  });
});
