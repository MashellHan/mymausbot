// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../../shared/local-dashboard";
import { setLocale } from "@/lib/i18n";

const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: calls.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

const { LocalUsagePanel, LocalUsageView } = await import("./LocalUsagePanel");
const { ApiError } = await import("@/state/store");

const asOf = Date.UTC(2026, 10, 3, 8, 30);
const window = (days: 1 | 7 | 30, startDay: string, endDay: string, patch: Partial<LocalUsageWindow> = {}): LocalUsageWindow => ({
  days, startDay, endDay, asOf, coverage: "partial", tokenCoverage: "partial", missingDays: [], unavailableTokenDays: [],
  prs: null, knownPrs: 2, commits: 4, newTokens: 100, cacheRead: 50,
  categories: { work: { prs: null, knownPrs: 1, commits: 3 }, personal: { prs: 1, knownPrs: 1, commits: 1 }, unclassified: { prs: 0, knownPrs: 0, commits: 0 } },
  repositories: { sharedCommits: 0, coverage: "partial", rows: [{ id: "repo", name: "sample/team-repo", category: "work", prs: null, knownPrs: days, commits: days * 2 }], unattributedPrs: 0, unattributedCommits: 0 }, ...patch,
});
const trend: LocalUsageTrendDay[] = Array.from({ length: 30 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 9, 5 + index)).toISOString().slice(0, 10),
  coverage: "partial", tokenStatus: "partial", prs: null, knownPrs: 1, commits: 2, newTokens: 100, cacheRead: 10, wow: { prs: null, commits: 20, newTokens: "new" },
}));
trend[7] = { day: "2026-10-12", coverage: "unavailable", tokenStatus: "unavailable", prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, wow: { prs: null, commits: null, newTokens: null } };
trend[10] = { ...trend[10]!, tokenStatus: "unavailable", newTokens: null, cacheRead: null, wow: { prs: null, commits: null, newTokens: null } };

const sample: LocalUsageResponse = {
  status: "partial", asOf, timeZone: "Asia/Shanghai",
  sourceCoverage: { total: 2, ready: 1, partial: 0, stale: 0, missing: 1 },
  prSourceCoverage: { total: 4, ready: 3, stale: 0, unavailable: 1, missing: 0 },
  prCoverage: { work: "partial", personal: "ready", unclassified: "partial" },
  windows: {
    "1": window(1, "2026-11-03", "2026-11-03", { prs: 1, knownPrs: 1, commits: 2, newTokens: 100 }),
    "7": window(7, "2026-10-28", "2026-11-03", { knownPrs: 4, commits: 12, newTokens: 600 }),
    "30": window(30, "2026-10-05", "2026-11-03", { knownPrs: 9, commits: 58, newTokens: 2_800,
      missingDays: ["2026-10-12"], unavailableTokenDays: ["2026-10-12", "2026-10-15"] }),
  },
  trend,
};

