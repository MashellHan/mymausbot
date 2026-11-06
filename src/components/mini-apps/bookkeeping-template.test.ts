import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");
type Row = Record<string, string | number | null>;
const record = (date: string, amount: string, category: string, note: string): Row => ({
  date, amount, category, currency: "人民币", account: "Sample card", book: "Sample ledger", note,
});
const current = [
  record("2026-11-06", "-100.00", "Food", "Synthetic groceries"),
  record("2026-11-06", "+30.00", "Income", "Synthetic inflow"),
  record("2026-11-05", "-56.40", "Household", "Synthetic supplies"),
];
const october = [record("2026-10-12", "-20.00", "Travel", "Synthetic rail")];
const historical = [record("2024-11-07", "-8.00", "Food", "Synthetic early entry")];

function page(rows: Row[], nextCursor?: string) {
  return { columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows: rows.map((row) => Object.values(row)),
    revision: 7, ...(nextCursor ? { nextCursor } : {}) };
}

function fixture() {
  const view = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  let changed: (() => void) | null = null;
  let failDaily = false;
  let exhaustDaily = false;
  const query = vi.fn(async (id: string, params: Record<string, unknown>, options?: { cursor?: string; expectedDataRevision?: number }) => {
    const from = String(params.from ?? "");
    const to = String(params.through ?? "");
    const prior = from.startsWith("2026-10") || from.startsWith("2025-");
    if (failDaily && id === "trend_day") throw new Error("private query detail");
    if (id === "coverage") return page([
      { currency: "人民币", count: "1135", datedCount: "1135", amountCount: "1135", firstDate: "2024-11-07", lastDate: "2026-11-06" },
      { currency: "", count: "6", datedCount: "4", amountCount: "6", firstDate: "2025-03-01", lastDate: "2026-10-01" },
      { currency: "美元", count: "1", datedCount: "0", amountCount: "1", firstDate: null, lastDate: null },
    ]);
    if (id === "summary") return page([{ currency: "人民币", net: prior ? "-80.00" : "-126.40", count: prior ? "2" : "3" }]);
    if (id === "outflow") return page([{ currency: "人民币", amount: prior ? "-80.00" : "-156.40", count: "2" }]);
    if (id === "inflow") return page(prior ? [] : [{ currency: "人民币", amount: "30.00", count: "1" }]);
    if (id === "categories") return page([
      { currency: "人民币", category: "Food", amount: "-100.00", count: "1" },
      { currency: "人民币", category: "Household", amount: "-56.40", count: "1" },
    ]);
    if (id === "trend_month") return page([
      { currency: "人民币", bucket: "2026-01", amount: "-10.00", count: "1" },
      { currency: "人民币", bucket: "2026-10", amount: "-80.00", count: "1" },
      { currency: "人民币", bucket: "2026-11", amount: "-156.40", count: "2" },
    ]);
    if (id === "trend_month_inflow") return page([{ currency: "人民币", bucket: "2026-11", amount: "30.00", count: "1" }]);
    if (id === "trend_day" || id === "trend_day_inflow") {
      if (exhaustDaily && id === "trend_day") {
        const index = options?.cursor ? Number(options.cursor.split("-").at(-1)) : 1;
        return page([{ currency: "人民币", bucket: "2026-11-06", amount: "-100.00", count: "1" }], `day-${index + 1}`);
      }
      if (from.startsWith("2024-11")) return page(id === "trend_day" ? [{ currency: "人民币", bucket: "2024-11-07", amount: "-8.00", count: "1" }] : []);
      if (from.startsWith("2026-10")) return page(id === "trend_day" ? [{ currency: "人民币", bucket: "2026-10-12", amount: "-20.00", count: "1" }] : []);
      return page(id === "trend_day"
        ? [{ currency: "人民币", bucket: "2026-11-05", amount: "-56.40", count: "1" },
          { currency: "人民币", bucket: "2026-11-06", amount: "-100.00", count: "1" }]
        : [{ currency: "人民币", bucket: "2026-11-06", amount: "30.00", count: "1" }]);
    }
    if (id === "largest_expenses") return page([current[0]!, current[2]!]);
    if (id === "details") {
      if (options?.cursor) return page([record("2026-11-04", "-2.00", "Food", "Synthetic extra")]);
      const rows = from.startsWith("2024-11") ? historical : from.startsWith("2026-10") ? october : current;
      const dated = from === to ? rows.filter((row) => row.date === from) : rows;
      const filtered = params.category ? dated.filter((row) => row.category === params.category) : dated;
      return page(filtered, from !== to && from.startsWith("2026-11") ? "next" : undefined);
    }
    throw new Error(`Unexpected query: ${id}`);
  });
  (view as unknown as { mausApp: unknown }).mausApp = { query, onDataChanged: (callback: () => void) => { changed = callback; } };
  view.document.write(html);
  return {
    view, query, changed: () => changed?.(), failDaily: (value: boolean) => { failDaily = value; },
    exhaustDaily: () => { exhaustDaily = true; },
    text: (id: string) => view.document.getElementById(id)?.textContent ?? "",
    click: (id: string) => (view.document.getElementById(id) as unknown as HTMLButtonElement).click(),
    choose: (id: string, value: string) => {
      const control = view.document.getElementById(id) as unknown as HTMLInputElement;
      control.value = value;
      control.dispatchEvent(new view.Event("change") as unknown as Event);
    },
  };
}

