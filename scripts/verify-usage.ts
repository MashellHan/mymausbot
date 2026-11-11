import { createServer } from "node:http";
import { withGithubUsageFixture } from "./testing/merged-usage-fixture.ts";
import { primaryUsageFixture } from "./testing/primary-usage-fixture.ts";
import type { AddressInfo } from "node:net";
import type { LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../shared/local-dashboard.ts";
import type { Bot } from "../src/state/store.tsx";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const bot = {
  id: "fixture-bot", threadId: "fixture-thread", name: "Sample assistant", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, computer: "off", messages: [],
  modelSelection: { instanceId: "fixture-engine", model: "fixture-model" },
  tasks: [{ threadId: "fixture-thread", title: "Sample thread", createdAt: 1, approvalMode: "ask" }],
} as Bot;

const dates = (start: string) => Array.from({ length: 30 }, (_, index) =>
  new Date(Date.parse(`${start}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10));
const shiftDay = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const missingCategories = {
  work: { prs: null, knownPrs: null, commits: null },
  personal: { prs: null, knownPrs: null, commits: null },
  unclassified: { prs: null, knownPrs: null, commits: null },
};

function snapshot(scenario: string | null): LocalUsageResponse {
  if (scenario === "unavailable") return { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
    sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };

  const stale = scenario === "stale";
  const missing = scenario === "missing";
  const pendingZero = scenario === "pending-zero";
  const partialPr = missing || pendingZero;
  const midnight = scenario === "midnight";
  const noMetrics = scenario === "no-metrics";
  const zero = scenario === "zero";
  const noPrior = scenario === "no-prior";
  const unclassified = scenario === "unclassified";
  const beijingPartial = scenario === "beijing-partial";
  const asOf = midnight ? Date.UTC(2025, 11, 31, 16, 5)
    : beijingPartial ? Date.UTC(2026, 10, 2, 16, 5)
      : stale ? Date.UTC(2026, 10, 2, 15, 50) : Date.UTC(2026, 10, 3, 8, 30);
  const days = dates(midnight ? "2025-12-03" : stale ? "2026-10-04" : "2026-10-05");
  const trend: LocalUsageTrendDay[] = days.map((day, index) => {
    if (noMetrics) return { day, coverage: "unavailable", tokenStatus: "unavailable",
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, totalTokens: null, categories: missingCategories,
      wow: { prs: null, commits: null, newTokens: null, totalTokens: null } };
    if (missing && day === "2026-10-12") return { day, coverage: "unavailable", tokenStatus: "unavailable",
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, totalTokens: null, categories: missingCategories,
      wow: { prs: null, commits: null, newTokens: null, totalTokens: null } };
    const tokenGap = missing && day === "2026-10-15";
    const prs = partialPr ? null : zero ? 0 : index % 3 === 0 ? 2 : 1;
    const knownPrs = zero || pendingZero && day === "2026-10-12" ? 0 : index % 3 === 0 ? 2 : 1;
    const commits = zero ? 0 : 1 + index % 4;
    const newTokens = tokenGap ? null : zero ? 0 : 80 + index % 7 * 30;
    const cacheRead = tokenGap ? null : zero ? 0 : 20 + index % 3 * 10;
    const unclassifiedCommits = unclassified && index === 29 ? 1 : 0;
    const workPrs = prs === null ? null : Math.floor(prs / 2);
    const workKnownPrs = Math.floor(knownPrs / 2);
    const workCommits = Math.floor((commits - unclassifiedCommits) / 2);
    return { day, coverage: partialPr ? "partial" : "ready", tokenStatus: tokenGap ? "unavailable" : missing ? "partial" : "ready",
      prs, knownPrs, commits, newTokens, cacheRead, totalTokens: newTokens === null || cacheRead === null ? null : newTokens + cacheRead,
      categories: {
        work: { prs: workPrs, knownPrs: workKnownPrs, commits: workCommits },
        personal: { prs: prs === null ? null : prs - workPrs!, knownPrs: knownPrs - workKnownPrs, commits: commits - unclassifiedCommits - workCommits },
        unclassified: { prs: 0, knownPrs: 0, commits: unclassifiedCommits },
      },
      wow: { prs: null, commits: null, newTokens: null, totalTokens: null } };
  });
  const change = (current: number | null, previous: number | null) => current === null || previous === null ? null
    : previous === 0 ? current === 0 ? 0 : "new" as const : (current - previous) / previous * 100;
  for (let index = 7; index < trend.length; index++) {
    const row = trend[index]!, previous = trend[index - 7]!;
    row.wow = { prs: change(row.prs, previous.prs), commits: missing ? null : change(row.commits, previous.commits),
      newTokens: missing ? null : change(row.newTokens, previous.newTokens),
      totalTokens: missing ? null : change(row.totalTokens, previous.totalTokens) };
  }
  const makeWindow = (count: 1 | 7 | 30): LocalUsageWindow => {
    const rows = trend.slice(-count);
    const sum = (field: "knownPrs" | "commits" | "newTokens" | "cacheRead" | "totalTokens") => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
    const available = (field: "knownPrs" | "commits" | "newTokens" | "cacheRead" | "totalTokens") => rows.some((row) => row[field] !== null);
    const result = { days: count, startDay: rows[0]!.day, endDay: rows.at(-1)!.day, asOf,
      coverage: noMetrics ? "unavailable" : partialPr ? "partial" : "ready", tokenCoverage: noMetrics ? "unavailable" : missing ? "partial" : "ready",
      missingDays: rows.filter((row) => row.coverage === "unavailable").map((row) => row.day),
      unavailableTokenDays: rows.filter((row) => row.tokenStatus === "unavailable").map((row) => row.day),
      prs: partialPr || noMetrics ? null : sum("knownPrs"), knownPrs: available("knownPrs") ? sum("knownPrs") : null,
      commits: available("commits") ? sum("commits") : null,
      newTokens: available("newTokens") ? sum("newTokens") : null,
      cacheRead: available("cacheRead") ? sum("cacheRead") : null,
      totalTokens: available("totalTokens") ? sum("totalTokens") : null };
    const unclassifiedCommits = unclassified && result.commits !== null ? 1 : 0;
    const classifiedCommits = result.commits === null ? null : result.commits - unclassifiedCommits;
    const work = { prs: result.prs === null ? null : Math.floor(result.prs / 2), knownPrs: result.knownPrs === null ? null : Math.floor(result.knownPrs / 2), commits: classifiedCommits === null ? null : Math.floor(classifiedCommits / 2) };
    const personal = { prs: result.prs === null ? null : result.prs - (work.prs ?? 0), knownPrs: result.knownPrs === null ? null : result.knownPrs - (work.knownPrs ?? 0), commits: classifiedCommits === null ? null : classifiedCommits - (work.commits ?? 0) };
    const priorStart = shiftDay(result.startDay, -count), priorEnd = shiftDay(result.startDay, -1);
    const comparable = !noMetrics && !(noPrior && count === 30) && result.missingDays.length === 0;
    const prComparison = comparable && !partialPr ? zero ? 0 : count === 1 ? 10 : count === 7 ? 20 : 30 : null;
    const commitComparison = comparable ? zero ? 0 : count === 1 ? 10 : count === 7 ? 20 : 30 : null;
    const tokenComparison = comparable && result.unavailableTokenDays.length === 0 ? zero ? 0 : count === 7 ? "new" as const : count === 1 ? 10 : 30 : null;
    const comparison = { startDay: priorStart, endDay: priorEnd,
      missingDays: noMetrics || (noPrior && count === 30) ? [priorStart] : [],
      unavailableTokenDays: noMetrics || (noPrior && count === 30) ? [priorStart] : [],
      prs: prComparison, commits: commitComparison, totalTokens: tokenComparison,
      categories: {
        work: { prs: prComparison === null ? null : zero ? 0 : 5, commits: commitComparison === null ? null : zero ? 0 : 10 },
        personal: { prs: prComparison === null ? null : zero ? 0 : 15, commits: commitComparison === null ? null : zero ? 0 : 20 },
        unclassified: { prs: unclassified && prComparison !== null ? 0 : null, commits: unclassified && commitComparison !== null ? 30 : null },
      } };
    return { ...result, coverage: noMetrics ? "unavailable" : partialPr ? "partial" : "ready", tokenCoverage: noMetrics ? "unavailable" : missing ? "partial" : "ready",
      comparison,
      categories: { work, personal, unclassified: { prs: noMetrics ? null : 0, knownPrs: noMetrics ? null : 0, commits: result.commits === null ? null : unclassifiedCommits } },
      repositories: { sharedCommits: 0, coverage: noMetrics ? "unavailable" : missing ? "partial" : "ready", unattributedPrs: result.knownPrs === null ? null : 0, unattributedCommits: result.commits === null ? null : unclassifiedCommits,
        rows: noMetrics || zero ? [] : [
          { id: "sample-work", name: "example/workspace-tools", category: "work", ...work, comparison: comparison.categories.work },
          { id: "sample-personal", name: "example/personal-lab", category: "personal", ...personal, comparison: comparison.categories.personal },
        ] } };

  };
  return { status: stale ? "stale" : partialPr || noMetrics ? "partial" : "ready", asOf, timeZone: "Asia/Shanghai",
    sourceCoverage: { total: 2, ready: noMetrics ? 0 : missing ? 1 : 2, partial: 0, stale: 0, missing: noMetrics ? 2 : missing ? 1 : 0 },
    prSourceCoverage: { total: 4, ready: noMetrics ? 0 : partialPr ? 3 : 4, stale: 0,
      unavailable: noMetrics ? 4 : partialPr ? 1 : 0, missing: 0 },
    prCoverage: { work: partialPr || noMetrics ? "partial" : "ready", personal: noMetrics ? "partial" : "ready",
      unclassified: partialPr || noMetrics ? "partial" : "ready" },
    windows: { "1": makeWindow(1), "7": makeWindow(7), "30": makeWindow(30) }, trend };
}

const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url?.includes("/computer/control")) res.end(JSON.stringify({ held: false, helpReason: null }));
  else res.end("{}");
});
await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
let preview: MountedPreview | undefined;
try {
  preview = await mountPreview({ info: { url: `http://127.0.0.1:${address.port}` } }, {
    entry: "/scripts/testing/local-usage-preview.tsx", route: "/__local-usage.html", title: "Isolated Usage panel",
    extraRoutes: [
      { path: "/__local-usage-bot", handler: (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(bot));
      } },
      { path: "/api/local-dashboard/usage", handler: (req, res) => {
        const scenario = new URL(req.headers.referer ?? "http://127.0.0.1/").searchParams.get("scenario");
        res.setHeader("content-type", "application/json");
        const value = withGithubUsageFixture(snapshot(scenario));
        if (scenario === "remote-only") res.end(JSON.stringify({ ...snapshot("unavailable"), github: value.github }));
        else if (scenario === "legacy-only") res.end(JSON.stringify(snapshot("ready")));
        else res.end(JSON.stringify({ ...value, contributions: scenario === "unavailable"
          ? { ...primaryUsageFixture(), status: "unavailable", windows: null, accounts: [], trend: [], history: [] }
          : primaryUsageFixture("2026-11-03", scenario === "known-counts" || scenario === "beijing-partial",
            scenario === "beijing-partial" ? "2026-11-02T16:05:00Z" : "2026-11-03T08:30:00Z",
            scenario === "beijing-partial" ? { github: { prs: 1, commits: 2 }, ado: { prs: 2, commits: 3 } } : undefined) }));
      } },
    ],
  });
  console.log(JSON.stringify({ previewUrl: preview.previewUrl + "?mode=simple&width=400&scenario=missing&skin=midnight", fixture: "synthetic Usage aggregates only" }));
  await parkUntilSignal();
} finally {
  await preview?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
