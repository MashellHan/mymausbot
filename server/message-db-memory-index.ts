import type { DatabaseSync } from "node:sqlite";

import { cjkSearchText, ensureSearchIndex, withoutSearchMarks } from "./cjk-search.ts";

export interface MemoryEntryRecord {
  entryId: string;
  lineNo: number;
  text: string;
  recordedDate: string;
  validFrom: string;
  validUntil: string | null;
  supersededAt?: string | null;
  supersededBy?: string | null;
  struck: boolean;
}

export interface MemoryEntryHit {
  entryId: string;
  file: string;
  lineNo: number;
  snippet: string;
  recordedDate: string;
  validFrom: string;
  validUntil: string | null;
  supersededAt: string | null;
  struck: boolean;
  at: number;
}

export function ensureMemoryIndex(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_files (
      bot_id TEXT NOT NULL,
      path TEXT NOT NULL,
      text TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (bot_id, path)
    );
    CREATE TABLE IF NOT EXISTS memory_entries (
      bot_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      path TEXT NOT NULL,
      line_no INTEGER NOT NULL,
      text TEXT NOT NULL,
      search_text TEXT,
      recorded_date TEXT NOT NULL,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      superseded_at TEXT,
      superseded_by TEXT,
      struck INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL,
      PRIMARY KEY (bot_id, path, entry_id, line_no)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entries_active
      ON memory_entries(bot_id, struck, valid_from, valid_until);
    CREATE INDEX IF NOT EXISTS idx_memory_entries_path
      ON memory_entries(bot_id, path);
  `);
  ensureSearchIndex(db, { table: "memory_files", fts: "memory_fts", view: "memory_search", triggerPrefix: "memory_fts" });
  ensureSearchIndex(db, { table: "memory_entries", fts: "memory_entries_fts", view: "memory_entries_search", triggerPrefix: "memory_entries_fts" });
}

export interface MemoryFileStat {
  path: string;
  mtimeMs: number;
  bytes: number;
}

export interface MemoryHit {
  file: string;
  snippet: string;
  at: number;
}

export function upsertMemoryFile(
  database: DatabaseSync,
  botId: string,
  path: string,
  text: string,
  stat: { mtimeMs: number; bytes: number },
  entries?: readonly MemoryEntryRecord[],
): void {
  const mtimeMs = Math.trunc(stat.mtimeMs);
  database
    .prepare(
      "INSERT INTO memory_files (bot_id, path, text, mtime_ms, bytes, search_text) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(bot_id, path) DO UPDATE SET text = excluded.text, mtime_ms = excluded.mtime_ms, bytes = excluded.bytes, search_text = excluded.search_text",
    )
    .run(botId, path, text, mtimeMs, stat.bytes, cjkSearchText(text));
  if (entries !== undefined) replaceMemoryEntries(database, botId, path, mtimeMs, entries);
}

export function deleteMemoryFileRows(database: DatabaseSync, botId: string, path?: string): void {
  if (path !== undefined) {
    database.prepare("DELETE FROM memory_files WHERE bot_id = ? AND path = ?").run(botId, path);
    database.prepare("DELETE FROM memory_entries WHERE bot_id = ? AND path = ?").run(botId, path);
    return;
  }
  database.prepare("DELETE FROM memory_files WHERE bot_id = ?").run(botId);
  database.prepare("DELETE FROM memory_entries WHERE bot_id = ?").run(botId);
}

export function listIndexedMemoryFiles(database: DatabaseSync, botId: string): MemoryFileStat[] {
  const rows = database
    .prepare("SELECT path, mtime_ms, bytes FROM memory_files WHERE bot_id = ?")
    .all(botId) as Array<{ path: string; mtime_ms: number; bytes: number }>;
  return rows.map((row) => ({ path: row.path, mtimeMs: row.mtime_ms, bytes: row.bytes }));
}

export function queryMemoryFiles(
  database: DatabaseSync,
  match: string,
  botId: string,
  snippetTokens: number,
  limit: number,
  excludeNonTopic: boolean,
): MemoryHit[] {
  const rows = database
    .prepare(
      "SELECT f.path, f.mtime_ms, " +
        `snippet(memory_fts, 0, '[', ']', '…', ${snippetTokens}) AS snippet ` +
        "FROM memory_fts JOIN memory_files f ON f.rowid = memory_fts.rowid " +
        "WHERE memory_fts MATCH ? AND f.bot_id = ? " +
        (excludeNonTopic ? "AND f.path NOT IN ('MEMORY.md', 'memory/archive.md') AND f.path NOT LIKE 'memory/log/%' " : "") +
        "ORDER BY bm25(memory_fts), f.mtime_ms DESC LIMIT ?",
    )
    .all(match, botId, limit) as Array<{ path: string; mtime_ms: number; snippet: string }>;
  return rows.map((row) => ({ file: row.path, at: row.mtime_ms, snippet: withoutSearchMarks(row.snippet).replace(/\s+/g, " ").trim() }));
}

export function replaceMemoryEntries(
  database: DatabaseSync,
  botId: string,
  path: string,
  mtimeMs: number,
  entries: readonly MemoryEntryRecord[],
): void {
  database.prepare("DELETE FROM memory_entries WHERE bot_id = ? AND path = ?").run(botId, path);
  if (!entries.length) return;
  const insert = database.prepare(
    "INSERT INTO memory_entries (bot_id, entry_id, path, line_no, text, search_text, recorded_date, valid_from, valid_until, superseded_at, superseded_by, struck, mtime_ms) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const entry of entries) {
    insert.run(
      botId,
      entry.entryId,
      path,
      entry.lineNo,
      entry.text,
      cjkSearchText(entry.text),
      entry.recordedDate,
      entry.validFrom,
      entry.validUntil,
      entry.supersededAt ?? null,
      entry.supersededBy ?? null,
      entry.struck ? 1 : 0,
      mtimeMs,
    );
  }
}

export function queryMemoryEntries(
  database: DatabaseSync,
  match: string,
  botId: string,
  snippetTokens: number,
  options: { limit: number; today: string; includeHistorical?: boolean; includeUpcomingDays?: number },
): MemoryEntryHit[] {
  const includeHistorical = Boolean(options.includeHistorical);
  const maxValidFrom = options.includeUpcomingDays && options.includeUpcomingDays > 0
    ? shiftCalendarDays(options.today, options.includeUpcomingDays)
    : options.today;
  const temporalClause = includeHistorical
    ? "AND (e.struck = 1 OR e.valid_until < ? OR e.path = 'memory/archive.md') "
    : "AND e.struck = 0 AND e.valid_from <= ? AND (e.valid_until IS NULL OR e.valid_until >= ?) AND e.path NOT IN ('MEMORY.md', 'memory/archive.md') AND e.path NOT LIKE 'memory/log/%' ";
  const args = includeHistorical
    ? [match, botId, options.today, options.limit]
    : [match, botId, maxValidFrom, options.today, options.limit];
  const rows = database
    .prepare(
      "SELECT e.entry_id, e.path, e.line_no, e.recorded_date, e.valid_from, e.valid_until, e.superseded_at, e.struck, e.mtime_ms, " +
        `snippet(memory_entries_fts, 0, '[', ']', '…', ${snippetTokens}) AS snippet ` +
        "FROM memory_entries_fts JOIN memory_entries e ON e.rowid = memory_entries_fts.rowid " +
        "WHERE memory_entries_fts MATCH ? AND e.bot_id = ? " +
        temporalClause +
        "ORDER BY bm25(memory_entries_fts), e.recorded_date DESC, e.mtime_ms DESC LIMIT ?",
    )
    .all(...args) as Array<{
      entry_id: string;
      path: string;
      line_no: number;
      recorded_date: string;
      valid_from: string;
      valid_until: string | null;
      superseded_at: string | null;
      struck: number;
      mtime_ms: number;
      snippet: string;
    }>;
  return rows.map((row) => ({
    entryId: row.entry_id,
    file: row.path,
    lineNo: row.line_no,
    recordedDate: row.recorded_date,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededAt: row.superseded_at,
    struck: row.struck !== 0,
    at: row.mtime_ms,
    snippet: withoutSearchMarks(row.snippet).replace(/\s+/g, " ").trim(),
  }));
}

function shiftCalendarDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