const opened: Window[] = [];
afterEach(async () => { for (const view of opened.splice(0)) await view.happyDOM.abort(); });

describe("Bookkeeping Manager local ledger views", () => {
  it("opens dated Details at the latest actual record and keeps currency/date defects separate", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelector("h1")?.textContent).toBe("Bookkeeping Manager");
    expect(app.view.document.getElementById("tab-records")?.getAttribute("aria-selected")).toBe("true");
    expect(app.text("records-title")).toContain("November 2026");
    expect(app.text("coverage")).toContain("2024-11-07 to 2026-11-06");
    expect(app.text("coverage")).toContain("Missing dates across all records: 3");
    expect(app.text("excluded-currencies")).toContain("7 other or unknown currency records outside the totals");
    expect(app.text("excluded-currencies")).toContain("Currency blank · 6");
    expect(app.text("excluded-currencies")).toContain("美元 · 1");
    expect(app.view.document.querySelectorAll("#details .date-group")).toHaveLength(2);
    expect(app.text("details")).toContain("−100.00");
    expect(app.text("details")).toContain("+30.00");
    expect(app.text("details")).not.toContain("¥");
    for (const id of ["refresh", "period", "category", "currency"]) expect(app.view.document.getElementById(id)).toBeNull();
    expect(app.query).toHaveBeenCalledWith("details", { from: "2026-11-01", through: "2026-11-06", currencies: ["人民币"] }, { expectedDataRevision: 7 });
  });

  it("navigates two years directly and selects a calendar day with keyboard tabs", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    const records = app.view.document.getElementById("tab-records") as unknown as HTMLButtonElement;
    records.dispatchEvent(new app.view.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.getElementById("tab-calendar")?.getAttribute("aria-selected")).toBe("true");
    expect(app.view.document.querySelector('[data-calendar-day="2026-11-06"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(app.text("day-details")).toContain("Synthetic groceries");
    app.choose("calendar-month", "2024-11");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("calendar-title")).toContain("November 2024");
    expect(app.query).toHaveBeenCalledWith("trend_day", { from: "2024-11-01", through: "2024-11-30", currencies: ["人民币"] }, { expectedDataRevision: 7 });
    const day = app.view.document.querySelector('[data-calendar-day="2024-11-07"]') as unknown as HTMLButtonElement | null;
    day?.click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("day-details")).toContain("Synthetic early entry");
    expect(app.query).toHaveBeenCalledWith("details", { from: "2024-11-07", through: "2024-11-07", currencies: ["人民币"] }, { expectedDataRevision: 7 });
  });

  it("compares a partial month, changes trend granularity and drills from category/year into Details", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.click("tab-statistics");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("stats-range")).toContain("2026-11-01 to 2026-11-06");
    expect(app.text("stats-range")).toContain("Prior 2026-10-01 to 2026-10-06");
    expect(app.query).toHaveBeenCalledWith("trend_day", expect.objectContaining({ from: "2026-11-01", through: "2026-11-06" }), { expectedDataRevision: 7 });
    expect(app.text("summary")).toContain("Outflow rose by 76.40");
    expect(app.text("summary")).not.toContain("¥");
    (app.view.document.querySelector('[data-stats-period="week"]') as unknown as HTMLButtonElement).click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("stats-range")).toContain("2026-11-02 to 2026-11-06");
    expect(app.text("stats-range")).toContain("Prior 2026-10-26 to 2026-10-30");
    (app.view.document.querySelector('[data-stats-period="year"]') as unknown as HTMLButtonElement).click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("trend_month", expect.objectContaining({ from: "2026-01-01", through: "2026-11-06" }), { expectedDataRevision: 7 });
    expect(app.text("year-breakdown")).toContain("156.40");
    const octoberButton = [...app.view.document.querySelectorAll("#year-breakdown button")].find((button) => button.textContent === "10") as unknown as HTMLButtonElement | undefined;
    expect(octoberButton).toBeDefined();
    octoberButton?.click();
    await vi.waitFor(() => expect(app.text("records-title")).toContain("October 2026"));
    expect(app.view.document.getElementById("tab-records")?.getAttribute("aria-selected")).toBe("true");
    app.click("tab-statistics");
    await app.view.happyDOM.whenAsyncComplete();
    app.choose("stats-date", "2025-06-01");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ from: "2025-01-01", through: "2025-12-31" }), { expectedDataRevision: 7 });
    expect(app.text("stats-range")).toContain("Prior 2024-01-01 to 2024-12-31");
    app.click("stats-latest");
    await app.view.happyDOM.whenAsyncComplete();
    const food = [...app.view.document.querySelectorAll("#categories button")].find((button) => button.textContent?.includes("Food")) as unknown as HTMLButtonElement | undefined;
    food?.click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("record-drilldown")).toContain("Category: Food");
    expect(app.view.document.activeElement?.id).toBe("tab-records");
    expect(app.query).toHaveBeenCalledWith("details", expect.objectContaining({ category: "Food", currencies: ["人民币"] }), { expectedDataRevision: 7 });
    app.click("record-drilldown-clear");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.getElementById("record-drilldown")?.hasAttribute("hidden")).toBe(true);
  });

  it("keeps tab and calendar context on automatic updates and retains readable stale results", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.click("tab-calendar");
    await app.view.happyDOM.whenAsyncComplete();
    app.choose("calendar-month", "2026-10");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("calendar-title")).toContain("October 2026");
    app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.getElementById("tab-calendar")?.getAttribute("aria-selected")).toBe("true");
    expect(app.text("calendar-title")).toContain("October 2026");
    app.failDaily(true); app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("calendar")).toContain("12");
    expect(app.text("notice")).toContain("Data could not be updated. Showing the last results.");
    expect(app.text("notice")).not.toContain("private query detail");
  });

  it("never turns a bounded unread day aggregate into observed zero", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.exhaustDaily();
    app.click("tab-calendar");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelectorAll("#calendar .calendar-day")).toHaveLength(0);
    expect(app.text("calendar")).toContain("Daily totals incomplete");
    expect(app.text("notice")).toContain("This view is incomplete");
    expect(app.text("calendar")).not.toContain("No recorded outflow");
  });
});
