import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LocalAgentActivityEvent, LocalAgentActivityHistoryRequest, LocalAgentActivityResponse } from "../shared/local-dashboard.ts";
import { redactedAgentText as safeText, trackAgentToolCalls, visibleAgentMessage, visibleToolDetail } from "./local-agent-visible-message.ts";
import { createActivityHistory, isToolActivity, MAX_ACTIVITY_EVENTS, MAX_ACTIVITY_HISTORY_EVENTS, MAX_ACTIVITY_TOOL_EVENTS,
  unavailableActivityHistory, type ActivityHistoryRead } from "./local-agent-activity-history.ts";
import { agyHomeDir, agySessionId, readAgySession } from "./local-agent-agy.ts";
import { codexSessionId, discoverCodexSessionFiles } from "./local-agent-session.ts";
import { readOpenCodeMessages } from "./local-agent-opencode-message.ts";
import { openCodeSessionId, openCodeUsageDatabase } from "./local-agent-opencode-usage.ts";
import { createPiSessionReader } from "./local-agent-pi-message.ts";
import { verifiedLocalAgentMembers } from "./local-agent-association.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { herdrRows, runHerdr, type HerdrRunner } from "./local-agent-teams.ts";

const PANE_ID = /^w\d+:p[0-9A-Za-z]+$/;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_HISTORY_LINE_BYTES = 1024 * 1024;
const DISCOVERY_MS = 10_000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unavailable = (agentId: string): LocalAgentActivityResponse => ({ agentId, status: "unavailable", updatedAt: null, truncated: false, events: [] });

function visibleEvent(line: string, offset: number, callFor: (id: string) => { tool: string | null; family?: "function" | "custom" } | null): {
  event: LocalAgentActivityEvent | null; clipped: boolean; format?: "legacy" | "canonical"; raw?: string; callId?: string; family?: "function" | "custom";
} {
  let row: Record<string, unknown>;
  try { row = record(JSON.parse(line)); } catch { return { event: null, clipped: true }; }
  const payload = record(row.payload);
  if (row.type === "response_item" && ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(String(payload.type))) {
    const callId = payload.call_id;
    if (typeof callId !== "string" || !callId || callId.length > 128) return { event: null, clipped: false };
    const result = payload.type === "function_call_output" || payload.type === "custom_tool_call_output";
    const family: "function" | "custom" = payload.type === "custom_tool_call" || payload.type === "custom_tool_call_output" ? "custom" : "function";
    const name = payload.name;
    if (!result && (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(name)
      || safeText(name).text !== name)) return { event: null, clipped: false, callId, family };
    const time = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const kind = result ? "tool-result" : "tool-call";
    const recorded = result ? callFor(callId) : null;
    const detailTool = result
      ? (family === "custom" && recorded?.family === "custom" ? recorded.tool : null)
      : (name as string);
    const value = result ? payload.output : family === "custom" ? payload.input : payload.arguments;
    const detail = visibleToolDetail(kind, value, "codex", detailTool, family);
    return { event: { id: `e${offset.toString(36)}`, at: Number.isFinite(time) ? time : null,
      kind, tool: result ? null : name as string, text: detail.text, detailStatus: detail.detailStatus }, clipped: detail.clipped,
      format: "canonical", raw: "", callId, family };
  }
  const message = visibleAgentMessage(row);
  if (!message) return { event: null, clipped: false };
  const { kind, raw, format } = message;
  const { text, clipped } = safeText(raw);
  if (text === null) return { event: null, clipped };
  const time = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  return { event: { id: `e${offset.toString(36)}`, at: Number.isFinite(time) ? time : null, kind, tool: null, text }, clipped, format, raw };
}

