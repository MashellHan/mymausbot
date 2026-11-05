import { describe, expect, it } from "vitest";

import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import { compileNamedRead, validateDataBindings } from "./named-query.ts";

const binding: MiniAppDataBinding = {
  id: "ledger",
  datasetId: "00000000-0000-4000-8000-000000000001",
  source: { schema: "main", table: "synthetic_ledger" },
  fields: {
    amount: { column: "金额文本", sourceType: "VARCHAR", as: "decimal", scale: 2 },
    day: { column: "日期文本", sourceType: "VARCHAR", as: "date" },
    category: { column: "类别文本", sourceType: "VARCHAR", as: "text" },
  },
  queries: {
    outflow_month: {
      kind: "aggregate", groupBy: ["category"], timeBucket: { field: "day", unit: "month", name: "month" },
      measures: [{ name: "rows", op: "count" }, { name: "validAmounts", op: "count", field: "amount" }, { name: "total", op: "sum", field: "amount" }],
      filters: [
        { field: "amount", op: "lt", literal: "0" },
        { field: "category", op: "eq", parameter: "category" },
        { field: "day", op: "gte", parameter: "from" },
        { field: "day", op: "lt", parameter: "before" },
      ],
      parameters: { category: { type: "text", optional: true }, from: { type: "date", optional: true }, before: { type: "date", optional: true } },
      orderBy: [{ field: "total", direction: "asc" }], pageSize: 50,
    },
  },
};

const read = (parameters: Record<string, string | string[]> = {}) => ({ ownerId: "owner", binding, queryId: "outflow_month", parameters, scope: "mount-1" });

describe("declarative named Data queries", () => {
  it("binds fixed and optional typed filters while sorting decimal aggregates numerically", () => {
    validateDataBindings([binding]);
    const compiled = compileNamedRead(read({ category: "Food', read_csv('/private') --", from: "2025-01-01" }), 0);
    expect(compiled.values).toEqual(["0", "Food', read_csv('/private') --", "2025-01-01"]);
    expect(compiled.sql).not.toContain("read_csv");
    expect(compiled.sql).toContain('source."金额文本"');
    expect(compiled.sql).toContain("TRY_CAST");
    expect(compiled.sql).toContain("count(CASE WHEN regexp_full_match");
    expect(compiled.sql).toContain("ORDER BY sum(CASE WHEN regexp_full_match");
    expect(compiled.columns.map((column) => column.name)).toEqual(["category", "month", "rows", "validAmounts", "total"]);
    expect(compileNamedRead(read(), 0).values).toEqual(["0"]);
  });

  it("rejects malformed amounts, dates and undeclared parameters", () => {
    expect(() => compileNamedRead(read({ from: "2025-02-30" }), 0)).toThrow(/Invalid date/);
    expect(() => compileNamedRead(read({ category: "x", unexpected: "y" }), 0)).toThrow(/Unexpected Data parameter/);
    expect(() => compileNamedRead({ ...read(), binding: {
      ...binding, queries: { outflow_month: { ...binding.queries.outflow_month!, filters: [{ field: "amount", op: "gt", parameter: "minimum" }], parameters: { minimum: { type: "decimal" } } } },
    }, parameters: { minimum: "0.001" } }, 0)).toThrow(/Invalid decimal/);
  });

  it("rejects duplicate query IDs across bindings and result-cache or metadata sources", () => {
    expect(() => validateDataBindings([binding, { ...binding, id: "other" }])).toThrow(/Duplicate Data query/);
    expect(() => compileNamedRead({ ...read(), binding: { ...binding, source: { schema: "omb_results", table: "q_1" } } }, 0)).toThrow(/Invalid Data binding/);
    expect(() => compileNamedRead({ ...read(), binding: { ...binding, source: { schema: "omb_data_internal", table: "revision" } } }, 0)).toThrow(/Invalid Data binding/);
    expect(() => validateDataBindings([null as unknown as MiniAppDataBinding])).toThrow(/Invalid Data binding/);
    expect(() => validateDataBindings([{ ...binding, queries: { broken: null as never } }])).toThrow(/Invalid named Data query/);
  });
});
