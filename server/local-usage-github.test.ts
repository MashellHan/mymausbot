import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalUsageGithubReader } from "./local-usage-github.ts";
import { createLocalUsageProvider } from "./local-usage.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { localUsageView, profileUsageView } from "../src/lib/local-usage-view.ts";
import { weeklyUsageTrend } from "../src/lib/local-usage-trends.ts";

const now = Date.parse("2026-11-09T08:24:11Z");
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });
function syntheticCapture(days = 7) {
  return JSON.parse(execFileSync("python3", ["-c", [
    "import json,runpy,sys; sys.path.insert(0,'scripts')",
    "fixture=runpy.run_path('scripts/local_usage_github.test.py')",
    `print(json.dumps(fixture['collect'](days=${days})))`,
  ].join("; ")], { encoding: "utf8" }));
}
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "mausbot-profile-"));
  folders.push(folder);
  const file = join(folder, "github-profile-v1.json"), raw = syntheticCapture();
  raw.capturedAt = raw.asOfAt;
  await writeFile(file, JSON.stringify(raw));
  return { file, raw, read: createLocalUsageGithubReader(file, () => now) };
}

describe("GitHub Profile source contract", () => {
  it("projects retained Profile dates through provider and long views without changing short windows or inventing old zeroes", async () => {
    const { file, raw, read } = await fixture();
    const retained = structuredClone(raw.sources[0].days.at(-1));
    Object.assign(retained, { day: "2026-08-01", capturedAt: "2026-08-01T04:00:00Z", inProgress: false,
      rawPrs: 2, excludedForkPrs: 0, knownPrs: 2, profilePrs: 2, profileCommits: 3 });
    retained.repositories[0].knownPrs = 2;
    retained.repositories[0].profileCommits = 3;
    const zero = { ...structuredClone(raw.sources[0].days[0]), day: "2026-09-20", capturedAt: "2026-09-20T04:00:00Z" };
    raw.sources[0].days.unshift(zero);
    await writeFile(file, JSON.stringify(raw));
    const baseline = await read();
    raw.sources[0].days.unshift(retained);
    await writeFile(file, JSON.stringify(raw));
    const provider = createLocalUsageProvider({ file: join(file, "..", "absent-local.json"), githubFile: file,
      mergedFile: join(file, "..", "absent-merged.json"), now: () => now });
    const snapshot = await provider.get(), source = snapshot.github!;
    expect(source.history).toHaveLength(191);
    expect(source.windows).toEqual(baseline!.windows);
    expect(source.trend).toEqual(baseline!.trend);
    expect(source.history!.slice(-30)).toEqual(source.trend);
    const short = profileUsageView(snapshot);
    for (const range of ["60", "90", "6m"] as const) {
      const view = profileUsageView(snapshot, range);
      expect(view.windows).toEqual(short.windows);
      expect(view.trend.find((row) => row.day === "2026-09-20")).toMatchObject({ coverage: "partial", knownPrs: 0, knownCommits: 0 });
      expect(view.trend.find((row) => row.day === "2026-09-21")).toMatchObject({ coverage: "unavailable", knownPrs: null, knownCommits: null });
      expect(view.trend.at(-1)).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 100, totalTokens: null });
    }
    const months = profileUsageView(snapshot, "6m");
    expect(months.period).toEqual({ startDay: "2026-05-10", endDay: "2026-11-09", days: 184 });
    expect(months.trend.find((row) => row.day === "2026-08-01")).toMatchObject({ knownPrs: 2, knownCommits: 3, totalTokens: null });
    expect(months.trend[0]).toMatchObject({ coverage: "unavailable", knownPrs: null, knownCommits: null });
    const weeks = weeklyUsageTrend(months.trend);
    expect(weeks[0]).toMatchObject({ day: "2026-05-10", endDay: "2026-05-10" });
    expect(weeks.at(-1)).toMatchObject({ day: "2026-11-09", endDay: "2026-11-09" });
    expect(weeks.reduce((sum, row) => sum + (row.knownCommits ?? 0), 0)).toBe(110);
    expect(weeks.reduce((sum, row) => sum + (row.categories.personal.knownPrs ?? 0), 0)).toBe(4);
    expect(weeks.every((row) => row.prs === null && row.commits === null && row.wow.prs === null && row.wow.commits === null)).toBe(true);
  });

  it("reads the Python capture without rebinning commit buckets or certifying the nonfork PR subset", async () => {
    const { read, raw } = await fixture();
    expect(raw.sources[0].days.at(-1)).toMatchObject({ rawPrs: 1, knownPrs: 1, excludedForkPrs: 0 });
    const result = await read();
    expect(result).toMatchObject({ status: "partial", metricDefinition: "github-profile-v1",
      qualification: "nonfork-at-capture", chinaCommitAlignment: "unknown", sourceCoverage: { ready: 1 },
      windows: { "1": { prs: null, knownPrs: 1, commits: null, knownCommits: 100 },
        "7": { knownPrs: 2, knownCommits: 107, missingDays: [], comparison: { prs: null, commits: null } },
        "30": { prs: null, commits: null, knownCommits: 107 } } });
    expect(result!.windows!["30"].missingDays).toHaveLength(23);
    expect(result!.trend.at(-2)).toMatchObject({ day: "2026-11-08", knownPrs: 1, knownCommits: 7 });
    expect(result!.trend[0]).toMatchObject({ prs: null, commits: null, knownCommits: null, coverage: "unavailable" });
    expect(result!.windows!["7"].repositories.rows[0]).toMatchObject({ name: "sample/project", knownPrs: 2, knownCommits: 107, commits: null });
  });

  it("keeps Profile source and Tokens independent through the actual provider and view", async () => {
    const { file } = await fixture();
    const local = join(file, "..", "latest.json");
    const counts = { prs: 999, knownPrs: 999, commits: 999, newTokens: 10, cacheRead: 20,
      input: 5, output: 5, cacheWrite: 0, reasoning: 0 };
    await writeFile(local, JSON.stringify({ version: 1, updatedAt: now, timeZone: "Asia/Shanghai", status: "ready",
      sources: [{ status: "ok" }], prSources: [], prCoverage: { work: "ready", personal: "ready", unclassified: "ready" }, daily: [{ day: "2026-11-09", tokenStatus: "ready",
        categories: { work: counts, personal: { ...counts, input: 0, output: 0, newTokens: 0, cacheRead: 0 }, unclassified: { ...counts, input: 0, output: 0, newTokens: 0, cacheRead: 0 } } }] }));
    const provider = createLocalUsageProvider({ file: local, mergedFile: join(file, "..", "absent.json"), githubFile: file, now: () => now });
    const response = await provider.get();
    const view = profileUsageView(response);
    expect(view.windows!["1"]).toMatchObject({ knownPrs: 1, knownCommits: 100, commits: null, totalTokens: 30 });
    expect(view.trend.at(-1)).toMatchObject({ knownPrs: 1, knownCommits: 100, totalTokens: 30 });
    expect(response.windows!["1"].commits).toBe(2997);
    expect(localUsageView(response).windows!["1"]).toMatchObject({ commits: 2997, knownCommits: 2997, totalTokens: 30 });
    expect(localUsageView(response).metricDefinition).toBe("repository-observations-v1");
    const onlyGithub = await createLocalUsageProvider({ file: join(file, "..", "no-local.json"), githubFile: file,
      mergedFile: join(file, "..", "no-merged.json"), now: () => now }).get();
    expect(profileUsageView(onlyGithub).windows!["1"]).toMatchObject({ knownPrs: 1, totalTokens: null });
  });

  it("exposes per-account query totals independently and preserves unknown metadata on older snapshots", async () => {
    const { file, raw, read } = await fixture();
    const result = await read();
    expect(result!.accounts).toEqual([expect.objectContaining({ host: "github.com", apiStatus: "ready", contributions: 119,
      commits: 107, rawPrs: 2, restricted: 0, outsideWindowPrs: 0,
      startAt: Date.parse("2026-11-02T00:00:00Z"), endAt: now })]);
    expect(result!.windows!["7"]).toMatchObject({ prs: null, commits: null, knownPrs: 2, knownCommits: 107, coverage: "partial" });
    delete raw.sources[0].collectionTotals;
    delete raw.sources[0].outsideWindowPrs;
    await writeFile(file, JSON.stringify(raw));
    expect((await read())!.accounts![0]).toMatchObject({ contributions: null, commits: null, rawPrs: null, outsideWindowPrs: null });
    for (const invalid of [true, -1, "119"]) {
      const changed = structuredClone(raw);
      changed.sources[0].collectionTotals = { contributions: invalid, commits: 107, rawPrs: 2 };
      await writeFile(file, JSON.stringify(changed));
      expect(await createLocalUsageGithubReader(file, () => now)()).toBeUndefined();
    }
  });

  it("retains every configured empty API source as partial coverage rather than certifying private zeros", async () => {
    const { file, raw, read } = await fixture();
    const source = raw.sources[0];
    for (const letter of ["a", "b", "c"]) {
      const empty = structuredClone(source);
      Object.assign(empty, { id: letter.repeat(64), account: letter.repeat(64), host: `${letter}.ghe.com`, collectionTotals: { contributions: 0, commits: 0, rawPrs: 0 } });
      for (const day of empty.days) Object.assign(day, { rawPrs: 0, excludedForkPrs: 0, knownPrs: 0, profilePrs: 0, profileCommits: 0, repositories: [] });
      raw.sources.push(empty); raw.activeSourceIds.push(empty.id);
    }
    await writeFile(file, JSON.stringify(raw));
    const result = await read();
    expect(result!.accounts).toHaveLength(4);
    expect(result!.accounts!.slice(1).every(account => account.apiStatus === "ready" && account.contributions === 0)).toBe(true);
    expect(result).toMatchObject({ status: "partial", sourceCoverage: { total: 4, ready: 4 }, windows: { "7": {
      coverage: "partial", prs: null, commits: null, knownPrs: 2, knownCommits: 107, comparison: { prs: null, commits: null } } } });
  });

  it("rejects malformed or mixed definitions and preserves only an already observed stream as stale", async () => {
    const { file, raw, read } = await fixture();
    await read();
    const cases = [
      (value: typeof raw) => { value.metricDefinition = "merged-v1"; },
      (value: typeof raw) => { value.dateBasis.commits = "Asia/Shanghai"; },
      (value: typeof raw) => { value.qualification = "event-time-certified"; },
      (value: typeof raw) => { value.activeSourceIds.push(value.activeSourceIds[0]); },
      (value: typeof raw) => { value.sources[0].days.at(-1).profileCommits = 0; },
      (value: typeof raw) => { value.sources[0].days.at(-1).repositories[0].profileCommits = null; },
      (value: typeof raw) => { value.sources[0].days.at(-1).rawPrs = 0; },
      (value: typeof raw) => { value.sources[0].days.at(-1).status = "ready"; },
      (value: typeof raw) => { value.sources[0].days.at(-1).knownPrs = true; },
      (value: typeof raw) => { value.sources[0].days.at(-1).day = "2026-02-30"; },
      (value: typeof raw) => { value.sources[0].days.push(value.sources[0].days[0]); },
      (value: typeof raw) => { value.sources[0].days.at(-1).repositories[0].name = "/private/local/path"; },
    ];
    for (const mutate of cases) {
      const invalid = structuredClone(raw); mutate(invalid);
      await writeFile(file, JSON.stringify(invalid));
      expect((await read())!.status).toBe("stale");
      expect(await createLocalUsageGithubReader(file, () => now)()).toBeUndefined();
    }
  });

  it("keeps inaccessible accounts unknown, explicit empty observations distinct, and old captures stale", async () => {
    const { file, raw, read } = await fixture();
    const second = structuredClone(raw.sources[0]);
    second.id = "a".repeat(64); second.status = "unavailable"; second.days = [];
    raw.sources.push(second); raw.activeSourceIds.push(second.id);
    await writeFile(file, JSON.stringify(raw));
    const partial = await read();
    expect(partial!.windows!["1"]).toMatchObject({ prs: null, knownPrs: 1, commits: null, knownCommits: 100,
      missingDays: ["2026-11-09"] });
    expect(partial!.windows!["7"].categories.personal.knownCommits).toBe(107);
    expect(partial!.trend.at(-3)).toMatchObject({ knownPrs: 0, knownCommits: 0, coverage: "partial" });
    raw.sources[0].days = []; raw.sources[0].status = "unavailable";
    await writeFile(file, JSON.stringify(raw));
    const unknown = await createLocalUsageGithubReader(file, () => now)();
    expect(unknown).toMatchObject({ status: "unavailable", windows: { "1": { prs: null, commits: null, knownCommits: null } } });
    expect((await createLocalUsageGithubReader(file, () => now + 86_400_000)())!.status).toBe("unavailable");
    const fresh = syntheticCapture(); fresh.capturedAt = fresh.asOfAt;
    await writeFile(file, JSON.stringify(fresh));
    expect((await createLocalUsageGithubReader(file, () => now + 86_400_000)())!.status).toBe("stale");
  });
});