async function readSession(file: string, sessionId: string, history = false): Promise<ActivityHistoryRead | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    const size = Number(stat.size);
    if (!stat.isFile() || !Number.isSafeInteger(size) || size <= 0) return null;
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const firstRead = await handle.read(head, 0, head.length, 0);
    const endOfMeta = head.indexOf(10);
    if (endOfMeta < 0 || endOfMeta >= firstRead.bytesRead) return null;
    let meta: Record<string, unknown>;
    try { meta = record(JSON.parse(head.toString("utf8", 0, endOfMeta))); } catch { return null; }
    const recordedId = record(meta.payload).id;
    if (meta.type !== "session_meta" || typeof recordedId !== "string" || recordedId.toLowerCase() !== sessionId) return null;
    const start = Math.max(0, size - (history ? HISTORY_TAIL_BYTES : TAIL_BYTES));
    const bytes = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    if (bytesRead !== bytes.length) throw new Error("Session changed during read");
    const first = start === 0 ? 0 : bytes.indexOf(10) + 1;
    let truncated = start > 0;
    const events: Array<{ event: LocalAgentActivityEvent; format: "legacy" | "canonical"; raw: string }> = [];
    const toolCalls = trackAgentToolCalls();
    for (let cursor = first; (start === 0 || first > 0) && cursor < bytesRead;) {
      const end = bytes.indexOf(10, cursor);
      if (end < 0) { truncated = true; break; }
      if (end - cursor > (history ? MAX_HISTORY_LINE_BYTES : MAX_LINE_BYTES)) truncated = true;
      else {
        const found = visibleEvent(bytes.toString("utf8", cursor, end), start + cursor, toolCalls.callFor);
        if (found.clipped) truncated = true;
        if (found.callId) {
          if (found.event?.kind === "tool-result") toolCalls.associate(found.callId, found.event, found.family);
          else toolCalls.record(found.callId, found.event?.tool ?? null, found.family);
        }
        if (found.event) {
          const event = found.event;
          const duplicate = events.findIndex((prior) => event.at !== null && prior.format !== found.format && prior.event.kind === event.kind
            && prior.event.at === event.at && prior.raw === found.raw);
          if (duplicate >= 0) {
            if (found.format === "canonical") {
              event.id = events[duplicate]!.event.id;
              events[duplicate] = { event, format: found.format, raw: found.raw! };
            }
          } else {
            events.push({ event, format: found.format!, raw: found.raw! });
            if (!history && isToolActivity(event)) {
              const tools = events.filter((entry) => isToolActivity(entry.event));
              if (tools.length > MAX_ACTIVITY_TOOL_EVENTS) {
                events.splice(events.indexOf(tools[0]!), 1);
                truncated = true;
              }
            }
            if (events.length > (history ? MAX_ACTIVITY_HISTORY_EVENTS : MAX_ACTIVITY_EVENTS)) { events.shift(); truncated = true; }
          }
        }
      }
      cursor = end + 1;
    }
    const result = { events: events.map(({ event }) => event), truncated };
    if (!history) return result;
    const current = await lstat(file, { bigint: true });
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size ||
        current.mtimeNs !== stat.mtimeNs || current.ctimeNs !== stat.ctimeNs) return null;
    return { ...result, historySource: { file: `${stat.dev}:${stat.ino}`, path: file, size, revision: `${stat.mtimeNs}:${stat.ctimeNs}` } };
  } finally { await handle.close(); }
}

