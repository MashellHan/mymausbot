import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LocalAgentMember, LocalAgentTokenUsageWindow } from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION_FILE = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
const READ_BYTES = 512 * 1024;
const INITIAL_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const empty = () => ({ model: null, reasoningEffort: null, contextUsed: null, contextWindow: null, taskHint: null, lastActivityAt: null });
type Observation = Pick<LocalAgentMember, "model" | "reasoningEffort" | "contextUsed" | "contextWindow" | "taskHint"> & { lastActivityAt: number | null };
type SessionObservation = Observation & { tokenUsage24h: LocalAgentTokenUsageWindow; tokenUsage7d: LocalAgentTokenUsageWindow };
type TokenSample = { at: number | null; tokens: number | null; total: number | null; gap: boolean };
type Cached = { signature: string; identity: string; size: number; offset: number; observation: Observation; pendingLine: boolean;
  scanStart: number; firstAt: number | null; highestTotal: number | null; tokenSamples: TokenSample[] };

export function dashboardText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const clean = redactSecretsInText(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, limit).join("") : null;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const timestamp = (value: unknown): number | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const tokens = (value: unknown): number | null => {
  const usage = record(value);
  const direct = count(usage.total_tokens);
  if (direct !== null) return direct;
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  return input === null || output === null ? null : count(input + output);
};

export function codexSessionId(agent: Record<string, unknown>): string | null {
  const session = record(agent.agent_session);
  return agent.agent === "codex" && session.kind === "id" && session.agent === "codex" && typeof session.value === "string" && SESSION_ID.test(session.value)
    ? session.value.toLowerCase() : null;
}

function apply(observation: Observation, line: string, highestTotal: number | null): TokenSample | null {
  if (!line.includes('"turn_context"') && !line.includes('"event_msg"')) return null;
  let event: Record<string, unknown>;
  try { event = record(JSON.parse(line)); } catch { return line.includes('"token_count"') ? { at: null, tokens: null, total: null, gap: true } : null; }
  if (event.type !== "turn_context" && event.type !== "event_msg")
    return line.includes('"token_count"') ? { at: null, tokens: null, total: null, gap: true } : null;
  const at = timestamp(event.timestamp);
  if (at !== null && at > 0) observation.lastActivityAt = Math.max(observation.lastActivityAt ?? 0, at);
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
      const total = tokens(info.total_token_usage), delta = tokens(info.last_token_usage);
      const increase = total === null || highestTotal === null ? null : total - highestTotal;
      const valid = at !== null && at > 0 && increase !== null && delta !== null && delta <= increase;
      return { at, tokens: valid ? delta : null, total, gap: !valid || delta !== increase };
    }
  }
  return null;
}

function tokenUsage(cached: Cached, now: number, durationMs: number): LocalAgentTokenUsageWindow {
  const cutoff = now - durationMs;
  const complete = cached.scanStart === 0 || cached.firstAt !== null && cached.firstAt <= cutoff;
  let known = 0;
  let invalid = cached.pendingLine;
  for (const sample of cached.tokenSamples) {
    if (sample.at === null || sample.at > now) { invalid = true; continue; }
    if (sample.at <= cutoff) continue;
    if (sample.gap) invalid = true;
    if (sample.tokens === null || !Number.isSafeInteger(known + sample.tokens)) { invalid = true; continue; }
    known += sample.tokens;
  }
  return complete && !invalid ? { coverage: "ready" as const, knownTokens: known }
    : { coverage: "partial" as const, knownTokens: known > 0 ? known : null };
}

async function entries(path: string): Promise<Dirent[]> {
  try { return (await readdir(path, { withFileTypes: true })).sort((a, b) => b.name.localeCompare(a.name)); }
  catch { return []; }
}

export async function discoverCodexSessionFiles(codexHome: string, ids: Set<string>) {
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

async function readObservation(file: string, id: string, cached: Cached | undefined, now: number): Promise<Cached | null> {
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
      const lines = end >= first ? bytes.toString("utf8", first, end).split("\n") : [];
      let firstAt = incremental ? cached.firstAt : null;
      if (!incremental && lines.length) {
        try { firstAt = timestamp(record(JSON.parse(lines[0]!)).timestamp); } catch { firstAt = null; }
      }
      const tokenSamples = incremental ? [...cached.tokenSamples] : [];
      let highestTotal = incremental ? cached.highestTotal : start === 0 ? 0 : null;
      for (const line of lines) {
        const sample = apply(observation, line, highestTotal);
        if (sample) {
          tokenSamples.push(sample);
          if (sample.total !== null) highestTotal = Math.max(highestTotal ?? 0, sample.total);
        }
      }
      const cutoff = now - WEEK_MS;
      const baseline = tokenSamples.filter((sample) => sample.at !== null && sample.at <= cutoff).at(-1);
      const recent = tokenSamples.filter((sample) => sample.at === null || sample.at > cutoff);
      return { identity, signature, size: info.size, offset: end >= 0 ? start + end + 1 : start, observation,
        scanStart: incremental ? cached.scanStart : start, firstAt, highestTotal, pendingLine: end < bytesRead - 1,
        tokenSamples: baseline ? [baseline, ...recent] : recent };
    } finally { await handle.close(); }
  } catch { return null; }
}

export function createLocalAgentSessionReader(codexHome: string, now: () => number) {
  let paths = new Map<string, string | null>();
  const cache = new Map<string, Cached>();
  let discoveredAt = -Infinity;
  let requested = "";
  return async (agents: Record<string, unknown>[]): Promise<Map<string, SessionObservation>> => {
    const ids = new Set(agents.map(codexSessionId).filter((id): id is string => id !== null).slice(0, 64));
    const key = [...ids].sort().join(",");
    if (key !== requested || now() - discoveredAt >= 10_000) {
      paths = ids.size ? await discoverCodexSessionFiles(codexHome, ids) : new Map();
      discoveredAt = now(); requested = key;
    }
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    const result = new Map<string, SessionObservation>();
    const at = now();
    for (const id of ids) {
      const file = paths.get(id);
      const value = file ? await readObservation(file, id, cache.get(id), at) : null;
      if (value) cache.set(id, value); else cache.delete(id);
      result.set(id, value ? { ...value.observation,
        tokenUsage24h: tokenUsage(value, at, DAY_MS), tokenUsage7d: tokenUsage(value, at, WEEK_MS) }
        : { ...empty(), tokenUsage24h: { coverage: "unavailable", knownTokens: null },
          tokenUsage7d: { coverage: "unavailable", knownTokens: null } });
    }
    return result;
  };
}
