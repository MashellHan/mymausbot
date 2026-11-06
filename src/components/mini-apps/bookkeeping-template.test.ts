import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOKKEEPING_FIELDS, createBookkeepingPublish } from "../../../shared/bookkeeping-mini-app";
import type { MiniAppDataset, MiniAppSourceTable } from "../../../shared/mini-apps";

const html = readFileSync(new URL("../../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");
const table = { schema: "main", name: "synthetic_ledger", rowCount: 0,
  columns: BOOKKEEPING_FIELDS.map((name) => ({ name, type: name === "amount" ? "DECIMAL(18,2)" : name === "date" ? "DATE" : "VARCHAR" })) } as MiniAppSourceTable;
const dataset = { datasetId: "synthetic-dataset", tables: [table] } as MiniAppDataset;
const declarations = createBookkeepingPublish({ dataset, table,
  columns: Object.fromEntries(BOOKKEEPING_FIELDS.map((name) => [name, name])) as Record<typeof BOOKKEEPING_FIELDS[number], string>,
  html: "<html></html>", requestKey: "synthetic-request" }).bindings[0]!.queries;
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

function fixture(fixtureOptions: { manyRows?: boolean } = {}) {
  const view = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  let changed: (() => void) | null = null;
  let failDaily = false;
  let exhaustDaily = false;
  let failOctober = false;
  let noDomesticCurrency = false;
  let manyRows = fixtureOptions.manyRows ?? false;
  let failSecondPage = false;
  let latestDate = "2026-11-06";
  let failNovemberDetails = false;
  let deferDays = false;
  const pendingDays = new Map<string, Array<{ resolve(value: ReturnType<typeof page>): void; reject(error: Error): void }>>();
  const query = vi.fn(async (id: string, params: Record<string, unknown>, options?: { cursor?: string; expectedDataRevision?: number }) => {
    const declaration = declarations[id];
    if (!declaration) throw new Error(`Undeclared query ${id}`);
    for (const key of Object.keys(params)) if (!Object.hasOwn(declaration.parameters, key)) throw new Error(`Undeclared parameter ${id}.${key}`);
    const from = String(params.from ?? "");
    const to = String(params.through ?? "");
    const prior = from.startsWith("2026-10") || from.startsWith("2025-");
    if (failDaily && id === "trend_day") throw new Error("private query detail");
    if (id === "coverage") return page(noDomesticCurrency ? [
      { currency: "", count: "6", datedCount: "4", amountCount: "6", firstDate: "2025-03-01", lastDate: "2026-10-01" },
      { currency: "美元", count: "1", datedCount: "0", amountCount: "1", firstDate: null, lastDate: null },
    ] : [
      { currency: "人民币", count: "1135", datedCount: "1135", amountCount: "1135", firstDate: "2024-11-07", lastDate: latestDate },
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
      if (deferDays && from === to) return new Promise<ReturnType<typeof page>>((resolve, reject) => {
        const pending = pendingDays.get(from) ?? [];
        pending.push({ resolve, reject });
        pendingDays.set(from, pending);
      });
      if (failNovemberDetails && from.startsWith("2026-11")) throw new Error("November read failed");
      if (failOctober && from.startsWith("2026-10")) throw new Error("October read failed");
      if (manyRows && from.startsWith("2026-11")) {
        if (options?.cursor === "next" && failSecondPage) throw new Error("Second page failed");
        const rows = Array.from({ length: 30 }, (_, index) => record(options?.cursor ? "2026-11-05" : "2026-11-06",
          `-${index + 1}.00`, "Food", `Synthetic page ${options?.cursor ? "two" : "one"} ${index + 1}`));
        if (latestDate === "2026-11-07" && !options?.cursor) rows[0] = record("2026-11-07", "-4.00", "Food", "Synthetic new day");
        return page(rows, options?.cursor ? undefined : "next");
      }
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
    failOctober: (value: boolean) => { failOctober = value; },
    noDomesticCurrency: () => { noDomesticCurrency = true; },
    manyRows: () => { manyRows = true; },
    failSecondPage: (value: boolean) => { failSecondPage = value; },
    advanceLatest: (date: string) => { latestDate = date; },
    failNovemberDetails: (value: boolean) => { failNovemberDetails = value; },
    deferDays: () => { deferDays = true; },
    resolveDay: (date: string, rows: Row[]) => {
      const request = pendingDays.get(date)?.shift();
      if (!request) throw new Error(`No deferred read for ${date}`);
      request.resolve(page(rows));
    },
    rejectDay: (date: string) => {
      const request = pendingDays.get(date)?.shift();
      if (!request) throw new Error(`No deferred read for ${date}`);
      request.reject(new Error("Synthetic day read failed"));
    },
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
    expect(app.view.document.querySelectorAll("#details .date-group")).toHaveLength(3);
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
    const expense = app.view.document.querySelector("#largest .expense-open") as unknown as HTMLButtonElement | null;
    expense?.click();
    expect(app.text("expense-detail")).toContain("Synthetic groceries");
    expect(app.text("expense-detail")).toContain("−100.00");
    app.click("expense-detail-close");
    expect(app.view.document.activeElement?.getAttribute("data-expense-index")).toBe("0");
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

  it("queries a closed month and complete prior month, and keeps category scope through clear and pagination", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.click("tab-statistics");
    await app.view.happyDOM.whenAsyncComplete();
    app.choose("stats-date", "2026-04-04");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("stats-range")).toContain("2026-04-01 to 2026-04-30");
    expect(app.text("stats-range")).toContain("Prior 2026-03-01 to 2026-03-31");
    expect(app.query).toHaveBeenCalledWith("summary", { from: "2026-03-01", through: "2026-03-31", currencies: ["人民币"] }, { expectedDataRevision: 7 });
    app.click("stats-latest");
    await app.view.happyDOM.whenAsyncComplete();
    app.manyRows();
    const food = [...app.view.document.querySelectorAll("#categories button")].find((button) => button.textContent?.includes("Food")) as unknown as HTMLButtonElement | undefined;
    food?.click();
    await app.view.happyDOM.whenAsyncComplete();
    const scope = app.text("records-range");
    expect(scope).toContain("2026-11-01 to 2026-11-06");
    expect(app.query).toHaveBeenCalledWith("details", { from: "2026-11-01", through: "2026-11-06", currencies: ["人民币"], category: "Food" }, { expectedDataRevision: 7 });
    app.click("more");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("details", { from: "2026-11-01", through: "2026-11-06", currencies: ["人民币"], category: "Food" }, { cursor: "next", expectedDataRevision: 7 });
    app.click("record-drilldown-clear");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("records-range")).toBe(scope);
    expect(app.view.document.getElementById("record-drilldown")?.hasAttribute("hidden")).toBe(true);
  });

  it("restores committed scope and data on failed navigation, and marks a never-loaded view unavailable", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    const beforeMoney = app.text("records-totals");
    app.failOctober(true);
    app.choose("records-month", "2026-10");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("records-title")).toContain("November 2026");
    expect((app.view.document.getElementById("records-month") as unknown as HTMLInputElement).value).toBe("2026-11");
    expect(app.text("records-totals")).toBe(beforeMoney);
    expect(app.text("details")).toContain("Synthetic groceries");
    expect(app.text("notice")).toContain("Showing the last results");
    app.failDaily(true);
    app.click("tab-calendar");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("calendar")).toContain("Records unavailable");
    expect(app.text("notice")).not.toContain("Showing the last results");
  });

  it("keeps the committed Records cutoff after another view advances, and hides obsolete expense detail", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    const committedRange = app.text("records-range");
    const committedMoney = app.text("records-totals");
    app.click("tab-statistics");
    await app.view.happyDOM.whenAsyncComplete();
    (app.view.document.querySelector("#largest .expense-open") as unknown as HTMLButtonElement).click();
    expect(app.view.document.getElementById("expense-detail")?.hasAttribute("hidden")).toBe(false);
    app.choose("stats-date", "2026-10-12");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.getElementById("expense-detail")?.hasAttribute("hidden")).toBe(true);
    app.advanceLatest("2026-11-07"); app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    app.failNovemberDetails(true);
    app.click("tab-records");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("records-range")).toBe(committedRange);
    expect(app.text("records-range")).toContain("2026-11-06");
    expect(app.text("records-totals")).toBe(committedMoney);
    expect(app.text("details")).toContain("Synthetic groceries");
    expect(app.text("notice")).toContain("Showing the last results");
  });

  it("clears every related view after a successful no-domestic-currency refresh", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.click("tab-statistics");
    await app.view.happyDOM.whenAsyncComplete();
    (app.view.document.querySelector('[data-stats-period="year"]') as unknown as HTMLButtonElement).click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("year-breakdown")).toContain("156.40");
    app.noDomesticCurrency(); app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    for (const id of ["summary", "categories", "trend", "largest", "year-breakdown", "details", "calendar", "day-details"])
      expect(app.text(id)).toContain("No recorded entries");
    expect(app.text("records-totals")).toBe("");
    expect(app.text("stats-range")).toBe("");
    expect(app.view.document.getElementById("expense-detail")?.hasAttribute("hidden")).toBe(true);
  });

  it("requeries loaded Records depth on auto refresh and retains 60 rows when page two fails", async () => {
    const app = fixture({ manyRows: true }); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelectorAll("#details .record-row")).toHaveLength(30);
    app.click("more");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelectorAll("#details .record-row")).toHaveLength(60);
    const scroller = app.view.document.scrollingElement;
    if (scroller) scroller.scrollTop = 72;
    const before = app.query.mock.calls.length;
    app.advanceLatest("2026-11-07");
    app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query.mock.calls.slice(before).filter(([id]) => id === "details")).toHaveLength(2);
    expect(app.view.document.querySelectorAll("#details .record-row")).toHaveLength(60);
    expect(app.text("records-range")).toContain("2026-11-07");
    expect(app.text("details")).toContain("Synthetic page two 30");
    if (scroller) expect(scroller.scrollTop).toBe(72);
    app.failSecondPage(true); app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelectorAll("#details .record-row")).toHaveLength(60);
    expect(app.text("notice")).toContain("Showing the last results");
  });

  it("commits only the latest deferred calendar day intent on success and failure", async () => {
    const app = fixture(); opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.click("tab-calendar");
    await app.view.happyDOM.whenAsyncComplete();
    app.deferDays();
    const clickDay = (date: string) => (app.view.document.querySelector(`[data-calendar-day="${date}"]`) as unknown as HTMLButtonElement).click();
    clickDay("2026-11-05");
    clickDay("2026-11-06");
    app.resolveDay("2026-11-05", [current[2]!]);
    await Promise.resolve();
    app.resolveDay("2026-11-06", [current[0]!, current[1]!]);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelector('[data-calendar-day="2026-11-06"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(app.text("day-details")).toContain("Synthetic groceries");
    expect(app.text("day-details")).not.toContain("Synthetic supplies");
    clickDay("2026-11-05");
    clickDay("2026-11-06");
    app.rejectDay("2026-11-06");
    app.resolveDay("2026-11-05", [current[2]!]);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelector('[data-calendar-day="2026-11-06"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(app.text("day-details")).toContain("Synthetic groceries");
    expect(app.text("notice")).toContain("Records unavailable");
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
