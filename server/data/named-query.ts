import type { MiniAppDataBinding, MiniAppField, MiniAppNamedRead } from "../../shared/mini-app-data.ts";
import { quoteIdentifier } from "./sql-identifiers.ts";
import { DataFailure } from "./types.ts";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const DECIMAL = /^-?(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const PAGE_MAX = 100;
const LIST_MAX = 50;
const VALUE_MAX = 500;
const QUERY_MAX = 100_000;

function invalid(message: string): never { throw new DataFailure({ code: "spec_invalid", message }); }
function badParameter(message: string): never { throw new DataFailure({ code: "invalid_input", message }); }
function validName(name: string): boolean { return NAME.test(name); }
function hasControl(text: string): boolean { return [...text].some((char) => char.charCodeAt(0) < 32); }
function typeOf(field: MiniAppField): "text" | "decimal" | "date" { return field.as; }
function sqlType(field: MiniAppField): string {
  return field.as === "decimal" ? `DECIMAL(38, ${field.scale})` : field.as === "date" ? "DATE" : "VARCHAR";
}

function decimalField(column: string, field: Extract<MiniAppField, { as: "decimal" }>): string {
  const target = sqlType(field);
  const sourceType = field.sourceType.toUpperCase().replaceAll(" ", "");
  const converted = `TRY_CAST(${column} AS ${target})`;
  if (/^(?:VARCHAR|TEXT|STRING|CHAR)(?:\([0-9]+\))?$/.test(sourceType)) {
    const digits = 38 - field.scale;
    const fraction = field.scale ? `(?:[.][0-9]{1,${field.scale}})?` : "";
    const pattern = `^-?(?:0|[1-9][0-9]{0,${digits - 1}})${fraction}$`;
    return `CASE WHEN regexp_full_match(${column}, '${pattern}') THEN ${converted} ELSE NULL END`;
  }
  const nativeDecimal = /^DECIMAL\(([0-9]+),([0-9]+)\)$/.exec(sourceType);
  if (nativeDecimal) {
    const precision = Number(nativeDecimal[1]), scale = Number(nativeDecimal[2]);
    if (precision < 1 || precision > 38 || scale > precision) invalid("Invalid source decimal type.");
    return `CASE WHEN TRY_CAST(${converted} AS DECIMAL(${precision}, ${scale})) = ${column} THEN ${converted} ELSE NULL END`;
  }
  if (["DOUBLE", "FLOAT", "REAL"].includes(sourceType)) {
    const float = sourceType === "DOUBLE" ? "DOUBLE" : "FLOAT";
    const limit = ((float === "DOUBLE" ? 9007199254740991n : 16777215n) / 10n ** BigInt(field.scale)).toString();
    const text = `CAST(${column} AS VARCHAR)`;
    const digits = 38 - field.scale;
    const fraction = field.scale ? `(?:[.][0-9]{1,${field.scale}})?` : "";
    const pattern = `^-?(?:0|[1-9][0-9]{0,${digits - 1}})${fraction}$`;
    const parsed = `TRY_CAST(${text} AS ${target})`;
    return `CASE WHEN isfinite(${column}) AND abs(${column}) <= ${limit} AND regexp_full_match(${text}, '${pattern}') AND TRY_CAST(${parsed} AS ${float}) = ${column} THEN ${parsed} ELSE NULL END`;
  }
  if (/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|BIGNUM)$/.test(sourceType)) return converted;
  invalid("A decimal field requires a text or numeric source column.");
}

function sourceField(field: MiniAppField): string {
  const column = `source.${quoteIdentifier(field.column)}`;
  if (field.as === "text") return `left(CAST(${column} AS VARCHAR), 2000)`;
  if (field.as === "decimal") return decimalField(column, field);
  if (/^(?:VARCHAR|TEXT|STRING|CHAR)(?:\([0-9]+\))?$/i.test(field.sourceType)) {
    return `CASE WHEN regexp_full_match(${column}, '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') THEN TRY_CAST(${column} AS DATE) ELSE NULL END`;
  }
  return `TRY_CAST(${column} AS DATE)`;
}
function rendered(expression: string): string { return `CAST(${expression} AS VARCHAR)`; }

