import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { createLocalUsageProvider } from "./local-usage.ts";

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

describe("local Usage projection", () => {
  it("includes the capture date in all windows and uses exactly the same 30 dates for the trend", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file } = await fixture(asOf, { partialPr: true, oldestExtra: true });
    const response = await createLocalUsageProvider({ file, now: () => asOf + 60_000 }).get();
    expect(response.status).toBe("partial");
    expect(response.windows?.["1"]).toMatchObject({ startDay: "2026-11-03", endDay: "2026-11-03", asOf, prs: null, knownPrs: 1, commits: 2, newTokens: 14, cacheRead: 50 });
    expect(response.windows?.["7"]).toMatchObject({ startDay: "2026-10-28", endDay: "2026-11-03", asOf, knownPrs: 7, commits: 14, newTokens: 98 });
    expect(response.windows?.["30"]).toMatchObject({ startDay: "2026-10-05", endDay: "2026-11-03", asOf, knownPrs: 30, commits: 60, newTokens: 420 });
    expect(response.trend).toHaveLength(30);
    expect([response.trend[0]?.day, response.trend.at(-1)?.day]).toEqual(["2026-10-05", "2026-11-03"]);
    expect(JSON.stringify(response)).not.toMatch(/device|email|session/);
    expect(JSON.stringify(response.windows)).not.toContain("999");
  });

  it("crosses China midnight and year boundaries without moving a stale capture to today", async () => {
    const before = Date.parse("2026-11-02T15:59:59Z");
    const { file } = await fixture(before);
    const provider = createLocalUsageProvider({ file, now: () => Date.parse("2026-11-02T16:01:00Z") });
    expect(await provider.get()).toMatchObject({ status: "stale", asOf: before, windows: { "1": { startDay: "2026-11-02", endDay: "2026-11-02" } } });
    const next = Date.parse("2026-11-02T16:00:00Z");
    const after = await fixture(next);
    expect((await createLocalUsageProvider({ file: after.file, now: () => next }).get()).windows?.["1"].endDay).toBe("2026-11-03");
    const january = Date.parse("2027-01-01T00:00:00Z");
    const rollover = await fixture(january);
    expect((await createLocalUsageProvider({ file: rollover.file, now: () => january }).get()).windows?.["30"]).toMatchObject({ startDay: "2026-12-03", endDay: "2027-01-01" });
  });

  it("shows missing dates and wholly unavailable token windows without invented zeros", async () => {
    const asOf = Date.parse("2026-11-03T08:00:00Z");
    const { file } = await fixture(asOf, { missingDay: "2026-10-30", unavailableDay: "2026-11-03" });
    const response = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(response.windows?.["1"]).toMatchObject({ tokenCoverage: "unavailable", newTokens: null, cacheRead: null });
    expect(response.windows?.["30"].missingDays).toEqual(["2026-10-30"]);
    expect(response.windows?.["30"].unavailableTokenDays).toEqual(["2026-10-30", "2026-11-03"]);
    expect(response.trend.find((row) => row.day === "2026-10-30")).toMatchObject({ coverage: "unavailable", commits: null, newTokens: null, knownPrs: null });
    expect(response.trend.at(-1)).toMatchObject({ tokenStatus: "unavailable", newTokens: null, cacheRead: null });
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
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null });
    expect(response.trend.at(-1)).toMatchObject({ coverage: "unavailable", commits: null, newTokens: null, knownPrs: null });
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
    expect(response.trend.at(-1)?.wow).toEqual({ prs: "new", commits: -50, newTokens: "new" });
    expect(response.trend[0]?.wow).toEqual({ prs: null, commits: null, newTokens: null });
    expect(response.trend[10]?.wow).toEqual({ prs: 0, commits: 0, newTokens: 0 });
    snapshot.sources[0]!.status = "missing";
    await writeFile(file, JSON.stringify(snapshot));
    const missing = await createLocalUsageProvider({ file, now: () => asOf }).get();
    expect(missing.trend.at(-1)?.wow).toEqual({ prs: "new", commits: null, newTokens: null });
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
