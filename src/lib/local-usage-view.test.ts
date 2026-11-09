import { describe, expect, it } from "vitest";
import type { LocalUsageResponse, LocalUsageWindow } from "../../shared/local-dashboard";
import { withGithubUsageFixture, withMergedUsageFixture } from "../../scripts/testing/merged-usage-fixture";
import { localUsageView, profileUsageView, retainUsageSnapshot } from "./local-usage-view";
import { weeklyUsageTrend } from "./local-usage-trends";

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
  return withGithubUsageFixture({ ...unavailable, status: "ready", asOf, windows,
    trend: Array.from({ length: 30 }, (_, index) => ({ day: shift(endDay, index - 29), coverage: "ready", tokenStatus: "ready",
      ...counts, newTokens: 80, cacheRead: 20, totalTokens: 100, categories,
      wow: { prs: 50, commits: 25, newTokens: 10, totalTokens: 10 } })),
  });
}

describe("GitHub contribution Usage view", () => {
  it("keeps Profile exact counts and comparisons unknown at every fixture level", () => {
    const snapshot = fixture();
    const assertUnknown = (value: object) => {
      for (const [key, item] of Object.entries(value)) {
        if (["prs", "commits", "unattributedPrs", "unattributedCommits"].includes(key)) expect(item, key).toBeNull();
        else if (item && typeof item === "object") assertUnknown(item);
      }
    };
    assertUnknown(snapshot.github!.windows!);
    assertUnknown(snapshot.github!.trend);
    const view = profileUsageView(snapshot);
    for (const window of Object.values(view.windows!)) {
      expect(window.categories.work).toEqual({ prs: null, knownPrs: 1, commits: null, knownCommits: 5 });
      expect(window.repositories.rows[0]).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 5 });
    }
    expect(view.trend[0]!.categories.work).toEqual({ prs: null, knownPrs: 1, commits: null, knownCommits: 5 });
    expect(snapshot.windows!["1"]).toMatchObject({ prs: 1, commits: 5, totalTokens: 100 });
  });

  it.each(["ready", "partial"] as const)("retains %s tokens only in long ranges when a recent row becomes unavailable", (tokenStatus) => {
    const snapshot = fixture("2026-11-09"), date = "2026-11-01", missing = "2026-11-02";
    const known = { ...snapshot.trend.find((row) => row.day === date)!, tokenStatus, newTokens: 100, cacheRead: 20, totalTokens: 120 };
    snapshot.trend = snapshot.trend.map((row) => [date, missing].includes(row.day)
      ? { ...row, tokenStatus: "unavailable", newTokens: null, cacheRead: null, totalTokens: null,
        wow: { ...row.wow, newTokens: null, totalTokens: null } } : row);
    const baseline = profileUsageView(snapshot);
    snapshot.history = [known, { ...known, day: "2026-11-08", totalTokens: 999 }];
    for (const range of ["60", "90", "6m"] as const) {
      const view = profileUsageView(snapshot, range);
      expect(view.trend.find((row) => row.day === date)).toMatchObject({ tokenStatus: "partial", newTokens: 100,
        cacheRead: 20, totalTokens: 120, wow: { newTokens: null, totalTokens: null } });
      expect(view.trend.find((row) => row.day === missing)).toMatchObject({ tokenStatus: "unavailable", totalTokens: null });
      expect(view.trend.find((row) => row.day === "2026-11-08")).toMatchObject({ tokenStatus: "ready", totalTokens: 100 });
      expect(view.windows).toEqual(baseline.windows);
    }
    expect(profileUsageView(snapshot)).toEqual(baseline);
    expect(snapshot.history[0]).toEqual(known);
    expect(snapshot.history[0]?.tokenStatus).toBe(tokenStatus);
  });

  it("uses dated history for 60/90 days and calendar months without changing cards or inventing old zeroes", () => {
    const snapshot = fixture("2026-11-09");
    snapshot.history = snapshot.trend.map((row) => ({ ...row, day: shift(row.day, -60), totalTokens: 42 }));
    snapshot.github!.history = snapshot.github!.trend.map((row) => ({ ...row, day: shift(row.day, -60) }));
    const base = profileUsageView(snapshot);
    expect(profileUsageView(snapshot, "60").trend).toHaveLength(60);
    const long = profileUsageView(snapshot, "90");
    expect(long.trend).toHaveLength(90);
    expect(long.trend[0]).toMatchObject({ day: "2026-08-12", totalTokens: 42, prs: null, knownPrs: 1, commits: null, knownCommits: 5 });
    expect(long.trend.find((row) => row.day === "2026-09-11")).toMatchObject({ prs: null, knownPrs: null, commits: null, totalTokens: null });
    expect(long.windows).toEqual(base.windows);
    const months = profileUsageView(snapshot, "6m");
    expect(months.period).toEqual({ startDay: "2026-05-10", endDay: "2026-11-09", days: 184 });
    expect(months.trend[0]).toMatchObject({ coverage: "unavailable", tokenStatus: "unavailable", totalTokens: null, prs: null, commits: null });
    const legacy = fixture();
    expect(profileUsageView(legacy, "90").trend[0]).toMatchObject({ totalTokens: null, knownPrs: null, coverage: "unavailable" });
  });

  it("aligns differing extended capture dates by their real dates", () => {
    const snapshot = fixture("2026-01-02");
    snapshot.github = fixture("2026-01-01").github;
    snapshot.history = [{ ...snapshot.trend[0]!, day: "2025-11-03", totalTokens: 321 }];
    const long = profileUsageView(snapshot, "60");
    expect(long.trend[0]).toMatchObject({ day: "2025-11-03", totalTokens: 321, prs: null });
    expect(long.trend.at(-1)).toMatchObject({ day: "2026-01-01", totalTokens: 100, prs: null, knownPrs: 1 });
    expect(long.windows).toEqual(profileUsageView(snapshot).windows);
  });

  it("takes every PR and commit value and comparison from remote data while retaining cached tokens", () => {
    const snapshot = fixture();
    for (const window of Object.values(snapshot.windows!)) {
      window.prs = 9_999; window.commits = 99_999;
      window.comparison = { ...window.comparison, prs: -100, commits: -100 };
      window.repositories = { ...window.repositories, rows: [] };
    }
    snapshot.trend = snapshot.trend.map((day) => ({ ...day, prs: 8_888, commits: 88_888 }));
    const view = profileUsageView(snapshot);
    expect(view.windows!["1"]).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 5, totalTokens: 100, comparison: { prs: null, commits: null, totalTokens: 10 } });
    expect(view.windows!["7"]).toMatchObject({ prs: null, knownPrs: 7, commits: null, knownCommits: 35, totalTokens: 700 });
    expect(view.windows!["30"]).toMatchObject({ prs: null, knownPrs: 30, commits: null, knownCommits: 150, totalTokens: 3_000 });
    expect(view.windows!["1"].repositories.rows[0]).toMatchObject({ name: "sample/merged", prs: null, knownPrs: 1, commits: null, knownCommits: 5 });
    expect(view.trend.at(-1)).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 5, totalTokens: 100, wow: { prs: null, commits: null, totalTokens: 10 } });
  });

  it("does not reinterpret legacy PRs, commits, repositories or comparisons as contribution data", () => {
    const snapshot = fixture();
    snapshot.merged = withMergedUsageFixture(snapshot).merged;
    delete snapshot.github;
    const view = profileUsageView(snapshot);
    expect(view.status).toBe("partial");
    for (const window of Object.values(view.windows!)) {
      expect(window).toMatchObject({ prs: null, knownPrs: null, commits: null, knownCommits: null,
        comparison: { prs: null, commits: null, totalTokens: 10 }, repositories: { coverage: "unavailable", rows: [] } });
      expect(window.categories.work).toEqual({ prs: null, knownPrs: null, commits: null, knownCommits: null });
    }
    expect(view.windows!["1"].totalTokens).toBe(100);
    expect(view.trend[0]).toMatchObject({ prs: null, commits: null, totalTokens: 100, wow: { prs: null, commits: null } });
    snapshot.merged!.history = snapshot.merged!.trend.map((day) => ({ ...day, day: shift(day.day, -60) }));
    for (const range of ["60", "90", "6m"] as const) {
      for (const row of profileUsageView(snapshot, range).trend) {
        expect(row).toMatchObject({ prs: null, knownPrs: null, commits: null, knownCommits: null, coverage: "unavailable" });
      }
    }
  });

  it("preserves private comparison-history coverage beyond the visible 30-day trend", () => {
    const snapshot = fixture();
    expect(profileUsageView(snapshot).windows!["30"].comparison.unavailableTokenDays).toEqual([]);
    snapshot.windows!["30"].comparison = { ...snapshot.windows!["30"].comparison,
      totalTokens: null, unavailableTokenDays: ["2026-09-20"] };
    expect(profileUsageView(snapshot).windows!["30"].comparison).toMatchObject({
      totalTokens: null, unavailableTokenDays: ["2026-09-20"],
    });
  });

  it("shows remote contribution activity without any local snapshot or token history", () => {
    const snapshot = { ...unavailable, github: fixture().github };
    const view = profileUsageView(snapshot);
    expect(view.asOf).toBe(snapshot.github!.asOf);
    expect(view.status).toBe("partial");
    expect(view.windows!["1"]).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 5, totalTokens: null, tokenCoverage: "unavailable" });
    expect(view.trend[0]).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 5, totalTokens: null });
  });

  it("aligns token dates to a stale remote capture without shifting old counts onto the next day", () => {
    const snapshot = fixture("2026-01-01");
    snapshot.github = { ...fixture("2025-12-31").github!, status: "stale" };
    snapshot.trend.at(-1)!.totalTokens = 9_999;
    const view = profileUsageView(snapshot);
    expect(view.status).toBe("stale");
    expect(view.asOf).toBe(Date.parse("2025-12-31T08:00:00Z"));
    expect(view.windows!["1"]).toMatchObject({ startDay: "2025-12-31", endDay: "2025-12-31", prs: null, knownPrs: 1, commits: null, knownCommits: 5, totalTokens: 100,
      comparison: { startDay: "2025-12-30", endDay: "2025-12-30", totalTokens: 0 } });
    expect(view.windows!["30"]).toMatchObject({ tokenCoverage: "partial", totalTokens: 2_900, unavailableTokenDays: ["2025-12-02"],
      comparison: { totalTokens: null } });
    expect(view.trend).toHaveLength(30);
    expect(view.trend.at(-1)!.day).toBe("2025-12-31");
    expect(view.trend[0]!.totalTokens).toBeNull();
  });

  it("retains each failed stream independently while accepting fresh data from the other", () => {
    const previous = fixture("2026-11-05"), next = fixture("2026-11-06");
    delete next.github;
    const kept = retainUsageSnapshot(previous, next);
    expect(kept.asOf).toBe(next.asOf);
    expect(kept.status).toBe("ready");
    expect(kept.github).toEqual({ ...previous.github, status: "stale" });
    expect(previous.github!.status).toBe("partial");
    const remoteOnly = { ...unavailable, github: fixture("2026-11-06").github };
    const renewed = retainUsageSnapshot(previous, remoteOnly);
    expect(renewed.asOf).toBe(previous.asOf);
    expect(renewed.status).toBe("stale");
    expect(renewed.github).toBe(remoteOnly.github);
    const offline = retainUsageSnapshot(remoteOnly, unavailable);
    expect(offline.github!.status).toBe("stale");
    expect(profileUsageView(offline).windows!["1"].knownCommits).toBe(5);
  });
});