function checkValue(value: string, field: MiniAppField, parameter: string): void {
  if (typeof value !== "string" || value.length > VALUE_MAX || value.includes("\0")) badParameter(`Invalid ${parameter} value.`);
  if (field.as === "decimal") {
    const match = DECIMAL.exec(value);
    const digits = value.replace(/[-.]/g, "");
    const whole = value.split(".")[0]!.replace("-", "");
    if (!match || digits.length > 38 || whole.length > 38 - field.scale || (match[1]?.length ?? 0) > field.scale) badParameter(`Invalid decimal ${parameter}.`);
  } else if (field.as === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      badParameter(`Invalid date ${parameter}.`);
    }
  }
}

function fieldOf(binding: MiniAppDataBinding, name: string): MiniAppField {
  const field = binding.fields[name];
  if (!field || typeof field !== "object") invalid(`Unknown Data field ${name}.`);
  return field;
}

export interface CompiledNamedRead {
  sql: string;
  values: string[];
  columns: Array<{ name: string; type: "text" | "decimal" | "date" | "count" }>;
  pageSize: number;
}

export function compileNamedRead(input: MiniAppNamedRead, offset: number): CompiledNamedRead {
  const { binding, queryId, parameters } = input;
  if (!binding || typeof binding !== "object" || !binding.source || !binding.fields || !binding.queries ||
      typeof binding.source.schema !== "string" || typeof binding.source.table !== "string" ||
      typeof binding.fields !== "object" || Array.isArray(binding.fields) || typeof binding.queries !== "object" || Array.isArray(binding.queries) ||
      !validName(binding.id) || !validName(queryId) || !binding.source.schema || !binding.source.table ||
      binding.source.schema.length > 200 || binding.source.table.length > 200 ||
      hasControl(binding.source.schema + binding.source.table) ||
      ["omb_results", "omb_data_internal", "information_schema", "pg_catalog"].includes(binding.source.schema.toLowerCase()) ||
      Object.keys(binding.fields).length < 1 || Object.keys(binding.fields).length > 64 || JSON.stringify(binding).length > QUERY_MAX) {
    invalid("Invalid Data binding.");
  }
  for (const [name, field] of Object.entries(binding.fields)) {
    if (!field || typeof field !== "object" || typeof field.column !== "string" || typeof field.sourceType !== "string" ||
        !validName(name) || !field.column || field.column.length > 200 || hasControl(field.column) || !field.sourceType || field.sourceType.length > 100 ||
        !["text", "decimal", "date"].includes(field.as) ||
        (field.as === "decimal" && (!Number.isInteger(field.scale) || field.scale < 0 || field.scale > 18))) invalid(`Invalid Data field ${name}.`);
  }
  const query = binding.queries[queryId];
  if (!query || typeof query !== "object") invalid(`Unknown Data query ${queryId}.`);
  if (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > PAGE_MAX ||
      !Array.isArray(query.filters) || query.filters.length > 12 || !Array.isArray(query.orderBy) || query.orderBy.length > 4 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - PAGE_MAX) invalid("Invalid Data query limits.");
  if (parameters === null || Array.isArray(parameters) || typeof parameters !== "object" || JSON.stringify(parameters).length > 16_000) badParameter("Invalid Data parameters.");
  if (!query.parameters || Array.isArray(query.parameters) || typeof query.parameters !== "object") invalid("Invalid Data parameter declarations.");
  for (const [name, specification] of Object.entries(query.parameters)) {
    if (!specification || typeof specification !== "object" || !validName(name) || !["text", "decimal", "date"].includes(specification.type)) invalid(`Invalid Data parameter ${name}.`);
  }
  for (const name of Object.keys(parameters)) if (!Object.hasOwn(query.parameters, name)) badParameter(`Unexpected Data parameter ${name}.`);

  const values: string[] = [];
  const conditions: string[] = [];
  const used = new Set<string>();
  for (const filter of query.filters) {
    if (!filter || typeof filter !== "object") invalid("Invalid Data filter.");
    const field = fieldOf(binding, filter.field);
    if (!["eq", "in", "lt", "lte", "gt", "gte"].includes(filter.op) || ("literal" in filter) === ("parameter" in filter)) invalid("Invalid Data filter.");
    if ("literal" in filter) {
      if (String(filter.op) === "in") invalid("Literal Data filters must be scalar.");
      checkValue(filter.literal, field, filter.field);
      values.push(filter.literal);
      const operator = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[filter.op];
      conditions.push(`${sourceField(field)} ${operator} CAST(? AS ${sqlType(field)})`);
      continue;
    }
    const parameter = query.parameters[filter.parameter];
    if (!parameter || typeOf(field) !== parameter.type || (filter.op === "in") !== Boolean(parameter.list)) invalid(`Invalid Data filter ${filter.parameter}.`);
    used.add(filter.parameter);
    const supplied = parameters[filter.parameter];
    if (supplied === undefined) {
      if (parameter.optional) continue;
      badParameter(`Missing Data parameter ${filter.parameter}.`);
    }
    const expression = sourceField(field);
    if (parameter.list) {
      if (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > LIST_MAX) badParameter(`Invalid list ${filter.parameter}.`);
      for (const value of supplied) checkValue(value, field, filter.parameter);
      values.push(...supplied);
      conditions.push(`${expression} IN (${supplied.map(() => `CAST(? AS ${sqlType(field)})`).join(", ")})`);
    } else {
      if (typeof supplied !== "string") badParameter(`Invalid ${filter.parameter} value.`);
      checkValue(supplied, field, filter.parameter);
      values.push(supplied);
      const operator = { eq: "=", lt: "<", lte: "<=", gt: ">", gte: ">=" }[filter.op as "eq" | "lt" | "lte" | "gt" | "gte"];
      conditions.push(`${expression} ${operator} CAST(? AS ${sqlType(field)})`);
    }
  }
  for (const name of Object.keys(query.parameters)) if (!used.has(name)) invalid(`Unused Data parameter ${name}.`);

  const columns: CompiledNamedRead["columns"] = [];
  const selected: string[] = [];
  const grouping: string[] = [];
  const sortExpressions = new Map<string, string>();
  if (query.kind === "rows") {
    if (!Array.isArray(query.columns) || query.columns.length < 1 || query.columns.length > 32 || new Set(query.columns).size !== query.columns.length) invalid("Invalid Data row columns.");
    for (const name of query.columns) {
      const field = fieldOf(binding, name);
      columns.push({ name, type: field.as });
      selected.push(`${rendered(sourceField(field))} AS ${quoteIdentifier(name)}`);
      sortExpressions.set(name, sourceField(field));
    }
  } else if (query.kind === "aggregate") {
    if (!Array.isArray(query.groupBy) || query.groupBy.length > 4 || new Set(query.groupBy).size !== query.groupBy.length ||
        !Array.isArray(query.measures) || query.measures.length < 1 || query.measures.length > 12) invalid("Invalid Data aggregation.");
    for (const name of query.groupBy) {
      const field = fieldOf(binding, name);
      const expression = sourceField(field);
      columns.push({ name, type: field.as });
      selected.push(`${rendered(expression)} AS ${quoteIdentifier(name)}`);
      grouping.push(expression);
      sortExpressions.set(name, expression);
    }
    if (query.timeBucket) {
      const { name, field: source, unit } = query.timeBucket;
      const field = fieldOf(binding, source);
      if (field.as !== "date" || !validName(name) || !["day", "week", "month", "year"].includes(unit) || columns.some((column) => column.name === name)) invalid("Invalid Data time bucket.");
      const expression = `CAST(date_trunc('${unit}', ${sourceField(field)}) AS DATE)`;
      columns.push({ name, type: "date" });
      selected.push(`${rendered(expression)} AS ${quoteIdentifier(name)}`);
      grouping.push(expression);
      sortExpressions.set(name, expression);
    }
    for (const measure of query.measures) {
      if (!measure || typeof measure !== "object") invalid("Invalid Data measure.");
      if (!validName(measure.name) || columns.some((column) => column.name === measure.name)) invalid(`Invalid Data measure ${measure.name}.`);
      if (measure.op === "count") {
        columns.push({ name: measure.name, type: "count" });
        const expression = measure.field ? `count(${sourceField(fieldOf(binding, measure.field))})` : "count(*)";
        selected.push(`CAST(${expression} AS VARCHAR) AS ${quoteIdentifier(measure.name)}`);
        sortExpressions.set(measure.name, expression);
      } else {
        const field = fieldOf(binding, measure.field);
        if (measure.op === "sum" && field.as !== "decimal") invalid("Data sums require a decimal field.");
        if (!["sum", "min", "max"].includes(measure.op)) invalid("Invalid Data measure operation.");
        columns.push({ name: measure.name, type: field.as });
        const expression = `${measure.op}(${sourceField(field)})`;
        selected.push(`${rendered(expression)} AS ${quoteIdentifier(measure.name)}`);
        sortExpressions.set(measure.name, expression);
      }
    }
  } else invalid("Invalid Data query kind.");

  const output = new Set(columns.map((column) => column.name));
  const order: string[] = [];
  for (const item of query.orderBy) {
    if (!item || typeof item !== "object") invalid("Invalid Data sort.");
    if (!output.has(item.field) || !["asc", "desc"].includes(item.direction)) invalid(`Invalid Data sort ${item.field}.`);
    order.push(`${sortExpressions.get(item.field)} ${item.direction.toUpperCase()} NULLS LAST`);
  }
  if (query.kind === "rows") order.push("source.rowid");
  else for (const name of columns.slice(0, grouping.length).map((column) => column.name)) if (!query.orderBy.some((item) => item.field === name)) order.push(`${sortExpressions.get(name)} ASC NULLS LAST`);
  const from = `${quoteIdentifier(binding.source.schema)}.${quoteIdentifier(binding.source.table)} AS source`;
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  const group = grouping.length ? ` GROUP BY ${grouping.join(", ")}` : "";
  const sort = order.length ? ` ORDER BY ${order.join(", ")}` : "";
  const sql = `SELECT ${selected.join(", ")} FROM ${from}${where}${group}${sort} LIMIT ${query.pageSize + 1} OFFSET ${offset}`;
  return { sql, values, columns, pageSize: query.pageSize };
}

