import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { createLocalUsageProvider } from "./local-usage.ts";
import { localUsageView } from "../src/lib/local-usage-view.ts";
import { weeklyUsageTrend } from "../src/lib/local-usage-trends.ts";

const folders: string[] = [];
const day = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const chinaDay = (timestamp: number) => new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

afterEach(async () => {
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

async function fixture(asOf: number, options: { partialPr?: boolean; missingDay?: string; unavailableDay?: string; oldestExtra?: boolean } = {}) {
  const folder = await mkdtemp(join(tmpdir(), "mausbot-usage-"));
  folders.push(folder);
  const file = join(folder, "latest.json");
  const captureDay = chinaDay(asOf);
  const categories = (date: string) => ({
    work: { prs: options.partialPr ? null : 1, knownPrs: 1, commits: date === day(captureDay, -30) && options.oldestExtra ? 999 : 2,
      input: 10, output: 4, cacheRead: 50, cacheWrite: 3, reasoning: 2, newTokens: 14 },
    personal: { prs: 0, knownPrs: 0, commits: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, newTokens: 0 },
    unclassified: { prs: 0, knownPrs: 0, commits: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, newTokens: 0 },
  });
  const daily = Array.from({ length: 31 }, (_, index) => {
    const date = day(captureDay, index - 30);
    return { day: date, tokenStatus: date === options.unavailableDay ? "unavailable" : "ready", categories: categories(date) };
  }).filter((row) => row.day !== options.missingDay);
  const snapshot = {
    version: 1, updatedAt: asOf, timeZone: "Asia/Shanghai", status: options.partialPr ? "partial" : "ready",
    sources: [{ status: "ok" }],
    prSources: [{ status: "ok" }, ...(options.partialPr ? [{ status: "unavailable" }] : [])],
    prCoverage: { work: options.partialPr ? "partial" : "ready", personal: "ready", unclassified: "ready" },
    daily,
  };
  await writeFile(file, JSON.stringify(snapshot));
  return { file, snapshot };
}

async function historyFixture(asOf: number) {
  const { file, snapshot: base } = await fixture(asOf);
  const captureDay = chinaDay(asOf);
  const category = (level: number) => ({ prs: level, knownPrs: level, commits: level * 2,
    input: level * 10, output: level * 4, cacheRead: level * 50, cacheWrite: level * 3,
    reasoning: level * 2, newTokens: level * 14, totalTokens: level * 64 });
  const daily = Array.from({ length: 60 }, (_, index) => {
    const offset = index - 59;
    const level = offset === 0 ? 4 : offset >= -6 ? 2 : 1;
    return { day: day(captureDay, offset), tokenStatus: "ready", categories: {
      work: category(level), personal: category(0), unclassified: category(0),
    } };
  });
  const repositoryDaily = daily.map((row) => ({ day: row.day,
    knownPrs: row.categories.work.knownPrs, commits: row.categories.work.commits }));
  const repository = { id: "a".repeat(64), name: "github.com/example/sample", category: "work",
    daily: repositoryDaily };
  const snapshot = { ...base, daily: daily.slice(-31),
    prSources: [{ category: "work", status: "ok" }, { category: "personal", status: "ok" }],
    localRepositories: { version: 1, rows: [{ ...repository, daily: repositoryDaily.slice(-31) }], attribution: repositoryDaily.slice(-31) },
    localHistory: { version: 1, daily, localRepositories: { version: 1, rows: [repository], attribution: repositoryDaily } } };
  await writeFile(file, JSON.stringify(snapshot));
  return { file, snapshot };
}

describe("local Usage projection", () => {
  it.each(["ready", "partial"] as const)("retains %s token history through unavailable baseline and recent rows without changing short windows", async (tokenStatus) => {
    const asOf = Date.parse("2026-11-09T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    const dates = ["2026-10-01", "2026-11-01"], missing = ["2026-10-02", "2026-11-02"];
    for (const rows of [snapshot.daily, snapshot.localHistory.daily]) {
      for (const row of rows) if ([...dates, ...missing].includes(row.day)) row.tokenStatus = "unavailable";
    }
    await writeFile(file, JSON.stringify(snapshot));
    const baseline = await createLocalUsageProvider({ file, now: () => asOf }).get();
    const history = { version: 1, daily: dates.map((day) => ({ day, tokenStatus, newTokens: 100, cacheRead: 20, totalTokens: 120 })) };
    await writeFile(file, JSON.stringify({ ...snapshot, trendHistory: history }));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows).toEqual(baseline.windows);
    expect(response.trend).toEqual(baseline.trend);
    expect(localUsageView(response)).toEqual(localUsageView(baseline));
    for (const date of dates) expect(response.history?.find((row) => row.day === date)).toMatchObject({
      tokenStatus: "partial", newTokens: 100, cacheRead: 20, totalTokens: 120, wow: { newTokens: null, totalTokens: null },
    });
    for (const range of ["60", "90", "6m"] as const) {
      const view = localUsageView(response, range);
      expect(view.windows).toEqual(localUsageView(baseline).windows);
      for (const date of dates) expect(view.trend.find((row) => row.day === date)).toMatchObject({ tokenStatus: "partial", totalTokens: 120 });
      for (const date of missing) expect(view.trend.find((row) => row.day === date)).toMatchObject({ tokenStatus: "unavailable", totalTokens: null });
    }
    const laterAsOf = Date.parse("2027-01-15T08:00:00Z"), later = await historyFixture(laterAsOf);
    expect(later.snapshot.localHistory.daily.some((row) => dates.includes(row.day))).toBe(false);
    await writeFile(later.file, JSON.stringify({ ...later.snapshot,
      trendHistory: { version: 1, daily: history.daily.map((row) => ({ ...row, tokenStatus: "partial" })) } }));
    const retained = localUsageView(await createLocalUsageProvider({ file: later.file, now: () => laterAsOf }).get(), "6m");
    for (const date of dates) expect(retained.trend.find((row) => row.day === date)).toMatchObject({
      tokenStatus: "partial", newTokens: 100, cacheRead: 20, totalTokens: 120,
    });
  });

  it("reads bounded token history while retaining legacy windows and rejecting invalid extensions", async () => {
    const asOf = Date.parse("2026-11-09T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    const baseline = await createLocalUsageProvider({ file, now: () => asOf }).get();
    const history = { version: 1, daily: [
      { day: "2026-06-01", tokenStatus: "ready", newTokens: 10, cacheRead: 2, totalTokens: 12 },
      { day: "2026-06-02", tokenStatus: "partial", newTokens: 0, cacheRead: 0, totalTokens: 0 },
      { day: "2026-06-03", tokenStatus: "unavailable", newTokens: null, cacheRead: null, totalTokens: null },
    ] };
    await writeFile(file, JSON.stringify({ ...snapshot, trendHistory: history }));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows).toEqual(baseline.windows);
    expect(response.trend).toEqual(baseline.trend);
    expect(response.history).toEqual(expect.arrayContaining([
      expect.objectContaining({ day: "2026-06-01", tokenStatus: "ready", totalTokens: 12 }),
      expect.objectContaining({ day: "2026-06-02", tokenStatus: "partial", totalTokens: 0 }),
      expect.objectContaining({ day: "2026-06-03", tokenStatus: "unavailable", totalTokens: null }),
      expect.objectContaining({ day: "2026-09-11", totalTokens: 64 }),
    ]));
    for (const patch of [{ day: "2026-11-10" }, { day: "2025-01-01" }, { totalTokens: 99 }, { newTokens: -1 }, { tokenStatus: "ready", cacheRead: null }]) {
      await writeFile(file, JSON.stringify({ ...snapshot, trendHistory: { version: 1, daily: [{ ...history.daily[0], ...patch }] } }));
      const invalid = await createLocalUsageProvider({ file, now: () => asOf }).get();
      expect(invalid.windows).toEqual(baseline.windows);
      expect(invalid.history?.some((row) => row.day === "2026-06-01")).toBe(false);
    }
  });

  it("keeps the original 60-day card deduplication independent of longer merge history", async () => {
    const asOf = Date.parse("2026-11-09T08:00:00Z");
    const { file } = await fixture(asOf);
    const mergedFile = join(dirname(file), "merged-v1.json");
    const id = (value: number) => value.toString(16).padStart(64, "0");
    const repository = { id: id(2), name: "github.com/example/project" };
    const source = { id: id(1), provider: "github", category: "work", status: "ready", capturedAt: new Date(asOf).toISOString(), items: [
      { key: id(3), at: "2026-11-08T01:00:00Z", category: "work", repository, commits: [id(10)] },
      { key: id(4), at: "2026-08-01T01:00:00Z", category: "personal", repository, commits: [id(10), id(11)] },
    ] };
    const raw = { version: 1, asOfAt: new Date(asOf).toISOString(), capturedAt: new Date(asOf).toISOString(),
      windowStartDay: day("2026-11-09", -59), sources: [source] };
    await writeFile(mergedFile, JSON.stringify(raw));
    const baseline = (await createLocalUsageProvider({ file, mergedFile, now: () => asOf }).get()).merged!;
    expect(baseline.history?.find((row) => row.day === "2026-08-01")?.coverage).toBe("unavailable");
    await writeFile(mergedFile, JSON.stringify({ ...raw, windowStartDay: day("2026-11-09", -190) }));
    const extended = (await createLocalUsageProvider({ file, mergedFile, now: () => asOf }).get()).merged!;
    expect(extended.windows).toEqual(baseline.windows);
    expect(extended.overlaps).toEqual(baseline.overlaps);
    expect(extended.trend).toEqual(baseline.trend);
    expect(extended.windows?.["7"]).toMatchObject({ prs: 1, commits: 1 });
    expect(extended.history?.find((row) => row.day === "2026-08-01")).toMatchObject({ prs: 1, commits: 2 });
    expect(extended.history?.find((row) => row.day === "2026-11-08")).toMatchObject({ prs: 1, commits: 0 });
    expect(extended.history).toHaveLength(191);
    const response = { status: "unavailable" as const, asOf: null, timeZone: "Asia/Shanghai" as const,
      sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [], merged: extended };
    const long = localUsageView(response, "6m");
    expect(long.trend.reduce((sum, row) => sum + (row.commits ?? 0), 0)).toBe(2);
    expect(weeklyUsageTrend(long.trend).reduce((sum, row) => sum + (row.commits ?? 0), 0)).toBe(2);
    expect(long.trend.find((row) => row.day === "2026-08-01")?.categories.unclassified.commits).toBe(1);
    expect(localUsageView(response).trend.reduce((sum, row) => sum + (row.commits ?? 0), 0)).toBe(1);
    expect(localUsageView(response).windows?.["7"].repositories).toEqual(baseline.windows?.["7"].repositories);
    for (const range of ["60", "90"] as const) {
      expect(localUsageView(response, range).trend.reduce((sum, row) => sum + (row.commits ?? 0), 0)).toBe(0);
    }

    await writeFile(mergedFile, JSON.stringify({ ...raw, windowStartDay: day("2026-11-09", -190), sources: [{ ...source,
      status: "stale", startDay: raw.windowStartDay }] }));
    const stale = (await createLocalUsageProvider({ file, mergedFile, now: () => asOf }).get()).merged!;
    expect(stale.history?.find((row) => row.day === "2026-05-10")?.coverage).toBe("unavailable");
    for (const windowStartDay of [day("2026-11-09", -191), "2026-02-30", "2026-11-08"]) {
      await writeFile(mergedFile, JSON.stringify({ ...raw, windowStartDay }));
      expect((await createLocalUsageProvider({ file, mergedFile, now: () => asOf }).get()).merged).toBeUndefined();
    }
  });

  it("keeps remotely merged PRs independent of local logs and deduplicates original commits across PRs", async () => {
    const asOf = Date.parse("2026-11-06T08:00:00Z");
    const { file } = await fixture(asOf);
    const mergedFile = join(dirname(file), "merged-v1.json");
    const id = (value: number) => value.toString(16).padStart(64, "0");
    const personal = { id: id(21), name: "github.com/example/personal" };
    const work = { id: id(22), name: "github.com/workorg/shared" };
    const source = { id: id(1), provider: "github", category: "personal", status: "ready", capturedAt: new Date(asOf).toISOString(), items: [
      { key: id(11), at: "2026-11-06T01:00:00Z", category: "personal", repository: personal,
        commits: [id(101), id(102), id(103), id(104), id(105)] },
      { key: id(12), at: "2026-11-05T01:00:00Z", category: "work", repository: work, commits: [id(101), id(106)] },
      { key: id(13), at: "2026-10-01T01:00:00Z", category: "personal", repository: personal, commits: [id(107)] },
    ] };
    const snapshot = { version: 1, asOfAt: new Date(asOf).toISOString(), capturedAt: new Date(asOf).toISOString(),
      windowStartDay: day(chinaDay(asOf), -59), sources: [source] };
    await writeFile(mergedFile, JSON.stringify(snapshot));
    const provider = createLocalUsageProvider({ file: join(dirname(file), "missing-local.json"), mergedFile, now: () => asOf });
    const result = await provider.get();
    expect(result.status).toBe("unavailable");
    expect(result.merged).toMatchObject({ status: "ready", asOf, overlaps: { repeatedShas: 1, categoryConflicts: 1, dayConflicts: 1 },
      windows: { "1": { prs: 1, commits: 4, knownCommits: 4 }, "7": { prs: 2, commits: 6 },
        "30": { prs: 2, commits: 6, comparison: { prs: 100, commits: 500 }, repositories: { sharedCommits: 1,
          rows: expect.arrayContaining([expect.objectContaining({ name: personal.name, knownCommits: 5 }),
            expect.objectContaining({ name: work.name, knownCommits: 2 })]) } } },
      trend: expect.arrayContaining([expect.objectContaining({ day: "2026-11-06", prs: 1, commits: 4,
        wow: { prs: "new", commits: "new" } })]) });
    expect(result.merged?.windows?.["30"].categories.unclassified.knownCommits).toBe(1);
    expect(result.merged?.windows?.["30"].repositories.rows.find((row) => row.name === personal.name)?.comparison)
      .toEqual({ prs: 0, commits: 400 });
    expect(JSON.stringify(result.merged)).not.toContain(id(11));
    expect(JSON.stringify(result.merged)).not.toContain(id(101));
    source.status = "stale";
    await writeFile(mergedFile, JSON.stringify(snapshot));
    const stale = await provider.get();
    expect(stale.merged).toMatchObject({ status: "stale", windows: { "30": { prs: null, knownPrs: 2,
      commits: null, knownCommits: 6, comparison: { prs: null, commits: null } } } });
    source.status = "partial";
    await writeFile(mergedFile, JSON.stringify(snapshot));
    const partial = await provider.get();
    expect(partial.merged).toMatchObject({ status: "partial", windows: { "30": { prs: null, knownPrs: 2,
      commits: null, knownCommits: 6, comparison: { prs: null, commits: null } } } });
    await writeFile(mergedFile, "broken");
    expect((await provider.get()).merged?.status).toBe("stale");
    const fresh = createLocalUsageProvider({ file, mergedFile: join(dirname(file), "missing-remote.json"), now: () => asOf });
    expect((await fresh.get()).merged).toBeUndefined();
  });

  it("assigns a repeated original SHA to its earliest merge day in the same repository row", async () => {
    const asOf = Date.parse("2026-11-06T08:00:00Z");
    const { file } = await fixture(asOf);
    const mergedFile = join(dirname(file), "merged-v1.json");
    const id = (value: number) => value.toString(16).padStart(64, "0");
    const repository = { id: id(1), name: "github.com/example/shared" };
    await writeFile(mergedFile, JSON.stringify({ version: 1, asOfAt: new Date(asOf).toISOString(),
      capturedAt: new Date(asOf).toISOString(), windowStartDay: day(chinaDay(asOf), -59), sources: [{
        id: id(2), provider: "github", category: "personal", status: "ready",
        capturedAt: new Date(asOf).toISOString(), items: [
          { key: id(3), at: "2026-11-05T01:00:00Z", category: "personal", repository, commits: [id(5)] },
          { key: id(4), at: "2026-11-06T01:00:00Z", category: "personal", repository, commits: [id(5)] },
        ],
      }] }));
    const result = await createLocalUsageProvider({ file: join(dirname(file), "missing.json"), mergedFile, now: () => asOf }).get();
    expect(result.merged).toMatchObject({ overlaps: { repeatedShas: 1, dayConflicts: 1 },
      windows: { "1": { prs: 1, commits: 0, repositories: { rows: [{ name: repository.name, knownPrs: 1, knownCommits: 0 }] } },
        "7": { prs: 2, commits: 1, repositories: { rows: [{ name: repository.name, knownPrs: 2, knownCommits: 1 }] } } } });
  });
  it("compares adjacent China-calendar periods and keeps total tokens separate from new tokens", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file } = await historyFixture(asOf);
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"]).toMatchObject({ startDay: "2026-11-03", endDay: "2026-11-03",
      prs: 4, commits: 8, newTokens: 56, cacheRead: 200, totalTokens: 256,
      comparison: { startDay: "2026-11-02", endDay: "2026-11-02", prs: 100, commits: 100, totalTokens: 100,
        missingDays: [], unavailableTokenDays: [], categories: { work: { prs: 100, commits: 100 }, personal: { prs: 0, commits: 0 } } },
      repositories: { rows: [{ prs: 4, commits: 8, comparison: { prs: 100, commits: 100 } }] } });
    expect(response.windows?.["7"].comparison).toMatchObject({ startDay: "2026-10-21", endDay: "2026-10-27",
      prs: (16 - 7) / 7 * 100, commits: (16 - 7) / 7 * 100, totalTokens: (16 - 7) / 7 * 100 });
    expect(response.windows?.["30"]).toMatchObject({ startDay: "2026-10-05", endDay: "2026-11-03",
      newTokens: 39 * 14, cacheRead: 39 * 50, totalTokens: 39 * 64,
      comparison: { startDay: "2026-09-05", endDay: "2026-10-04", prs: 30, commits: 30, totalTokens: 30 },
      repositories: { rows: [{ comparison: { prs: 30, commits: 30 } }] } });
    expect(response.trend).toHaveLength(30);
    expect(response.trend.at(-1)).toMatchObject({ day: "2026-11-03", newTokens: 56, cacheRead: 200, totalTokens: 256,
      categories: { work: { prs: 4, knownPrs: 4, commits: 8 }, personal: { prs: 0, commits: 0 } },
      wow: { prs: 300, commits: 300, newTokens: 300, totalTokens: 300 } });
  });

  it("distinguishes an observed zero from missing repository attribution", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    const yesterday = "2026-11-02";
    for (const row of [snapshot.daily, snapshot.localHistory.daily].flat().filter((row) => row.day === yesterday)) {
      Object.assign(row.categories.work, { prs: 0, knownPrs: 0, commits: 0, input: 0, output: 0,
        cacheRead: 0, cacheWrite: 0, reasoning: 0, newTokens: 0, totalTokens: 0 });
    }
    for (const repositories of [snapshot.localRepositories, snapshot.localHistory.localRepositories]) {
      repositories.rows[0]!.daily = repositories.rows[0]!.daily.filter((row) => row.day !== yesterday);
      repositories.attribution = repositories.attribution.filter((row) => row.day !== yesterday);
    }
    await writeFile(file, JSON.stringify(snapshot));
    const observed = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(observed.windows?.["1"].comparison).toMatchObject({ prs: "new", commits: "new", totalTokens: "new",
      categories: { work: { prs: "new", commits: "new" }, personal: { prs: 0, commits: 0 } } });
    expect(observed.windows?.["1"].repositories.rows[0]?.comparison).toEqual({ prs: "new", commits: "new" });

    Object.assign(snapshot.localHistory.localRepositories, { coveredDays: snapshot.localHistory.daily
      .map((row) => row.day).filter((day) => day !== yesterday) });
    await writeFile(file, JSON.stringify(snapshot));
    const unknown = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(unknown.windows?.["1"].comparison).toMatchObject({ prs: "new", commits: "new", totalTokens: "new" });
    expect(unknown.windows?.["1"].repositories.rows[0]?.comparison).toEqual({ prs: null, commits: null });
  });

  it("keeps independent metrics comparable through unrelated PR gaps and token absences", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    snapshot.prSources[1]!.status = "unavailable";
    snapshot.prCoverage.personal = "partial";
    for (const row of snapshot.localHistory.daily) Object.assign(row.categories.personal, { prs: null });
    for (const row of snapshot.daily) Object.assign(row.categories.personal, { prs: null });
    await writeFile(file, JSON.stringify(snapshot));
    const partial = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(partial.windows?.["30"].comparison).toMatchObject({ prs: null, commits: 30, totalTokens: 30,
      categories: { work: { prs: 30, commits: 30 }, personal: { prs: null, commits: 0 } } });
    expect(partial.windows?.["30"].repositories.rows[0]?.comparison).toEqual({ prs: 30, commits: 30 });

    Object.assign(snapshot.localHistory.daily.find((row) => row.day === "2026-11-02")!.categories.work, { prs: null });
    snapshot.localHistory.daily.find((row) => row.day === "2026-11-02")!.tokenStatus = "unavailable";
    await writeFile(file, JSON.stringify(snapshot));
    const gaps = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(gaps.windows?.["1"].comparison).toMatchObject({ prs: null, commits: 100, totalTokens: null,
      unavailableTokenDays: ["2026-11-02"], categories: { work: { prs: null, commits: 100 } } });
    expect(gaps.windows?.["1"].repositories.rows[0]?.comparison).toEqual({ prs: null, commits: 100 });
  });

  it.each(["ready", "partial"])("compares observed commits and cached-inclusive tokens with %s days and an unsampled machine", async (tokenStatus) => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    snapshot.sources.push({ status: "missing" });
    for (const rows of [snapshot.daily, snapshot.localHistory.daily]) {
      for (const row of rows) row.tokenStatus = tokenStatus;
      Object.assign(rows.at(-1)!.categories.work, { cacheRead: 456, totalTokens: 512 });
    }
    for (const [date, commits] of [["2026-11-03", 64], ["2026-11-02", 24]] as const) {
      for (const daily of [snapshot.daily, snapshot.localHistory.daily]) {
        daily.find((row) => row.day === date)!.categories.work.commits = commits;
      }
      for (const repositories of [snapshot.localRepositories, snapshot.localHistory.localRepositories]) {
        repositories.rows[0]!.daily.find((row) => row.day === date)!.commits = commits;
        repositories.attribution.find((row) => row.day === date)!.commits = commits;
      }
    }
    await writeFile(file, JSON.stringify(snapshot));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    const dayChange = (64 - 24) / 24 * 100;
    expect(response.sourceCoverage).toMatchObject({ ready: 1, missing: 1 });
    expect(response.windows?.["1"]).toMatchObject({ commits: 64, totalTokens: 512, tokenCoverage: "partial",
      comparison: { prs: 100, commits: dayChange, totalTokens: 300,
        categories: { work: { prs: 100, commits: dayChange } } },
      repositories: { rows: [{ commits: 64, comparison: { prs: 100, commits: dayChange } }] } });
    expect(response.windows?.["7"].comparison).toMatchObject({ commits: (108 - 14) / 14 * 100, totalTokens: (1280 - 448) / 448 * 100 });
    expect(response.windows?.["30"].comparison).toMatchObject({ commits: (154 - 60) / 60 * 100, totalTokens: (2752 - 1920) / 1920 * 100 });
    expect(response.trend.at(-1)).toMatchObject({ commits: 64, wow: { prs: 300, commits: 3100,
      newTokens: 300, totalTokens: 700 } });

    for (const rows of [snapshot.daily, snapshot.localHistory.daily]) rows.at(-8)!.tokenStatus = "unavailable";
    await writeFile(file, JSON.stringify(snapshot));
    const gap = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(gap.windows?.["7"].comparison.totalTokens).toBeNull();
    expect(gap.trend.at(-1)?.wow).toMatchObject({ commits: 3100, newTokens: null, totalTokens: null });
  });

  it.each([
    { name: "partial machine", source: { status: "partial" } },
    { name: "incomplete token source", source: { status: "partial", tokenStatus: "partial" } },
    { name: "stale machine", source: { status: "stale" } },
    { name: "stale machine with ready tokens", source: { status: "stale", tokenStatus: "ready" } },
    { name: "missing machine with prior capture", source: { status: "missing", capturedAt: "2026-11-02T00:00:00Z" } },
    { name: "missing sampled machine with ready tokens", source: { status: "missing", tokenStatus: "ready", capturedAt: "2026-11-02T00:00:00Z" } },
    { name: "missing machine with sample metadata", source: { status: "missing", repositoryCount: 0 } },
  ])("keeps observed amounts but suppresses changes for $name", async ({ source }) => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    snapshot.sources.push(source);
    await writeFile(file, JSON.stringify(snapshot));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"]).toMatchObject({ prs: 4, commits: 8, newTokens: 56, totalTokens: 256,
      tokenCoverage: "partial", comparison: { prs: 100, commits: null, totalTokens: null,
        categories: { work: { prs: 100, commits: null } } },
      repositories: { rows: [{ prs: 4, commits: 8, comparison: { prs: 100, commits: null } }] } });
    expect(response.windows?.["7"].comparison).toMatchObject({ prs: (16 - 7) / 7 * 100, commits: null, totalTokens: null });
    expect(response.windows?.["30"].comparison).toMatchObject({ prs: 30, commits: null, totalTokens: null });
    expect(response.trend.at(-1)).toMatchObject({ commits: 8, newTokens: 56, totalTokens: 256,
      wow: { prs: 300, commits: null, newTokens: null, totalTokens: null } });
  });

  it.each([false, true])("compares complete token logs independently of partial Git coverage, unsampled machine: %s", async (unsampled) => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    Object.assign(snapshot.sources[0]!, { status: "partial", tokenStatus: "ready" });
    if (unsampled) snapshot.sources.push({ status: "missing" });
    for (const rows of [snapshot.daily, snapshot.localHistory.daily]) for (const row of rows) row.tokenStatus = "partial";
    await writeFile(file, JSON.stringify(snapshot));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.sourceCoverage).toMatchObject({ ready: 0, partial: 1, missing: Number(unsampled) });
    expect(response.windows?.["1"]).toMatchObject({ tokenCoverage: "partial", totalTokens: 256,
      comparison: { commits: null, totalTokens: 100 } });
    expect(response.windows?.["7"].comparison).toMatchObject({ commits: null, totalTokens: (16 - 7) / 7 * 100 });
    expect(response.windows?.["30"].comparison).toMatchObject({ commits: null, totalTokens: 30 });
    expect(response.trend.at(-1)?.wow).toMatchObject({ commits: null, totalTokens: 300 });

    for (const rows of [snapshot.daily, snapshot.localHistory.daily]) rows.at(-8)!.tokenStatus = "unavailable";
    await writeFile(file, JSON.stringify(snapshot));
    const gap = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(gap.windows?.["1"].comparison.totalTokens).toBe(100);
    expect(gap.windows?.["7"].comparison.totalTokens).toBeNull();
    expect(gap.windows?.["30"].comparison.totalTokens).toBeNull();
    expect(gap.trend.at(-1)?.wow.totalTokens).toBeNull();
  });

  it("uses a verified zero within the collected scope for commit and token New", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    const yesterday = "2026-11-02";
    Object.assign(snapshot.daily.find((row) => row.day === yesterday)!.categories.work, { prs: 0, knownPrs: 0,
      commits: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, newTokens: 0, totalTokens: 0 });
    snapshot.localRepositories.rows[0]!.daily = snapshot.localRepositories.rows[0]!.daily.filter((row) => row.day !== yesterday);
    snapshot.localRepositories.attribution = snapshot.localRepositories.attribution.filter((row) => row.day !== yesterday);
    snapshot.sources.push({ status: "missing" });
    const { localHistory: _unused, ...withoutHistory } = snapshot;
    await writeFile(file, JSON.stringify(withoutHistory));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"]).toMatchObject({ commits: 8, totalTokens: 256,
      comparison: { prs: "new", commits: "new", totalTokens: "new",
        categories: { work: { prs: "new", commits: "new" } } } });
    expect(response.windows?.["1"].repositories.rows[0]?.comparison).toEqual({ prs: "new", commits: "new" });
  });

  it("requires ready token coverage on both dates without suppressing complete PR and commit changes", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    for (const date of ["2026-11-02", "2026-10-27"]) {
      snapshot.daily.find((row) => row.day === date)!.tokenStatus = "partial";
      snapshot.localHistory.daily.find((row) => row.day === date)!.tokenStatus = "partial";
    }
    await writeFile(file, JSON.stringify(snapshot));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"]).toMatchObject({ commits: 8, totalTokens: 256,
      comparison: { prs: 100, commits: 100, totalTokens: null,
        categories: { work: { prs: 100, commits: 100 } } },
      repositories: { rows: [{ comparison: { prs: 100, commits: 100 } }] } });
    expect(response.windows?.["7"].comparison).toMatchObject({ prs: (16 - 7) / 7 * 100,
      commits: (16 - 7) / 7 * 100, totalTokens: null });
    expect(response.trend.at(-1)).toMatchObject({ commits: 8, totalTokens: 256,
      wow: { prs: 300, commits: 300, newTokens: null, totalTokens: null } });
  });

  it("falls back to the public 31 dates when private history is invalid or missing", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    snapshot.localHistory.version = 2;
    await writeFile(file, JSON.stringify(snapshot));
    const invalid = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(invalid.status).toBe("ready");
    expect(invalid.windows?.["1"].comparison).toMatchObject({ prs: 100, commits: 100, totalTokens: 100 });
    expect(invalid.windows?.["30"].comparison).toMatchObject({ startDay: "2026-09-05", endDay: "2026-10-04",
      prs: null, commits: null, totalTokens: null });
    expect(invalid.windows?.["30"].comparison.missingDays).toHaveLength(29);
    expect(invalid.windows?.["30"].totalTokens).toBe(39 * 64);
    expect(invalid.trend).toHaveLength(30);
    const { localHistory: _unused, ...withoutHistory } = snapshot;
    await writeFile(file, JSON.stringify(withoutHistory));
    expect((await createLocalUsageProvider({ file, now: () => asOf }).get()).windows?.["30"].comparison.totalTokens).toBeNull();
  });

  it("reports missing prior dates without treating a partial period as zero", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await historyFixture(asOf);
    const absent = "2026-09-19";
    snapshot.localHistory.daily = snapshot.localHistory.daily.filter((row) => row.day !== absent);
    snapshot.localHistory.localRepositories.rows[0]!.daily = snapshot.localHistory.localRepositories.rows[0]!.daily.filter((row) => row.day !== absent);
    snapshot.localHistory.localRepositories.attribution = snapshot.localHistory.localRepositories.attribution.filter((row) => row.day !== absent);
    await writeFile(file, JSON.stringify(snapshot));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["30"].comparison).toMatchObject({ missingDays: [absent], prs: null, commits: null, totalTokens: null,
      categories: { work: { prs: null, commits: null } } });
    expect(response.windows?.["30"].repositories.rows[0]?.comparison).toEqual({ prs: null, commits: null });
    expect(response.windows?.["7"].comparison.commits).toBe((16 - 7) / 7 * 100);
  });

  it("includes the capture date in all windows and uses exactly the same 30 dates for the trend", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file } = await fixture(asOf, { partialPr: true, oldestExtra: true });
    const response = await createLocalUsageProvider({ file, now: () => asOf + 60_000 }).get();
    expect(response.status).toBe("partial");
    expect(response.windows?.["1"]).toMatchObject({ startDay: "2026-11-03", endDay: "2026-11-03", asOf, prs: null, knownPrs: 1, commits: 2, newTokens: 14, cacheRead: 50, totalTokens: 64 });
    expect(response.windows?.["7"]).toMatchObject({ startDay: "2026-10-28", endDay: "2026-11-03", asOf, knownPrs: 7, commits: 14, newTokens: 98, totalTokens: 7 * 64 });
    expect(response.windows?.["30"]).toMatchObject({ startDay: "2026-10-05", endDay: "2026-11-03", asOf, knownPrs: 30, commits: 60, newTokens: 420, totalTokens: 30 * 64 });
    expect(response.trend).toHaveLength(30);
    expect([response.trend[0]?.day, response.trend.at(-1)?.day]).toEqual(["2026-10-05", "2026-11-03"]);
    expect(JSON.stringify(response)).not.toMatch(/device|email|session/);
    expect(JSON.stringify(response.windows)).not.toContain("999");
  });

  it("crosses China midnight and year boundaries without moving a stale capture to today", async () => {
    const before = Date.parse("2026-11-02T15:59:59Z");
    const { file } = await fixture(before);
    const provider = createLocalUsageProvider({ file, now: () => Date.parse("2026-11-02T16:01:00Z") });
    expect(await provider.get()).toMatchObject({ status: "stale", asOf: before, windows: { "1": {
      startDay: "2026-11-02", endDay: "2026-11-02", totalTokens: 64,
      comparison: { startDay: "2026-11-01", endDay: "2026-11-01" } } } });
    const next = Date.parse("2026-11-02T16:00:00Z");
    const after = await fixture(next);
    expect((await createLocalUsageProvider({ file: after.file, now: () => next }).get()).windows?.["1"])
      .toMatchObject({ endDay: "2026-11-03", comparison: { startDay: "2026-11-02", endDay: "2026-11-02" } });
    const january = Date.parse("2027-01-01T00:00:00Z");
    const rollover = await fixture(january);
    expect((await createLocalUsageProvider({ file: rollover.file, now: () => january }).get()).windows?.["30"]).toMatchObject({
      startDay: "2026-12-03", endDay: "2027-01-01",
      comparison: { startDay: "2026-11-03", endDay: "2026-12-02", totalTokens: null } });
  });

  it("marks a snapshot stale after fifteen minutes and recovers when collection resumes", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await fixture(asOf);
    let now = asOf + 15 * 60 * 1000;
    const provider = createLocalUsageProvider({ file, now: () => now });
    const fresh = await provider.get();
    expect(fresh.status).toBe("ready");
    now++;
    expect(await provider.get()).toEqual({ ...fresh, status: "stale" });
    snapshot.updatedAt = now;
    await writeFile(file, JSON.stringify(snapshot));
    expect(await provider.get()).toMatchObject({ status: "ready", asOf: now, windows: { "1": { prs: 1, commits: 2 } } });
  });

  it("shows missing dates and wholly unavailable token windows without invented zeros", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file } = await fixture(asOf, { missingDay: "2026-10-30", unavailableDay: "2026-11-03" });
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"]).toMatchObject({ tokenCoverage: "unavailable", newTokens: null, cacheRead: null, totalTokens: null });
    expect(response.windows?.["30"].missingDays).toEqual(["2026-10-30"]);
    expect(response.windows?.["30"].unavailableTokenDays).toEqual(["2026-10-30", "2026-11-03"]);
    expect(response.trend.find((row) => row.day === "2026-10-30")).toMatchObject({ coverage: "unavailable", commits: null, newTokens: null, knownPrs: null });
    expect(response.trend.at(-1)).toMatchObject({ tokenStatus: "unavailable", newTokens: null, cacheRead: null, totalTokens: null });
  });

  it("makes PRs unavailable without a covered PR source, and preserves a last good read after corruption", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await fixture(asOf);
    snapshot.prSources = [];
    await writeFile(file, JSON.stringify(snapshot));
    const provider = createLocalUsageProvider({ file, now: () => asOf });
    const good = await provider.get();
    expect(good.windows?.["1"]).toMatchObject({ prs: null, knownPrs: null });
    await writeFile(file, "{invalid");
    expect(await provider.get()).toEqual({ ...good, status: "stale" });
  });

  it("uses null for every metric when no source covers the window", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await fixture(asOf);
    snapshot.sources = [];
    snapshot.prSources = [];
    for (const row of snapshot.daily) row.tokenStatus = "unavailable";
    await writeFile(file, JSON.stringify(snapshot));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"]).toMatchObject({ coverage: "unavailable", tokenCoverage: "unavailable",
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, totalTokens: null });
    expect(response.trend.at(-1)).toMatchObject({ coverage: "unavailable", commits: null, newTokens: null, totalTokens: null, knownPrs: null });
  });

  it.each(["tokenStatus", "status"])("rejects a non-string %s on first read and preserves the last good result", async (field) => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await fixture(asOf);
    const invalid = structuredClone(snapshot);
    if (field === "tokenStatus") (invalid.daily.at(-1)! as { tokenStatus: unknown }).tokenStatus = ["unavailable"];
    else (invalid as { status: unknown }).status = ["ready"];
    await writeFile(file, JSON.stringify(invalid));
    const first = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(first).toMatchObject({ status: "unavailable", asOf: null, windows: null, trend: [] });

    const provider = createLocalUsageProvider({ file, now: () => asOf });
    await writeFile(file, JSON.stringify(snapshot));
    const good = await provider.get();
    expect(good.status).toBe("ready");
    await writeFile(file, JSON.stringify(invalid));
    expect(await provider.get()).toEqual({ ...good, status: "stale" });
  });

  it("has no fabricated windows before any valid aggregate", async () => {
    const provider = createLocalUsageProvider({ file: join(tmpdir(), "no-such-usage-aggregate.json") });
    expect(await provider.get()).toEqual({ status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
      sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] });
  });

  it("does not turn a verified PR count into a lower bound for an unused unclassified category", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await fixture(asOf);
    const input = { ...snapshot, prSources: [{ category: "work", status: "ok" }, { category: "personal", status: "ok" }],
      prCoverage: { work: "ready", personal: "ready", unclassified: "partial" },
      daily: snapshot.daily.map((row) => ({ ...row, categories: { ...row.categories, unclassified: { ...row.categories.unclassified, prs: null } } })) };
    await writeFile(file, JSON.stringify(input));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["30"].prs).toBe(30);
    expect(response.windows?.["7"].categories).toMatchObject({ work: { prs: 7, commits: 14 }, personal: { prs: 0, commits: 0 } });
    input.prSources[0]!.status = "unavailable";
    input.prCoverage.work = "partial";
    await writeFile(file, JSON.stringify(input));
    const partial = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(partial.windows?.["1"].prs).toBeNull();
    expect(partial.windows?.["1"].categories.work.knownPrs).toBeNull();
    expect(partial.windows?.["1"].categories.personal.prs).toBe(0);
  });

  it("compares all three metrics with the same date seven days earlier, including zero and missing baselines", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await fixture(asOf);
    const previous = snapshot.daily.find((row) => row.day === "2026-10-27")!.categories.work;
    Object.assign(previous, { prs: 0, knownPrs: 0, commits: 4, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, newTokens: 0 });
    await writeFile(file, JSON.stringify(snapshot));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.trend.at(-1)?.wow).toEqual({ prs: "new", commits: -50, newTokens: "new", totalTokens: "new" });
    expect(response.trend[0]?.wow).toEqual({ prs: null, commits: null, newTokens: null, totalTokens: null });
    expect(response.trend[10]?.wow).toEqual({ prs: 0, commits: 0, newTokens: 0, totalTokens: 0 });
    snapshot.sources[0]!.status = "missing";
    await writeFile(file, JSON.stringify(snapshot));
    const missing = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(missing.trend.at(-1)?.wow).toEqual({ prs: "new", commits: null, newTokens: null, totalTokens: null });
  });

  it("projects local repository counts into matching windows and accounts for unattributed events", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file, snapshot } = await fixture(asOf);
    const records = [{ day: "2026-11-03", knownPrs: 1, commits: 2 }, { day: "2026-10-27", knownPrs: 1, commits: 1 }];
    const input = { ...snapshot, localRepositories: { version: 1, rows: [{ id: "a".repeat(64), name: "github.com/example/sample", category: "work",
      checkoutPath: "/private/source", daily: structuredClone(records) }], attribution: records } };
    await writeFile(file, JSON.stringify(input));
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"].repositories).toMatchObject({ coverage: "ready", unattributedPrs: 0, unattributedCommits: 0,
      rows: [{ name: "github.com/example/sample", category: "work", prs: 1, knownPrs: 1, commits: 2 }] });
    expect(response.windows?.["7"].repositories).toMatchObject({ coverage: "partial", unattributedPrs: 6, unattributedCommits: 12 });
    expect(response.windows?.["30"].repositories.rows[0]).toMatchObject({ prs: 2, commits: 3 });
    expect(JSON.stringify(response)).not.toMatch(/checkoutPath|private\/source/);
    input.localRepositories.rows.push({ id: "b".repeat(64), name: "github.com/example/fork", category: "work", checkoutPath: "/private/fork",
      daily: [{ day: "2026-11-03", knownPrs: 0, commits: 1 }] });
    await writeFile(file, JSON.stringify(input));
    const shared = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(shared.windows?.["1"].repositories).toMatchObject({ sharedCommits: 1, unattributedCommits: 0 });
    expect(shared.windows?.["1"].repositories.rows.map((row) => row.commits)).toEqual([2, 1]);
    input.localRepositories.rows[0]!.daily[0]!.commits = 3;
    await writeFile(file, JSON.stringify(input));
    expect((await createLocalUsageProvider({ file, now: () => asOf }).get()).windows?.["1"]).toMatchObject({ prs: 1,
      repositories: { coverage: "unavailable", rows: [] } });
  });
});
