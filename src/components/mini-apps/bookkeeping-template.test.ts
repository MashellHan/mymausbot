import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");
type Row = Record<string, string | number | null>;
const record = (date: string, amount: string, category: string, note = "") => ({
  date, amount, category, currency: "CNY", account: "Demo card", book: "Sample book", note,
});
const currentRows = [
  record("2026-11-06", "-9007199254740980.78", "Other", "<img src=x onerror=alert(1)>"),
  record("2026-11-06", "-12.34", "Food"),
  record("2026-11-06", "+25.00", "Salary", "Synthetic inflow"),
];

function page(rows: Row[], nextCursor?: string) {
  return { columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows: rows.map((row) => Object.values(row)),
    revision: 7, ...(nextCursor ? { nextCursor } : {}) };
}

function fixture(fixtureOptions: { latestDate?: string; aliases?: boolean } = {}) {
  const view = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  let changed: (() => void) | null = null;
  let failSummary = false;
  let exhaustCalendarBudget = false;
  const query = vi.fn(async (id: string, parameters: Record<string, unknown>, options?: { cursor?: string; expectedDataRevision?: number }) => {
    if (failSummary && id === "summary") throw new Error("private query detail must not leak");
    const prior = String(parameters.from ?? "").startsWith("2026-10") || String(parameters.from ?? "").startsWith("2025-");
    const food = parameters.category === "Food";
    if (id === "coverage") return page([
      { currency: "CNY", count: "6", datedCount: "5", amountCount: "5", firstDate: "2023-01-01", lastDate: fixtureOptions.latestDate ?? "2026-11-06" },
      ...(fixtureOptions.aliases ? [
        { currency: "RMB", count: "1", datedCount: "1", amountCount: "1", firstDate: "2026-11-06", lastDate: "2026-11-06" },
        { currency: "人民币", count: "1", datedCount: "1", amountCount: "1", firstDate: "2026-11-06", lastDate: "2026-11-06" },
      ] : []),
      { currency: "USD", count: "1", datedCount: "1", amountCount: "1", firstDate: "2026-11-05", lastDate: "2026-11-05" },
      { currency: null, count: "1", datedCount: "1", amountCount: "1", firstDate: "2026-11-04", lastDate: "2026-11-04" },
    ]);
    if (exhaustCalendarBudget && (id === "categories" || id === "category_options")) {
      const index = options?.cursor ? Number(options.cursor.split("-").at(-1)) : 1;
      const row = id === "categories" ? { currency: "CNY", category: "Food", amount: "-12.34", count: "1" }
        : { currency: "CNY", category: "Food", count: "1" };
      return page([row], index < 20 ? `${id}-${index + 1}` : undefined);
    }
    if (fixtureOptions.aliases && id === "summary") return page([
      { currency: "CNY", net: "-100.00", count: "1" }, { currency: "RMB", net: "-20.00", count: "1" },
      { currency: "人民币", net: "30.00", count: "1" },
    ]);
    if (fixtureOptions.aliases && id === "outflow") return page([
      { currency: "CNY", amount: "-100.00", count: "1" }, { currency: "RMB", amount: "-20.00", count: "1" },
    ]);
    if (fixtureOptions.aliases && id === "inflow") return page([{ currency: "人民币", amount: "30.00", count: "1" }]);
    if (fixtureOptions.aliases && id === "categories") return page([
      { currency: "CNY", category: "Food", amount: "-100.00", count: "1" },
      { currency: "RMB", category: "Food", amount: "-20.00", count: "1" },
    ]);
    if (fixtureOptions.aliases && id === "category_options") return page([
      { currency: "CNY", category: "Food", count: "1" }, { currency: "RMB", category: "Food", count: "1" },
    ]);
    if (fixtureOptions.aliases && (id === "trend_month" || id === "trend_day")) return page([
      { currency: "CNY", bucket: id === "trend_month" ? "2026-11" : "2026-11-06", amount: "-100.00", count: "1" },
      { currency: "RMB", bucket: id === "trend_month" ? "2026-11" : "2026-11-06", amount: "-20.00", count: "1" },
    ]);
    if (fixtureOptions.aliases && (id === "trend_month_inflow" || id === "trend_day_inflow")) return page([
      { currency: "人民币", bucket: id === "trend_month_inflow" ? "2026-11" : "2026-11-06", amount: "30.00", count: "1" },
    ]);
    if (fixtureOptions.aliases && id === "largest_expenses") return page([
      { ...record("2026-11-06", "-100.00", "Food"), currency: "CNY" },
      { ...record("2026-11-06", "-20.00", "Food"), currency: "RMB" },
    ]);
    if (fixtureOptions.aliases && id === "details") return page([
      { ...record("2026-11-06", "-100.00", "Food"), currency: "CNY" },
      { ...record("2026-11-06", "-20.00", "Food"), currency: "RMB" },
    ]);
    if (id === "summary") return page([prior
      ? { currency: "CNY", net: "25.00", count: "1" }
      : food ? { currency: "CNY", net: "-12.34", count: "1" }
        : { currency: "CNY", net: "-9007199254740868.12", count: "4" }]);
    if (id === "outflow") return page([{ currency: "CNY", amount: prior ? "-5.00" : food ? "-12.34" : "-9007199254740993.12", count: "2" }]);
    if (id === "inflow") return page(food ? [] : [{ currency: "CNY", amount: prior ? "30.00" : "125.00", count: "2" }]);
    if (id === "categories") return page(food ? [{ currency: "CNY", category: "Food", amount: "-12.34", count: "1" }]
      : [{ currency: "CNY", category: "Other", amount: "-9007199254740980.78", count: "1" },
        { currency: "CNY", category: "Food", amount: "-12.34", count: "1" }]);
    if (id === "category_options") return page([
      { currency: "CNY", category: "Food", count: "1" }, { currency: "CNY", category: "Other", count: "1" },
      { currency: "CNY", category: "Salary", count: "1" },
    ]);
    if (id === "trend_month") return page([
      { currency: "CNY", bucket: "2026-10", amount: "-5.00", count: "1" },
      { currency: "CNY", bucket: "2026-11", amount: "-9007199254740993.12", count: "2" },
    ]);
    if (id === "trend_month_inflow") return page([
      { currency: "CNY", bucket: "2026-10", amount: "30.00", count: "1" },
      { currency: "CNY", bucket: "2026-11", amount: "125.00", count: "2" },
    ]);
    if (id === "trend_day") return page([{ currency: "CNY", bucket: "2026-11-06", amount: "-12.34", count: "1" }]);
    if (id === "trend_day_inflow") return page([{ currency: "CNY", bucket: "2026-11-06", amount: "25.00", count: "1" }]);
    if (id === "largest_expenses") return page(currentRows.filter((row) => String(row.amount).startsWith("-")));
    if (id === "details") return options?.cursor === "next" ? page([record("2026-11-05", "-1.00", "Food")])
      : page(parameters.from === parameters.through ? currentRows : food ? [currentRows[1]!] : currentRows, "next");
    throw new Error(`Unexpected query: ${id}`);
  });
  (view as unknown as { mausApp: unknown }).mausApp = { query, onDataChanged: (callback: () => void) => { changed = callback; } };
  view.document.write(html);
  return {
    view, query, changed: () => changed?.(), fail: () => { failSummary = true; },
    exhaustCalendarBudget: () => { exhaustCalendarBudget = true; },
    text: (id: string) => view.document.getElementById(id)?.textContent ?? "",
    select: (id: string, value: string) => {
      const control = view.document.getElementById(id) as unknown as HTMLSelectElement;
      control.value = value;
      control.dispatchEvent(new view.Event("change") as unknown as Event);
    },
    tab: (name: string) => (view.document.getElementById(`tab-${name}`) as unknown as HTMLButtonElement).click(),
  };
}

