import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { aggregateContributionSnapshot, createLocalContributionsReader, parseContributionSnapshot } from "./local-usage-contributions.ts";
import { primaryUsageSnapshotFixture } from "../scripts/testing/primary-usage-fixture.ts";

const cutoff = Date.parse("2026-11-10T12:00:00Z");
const date = (index: number) => new Date(Date.UTC(2026, 8, 12 + index)).toISOString().slice(0, 10);

function envelope(provider: "github" | "ado") {
  const sourceId = `fixture:${provider}:one`;
  const days = Array.from({ length: 60 }, (_, index) => {
    const active = index === 59;
    const prs = active ? provider === "github" ? 3 : 2 : 0;
    const commits = active ? provider === "github" ? 4 : 5 : 0;
    return { day: date(index), capturedAt: "2026-11-10T12:00:00Z", status: "ready",
      prs, knownPrs: prs, commits, knownCommits: commits,
      repositories: active ? [{ id: `${provider}-repository`, name: `${provider}/fixture`,
        category: provider === "github" ? "personal" : "work", status: "ready",
        prs, knownPrs: prs, commits, knownCommits: commits }] : [] };
  });
  return { version: 2, metricDefinition: provider === "github" ? "github-profile-beijing-v1" : "ado-default-head-beijing-v1", provider,
    asOfAt: "2026-11-10T12:00:00Z", capturedAt: "2026-11-10T12:00:00Z",
    dateBasis: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" },
    operationWindow: { startDay: date(0), endDay: date(59), todayPartial: true },
    activeSourceIds: [sourceId], sources: [{ id: sourceId,
      account: { host: provider === "github" ? "github.example" : "dev.azure.com", login: "fixture-owner", stableId: "fixture-stable-id" },
      ...(provider === "ado" ? { scope: { organization: "fixture-org", project: "fixture-project" } } : {}),
      status: "ready", coverage: { identityVerified: true, paginationComplete: true, visibilityComplete: true, reasons: [] }, days }],
    collection: { requestCount: 2, elapsedSeconds: 0.1, complete: true, reasons: [] }, state: { privateContinuation: "never-public" } };
}

function snapshot() { return { version: 2, github: envelope("github"), ado: envelope("ado") }; }
function partialAccountedSnapshot() {
  const value = snapshot();
  for (const source of [...value.github.sources, ...value.ado.sources]) {
    const repository = source.days[59]!.repositories[0]!;
    source.status = "partial";
    source.coverage.visibilityComplete = false;
    for (const [index, day] of source.days.entries()) {
      const current = index === 59, previous = index === 58;
      const prs = source === value.ado.sources[0] ? current ? 3 : previous ? 10 : 0 : 0;
      const commits = source === value.github.sources[0] ? current ? 53 : previous ? 76 : 0 : 0;
      day.status = "partial";
      day.prs = null as never;
      day.commits = null as never;
      day.knownPrs = prs;
      day.knownCommits = commits;
      day.repositories = prs || commits ? [{ ...repository, status: "partial", prs: null as never,
        commits: null as never, knownPrs: prs, knownCommits: commits }] : [];
    }
  }
  return value;
}
const parse = (value: unknown) => parseContributionSnapshot(value, cutoff + 60_000);

