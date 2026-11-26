import { constants, lstatSync, readFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { LocalAgentActivityEvent, LocalAgentMemberTokenUsageWindow } from "../shared/local-dashboard.ts";
import { MAX_ACTIVITY_EVENTS, MAX_ACTIVITY_HISTORY_EVENTS, MAX_ACTIVITY_TOOL_EVENTS, isToolActivity, type ActivityHistoryRead } from "./local-agent-activity-history.ts";
import { inside } from "./local-agent-association.ts";
import { dashboardText, unavailableMemberUsage } from "./local-agent-session.ts";
import { createLocalTokenProjector, type DailyTokenObservation } from "./local-usage-models.ts";
import { redactedVisibleText, visibleToolDetail } from "./local-agent-visible-message.ts";

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_TAIL_BYTES = 512 * 1024;
const HISTORY_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_SETTINGS_BYTES = 256 * 1024;
const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/i;
const BYOM_MODEL = "MODEL_GOOGLE_GEMINI_INTERNAL_BYOM";
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;

interface AgyCustomModelEntry {
  modelId: string;
  maxTokens: number | null;
  effort: string | null;
}

interface AgySettingsInfo {
  defaultModel: string | null;
  byKey: Map<string, AgyCustomModelEntry>;
  byLabel: Map<string, AgyCustomModelEntry>;
}

interface TokenSample {
  at: number;
  tokens: number;
  observation: DailyTokenObservation;
}

export interface AgySessionObservation {
  sessionDir: string | null;
  sessionStartedAt: number | null;
  model: string | null;
  reasoningEffort: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
  taskHint: string | null;
  preview: string | null;
  lastActivityAt: number | null;
  events: LocalAgentActivityEvent[];
  truncated: boolean;
  historySource?: ActivityHistoryRead["historySource"];
  usage: (verifiedSince: number) => {
    tokenUsage24h: LocalAgentMemberTokenUsageWindow;
    tokenUsage7d: LocalAgentMemberTokenUsageWindow;
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Accepts Herdr's canonical Antigravity CLI session identity (`source: "herdr:antigravity_cli"` or `"herdr:agy"`). */
export function agySessionId(agent: Record<string, unknown>): string | null {
  const session = record(agent.agent_session);
  const id = session.value;
  return agent.agent === "agy" && session.agent === "agy" && session.kind === "id" &&
    (session.source === "herdr:antigravity_cli" || session.source === "herdr:agy") &&
    typeof id === "string" && SESSION_ID.test(id) ? id.toLowerCase() : null;
}

export function agyHomeDir(home: string): string {
  return join(home, ".gemini", "antigravity-cli");
}

function parseModelNameFromUri(modelName: unknown): string | null {
  if (typeof modelName !== "string") return null;
  const match = /\/models\/([^/:?#]+)$/.exec(modelName.trim());
  const id = match?.[1]?.trim();
  return id && MODEL.test(id) ? id : null;
}

function parseEffortFromLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const match = /\b(xhigh|high|medium|low|max)\b/i.exec(label);
  return match ? match[1]!.toLowerCase() : null;
}

function readAgySettings(agyHome: string): AgySettingsInfo {
  const empty: AgySettingsInfo = { defaultModel: null, byKey: new Map(), byLabel: new Map() };
  const file = join(agyHome, "settings.json");
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SETTINGS_BYTES) return empty;
    const parsed = record(JSON.parse(readFileSync(file, "utf8")));
    const defaultModel = typeof parsed.model === "string" ? parsed.model.trim() || null : null;
    const byKey = new Map<string, AgyCustomModelEntry>();
    const byLabel = new Map<string, AgyCustomModelEntry>();
    const custom = record(record(parsed.customModelsConfig).customModels);
    for (const [key, raw] of Object.entries(custom)) {
      const entry = record(raw);
      const modelId = parseModelNameFromUri(entry.modelName) ?? (MODEL.test(key) ? key : null);
      if (!modelId) continue;
      const maxTokens = whole(entry.maxTokens) && entry.maxTokens > 0 ? entry.maxTokens : null;
      const effort = parseEffortFromLabel(entry.label) ?? parseEffortFromLabel(key);
      const resolved: AgyCustomModelEntry = { modelId, maxTokens, effort };
      byKey.set(key, resolved);
      if (typeof entry.label === "string" && entry.label.trim()) {
        byLabel.set(entry.label.trim(), resolved);
      }
    }
    return { defaultModel, byKey, byLabel };
  } catch {
    return empty;
  }
}

/** Resolves an Agy pane's configured model/effort/contextWindow from `--model` argv or settings.json default, even before a first turn creates a transcript. */
export function resolveAgyConfiguredRuntime(home: string, configuredModel: string | null): {
  model: string; effort: string | null; contextWindow: number | null;
} | null {
  const settings = readAgySettings(agyHomeDir(home));
  return resolveConfiguredModel(configuredModel ?? settings.defaultModel, settings);
}

function resolveBuiltinModel(raw: string): { model: string; effort: string | null; contextWindow: number | null } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === BYOM_MODEL) return null;
  // Handle human-readable Agy settings labels such as "Gemini 4 Neon (High)" or "Gemini 4 Neon (1M / High)".
  const friendly = /^gemini\s+(4|3\.\d)\s+([a-z0-9-]+)(?:\s*\(([^)]+)\))?$/i.exec(trimmed);
  if (friendly) {
    const base = `gemini-${friendly[1]!.toLowerCase()}-${friendly[2]!.toLowerCase()}`;
    const effort = parseEffortFromLabel(friendly[3]) ?? null;
    const contextWindow = /^gemini-4-carbon$/i.test(base) ? 1_000_000 : 1_048_576;
    return { model: base, effort, contextWindow };
  }
  if (!MODEL.test(trimmed)) return null;
  const effortMatch = EFFORT_SUFFIX.exec(trimmed);
  const effort = effortMatch ? effortMatch[1]!.toLowerCase() : null;
  const base = effortMatch ? trimmed.slice(0, -effortMatch[0].length) : trimmed;
  const contextWindow = /^gemini-4-carbon$/i.test(base) ? 1_000_000
    : /^gemini-(?:4|3\.\d)/i.test(base) ? 1_048_576 : null;
  return { model: base, effort, contextWindow };
}

