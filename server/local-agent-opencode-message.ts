import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { LocalAgentActivityEvent } from "../shared/local-dashboard.ts";
import { MAX_ACTIVITY_EVENTS, MAX_ACTIVITY_HISTORY_EVENTS, type ActivityHistoryRead } from "./local-agent-activity-history.ts";
import { dashboardText } from "./local-agent-session.ts";
import { redactedVisibleText } from "./local-agent-visible-message.ts";

const RECENT_BYTES = 512 * 1024;
const HISTORY_BYTES = 4 * 1024 * 1024;
const ROW_BYTES = 1024 * 1024;
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;
const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type View = "preview" | "recent" | "history";
type MessageRead = ActivityHistoryRead & { preview: string | null; model: string | null; reasoningEffort: string | null };
type MessageStore = { messages: StatementSync; hasSession?: StatementSync; parts?: StatementSync };

function messageStores(db: DatabaseSync) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'session_v2', 'message', 'part', 'session')").all().map(({ name }) => name));
  const current: MessageStore | null = tables.has("session_message") ? {
    messages: db.prepare(`SELECT id, time_created AS at, type AS kind,
      CASE WHEN length(CAST(data AS BLOB)) <= ? AND json_valid(data) THEN
        CASE type
          WHEN 'user' THEN json_object('text', json_extract(data, '$.text'))
          ELSE json_object(
            'model', json_object('id', json_extract(data, '$.model.id'), 'variant', json_extract(data, '$.model.variant')),
            'content', json((SELECT json_group_array(json_object('type', 'text', 'text', json_extract(block.value, '$.text')) ORDER BY block.key)
              FROM json_each(data, '$.content') AS block
              WHERE CASE WHEN block.type = 'object' THEN json_extract(block.value, '$.type') = 'text'
                AND json_type(block.value, '$.text') = 'text'
                AND json_type(block.value, '$.synthetic') IS NOT 'true'
                AND json_type(block.value, '$.ignored') IS NOT 'true' END)))
        END
      END AS data
      FROM session_message WHERE session_id = ? AND type IN ('assistant', 'user')
      ORDER BY seq DESC LIMIT ?`),
    hasSession: tables.has("session_v2") ? db.prepare("SELECT 1 FROM session_v2 WHERE id = ? LIMIT 1") : undefined,
  } : null;
  const legacy: MessageStore | null = tables.has("message") && tables.has("part") ? {
    messages: db.prepare(`SELECT id, time_created AS at,
      CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data
      FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC LIMIT ?`),
    hasSession: tables.has("session") ? db.prepare("SELECT 1 FROM session WHERE id = ? LIMIT 1") : undefined,
    parts: db.prepare(`SELECT CASE WHEN length(CAST(data AS BLOB)) <= ? THEN data END AS data
      FROM part WHERE session_id = ? AND message_id = ?
      ORDER BY id ASC LIMIT 101`),
  } : null;
  const hasCurrent = legacy && current ? db.prepare("SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1") : null;
  return (id: string) => hasCurrent && !hasCurrent.get(id) && !current?.hasSession?.get(id) ? legacy : current ?? legacy;
}

function textParts(parts: unknown[]): string {
  return parts.flatMap((part) => {
    const block = object(part);
    return block.type === "text" && block.synthetic !== true && block.ignored !== true && typeof block.text === "string" ? [block.text] : [];
  }).join(" ");
}

function readMessages(store: MessageStore, sessionId: string, view: View): MessageRead | null {
  const limit = view === "history" ? MAX_ACTIVITY_HISTORY_EVENTS : MAX_ACTIVITY_EVENTS;
  const scanLimit = store.parts ? limit : MAX_ACTIVITY_HISTORY_EVENTS;
  const budget = view === "history" ? HISTORY_BYTES : RECENT_BYTES;
  const events: LocalAgentActivityEvent[] = [];
  let bytes = 0, rows = 0, truncated = false;
  let preview: string | null = null, model: string | null = null, reasoningEffort: string | null = null;
  const parse = (data: unknown): Record<string, unknown> | null => {
    if (typeof data !== "string") { truncated = true; return null; }
    bytes += Buffer.byteLength(data);
    if (bytes > budget) { truncated = true; return null; }
    try { return object(JSON.parse(data)); }
    catch { truncated = true; return null; }
  };
  for (const row of store.messages.iterate(ROW_BYTES, sessionId, scanLimit + 1)) {
    if (++rows > scanLimit) { truncated = true; break; }
    const data = parse(row.data);
    if (!data) { if (bytes > budget) break; continue; }
    const kind = store.parts ? data.role : row.kind;
    if ((kind !== "assistant" && kind !== "user") || typeof row.id !== "string" || row.id.length > 128) continue;
    if (kind === "assistant" && !model) {
      const { id, variant } = object(data.model);
      const reported = store.parts ? data.modelID : id;
      if (typeof reported === "string" && MODEL.test(reported) && dashboardText(reported, 120) === reported) {
        model = reported;
        const effort = store.parts ? data.variant : variant;
        reasoningEffort = typeof effort === "string" && EFFORTS.has(effort) ? effort : null;
      }
    }
    if (view === "preview" && kind === "user") continue;
    let raw = kind === "user" ? data.text : textParts(Array.isArray(data.content) ? data.content : []);
    if (store.parts) {
      const parts: Record<string, unknown>[] = [];
      let count = 0, complete = true;
      for (const part of store.parts.iterate(ROW_BYTES, sessionId, row.id)) {
        if (++count > 100) { truncated = true; complete = false; break; }
        const parsed = parse(part.data);
        if (!parsed) { complete = false; break; }
        parts.push(parsed);
      }
      if (bytes > budget) break;
      if (!complete) continue;
      raw = textParts(parts);
    }
    const visible = redactedVisibleText(raw, view === "preview" ? 400 : 600);
    if (visible.clipped) truncated = true;
    if (visible.text === null) continue;
    if (kind === "assistant" && preview === null) preview = visible.text;
    if (view === "preview") break;
    if (events.length === limit) { truncated = true; break; }
    const id = createHash("sha256").update(row.id).digest("hex").slice(0, 14);
    const at = typeof row.at === "number" && Number.isSafeInteger(row.at) && row.at > 0 ? row.at : null;
    events.push({ id: `e${id}`, at, kind, tool: null, text: visible.text });
  }
  if (!rows && !store.hasSession?.get(sessionId)) return null;
  return { preview, model, reasoningEffort, events: events.reverse(), truncated };
}

export function readOpenCodeMessages(file: string | null, ids: Iterable<string>, view: View): Map<string, MessageRead> {
  const result = new Map<string, MessageRead>();
  const sessions = new Set(ids);
  if (!file || !sessions.size) return result;
  let database: DatabaseSync | undefined;
  try {
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile()) return result;
    const db = new DatabaseSync(file, { readOnly: true });
    database = db;
    db.exec("BEGIN");
    const storeFor = messageStores(db);
    for (const id of sessions) {
      const store = storeFor(id);
      const read = store && readMessages(store, id, view);
      if (read) result.set(id, read);
    }
    const after = lstatSync(file, { bigint: true });
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return new Map();
    if (view === "history") {
      const historySource = {
        file: `${after.dev}:${after.ino}`, path: file, size: Number(after.size), revision: `${after.mtimeNs}:${after.ctimeNs}`,
      };
      for (const read of result.values()) read.historySource = historySource;
    }
    return result;
  } catch { return new Map(); }
  finally { database?.close(); }
}
