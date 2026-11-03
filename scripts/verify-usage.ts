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
  const midnight = scenario === "midnight";
  const noMetrics = scenario === "no-metrics";
  const zero = scenario === "zero";
  const asOf = midnight ? Date.UTC(2025, 11, 31, 16, 5)
    : stale ? Date.UTC(2026, 10, 2, 15, 50) : Date.UTC(2026, 10, 3, 8, 30);
  const days = dates(midnight ? "2025-12-03" : stale ? "2026-10-04" : "2026-10-05");
  const trend: LocalUsageTrendDay[] = days.map((day, index) => {
    if (noMetrics) return { day, coverage: "unavailable", tokenStatus: "unavailable",
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null };
    if (missing && day === "2026-10-12") return { day, coverage: "unavailable", tokenStatus: "unavailable",
      prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null };
    const tokenGap = missing && day === "2026-10-15";
    return { day, coverage: missing ? "partial" : "ready", tokenStatus: tokenGap ? "unavailable" : missing ? "partial" : "ready",
      prs: missing ? null : zero ? 0 : index % 3 === 0 ? 2 : 1,
      knownPrs: zero ? 0 : index % 3 === 0 ? 2 : 1,
      commits: zero ? 0 : 1 + index % 4,
      newTokens: tokenGap ? null : zero ? 0 : 80 + index % 7 * 30,
      cacheRead: tokenGap ? null : zero ? 0 : 20 + index % 3 * 10 };
  });
  const makeWindow = (count: 1 | 7 | 30): LocalUsageWindow => {
    const rows = trend.slice(-count);
    const sum = (field: "knownPrs" | "commits" | "newTokens" | "cacheRead") => rows.reduce((total, row) => total + (row[field] ?? 0), 0);
    const available = (field: "knownPrs" | "commits" | "newTokens" | "cacheRead") => rows.some((row) => row[field] !== null);
    return { days: count, startDay: rows[0]!.day, endDay: rows.at(-1)!.day, asOf,
      coverage: noMetrics ? "unavailable" : missing ? "partial" : "ready", tokenCoverage: noMetrics ? "unavailable" : missing ? "partial" : "ready",
      missingDays: rows.filter((row) => row.coverage === "unavailable").map((row) => row.day),
      unavailableTokenDays: rows.filter((row) => row.tokenStatus === "unavailable").map((row) => row.day),
      prs: missing || noMetrics ? null : sum("knownPrs"), knownPrs: available("knownPrs") ? sum("knownPrs") : null,
      commits: available("commits") ? sum("commits") : null,
      newTokens: available("newTokens") ? sum("newTokens") : null,
      cacheRead: available("cacheRead") ? sum("cacheRead") : null };
  };
  return { status: stale ? "stale" : missing || noMetrics ? "partial" : "ready", asOf, timeZone: "Asia/Shanghai",
    sourceCoverage: { total: 2, ready: noMetrics ? 0 : missing ? 1 : 2, partial: 0, stale: 0, missing: noMetrics ? 2 : missing ? 1 : 0 },
    prSourceCoverage: { total: 4, ready: noMetrics ? 0 : missing ? 3 : 4, stale: 0,
      unavailable: noMetrics ? 4 : missing ? 1 : 0, missing: 0 },
    prCoverage: { work: missing || noMetrics ? "partial" : "ready", personal: noMetrics ? "partial" : "ready",
      unclassified: missing || noMetrics ? "partial" : "ready" },
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
