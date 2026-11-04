import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LocalAgentMember } from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION_FILE = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
const READ_BYTES = 512 * 1024;
const INITIAL_BYTES = 8 * 1024 * 1024;
const empty = () => ({ model: null, reasoningEffort: null, contextUsed: null, contextWindow: null, taskHint: null });
type Observation = Pick<LocalAgentMember, "model" | "reasoningEffort" | "contextUsed" | "contextWindow" | "taskHint">;
type Cached = { signature: string; identity: string; size: number; offset: number; observation: Observation };

export function dashboardText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const clean = redactSecretsInText(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, limit).join("") : null;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;

export function codexSessionId(agent: Record<string, unknown>): string | null {
  const session = record(agent.agent_session);
  return agent.agent === "codex" && session.kind === "id" && session.agent === "codex" && typeof session.value === "string" && SESSION_ID.test(session.value)
    ? session.value.toLowerCase() : null;
}

function apply(observation: Observation, line: string) {
  if (!line.includes('"turn_context"') && !line.includes('"event_msg"')) return;
  let event: Record<string, unknown>;
  try { event = record(JSON.parse(line)); } catch { return; }
  const payload = record(event.payload);
  if (event.type === "turn_context") {
    const model = typeof payload.model === "string" && MODEL.test(payload.model) ? payload.model : null;
    if (model !== observation.model) { observation.contextUsed = null; observation.contextWindow = null; }
    observation.model = model;
    const settings = record(record(payload.collaboration_mode).settings);
    observation.reasoningEffort = dashboardText(payload.effort ?? payload.reasoning_effort ?? settings.reasoning_effort, 40);
    if (count(payload.model_context_window)) observation.contextWindow = count(payload.model_context_window);
  } else if (event.type === "event_msg") {
    if (payload.type === "user_message") observation.taskHint = dashboardText(payload.message, 400);
    if (payload.type === "item_started" || payload.type === "item_completed") {
      const item = record(payload.item);
      if (item.type === "UserMessage") {
        const content = typeof item.content === "string" ? item.content : Array.isArray(item.content)
          ? item.content.map((part) => record(part).text).filter((text) => typeof text === "string").join(" ") : null;
        observation.taskHint = dashboardText(content, 400);
      }
    }
    if (payload.type === "task_started" && count(payload.model_context_window)) observation.contextWindow = count(payload.model_context_window);
    if (payload.type === "token_count") {
      const info = record(payload.info);
      if (count(info.model_context_window)) observation.contextWindow = count(info.model_context_window);
      const last = record(info.last_token_usage);
      const input = count(last.input_tokens), output = count(last.output_tokens);
      if (input !== null && output !== null) observation.contextUsed = count(input + output);
    }
  }
}

async function entries(path: string): Promise<Dirent[]> {
  try { return (await readdir(path, { withFileTypes: true })).sort((a, b) => b.name.localeCompare(a.name)); }
  catch { return []; }
}

async function discover(codexHome: string, ids: Set<string>) {
  const found = new Map<string, string | null>();
  let inspected = 0;
  const root = join(codexHome, "sessions");
  for (const year of await entries(root)) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const month of await entries(join(root, year.name))) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
      for (const day of await entries(join(root, year.name, month.name))) {
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
        const directory = join(root, year.name, month.name, day.name);
        const files = await entries(directory);
        inspected += files.length;
        if (inspected > 5000) return found;
        for (const file of files) {
          const id = file.isFile() ? SESSION_FILE.exec(file.name)?.[1]?.toLowerCase() : undefined;
          if (id && ids.has(id)) found.set(id, found.has(id) ? null : join(directory, file.name));
        }
      }
    }
  }
  return found;
}

async function readObservation(file: string, id: string, cached: Cached | undefined): Promise<Cached | null> {
  try {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) return null;
      const identity = `${info.dev}:${info.ino}`;
      const signature = `${identity}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      if (signature === cached?.signature) return cached;
      const head = Buffer.alloc(Math.min(info.size, 64 * 1024));
      const firstRead = await handle.read(head, 0, head.length, 0);
      const firstEnd = head.indexOf(10);
      if (firstEnd < 0 || firstEnd >= firstRead.bytesRead) return null;
      const meta = record(JSON.parse(head.toString("utf8", 0, firstEnd)));
      if (meta.type !== "session_meta" || String(record(meta.payload).id).toLowerCase() !== id) return null;
      const incremental = cached && cached.identity === identity && info.size > cached.size && info.size - cached.offset <= READ_BYTES;
      const start = incremental ? cached.offset : Math.max(0, info.size - INITIAL_BYTES);
      const bytes = Buffer.alloc(info.size - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      const first = !incremental && start > 0 ? bytes.indexOf(10) + 1 : 0;
      const end = bytes.lastIndexOf(10, bytesRead - 1);
      const observation: Observation = incremental ? { ...cached.observation } : empty();
      if (end >= first) for (const line of bytes.toString("utf8", first, end).split("\n")) apply(observation, line);
      return { identity, signature, size: info.size, offset: end >= 0 ? start + end + 1 : start, observation };
    } finally { await handle.close(); }
  } catch { return null; }
}

export function createLocalAgentSessionReader(codexHome: string, now: () => number) {
  let paths = new Map<string, string | null>();
  const cache = new Map<string, Cached>();
  let discoveredAt = -Infinity;
  let requested = "";
  return async (agents: Record<string, unknown>[]): Promise<Map<string, Observation>> => {
    const ids = new Set(agents.map(codexSessionId).filter((id): id is string => id !== null).slice(0, 64));
    const key = [...ids].sort().join(",");
    if (key !== requested || now() - discoveredAt >= 10_000) {
      paths = ids.size ? await discover(codexHome, ids) : new Map();
      discoveredAt = now(); requested = key;
    }
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    const result = new Map<string, Observation>();
    for (const id of ids) {
      const file = paths.get(id);
      const value = file ? await readObservation(file, id, cache.get(id)) : null;
      if (value) cache.set(id, value); else cache.delete(id);
      result.set(id, value?.observation ?? empty());
    }
    return result;
  };
}
