import type { LocalUsageCounts, LocalUsageMergedWindow, LocalUsageResponse, LocalUsageWindow } from "../../shared/local-dashboard";

export function withMergedUsageFixture(snapshot: LocalUsageResponse): LocalUsageResponse {
  const counts = (value: LocalUsageCounts) => ({ prs: value.prs, knownPrs: value.knownPrs ?? 0,
    commits: value.commits, knownCommits: value.commits ?? 0 });
  const categories = (value: Record<"work" | "personal" | "unclassified", LocalUsageCounts>) => ({
    work: counts(value.work), personal: counts(value.personal), unclassified: counts(value.unclassified),
  });
  const mergedWindow = (window: LocalUsageWindow): LocalUsageMergedWindow => ({
    days: window.days, startDay: window.startDay, endDay: window.endDay, asOf: window.asOf, coverage: window.coverage,
    missingDays: window.missingDays, ...counts(window), categories: categories(window.categories), comparison: window.comparison,
    repositories: { ...window.repositories, rows: window.repositories.rows.map((row) => ({ ...row, ...counts(row) })) },
  });
  const windows = snapshot.windows && { "1": mergedWindow(snapshot.windows["1"]),
    "7": mergedWindow(snapshot.windows["7"]), "30": mergedWindow(snapshot.windows["30"]) };
  return { ...snapshot, merged: { status: snapshot.status, asOf: snapshot.asOf, timeZone: "Asia/Shanghai",
    sourceCoverage: null, overlaps: null, windows, trend: snapshot.trend.map((day) => ({
      day: day.day, coverage: day.coverage, ...counts(day), categories: categories(day.categories),
      wow: { prs: day.wow.prs, commits: day.wow.commits },
    })) } };
}
