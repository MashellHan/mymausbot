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
const shiftDay = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const window = (days: 1 | 7 | 30, startDay: string, endDay: string, patch: Partial<LocalUsageWindow> = {}): LocalUsageWindow => ({
  days, startDay, endDay, asOf, coverage: "partial", tokenCoverage: "partial", missingDays: [], unavailableTokenDays: [],
  prs: null, knownPrs: 2, commits: 4, newTokens: 100, cacheRead: 50, totalTokens: 150,
  comparison: { startDay: shiftDay(startDay, -days), endDay: shiftDay(startDay, -1), missingDays: [], unavailableTokenDays: [],
    prs: null, commits: null, totalTokens: null,
    categories: { work: { prs: null, commits: null }, personal: { prs: null, commits: null }, unclassified: { prs: null, commits: null } } },
  categories: { work: { prs: null, knownPrs: 1, commits: 3 }, personal: { prs: 1, knownPrs: 1, commits: 1 }, unclassified: { prs: 0, knownPrs: 0, commits: 0 } },
  repositories: { sharedCommits: 0, coverage: "partial", rows: [{ id: "repo", name: "sample/team-repo", category: "work", prs: null, knownPrs: days, commits: days * 2,
    comparison: { prs: null, commits: days === 1 ? 10 : days === 7 ? 20 : 30 } }], unattributedPrs: 0, unattributedCommits: 0 }, ...patch,
});
const trend: LocalUsageTrendDay[] = Array.from({ length: 30 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 9, 5 + index)).toISOString().slice(0, 10),
  coverage: "partial", tokenStatus: "partial", prs: null, knownPrs: 1, commits: 2, newTokens: 100, cacheRead: 10, totalTokens: 110,
  categories: { work: { prs: null, knownPrs: 1, commits: 1 }, personal: { prs: 0, knownPrs: 0, commits: 1 }, unclassified: { prs: 0, knownPrs: 0, commits: 0 } },
  wow: { prs: null, commits: 20, newTokens: "new", totalTokens: "new" },
}));
trend[7] = { day: "2026-10-12", coverage: "unavailable", tokenStatus: "unavailable", prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, totalTokens: null,
  categories: { work: { prs: null, knownPrs: null, commits: null }, personal: { prs: null, knownPrs: null, commits: null }, unclassified: { prs: null, knownPrs: null, commits: null } },
  wow: { prs: null, commits: null, newTokens: null, totalTokens: null } };
trend[10] = { ...trend[10]!, tokenStatus: "unavailable", newTokens: null, cacheRead: null, totalTokens: null,
  wow: { prs: null, commits: null, newTokens: null, totalTokens: null } };

