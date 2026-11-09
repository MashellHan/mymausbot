import { shiftUsageDay } from "../../shared/local-usage-range.ts";
import type { UsageTrendDay } from "./local-usage-view.ts";

export type UsageTrendBucket = UsageTrendDay & { endDay?: string };

function sum(values: (number | null)[], exact = false): number | null {
  if (!values.some((value) => value !== null) || exact && values.some((value) => value === null)) return null;
  const total = values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function weeklyUsageTrend(days: UsageTrendDay[]): UsageTrendBucket[] {
  const weeks = new Map<string, UsageTrendDay[]>();
  for (const day of days) {
    const weekday = new Date(`${day.day}T00:00:00Z`).getUTCDay();
    const monday = shiftUsageDay(day.day, -((weekday + 6) % 7));
    const week = weeks.get(monday) ?? [];
    week.push(day); weeks.set(monday, week);
  }
  return [...weeks.values()].map((week) => {
    const counts = (rows: Pick<UsageTrendDay, "prs" | "knownPrs" | "commits" | "knownCommits">[]) => ({
      prs: sum(rows.map((row) => row.prs), true), knownPrs: sum(rows.map((row) => row.knownPrs)),
      commits: sum(rows.map((row) => row.commits), true), knownCommits: sum(rows.map((row) => row.knownCommits)),
    });
    return { day: week[0]!.day, endDay: week.at(-1)!.day, ...counts(week),
      coverage: week.every((day) => day.coverage === "unavailable") ? "unavailable"
        : week.every((day) => day.coverage === "ready") ? "ready" : "partial",
      tokenStatus: week.every((day) => day.tokenStatus === "unavailable") ? "unavailable"
        : week.every((day) => day.tokenStatus === "ready") ? "ready" : "partial",
      newTokens: sum(week.map((day) => day.newTokens)), cacheRead: sum(week.map((day) => day.cacheRead)),
      totalTokens: sum(week.map((day) => day.totalTokens)),
      categories: { work: counts(week.map((day) => day.categories.work)),
        personal: counts(week.map((day) => day.categories.personal)), unclassified: counts(week.map((day) => day.categories.unclassified)) },
      wow: { prs: null, commits: null, newTokens: null, totalTokens: null },
    };
  });
}