export function createLocalAgentActivityProvider({ run = runHerdr, read = readSession, home = homedir(), codexHome = process.env.CODEX_HOME || join(home, ".codex"), now = Date.now }: {
  run?: HerdrRunner; read?: typeof readSession; home?: string; codexHome?: string; now?: () => number;
} = {}) {
  const piSessionsFor = createPiSessionReader(join(home, ".local", "share", "mausbot-team", "pi-agent"));
  const piHistoryFor = createPiSessionReader(join(home, ".local", "share", "mausbot-team", "pi-agent"), { history: true });
  const activityHistory = createActivityHistory();
  const paths = new Map<string, { file: string | null; at: number }>();
  const lastGood = new Map<string, { sessionId: string; file: string; response: LocalAgentActivityResponse }>();
  const latest = new Map<string, symbol>();
  const pendingNewest = new Map<string, Promise<LocalAgentActivityResponse>>();

  async function historyAgent(agentId: string, expected: string): Promise<Record<string, unknown> | undefined> {
    const agents = herdrRows(await run(["--session", "default", "agent", "list"]), "agents");
    const agent = verifiedLocalAgentMembers(agents).find((row) => row.pane_id === agentId);
    return agent && localAgentOccupantId(agent, agentId) === expected ? agent : undefined;
  }

  async function refreshHistory(agentId: string, request: LocalAgentActivityHistoryRequest): Promise<LocalAgentActivityResponse> {
    const missing = unavailableActivityHistory(agentId);
    if (!PANE_ID.test(agentId)) return missing;
    try {
      const agent = await historyAgent(agentId, request.occupantId);
      if (!agent) return missing;
      let observed: ActivityHistoryRead | null | undefined;
      if (agent.agent === "pi") observed = (await piHistoryFor([agent])).get(agentId);
      else if (agent.agent === "opencode") {
        const sessionId = openCodeSessionId(agent);
        if (!sessionId) return missing;
        observed = readOpenCodeMessages(openCodeUsageDatabase(home), [sessionId], "history").get(sessionId);
      } else if (agent.agent === "agy") {
        const sessionId = agySessionId(agent);
        if (!sessionId) return missing;
        observed = await readAgySession(agyHomeDir(home), sessionId, now(), { history: true });
      } else if (agent.agent === "codex") {
        const sessionId = codexSessionId(agent);
        if (!sessionId) return missing;
        const file = (await discoverCodexSessionFiles(codexHome, new Set([sessionId]))).get(sessionId);
        if (file) observed = await read(file, sessionId, true);
      } else return { ...missing, status: "unsupported" };
      if (!observed?.historySource) return missing;
      const live = await historyAgent(agentId, request.occupantId);
      if (!live || live.cwd !== agent.cwd) return missing;
      const source = observed.historySource;
      const stat = await lstat(source.path, { bigint: true });
      if (!stat.isFile() || source.file !== `${stat.dev}:${stat.ino}` || BigInt(source.size) !== stat.size ||
          source.revision !== `${stat.mtimeNs}:${stat.ctimeNs}`) return missing;
      return activityHistory(agentId, request, observed, now());
    } catch { return missing; }
  }

  async function refresh(agentId: string, current: () => boolean): Promise<LocalAgentActivityResponse> {
    if (!PANE_ID.test(agentId)) return unavailable(agentId);
    const clear = () => { if (current()) lastGood.delete(agentId); };
    let agents: Record<string, unknown>[];
    try { agents = herdrRows(await run(["--session", "default", "agent", "list"]), "agents"); }
    catch { clear(); return unavailable(agentId); }
    const matches = agents.filter((agent) => agent.pane_id === agentId && agent.workspace_id === agentId.split(":")[0]);
    if (matches.length !== 1) { clear(); return unavailable(agentId); }
    const agent = matches[0]!;
    if (agent.agent === "pi") {
      clear();
      const verified = verifiedLocalAgentMembers(agents);
      if (!verified.includes(agent)) return unavailable(agentId);
      const observed = (await piSessionsFor(verified)).get(agentId);
      if (!current() || !observed) return unavailable(agentId);
      return { agentId, status: "ready", updatedAt: now(), events: observed.events, truncated: observed.truncated };
    }
    if (agent.agent === "opencode") {
      clear();
      const sessionId = openCodeSessionId(agent);
      if (!sessionId || !verifiedLocalAgentMembers(agents).includes(agent)) return unavailable(agentId);
      const observed = readOpenCodeMessages(openCodeUsageDatabase(home), [sessionId], "recent").get(sessionId);
      const occupant = localAgentOccupantId(agent, agentId);
      const live = observed && occupant && await historyAgent(agentId, occupant).catch(() => undefined);
      if (!current() || !observed || !live || live.cwd !== agent.cwd) return unavailable(agentId);
      return { agentId, status: "ready", updatedAt: now(), events: observed.events, truncated: observed.truncated };
    }
    if (agent.agent === "agy") {
      clear();
      const sessionId = agySessionId(agent);
      if (!sessionId || !verifiedLocalAgentMembers(agents).includes(agent)) return unavailable(agentId);
      const observed = await readAgySession(agyHomeDir(home), sessionId, now());
      const occupant = localAgentOccupantId(agent, agentId);
      const live = observed && occupant && await historyAgent(agentId, occupant).catch(() => undefined);
      if (!current() || !observed || !live || live.cwd !== agent.cwd) return unavailable(agentId);
      return { agentId, status: "ready", updatedAt: now(), events: observed.events, truncated: observed.truncated };
    }
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
    get(agentId: string, history?: LocalAgentActivityHistoryRequest): Promise<LocalAgentActivityResponse> {
      if (history) {
        if (history.before !== undefined) return refreshHistory(agentId, history);
        const key = `${agentId}\0${history.occupantId}`;
        const pending = pendingNewest.get(key);
        if (pending) return pending;
        const newest = refreshHistory(agentId, history).finally(() => pendingNewest.delete(key));
        pendingNewest.set(key, newest);
        return newest;
      }
      const request = Symbol();
      latest.set(agentId, request);
      const current = () => latest.get(agentId) === request;
      return refresh(agentId, current).finally(() => { if (current()) latest.delete(agentId); });
    },
  };
}
