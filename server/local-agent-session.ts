import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { LocalAgentMember, LocalAgentMemberTokenUsageWindow, LocalAgentTokenUsageWindow } from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { assistantMessagePreview } from "./local-agent-visible-message.ts";
import { createLocalTokenProjector, type DailyTokenObservation } from "./local-usage-models.ts";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION_FILE = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
const READ_BYTES = 512 * 1024;
const INITIAL_BYTES = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const empty = () => ({ model: null, reasoningEffort: null, contextUsed: null, contextWindow: null, taskHint: null, messagePreview: null, lastActivityAt: null });
export const unavailableMemberUsage = (): LocalAgentMemberTokenUsageWindow => ({
  coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
});
type Observation = Pick<LocalAgentMember, "model" | "reasoningEffort" | "contextUsed" | "contextWindow" | "taskHint"> & { messagePreview: string | null; lastActivityAt: number | null };
export type SessionObservation = Observation & {
  sessionCwd: string | null;
  sessionStartedAt: number | null;
  tokenUsage24h: LocalAgentTokenUsageWindow;
  tokenUsage7d: LocalAgentTokenUsageWindow;
  memberUsage: (switchedAt: number | null) => {
    tokenUsage24h: LocalAgentMemberTokenUsageWindow;
    tokenUsage7d: LocalAgentMemberTokenUsageWindow;
  };
};
type TokenSplit = { input: number; output: number; cacheRead: number };
type TokenSample = { at: number | null; tokens: number | null; total: number | null; gap: boolean; model: string | null; split: TokenSplit | null };
type PriorSample = { at: number; tokens: number; total: number | null };
type PriorHistory = {
  identity: string; size: number; highestTotal: number | null; hadTokens: boolean; lostAt: number | null;
  recentSamples: PriorSample[];
};
type Cached = {
  signature: string; identity: string; size: number; offset: number; observation: Observation; pendingLine: boolean;
  scanStart: number; firstAt: number | null; sessionCwd: string | null; sessionStartedAt: number | null; firstEventAt: number | null;
  highestTotal: number | null; lostAt: number | null; tokenSamples: TokenSample[];
};

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

function tokenSplit(last: Record<string, unknown>, expectedTokens: number): TokenSplit | null {
  const rawInput = count(last.input_tokens);
  const output = count(last.output_tokens);
  if (rawInput === null || output === null) return null;
  if (last.total_tokens !== undefined && count(last.total_tokens) !== rawInput + output) return null;
  if (rawInput + output !== expectedTokens) return null;
  const cached = count(last.cached_input_tokens);
  if (cached === null || cached > rawInput) return null;
  return { input: rawInput - cached, output, cacheRead: cached };
}

export function codexSessionId(agent: Record<string, unknown>): string | null {
  const session = record(agent.agent_session);
  return agent.agent === "codex" && session.kind === "id" && session.agent === "codex" && typeof session.value === "string" && SESSION_ID.test(session.value)
    ? session.value.toLowerCase() : null;
}