describe("canonical source-qualified contributions", () => {
  it("includes the first eight Beijing hours in the partial day and its comparison windows", () => {
    const asOfAt = "2026-11-02T16:05:00Z";
    const now = Date.parse(asOfAt) + 60_000;
    const value = primaryUsageSnapshotFixture("2026-11-03", asOfAt,
      { github: { prs: 2, commits: 3 }, ado: { prs: 1, commits: 2 } });
    const result = aggregateContributionSnapshot(parseContributionSnapshot(value, now), now);
    expect(result.currentDayPartial).toBe(true);
    expect(result.windows?.["1"]).toMatchObject({ startDay: "2026-11-03", endDay: "2026-11-03",
      prs: 3, commits: 5, comparison: { prs: "new", commits: "new" } });
    expect(result.windows?.["7"]).toMatchObject({ prs: 3, commits: 5 });
    expect(result.windows?.["30"]).toMatchObject({ prs: 3, commits: 5 });
    expect(result.history?.at(-1)).toMatchObject({ day: "2026-11-03", prs: 3, commits: 5 });
  });

  it("retains independent source cutoffs during a bounded ADO continuation", () => {
    const value = snapshot();
    value.ado.asOfAt = "2026-11-10T11:59:59Z";
    const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
    expect(result.cutoffAt).toBe(Date.parse(value.ado.asOfAt));
    expect(result.sourceDays?.ado.endDay).toBe("2026-11-10");
  });

  it("keeps Beijing source days, accounts, categories, repositories and comparisons on one version", () => {
    const result = aggregateContributionSnapshot(parse(snapshot()), cutoff + 60_000);
    expect(result.metricDefinition).toBe("contributions-v2");
    expect(result.timeZone).toBe("Asia/Shanghai");
    expect(result.dateBasis).toMatchObject({ github: { prs: "created-at/Asia-Shanghai" }, ado: { commits: "author-at/Asia-Shanghai" } });
    expect(result.currentDayPartial).toBe(true);
    expect(result.windows?.["1"]).toMatchObject({ prs: 5, knownPrs: 5, commits: 9, knownCommits: 9,
      categories: { personal: { prs: 3, commits: 4 }, work: { prs: 2, commits: 5 } },
      comparison: { prs: "new", commits: "new" } });
    expect(result.windows?.["7"].prs).toBe(5);
    expect(result.windows?.["30"].commits).toBe(9);
    expect(result.sixtyDayRepositories?.repositories.rows).toHaveLength(2);
    expect(result.history).toHaveLength(60);
    expect(result.accounts.map((account) => account.windows["1"].prs)).toEqual([3, 2]);
    expect(JSON.stringify(result)).not.toContain("privateContinuation");
  });

  it("never promotes partial, missing or hidden coverage to an exact zero", () => {
    const value = snapshot();
    value.ado.sources[0]!.coverage.visibilityComplete = false;
    value.ado.sources[0]!.status = "partial";
    value.ado.sources[0]!.days[59]!.status = "partial";
    value.ado.sources[0]!.days[59]!.prs = null as never;
    value.ado.sources[0]!.days[59]!.commits = null as never;
    const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
    expect(result.windows?.["1"]).toMatchObject({ prs: null, knownPrs: 5, commits: null, knownCommits: 9, coverage: "partial" });
    expect(result.windows?.["1"].comparison.prs).toBeNull();
    expect(result.windows?.["1"].comparison.known).toEqual({ prs: "new", commits: "new" });
    expect(result.accounts[1]!.windows["1"]).toMatchObject({ prs: null, knownPrs: 2 });
    value.ado.sources[0]!.days.pop();
    expect(aggregateContributionSnapshot(parse(value), cutoff + 60_000).history?.at(-1)?.coverage).toBe("partial");
  });

  it("compares known counts across complete source dates without promoting private coverage", () => {
    const value = snapshot();
    for (const source of [...value.github.sources, ...value.ado.sources]) {
      source.coverage.visibilityComplete = false;
      source.status = "partial";
      for (const day of source.days) {
        day.status = "partial";
        day.prs = null as never;
        day.commits = null as never;
        day.knownPrs = 0;
        day.knownCommits = day.day === date(59) ? 4 : 2;
        day.repositories = [];
      }
    }
    const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
    for (const period of ["1", "7", "30"] as const) {
      const current = result.windows![period];
      expect(current.prs).toBeNull();
      expect(current.comparison.prs).toBeNull();
      expect(current.comparison.commits).toBeNull();
      expect(current.comparison.known?.prs).toBe(0);
      expect(current.comparison.known?.commits).toBeCloseTo(100 / Number(period));
      expect(current.comparison.knownCategories?.personal.commits).toBeNull();
    }
  });

  it("compares accounted partial categories and proves quiet ready source-days as known zero", () => {
    for (const period of ["1", "7", "30"] as const) {
      const value = partialAccountedSnapshot();
      if (period !== "1") for (const source of [...value.github.sources, ...value.ado.sources]) {
        const previous = source.days[58]!;
        const target = source.days[59 - Number(period)]!;
        target.knownPrs = previous.knownPrs;
        target.knownCommits = previous.knownCommits;
        target.repositories = previous.repositories;
        previous.knownPrs = 0;
        previous.knownCommits = 0;
        previous.repositories = [];
      }
      const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
      const window = result.windows![period];
      expect(window.comparison.categories.personal.commits).toBeNull();
      expect(window.comparison.categories.work.prs).toBeNull();
      expect(window.comparison.knownCategories?.personal.commits).toBeCloseTo((53 - 76) / 76 * 100);
      expect(window.comparison.knownCategories?.work.prs).toBe(-70);
      expect(window.comparison.knownCategories?.unclassified).toEqual({ prs: 0, commits: 0 });
      expect(window.categories.unclassified).toMatchObject({ prs: null, knownPrs: 0, commits: null, knownCommits: 0 });
      expect(window.comparison.startDay).toBe(date(59 - 2 * Number(period) + 1));
      expect(window.comparison.endDay).toBe(date(59 - Number(period)));
    }
  });

  it.each(["identity", "pagination", "missing-day", "unavailable-day", "stale", "unknown-row", "unavailable-row", "residual"])(
    "withholds category comparison for %s while retaining valid metric-specific values", (gap) => {
      const value = partialAccountedSnapshot(), source = value.ado.sources[0]!, baseline = source.days[58]!;
      if (gap === "identity") source.coverage.identityVerified = false;
      if (gap === "pagination") source.coverage.paginationComplete = false;
      if (gap === "missing-day") source.days.splice(58, 1);
      if (gap === "unavailable-day") baseline.status = "unavailable";
      if (gap === "stale") source.status = "stale";
      if (gap === "unknown-row") baseline.repositories[0]!.knownPrs = null as never;
      if (gap === "unavailable-row") {
        baseline.repositories[0]!.status = "unavailable";
        baseline.repositories[0]!.knownPrs = null as never;
      }
      if (gap === "residual") baseline.knownPrs = 11;
      const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
      expect(result.windows!["1"].comparison.knownCategories?.work.prs).toBeNull();
      expect(result.windows!["7"].comparison.knownCategories?.work.prs).toBeNull();
      expect(result.windows!["30"].comparison.knownCategories?.work.prs).toBeNull();
      if (["unknown-row", "residual"].includes(gap)) {
        expect(result.windows!["1"].comparison.knownCategories?.personal.commits).toBeCloseTo((53 - 76) / 76 * 100);
      }
    });

  it("keeps positive, zero and new category changes distinct", () => {
    const value = partialAccountedSnapshot(), source = value.ado.sources[0]!;
    const previous = source.days[58]!, current = source.days[59]!;
    const repository = current.repositories[0]!;
    previous.knownPrs = 0;
    previous.repositories = [];
    expect(aggregateContributionSnapshot(parse(value), cutoff + 60_000).windows!["1"].comparison.knownCategories?.work.prs).toBe("new");
    current.knownPrs = 0;
    current.repositories = [];
    expect(aggregateContributionSnapshot(parse(value), cutoff + 60_000).windows!["1"].comparison.knownCategories?.work.prs).toBe(0);
    previous.knownPrs = 10;
    previous.repositories = [{ ...repository, knownPrs: 10, knownCommits: 0 }];
    current.knownPrs = 15;
    current.repositories = [{ ...previous.repositories[0]!, knownPrs: 15 }];
    expect(aggregateContributionSnapshot(parse(value), cutoff + 60_000).windows!["1"].comparison.knownCategories?.work.prs).toBe(50);
  });

  it.each(["identity", "pagination", "missing-day", "unavailable", "missing-count"])(
    "withholds known comparisons when one source has %s gaps", (gap) => {
      const value = snapshot();
      const source = value.ado.sources[0]!;
      source.coverage.visibilityComplete = false;
      source.status = "partial";
      if (gap === "identity") source.coverage.identityVerified = false;
      if (gap === "pagination") source.coverage.paginationComplete = false;
      if (gap === "missing-day") source.days.splice(58, 1);
      if (gap === "unavailable") source.days[58]!.status = "unavailable";
      if (gap === "missing-count") {
        source.days[58]!.status = "partial";
        source.days[58]!.prs = null as never;
        source.days[58]!.knownPrs = null as never;
      }
      const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
      expect(result.windows!["1"].comparison.known?.prs).toBeNull();
      expect(result.windows!["7"].comparison.known?.prs).toBeNull();
      expect(result.windows!["30"].comparison.known?.prs).toBeNull();
    });

  it("preserves a verified account's exact subtotal when another account is partial", () => {
    const value = snapshot();
    const second = structuredClone(value.github.sources[0]!);
    second.id = "fixture:github:partial";
    second.account.stableId = "second-stable-id";
    second.account.login = "second-owner";
    second.status = "partial";
    second.coverage.visibilityComplete = false;
    (second.coverage as { reasons: string[] }).reasons = ["private-visibility-unknown"];
    (second.days[59]! as { status: string }).status = "partial";
    second.days[59]!.prs = null as never;
    second.days[59]!.commits = null as never;
    second.days[59]!.knownPrs = 1;
    second.days[59]!.knownCommits = 1;
    second.days[59]!.repositories = [];
    value.github.activeSourceIds.push(second.id);
    value.github.sources.push(second);
    value.github.collection.complete = false;
    const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
    expect(result.status).toBe("partial");
    expect(result.windows?.["1"]).toMatchObject({ prs: null, knownPrs: 6, commits: null, knownCommits: 10 });
    expect(result.accounts.find((account) => account.sourceId === "fixture:github:one")?.windows["1"]).toMatchObject({
      prs: 3, commits: 4,
    });
    expect(result.accounts.find((account) => account.sourceId === second.id)?.windows["1"]).toMatchObject({
      prs: null, knownPrs: 1, commits: null, knownCommits: 1,
    });
  });

  it("excludes every numeric projection from an identity-unverified source", () => {
    const value = snapshot();
    const source = value.github.sources[0]!;
    source.status = "partial";
    source.coverage.identityVerified = false;
    const latest = source.days[59]!;
    (latest as { status: string }).status = "partial";
    latest.prs = null as never;
    latest.commits = null as never;
    (latest.repositories[0]! as { status: string }).status = "partial";
    latest.repositories[0]!.prs = null as never;
    latest.repositories[0]!.commits = null as never;
    const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
    expect(result.windows?.["1"]).toMatchObject({ prs: null, knownPrs: 2, commits: null, knownCommits: 5 });
    expect(result.accounts.find((account) => account.provider === "github")?.windows["1"])
      .toMatchObject({ prs: null, knownPrs: null, commits: null, knownCommits: null });
    expect(result.windows?.["1"].repositories.rows.map((row) => row.name)).toEqual(["ado/fixture"]);
    expect(result.windows?.["1"].categories.personal).toMatchObject({ prs: null, knownPrs: null, commits: null, knownCommits: null });
  });

  it("keeps a partial repository category unknown when its account total is exact", () => {
    const value = snapshot();
    const row = value.github.sources[0]!.days[59]!.repositories[0]!;
    (row as { status: string }).status = "partial";
    row.prs = null as never;
    row.commits = null as never;
    const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
    expect(result.windows?.["1"]).toMatchObject({ prs: 5, commits: 9,
      categories: { personal: { prs: null, knownPrs: 3, commits: null, knownCommits: 4 } },
      repositories: { coverage: "partial" } });
    expect(result.windows?.["1"].repositories.rows.find((item) => item.category === "personal"))
      .toMatchObject({ prs: null, knownPrs: 3, commits: null, knownCommits: 4 });
  });

  it("rejects case aliases of one authenticated account before aggregation", () => {
    const value = snapshot();
    const duplicate = structuredClone(value.github.sources[0]!);
    duplicate.id = "fixture:github:case-alias";
    duplicate.account.host = duplicate.account.host.toUpperCase();
    value.github.activeSourceIds.push(duplicate.id);
    value.github.sources.push(duplicate);
    expect(() => parse(value)).toThrow("Duplicate contribution account scope");
  });

  it("reconciles one ADO principal across distinct verified project scopes", () => {
    const value = snapshot();
    const second = structuredClone(value.ado.sources[0]!);
    second.id = "fixture:ado:second-project";
    second.scope!.project = "second-project";
    for (const day of second.days) for (const repository of day.repositories) repository.id = "second-project-repo";
    value.ado.activeSourceIds.push(second.id);
    value.ado.sources.push(second);
    const result = aggregateContributionSnapshot(parse(value), cutoff + 60_000);
    expect(result.accounts).toHaveLength(2);
    const ado = result.accounts.find((account) => account.provider === "ado")!;
    expect(ado.sourceIds).toHaveLength(2);
    expect(ado.scopes.map((scope) => scope.project)).toEqual(["fixture-project", "second-project"]);
    expect(ado.windows["1"]).toMatchObject({ prs: 4, commits: 10 });
    expect(result.windows?.["1"]).toMatchObject({ prs: 7, commits: 14 });
  });

  it("rejects incompatible versions, source identities, dates, duplicates and unreconciled rows", () => {
    const cases: ((value: ReturnType<typeof snapshot>) => void)[] = [
      (value) => { value.github.version = 1; },
      (value) => { value.github.metricDefinition = "github-profile-v2"; },
      (value) => { value.github.activeSourceIds = ["wrong"]; },
      (value) => { (value.github.dateBasis as { prs: string }).prs = "created-at/UTC"; },
      (value) => { value.ado.operationWindow.endDay = "2026-11-09"; },
      (value) => { value.github.sources[0]!.days[1] = value.github.sources[0]!.days[0]!; },
      (value) => { value.github.sources[0]!.days[59]!.repositories[0]!.knownPrs = 9; },
      (value) => { value.ado.sources[0]!.coverage.identityVerified = false; },
      (value) => { value.ado.sources = []; value.ado.activeSourceIds = []; },
      (value) => { (value.github.collection as { reasons: string[] }).reasons = ["unsafe\nreason"]; },
    ];
    for (const change of cases) {
      const value = snapshot(); change(value);
      expect(() => parse(value)).toThrow();
    }
  });

  it("fails closed on unreadable or malformed cache without falling back to legacy observations", async () => {
    const root = await mkdtemp(join(tmpdir(), "contributions-reader-"));
    try {
      const file = join(root, "contributions-v2.json");
      const read = createLocalContributionsReader(file, () => cutoff + 60_000);
      expect((await read()).status).toBe("unavailable");
      await writeFile(file, JSON.stringify(snapshot()));
      expect((await read()).windows?.["1"].prs).toBe(5);
      await writeFile(file, '{"version":1}');
      expect(await read()).toMatchObject({ status: "unavailable", windows: null, accounts: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
