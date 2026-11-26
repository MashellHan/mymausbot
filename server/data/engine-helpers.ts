import type * as DuckDB from "@duckdb/node-api";
import { DATA_LIMITS } from "../../shared/data-surface.ts";
import { DataFailure } from "./types.ts";

export type Binding = typeof DuckDB;
export type Cell = string | number | boolean | null;

const INTERRUPT_DELIVERY_MS = 10;

export const COMPARABLE_TYPE = /^(?!STRUCT|MAP|UNION|JSON|GEOMETRY|VARIANT)[^[\]]*$/;
export const NUMERIC_TYPE = /^(?:U?TINYINT|U?SMALLINT|U?INTEGER|U?BIGINT|U?HUGEINT|FLOAT|DOUBLE|REAL|DECIMAL\(|BIGNUM)/;
export const TEMPORAL_TYPE = /^(?:DATE|TIMESTAMP)/;

export function likePattern(filter: string): string {
  return `%${filter.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

export function closeNames(wanted: string, names: readonly string[], max = 5): string[] {
  const target = wanted.toLowerCase();
  const budget = Math.max(2, Math.floor(target.length / 3));
  return names
    .map((name) => {
      const folded = name.toLowerCase();
      const distance = levenshtein(target, folded);
      const prefix = folded.startsWith(target) || target.startsWith(folded);
      const related = prefix || folded.includes(target);
      return { name, distance, prefix, related };
    })
    .filter((entry) => entry.related || entry.distance <= budget)
    .sort((x, y) => Number(y.prefix) - Number(x.prefix) || x.distance - y.distance || x.name.localeCompare(y.name))
    .slice(0, max)
    .map((entry) => entry.name);
}

export function missingTableName(message: string): string | null {
  const match = /Table with name "?([^"\n]+?)"? does not exist/.exec(message);
  return match ? match[1] : null;
}

function parseLine(message: string): number | undefined {
  const match = /\bLINE (\d+):/.exec(message);
  return match ? Number(match[1]) : undefined;
}

type InterruptCause = "timeout" | "cancelled";
type RunState = { interrupted: InterruptCause | null; deadline: number; retry?: NodeJS.Timeout };

function failureFrom(error: unknown, sql: string, interrupted: InterruptCause | null, timeoutMs: number): DataFailure {
  if (error instanceof DataFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (interrupted === "timeout") {
    return new DataFailure({ code: "timeout", message, sql, retryable: true, hint: `Stopped after ${timeoutMs} ms. Narrow the query or aggregate first.` });
  }
  if (interrupted === "cancelled") return new DataFailure({ code: "cancelled", message, sql });
  const line = parseLine(message);
  if (missingTableName(message)) return new DataFailure({ code: "table_not_found", message, sql, line });
  return new DataFailure({ code: "sql_error", message, sql, line });
}

export class Lane {
  private queue: Promise<unknown> = Promise.resolve();
  private running: RunState | null = null;

  readonly connection: DuckDB.DuckDBConnection;
  constructor(connection: DuckDB.DuckDBConnection) { this.connection = connection; }

  run<T>(sql: string, options: { timeoutMs?: number; signal?: AbortSignal }, work: (connection: DuckDB.DuckDBConnection) => Promise<T>): Promise<T> {
    const turn = this.queue.then(() => this.execute(sql, options, work));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async execute<T>(sql: string, options: { timeoutMs?: number; signal?: AbortSignal }, work: (connection: DuckDB.DuckDBConnection) => Promise<T>): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DATA_LIMITS.sqlTimeoutMs;
    if (options.signal?.aborted) throw new DataFailure({ code: "cancelled", message: "Cancelled before it ran.", sql });
    const state: RunState = { interrupted: null, deadline: Date.now() + timeoutMs };
    this.running = state;
    const timer = setTimeout(() => this.stop(state, "timeout"), timeoutMs);
    const onAbort = () => this.stop(state, "cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await work(this.connection);
    } catch (error) {
      throw failureFrom(error, sql, state.interrupted, timeoutMs);
    } finally {
      clearTimeout(timer);
      if (state.retry) clearInterval(state.retry);
      options.signal?.removeEventListener("abort", onAbort);
      this.running = null;
    }
  }

  interrupt(): void {
    if (this.running) this.stop(this.running, "cancelled");
  }

  // DuckDB honours an interrupt only once its statement is dispatched, so a cause keeps re-delivering
  // until the statement settles: one that lands first is not lost, and no cause blocks the next.
  private stop(state: RunState, cause: InterruptCause): void {
    state.interrupted ??= cause;
    this.connection.interrupt();
    if (state.retry || Date.now() >= state.deadline) return;
    const retry = setInterval(() => {
      if (Date.now() >= state.deadline) {
        clearInterval(retry);
        state.retry = undefined;
        return;
      }
      this.connection.interrupt();
    }, INTERRUPT_DELIVERY_MS);
    state.retry = retry;
  }
}

export const CLOSE_DRAIN_MS = 10_000;

/** A statement DuckDB did not stop (seen on Windows) would otherwise hold a close, and shutdown, forever. */
export async function drainLanes(lanes: Array<{ run<T>(sql: string, options: object, work: () => Promise<T>): Promise<T> }>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const drained = Promise.all(lanes.map((lane) => lane.run("", {}, async () => undefined).catch(() => undefined))).then(() => true);
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref(); });
  try { return await Promise.race([drained, expired]); } finally { clearTimeout(timer); }
}

export function toCount(cell: Cell): number {
  return typeof cell === "string" ? Number(cell) : typeof cell === "number" ? cell : 0;
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

export function formatEpoch(seconds: number, dateOnly: boolean): string {
  const iso = new Date(seconds * 1000).toISOString();
  return dateOnly ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}
