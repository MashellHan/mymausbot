import type { MiniAppDataBinding, MiniAppField, MiniAppFilter, MiniAppNamedQuery, MiniAppParameter } from "./mini-app-data.ts";
import type { MiniAppDataset, MiniAppPublish, MiniAppSourceTable } from "./mini-apps.ts";

export const BOOKKEEPING_FIELDS = ["category", "date", "amount", "account", "book", "currency", "note"] as const;
export type BookkeepingColumns = Record<typeof BOOKKEEPING_FIELDS[number], string>;

export function suggestedBookkeepingColumns(table: MiniAppSourceTable): BookkeepingColumns {
  const labels = { category: ["分类", "category"], date: ["时间", "date", "time"], amount: ["金额", "amount"],
    account: ["账户", "account"], book: ["账本", "book"], currency: ["货币", "currency"], note: ["备注", "note", "description"] };
  return Object.fromEntries(BOOKKEEPING_FIELDS.map((field) => [field,
    table.columns.find((column) => labels[field].some((label) => label === column.name.toLowerCase()))?.name ?? "",
  ])) as BookkeepingColumns;
}

export function createBookkeepingPublish(input: {
  dataset: MiniAppDataset;
  table: MiniAppSourceTable;
  columns: BookkeepingColumns;
  html: string;
  publisherBotId?: string;
  requestKey: string;
  slug?: string;
  title?: string;
}): MiniAppPublish {
  const fields: Record<string, MiniAppField> = {};
  for (const field of BOOKKEEPING_FIELDS) {
    const column = input.table.columns.find((candidate) => candidate.name === input.columns[field]);
    if (!column) throw new Error(`Choose a source column for ${field}.`);
    fields[field] = field === "amount" ? { column: column.name, sourceType: column.type, as: "decimal", scale: 2 }
      : { column: column.name, sourceType: column.type, as: field === "date" ? "date" : "text" };
  }
  const parameters: Record<string, MiniAppParameter> = {
    from: { type: "date", optional: true }, through: { type: "date", optional: true },
    currency: { type: "text", optional: true }, category: { type: "text", optional: true },
  };
  const filters: MiniAppFilter[] = [
    { field: "date", op: "gte", parameter: "from" }, { field: "date", op: "lte", parameter: "through" },
    { field: "currency", op: "eq", parameter: "currency" }, { field: "category", op: "eq", parameter: "category" },
  ];
  const base = { parameters, filters, orderBy: [{ field: "currency", direction: "asc" as const }], pageSize: 100 };
  const aggregate = (groupBy: string[], extra: Partial<Extract<MiniAppNamedQuery, { kind: "aggregate" }>> = {}): MiniAppNamedQuery => ({
    ...base, kind: "aggregate", groupBy, measures: [{ name: "count", op: "count" }, { name: "amount", op: "sum", field: "amount" }], ...extra,
  });
  const outflows: MiniAppFilter[] = [...filters, { field: "amount", op: "lt", literal: "0" }];
  const binding: MiniAppDataBinding = {
    id: "ledger", datasetId: input.dataset.datasetId, source: { schema: input.table.schema, table: input.table.name }, fields,
    queries: {
      coverage: { ...base, parameters: {}, filters: [], kind: "aggregate", groupBy: ["currency"], measures: [
        { name: "count", op: "count" }, { name: "datedCount", op: "count", field: "date" },
        { name: "amountCount", op: "count", field: "amount" }, { name: "firstDate", op: "min", field: "date" },
        { name: "lastDate", op: "max", field: "date" },
      ] },
      summary: aggregate(["currency"], { measures: [{ name: "count", op: "count" }, { name: "net", op: "sum", field: "amount" }] }),
      outflow: aggregate(["currency"], { filters: outflows }),
      inflow: aggregate(["currency"], { filters: [...filters, { field: "amount", op: "gt", literal: "0" }] }),
      categories: aggregate(["currency", "category"], { filters: outflows, orderBy: [{ field: "amount", direction: "asc" }] }),
      category_options: aggregate(["currency", "category"], { measures: [{ name: "count", op: "count" }], orderBy: [{ field: "currency", direction: "asc" }, { field: "category", direction: "asc" }] }),
      trend_day: aggregate(["currency"], { filters: outflows, timeBucket: { field: "date", unit: "day", name: "bucket" }, orderBy: [{ field: "bucket", direction: "asc" }] }),
      trend_month: aggregate(["currency"], { filters: outflows, timeBucket: { field: "date", unit: "month", name: "bucket" }, orderBy: [{ field: "bucket", direction: "asc" }] }),
      details: { ...base, kind: "rows", columns: ["date", "amount", "currency", "category", "account", "book", "note"],
        orderBy: [{ field: "date", direction: "desc" }], pageSize: 30 },
    },
  };
  return {
    requestKey: input.requestKey, expectedRevision: 0, slug: input.slug ?? "bookkeeping", title: input.title ?? "Bookkeeping",
    description: "Cash flow, categories, trends and individual records from local Data, with each currency kept separate.",
    html: input.html, bindings: [binding], publisherBotIds: input.publisherBotId ? [input.publisherBotId] : [],
  };
}
