import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(new URL("../../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");

type RecordRow = Record<string, string | number | null>;
const source: RecordRow[] = [
  { category: "Food", date: "2026-04-04", amount: "-12.34", account: "Demo card", book: "Sample book", currency: "CNY", note: "<img src=x onerror=alert(1)>" },
  { category: "Other", date: "2026-04-03", amount: "-9007199254740980.78", account: "Demo card", book: "Sample book", currency: "CNY", note: null },
  { category: "Other", date: "2026-04-03", amount: "+25.00", account: "Demo card", book: "Sample book", currency: "CNY", note: null },
  { category: "Travel", date: "2026-04-02", amount: "-8.50", account: "Sample cash", book: "Sample book", currency: "USD", note: null },
  { category: null, date: "2026-04-02", amount: "-3.00", account: null, book: "Sample book", currency: null, note: null },
  { category: "", date: "2026-04-02", amount: "-1.00", account: null, book: "Sample book", currency: "", note: null },
  { category: "Salary", date: "2026-04-01", amount: "+100.00", account: "Demo card", book: "Sample book", currency: "CNY", note: "Synthetic inflow" },
  { category: "Food", date: "2026-04", amount: "-2.00", account: null, book: null, currency: "CNY", note: "Partial date" },
  { category: "Food", date: null, amount: "invalid", account: null, book: null, currency: "CNY", note: "Invalid amount" },
];

function result(rows: RecordRow[], nextCursor?: string) {
  return { columns: Object.keys(rows[0] ?? {}).map((name) => ({ name })), rows: rows.map((row) => Object.values(row)), revision: 7, ...(nextCursor ? { nextCursor } : {}) };
}

function fixture(options: { paginateCategories?: boolean; paginateCategoryOptions?: boolean } = {}) {
  const view = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const coverage = [
    { currency: "CNY", count: "6", datedCount: "4", amountCount: "5", firstDate: "2026-04-01", lastDate: "2026-04-04" },
    { currency: "USD", count: "1", datedCount: "1", amountCount: "1", firstDate: "2026-04-02", lastDate: "2026-04-02" },
    { currency: null, count: "1", datedCount: "1", amountCount: "1", firstDate: "2026-04-02", lastDate: "2026-04-02" },
    { currency: "", count: "1", datedCount: "1", amountCount: "1", firstDate: "2026-04-02", lastDate: "2026-04-02" },
  ];
  let changed: (() => void) | null = null;
  let fail = false;
  const query = vi.fn(async (queryId: string, parameters: Record<string, unknown>, paging?: { cursor?: string; expectedDataRevision?: number }) => {
    if (fail && queryId === "summary") throw new Error("Data temporarily unavailable");
    if (queryId === "coverage") return result(coverage);
    if (queryId === "summary") return result(parameters.category === "Food"
      ? [{ currency: "CNY", net: "-12.34", count: 1 }]
      : parameters.category === "Salary" ? [{ currency: "CNY", net: "100.00", count: 1 }]
      : [
        { currency: "CNY", net: "-9007199254740868.12", count: 4 },
        { currency: "USD", net: "-8.50", count: 1 },
        { currency: null, net: "-3.00", count: 1 },
        { currency: "", net: "-1.00", count: 1 },
      ]);
    if (queryId === "outflow") return result(parameters.category === "Salary" ? [] : parameters.category === "Food"
      ? [{ currency: "CNY", amount: "-12.34" }]
      : [{ currency: "CNY", amount: "-9007199254740993.12" }, { currency: "USD", amount: "-8.50" }, { currency: null, amount: "-3.00" }, { currency: "", amount: "-1.00" }]);
    if (queryId === "inflow") return result(parameters.category === "Food" ? [] : [{ currency: "CNY", amount: parameters.category === "Salary" ? "100.00" : "125.00" }]);
    if (queryId === "categories" && paging?.cursor === "categories-next") return result([{ currency: "CNY", category: "Late category", amount: "-0.01", count: 1 }]);
    if (queryId === "categories") return result([
      { currency: "CNY", category: "Food", amount: "-12.34", count: 1 },
      { currency: "CNY", category: "Other", amount: "-9007199254740980.78", count: 1 },
      { currency: "USD", category: "Travel", amount: "-8.50", count: 1 },
      { currency: null, category: null, amount: "-3.00", count: 1 },
      { currency: "", category: "", amount: "-1.00", count: 1 },
    ], options.paginateCategories ? "categories-next" : undefined);
    if (queryId === "category_options" && paging?.cursor === "options-next") return result([{ currency: "CNY", category: "Salary", count: 1 }]);
    if (queryId === "category_options") return result([
      { currency: "CNY", category: "Food", count: 1 },
      { currency: "CNY", category: "Other", count: 2 },
      { currency: "USD", category: "Travel", count: 1 },
      { currency: null, category: null, count: 1 },
      { currency: "", category: "", count: 1 },
      ...(options.paginateCategoryOptions ? [] : [{ currency: "CNY", category: "Salary", count: 1 }]),
    ], options.paginateCategoryOptions ? "options-next" : undefined);
    if (queryId === "trend_day" || queryId === "trend_month") return result(parameters.category === "Salary" ? [] : [
      { currency: "CNY", bucket: queryId === "trend_month" ? "2026-04" : "2026-04-04", amount: "-9007199254740993.12", count: 3 },
      { currency: "USD", bucket: queryId === "trend_month" ? "2026-04" : "2026-04-02", amount: "-8.50", count: 1 },
    ]);
    if (queryId === "details") return parameters.category === "Salary" ? result([source[6]!])
      : paging?.cursor === "next" ? result([source[3]!]) : result(Array.from({ length: 30 }, (_, index) => source[index % 7]!), "next");
    throw new Error(`Unexpected query: ${queryId}`);
  });
  (view as unknown as { mausApp: unknown }).mausApp = { query, onDataChanged: (callback: () => void) => { changed = callback; } };
  view.document.write(html);
  return {
    view, query,
    changed: () => changed?.(),
    fail: () => { fail = true; },
    text: (id: string) => view.document.getElementById(id)?.textContent ?? "",
    select: (id: string, value: string) => {
      const control = view.document.getElementById(id) as unknown as HTMLSelectElement;
      control.value = value;
      control.dispatchEvent(new view.Event("change") as unknown as Event);
    },
  };
}

const opened: Window[] = [];
afterEach(async () => {
  for (const view of opened.splice(0)) await view.happyDOM.abort();
});

describe("portable bookkeeping Mini App", () => {
  it("keeps decimal strings exact and currencies separate, and labels incomplete source coverage", async () => {
    const app = fixture();
    opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();

    expect(source).toHaveLength(9);
    expect(app.text("notice")).toBe("");
    expect(app.text("coverage")).toContain("2 incomplete dates excluded");
    expect(app.text("coverage")).toContain("1 invalid or unrepresentable amount excluded");
    expect(app.text("summary")).toContain("9,007,199,254,740,993.12");
    expect(app.text("summary")).toContain("−9,007,199,254,740,868.12");
    expect(app.text("summary")).toContain("Currency missing");
    expect(app.text("summary")).toContain("Currency blank");
    expect(app.text("categories")).toContain("Category missing");
    expect(app.text("categories")).toContain("Category blank");
    expect(app.text("categories")).toContain("0.0% of outflow");
    expect(app.text("details")).toContain("−12.34 CNY");
    expect(app.text("details")).toContain("25.00 CNY");
    expect(app.text("details")).toContain("<img src=x onerror=alert(1)>");
    expect(app.view.document.querySelector("#details img")).toBeNull();
    expect(app.query).toHaveBeenCalledWith("summary", { from: "2026-04-01", through: "2026-04-04" }, { expectedDataRevision: 7 });
    expect(app.view.document.querySelectorAll("iframe, form")).toHaveLength(0);
  });

  it("passes filters and buckets through named queries and bounds detail pages", async () => {
    const app = fixture();
    opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();

    app.select("category", "Food");
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("summary", expect.objectContaining({ category: "Food" }), { expectedDataRevision: 7 });
    expect(app.text("summary")).toContain("12.34");
    expect(app.text("categories")).toContain("0.0% of outflow");

    (app.view.document.getElementById("month") as unknown as HTMLButtonElement).click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("trend_month", expect.objectContaining({ category: "Food" }), { expectedDataRevision: 7 });
    expect(app.text("trend")).toContain("2026-04");

    (app.view.document.getElementById("more") as unknown as HTMLButtonElement).click();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("details", expect.any(Object), { cursor: "next", expectedDataRevision: 7 });
    expect(app.view.document.querySelectorAll("#details .entry")).toHaveLength(31);
  });

  it("reads aggregate cursors before computing category shares", async () => {
    const app = fixture({ paginateCategories: true });
    opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("categories", expect.any(Object), { cursor: "categories-next", expectedDataRevision: 7 });
    expect(app.text("categories")).toContain("Late category");
  });

  it("offers an income-only category from all-sign pages and filters its summary, trend and details", async () => {
    const app = fixture({ paginateCategoryOptions: true });
    opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledWith("category_options", expect.any(Object), { cursor: "options-next", expectedDataRevision: 7 });
    expect(app.view.document.querySelector('#category option[value="Salary"]')).not.toBeNull();

    app.select("category", "Salary");
    await app.view.happyDOM.whenAsyncComplete();
    for (const queryId of ["summary", "outflow", "inflow", "trend_day", "details"]) {
      expect(app.query).toHaveBeenCalledWith(queryId, expect.objectContaining({ category: "Salary" }), { expectedDataRevision: 7 });
    }
    expect(app.text("summary")).toContain("100.00");
    expect(app.text("summary")).toContain("0.00");
    expect(app.text("trend")).toContain("No outflow matches these filters.");
    expect(app.text("details")).toContain("Salary");
    expect(app.text("details")).toContain("100.00 CNY");
  });

  it("uses the host's Chinese locale for controls and report states", async () => {
    const app = fixture();
    opened.push(app.view);
    app.view.document.documentElement.lang = "zh-CN";
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.view.document.querySelector("h1")?.textContent).toBe("记账");
    expect(app.view.document.querySelector("#summary-title")?.textContent).toBe("收支汇总");
    expect(app.text("coverage")).toContain("已排除 2 条日期不完整的记录");
    expect(app.text("summary")).toContain("支出");
    expect(app.view.document.getElementById("refresh")?.textContent).toBe("刷新");
  });

  it("keeps the previous result visible when a later Data notification fails", async () => {
    const app = fixture();
    opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.fail();
    app.changed();
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.text("summary")).toContain("9,007,199,254,740,993.12");
    expect(app.text("notice")).toContain("Records could not be refreshed");
    expect(app.view.document.getElementById("notice")?.getAttribute("role")).toBe("alert");
  });

  it("does not query an invalid custom range or display a fabricated zero", async () => {
    const app = fixture();
    opened.push(app.view);
    await app.view.happyDOM.whenAsyncComplete();
    app.select("period", "custom");
    const from = app.view.document.getElementById("from") as unknown as HTMLInputElement;
    const through = app.view.document.getElementById("through") as unknown as HTMLInputElement;
    from.value = "2026-05-01";
    through.value = "2026-04-01";
    from.dispatchEvent(new app.view.Event("change") as unknown as Event);
    const before = app.query.mock.calls.length;
    await app.view.happyDOM.whenAsyncComplete();
    expect(app.query).toHaveBeenCalledTimes(before);
    expect(app.text("notice")).toContain("Choose a valid From and Through date");
    expect(app.text("summary")).not.toContain("0.00");
  });
});