const opened: Window[] = [];
afterEach(async () => { for (const view of opened.splice(0)) await view.happyDOM.abort(); });

describe("Bookkeeping Manager Mini App", () => {
  it("keeps CNY totals exact, excludes foreign or unknown currency, and compares matched dates", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelector("h1")?.textContent).toBe("Bookkeeping Manager");
    expect(app.text("excluded-currencies")).toContain("2 other or unknown currency records excluded from CNY");
    expect(app.text("excluded-currencies")).toContain("USD · 1");
    expect(app.text("excluded-currencies")).toContain("Currency missing · 1");
    expect(app.text("coverage")).toContain("1 incomplete date excluded");
    expect(app.text("summary")).toContain("¥9,007,199,254,740,993.12");
    expect(app.text("summary")).toContain("Prior ¥5.00");
    expect(app.text("summary")).toContain("Recorded entries: 4");
    expect(app.text("range-label")).toContain("Prior 2026-10-01 to 2026-10-06");
    expect(app.text("range-label")).toContain("Recorded through 2026-11-06");
    expect(app.text("largest")).toContain("¥9,007,199,254,740,980.78");
    expect(app.text("categories")).toContain("Other");
    expect(app.text("trend")).toContain("¥125.00");
    expect(app.text("summary")).not.toContain("USD");
    expect(app.view.document.getElementById("currency")).toBeNull();
    expect(app.view.document.querySelector("#largest img")).toBeNull();
    expect(app.query).toHaveBeenCalledWith("largest_expenses", expect.objectContaining({ currencies: ["CNY"] }), { expectedDataRevision: 7 });
  });

  it("uses matched week and year queries, and opens an accessible calendar day", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.select("period", "week");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ from: "2026-11-02", through: "2026-11-06" }), { expectedDataRevision: 7 });
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ from: "2026-10-26", through: "2026-10-30" }), { expectedDataRevision: 7 });
    app.select("period", "year");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ from: "2026-01-01", through: "2026-11-06" }), { expectedDataRevision: 7 });
    app.tab("calendar");
    await app.view.happyDOM.whenAsyncComplete();
    const day = app.view.document.querySelector<HTMLButtonElement>('[data-calendar-day="2026-11-06"]');
    expect(day?.getAttribute("aria-label")).toContain("Outflow ¥12.34");
    day?.click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("details", { from: "2026-11-06", through: "2026-11-06", currencies: ["CNY"] }, { expectedDataRevision: 7 });
    expect(app.text("day-details")).toContain("Synthetic inflow");
    expect(app.view.document.querySelector('[data-calendar-day="2026-11-06"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("clamps the corresponding prior month and leap-day year without shifting calendar dates", async () => {
    const app = fixture({ latestDate: "2024-02-29" }); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ from: "2024-02-01", through: "2024-02-29" }), { expectedDataRevision: 7 });
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ from: "2024-01-01", through: "2024-01-29" }), { expectedDataRevision: 7 });
    app.select("period", "year");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ from: "2023-01-01", through: "2023-02-28" }), { expectedDataRevision: 7 });
  });

  it("shows ranked outflows and paged signed records with keyboard tabs", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("largest")).toContain("1. Other");
    app.tab("records");
    expect(app.view.document.getElementById("tab-records")?.getAttribute("aria-selected")).toBe("true");
    expect(app.text("details")).toContain("+¥25.00");
    (app.view.document.getElementById("more") as unknown as HTMLButtonElement).click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("details", expect.objectContaining({ currencies: ["CNY"] }), { cursor: "next", expectedDataRevision: 7 });
    expect(app.text("details")).toContain("2026-11-05");
    const food = [...app.view.document.querySelectorAll<HTMLButtonElement>("#categories button")].find((button) => button.textContent?.includes("Food"));
    food?.click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.getElementById("tab-records")?.getAttribute("aria-selected")).toBe("true");
    expect(app.query).toHaveBeenCalledWith("details", expect.objectContaining({ category: "Food", currencies: ["CNY"] }), { expectedDataRevision: 7 });
  });

  it("localizes the page and retains the last view on a failed data notification", async () => {
    const app = fixture(); opened.push(app.view);
    app.view.document.documentElement.lang = "zh-CN";
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelector("h1")?.textContent).toBe("记账管家");
    expect(app.view.document.getElementById("tab-calendar")?.textContent).toBe("日历");
    expect(app.text("summary")).toContain("¥9,007,199,254,740,993.12");
    app.fail(); app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("summary")).toContain("¥9,007,199,254,740,993.12");
    expect(app.text("notice")).toContain("无法刷新记录");
    expect(app.text("notice")).not.toContain("private query detail");
  });

  it("combines explicit CNY aliases in exact category and date buckets and retains category on day reads", async () => {
    const app = fixture({ aliases: true }); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ currencies: ["CNY", "RMB", "人民币"] }), { expectedDataRevision: 7 });
    expect(app.text("summary")).toContain("¥120.00");
    expect(app.text("summary")).toContain("¥30.00");
    expect(app.view.document.querySelectorAll("#categories li")).toHaveLength(1);
    expect(app.text("categories")).toContain("¥120.00");
    expect(app.text("trend")).toContain("¥120.00");
    app.select("category", "Food");
    await app.view.happyDOM.whenAsyncComplete();
    app.tab("calendar");
    await app.view.happyDOM.whenAsyncComplete();
    const day = app.view.document.querySelector<HTMLButtonElement>('[data-calendar-day="2026-11-06"]');
    expect(day?.getAttribute("aria-label")).toContain("Outflow ¥120.00");
    day?.click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("details", { from: "2026-11-06", through: "2026-11-06", currencies: ["CNY", "RMB", "人民币"], category: "Food" }, { expectedDataRevision: 7 });
    expect(app.text("day-details")).toContain("¥100.00");
    expect(app.text("day-details")).toContain("¥20.00");
  });

  it("marks calendar dates unavailable when earlier complete pages exhaust the shared read cap", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.exhaustCalendarBudget();
    const before = app.query.mock.calls.length;
    app.tab("calendar");
    await app.view.happyDOM.whenAsyncComplete();
    const calls = app.query.mock.calls.slice(before);
    const budgeted = new Set(["summary", "outflow", "inflow", "categories", "category_options", "trend_month", "trend_month_inflow", "trend_day", "trend_day_inflow"]);
    expect(calls.filter(([id]) => budgeted.has(id))).toHaveLength(48);
    expect(calls.filter(([id]) => id === "categories")).toHaveLength(20);
    expect(calls.filter(([id]) => id === "category_options")).toHaveLength(20);
    expect(calls.some(([id]) => id === "trend_day" || id === "trend_day_inflow")).toBe(false);
    expect(app.view.document.querySelectorAll("#calendar .calendar-day")).toHaveLength(0);
    expect(app.text("calendar")).toContain("Daily totals incomplete. Narrow the date range and refresh.");
    expect(app.text("notice")).toContain("This view is incomplete");
    expect(app.text("calendar")).not.toContain("No recorded outflow");
  });

  it("rejects an invalid custom range without querying a fabricated zero", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.select("period", "custom");
    const from = app.view.document.getElementById("from") as unknown as HTMLInputElement;
    const through = app.view.document.getElementById("through") as unknown as HTMLInputElement;
    from.value = "2026-12-01"; through.value = "2026-11-01";
    from.dispatchEvent(new app.view.Event("change") as unknown as Event);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("notice")).toContain("Choose a valid From and Through date");
    expect(app.text("summary")).not.toContain("¥0.00");
  });
});
