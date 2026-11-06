import { describe, expect, it } from "vitest";
import type { LocalUsageResponse, LocalUsageWindow } from "../../shared/local-dashboard";
import { withMergedUsageFixture } from "../../scripts/testing/merged-usage-fixture";
import { localUsageView, retainUsageSnapshot } from "./local-usage-view";

const shift = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const unavailable: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
  sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };
function fixture(endDay = "2026-11-06"): LocalUsageResponse {
  const asOf = Date.parse(`${endDay}T08:00:00Z`);
  const counts = { prs: 1, knownPrs: 1, commits: 5 }, zero = { prs: 0, knownPrs: 0, commits: 0 };
  const categories = { work: counts, personal: zero, unclassified: zero };
  const comparison = { prs: 50, commits: 25 };
  const window = (days: 1 | 7 | 30): LocalUsageWindow => ({
    days, asOf, startDay: shift(endDay, 1 - days), endDay, coverage: "ready", tokenCoverage: "ready",
    missingDays: [], unavailableTokenDays: [], prs: days, knownPrs: days, commits: 5 * days,
    newTokens: 80 * days, cacheRead: 20 * days, totalTokens: 100 * days, categories,
    repositories: { coverage: "ready", rows: [{ id: "remote", name: "sample/merged", category: "work", ...counts, comparison }],
      unattributedPrs: 0, unattributedCommits: 0, sharedCommits: 0 },
    comparison: { startDay: shift(endDay, 1 - 2 * days), endDay: shift(endDay, -days), missingDays: [], unavailableTokenDays: [],
      ...comparison, totalTokens: 10, categories: { work: comparison, personal: comparison, unclassified: comparison } },
  });
  const windows = { "1": window(1), "7": window(7), "30": window(30) };
  return withMergedUsageFixture({ ...unavailable, status: "ready", asOf, windows,
    trend: Array.from({ length: 30 }, (_, index) => ({ day: shift(endDay, index - 29), coverage: "ready", tokenStatus: "ready",
      ...counts, newTokens: 80, cacheRead: 20, totalTokens: 100, categories,
      wow: { prs: 50, commits: 25, newTokens: 10, totalTokens: 10 } })),
  });
}

describe("merged Usage view", () => {
  it("takes every PR and commit value and comparison from remote data while retaining cached tokens", () => {
    const snapshot = fixture();
    for (const window of Object.values(snapshot.windows!)) {
      window.prs = 9_999; window.commits = 99_999;
      window.comparison = { ...window.comparison, prs: -100, commits: -100 };
      window.repositories = { ...window.repositories, rows: [] };
    }
    snapshot.trend = snapshot.trend.map((day) => ({ ...day, prs: 8_888, commits: 88_888 }));
    const view = localUsageView(snapshot);
    expect(view.windows!["1"]).toMatchObject({ prs: 1, commits: 5, totalTokens: 100, comparison: { prs: 50, commits: 25, totalTokens: 10 } });
    expect(view.windows!["7"]).toMatchObject({ prs: 7, commits: 35, totalTokens: 700 });
    expect(view.windows!["30"]).toMatchObject({ prs: 30, commits: 150, totalTokens: 3_000 });
    expect(view.windows!["1"].repositories.rows[0]).toMatchObject({ name: "sample/merged", prs: 1, commits: 5 });
    expect(view.trend.at(-1)).toMatchObject({ prs: 1, commits: 5, totalTokens: 100, wow: { prs: 50, commits: 25, totalTokens: 10 } });
  });

  it("does not reinterpret legacy PRs, commits, repositories or comparisons as merged data", () => {
    const snapshot = fixture();
    delete snapshot.merged;
    const view = localUsageView(snapshot);
    expect(view.status).toBe("partial");
    for (const window of Object.values(view.windows!)) {
      expect(window).toMatchObject({ prs: null, knownPrs: null, commits: null, knownCommits: null,
        comparison: { prs: null, commits: null, totalTokens: 10 }, repositories: { coverage: "unavailable", rows: [] } });
      expect(window.categories.work).toEqual({ prs: null, knownPrs: null, commits: null, knownCommits: null });
    }
    expect(view.windows!["1"].totalTokens).toBe(100);
    expect(view.trend[0]).toMatchObject({ prs: null, commits: null, totalTokens: 100, wow: { prs: null, commits: null } });
  });

  it("shows remote merged activity without any local snapshot or token history", () => {
    const snapshot = { ...unavailable, merged: fixture().merged };
    const view = localUsageView(snapshot);
    expect(view.asOf).toBe(snapshot.merged!.asOf);
    expect(view.status).toBe("partial");
    expect(view.windows!["1"]).toMatchObject({ prs: 1, commits: 5, totalTokens: null, tokenCoverage: "unavailable" });
    expect(view.trend[0]).toMatchObject({ prs: 1, commits: 5, totalTokens: null });
  });

  it("aligns token dates to a stale remote capture without shifting old counts onto the next day", () => {
    const snapshot = fixture("2026-01-01");
    snapshot.merged = { ...fixture("2025-12-31").merged!, status: "stale" };
    snapshot.trend.at(-1)!.totalTokens = 9_999;
    const view = localUsageView(snapshot);
    expect(view.status).toBe("stale");
    expect(view.asOf).toBe(Date.parse("2025-12-31T08:00:00Z"));
    expect(view.windows!["1"]).toMatchObject({ startDay: "2025-12-31", endDay: "2025-12-31", prs: 1, commits: 5, totalTokens: 100,
      comparison: { startDay: "2025-12-30", endDay: "2025-12-30", totalTokens: 0 } });
    expect(view.windows!["30"]).toMatchObject({ tokenCoverage: "partial", totalTokens: 2_900, unavailableTokenDays: ["2025-12-02"],
      comparison: { totalTokens: null } });
    expect(view.trend).toHaveLength(30);
    expect(view.trend.at(-1)!.day).toBe("2025-12-31");
    expect(view.trend[0]!.totalTokens).toBeNull();
  });

  it("retains each failed stream independently while accepting fresh data from the other", () => {
    const previous = fixture("2026-11-05"), next = fixture("2026-11-06");
    delete next.merged;
    const kept = retainUsageSnapshot(previous, next);
    expect(kept.asOf).toBe(next.asOf);
    expect(kept.status).toBe("ready");
    expect(kept.merged).toEqual({ ...previous.merged, status: "stale" });
    expect(previous.merged!.status).toBe("ready");
    const remoteOnly = { ...unavailable, merged: fixture("2026-11-06").merged };
    const renewed = retainUsageSnapshot(previous, remoteOnly);
    expect(renewed.asOf).toBe(previous.asOf);
    expect(renewed.status).toBe("stale");
    expect(renewed.merged).toBe(remoteOnly.merged);
    const offline = retainUsageSnapshot(remoteOnly, unavailable);
    expect(offline.merged!.status).toBe("stale");
    expect(localUsageView(offline).windows!["1"].commits).toBe(5);
  });
});
