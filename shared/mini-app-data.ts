export type MiniAppField =
  | { column: string; sourceType: string; as: "text" }
  | { column: string; sourceType: string; as: "decimal"; scale: number }
  | { column: string; sourceType: string; as: "date" };

export type MiniAppParameter = { type: "text" | "decimal" | "date"; list?: boolean; optional?: boolean };

export type MiniAppFilter = { field: string; op: "eq" | "lt" | "lte" | "gt" | "gte"; literal: string } |
  { field: string; op: "eq" | "in" | "lt" | "lte" | "gt" | "gte"; parameter: string };

export type MiniAppMeasure =
  | { name: string; op: "count"; field?: string }
  | { name: string; op: "sum" | "min" | "max"; field: string };

export type MiniAppNamedQuery = {
  parameters: Record<string, MiniAppParameter>;
  filters: MiniAppFilter[];
  orderBy: Array<{ field: string; direction: "asc" | "desc" }>;
  pageSize: number;
} & (
  | { kind: "rows"; columns: string[] }
  | { kind: "aggregate"; groupBy: string[]; timeBucket?: { field: string; unit: "day" | "week" | "month" | "year"; name: string }; measures: MiniAppMeasure[] }
);

/** An installed binding names one physical local table and only the fields and queries its host may expose. */
export interface MiniAppDataBinding {
  id: string;
  datasetId: string;
  source: { schema: string; table: string };
  fields: Record<string, MiniAppField>;
  queries: Record<string, MiniAppNamedQuery>;
}

export interface MiniAppNamedRead {
  ownerId: string;
  binding: MiniAppDataBinding;
  queryId: string;
  parameters: Record<string, string | string[]>;
  scope: string;
  cursor?: string;
  expectedRevision?: number;
}

export interface MiniAppNamedPage {
  columns: Array<{ name: string; type: "text" | "decimal" | "date" | "count" }>;
  rows: Array<Array<string | number | null>>;
  revision: number;
  nextCursor?: string;
}

export interface MiniAppSourceTable {
  schema: string;
  name: string;
  rowCount: number;
  columns: Array<{ name: string; type: string }>;
}
