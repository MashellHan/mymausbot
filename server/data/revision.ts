import { DataFailure, type RunResult } from "./types.ts";

export async function ensureRevision(run: (statement: string) => Promise<unknown>): Promise<void> {
  await run("CREATE SCHEMA IF NOT EXISTS omb_data_internal");
  await run("CREATE TABLE IF NOT EXISTS omb_data_internal.revision (revision BIGINT NOT NULL)");
  await run("INSERT INTO omb_data_internal.revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM omb_data_internal.revision)");
}

export async function readRevision(read: (statement: string) => Promise<RunResult>, run: (statement: string) => Promise<unknown>): Promise<number> {
  await ensureRevision(run);
  const result = await read("SELECT revision FROM omb_data_internal.revision");
  const revision = Number(result.rows[0]?.[0] ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new DataFailure({ code: "sql_error", message: "Data revision is invalid." });
  return revision;
}

export async function commitBusinessCreate(
  sql: string, maxRows: number,
  read: (statement: string, limit: number) => Promise<RunResult>,
  run: (statement: string) => Promise<unknown>,
): Promise<{ result: RunResult; revision: number }> {
  await run("BEGIN TRANSACTION");
  try {
    const result = await read(sql, maxRows);
    const updated = await read("UPDATE omb_data_internal.revision SET revision = revision + 1 RETURNING revision", 1);
    const revision = Number(updated.rows[0]?.[0] ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Data revision is invalid.");
    await run("COMMIT");
    return { result, revision };
  } catch (error) {
    await run("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
