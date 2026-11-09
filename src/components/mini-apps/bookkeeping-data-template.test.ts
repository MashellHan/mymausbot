import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { expect, it, vi } from "vitest";
import { launchMiniAppsFixture } from "../../../server/testing/mini-apps-fixture.ts";
import type { MiniAppQueryOptions, MiniAppQueryResult } from "../../../shared/mini-apps.ts";

it("renders canonical DuckDB month buckets and sorts the complete ledger across pages", async () => {
  const fixture = await launchMiniAppsFixture();
  const view = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  let changed: (() => void) | undefined;
  let monthly: MiniAppQueryResult | undefined;
  const query = vi.fn(async (queryId: string, parameters: Record<string, string | string[]>, options?: MiniAppQueryOptions) => {
    const result = await fixture.api<MiniAppQueryResult>("POST", `/api/mini-apps/${fixture.installed.app.id}/query`, {
      queryId, parameters, expectedRevision: fixture.installed.app.revision, ...options,
    });
    if (queryId === "trend_month") monthly = result;
    return result;
  });
  const text = (id: string) => view.document.getElementById(id)?.textContent ?? "";
  const click = (selector: string) => {
    const node = view.document.querySelector(selector);
    expect(node).not.toBeNull();
    (node as unknown as HTMLButtonElement).click();
  };
  try {
    await fixture.dataCall("data_sql", { sql: `CREATE OR REPLACE TABLE ledger_master AS SELECT * FROM ledger_master UNION ALL SELECT * FROM (VALUES
      ('Food', '2024-11-07', '-8.00', 'Card', 'Daily', 'CNY', 'Synthetic earliest'),
      ('Food', '2026-10-05', '-80.00', 'Card', 'Daily', 'CNY', 'Synthetic prior'),
      ('Household', '2026-11-05', '-56.40', 'Card', 'Daily', 'CNY', 'Synthetic supplies'),
      ('Food', '2026-11-06', '-100.00', 'Card', 'Daily', 'CNY', 'Synthetic groceries'),
      ('Transfer', '2026-11-06', '30.00', 'Card', 'Daily', 'CNY', 'Synthetic income')) AS added(category, date, amount, account, book, currency, note)` });
    (view as unknown as { mausApp: unknown }).mausApp = { query, onDataChanged: (listener: () => void) => { changed = listener; } };
    view.document.write(readFileSync(new URL("../../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8"));
    await vi.waitFor(() => expect(text("daily-trend")).toContain("Peak 100.00"), { timeout: 15_000 });
    expect(text("records-totals")).toContain("156.40");
    expect(text("records-totals")).toContain("+95.5% vs previous month");
    expect(text("recent-categories")).toContain("63.9% of outflow");
    expect(view.document.querySelector('#daily-trend .trend-point[data-date="2026-11-07"]')).toBeNull();

    click("#tab-statistics");
    await vi.waitFor(() => expect(text("trend")).toContain("Peak 100.00"));
    click('[data-stats-period="year"]');
    await vi.waitFor(() => expect(view.document.querySelector('#trend .trend-point[data-date="2026-11"]')?.getAttribute("data-amount")).toBe("156.40"));
    const monthColumn = monthly!.columns.findIndex((column) => column.name === "bucket");
    expect(monthly!.rows.some((row) => row[monthColumn] === "2026-11-01")).toBe(true);
    expect(text("year-breakdown")).toContain("156.40");
    expect(text("trend")).toContain("Peak 156.40");

    click("#tab-records");
    await vi.waitFor(() => expect(text("records-totals")).toContain("156.40"));
    await fixture.dataCall("data_sql", { sql: `CREATE OR REPLACE TABLE ledger_master AS SELECT * FROM ledger_master UNION ALL
      SELECT 'Small', '2026-11-03', CAST(-(i + 1) AS VARCHAR), 'Card', 'Daily', 'CNY', 'Synthetic small ' || i FROM range(35) AS rows(i) UNION ALL SELECT * FROM (VALUES ('Large', '2026-11-01', '-1000.00', 'Card', 'Daily', 'CNY', 'Synthetic largest outside first date page')) AS added(category, date, amount, account, book, currency, note)` });
    changed!();
    await vi.waitFor(() => expect(view.document.querySelectorAll("#details .record-row")).toHaveLength(30));
    expect(text("details")).not.toContain("Synthetic largest outside first date page");
    const sort = view.document.getElementById("records-sort")!;
    (sort as unknown as HTMLSelectElement).value = "spending";
    sort.dispatchEvent(new view.Event("change"));
    click("#more");
    await vi.waitFor(() => expect(view.document.querySelector("#details .record-row")?.textContent).toContain("Synthetic largest outside first date page"));
    expect(view.document.querySelector("#details .amount")?.textContent).toBe("−1,000.00");
    click("#more");
    await vi.waitFor(() => expect(view.document.querySelectorAll("#details .record-row")).toHaveLength(38));
    expect(text("details")).not.toContain("Synthetic income");
    expect(query.mock.calls.some(([id, , options]) => id === "largest_expenses" && Boolean(options?.cursor))).toBe(true);
    changed!();
    await vi.waitFor(() => expect(query.mock.calls.filter(([id, , options]) => id === "largest_expenses" && Boolean(options?.cursor)).length).toBeGreaterThan(1));
    await view.happyDOM.whenAsyncComplete();
    expect(view.document.querySelectorAll("#details .record-row")).toHaveLength(38);
  } finally {
    await view.happyDOM.abort();
    await fixture.close();
  }
}, 60_000);