let host: HTMLDivElement;
let root: Root;
const render = async (snapshot: LocalUsageResponse | null, panel = false) => {
  await act(async () => root.render(panel ? createElement(LocalUsagePanel) : createElement(LocalUsageView, { snapshot })));
};
const text = () => host.textContent ?? "";

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  setLocale("en");
  calls.api.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("local Usage panel", () => {
  it("shows today-inclusive windows, partial PR bounds, exact daily values and missing gaps", async () => {
    await render(sample);
    expect(text()).toContain("1-day window");
    expect(text()).toContain("2026-11-03 – 2026-11-03");
    expect(text()).toContain("2026-10-28 – 2026-11-03");
    expect(text()).toContain("2026-10-05 – 2026-11-03");
    expect(text()).toContain("9Synced");
    expect(text()).not.toContain("≥");
    expect(host.querySelector<HTMLDetailsElement>("[data-usage-daily]")?.open).toBe(false);
    expect(text()).toContain("2,800");
    expect(text()).toContain("Missing dates: 1");
    expect(text()).toContain("Dates without token records: 2");
    expect(text()).toContain("Activity sources: 1/2 ready");
    expect(text()).toContain("PR sources: 3/4 ready");
    expect(host.querySelectorAll("[data-usage-daily] table tbody tr")).toHaveLength(30);
    expect(text()).not.toContain("2026-10-04");
    expect(host.querySelectorAll('[aria-hidden="true"] .bg-warning\\/15').length).toBeGreaterThan(0);
    expect(host.querySelector('time')?.getAttribute("datetime")).toBe("2026-11-03T08:30:00.000Z");
  });

  it("labels partial PR bars as lower bounds and keeps known zero pending", async () => {
    await render({ ...sample, trend: [
      { ...trend[0]!, prs: null, knownPrs: 0 },
      { ...trend[1]!, prs: null, knownPrs: 2 },
      { ...trend[2]!, prs: 0, knownPrs: 0 },
      ...trend.slice(3),
    ] });
    const bars = [...host.querySelector('[data-usage-trend="prs"] [aria-hidden="true"]')!.children] as HTMLElement[];
    expect(bars[0]!.title).toBe("2026-10-05: 0 · Synced");
    expect(bars[0]!.firstElementChild?.className).toContain("bg-accent/40");
    expect(bars[1]!.title).toBe("2026-10-06: 2 · Synced");
    expect(bars[1]!.firstElementChild?.className).toContain("bg-accent/40");
    expect(bars[2]!.title).toBe("2026-10-07: 0");
    expect(bars[2]!.firstElementChild?.className).toContain("bg-accent/75");
    expect(text()).toContain("Pale PR bars: synced counts");
  });

  it("anchors a stale previous-day snapshot to its real capture day, with no current-day claim", async () => {
    const previousAsOf = Date.UTC(2026, 10, 2, 15, 50);
    const windows = {
      "1": window(1, "2026-11-02", "2026-11-02", { asOf: previousAsOf }),
      "7": window(7, "2026-10-27", "2026-11-02", { asOf: previousAsOf }),
      "30": window(30, "2026-10-04", "2026-11-02", { asOf: previousAsOf }),
    };
    await render({ ...sample, status: "stale", asOf: previousAsOf, windows,
      trend: trend.map((day) => ({ ...day, day: new Date(Date.parse(day.day + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10) })) });
    expect(text()).toContain("Showing the last captured snapshot");
    expect(text()).toContain("2026-11-02 – 2026-11-02");
    expect(text()).toContain("2026-10-04 – 2026-11-02");
    expect(text()).toContain("23:50");
    expect(text()).not.toContain("today");
    expect(host.querySelector('time')?.getAttribute("datetime")).toBe("2026-11-02T15:50:00.000Z");
  });

  it("renders a China-midnight year rollover without shifting dates or showing 24:05", async () => {
    const midnight = Date.UTC(2025, 11, 31, 16, 5);
    await render({ ...sample, status: "ready", asOf: midnight, windows: {
      "1": window(1, "2026-01-01", "2026-01-01", { asOf: midnight }),
      "7": window(7, "2025-12-26", "2026-01-01", { asOf: midnight }),
      "30": window(30, "2025-12-03", "2026-01-01", { asOf: midnight }),
    }, trend: trend.map((day, index) => ({ ...day, day: new Date(Date.UTC(2025, 11, 3 + index)).toISOString().slice(0, 10) })) });
    expect(text()).toContain("2025-12-26 – 2026-01-01");
    expect(text()).toContain("2025-12-03 – 2026-01-01");
    expect(text()).toContain("00:05");
    expect(text()).not.toContain("24:05");
    expect(host.querySelectorAll("[data-usage-daily] table tbody tr")).toHaveLength(30);
  });

  it("uses unavailable instead of zero when the aggregate or a whole metric is missing", async () => {
    await render({ status: "unavailable", asOf: null, timeZone: "Asia/Shanghai", sourceCoverage: null,
      prSourceCoverage: null, prCoverage: null, windows: null, trend: [] });
    expect(text()).toContain("Activity summary unavailable");
    expect(text()).not.toContain("0 PRs");

    await render({ ...sample, windows: { ...sample.windows!, "1": window(1, "2026-11-03", "2026-11-03", {
      coverage: "unavailable", tokenCoverage: "unavailable", prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null,
    }) } });
    const first = host.querySelector<HTMLElement>("section")!;
    expect([...first.querySelectorAll("dd")].map((value) => value.textContent)).toEqual(["Unavailable", "Unavailable", "Unavailable"]);

    await render({ ...sample, status: "ready", windows: { ...sample.windows!, "1": window(1, "2026-11-03", "2026-11-03", {
      coverage: "ready", tokenCoverage: "ready", prs: 0, knownPrs: 0, commits: 0, newTokens: 0, cacheRead: 0,
    }) } });
    expect([...host.querySelector<HTMLElement>("section")!.querySelectorAll("dd")].map((value) => value.textContent)).toEqual(["0", "0", "0"]);
  });

  it("fetches only the local summary and keeps a last-good response on transport failure", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(sample).mockRejectedValueOnce(new Error("offline"));
    await render(null, true);
    expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/usage", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1_000); });
    expect(text()).toContain("Showing the last captured snapshot");
    expect(text()).toContain("2026-10-05 – 2026-11-03");
  });

  it("keeps daily details collapsed initially and changes repository windows with keyboard tabs", async () => {
    await render(sample);
    const daily = host.querySelector<HTMLDetailsElement>("[data-usage-daily]")!;
    expect(daily.open).toBe(false);
    daily.open = true;
    expect(daily.textContent).toContain("+20%");
    expect(daily.textContent).toContain("New");
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    const values = () => [...host.querySelectorAll("[data-usage-repositories] tbody tr:first-child td")].map((cell) => cell.textContent);
    expect(values()).toEqual(["Enterprise", "1Synced", "2"]);
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tabs[2]);
    expect(values()).toEqual(["Enterprise", "30Synced", "60"]);
    await render({ ...sample, status: "stale" });
    expect(daily.open).toBe(true);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Personal");
  });

  it.each([401, 403])("clears old activity data on HTTP %i", async (status) => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(sample).mockRejectedValueOnce(new ApiError("forbidden", status));
    await render(null, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1_000); });
    expect(text()).toContain("Activity summary unavailable");
    expect(text()).not.toContain("2026-10-05 – 2026-11-03");
  });
});