function resolveConfiguredModel(selector: string | null, settings: AgySettingsInfo): {
  model: string; effort: string | null; contextWindow: number | null;
} | null {
  if (!selector) return null;
  const custom = settings.byKey.get(selector) ?? settings.byLabel.get(selector);
  if (custom) {
    return { model: custom.modelId, effort: custom.effort, contextWindow: custom.maxTokens };
  }
  return resolveBuiltinModel(selector);
}

/** Extracts `--model <value>` from live pane process argv when Herdr pane process-info is available. */
export function agyModelFromArgv(argv: readonly unknown[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (typeof arg !== "string") continue;
    if (arg === "--model" && typeof argv[index + 1] === "string") {
      const value = (argv[index + 1] as string).trim();
      return value || null;
    }
    if (arg.startsWith("--model=")) {
      const value = arg.slice("--model=".length).trim();
      return value || null;
    }
  }
  return null;
}

/** Extracts `--conversation <uuid>` from live pane process argv when Herdr has not yet observed an Agy session ID. */
export function agyConversationFromArgv(argv: readonly unknown[]): string | null {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (typeof arg !== "string") continue;
    if ((arg === "--conversation" || arg === "-c") && typeof argv[index + 1] === "string") {
      const value = (argv[index + 1] as string).trim().toLowerCase();
      return SESSION_ID.test(value) ? value : null;
    }
    if (arg.startsWith("--conversation=")) {
      const value = arg.slice("--conversation=".length).trim().toLowerCase();
      return SESSION_ID.test(value) ? value : null;
    }
  }
  return null;
}

function readConversationWorkspaces(agyHome: string, sessionIds: readonly string[]): Map<string, string> {
  const dirs = new Map<string, string>();
  if (!sessionIds.length) return dirs;
  const file = join(agyHome, "conversation_summaries.db");
  let database: DatabaseSync | undefined;
  try {
    if (!lstatSync(file).isFile()) return dirs;
    const db = new DatabaseSync(file, { readOnly: true });
    database = db;
    const stmt = db.prepare("SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ? LIMIT 1");
    for (const id of sessionIds) {
      const row = stmt.get(id) as { workspace_uris?: unknown } | undefined;
      if (typeof row?.workspace_uris !== "string") continue;
      try {
        const uris = JSON.parse(row.workspace_uris);
        if (!Array.isArray(uris)) continue;
        for (const uri of uris) {
          if (typeof uri !== "string" || !uri.startsWith("file://")) continue;
          const path = fileURLToPath(uri);
          if (isAbsolute(path)) { dirs.set(id, path); break; }
        }
      } catch { /* ignore malformed workspace_uris */ }
    }
  } catch { /* summaries db is optional */ }
  finally { database?.close(); }
  return dirs;
}

function stripUserEnvelope(raw: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(raw);
  return match ? match[1]!.trim() : raw;
}

