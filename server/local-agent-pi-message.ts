import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { LocalAgentActivityEvent } from "../shared/local-dashboard.ts";
import type { PiContextBinding } from "./local-agent-pi-context.ts";
import { piVisibleMessageText, redactedAgentText, redactedAgentToolArguments,
  redactedAgentToolResult, trackAgentToolCalls } from "./local-agent-visible-message.ts";

const SESSION_ID = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const SESSION_FILE = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_(${SESSION_ID})\\.jsonl$`, "i");
const ENTRY_ID = new RegExp(`^(?:[0-9a-f]{8}|${SESSION_ID})$`, "i");
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const HEADER_BYTES = 64 * 1024;
const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_EVENTS = 60;
const MAX_TOOL_EVENTS = 30;

type PiIdentity = { pane: string; file: string; directory: string; id: string; cwd: string };
export type PiSessionView = { preview: string | null; model: string | null; reasoningEffort: string | null;
  contextWindow: null; events: LocalAgentActivityEvent[]; truncated: boolean;
  contextBinding?: Omit<PiContextBinding, "pane"> };
type Cached = { signature: string; cwd: string; id: string; view: PiSessionView };
type EntryEvent = { event: LocalAgentActivityEvent; callId?: string; clipped?: boolean };
type Entry = { parent: string | null; preview: string | null; events: EntryEvent[]; clipped: boolean;
  model?: string | null; provider?: string; reasoningEffort?: string | null };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const modelId = (provider: unknown, model: unknown): string | null =>
  typeof provider === "string" && MODEL.test(provider) && redactedAgentText(provider).text === provider &&
  typeof model === "string" && MODEL.test(model) && redactedAgentText(model).text === model ? model : null;
const thinkingLevel = (value: unknown): string | null => typeof value === "string" && THINKING_LEVELS.has(value) ? value : null;
const revision = (stat: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

// Pi 1.5.1 names sessions by the resolved cwd and UUID under its configured agent directory.
function piIdentity(agent: Record<string, unknown>, root: string): PiIdentity | null {
  const session = record(agent.agent_session);
  const cwd = agent.cwd;
  const file = session.value;
  const pane = agent.pane_id;
  if (agent.agent !== "pi" || session.kind !== "path" || session.agent !== "pi" || session.source !== "herdr:pi" ||
      typeof cwd !== "string" || !isAbsolute(cwd) || cwd !== resolve(cwd) || cwd.length > 4096 || cwd.includes("\0") ||
      typeof file !== "string" || !isAbsolute(file) || file !== resolve(file) || file.length > 8192 || file.includes("\0") ||
      typeof pane !== "string" || !isAbsolute(root) || root !== resolve(root)) return null;
  const id = SESSION_FILE.exec(basename(file))?.[1];
  if (!id) return null;
  const directory = join(root, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
  return file === join(directory, basename(file)) ? { pane, file, directory, id, cwd } : null;
}

async function readRange(handle: FileHandle, length: number, position: number): Promise<Buffer | null> {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length;) {
    const read = await handle.read(bytes, offset, length - offset, position + offset);
    if (!read.bytesRead) return null;
    offset += read.bytesRead;
  }
  return bytes;
}

function eventAt(row: Record<string, unknown>): number | null {
  const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(at) ? at : null;
}

function visibleEvents(row: Record<string, unknown>, offset: number, user: string | null, assistant: string | null): EntryEvent[] {
  const events: EntryEvent[] = [];
  const add = (kind: LocalAgentActivityEvent["kind"], text: string, tool: string | null = null, callId?: string, clipped = false) => {
    events.push({ event: { id: `e${offset.toString(36)}-${events.length}`, at: eventAt(row), kind, tool, text }, callId, clipped });
  };
  if (user !== null) add("user", user);
  if (assistant !== null) add("assistant", assistant);
  const message = record(row.message);
  if (row.type !== "message") return events;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    for (const part of message.content) {
      const block = record(part);
      if (block.type !== "toolCall" || typeof block.id !== "string" || !block.id || block.id.length > 128) continue;
      const name = block.name;
      if (typeof name !== "string" || !TOOL_NAME.test(name) || redactedAgentText(name).text !== name) {
        add("tool-call", "[Arguments unavailable]", null, block.id);
        continue;
      }
      const detail = redactedAgentToolArguments(block.arguments);
      add("tool-call", detail.text ?? "[Arguments unavailable]", name, block.id, detail.clipped);
    }
  } else if (message.role === "toolResult" && typeof message.toolCallId === "string" &&
      message.toolCallId.length > 0 && message.toolCallId.length <= 128) {
    const detail = redactedAgentToolResult(message.content);
    add("tool-result", detail.text ?? "[Result details unavailable]", null, message.toolCallId, detail.clipped);
  }
  return events;
}

function sessionView(bytes: Buffer, start: number, headerEnd: number, identity: PiIdentity, file: string): PiSessionView | null {
  const first = start === 0 ? headerEnd + 1 : bytes.indexOf(10) + 1;
  const end = bytes.lastIndexOf(10);
  if (first <= 0 || end < first || end !== bytes.length - 1) return null;
  const entries = new Map<string, Entry>();
  let leaf: string | null = null;
  for (let cursor = first; cursor < end;) {
    const next = bytes.indexOf(10, cursor);
    if (next < 0 || next - cursor > MAX_LINE_BYTES) return null;
    let row: Record<string, unknown>;
    try { row = record(JSON.parse(bytes.toString("utf8", cursor, next))); } catch { return null; }
    const id = row.id;
    const parent = row.parentId;
    if (typeof row.type !== "string" || row.type === "session" || typeof id !== "string" || !ENTRY_ID.test(id) ||
        (parent !== null && (typeof parent !== "string" || !ENTRY_ID.test(parent))) || entries.has(id)) return null;
    const user = piVisibleMessageText(row, "user");
    const assistant = piVisibleMessageText(row, "assistant");
    const message = record(row.message);
    const metadata = row.type === "model_change" ? { model: modelId(row.provider, row.modelId), provider: row.provider }
      : row.type === "thinking_level_change" ? { reasoningEffort: thinkingLevel(row.thinkingLevel) }
        : row.type === "message" && message.role === "assistant" ? {
          ...(message.model !== undefined || message.provider !== undefined
            ? { model: modelId(message.provider, message.model), provider: message.provider } : {}),
          ...(message.thinkingLevel !== undefined ? { reasoningEffort: thinkingLevel(message.thinkingLevel) } : {}),
        } : {};
    entries.set(id, { parent, preview: assistant?.text ?? null,
      events: visibleEvents(row, start + cursor, user?.text ?? null, assistant?.text ?? null),
      clipped: Boolean(user?.clipped || assistant?.clipped), model: metadata.model,
      provider: typeof metadata.provider === "string" && metadata.model ? metadata.provider : undefined,
      reasoningEffort: metadata.reasoningEffort });
    if (entries.size > MAX_ENTRIES) return null;
    leaf = id;
    cursor = next + 1;
  }
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let preview: string | null = null;
  for (let id = leaf; id !== null;) {
    if (seen.has(id)) return null;
    seen.add(id);
    const entry = entries.get(id);
    if (!entry) {
      if (start === 0) return null;
      break;
    }
    branch.push(entry);
    preview ??= entry.preview;
    id = entry.parent;
  }
  const events: LocalAgentActivityEvent[] = [];
  const toolCalls = trackAgentToolCalls();
  let truncated = start > 0;
  let model: string | null = null;
  let provider: string | undefined;
  let reasoningEffort: string | null = null;
  for (const entry of branch.reverse()) {
    if (entry.model !== undefined) {
      model = entry.model;
      provider = entry.provider;
    }
    if (entry.reasoningEffort !== undefined) reasoningEffort = entry.reasoningEffort;
    if (entry.clipped) truncated = true;
    for (const { event, callId, clipped } of entry.events) {
      if (clipped) truncated = true;
      if (callId && event.kind === "tool-call") {
        toolCalls.record(callId, event.tool);
        if (!event.tool) continue;
      } else if (callId && event.kind === "tool-result") {
        toolCalls.associate(callId, event);
      }
      events.push(event);
      if (event.kind === "tool-call" || event.kind === "tool-result") {
        const tools = events.filter((item) => item.kind === "tool-call" || item.kind === "tool-result");
        if (tools.length > MAX_TOOL_EVENTS) { events.splice(events.indexOf(tools[0]!), 1); truncated = true; }
      }
      if (events.length > MAX_EVENTS) { events.shift(); truncated = true; }
    }
  }
  return { preview, model, reasoningEffort, contextWindow: null, events, truncated,
    ...(leaf && model && provider ? { contextBinding: { sessionId: identity.id, file, cwd: identity.cwd, leaf, provider, model } } : {}) };
}

async function readSession(identity: PiIdentity, root: string, cached: Cached | undefined): Promise<Cached | null> {
  try {
    const canonicalRoot = await realpath(root);
    const canonicalDirectory = await realpath(identity.directory);
    if (canonicalDirectory !== join(canonicalRoot, basename(identity.directory))) return null;
    const entry = await lstat(identity.file, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() ||
        await realpath(identity.file) !== join(canonicalDirectory, basename(identity.file))) return null;
    const handle = await open(identity.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino || info.size !== entry.size ||
          info.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      const signature = revision(info);
      if (revision(await lstat(identity.file, { bigint: true })) !== signature) return null;
      if (cached?.signature === signature && cached.cwd === identity.cwd && cached.id === identity.id) return cached;
      const size = Number(info.size);
      const head = await readRange(handle, Math.min(size, HEADER_BYTES), 0);
      const headerEnd = head?.indexOf(10) ?? -1;
      if (!head || headerEnd < 0) return null;
      let header: Record<string, unknown>;
      try { header = record(JSON.parse(head.toString("utf8", 0, headerEnd))); } catch { return null; }
      if (header.type !== "session" || header.version !== 3 || header.id !== identity.id || header.cwd !== identity.cwd) return null;
      const start = Math.max(0, size - TAIL_BYTES);
      const tail = await readRange(handle, size - start, start);
      if (!tail || revision(await handle.stat({ bigint: true })) !== signature ||
          revision(await lstat(identity.file, { bigint: true })) !== signature) return null;
      const view = sessionView(tail, start, headerEnd, identity, join(canonicalDirectory, basename(identity.file)));
      return view ? { signature, cwd: identity.cwd, id: identity.id, view } : null;
    } finally { await handle.close(); }
  } catch { return null; }
}

export function createPiSessionReader(agentDirectory: string) {
  const root = join(agentDirectory, "sessions");
  const cache = new Map<string, Cached>();
  return async (agents: Record<string, unknown>[]): Promise<Map<string, PiSessionView | null>> => {
    const identities = agents.map((agent) => piIdentity(agent, agentDirectory)).filter((value): value is PiIdentity => value !== null);
    if (identities.length > 64) { cache.clear(); return new Map(); }
    const counts = new Map<string, number>();
    for (const identity of identities) counts.set(identity.file, (counts.get(identity.file) ?? 0) + 1);
    for (const file of cache.keys()) if (!counts.has(file)) cache.delete(file);
    const views = new Map<string, PiSessionView | null>();
    for (const identity of identities) {
      if (counts.get(identity.file) !== 1) { cache.delete(identity.file); views.set(identity.pane, null); continue; }
      const value = await readSession(identity, root, cache.get(identity.file));
      if (value) cache.set(identity.file, value); else cache.delete(identity.file);
      views.set(identity.pane, value?.view ?? null);
    }
    return views;
  };
}
