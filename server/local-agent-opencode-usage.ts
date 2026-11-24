import { lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LocalAgentMemberTokenUsageWindow } from "../shared/local-dashboard.ts";
import { unavailableMemberUsage } from "./local-agent-session.ts";
import { createLocalTokenProjector, type DailyTokenObservation } from "./local-usage-models.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const PROVIDER = /^[A-Za-z0-9_.-]{1,80}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;

type MemberUsage = (verifiedSince: number) => {
  tokenUsage24h: LocalAgentMemberTokenUsageWindow;
  tokenUsage7d: LocalAgentMemberTokenUsageWindow;
};

interface Sample {
  startedAt: number;
  at: number;
  tokens: number;
  observation: DailyTokenObservation;
}

function whole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function openCodeSessionId(agent: Record<string, unknown>): string | null {
  const session = agent.agent_session as Record<string, unknown> | null | undefined;
  const id = session?.value;
  return agent.agent === "opencode" && session?.agent === "opencode" && session.kind === "id"
    && session.source === "herdr:opencode" && typeof id === "string" && SESSION_ID.test(id) ? id : null;
}

export function openCodeUsageDatabase(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const { XDG_DATA_HOME: dataHome, OPENCODE_DB: database } = env;
  if (database === ":memory:") return null;
  const root = join(dataHome && isAbsolute(dataHome) ? dataHome : join(home, ".local", "share"), "opencode");
  return database && isAbsolute(database) ? database : join(root, database || "opencode.db");
}

function sample(row: Record<string, unknown>, now: number): Sample | null {
  const { startedAt, completed, input, output, reasoning, cacheRead, cacheWrite, provider, model } = row;
  if (!whole(startedAt) || !whole(completed) || completed < startedAt || completed <= now - 7 * DAY_MS || completed > now ||
      !whole(input) || !whole(output) || !whole(reasoning) || !whole(cacheRead) || !whole(cacheWrite)) return null;
  const amounts = { input, output: output + reasoning, cacheRead };
  const tokens = input + amounts.output + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(tokens) || tokens === 0) return null;
  const models = typeof model === "string" && MODEL.test(model) ? [{
    provider: typeof provider === "string" && PROVIDER.test(provider) ? provider : "opencode",
    model,
    ...amounts,
  }] : [];
  return { startedAt, at: completed, tokens, observation: { ...amounts, models } };
}

function usage(samples: Sample[], cutoff: number, verifiedSince: number,
  project: ReturnType<typeof createLocalTokenProjector>): LocalAgentMemberTokenUsageWindow {
  const observed = samples.filter(({ at, startedAt }) => at > cutoff && startedAt >= verifiedSince);
  const knownTokens = observed.reduce((sum, row) => sum + row.tokens, 0);
  if (!knownTokens || !Number.isSafeInteger(knownTokens)) return unavailableMemberUsage();
  return {
    coverage: "partial", knownTokens,
    estimatedCost: project(observed.map(({ observation }) => observation), "partial").estimatedCost,
  };
}

export function readOpenCodeMemberUsage(file: string | null, ids: Iterable<string>, now: number): Map<string, MemberUsage> {
  const sessions = [...new Set(ids)].filter((id) => SESSION_ID.test(id));
  const result = new Map<string, MemberUsage>();
  if (!file || !sessions.length) return result;
  let database: DatabaseSync | undefined;
  try {
    if (!lstatSync(file).isFile()) return result;
    const db = new DatabaseSync(file, { readOnly: true });
    database = db;
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message')").all().map(({ name }) => name));
    const prepare = (table: "session_message" | "message") => db.prepare(`SELECT
      time_created AS startedAt,
      json_extract(data, '$.time.completed') AS completed,
      json_extract(data, '$.tokens.input') AS input,
      json_extract(data, '$.tokens.output') AS output,
      json_extract(data, '$.tokens.reasoning') AS reasoning,
      json_extract(data, '$.tokens.cache.read') AS cacheRead,
      json_extract(data, '$.tokens.cache.write') AS cacheWrite,
      json_extract(data, '${table === "session_message" ? "$.model.providerID" : "$.providerID"}') AS provider,
      json_extract(data, '${table === "session_message" ? "$.model.id" : "$.modelID"}') AS model
      FROM ${table}
      WHERE session_id = ? AND time_created BETWEEN ? AND ?
        AND length(CAST(data AS BLOB)) <= 1048576
        AND CASE WHEN json_valid(data) THEN ${table === "session_message" ? "type" : "json_extract(data, '$.role')"} = 'assistant' ELSE 0 END
      ORDER BY time_created DESC LIMIT 10000`);
    const current = tables.has("session_message") ? prepare("session_message") : null;
    const legacy = tables.has("message") ? prepare("message") : null;
    // OpenCode 1.19 can have both stores. Use one store per session to avoid counting migrated messages twice.
    const hasCurrent = current && legacy ? db.prepare("SELECT 1 FROM session_message WHERE session_id = ? LIMIT 1") : null;
    const project = createLocalTokenProjector(new Date(now));
    for (const id of sessions) {
      const messages = hasCurrent && !hasCurrent.get(id) ? legacy : current ?? legacy;
      if (!messages) continue;
      const observed = messages.all(id, now - 7 * DAY_MS, now).flatMap((row) => {
        const parsed = sample(row, now);
        return parsed ? [parsed] : [];
      });
      result.set(id, (verifiedSince) => ({
        tokenUsage24h: usage(observed, now - DAY_MS, verifiedSince, project),
        tokenUsage7d: usage(observed, now - 7 * DAY_MS, verifiedSince, project),
      }));
    }
  } catch { return new Map(); }
  finally { database?.close(); }
  return result;
}