function agyWindowUsage(samples: readonly TokenSample[], cutoff: number, verifiedSince: number,
  sessionStartedAt: number | null, scanStart: number,
  project: ReturnType<typeof createLocalTokenProjector>): LocalAgentMemberTokenUsageWindow {
  const observed = samples.filter(({ at }) => at > cutoff && at >= verifiedSince);
  const knownTokens = observed.reduce((sum, row) => sum + row.tokens, 0);
  if (!Number.isSafeInteger(knownTokens)) return unavailableMemberUsage();
  if (!knownTokens) {
    const windowCovered = scanStart === 0 && sessionStartedAt !== null && sessionStartedAt <= cutoff && verifiedSince <= cutoff;
    if (!windowCovered) return unavailableMemberUsage();
    return {
      coverage: "ready",
      knownTokens: 0,
      estimatedCost: project([{ input: 0, output: 0, cacheRead: 0, models: [] }], "ready").estimatedCost,
    };
  }
  return {
    coverage: "partial",
    knownTokens,
    estimatedCost: project(observed.map(({ observation }) => observation), "partial").estimatedCost,
  };
}

export async function readAgySession(
  agyHome: string,
  sessionId: string,
  now: number,
  options: { history?: boolean; configuredModel?: string | null; sessionDir?: string | null; settings?: AgySettingsInfo } = {},
): Promise<AgySessionObservation | null> {
  if (!SESSION_ID.test(sessionId) || !isAbsolute(agyHome) || agyHome !== resolve(agyHome)) return null;
  const brainRoot = join(agyHome, "brain");
  const file = join(brainRoot, sessionId, ".system_generated", "logs", "transcript.jsonl");
  if (!inside(brainRoot, file)) return null;
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(brainRoot);
    canonicalFile = await realpath(file);
  } catch { return null; }
  if (!inside(canonicalRoot, canonicalFile)) return null;

  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch { return null; }

  const settings = options.settings ?? readAgySettings(agyHome);
  const configured = resolveConfiguredModel(options.configuredModel ?? settings.defaultModel, settings);
  const history = options.history === true;

  try {
    const stat = await handle.stat({ bigint: true });
    const size = Number(stat.size);
    if (!stat.isFile() || !Number.isSafeInteger(size) || size <= 0) return null;
    const maxBytes = history ? HISTORY_TAIL_BYTES : RECENT_TAIL_BYTES;
    const start = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    if (bytesRead !== bytes.length) return null;

    const first = start === 0 ? 0 : bytes.indexOf(10) + 1;
    let truncated = start > 0;
    const events: LocalAgentActivityEvent[] = [];
    const samples: TokenSample[] = [];
    let sessionStartedAt: number | null = null;
    let lastActivityAt: number | null = null;
    let model: string | null = configured?.model ?? null;
    let reasoningEffort: string | null = configured?.effort ?? null;
    let contextWindow: number | null = configured?.contextWindow ?? null;
    let contextUsed: number | null = null;
    let taskHint: string | null = null;
    let preview: string | null = null;
    const eventLimit = history ? MAX_ACTIVITY_HISTORY_EVENTS : MAX_ACTIVITY_EVENTS;
    const pushEvent = (event: LocalAgentActivityEvent) => {
      events.push(event);
      if (!history && isToolActivity(event)) {
        const tools = events.filter(isToolActivity);
        if (tools.length > MAX_ACTIVITY_TOOL_EVENTS) {
          events.splice(events.indexOf(tools[0]!), 1);
          truncated = true;
        }
      }
      if (events.length > eventLimit) { events.shift(); truncated = true; }
    };

    for (let cursor = first; (start === 0 || first > 0) && cursor < bytesRead;) {
      const end = bytes.indexOf(10, cursor);
      if (end < 0) { truncated = true; break; }
      if (end - cursor > MAX_LINE_BYTES) {
        truncated = true;
        cursor = end + 1;
        continue;
      }
      const line = bytes.toString("utf8", cursor, end).trim();
      const offset = start + cursor;
      cursor = end + 1;
      if (!line) continue;

      let row: Record<string, unknown>;
      try { row = record(JSON.parse(line)); } catch { truncated = true; continue; }

      const at = timestamp(row.created_at);
      if (at !== null) {
        if (sessionStartedAt === null || at < sessionStartedAt) sessionStartedAt = at;
        if (lastActivityAt === null || at > lastActivityAt) lastActivityAt = at;
      }

      const type = row.type;
      if (type === "USER_INPUT") {
        const raw = typeof row.content === "string" ? stripUserEnvelope(row.content) : "";
        const hint = dashboardText(raw, 400);
        if (hint) taskHint = hint;
        const visible = redactedVisibleText(raw, 600);
        if (visible.clipped) truncated = true;
        if (visible.text) {
          pushEvent({ id: `e${offset.toString(36)}`, at, kind: "user", tool: null, text: visible.text });
        }
      } else if (type === "PLANNER_RESPONSE") {
        if (typeof row.model === "string") {
          const parsed = resolveBuiltinModel(row.model);
          if (parsed) {
            model = parsed.model;
            if (parsed.effort) reasoningEffort = parsed.effort;
            if (parsed.contextWindow) contextWindow = parsed.contextWindow;
          } else if (row.model === BYOM_MODEL && configured) {
            model = configured.model;
            reasoningEffort = configured.effort;
            contextWindow = configured.contextWindow;
          }
        }
        const input = whole(row.input_tokens) ? row.input_tokens : null;
        const cacheRead = whole(row.cache_read_tokens) ? row.cache_read_tokens : 0;
        const output = whole(row.output_tokens) ? row.output_tokens : null;
        if (input !== null && output !== null) {
          const used = input + cacheRead;
          if (Number.isSafeInteger(used) && used > 0) contextUsed = used;
          const total = input + output + cacheRead;
          if (at !== null && at <= now && at > now - 7 * DAY_MS && Number.isSafeInteger(total) && total > 0) {
            const models = model ? [{ provider: "agy", model, input, output, cacheRead }] : [];
            samples.push({ at, tokens: total, observation: { input, output, cacheRead, models } });
          }
        }
        if (Array.isArray(row.tool_calls)) {
          row.tool_calls.forEach((rawCall, index) => {
            const call = record(rawCall);
            const name = typeof call.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(call.name) ? call.name : null;
            if (!name) return;
            const detail = visibleToolDetail("tool-call", call.args, undefined, name);
            if (detail.clipped) truncated = true;
            pushEvent({
              id: `e${offset.toString(36)}-${index}`,
              at,
              kind: "tool-call",
              tool: name,
              text: detail.text,
              detailStatus: detail.detailStatus,
            });
          });
        }
        if (typeof row.content === "string" && row.content.trim()) {
          const visible = redactedVisibleText(row.content, 600);
          if (visible.clipped) truncated = true;
          if (visible.text) {
            preview = redactedVisibleText(row.content, 400).text;
            pushEvent({ id: `e${offset.toString(36)}`, at, kind: "assistant", tool: null, text: visible.text });
          }
        }
      }
    }

    let historySource: ActivityHistoryRead["historySource"];
    if (history) {
      const current = await lstat(file, { bigint: true });
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size ||
          current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs) return null;
      historySource = { file: `${stat.dev}:${stat.ino}`, path: file, size, revision: `${stat.mtimeNs}:${stat.ctimeNs}` };
    }

    const project = createLocalTokenProjector(new Date(now));
    return {
      sessionDir: options.sessionDir ?? null,
      sessionStartedAt,
      model,
      reasoningEffort,
      contextUsed,
      contextWindow,
      taskHint,
      preview,
      lastActivityAt,
      events,
      truncated,
      ...(historySource ? { historySource } : {}),
      usage: (verifiedSince: number) => ({
        tokenUsage24h: agyWindowUsage(samples, now - DAY_MS, verifiedSince, sessionStartedAt, start, project),
        tokenUsage7d: agyWindowUsage(samples, now - 7 * DAY_MS, verifiedSince, sessionStartedAt, start, project),
      }),
    };
  } finally {
    await handle.close();
  }
}

export async function readAgySessions(
  home: string,
  sessions: ReadonlyMap<string, { sessionId: string; configuredModel?: string | null }>,
  now: number,
  options: { history?: boolean } = {},
): Promise<Map<string, AgySessionObservation>> {
  const result = new Map<string, AgySessionObservation>();
  if (!sessions.size) return result;
  const agyHome = agyHomeDir(home);
  const settings = readAgySettings(agyHome);
  const dirs = readConversationWorkspaces(agyHome, [...new Set([...sessions.values()].map((s) => s.sessionId))]);
  await Promise.all([...sessions.entries()].map(async ([paneId, entry]) => {
    const observed = await readAgySession(agyHome, entry.sessionId, now, {
      history: options.history,
      configuredModel: entry.configuredModel,
      sessionDir: dirs.get(entry.sessionId) ?? null,
      settings,
    });
    if (observed) result.set(paneId, observed);
  }));
  return result;
}
