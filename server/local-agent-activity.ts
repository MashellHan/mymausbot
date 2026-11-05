import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LocalAgentActivityEvent, LocalAgentActivityResponse } from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { codexSessionId, discoverCodexSessionFiles } from "./local-agent-session.ts";
import { herdrRows, runHerdr, type HerdrRunner } from "./local-agent-teams.ts";

const PANE_ID = /^w\d+:p\d+$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_EVENTS = 60;
const MAX_TEXT = 600;
const DISCOVERY_MS = 10_000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unavailable = (agentId: string): LocalAgentActivityResponse => ({ agentId, status: "unavailable", updatedAt: null, truncated: false, events: [] });

function safeText(value: unknown): { text: string | null; clipped: boolean } {
  if (typeof value !== "string") return { text: null, clipped: false };
  const clean = redactSecretsInText(value)
    .replace(/\b(?:https?|file):\/\/[^\s"'`<>]+/gi, "[link]")
    .replace(/(^|[\s"'`=:(])\/[^\s"'`<>]+/gm, (_match, lead: string) => `${lead}[path]`)
    .replace(/(^|[\s"'`=:(])(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])[^\s"'`<>]+/gm, (_match, lead: string) => `${lead}[path]`)
    .replace(/\b[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)+\b/g, "[path]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return { text: chars.length ? chars.slice(0, MAX_TEXT).join("") : null, clipped: chars.length > MAX_TEXT };
}

function outputText(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  return value.slice(0, 4).map((part) => record(part).text).filter((text): text is string => typeof text === "string").join(" ");
}

function visibleEvent(line: string, offset: number, tools: Map<string, string>): { event: LocalAgentActivityEvent | null; clipped: boolean } {
  let row: Record<string, unknown>;
  try { row = record(JSON.parse(line)); } catch { return { event: null, clipped: true }; }
  const payload = record(row.payload);
  let kind: LocalAgentActivityEvent["kind"] | null = null;
  let tool: string | null = null;
  let rawText: unknown = null;
  if (row.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
    kind = payload.type === "user_message" ? "user" : "assistant";
    rawText = payload.message;
  } else if (row.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
    kind = "tool-call";
    tool = typeof payload.name === "string" && TOOL_NAME.test(payload.name) ? payload.name : null;
    rawText = payload.type === "function_call" ? payload.arguments : payload.input;
    if (typeof payload.call_id === "string" && payload.call_id.length <= 128 && tool) {
      tools.set(payload.call_id, tool);
      if (tools.size > 200) tools.delete(tools.keys().next().value!);
    }
  } else if (row.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
    kind = "tool-result";
    tool = typeof payload.call_id === "string" ? tools.get(payload.call_id) ?? null : null;
    rawText = outputText(payload.output);
  }
  if (kind === null) return { event: null, clipped: false };
  const { text, clipped } = safeText(rawText);
  if (text === null && (kind === "user" || kind === "assistant")) return { event: null, clipped };
  const time = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return { event: { id: `e${offset.toString(36)}`, at: Number.isFinite(time) ? time : null, kind, tool, text }, clipped };
}

async function readSession(file: string, sessionId: string): Promise<{ events: LocalAgentActivityEvent[]; truncated: boolean } | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size <= 0) return null;
    const head = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
    const firstRead = await handle.read(head, 0, head.length, 0);
    const endOfMeta = head.indexOf(10);
    if (endOfMeta < 0 || endOfMeta >= firstRead.bytesRead) return null;
    let meta: Record<string, unknown>;
    try { meta = record(JSON.parse(head.toString("utf8", 0, endOfMeta))); } catch { return null; }
    const recordedId = record(meta.payload).id;
    if (meta.type !== "session_meta" || typeof recordedId !== "string" || recordedId.toLowerCase() !== sessionId) return null;
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const bytes = Buffer.alloc(stat.size - start);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    if (bytesRead !== bytes.length) throw new Error("Session changed during read");
    const first = start === 0 ? 0 : bytes.indexOf(10) + 1;
    let truncated = start > 0;
    const events: LocalAgentActivityEvent[] = [];
    const tools = new Map<string, string>();
    for (let cursor = first; (start === 0 || first > 0) && cursor < bytesRead;) {
      const end = bytes.indexOf(10, cursor);
      if (end < 0) { truncated = true; break; }
      if (end - cursor > MAX_LINE_BYTES) truncated = true;
      else {
        const found = visibleEvent(bytes.toString("utf8", cursor, end), start + cursor, tools);
        if (found.clipped) truncated = true;
        if (found.event) {
          events.push(found.event);
          if (events.length > MAX_EVENTS) { events.shift(); truncated = true; }
        }
      }
      cursor = end + 1;
    }
    return { events, truncated };
  } finally { await handle.close(); }
}

export function createLocalAgentActivityProvider({ run = runHerdr, read = readSession, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), now = Date.now }: {
  run?: HerdrRunner; read?: typeof readSession; codexHome?: string; now?: () => number;
} = {}) {
  const paths = new Map<string, { file: string | null; at: number }>();
  const lastGood = new Map<string, { sessionId: string; file: string; response: LocalAgentActivityResponse }>();
  const latest = new Map<string, symbol>();

  async function refresh(agentId: string, current: () => boolean): Promise<LocalAgentActivityResponse> {
    if (!PANE_ID.test(agentId)) return unavailable(agentId);
    const clear = () => { if (current()) lastGood.delete(agentId); };
    let agents: Record<string, unknown>[];
    try { agents = herdrRows(await run(["--session", "default", "agent", "list"]), "agents"); }
    catch { clear(); return unavailable(agentId); }
    const matches = agents.filter((agent) => agent.pane_id === agentId && agent.workspace_id === agentId.split(":")[0]);
    if (matches.length !== 1) { clear(); return unavailable(agentId); }
    const agent = matches[0]!;
    if (agent.agent !== "codex") {
      clear();
      return { ...unavailable(agentId), status: "unsupported" };
    }
    const sessionId = codexSessionId(agent);
    if (!sessionId) { clear(); return unavailable(agentId); }
    const known = paths.get(sessionId);
    let file = known?.file;
    if (!known || !known.file || now() - known.at >= DISCOVERY_MS) {
      const found = await discoverCodexSessionFiles(codexHome, new Set([sessionId]));
      file = found.get(sessionId) ?? null;
      if (current()) paths.set(sessionId, { file, at: now() });
    }
    if (!file) { clear(); return unavailable(agentId); }
    try {
      const observed = await read(file, sessionId);
      if (!observed) { clear(); return unavailable(agentId); }
      const response: LocalAgentActivityResponse = { agentId, status: "ready", updatedAt: now(), ...observed };
      if (current()) lastGood.set(agentId, { sessionId, file, response });
      return response;
    } catch {
      const previous = lastGood.get(agentId);
      if (previous?.sessionId === sessionId && previous.file === file) return { ...previous.response, status: "stale" };
      clear();
      return unavailable(agentId);
    }
  }

  return {
    get(agentId: string): Promise<LocalAgentActivityResponse> {
      const request = Symbol();
      latest.set(agentId, request);
      const current = () => latest.get(agentId) === request;
      return refresh(agentId, current).finally(() => { if (current()) latest.delete(agentId); });
    },
  };
}
