// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../../shared/local-dashboard";
import { UsageChange } from "./LocalUsageValues";
import { setLocale } from "@/lib/i18n";
import { withGithubUsageFixture, withMergedUsageFixture } from "../../scripts/testing/merged-usage-fixture";

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
const rolledWindow = (current: LocalUsageWindow, offset: number): LocalUsageWindow => ({
  ...current, startDay: shiftDay(current.startDay, offset), endDay: shiftDay(current.endDay, offset),
  comparison: { ...current.comparison, startDay: shiftDay(current.comparison.startDay, offset), endDay: shiftDay(current.comparison.endDay, offset) },
});
const rolled = (offset: number): LocalUsageResponse => ({ ...sample, asOf: asOf + offset * 86_400_000,
  windows: { "1": rolledWindow(sample.windows!["1"], offset), "7": rolledWindow(sample.windows!["7"], offset), "30": rolledWindow(sample.windows!["30"], offset) },
  trend: trend.map((day) => ({ ...day, day: shiftDay(day.day, offset) })),
});

let host: HTMLDivElement;
let root: Root;
const renderRaw = async (snapshot: LocalUsageResponse | null, panel = false) => {
  await act(async () => root.render(panel ? createElement(LocalUsagePanel) : createElement(LocalUsageView, { snapshot })));
};
const render = (snapshot: LocalUsageResponse | null, panel = false) => renderRaw(snapshot && withGithubUsageFixture(snapshot), panel);
const text = () => host.textContent ?? "";
const infoText = () => document.querySelector("[data-info-hint-content]")?.textContent ?? "";
const showSummaryInfo = async () => {
  await act(async () => host.querySelector<HTMLButtonElement>("header [data-info-hint]")!.click());
};

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
  it("shares the extended range across charts, keeps daily details and restores daily bars", async () => {
    const history = Array.from({ length: 184 }, (_, index) => ({ ...trend[0]!, day: shiftDay("2026-11-03", index - 183) }));
    Object.assign(history.find((day) => day.day === "2026-09-20")!, { tokenStatus: "partial", newTokens: 0, cacheRead: 0, totalTokens: 0 });
    Object.assign(history.find((day) => day.day === "2026-09-21")!, { tokenStatus: "unavailable", newTokens: null, cacheRead: null, totalTokens: null });
    Object.assign(history.find((day) => day.day === "2026-09-22")!, { tokenStatus: "ready", newTokens: 0, cacheRead: 0, totalTokens: 0 });
    Object.assign(history.find((day) => day.day === "2026-10-15")!, { tokenStatus: "ready", newTokens: 100, cacheRead: 20, totalTokens: 120 });
    const snapshot = withGithubUsageFixture({ ...structuredClone(sample), history });
    await renderRaw(snapshot);
    const select = host.querySelector<HTMLSelectElement>("select[aria-label='Trend range']")!;
    expect([...select.options].map((option) => option.value)).toEqual(["30", "60", "90", "6m"]);
    expect(select.value).toBe("30");
    expect(select.parentElement?.classList.contains("max-w-full")).toBe(true);
    const cards = [...host.querySelectorAll("section")].slice(0, 3).map((card) => card.textContent);
    const changeRange = async (value: string) => {
      await act(async () => { select.focus(); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
      expect(document.activeElement).toBe(select);
    };
    for (const range of ["60", "90"]) {
      await changeRange(range);
      for (const chart of host.querySelectorAll("[data-usage-trend]")) {
        expect(chart.getAttribute("data-usage-granularity")).toBe("day");
        expect(chart.querySelectorAll("[data-usage-day]")).toHaveLength(Number(range));
      }
      expect(host.querySelectorAll("[data-usage-daily] tbody tr")).toHaveLength(Number(range));
      const partial = host.querySelector<HTMLButtonElement>('[data-usage-trend="totalTokens"] [data-usage-day="2026-09-20"]')!;
      expect(partial.getAttribute("aria-label")).toContain("Partial coverage");
      await act(async () => partial.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      expect(host.querySelector('[data-usage-trend="totalTokens"] [role=tooltip]')?.textContent).toContain("Some sources or dates are incomplete");
      expect(host.querySelector('[data-usage-trend="totalTokens"] [data-usage-day="2026-09-21"]')?.getAttribute("aria-label")).toContain("Unavailable");
      const zero = host.querySelector('[data-usage-trend="totalTokens"] [data-usage-day="2026-09-22"]')!;
      expect(zero.getAttribute("aria-label")).toContain("Tokens 0");
      expect(zero.getAttribute("aria-label")).not.toContain("Partial coverage");
      const retained = host.querySelector('[data-usage-trend="totalTokens"] [data-usage-day="2026-10-15"]')!;
      expect(retained.getAttribute("aria-label")).toContain("Tokens 120");
      expect(retained.getAttribute("aria-label")).toContain("Partial coverage");
    }
    await changeRange("6m");
    expect(host.querySelector("[data-usage-trend-range]")?.textContent).toBe("2026-05-04 – 2026-11-03");
    for (const chart of host.querySelectorAll("[data-usage-trend]")) {
      expect(chart.getAttribute("data-usage-granularity")).toBe("week");
      expect(chart.querySelectorAll("[data-usage-day]")).toHaveLength(27);
    }
    expect(host.querySelectorAll("[data-usage-daily] tbody tr")).toHaveLength(184);
    const tokenChart = host.querySelector('[data-usage-trend="totalTokens"]')!;
    const bars = [...tokenChart.querySelectorAll<HTMLButtonElement>("[data-usage-day]")];
    await act(async () => bars[0]!.focus());
    expect(tokenChart.querySelector("[role=tooltip]")?.textContent).toContain("2026-05-04 – 2026-05-10");
    expect(tokenChart.querySelector("[role=tooltip]")?.textContent).toContain("Tokens: 770");
    await act(async () => bars[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(bars.at(-1));
    expect(tokenChart.querySelector("[role=tooltip]")?.textContent).toContain("2026-11-02 – 2026-11-03");
    await changeRange("30");
    expect(host.querySelectorAll('[data-usage-trend="prs"] [data-usage-day]')).toHaveLength(30);
    expect(host.querySelector('[data-usage-trend="prs"]')?.getAttribute("data-usage-granularity")).toBe("day");
    expect(host.querySelector('[data-usage-trend="totalTokens"] [data-usage-day="2026-10-15"]')?.getAttribute("aria-label")).toContain("Unavailable");
    expect([...host.querySelectorAll("section")].slice(0, 3).map((card) => card.textContent)).toEqual(cards);
    setLocale("zh");
    await renderRaw(snapshot);
    expect(select.getAttribute("aria-label")).toBe("趋势范围");
    expect(select.querySelector('option[value="6m"]')?.textContent).toBe("6 个月");
  });

  it("shows today-inclusive windows, partial PR references, daily values and missing gaps", async () => {
    await render(sample);
    expect(text()).toContain("1-day window");
    expect(text()).toContain("2026-11-03 – 2026-11-03");
    expect(text()).toContain("2026-10-28 – 2026-11-03");
    expect(text()).toContain("2026-10-05 – 2026-11-03");
    expect(host.querySelector("[data-usage-metric-definition]")?.textContent).toContain("Separate from GitHub Profile");
    expect([...host.querySelectorAll("[data-usage-provisional]")].some((value) => value.textContent === "9")).toBe(true);
    expect(text()).not.toContain("≥");
    expect(host.querySelector<HTMLDetailsElement>("[data-usage-daily]")?.open).toBe(false);
    expect(text()).toContain("4,000");
    const firstCard = host.querySelector<HTMLElement>("section")!;
    const visibleChanges = [...firstCard.querySelectorAll('[data-usage-change] > [aria-hidden="true"]')].map((value) => value.textContent);
    expect(visibleChanges.slice(0, 3)).toEqual(["+10%", "+50%", "+10%"]);
    const tokenChanges = [...host.querySelectorAll("section")].slice(0, 3)
      .map((card) => card.querySelectorAll('[data-usage-change] > [aria-hidden="true"]')[2]?.textContent);
    expect(tokenChanges).toEqual(["+10%", "New", "—"]);
    for (const change of host.querySelectorAll('[data-usage-change] > [aria-hidden="true"]')) {
      expect(change.textContent).not.toMatch(/[()]/);
    }
    const comparisons = [
      ["2026-11-02", "DoD: compared with the preceding 1-day period."],
      ["2026-10-21–2026-10-27", "WoW: compared with the preceding 7-day period."],
      ["2026-09-05–2026-10-04", "30d: compared with the preceding 30-day period."],
    ];
    for (const [index, [previous, period]] of comparisons.entries()) {
      const change = host.querySelectorAll("section")[index]!.querySelectorAll('[data-usage-change]')[2]!;
      expect(change.getAttribute("title")).toContain(`Compared with ${previous} (China time):`);
      expect(change.getAttribute("title")).toContain(period);
      expect(change.querySelector(".sr-only")?.textContent).toBe(change.getAttribute("title"));
    }
    expect(firstCard.querySelector('[data-usage-change]')?.getAttribute("title")).toContain("Compared with 2026-11-02 (China time): +10%.");
    expect(firstCard.querySelector('[data-usage-change] .sr-only')?.textContent).toContain("Compared with 2026-11-02");
    expect([...firstCard.querySelectorAll('[data-usage-change]')][1]?.getAttribute("title")).toContain("Observed non-merge Git commits across local branches");
    expect([...firstCard.querySelectorAll('[data-usage-change]')][2]?.getAttribute("title")).toContain("Based on synced devices; devices not yet synced are excluded.");
    expect(host.querySelector('section [data-usage-category-row="work"]')?.textContent).toContain("—");
    expect(host.querySelector('section [data-usage-category-row="personal"]')?.textContent).toContain("+10%");
    expect(firstCard.querySelector('[data-usage-category-row="work"] [data-usage-change]')?.getAttribute("title")).toContain("Not enough comparable data.");
    expect(firstCard.querySelector('div[aria-hidden="true"]')?.textContent).toBe("PRsCommits");
    expect(text()).not.toContain("Some sources or dates are incomplete");
    expect(text()).not.toContain("Missing dates:");
    const visibleSummary = host.cloneNode(true) as HTMLElement;
    visibleSummary.querySelectorAll(".sr-only").forEach((element) => element.remove());
    expect(visibleSummary.textContent).not.toContain("Dates without token records:");
    await act(async () => host.querySelectorAll("section")[2]!.querySelector<HTMLButtonElement>("[data-info-hint]")!.click());
    expect(infoText()).toContain("Missing dates: 1");
    expect(infoText()).toContain("Dates without token records: 2");
    await act(async () => globalThis.window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(text()).not.toContain("Across connected tools and repositories");
    expect(text()).not.toContain("Source coverage");
    expect(text()).not.toContain("Activity sources:");
    expect(text()).not.toContain("Tokens = noncached");
    expect(text()).not.toContain("shared appearances");
    expect(host.querySelector("section h3")?.parentElement?.textContent).toContain("2026-11-03 – 2026-11-03");
    expect(host.querySelectorAll("[data-usage-daily] table tbody tr")).toHaveLength(30);
    expect([...host.querySelectorAll('[data-usage-daily] tbody th[scope="row"]')].map((cell) => cell.textContent)).not.toContain("2026-10-04");
    expect(host.querySelectorAll('[data-usage-trend="prs"] [data-usage-day]')).toHaveLength(30);
    expect(host.querySelectorAll('.bg-warning\\/15').length).toBeGreaterThan(0);
    await showSummaryInfo();
    expect(infoText()).toContain("Some sources or dates are incomplete");
    expect(document.querySelector('[data-info-hint-content] time')?.getAttribute("datetime")).toBe("2026-11-03T08:30:00.000Z");
  });

  it("explains missing token history and localizes the comparison periods", async () => {
    const snapshot = structuredClone(sample);
    snapshot.windows!["30"].comparison.unavailableTokenDays = ["2026-09-11", "2026-09-12"];
    await render(snapshot);
    const tokenChange = () => host.querySelectorAll("section")[2]!.querySelectorAll('[data-usage-change]')[2]!;
    expect(tokenChange().getAttribute("title")).toContain("Token history is missing for 2 dates in the comparison period.");
    expect(tokenChange().querySelector(".sr-only")?.textContent).toContain("preceding 30-day period");
    setLocale("zh");
    await render(snapshot);
    const visibleLabels = [...host.querySelectorAll("section")].slice(0, 3)
      .map((card) => card.querySelectorAll('[data-usage-change] > [aria-hidden="true"]')[2]?.textContent);
    expect(visibleLabels).toEqual(["+10%", "新增", "—"]);
    for (const [index, period] of ["日环比", "周环比", "30 日环比"].entries()) {
      const change = host.querySelectorAll("section")[index]!.querySelectorAll('[data-usage-change]')[2]!;
      expect(change.getAttribute("title")).toContain(period);
      expect(change.querySelector(".sr-only")?.textContent).toBe(change.getAttribute("title"));
    }
    expect(tokenChange().getAttribute("title")).toContain("对比周期缺少 2 天的 Token 历史记录");
  });

  it.each([[-25, "-25%"], [0, "0%"]] as const)("preserves a %s change without visible wrappers or period prefixes", async (value, label) => {
    await act(async () => root.render(createElement("div", {}, ...(["prs", "commits", "totalTokens"] as const).map((metric) =>
      createElement(UsageChange, { key: metric, value, metric, startDay: "2026-11-02", endDay: "2026-11-02", periodDays: 1 })))));
    const changes = [...host.querySelectorAll('[data-usage-change]')];
    expect(changes.map((change) => change.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([label, label, label]);
    for (const change of changes) {
      expect(change.getAttribute("title")).toContain(`Compared with 2026-11-02 (China time): ${label}.`);
      expect(change.getAttribute("title")).toContain("DoD: compared with the preceding 1-day period.");
      expect(change.querySelector(".sr-only")?.textContent).toBe(change.getAttribute("title"));
    }
  });

  it("shows a visible PR tooltip on hover, focus and tap without treating synced zero as exact", async () => {
    await render({ ...sample, trend: [
      { ...trend[0]!, prs: null, knownPrs: 0, categories: { ...trend[0]!.categories, work: { prs: null, knownPrs: 0, commits: 1 } } },
      { ...trend[1]!, prs: null, knownPrs: 2, categories: { ...trend[1]!.categories, work: { prs: null, knownPrs: 2, commits: 1 } } },
      { ...trend[2]!, prs: 0, knownPrs: 0, categories: { work: { prs: 0, knownPrs: 0, commits: 1 }, personal: { prs: 0, knownPrs: 0, commits: 1 }, unclassified: { prs: 0, knownPrs: 0, commits: 0 } } },
      ...trend.slice(3),
    ] });
    const bars = [...host.querySelectorAll<HTMLButtonElement>('[data-usage-trend="prs"] [data-usage-day]')];
    expect(bars[0]!.getAttribute("aria-label")).toContain("0 · Reference");
    expect(bars[1]!.querySelector('[data-usage-category="work"]')?.className).toContain("bg-accent/35");
    expect(bars[2]!.getAttribute("aria-label")).toContain("PRs 0");
    expect(bars[2]!.getAttribute("aria-label")).not.toContain("Reference");
    await act(async () => bars[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toMatch(/2026-10-06.*PRs.*2.*Enterprise.*Observed count/s);
    await act(async () => bars[2]!.focus());
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toContain("2026-10-07");
    await act(async () => bars[0]!.click());
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toContain("2026-10-05");
    await act(async () => bars[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(bars[1]);
    await act(async () => bars[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')).toBeNull();
    expect(text()).not.toContain("Shaded columns: unavailable. Pale PR segments");
  });

  it("separates calendar weeks without weekend columns and preserves localized hover values", async () => {
    const marked = trend.map((day) => day.day === "2026-10-10" ? { ...day, commits: 1_000 }
      : day.day === "2026-10-11" ? { ...day, commits: 0 }
        : day.day === "2026-10-17" ? { ...trend[7]!, day: day.day } : day);
    await render({ ...sample, trend: marked });
    for (const metric of ["prs", "commits", "totalTokens"]) {
      const chart = host.querySelector<HTMLElement>(`[data-usage-trend="${metric}"]`)!;
      const boundaries = [...chart.querySelectorAll("[data-usage-week-start]")];
      expect(boundaries.map((line) => line.getAttribute("data-usage-week-start"))).toEqual([
        "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02",
      ]);
      expect(boundaries[0]?.parentElement?.getAttribute("aria-hidden")).toBe("true");
      expect(chart.querySelector("[data-usage-weekend], [data-usage-weekend-tick]")).toBeNull();
    }
    const chart = host.querySelector<HTMLElement>('[data-usage-trend="commits"]')!;
    const saturday = chart.querySelector<HTMLButtonElement>('[data-usage-day="2026-10-10"]')!;
    expect(saturday.querySelector<HTMLElement>("span[style]")?.style.height).toBe("100%");
    expect(Number.parseFloat(chart.querySelector<HTMLElement>('[data-usage-day="2026-10-11"] span[style]')?.style.height ?? "NaN")).toBe(0);
    expect(chart.querySelector('[data-usage-day="2026-10-17"] span[style]')).toBeNull();
    expect(saturday.getAttribute("aria-label")).toContain("2026-10-10 Sat");
    await act(async () => saturday.focus());
    expect(chart.querySelector('[role="tooltip"]')?.textContent).toContain("2026-10-10 · Sat");

    setLocale("zh");
    await render({ ...sample, trend: marked });
    expect(chart.querySelector('[data-usage-day="2026-10-11"]')?.getAttribute("aria-label")).toMatch(/2026-10-11 周[日天]/);
  });

  it("keeps the focused date and tooltip aligned as the trend window rolls", async () => {
    await render(sample);
    const chart = () => host.querySelector<HTMLElement>('[data-usage-trend="commits"]')!;
    const nov2 = chart().querySelector<HTMLButtonElement>('[data-usage-day="2026-11-02"]')!;
    await act(async () => nov2.focus());
    expect(chart().querySelector('[role="tooltip"]')?.textContent).toContain("2026-11-02");
    await render(rolled(1));
    expect(chart().querySelector('[data-usage-day="2026-11-02"]')).toBe(nov2);
    expect(document.activeElement).toBe(nov2);
    expect(nov2.tabIndex).toBe(0);
    expect(nov2.getAttribute("aria-describedby")).toBe(chart().querySelector('[role="tooltip"]')?.id);
    expect(chart().querySelector('[role="tooltip"]')?.textContent).toContain("2026-11-02");

    const oldest = chart().querySelector<HTMLButtonElement>('[data-usage-day="2026-10-06"]')!;
    await act(async () => oldest.focus());
    await render(rolled(2));
    expect(chart().querySelector('[data-usage-day="2026-10-06"]')).toBeNull();
    const fallback = chart().querySelector<HTMLButtonElement>('[data-usage-day="2026-10-07"]')!;
    expect(fallback.tabIndex).toBe(0);
    expect(document.activeElement).toBe(fallback);
    expect(fallback.getAttribute("aria-describedby")).toBe(chart().querySelector('[role="tooltip"]')?.id);
    expect(chart().querySelector('[role="tooltip"]')?.textContent).toContain("2026-10-07");
    await render(rolled(1));
    expect(chart().querySelector('[role="tooltip"]')?.textContent).toContain("2026-10-07");

    const external = document.createElement("input");
    document.body.append(external);
    try {
      await act(async () => chart().querySelector<HTMLButtonElement>('[data-usage-day="2026-10-06"]')!.focus());
      external.focus();
      await render(rolled(2));
      expect(document.activeElement).toBe(external);
      expect(chart().querySelector<HTMLButtonElement>('[data-usage-day="2026-10-07"]')?.tabIndex).toBe(0);
    } finally {
      external.remove();
    }
  });

  it("does not reclaim page focus after a chart bar is explicitly blurred", async () => {
    await render(rolled(1));
    const chart = () => host.querySelector<HTMLElement>('[data-usage-trend="commits"]')!;
    const oldest = chart().querySelector<HTMLButtonElement>('[data-usage-day="2026-10-06"]')!;
    await act(async () => oldest.focus());
    await act(async () => oldest.blur());
    expect(document.activeElement).toBe(document.body);
    await render(rolled(2));
    expect(document.activeElement).toBe(document.body);
    expect(chart().querySelector('[role="tooltip"]')).toBeNull();
    expect(chart().querySelector<HTMLButtonElement>('[data-usage-day="2026-10-07"]')?.tabIndex).toBe(0);
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
    await showSummaryInfo();
    expect(infoText()).toContain("Showing the last captured snapshot");
    expect(text()).toContain("2026-11-02 – 2026-11-02");
    expect(text()).toContain("2026-10-04 – 2026-11-02");
    expect(infoText()).toContain("23:50");
    expect(text()).not.toContain("today");
    expect(document.querySelector('[data-info-hint-content] time')?.getAttribute("datetime")).toBe("2026-11-02T15:50:00.000Z");
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
    await showSummaryInfo();
    expect(infoText()).toContain("00:05");
    expect(infoText()).not.toContain("24:05");
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
    calls.api.mockResolvedValueOnce(withGithubUsageFixture(sample)).mockRejectedValueOnce(new Error("offline"));
    await render(null, true);
    expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/usage", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1_000 - 1); });
    expect(calls.api).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.api).toHaveBeenCalledTimes(2);
    await showSummaryInfo();
    expect(infoText()).toContain("Showing the last captured snapshot");
    expect(text()).toContain("2026-10-05 – 2026-11-03");
  });

  it("keeps daily details collapsed initially and changes repository windows with keyboard tabs", async () => {
    await render(sample);
    const daily = host.querySelector<HTMLDetailsElement>("[data-usage-daily]")!;
    expect(daily.open).toBe(false);
    daily.open = true;
    expect(daily.querySelector("summary")?.textContent).not.toContain("WoW");
    expect([...daily.querySelectorAll('thead th[scope="col"]')].map((header) => header.textContent))
      .toEqual(["Date", "PRs", "Commits", "Tokens", "Change", "Repository activity"]);
    expect(daily.querySelector('[data-usage-change] > [aria-hidden="true"]')?.textContent).toMatch(/^(?:\+20%|New|—)$/);
    expect(daily.querySelector('p')?.textContent).not.toMatch(/DoD|WoW|MoM/);
    expect(daily.querySelector('[data-usage-change]')?.getAttribute("title")).toContain("Compared with 2026-10-27 (China time)");
    expect(daily.querySelector('[data-usage-change]')?.getAttribute("title")).toContain("Same calendar day last week.");
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    const values = () => [...host.querySelectorAll("[data-usage-repositories] tbody tr:first-child td")].map((cell) => cell.textContent);
    expect(values()[0]).toBe("Enterprise");
    expect(values()[1]).toMatch(/^1/);
    expect(values()[2]).toContain("2");
    const repositoryChanges = () => [...host.querySelectorAll('[data-usage-repositories] tbody tr:first-child [data-usage-change] > [aria-hidden="true"]')].map((value) => value.textContent);
    expect(repositoryChanges()).toEqual(["—", "+10%"]);
    expect(host.querySelector('[data-usage-repositories] [data-usage-change]')?.getAttribute("title")).toContain("Compared with 2026-11-02");
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tabs[3]);
    expect(tabs[3]!.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("Repository details are not available in this snapshot.");
    await act(async () => tabs[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(tabs[2]);
    expect(values()[1]).toMatch(/^30/);
    expect(values()[2]).toContain("60");
    expect(repositoryChanges()).toEqual(["—", "+30%"]);
    expect(host.querySelector('[data-usage-repositories] [data-usage-change]')?.getAttribute("title")).toContain("Compared with 2026-09-05–2026-10-04");
    await render({ ...sample, status: "stale" });
    expect(daily.open).toBe(true);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Personal");
  });

  it.each([401, 403])("clears old activity data on HTTP %i", async (status) => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(withGithubUsageFixture(sample)).mockRejectedValueOnce(new ApiError("forbidden", status));
    await render(null, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1_000); });
    expect(text()).toContain("Activity summary unavailable");
    expect(text()).not.toContain("2026-10-05 – 2026-11-03");
  });

  it("keeps all repository observations distinct from partial Profile counts through source and range changes", async () => {
    const snapshot = structuredClone(withGithubUsageFixture(sample));
    snapshot.github!.accounts = [{ id: "a".repeat(64), host: "work.ghe.com", apiStatus: "ready", startAt: asOf - 7 * 86400000,
      endAt: asOf, contributions: 0, commits: 0, rawPrs: 0, restricted: 0, outsideWindowPrs: 0 }];
    const work = snapshot.windows!["1"].repositories.rows[0]!;
    snapshot.windows!["1"].repositories.rows.push({ ...work, id: "personal-apps", name: "personal/private-apps", category: "personal", commits: 9 });
    await renderRaw(snapshot);
    expect(host.querySelector('[data-usage-repositories]')?.textContent).toContain("personal/private-apps");
    expect([...host.querySelectorAll("section dd")][1]?.firstElementChild?.textContent).toBe("2");
    expect(host.querySelector('[data-usage-metric-definition]')?.textContent).toContain("Repository activity");
    const references = () => host.querySelector('[data-usage-profile-reference]')!;
    expect(references().textContent).toContain("Total contributions 0 · Commit contributions 0");
    expect(references().textContent).toContain("API complete · coverage unknown");
    expect(references().textContent).toContain("not exact historical-instant totals");
    const source = host.querySelector<HTMLSelectElement>('select[aria-label="Activity source"]')!;
    const range = host.querySelector<HTMLSelectElement>('select[aria-label="Trend range"]')!;
    await act(async () => { range.value = "6m"; range.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { source.value = "profile"; source.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(range.value).toBe("6m");
    expect(host.querySelector('[data-usage-trend="commits"]')?.getAttribute("data-usage-granularity")).toBe("week");
    expect(host.querySelector('[data-usage-repositories]')?.textContent).not.toContain("personal/private-apps");
    expect(host.querySelector('[data-usage-metric-definition]')?.textContent).toContain("exact China-day counts are unknown");
    expect([...host.querySelectorAll("section dd")][1]?.querySelector('[data-usage-provisional]')?.textContent).toBe("2");
    expect(host.querySelector('section [data-usage-change] > [aria-hidden=true]')?.textContent).toBe("—");
    await act(async () => { source.value = "repositories"; source.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelector('[data-usage-repositories]')?.textContent).toContain("personal/private-apps");
    expect(range.value).toBe("6m");
    setLocale("zh");
    await renderRaw(snapshot);
    expect(host.querySelector('[data-usage-metric-definition]')?.textContent).toContain("与 GitHub Profile 贡献分开统计");
  });

  it("keeps remote-only activity through refresh failure and clears it when access is revoked", async () => {
    vi.useFakeTimers();
    const remoteOnly: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai", sourceCoverage: null,
      prSourceCoverage: null, prCoverage: null, windows: null, trend: [], github: withGithubUsageFixture(sample).github };
    calls.api.mockResolvedValueOnce(remoteOnly).mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiError("forbidden", 403));
    await renderRaw(null, true);
    expect(host.querySelectorAll("section dd")).toHaveLength(0);
    expect(host.querySelector('[data-usage-profile-reference]')?.textContent).toContain("2026-11-03");
    const source = host.querySelector<HTMLSelectElement>('select[aria-label="Activity source"]')!;
    await act(async () => { source.value = "profile"; source.dispatchEvent(new Event("change", { bubbles: true })); });
    expect([...host.querySelectorAll("section dd")][1]?.firstElementChild?.textContent).toBe("2");
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1_000); });
    await showSummaryInfo();
    expect(infoText()).toContain("Showing the last captured snapshot");
    expect([...host.querySelectorAll("section dd")][1]?.firstElementChild?.textContent).toBe("2");
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1_000); });
    expect(text()).toContain("Activity summary unavailable");
    expect(host.querySelectorAll("section dd")).toHaveLength(0);
  });
});


it("selects sixty-day repository detail with the trend and preserves source identities, unknown days and keyboard tabs", async () => {
  const snapshot = structuredClone(sample);
  const early = { ...trend[0]!, day: "2026-09-11", repositories: { ...snapshot.windows!["1"].repositories,
    rows: [{ ...snapshot.windows!["1"].repositories.rows[0]!, id: "old-personal", name: "fixture/retained-personal", category: "personal" as const, knownPrs: 3, commits: 11 }] } };
  snapshot.history = Array.from({ length: 60 }, (_, index) => ({ ...early, day: shiftDay("2026-11-09", index - 59) }));
  snapshot.windows = { "1": rolledWindow(snapshot.windows!["1"], 6), "7": rolledWindow(snapshot.windows!["7"], 6), "30": rolledWindow(snapshot.windows!["30"], 6) };
  snapshot.trend = snapshot.history.slice(-30);
  snapshot.sixtyDayRepositories = { startDay: "2026-09-11", endDay: "2026-11-09", repositories: early.repositories };
  const sources = withMergedUsageFixture(withGithubUsageFixture(snapshot));
  sources.github!.history = sources.github!.history!.slice(-7);
  sources.github!.trend = sources.github!.history!;
  for (const day of sources.merged!.history!) {
    day.repositories!.rows[0]!.name = "fixture/remote-pr-records";
    day.repositories!.rows[0]!.category = "work";
  }
  sources.merged!.sixtyDayRepositories!.repositories.rows[0]!.name = "fixture/remote-pr-records";
  sources.merged!.sixtyDayRepositories!.repositories.rows[0]!.category = "work";
  await renderRaw(sources);
  const range = host.querySelector<HTMLSelectElement>('select[aria-label="Trend range"]')!;
  await act(async () => { range.value = "60"; range.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('[data-usage-trend-range]')!.textContent).toBe("2026-09-11 – 2026-11-09");
  const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(value => value.textContent === "60d")!;
  expect(tab.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector('[data-usage-repositories]')!.textContent).toContain("fixture/retained-personal");
  expect(host.querySelectorAll('[data-usage-daily] tbody tr')).toHaveLength(60);
  const oldest = host.querySelector('[data-usage-daily] tbody tr:last-child [data-usage-day-repositories]')!;
  expect(oldest.textContent).toContain("fixture/retained-personal");
  expect(oldest.textContent).toContain("Personal");
  await act(async () => tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(host.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe("1d");
  const source = host.querySelector<HTMLSelectElement>('select[aria-label="Activity source"]')!;
  await act(async () => { source.value = "merged"; source.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('[data-usage-metric-definition]')!.textContent).toContain("Commits are those attached to these PRs");
  expect(host.querySelector('[data-usage-metric-definition]')!.textContent).toContain("dated by merge/completion in China time");
  expect(host.querySelector('section dt')!.getAttribute("title")).toBe("Your PRs merged remotely, counted on their merge date in China time.");
  expect(host.querySelectorAll('section dt')[1]!.getAttribute("title")).toContain("Original non-merge commits in your remotely merged PRs, counted on the PR merge date.");
  expect(host.querySelector('section [data-usage-change] .sr-only')!.textContent).toContain("counted on their merge date in China time.");
  expect(host.querySelector('[data-usage-repositories]')!.textContent).toContain("fixture/remote-pr-records");
  expect(host.querySelector('[data-usage-repositories]')!.textContent).not.toContain("fixture/retained-personal");
  await act(async () => { source.value = "profile"; source.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('[data-usage-daily] tbody tr:last-child')!.textContent).toContain("Repository details are not available in this snapshot.");
  setLocale("zh");
  await act(async () => { source.value = "merged"; source.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.querySelector('[data-usage-metric-definition]')!.textContent).toContain("PR 的关联提交");
  expect(host.querySelector('[data-usage-metric-definition]')!.textContent).toContain("按北京时间的合并／完成日期计数");
  expect(host.querySelector('section dt')!.getAttribute("title")).toBe("你创建且已在远端合并的 PR，按北京时间的合并日期计数。");
  expect(host.querySelectorAll('section dt')[1]!.getAttribute("title")).toContain("你已合并 PR 中的原始非 merge 提交，归到 PR 合并当天。");
  expect(host.querySelector('section [data-usage-change] .sr-only')!.textContent).toContain("按北京时间的合并日期计数。");
  expect(range.value).toBe("60");
});