function apply(observation: Observation, line: string, highestTotal: number | null): TokenSample | null {
  const observed = line.includes("\"turn_context\"") || line.includes("\"event_msg\"");
  if (!observed && (!line.includes("\"response_item\"") || Buffer.byteLength(line) > 64 * 1024)) return null;
  let event: Record<string, unknown>;
  try { event = record(JSON.parse(line)); } catch { return observed && line.includes("\"token_count\"") ? { at: null, tokens: null, total: null, gap: true, model: null, split: null } : null; }
  if (event.type !== "turn_context" && event.type !== "event_msg" && event.type !== "response_item")
    return observed && line.includes("\"token_count\"") ? { at: null, tokens: null, total: null, gap: true, model: null, split: null } : null;
  const preview = Buffer.byteLength(line) <= 64 * 1024 ? assistantMessagePreview(event) : null;
  if (preview !== null) observation.messagePreview = preview;
  if (event.type === "response_item") return null;
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
      return {
        at, tokens: valid ? delta : null, total, gap: !valid || delta !== increase,
        model: observation.model, split: valid && delta !== null ? tokenSplit(last, delta) : null,
      };
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

const MAX_ACTIVE_STEP_MS = 5 * 60 * 1000;

function memberTokenUsage(
  cached: Cached, now: number, durationMs: number, switchedAt: number | null,
  projectTokens: ReturnType<typeof createLocalTokenProjector>,
): LocalAgentMemberTokenUsageWindow {
  const cutoff = now - durationMs;
  const startAt = cached.sessionStartedAt ?? cached.firstEventAt;
  const continuousFromCutoff = cached.scanStart === 0
    ? startAt !== null && startAt <= cutoff
    : cached.firstAt !== null && cached.firstAt <= cutoff;
  const seatContinuous = switchedAt === null || switchedAt <= cutoff;
  const logContinuous = cached.lostAt === null || cached.lostAt <= cutoff;
  let known = 0;
  let outputKnown = 0;
  let outputComplete = true;
  let activeMs = 0;
  let prevSampleAt: number | null = null;
  let invalid = cached.pendingLine;
  let hasUnattributed = false;
  const byModel = new Map<string, { provider: string; model: string; input: number; output: number; cacheRead: number }>();
  for (const sample of cached.tokenSamples) {
    if (sample.at === null || sample.at > now) { invalid = true; continue; }
    if (sample.at <= cutoff) { prevSampleAt = sample.at; continue; }
    if (switchedAt !== null && sample.at < switchedAt) { prevSampleAt = sample.at; continue; }
    if (sample.gap) invalid = true;
    if (sample.tokens === null || !Number.isSafeInteger(known + sample.tokens)) { invalid = true; continue; }
    known += sample.tokens;
    if (sample.tokens > 0) {
      const gap = prevSampleAt !== null ? sample.at - prevSampleAt : 0;
      activeMs += gap > 0 && gap <= MAX_ACTIVE_STEP_MS ? gap : 1000;
      if (sample.split && Number.isSafeInteger(outputKnown + sample.split.output)) {
        outputKnown += sample.split.output;
      } else {
        outputComplete = false;
      }
      if (!sample.model || !sample.split) {
        hasUnattributed = true;
        prevSampleAt = sample.at;
        continue;
      }
      const existing = byModel.get(sample.model);
      if (!existing) {
        byModel.set(sample.model, { provider: "codex", model: sample.model, ...sample.split });
      } else if (
        Number.isSafeInteger(existing.input + sample.split.input) &&
        Number.isSafeInteger(existing.output + sample.split.output) &&
        Number.isSafeInteger(existing.cacheRead + sample.split.cacheRead)
      ) {
        existing.input += sample.split.input;
        existing.output += sample.split.output;
        existing.cacheRead += sample.split.cacheRead;
      } else {
        hasUnattributed = true;
      }
    }
    prevSampleAt = sample.at;
  }
  const windowCovered = !invalid && continuousFromCutoff && seatContinuous && logContinuous;
  const coverage = windowCovered ? "ready" as const : known > 0 ? "partial" as const : "unavailable" as const;
  const knownTokens = coverage === "unavailable" ? null : known;
  if (coverage === "unavailable") return unavailableMemberUsage();
  if (coverage === "ready" && known === 0) {
    return {
      coverage,
      knownTokens: 0,
      outputTokens: 0,
      activeSeconds: 0,
      estimatedCost: projectTokens([{ input: 0, output: 0, cacheRead: 0, models: [] }], "ready").estimatedCost,
    };
  }
  const outputTokens = outputComplete ? outputKnown : null;
  const activeSeconds = activeMs > 0 ? Math.max(1, Math.round(activeMs / 1000)) : null;
  const models = [...byModel.values()];
  if (!models.length) {
    return { coverage, knownTokens, ...(outputTokens !== null ? { outputTokens } : {}), ...(activeSeconds !== null ? { activeSeconds } : {}), estimatedCost: { coverage: "unavailable", usd: null } };
  }
  const totals = models.reduce(
    (acc, row) => ({ input: acc.input + row.input, output: acc.output + row.output, cacheRead: acc.cacheRead + row.cacheRead }),
    { input: 0, output: 0, cacheRead: 0 },
  );
  const observation: DailyTokenObservation = { ...totals, models };
  const costInputCoverage = windowCovered && !hasUnattributed ? "ready" : "partial";
  return {
    coverage,
    knownTokens,
    ...(outputTokens !== null ? { outputTokens } : {}),
    ...(activeSeconds !== null ? { activeSeconds } : {}),
    estimatedCost: projectTokens([observation], costInputCoverage).estimatedCost,
  };
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

async function readObservation(
  file: string, id: string, cached: Cached | undefined, prior: PriorHistory | undefined, now: number,
): Promise<Cached | null> {
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
      const metaPayload = record(meta.payload);
      if (meta.type !== "session_meta" || String(metaPayload.id).toLowerCase() !== id) return null;
      const sessionCwd = typeof metaPayload.cwd === "string" && isAbsolute(metaPayload.cwd) ? metaPayload.cwd : null;
      const sessionStartedAt = timestamp(metaPayload.timestamp) ?? timestamp(meta.timestamp);
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
      let firstEventAt = incremental ? cached.firstEventAt : null;
      if ((incremental ? cached.scanStart === 0 : start === 0) && firstEventAt === null) {
        for (const line of lines) {
          if (!line.includes("\"timestamp\"")) continue;
          try {
            const at = timestamp(record(JSON.parse(line)).timestamp);
            if (at !== null && at > 0) { firstEventAt = at; break; }
          } catch {}
        }
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
      let lostAt = incremental ? cached.lostAt : (prior?.lostAt ?? null);
      if (prior && !incremental) {
        const identityChanged = identity !== prior.identity;
        const shrunk = info.size < prior.size;
        const regressedTotal = prior.highestTotal !== null && (highestTotal === null || highestTotal < prior.highestTotal);
        const lostObservedTokens = prior.hadTokens && !tokenSamples.some((sample) => (sample.tokens ?? 0) > 0);
        const missingPriorSample = prior.recentSamples.some((expected) =>
          expected.at > cutoff && !tokenSamples.some((actual) =>
            actual.at === expected.at && actual.tokens === expected.tokens && actual.total === expected.total,
          ),
        );
        if (identityChanged || shrunk || regressedTotal || lostObservedTokens || missingPriorSample) lostAt = now;
      }
      return { identity, signature, size: info.size, offset: end >= 0 ? start + end + 1 : start, observation,
        scanStart: incremental ? cached.scanStart : start, firstAt, sessionCwd, sessionStartedAt, firstEventAt, highestTotal,
        lostAt, pendingLine: end < bytesRead - 1, tokenSamples: baseline ? [baseline, ...recent] : recent };
    } finally { await handle.close(); }
  } catch { return null; }
}

export function createLocalAgentSessionReader(codexHome: string, now: () => number) {
  let paths = new Map<string, string | null>();
  const cache = new Map<string, Cached>();
  const history = new Map<string, PriorHistory>();
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
    for (const id of history.keys()) if (!ids.has(id)) history.delete(id);
    const result = new Map<string, SessionObservation>();
    const at = now();
    const projectTokens = createLocalTokenProjector(new Date(at));
    for (const id of ids) {
      const file = paths.get(id);
      const prior = history.get(id);
      const value = file ? await readObservation(file, id, cache.get(id), prior, at) : null;
      if (value) {
        cache.set(id, value);
        history.set(id, {
          identity: value.identity,
          size: value.size,
          highestTotal: value.highestTotal,
          hadTokens: Boolean(prior?.hadTokens || value.tokenSamples.some((sample) => (sample.tokens ?? 0) > 0)),
          lostAt: value.lostAt,
          recentSamples: value.tokenSamples
            .filter((sample): sample is TokenSample & { at: number; tokens: number } =>
              sample.at !== null && sample.tokens !== null && sample.at > at - WEEK_MS)
            .map((sample) => ({ at: sample.at, tokens: sample.tokens, total: sample.total })),
        });
      } else {
        cache.delete(id);
        if (prior) history.set(id, { ...prior, lostAt: at });
      }
      result.set(id, value ? {
        ...value.observation,
        sessionCwd: value.sessionCwd,
        sessionStartedAt: value.sessionStartedAt,
        tokenUsage24h: tokenUsage(value, at, DAY_MS),
        tokenUsage7d: tokenUsage(value, at, WEEK_MS),
        memberUsage: (switchedAt) => ({
          tokenUsage24h: memberTokenUsage(value, at, DAY_MS, switchedAt, projectTokens),
          tokenUsage7d: memberTokenUsage(value, at, WEEK_MS, switchedAt, projectTokens),
        }),
      } : {
        ...empty(),
        sessionCwd: null,
        sessionStartedAt: null,
        tokenUsage24h: { coverage: "unavailable", knownTokens: null },
        tokenUsage7d: { coverage: "unavailable", knownTokens: null },
        memberUsage: () => ({
          tokenUsage24h: unavailableMemberUsage(),
          tokenUsage7d: unavailableMemberUsage(),
        }),
      });
    }
    return result;
  };
}
