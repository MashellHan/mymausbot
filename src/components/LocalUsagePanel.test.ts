// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../../shared/local-dashboard";
import type { LocalContributionsResponse } from "../../shared/local-contributions";
import { UsageChange } from "./LocalUsageValues";
import { setLocale } from "@/lib/i18n";
import { withGithubUsageFixture, withMergedUsageFixture } from "../../scripts/testing/merged-usage-fixture";
import { primaryUsageFixture } from "../../scripts/testing/primary-usage-fixture";

const calls = vi.hoisted(() => ({ api: vi.fn(), visible: true }));
vi.mock("@/state/store", () => ({
  api: calls.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => calls.visible }));

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

const withPrimaryFixture = (snapshot: LocalUsageResponse): LocalUsageResponse => {
  if (snapshot.contributions) return snapshot;
  const remote = withMergedUsageFixture(snapshot).merged!;
  const contributions: LocalContributionsResponse = { ...remote, timeZone: "Asia/Shanghai", metricDefinition: "contributions-v2",
    dateBasis: { github: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" },
      ado: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" }, tokens: "Asia/Shanghai" },
    cutoffAt: snapshot.asOf, capturedAt: snapshot.asOf, currentDayPartial: true, accounts: [], sourceDays: null };
  return { ...snapshot, contributions };
};

let host: HTMLDivElement;
let root: Root;
const renderRaw = async (snapshot: LocalUsageResponse | null, panel = false) => {
  await act(async () => root.render(panel ? createElement(LocalUsagePanel) : createElement(LocalUsageView, { snapshot: snapshot && withPrimaryFixture(snapshot) })));
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
  calls.visible = true;
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
      expect(host.querySelector('[data-usage-trend="totalTokens"] [role=tooltip]')?.textContent).not.toContain("Some sources or dates are incomplete");
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
    expect(host.querySelector("[data-usage-metric-definition]")?.textContent).toContain("Beijing time (UTC+8)");
    expect([...host.querySelectorAll("[data-usage-provisional]")].some((value) => value.textContent === "9")).toBe(true);
    expect(host.querySelector<HTMLDetailsElement>("[data-usage-daily]")?.open).toBe(false);
    expect(text()).toContain("4,000");
    const firstCard = host.querySelector<HTMLElement>("section")!;
    const visibleChanges = [...firstCard.querySelectorAll('[data-usage-change] > [aria-hidden="true"]')].map((value) => value.textContent);
    expect(visibleChanges.slice(0, 3)).toEqual(["DoD +10%", "DoD +50%", "DoD +10%"]);
    const tokenChanges = [...host.querySelectorAll("section")].slice(0, 3)
      .map((card) => card.querySelectorAll('[data-usage-change] > [aria-hidden="true"]')[2]?.textContent);
    expect(tokenChanges).toEqual(["DoD +10%", "WoW New", "30d —"]);
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
    expect(firstCard.querySelector('[data-usage-change]')?.getAttribute("title")).toContain("Compared with Beijing dates 2026-11-02: +10%.");
    expect(firstCard.querySelector('[data-usage-change] .sr-only')?.textContent).toContain("Compared with Beijing dates 2026-11-02");
    expect([...firstCard.querySelectorAll('[data-usage-change]')][1]?.getAttribute("title")).toContain("author time in Beijing (UTC+8), including merge commits");
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
    expect(visibleLabels).toEqual(["日环比 +10%", "周环比 新增", "30 日环比 —"]);
    for (const [index, period] of ["日环比", "周环比", "30 日环比"].entries()) {
      const change = host.querySelectorAll("section")[index]!.querySelectorAll('[data-usage-change]')[2]!;
      expect(change.getAttribute("title")).toContain(period);
      expect(change.querySelector(".sr-only")?.textContent).toBe(change.getAttribute("title"));
    }
    expect(tokenChange().getAttribute("title")).toContain("对比周期缺少 2 天的 Token 历史记录");
  });

  it.each([[-25, "-25%"], [0, "0%"]] as const)("shows the period beside a %s change", async (value, label) => {
    await act(async () => root.render(createElement("div", {}, ...(["prs", "commits", "totalTokens"] as const).map((metric) =>
      createElement(UsageChange, { key: metric, value, metric, startDay: "2026-11-02", endDay: "2026-11-02", periodDays: 1 })))));
    const changes = [...host.querySelectorAll('[data-usage-change]')];
    expect(changes.map((change) => change.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([`DoD ${label}`, `DoD ${label}`, `DoD ${label}`]);
    for (const [index, change] of changes.entries()) {
      expect(change.getAttribute("title")).toContain(index === 2
        ? `Compared with 2026-11-02 (China time): ${label}.`
        : `Compared with Beijing dates 2026-11-02: ${label}.`);
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
    expect(bars[0]!.getAttribute("aria-label")).toContain("0 · Known subtotal");
    expect(bars[1]!.querySelector('[data-usage-category="work"]')?.className).toContain("bg-accent/35");
    expect(bars[2]!.getAttribute("aria-label")).toContain("PRs 0");
    expect(bars[2]!.getAttribute("aria-label")).not.toContain("Known subtotal");
    await act(async () => bars[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    const tooltip = host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')!;
    expect(tooltip.textContent).toMatch(/2026-10-06.*PRs: 2.*Enterprise: 2.*Personal:/s);
    expect(tooltip.textContent).not.toMatch(/Verified subtotal|incomplete/);
    expect(tooltip.querySelector("p, [title], [aria-description]")).toBeNull();
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

  it("restores known PR and commit period changes while keeping exact totals unknown", async () => {
    const contributions = primaryUsageFixture("2026-11-03", true, "2026-11-02T16:05:00Z",
      { github: { prs: 1, commits: 2 }, ado: { prs: 2, commits: 3 } });
    expect(contributions.asOf).toBe(Date.parse("2026-11-02T16:05:00Z"));
    expect(contributions.windows!["1"].startDay).toBe("2026-11-03");
    expect([contributions.windows!["1"].knownPrs, contributions.windows!["1"].knownCommits]).toEqual([3, 5]);
    expect(contributions.currentDayPartial).toBe(true);
    await renderRaw({ ...sample, contributions });
    for (const [index, period] of ["DoD", "WoW", "30d"].entries()) {
      const changes = [...host.querySelectorAll("section")][index]!.querySelectorAll("dl > div > dd > [data-usage-change]");
      for (const change of [...changes].slice(0, 2)) {
        expect(change.querySelector('[aria-hidden="true"]')?.textContent).toBe(`${period} New`);
        expect(change.getAttribute("title")).toContain(period);
        expect(change.getAttribute("title")).toContain("Known subtotal");
        expect(change.getAttribute("data-usage-provisional")).toBe("true");
      }
    }
    expect(contributions.windows!["1"].prs).toBeNull();
    expect(contributions.windows!["1"].comparison.prs).toBeNull();
  });

  it("labels known repository comparisons with the same period and keeps unavailable values blank", async () => {
    const contributions = primaryUsageFixture("2026-11-03", true);
    const repository = contributions.windows!["1"].repositories.rows[0]!;
    repository.comparison = { prs: null, commits: null };
    repository.knownComparison = { prs: 27.3, commits: -7.4 };
    const displayedChanges = () => {
      const row = [...host.querySelectorAll('[data-usage-repositories] tbody tr')].find((item) =>
        item.querySelector('th')?.textContent === repository.name)!;
      return [...row.querySelectorAll<HTMLElement>('[data-usage-change]')];
    };
    await renderRaw({ ...sample, contributions });
    expect(displayedChanges().map((change) => change.querySelector('[aria-hidden="true"]')?.textContent))
      .toEqual(["DoD +27.3%", "DoD -7.4%"]);
    for (const change of displayedChanges()) {
      expect(change.getAttribute("title")).toContain("Known subtotal");
      expect(change.getAttribute("data-usage-provisional")).toBe("true");
    }
    repository.knownComparison.commits = null;
    await renderRaw({ ...sample, contributions });
    expect(displayedChanges()[1]?.querySelector('[aria-hidden="true"]')?.textContent).toBe("DoD —");
  });

  it("shows qualified work and personal category DoD/WoW/MoM with exact-null honesty in both locales", async () => {
    const contributions = primaryUsageFixture("2026-11-03", true);
    await renderRaw({ ...sample, contributions });
    for (const [index, period] of ["DoD", "WoW", "30d"].entries()) {
      const card = host.querySelectorAll("section")[index]!;
      const personal = card.querySelector('[data-usage-category-row="personal"]')!;
      const changes = personal.querySelectorAll('[data-usage-change]');
      expect(changes).toHaveLength(2);
      for (const change of changes) {
        expect(change.querySelector('[aria-hidden="true"]')?.textContent).toBe(`${period} New`);
        expect(change.getAttribute("title")).toContain(period);
        expect(change.getAttribute("title")).toContain("Known subtotal");
        expect(change.getAttribute("data-usage-provisional")).toBe("true");
      }
      expect(card.querySelector('[data-usage-category-row="work"] [data-usage-change]')?.getAttribute("title")).toContain(period);
    }
    contributions.windows!["1"].comparison.knownCategories!.personal.prs = null;
    await renderRaw({ ...sample, contributions });
    expect(host.querySelector('section [data-usage-category-row="personal"] [data-usage-change] [aria-hidden="true"]')?.textContent).toBe("DoD —");
    setLocale("zh");
    await renderRaw({ ...sample, contributions: primaryUsageFixture("2026-11-03", true) });
    for (const [index, period] of ["日环比", "周环比", "30 日环比"].entries()) {
      const change = host.querySelectorAll("section")[index]!.querySelector('[data-usage-category-row="personal"] [data-usage-change]')!;
      expect(change.querySelector('[aria-hidden="true"]')?.textContent).toBe(`${period} 新增`);
      expect(change.getAttribute("title")).toContain(period);
    }
  });

  it("shows a dash for missing hover values and numeric zero for observed zero", async () => {
    const contributions = primaryUsageFixture();
    const missing = contributions.trend[0]!;
    missing.coverage = "unavailable";
    await renderRaw({ ...sample, contributions });
    const bars = [...host.querySelectorAll<HTMLButtonElement>('[data-usage-trend="prs"] [data-usage-day]')];
    await act(async () => bars[0]!.focus());
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toMatch(/PRs: —.*Enterprise: —.*Personal: —/s);
    await act(async () => bars[1]!.focus());
    expect(host.querySelector('[data-usage-trend="prs"] [role="tooltip"]')?.textContent).toMatch(/PRs: 0.*Enterprise: 0.*Personal: 0/s);
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

  it("refreshes the local summary every five seconds and keeps the last good response on failure", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(withPrimaryFixture(withGithubUsageFixture(sample))).mockRejectedValueOnce(new Error("offline"));
    await render(null, true);
    expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/usage", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(calls.api).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.api).toHaveBeenCalledTimes(2);
    await showSummaryInfo();
    expect(infoText()).toContain("Showing the last captured snapshot");
    expect(text()).toContain("2026-10-05 – 2026-11-03");
  });

  it("shows new primary contributions with older tokens and reads immediately on visibility return", async () => {
    vi.useFakeTimers();
    const local = withGithubUsageFixture(sample);
    const first = { ...local, contributions: primaryUsageFixture("2026-11-03") };
    const next = { ...local, contributions: primaryUsageFixture("2026-11-03", false, "2026-11-03T08:31:00Z",
      { github: { prs: 4, commits: 6 }, ado: { prs: 2, commits: 5 } }) };
    calls.api.mockResolvedValueOnce(first).mockResolvedValue(next);
    const values = () => [...host.querySelectorAll("section dd > span:first-child")].slice(0, 3).map((value) => value.textContent);
    await renderRaw(null, true);
    expect(values()).toEqual(["5", "9", "150"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(calls.api).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(values()).toEqual(["6", "11", "150"]);
    calls.visible = false;
    await renderRaw(null, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(calls.api).toHaveBeenCalledTimes(2);
    calls.visible = true;
    await renderRaw(null, true);
    expect(calls.api).toHaveBeenCalledTimes(3);
    expect(calls.api.mock.calls.every(([path]) => path === "/api/local-dashboard/usage")).toBe(true);
  });

  it("keeps daily details collapsed initially and changes repository windows with keyboard tabs", async () => {
    await render(sample);
    const daily = host.querySelector<HTMLDetailsElement>("[data-usage-daily]")!;
    expect(daily.open).toBe(false);
    daily.open = true;
    expect(daily.querySelector("summary")?.textContent).not.toContain("WoW");
    expect([...daily.querySelectorAll('thead th[scope="col"]')].map((header) => header.textContent))
      .toEqual(["Date", "PRs", "Commits", "Tokens", "Change", "Repository contributions"]);
    expect(daily.querySelector('[data-usage-change] > [aria-hidden="true"]')?.textContent).toMatch(/^(?:\+20%|New|—)$/);
    expect(daily.querySelector('p')?.textContent).not.toMatch(/DoD|WoW|MoM/);
    expect(daily.querySelector('[data-usage-change]')?.getAttribute("title")).toContain("Compared with Beijing dates 2026-10-27");
    expect(daily.querySelector('[data-usage-change]')?.getAttribute("title")).toContain("Same calendar day last week.");
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"] [role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false"]);
    const values = () => [...host.querySelectorAll("[data-usage-repositories] tbody tr:first-child td")].map((cell) => cell.textContent);
    expect(values()[0]).toBe("Enterprise");
    expect(values()[1]).toMatch(/^1/);
    expect(values()[2]).toContain("2");
    const repositoryChanges = () => [...host.querySelectorAll('[data-usage-repositories] tbody tr:first-child [data-usage-change] > [aria-hidden="true"]')].map((value) => value.textContent);
    expect(repositoryChanges()).toEqual(["DoD —", "DoD +10%"]);
    expect(host.querySelector('[data-usage-repositories] [data-usage-change]')?.getAttribute("title")).toContain("Compared with Beijing dates 2026-11-02");
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tabs[3]);
    expect(tabs[3]!.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector('[role="tabpanel"]')?.textContent).toContain("Repository details are not available in this snapshot.");
    await act(async () => tabs[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(tabs[2]);
    expect(values()[1]).toMatch(/^30/);
    expect(values()[2]).toContain("60");
    expect(repositoryChanges()).toEqual(["30d —", "30d +30%"]);
    expect(host.querySelector('[data-usage-repositories] [data-usage-change]')?.getAttribute("title")).toContain("Compared with Beijing dates 2026-09-05–2026-10-04");
    await render({ ...sample, status: "stale" });
    expect(daily.open).toBe(true);
    expect(tabs[2]!.getAttribute("aria-selected")).toBe("true");
    expect(text()).toContain("Personal");
  });

  it.each([401, 403])("clears old activity data on HTTP %i", async (status) => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(withGithubUsageFixture(sample)).mockRejectedValueOnce(new ApiError("forbidden", status));
    await render(null, true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toContain("Activity summary unavailable");
    expect(text()).not.toContain("2026-10-05 – 2026-11-03");
  });

  it("never admits large legacy observations into missing primary cards, trends or repository totals", async () => {
    const legacy = structuredClone(withGithubUsageFixture(sample));
    for (const window of Object.values(legacy.windows!)) {
      window.prs = 900_000; window.knownPrs = 900_000; window.commits = 900_000;
      window.repositories.rows.push({ ...window.repositories.rows[0]!, id: "legacy-only", name: "legacy/large-count", prs: 900_000, commits: 900_000 });
    }
    await act(async () => root.render(createElement(LocalUsageView, { snapshot: legacy })));
    expect(text()).toContain("Contribution sources are unavailable");
    expect([...host.querySelectorAll("section dd")].slice(0, 3).map((value) => value.firstElementChild?.textContent))
      .toEqual(["Unavailable", "Unavailable", "150"]);
    expect(host.querySelectorAll('[data-usage-trend="prs"] [data-usage-day]')).toHaveLength(30);
    expect(host.querySelector('[data-usage-trend="prs"] [data-usage-day]')?.getAttribute("aria-label")).toContain("Unavailable");
    expect(host.querySelector('[data-usage-repositories]')).toBeNull();
    expect(text()).not.toContain("900,000");
    expect(text()).not.toContain("legacy/large-count");
    expect(host.querySelector('select[aria-label="Activity source"]')).toBeNull();
  });

  it("clears the primary view when a successful refresh omits the versioned snapshot", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(withPrimaryFixture(sample)).mockResolvedValueOnce(sample);
    await renderRaw(null, true);
    expect([...host.querySelectorAll("section dd")][0]?.firstElementChild?.textContent).toBe("1");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toContain("Contribution sources are unavailable");
    expect([...host.querySelectorAll("section dd")][0]?.firstElementChild?.textContent).toBe("Unavailable");
    expect([...host.querySelectorAll("section dd")][2]?.firstElementChild?.textContent).toBe("150");
  });

  it("keeps primary unknown through legacy-only refresh failure and clears on revoked access", async () => {
    vi.useFakeTimers();
    const legacyOnly: LocalUsageResponse = { ...sample, github: withGithubUsageFixture(sample).github };
    calls.api.mockResolvedValueOnce(legacyOnly).mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new ApiError("forbidden", 403));
    await renderRaw(null, true);
    expect(text()).toContain("Contribution sources are unavailable");
    expect([...host.querySelectorAll("section dd")][0]?.firstElementChild?.textContent).toBe("Unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toContain("Contribution sources are unavailable");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toContain("Activity summary unavailable");
    expect(host.querySelectorAll("section dd")).toHaveLength(0);
  });

  it("shows source-qualified contributions and per-account details on the main surface", async () => {
    await renderRaw({ ...sample, contributions: primaryUsageFixture() });
    expect(host.querySelector('select[aria-label="Activity source"]')).toBeNull();
    const definition = host.querySelector('[data-usage-metric-definition]')?.textContent;
    expect(definition).toContain("Beijing time (UTC+8)");
    expect(definition).toContain("00:00–24:00");
    expect(definition).toContain("including merge commits");
    expect([...host.querySelectorAll("section dd")][0]?.firstElementChild?.textContent).toBe("5");
    expect([...host.querySelectorAll("section dd")][1]?.firstElementChild?.textContent).toBe("9");
    expect(host.querySelector('[data-usage-repositories]')?.textContent).toContain("fixture/github-repo");
    expect(host.querySelector('[data-usage-repositories]')?.textContent).toContain("fixture/ado-repo");
    const detail = host.querySelector<HTMLDetailsElement>('[data-usage-primary-sources]')!;
    await act(async () => { detail.open = true; detail.dispatchEvent(new Event("toggle", { bubbles: true })); });
    expect(detail.textContent).toContain("fixture-gh");
    expect(detail.textContent).toContain("fixture-ado");
    expect(detail.textContent).toContain("fixture-org/fixture-project");
    expect([...host.querySelectorAll("section dd")][0]?.firstElementChild?.textContent).toBe("5");
  });

  it("keeps contribution comparisons on Beijing dates and Token comparisons on China dates", async () => {
    await render(sample);
    const descriptions = () => [...host.querySelectorAll<HTMLElement>("section:first-of-type [data-usage-change]")]
      .slice(0, 3).map((value) => value.getAttribute("title") ?? "");
    expect(descriptions()[0]).toContain("Compared with Beijing dates");
    expect(descriptions()[1]).toContain("Compared with Beijing dates");
    expect(descriptions()[2]).toContain("China time");
    setLocale("zh");
    await render(sample);
    expect(host.querySelector('[data-usage-metric-definition]')?.textContent).toContain("每日 00:00–24:00");
    expect(host.querySelector('[data-usage-metric-definition]')?.textContent).toContain("包括合并提交");
    expect(descriptions()[0]).toContain("与北京时间日期");
    expect(descriptions()[1]).toContain("与北京时间日期");
    expect(descriptions()[2]).toContain("北京时间");
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
  expect(host.querySelector('select[aria-label="Activity source"]')).toBeNull();
  expect(range.value).toBe("60");
});