describe("independent repository activity view", () => {
  it("preserves every configured repository and same-definition comparison without promoting Profile references", () => {
    const snapshot = fixture();
    const rows = [
      { id: "work-one", name: "work/service", category: "work" as const, prs: 3, knownPrs: 3, commits: 8, comparison: { prs: "new" as const, commits: 0 } },
      { id: "work-two", name: "work/tool", category: "work" as const, prs: null, knownPrs: 2, commits: 7, comparison: { prs: null, commits: null } },
      { id: "private", name: "personal/private-apps", category: "personal" as const, prs: 4, knownPrs: 4, commits: 10, comparison: { prs: -50, commits: 25 } },
    ];
    for (const window of Object.values(snapshot.windows!)) window.repositories.rows = rows;
    const original = structuredClone(snapshot);
    const view = localUsageView(snapshot);
    expect(view.metricDefinition).toBe("repository-observations-v1");
    for (const key of ["1", "7", "30"] as const) {
      expect(view.windows![key]).toMatchObject(snapshot.windows![key]);
      expect(view.windows![key].knownCommits).toBe(snapshot.windows![key].commits);
      expect(view.windows![key].repositories.rows.map(row => row.name)).toEqual(rows.map(row => row.name));
    }
    expect(view.trend.at(-1)).toMatchObject({ prs: 1, commits: 5, knownCommits: 5, wow: { prs: 50, commits: 25 } });
    expect(profileUsageView(snapshot).windows!["1"]).toMatchObject({ prs: null, commits: null, knownCommits: 5, comparison: { prs: null, commits: null } });
    delete snapshot.github;
    expect(localUsageView(snapshot)).toEqual(view);
    expect(original.windows).toEqual(snapshot.windows);
  });

  it("retains repository commit subtotals through mixed missing weeks without inventing exact totals or zeros", () => {
    const snapshot = fixture("2026-11-09"), original = structuredClone(snapshot);
    const zero = { prs: 0, knownPrs: 0, commits: 0 };
    snapshot.history = Array.from({ length: 10 }, (_, index) => {
      const observed = index < 3;
      return { ...snapshot.trend[0]!, day: shift("2026-09-11", index), coverage: "ready" as const,
        prs: observed ? 1 : 0, knownPrs: observed ? 1 : 0, commits: observed ? 8 : 0,
        tokenStatus: "ready" as const, newTokens: 0, cacheRead: 0, totalTokens: 0,
        categories: { work: { prs: observed ? 1 : 0, knownPrs: observed ? 1 : 0, commits: observed ? 6 : 0 },
          personal: { ...zero, commits: observed ? 2 : 0 }, unclassified: zero } };
    });
    const view = localUsageView(snapshot, "6m"), weeks = weeklyUsageTrend(view.trend);
    const mixed = weeks.find(week => week.day === "2026-09-07")!;
    expect(view.trend.find(day => day.day === "2026-09-07")).toMatchObject({ commits: null, knownCommits: null, coverage: "unavailable" });
    expect(view.trend.find(day => day.day === "2026-09-11")).toMatchObject({ commits: 8, knownCommits: 8 });
    expect(mixed).toMatchObject({ endDay: "2026-09-13", commits: null, knownCommits: 24, coverage: "partial",
      categories: { work: { commits: null, knownCommits: 18 }, personal: { commits: null, knownCommits: 6 },
        unclassified: { commits: null, knownCommits: 0 } }, wow: { prs: null, commits: null } });
    expect(weeks.find(week => week.day === "2026-09-14")).toMatchObject({ endDay: "2026-09-20", commits: 0, knownCommits: 0,
      coverage: "ready", categories: { work: { commits: 0, knownCommits: 0 }, personal: { commits: 0, knownCommits: 0 },
        unclassified: { commits: 0, knownCommits: 0 } } });
    expect(weeks.find(week => week.day === "2026-09-21")).toMatchObject({ endDay: "2026-09-27", commits: null, knownCommits: null,
      coverage: "unavailable", categories: { work: { commits: null, knownCommits: null }, personal: { commits: null, knownCommits: null },
        unclassified: { commits: null, knownCommits: null } } });
    expect(weeklyUsageTrend(profileUsageView(snapshot, "6m").trend).find(week => week.day === "2026-09-07"))
      .toMatchObject({ commits: null, knownCommits: null, coverage: "unavailable" });
    expect(snapshot.windows).toEqual(original.windows);
    expect(view.windows).toEqual(localUsageView(snapshot).windows);
  });

  it("joins long repository and retained token observations by date without converting unknown history to zero", () => {
    const snapshot = fixture("2026-11-09"), old = { ...snapshot.trend[0]!, day: "2026-08-01", commits: 17 };
    snapshot.history = [old, { ...snapshot.trend.at(-1)!, commits: 999 }];
    const short = localUsageView(snapshot);
    for (const range of ["60", "90", "6m"] as const) {
      const view = localUsageView(snapshot, range);
      expect(view.windows).toEqual(short.windows);
      expect(view.trend.at(-1)).toMatchObject({ day: "2026-11-09", commits: 5 });
      expect(view.trend.find(row => row.day === "2026-10-10")).toMatchObject({ coverage: "unavailable", prs: null, commits: null });
    }
    expect(localUsageView(snapshot, "6m").trend.find(row => row.day === old.day)).toMatchObject({ commits: 17 });
    snapshot.github = fixture("2026-11-08").github;
    expect(localUsageView(snapshot, "6m").period).toEqual({ startDay: "2026-05-10", endDay: "2026-11-09", days: 184 });
    expect(localUsageView(snapshot, "6m").trend.at(-1)).toMatchObject({ day: "2026-11-09", commits: 5 });
  });

  it.each(["ready", "partial"] as const)("keeps %s retained Tokens when recent observation is unavailable", tokenStatus => {
    const snapshot = fixture("2026-11-09"), known = { ...snapshot.trend.at(-1)!, tokenStatus, newTokens: 100, cacheRead: 20, totalTokens: 120 };
    snapshot.history = [known];
    Object.assign(snapshot.trend.at(-1)!, { tokenStatus: "unavailable", newTokens: null, cacheRead: null, totalTokens: null });
    const short = localUsageView(snapshot);
    for (const range of ["60", "90", "6m"] as const) {
      expect(localUsageView(snapshot, range).trend.at(-1)).toMatchObject({ tokenStatus: "partial", newTokens: 100, cacheRead: 20, totalTokens: 120,
        wow: { newTokens: null, totalTokens: null } });
      expect(localUsageView(snapshot, range).windows).toEqual(short.windows);
    }
    expect(short.trend.at(-1)?.totalTokens).toBeNull();
  });
});
