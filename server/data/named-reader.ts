import type { MiniAppDataBinding, MiniAppNamedPage, MiniAppNamedRead, MiniAppSourceTable } from "../../shared/mini-app-data.ts";
import { compileNamedRead, sourceColumns } from "./named-query.ts";
import { DataCursorCodec } from "./cursor.ts";
import { quoteIdentifier } from "./sql-identifiers.ts";
import { DataFailure, type RunResult } from "./types.ts";

export interface NamedConnection {
  read(sql: string, maxRows?: number, values?: string[]): Promise<RunResult>;
  run(sql: string): Promise<unknown>;
}

export async function readNamedPage(
  input: MiniAppNamedRead, cursors: DataCursorCodec,
  readAt: (offset: number) => Promise<{ page: MiniAppNamedPage; hasMore: boolean }>,
): Promise<MiniAppNamedPage> {
  if (!input.scope || input.scope.length > 300 || (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))) {
    throw new DataFailure({ code: "invalid_input", message: "Invalid Data read scope or revision." });
  }
  const position = cursors.position(input);
  if (position && input.expectedRevision !== undefined && input.expectedRevision !== position.revision) {
    throw new DataFailure({ code: "write_refused", message: "Data revision changed while paging." });
  }
  const { page, hasMore } = await readAt(position?.offset ?? 0);
  if ((position && position.revision !== page.revision) || (input.expectedRevision !== undefined && input.expectedRevision !== page.revision)) {
    throw new DataFailure({ code: "write_refused", message: "Data revision changed; restart this query group." });
  }
  const nextOffset = (position?.offset ?? 0) + page.rows.length;
  return hasMore ? { ...page, nextCursor: cursors.next(input, page.revision, nextOffset) } : page;
}

export async function verifyBaseTable(connection: NamedConnection, binding: MiniAppDataBinding): Promise<void> {
  const tableSql = `SELECT table_type FROM information_schema.tables
    WHERE table_catalog = current_database() AND table_schema = ? AND table_name = ?`;
  const table = await connection.read(tableSql, 2, [binding.source.schema, binding.source.table]);
  if (table.rows.length !== 1 || table.rows[0]?.[0] !== "BASE TABLE") {
    throw new DataFailure({ code: "spec_invalid", message: "A named Data binding must reference a local base table." });
  }
  const columnSql = `SELECT column_name, data_type FROM information_schema.columns
    WHERE table_catalog = current_database() AND table_schema = ? AND table_name = ?`;
  const columns = await connection.read(columnSql, 257, [binding.source.schema, binding.source.table]);
  if (columns.rows.length > 256) throw new DataFailure({ code: "spec_invalid", message: "Data source has too many columns." });
  const actual = new Map(columns.rows.map((row) => [String(row[0]), String(row[1]).toUpperCase()]));
  for (const { column, sourceType } of sourceColumns(binding)) {
    if (actual.get(column) !== sourceType.toUpperCase()) {
      throw new DataFailure({ code: "spec_invalid", message: `Data source column ${column} changed or is missing.` });
    }
  }
}

export async function executeNamedRead(connection: NamedConnection, input: MiniAppNamedRead, offset: number): Promise<{ page: MiniAppNamedPage; hasMore: boolean }> {
  const compiled = compileNamedRead(input, offset);
  await connection.run("BEGIN TRANSACTION");
  let result: RunResult;
  let revision: number;
  try {
    await verifyBaseTable(connection, input.binding);
    result = await connection.read(compiled.sql, compiled.pageSize + 1, compiled.values);
    const revisionResult = await connection.read("SELECT revision FROM omb_data_internal.revision", 1);
    revision = Number(revisionResult.rows[0]?.[0] ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new DataFailure({ code: "sql_error", message: "Data revision is invalid." });
    await connection.run("COMMIT");
  } catch (error) {
    await connection.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
  const rows = result.rows.slice(0, compiled.pageSize).map((row) => row.map((cell) => cell === null ? null : String(cell)));
  if (Buffer.byteLength(JSON.stringify(rows)) > 256_000) throw new DataFailure({ code: "output_too_large", message: "Named Data page exceeds 256 KB." });
  return { page: { columns: compiled.columns, rows, revision }, hasMore: result.rows.length > compiled.pageSize };
}

export async function listSourceTables(connection: NamedConnection): Promise<MiniAppSourceTable[]> {
  await connection.run("BEGIN TRANSACTION");
  try {
    const tablesSql = `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_catalog = current_database() AND table_type = 'BASE TABLE'
        AND table_schema NOT IN ('information_schema', 'pg_catalog', 'omb_results', 'omb_data_internal', 'temp')
        AND table_schema NOT LIKE 'duckdb_%'
      ORDER BY table_schema, table_name`;
    const tables = await connection.read(tablesSql, 101);
    if (tables.rows.length > 100) throw new DataFailure({ code: "output_too_large", message: "Too many Data source tables." });
    const sources: MiniAppSourceTable[] = [];
    for (const [schemaCell, nameCell] of tables.rows) {
      const schema = String(schemaCell), name = String(nameCell);
      const columnsSql = `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_catalog = current_database() AND table_schema = ? AND table_name = ? ORDER BY ordinal_position`;
      const columns = await connection.read(columnsSql, 257, [schema, name]);
      if (columns.rows.length > 256) throw new DataFailure({ code: "output_too_large", message: "Data source has too many columns." });
      const count = await connection.read(`SELECT count(*) FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)}`, 1);
      const rowCount = Number(count.rows[0]?.[0] ?? 0);
      if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new DataFailure({ code: "output_too_large", message: "Data source row count exceeds the supported range." });
      sources.push({ schema, name, rowCount, columns: columns.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) })) });
    }
    await connection.run("COMMIT");
    return sources;
  } catch (error) {
    await connection.run("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
