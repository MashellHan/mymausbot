import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { aggregateContributionSnapshot, createLocalContributionsReader, parseContributionSnapshot } from "./local-usage-contributions.ts";

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
  return { version: 2, metricDefinition: provider === "github" ? "github-profile-v2" : "ado-default-head-v1", provider,
    asOfAt: "2026-11-10T12:00:00Z", capturedAt: "2026-11-10T12:00:00Z",
    dateBasis: provider === "github" ? { prs: "github-profile-day", commits: "github-profile-day" }
      : { prs: "created-at/UTC", commits: "author-at/UTC" },
    operationWindow: { startDay: date(0), endDay: date(59), todayPartial: true },
    activeSourceIds: [sourceId], sources: [{ id: sourceId,
      account: { host: provider === "github" ? "github.example" : "dev.azure.com", login: "fixture-owner", stableId: "fixture-stable-id" },
      ...(provider === "ado" ? { scope: { organization: "fixture-org", project: "fixture-project" } } : {}),
      status: "ready", coverage: { identityVerified: true, paginationComplete: true, visibilityComplete: true, reasons: [] }, days }],
    collection: { requestCount: 2, elapsedSeconds: 0.1, complete: true, reasons: [] }, state: { privateContinuation: "never-public" } };
}

function snapshot() { return { version: 2, github: envelope("github"), ado: envelope("ado") }; }
const parse = (value: unknown) => parseContributionSnapshot(value, cutoff + 60_000);

describe("canonical source-qualified contributions", () => {
  it("keeps Profile and ADO source days, accounts, categories, repositories and comparisons on one version", () => {
    const result = aggregateContributionSnapshot(parse(snapshot()), cutoff + 60_000);
    expect(result.metricDefinition).toBe("contributions-v2");
    expect(result.timeZone).toBe("provider-days");
    expect(result.dateBasis).toMatchObject({ github: { prs: "github-profile-day" }, ado: { commits: "author-at/UTC" } });
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
    }
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