it("reads an explicit sixty-day Profile operation while preserving unknown exact counts and seven-day compatibility", async () => {
  const { file, read } = await fixture(), raw = syntheticCapture(60);
  raw.capturedAt = raw.asOfAt;
  await writeFile(file, JSON.stringify(raw));
  const result = await read();
  expect(result!.history!.filter(row => row.coverage !== "unavailable")).toHaveLength(60);
  expect(result!.history!.find(row => row.day === "2026-09-11")).toMatchObject({ coverage: "partial", prs: null, commits: null, knownPrs: 0, knownCommits: 0, repositories: { coverage: "partial" } });
  expect(result!.windows!["7"].comparison).toMatchObject({ prs: null, commits: null });
  expect(result!.windows!["7"].repositories.rows[0]).toMatchObject({ knownCommits: 107 });
  expect(result!.sixtyDayRepositories).toMatchObject({ startDay: "2026-09-11", endDay: "2026-11-09",
    repositories: { coverage: "partial", rows: [{ prs: null, commits: null, knownCommits: 107 }] } });
  const short = syntheticCapture();short.capturedAt = short.asOfAt;
  await writeFile(file, JSON.stringify(short));
  expect((await read())!.windows!["7"]).toMatchObject({ knownPrs: result!.windows!["7"].knownPrs, knownCommits: result!.windows!["7"].knownCommits, comparison: { prs: null, commits: null } });
  raw.operationWindow.startDay = "2026-10-11";
  await writeFile(file, JSON.stringify(raw));
  expect(await createLocalUsageGithubReader(file, () => now)()).toBeUndefined();
});
