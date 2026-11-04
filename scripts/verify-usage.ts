import { createServer } from "node:http";
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
  const asOf = midnight ? Date.UTC(2025, 11, 31, 16, 5)
    : stale ? Date.UTC(2026, 10, 2, 15, 50) : Date.UTC(2026, 10, 3, 8, 30);
  const days = dates(midnight ? "2025-12-03" : stale ? "2026-10-04" : "2026-10-05");
  const trend: LocalUsageTrendDay[] = days.map((day, index) => {
    if (noMetrics) return { day, coverage: "unavailable", tokenStatus: "unavailable",
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, wow: { prs: null, commits: null, newTokens: null } };
    if (missing && day === "2026-10-12") return { day, coverage: "unavailable", tokenStatus: "unavailable",
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, wow: { prs: null, commits: null, newTokens: null } };
    const tokenGap = missing && day === "2026-10-15";
    return { day, coverage: partialPr ? "partial" : "ready", tokenStatus: tokenGap ? "unavailable" : missing ? "partial" : "ready",
      prs: partialPr ? null : zero ? 0 : index % 3 === 0 ? 2 : 1,
      knownPrs: zero || pendingZero && day === "2026-10-12" ? 0 : index % 3 === 0 ? 2 : 1,
      commits: zero ? 0 : 1 + index % 4,
      newTokens: tokenGap ? null : zero ? 0 : 80 + index % 7 * 30,
      cacheRead: tokenGap ? null : zero ? 0 : 20 + index % 3 * 10,
      wow: { prs: null, commits: null, newTokens: null } };
  });
  const change = (current: number | null, previous: number | null) => current === null || previous === null ? null
    : previous === 0 ? current === 0 ? 0 : "new" as const : (current - previous) / previous * 100;
  for (let index = 7; index < trend.length; index++) {
    const row = trend[index]!, previous = trend[index - 7]!;
    row.wow = { prs: change(row.prs, previous.prs), commits: missing ? null : change(row.commits, previous.commits),
      newTokens: missing ? null : change(row.newTokens, previous.newTokens) };
  }
  const makeWindow = (count: 1 | 7 | 30): LocalUsageWindow => {
    const rows = trend.slice(-count);
    const sum = (field: "knownPrs" | "commits" | "newTokens" | "cacheRead") => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
    const available = (field: "knownPrs" | "commits" | "newTokens" | "cacheRead") => rows.some((row) => row[field] !== null);
    const result = { days: count, startDay: rows[0]!.day, endDay: rows.at(-1)!.day, asOf,
      coverage: noMetrics ? "unavailable" : partialPr ? "partial" : "ready", tokenCoverage: noMetrics ? "unavailable" : missing ? "partial" : "ready",
      missingDays: rows.filter((row) => row.coverage === "unavailable").map((row) => row.day),
      unavailableTokenDays: rows.filter((row) => row.tokenStatus === "unavailable").map((row) => row.day),
      prs: partialPr || noMetrics ? null : sum("knownPrs"), knownPrs: available("knownPrs") ? sum("knownPrs") : null,
      commits: available("commits") ? sum("commits") : null,
      newTokens: available("newTokens") ? sum("newTokens") : null,
      cacheRead: available("cacheRead") ? sum("cacheRead") : null };
    const work = { prs: result.prs === null ? null : Math.floor(result.prs / 2), knownPrs: result.knownPrs === null ? null : Math.floor(result.knownPrs / 2), commits: result.commits === null ? null : Math.floor(result.commits / 2) };
    const personal = { prs: result.prs === null ? null : result.prs - (work.prs ?? 0), knownPrs: result.knownPrs === null ? null : result.knownPrs - (work.knownPrs ?? 0), commits: result.commits === null ? null : result.commits - (work.commits ?? 0) };
    return { ...result, coverage: noMetrics ? "unavailable" : partialPr ? "partial" : "ready", tokenCoverage: noMetrics ? "unavailable" : missing ? "partial" : "ready",
      categories: { work, personal, unclassified: { prs: noMetrics ? null : 0, knownPrs: noMetrics ? null : 0, commits: noMetrics ? null : 0 } },
      repositories: { sharedCommits: 0, coverage: noMetrics ? "unavailable" : missing ? "partial" : "ready", unattributedPrs: result.knownPrs === null ? null : 0, unattributedCommits: result.commits === null ? null : 0,
        rows: noMetrics || zero ? [] : [
          { id: "sample-work", name: "example/workspace-tools", category: "work", ...work },
          { id: "sample-personal", name: "example/personal-lab", category: "personal", ...personal },
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
        res.end(JSON.stringify(snapshot(scenario)));
      } },
    ],
  });
  console.log(JSON.stringify({ previewUrl: preview.previewUrl + "?mode=simple&width=400&scenario=missing&skin=midnight", fixture: "synthetic Usage aggregates only" }));
  await parkUntilSignal();
} finally {
  await preview?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