const sample: LocalUsageResponse = {
  status: "partial", asOf, timeZone: "Asia/Shanghai",
  sourceCoverage: { total: 2, ready: 1, partial: 0, stale: 0, missing: 1 },
  prSourceCoverage: { total: 4, ready: 3, stale: 0, unavailable: 1, missing: 0 },
  prCoverage: { work: "partial", personal: "ready", unclassified: "partial" },
  windows: {
    "1": window(1, "2026-11-03", "2026-11-03", { prs: 1, knownPrs: 1, commits: 2, newTokens: 100, cacheRead: 50, totalTokens: 150,
      comparison: { startDay: "2026-11-02", endDay: "2026-11-02", missingDays: [], unavailableTokenDays: [], prs: 10, commits: 50, totalTokens: 10,
        categories: { work: { prs: null, commits: 20 }, personal: { prs: 10, commits: 30 }, unclassified: { prs: null, commits: null } } } }),
    "7": window(7, "2026-10-28", "2026-11-03", { knownPrs: 4, commits: 12, newTokens: 600, cacheRead: 300, totalTokens: 900,
      comparison: { startDay: "2026-10-21", endDay: "2026-10-27", missingDays: [], unavailableTokenDays: [], prs: null, commits: 20, totalTokens: "new",
        categories: { work: { prs: null, commits: 10 }, personal: { prs: null, commits: 30 }, unclassified: { prs: null, commits: null } } } }),
    "30": window(30, "2026-10-05", "2026-11-03", { knownPrs: 9, commits: 58, newTokens: 2_800, cacheRead: 1_200, totalTokens: 4_000,
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
    expect(text()).toContain("4,000");
    expect(text()).toContain("+10% DoD");
    expect(text()).toContain("+20% WoW");
    expect(text()).toContain("— MoM");
    expect(host.querySelector('section [data-usage-category-row="work"]')?.textContent).toContain("+20%");
    expect(host.querySelector('section [data-usage-category-row="personal"]')?.textContent).toContain("+10%");
    expect(host.querySelector("section")?.textContent).toContain("PRs · DoD");
    expect(text()).toContain("Missing dates: 1");
    expect(text()).toContain("Dates without token records: 2");
    expect(text()).not.toContain("Across connected tools and repositories");
    expect(text()).not.toContain("Source coverage");
    expect(text()).not.toContain("Activity sources:");
    expect(text()).not.toContain("Tokens = noncached");
    expect(text()).not.toContain("shared appearances");
    expect(host.querySelector("section h3")?.parentElement?.textContent).toContain("2026-11-03 – 2026-11-03");
    expect(host.querySelectorAll("[data-usage-daily] table tbody tr")).toHaveLength(30);
    expect(text()).not.toContain("2026-10-04");
    expect(host.querySelectorAll('[data-usage-trend="prs"] [data-usage-day]')).toHaveLength(30);
    expect(host.querySelectorAll('.bg-warning\\/15').length).toBeGreaterThan(0);
    expect(host.querySelector('time')?.getAttribute("datetime")).toBe("2026-11-03T08:30:00.000Z");
  });

  it("shows a visible PR tooltip on hover, focus and tap without treating synced zero as exact", async () => {
    await render({ ...sample, trend: [
      { ...trend[0]!, prs: null, knownPrs: 0, categories: { ...trend[0]!.categories, work: { prs: null, knownPrs: 0, commits: 1 } } },
      { ...trend[1]!, prs: null, knownPrs: 2, categories: { ...trend[1]!.categories, work: { prs: null, knownPrs: 2, commits: 1 } } },
      { ...trend[2]!, prs: 0, knownPrs: 0, categories: { work: { prs: 0, knownPrs: 0, commits: 1 }, personal: { prs: 0, knownPrs: 0, commits: 1 }, unclassified: { prs: 0, knownPrs: 0, commits: 0 } } },
      ...trend.slice(3),
    ] });
    const bars = [...host.querySelectorAll<HTMLButtonElement>('[data-usage-trend="prs"] [data-usage-day]')];
    expect(bars[0]!.getAttribute("aria-label")).toContain("0 · Synced");
    expect(bars[1]!.querySelector('[data-usage-category="work"]')?.className).toContain("bg-accent/35");
    expect(bars[2]!.getAttribute("aria-label")).not.toContain("Synced");
    await act(async () => bars[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toMatch(/2026-10-06.*PRs.*2.*Synced.*Enterprise/s);
    await act(async () => bars[2]!.focus());
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toContain("2026-10-07");
    await act(async () => bars[0]!.click());
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toContain("2026-10-05");
    await act(async () => bars[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(bars[1]);
    await act(async () => bars[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')).toBeNull();
    expect(text()).toContain("Pale PR segments: synced counts");
  });

  it("shows total tokens including cache reads in cards, daily values and a focused trend tooltip", async () => {
    await render(sample);
    expect(host.querySelector("section dd > span")?.textContent).toBe("1");
    expect([...host.querySelectorAll("section dd")][2]?.firstElementChild?.textContent).toBe("150");
    expect(host.querySelector('[data-usage-daily] tbody tr:first-child td:nth-child(4)')?.textContent).toBe("110");
    const last = host.querySelectorAll<HTMLButtonElement>('[data-usage-trend="totalTokens"] [data-usage-day]')[29]!;
    await act(async () => last.focus());
    expect(host.querySelector('[data-usage-trend="totalTokens"] [role="tooltip"]')?.textContent).toContain("Tokens: 110");
    expect(last.getAttribute("title")).toBeNull();
  });

  it("stacks Enterprise and Personal trend values and adds Unclassified only when observed", async () => {
    await render(sample);
    const first = () => host.querySelector('[data-usage-trend="commits"] [data-usage-day]')!;
    expect(first().querySelector('[data-usage-category="work"]')).not.toBeNull();
    expect(first().querySelector('[data-usage-category="personal"]')).not.toBeNull();
    expect(host.querySelector('[data-usage-category-legend]')?.textContent).not.toContain("Unclassified");

    const withUnclassified = [{ ...trend[0]!, categories: { ...trend[0]!.categories,
      work: { ...trend[0]!.categories.work, commits: 0 }, unclassified: { prs: 0, knownPrs: 0, commits: 1 } } }, ...trend.slice(1)];
    await render({ ...sample, trend: withUnclassified });
    expect(host.querySelector('[data-usage-category-legend]')?.textContent).toContain("Unclassified");
    expect(first().querySelector('[data-usage-category="unclassified"]')).not.toBeNull();
    await act(async () => (first() as HTMLButtonElement).focus());
    expect(host.querySelector('[data-usage-trend="commits"] [role="tooltip"]')?.textContent).toMatch(/2026-10-05.*Enterprise.*Personal.*Unclassified/s);
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
      coverage: "unavailable", tokenCoverage: "unavailable", prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null, totalTokens: null,
    }) } });
    const first = host.querySelector<HTMLElement>("section")!;
    expect([...first.querySelectorAll("dd")].map((value) => value.firstElementChild?.textContent)).toEqual(["Unavailable", "Unavailable", "Unavailable"]);

    await render({ ...sample, status: "ready", windows: { ...sample.windows!, "1": window(1, "2026-11-03", "2026-11-03", {
      coverage: "ready", tokenCoverage: "ready", prs: 0, knownPrs: 0, commits: 0, newTokens: 0, cacheRead: 0, totalTokens: 0,
    }) } });
    expect([...host.querySelector<HTMLElement>("section")!.querySelectorAll("dd")].map((value) => value.firstElementChild?.textContent)).toEqual(["0", "0", "0"]);
  });

  it("refreshes the local summary every five minutes and keeps the last good response on failure", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(sample).mockRejectedValueOnce(new Error("offline"));
    await render(null, true);
    expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/usage", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1); });
    expect(calls.api).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.api).toHaveBeenCalledTimes(2);
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
    expect(values()[0]).toBe("Enterprise");
    expect(values()[1]).toContain("1Synced— DoD");
    expect(values()[2]).toContain("2+10% DoD");
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tabs[2]);
    expect(values()[1]).toContain("30Synced— MoM");
    expect(values()[2]).toContain("60+30% MoM");
    await render({ ...sample, status: "stale" });
    expect(daily.open).toBe(true);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Personal");
  });

  it.each([401, 403])("clears old activity data on HTTP %i", async (status) => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(sample).mockRejectedValueOnce(new ApiError("forbidden", status));
    await render(null, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1_000); });
    expect(text()).toContain("Activity summary unavailable");
    expect(text()).not.toContain("2026-10-05 – 2026-11-03");
  });
});