export function sourceColumns(binding: MiniAppDataBinding): Array<{ column: string; sourceType: string }> {
  return Object.values(binding.fields).map(({ column, sourceType }) => ({ column, sourceType }));
}

export function validateDataBindings(bindings: MiniAppDataBinding[]): void {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 32) invalid("Invalid Data bindings.");
  const bindingIds = new Set<string>();
  const queryIds = new Set<string>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") invalid("Invalid Data binding.");
    if (bindingIds.has(binding.id)) invalid(`Duplicate Data binding ${binding.id}.`);
    bindingIds.add(binding.id);
    if (!binding.queries || typeof binding.queries !== "object" || Array.isArray(binding.queries) || Object.keys(binding.queries).length < 1 || Object.keys(binding.queries).length > 32) invalid("Invalid named Data queries.");
    for (const [queryId, query] of Object.entries(binding.queries)) {
      if (!query || typeof query !== "object" || !query.parameters || typeof query.parameters !== "object" || Array.isArray(query.parameters)) invalid("Invalid named Data query.");
      if (queryIds.has(queryId)) invalid(`Duplicate Data query ${queryId}.`);
      queryIds.add(queryId);
      const parameters = Object.fromEntries(Object.entries(query.parameters ?? {}).map(([name, parameter]) => [name,
        parameter.list ? [parameter.type === "date" ? "2000-01-01" : parameter.type === "decimal" ? "0" : "sample"]
          : parameter.type === "date" ? "2000-01-01" : parameter.type === "decimal" ? "0" : "sample",
      ]));
      compileNamedRead({ ownerId: "validation", binding, queryId, parameters, scope: "validation" }, 0);
    }
  }
}
