import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { LocalAgentMember, LocalAgentState, LocalAgentTeamsResponse, LocalAgentTeam } from "../shared/local-dashboard.ts";
import { OwnedFile } from "./atomic.ts";
import { augmentedPath } from "./env-path.ts";
import { agyConversationFromArgv, agyModelFromArgv, agySessionId, readAgySessions, resolveAgyConfiguredRuntime } from "./local-agent-agy.ts";
import { readOpenCodeMessages } from "./local-agent-opencode-message.ts";
import { openCodeSessionId, openCodeUsageDatabases, readOpenCodeMemberUsage } from "./local-agent-opencode-usage.ts";
import { codexSessionId, createLocalAgentSessionReader, dashboardText, unavailableMemberUsage } from "./local-agent-session.ts";
import { PI_CONTEXT_KEY, parsePiContext, readPiProcessStart, type PiProcessStart } from "./local-agent-pi-context.ts";
import { createPiSessionReader, type PiSessionView } from "./local-agent-pi-message.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { localAgentRoles, readDocument, sameGitRepository, verifiedLocalAgentMembers } from "./local-agent-association.ts";

const execute = promisify(execFile);
const STATES = new Set<LocalAgentState>(["idle", "working", "blocked", "done", "unknown"]);
const BINDING_FINGERPRINT = /^[a-f0-9]{64}$/;
export type HerdrRunner = (args: readonly string[]) => Promise<string>;

export const runHerdr: HerdrRunner = async (args) => (await execute("herdr", [...args], {
  timeout: 4000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true,
  env: { ...process.env, PATH: augmentedPath() },
})).stdout;

export function herdrRows(output: string, field: "workspaces" | "agents"): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(output);
  if (!parsed || typeof parsed !== "object" || !("result" in parsed)) throw new Error("Invalid Herdr response");
  const result = parsed.result;
  if (!result || typeof result !== "object" || !(field in result)) throw new Error("Invalid Herdr response");
  const list = (result as Record<string, unknown>)[field];
  if (!Array.isArray(list) || list.length > (field === "agents" ? 200 : 100) || list.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error("Invalid Herdr rows");
  }
  return list as Record<string, unknown>[];
}

function state(value: unknown): LocalAgentState {
  return STATES.has(value as LocalAgentState) ? value as LocalAgentState : "unknown";
}

function piContextValue(agent: Record<string, unknown>): unknown {
  const tokens = agent.tokens;
  return tokens && typeof tokens === "object" ? (tokens as Record<string, unknown>)[PI_CONTEXT_KEY] : undefined;
}

async function observePiContexts(agents: Record<string, unknown>[], sessions: Map<string, PiSessionView | null>,
  run: HerdrRunner, readStart: PiProcessStart, now: () => number): Promise<Map<string, number>> {
  const candidates = agents.flatMap((agent) => {
    const pane = String(agent.pane_id);
    const session = sessions.get(pane)?.contextBinding;
    if (!session) return [];
    const binding = { pane, ...session };
    const sample = parsePiContext(piContextValue(agent), binding, now());
    return sample ? [{ agent, pane, binding, sample }] : [];
  }).slice(0, 16);
  if (!candidates.length) return new Map();
  const checked = await Promise.all(candidates.map(async (candidate) => {
    const { pane, sample } = candidate;
    try {
      const { result } = JSON.parse(await run(["--session", "default", "pane", "process-info", "--pane", pane]));
      const info = result?.process_info;
      if (info?.pane_id !== pane || !Array.isArray(info.foreground_processes) ||
          !info.foreground_processes.some((entry: { pid?: number; name?: string }) =>
            entry?.pid === sample.pid && entry.name === "node")) return null;
      return await readStart(sample.pid) === sample.start ? candidate : null;
    } catch { return null; }
  }));
  if (!checked.some(Boolean)) return new Map();
  try {
    const fresh = verifiedLocalAgentMembers(herdrRows(await run(["--session", "default", "agent", "list"]), "agents"));
    return new Map(checked.flatMap((entry) => {
      if (!entry) return [];
      const { agent, pane, binding, sample } = entry;
      const row = fresh.find((candidate) => candidate.pane_id === pane);
      if (row?.agent !== "pi" || row.cwd !== agent.cwd ||
          localAgentOccupantId(row, pane) !== localAgentOccupantId(agent, pane)) return [];
      const current = parsePiContext(piContextValue(row), binding, now());
      return current && current.pid === sample.pid && current.start === sample.start && current.window === sample.window
        ? [[pane, current.window] as const] : [];
    }));
  } catch { return new Map(); }
}

async function observeAgyProcesses(panes: readonly string[], run: HerdrRunner): Promise<{
  models: Map<string, string>;
  conversations: Map<string, string>;
}> {
  const models = new Map<string, string>();
  const conversations = new Map<string, string>();
  if (!panes.length) return { models, conversations };
  await Promise.all(panes.slice(0, 24).map(async (pane) => {
    try {
      const { result } = JSON.parse(await run(["--session", "default", "pane", "process-info", "--pane", pane]));
      const processes = result?.process_info?.foreground_processes;
      if (!Array.isArray(processes)) return;
      for (const proc of processes) {
        if (!Array.isArray(proc?.argv)) continue;
        if (!models.has(pane)) {
          const model = agyModelFromArgv(proc.argv);
          if (model) models.set(pane, model);
        }
        if (!conversations.has(pane)) {
          const conversation = agyConversationFromArgv(proc.argv);
          if (conversation) conversations.set(pane, conversation);
        }
      }
    } catch { /* fallback to settings.json default */ }
  }));
  return { models, conversations };
}

type BindingState = {
  starts: Map<string, number>;
  sessionOwners: Map<string, string>;
  legacyStarts?: Map<string, number>;
  /** Maps sessionHash -> stable seat fingerprint (pane + agent + occupant, without transient terminal_id). */
  seatOwners: Map<string, string>;
};
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const sessionFingerprint = (session: string) => createHash("sha256").update(`session:${session}`).digest("hex");

async function restoreBindingStarts(file: OwnedFile): Promise<BindingState> {
  try {
    const saved = await readDocument(dirname(file.path), file.path);
    if (saved.status === "ready") {
      const parsed: unknown = JSON.parse(saved.markdown!);
      const isLegacy = Array.isArray(parsed);
      const entries = isLegacy ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { bindings?: unknown }).bindings)
          ? (parsed as { bindings: unknown[] }).bindings : null;
      const sessions = parsed && typeof parsed === "object" && !isLegacy && Array.isArray((parsed as { sessions?: unknown }).sessions)
        ? (parsed as { sessions: unknown[] }).sessions : [];
      const seats = parsed && typeof parsed === "object" && !isLegacy && Array.isArray((parsed as { seats?: unknown }).seats)
        ? (parsed as { seats: unknown[] }).seats : [];
      if (entries && entries.length <= 200 && entries.every((entry): entry is [string, number] =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && BINDING_FINGERPRINT.test(entry[0]) &&
        Number.isSafeInteger(entry[1]) && entry[1] >= 0)) {
        const validSessions = sessions.length <= 200 && sessions.every((entry): entry is [string, string] =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && BINDING_FINGERPRINT.test(entry[0]) &&
          typeof entry[1] === "string" && BINDING_FINGERPRINT.test(entry[1])) ? sessions : [];
        const validSeats = seats.length <= 200 && seats.every((entry): entry is [string, string] =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && BINDING_FINGERPRINT.test(entry[0]) &&
          typeof entry[1] === "string" && BINDING_FINGERPRINT.test(entry[1])) ? seats : [];
        file.loaded(saved.markdown!);
        return {
          starts: new Map(entries),
          sessionOwners: new Map(validSessions),
          seatOwners: new Map(validSeats),
          ...(isLegacy ? { legacyStarts: new Map(entries) } : {}),
        };
      }
    }
  } catch { /* The cache is optional. */ }
  return { starts: new Map(), sessionOwners: new Map(), seatOwners: new Map() };
}

export function createLocalAgentTeamsProvider({ run = runHerdr, home = homedir(), codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  bindingCachePath, now = Date.now, readProcessStart = readPiProcessStart, fastRosterTimeoutMs = 0 }: {
  run?: HerdrRunner; home?: string; codexHome?: string; bindingCachePath?: string;
  now?: () => number; readProcessStart?: PiProcessStart;
  /** When > 0 and no full snapshot is cached yet, return the fast Herdr roster if full enrichment exceeds this budget while continuing enrichment in the background. */
  fastRosterTimeoutMs?: number;
} = {}) {
  const observationsFor = createLocalAgentSessionReader(codexHome, now);
  const piSessionsFor = createPiSessionReader(join(home, ".local", "share", "mausbot-team", "pi-agent"));
  let lastGood: LocalAgentTeamsResponse | null = null;
  let lastResult: LocalAgentTeamsResponse | null = null;
  let lastFastRoster: LocalAgentTeamsResponse | null = null;
  let lastAttempt = -Infinity;
  let pending: Promise<LocalAgentTeamsResponse> | null = null;
  let pendingRoster: Promise<LocalAgentTeamsResponse | null> | null = null;
  let revision = 0;
  const bindingFile = bindingCachePath ? new OwnedFile(bindingCachePath, { mode: 0o600 }) : null;
  let restoredBindings: Promise<BindingState> | undefined;
  let bindingStarts: BindingState | undefined;

  function buildFastRoster(workspaces: Record<string, unknown>[], agents: Record<string, unknown>[], sampledAt: number): LocalAgentTeamsResponse {
    const teams = new Map<string, LocalAgentTeam>();
    for (const workspace of workspaces) {
      const id = workspace.workspace_id;
      if (typeof id !== "string" || !id || teams.has(id)) throw new Error("Invalid workspace identity");
      teams.set(id, {
        id, name: dashboardText(workspace.label, 100) || id, agentCount: 0, activeAgentCount: 0, lastActivityAt: null,
        tokenUsage24h: { coverage: "unavailable", knownTokens: null },
        tokenUsage7d: { coverage: "unavailable", knownTokens: null },
        agents: [],
      });
    }
    const seen = new Set<string>();
    for (const agent of agents) {
      const id = agent.pane_id;
      const team = teams.get(String(agent.workspace_id));
      if (typeof id !== "string" || !id || seen.has(id) || !team) throw new Error("Invalid agent identity");
      seen.add(id);
      const occupantId = localAgentOccupantId(agent, id);
      team.agents.push({
        id, name: dashboardText(agent.name, 100) || id, kind: dashboardText(agent.agent, 40) || "unknown",
        ...(occupantId ? { occupantId } : {}),
        role: null, model: null, reasoningEffort: null, contextUsed: null, contextWindow: null,
        state: state(agent.agent_status), taskHint: null, messagePreview: null,
        tokenUsage24h: unavailableMemberUsage(), tokenUsage7d: unavailableMemberUsage(),
      });
    }
    for (const team of teams.values()) {
      team.agentCount = team.agents.length;
      team.activeAgentCount = team.agents.filter((member) => member.state === "working").length;
    }
    return { status: "ready", updatedAt: sampledAt, teamCount: teams.size, enriching: true, teams: [...teams.values()] };
  }

  async function refresh(current: () => boolean, onRoster?: (roster: LocalAgentTeamsResponse | null) => void): Promise<LocalAgentTeamsResponse> {
    let rosterResolved = false;
    const emitRoster = (value: LocalAgentTeamsResponse | null) => {
      if (rosterResolved) return;
      rosterResolved = true;
      onRoster?.(value);
    };
    try {
      const responses = await Promise.allSettled([
        run(["--session", "default", "workspace", "list"]),
        run(["--session", "default", "agent", "list"]),
      ]);
      if (responses.some((response) => response.status === "rejected")) throw new Error("Herdr read failed");
      const [workspaceOutput, agentOutput] = responses.map((response) => (response as PromiseFulfilledResult<string>).value);
      const workspaces = herdrRows(workspaceOutput, "workspaces");
      const agents = herdrRows(agentOutput, "agents");
      const sampledAt = now();
      if (fastRosterTimeoutMs > 0 && !lastResult) {
        const fastRoster = buildFastRoster(workspaces, agents, sampledAt);
        if (current()) lastFastRoster = fastRoster;
        emitRoster(fastRoster);
        // Yield once so a caller waiting on the fast-roster race timer can receive the fast roster
        // before synchronous SQLite queries (`readOpenCodeMemberUsage` / `readOpenCodeMessages`) run.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const teams = new Map<string, LocalAgentTeam>();
      for (const workspace of workspaces) {
        const id = workspace.workspace_id;
        if (typeof id !== "string" || !id || teams.has(id)) throw new Error("Invalid workspace identity");
        teams.set(id, { id, name: dashboardText(workspace.label, 100) || id, agentCount: 0, activeAgentCount: 0, lastActivityAt: null, agents: [] });
      }
      const verified = verifiedLocalAgentMembers(agents);
      const verifiedIds = new Set(verified.map((agent) => agent.pane_id));
      const openCodeSessions = new Map(verified.flatMap((agent) => {
        const id = openCodeSessionId(agent);
        return id ? [[agent.pane_id, id] as const] : [];
      }));
      const agySessions = new Map(verified.flatMap((agent) => {
        const id = agySessionId(agent);
        return id ? [[String(agent.pane_id), id] as const] : [];
      }));
      const agyPanes = agents.flatMap((agent) =>
        agent.agent === "agy" && typeof agent.pane_id === "string" && agent.pane_id ? [agent.pane_id] : []);
      const openCodeIds = [...openCodeSessions.values()];
      const openCodeFiles = openCodeUsageDatabases(home);
      const [observations, roles, piSessions, agyProcesses] = await Promise.all([
        observationsFor(agents), localAgentRoles(verified, home), piSessionsFor(verified),
        observeAgyProcesses(agyPanes, run),
      ]);
      // When Herdr has not yet emitted `agent_session` for an idle resumed Agy pane (before its first new turn),
      // recover its exact `--conversation <uuid>` from the live pane's process argv so model/effort/context/usage stay visible.
      const agyFallbackSessions = new Map<string, string>();
      const claimedAgySessions = new Set(agySessions.values());
      for (const agent of agents) {
        if (agent.agent !== "agy" || typeof agent.pane_id !== "string" || agySessions.has(agent.pane_id)) continue;
        const conv = agyProcesses.conversations.get(agent.pane_id);
        if (conv && !claimedAgySessions.has(conv)) {
          claimedAgySessions.add(conv);
          agyFallbackSessions.set(agent.pane_id, conv);
        }
      }
      const agyInput = new Map([
        ...[...agySessions.entries()].map(([pane, sessionId]) =>
          [pane, { sessionId, configuredModel: agyProcesses.models.get(pane) ?? null }] as const),
        ...[...agyFallbackSessions.entries()].map(([pane, sessionId]) =>
          [pane, { sessionId, configuredModel: agyProcesses.models.get(pane) ?? null }] as const),
      ]);
      const agyConfiguredOnly = new Map(
        agyPanes.filter((pane) => !agyInput.has(pane)).map((pane) => [pane, agyProcesses.models.get(pane) ?? null] as const),
      );
      const [piContexts, agyObservations] = await Promise.all([
        observePiContexts(verified, piSessions, run, readProcessStart, now),
        readAgySessions(home, agyInput, sampledAt),
      ]);
      // Run synchronous OpenCode SQLite queries after async I/O has started (and fast-roster timer had a chance to fire).
      const openCodeUsage = readOpenCodeMemberUsage(openCodeFiles, openCodeIds, sampledAt);
      const openCodeMessages = readOpenCodeMessages(openCodeFiles, openCodeIds, "preview");
      const liveUsageMembers = openCodeIds.length || agySessions.size || agyFallbackSessions.size || verified.some(codexSessionId)
        ? verifiedLocalAgentMembers(herdrRows(await run(["--session", "default", "agent", "list"]), "agents")) : [];
      const liveByPane = new Map(liveUsageMembers.map((agent) => [agent.pane_id, agent] as const));
      const sessionTeams = new Map<string, Set<string>>();
      const sessionClaims = new Map<string, number>();
      for (const agent of agents) {
        const session = codexSessionId(agent);
        if (!session) continue;
        sessionClaims.set(session, (sessionClaims.get(session) ?? 0) + 1);
        const owners = sessionTeams.get(session) ?? new Set<string>();
        owners.add(String(agent.workspace_id));
        sessionTeams.set(session, owners);
      }
      const previousBindings: BindingState = bindingStarts ?? await (restoredBindings ??= bindingFile ? restoreBindingStarts(bindingFile) : Promise.resolve<BindingState>({ starts: new Map(), sessionOwners: new Map(), seatOwners: new Map() }));
      const nextStarts = new Map<string, number>();
      const nextSessionOwners = new Map<string, string>();
      const nextSeatOwners = new Map<string, string>();
      const invalidatedKeys = new Set<string>();
      const openCodeUsageByPane = new Map<string, { session: string; usage: ReturnType<NonNullable<ReturnType<typeof openCodeUsage.get>>["usage"]> }>();
      const agyUsageByPane = new Map<string, { session: string; usage: ReturnType<NonNullable<ReturnType<typeof agyObservations.get>>["usage"]> }>();
      const seen = new Set<string>();
      for (const agent of agents) {
        const id = agent.pane_id;
        const team = teams.get(String(agent.workspace_id));
        if (typeof id !== "string" || !id || seen.has(id) || !team) throw new Error("Invalid agent identity");
        seen.add(id);
        const sessionId = codexSessionId(agent);
        const occupantId = localAgentOccupantId(agent, id);
        const live = liveByPane.get(id);
        const sameBinding = current() && live && occupantId && live.agent === agent.agent && live.cwd === agent.cwd &&
          live.terminal_id === agent.terminal_id && localAgentOccupantId(live, id) === occupantId;
        const verifiedCodexMember = sameBinding && verifiedIds.has(id) && sessionId !== null && codexSessionId(live) === sessionId &&
          sessionClaims.get(sessionId) === 1;
        const openCodeSession = sameBinding && openCodeSessionId(live) === openCodeSessions.get(id) ? openCodeSessions.get(id) : undefined;
        const agyFallbackSession = agyFallbackSessions.get(id);
        const agySession = (sameBinding && agySessionId(live) === agySessions.get(id) ? agySessions.get(id) : undefined)
          ?? (current() && agyFallbackSession ? agyFallbackSession : undefined);
        const openCode = openCodeSession ? openCodeMessages.get(openCodeSession) : undefined;
        const observation = sessionId ? observations.get(sessionId) : null;
        const openCodeEntry = openCodeSession ? openCodeUsage.get(openCodeSession) : undefined;
        const agyEntry = agySession ? agyObservations.get(id) : undefined;
        const pi = verifiedIds.has(id) ? piSessions.get(id) : null;
        const memberLastActivity = observation?.lastActivityAt ?? agyEntry?.lastActivityAt ?? null;
        if (memberLastActivity != null) team.lastActivityAt = Math.max(team.lastActivityAt ?? 0, memberLastActivity);
        const boundSession = verifiedCodexMember ? sessionId : openCodeSession ?? agySession;
        const rawSession = sessionId ?? openCodeSessionId(agent) ?? agySessionId(agent) ?? agyFallbackSession ?? null;
        const effectiveOccupant = occupantId ?? (agyFallbackSession && typeof agent.name === "string" && agent.name
          ? `fallback:${agent.name}` : null);
        const binding = boundSession && effectiveOccupant ? JSON.stringify([id, agent.agent, effectiveOccupant, boundSession, agent.terminal_id]) : null;
        const bindingKey = binding && typeof agent.terminal_id === "string" && agent.terminal_id
          ? createHash("sha256").update(binding).digest("hex") : binding;
        // Key stable seat continuity on `(pane, agent, name, session)` so both Herdr `terminal_id` rotation and
        // Agy idle `--conversation` fallback (before Herdr re-emits `agent_session`) map to the same seat owner.
        const seatName = typeof agent.name === "string" && agent.name ? agent.name : effectiveOccupant;
        const seatOwnerKey = boundSession && seatName
          ? createHash("sha256").update(JSON.stringify([id, agent.agent, seatName, boundSession])).digest("hex") : null;
        const legacyKey = boundSession && occupantId && typeof agent.terminal_id === "string" && agent.terminal_id
          ? createHash("sha256").update(JSON.stringify([id, agent.agent, occupantId, boundSession, agent.cwd, agent.terminal_id])).digest("hex") : null;
        if (!boundSession && rawSession && occupantId && typeof agent.terminal_id === "string" && agent.terminal_id) {
          const staleKey = createHash("sha256").update(JSON.stringify([id, agent.agent, occupantId, rawSession, agent.terminal_id])).digest("hex");
          invalidatedKeys.add(staleKey);
          const staleLegacy = createHash("sha256").update(JSON.stringify([id, agent.agent, occupantId, rawSession, agent.cwd, agent.terminal_id])).digest("hex");
          invalidatedKeys.add(staleLegacy);
        }
        const directStart = bindingKey ? previousBindings.starts.get(bindingKey) : undefined;
        const legacyStart = legacyKey ? (previousBindings.legacyStarts?.get(legacyKey) ?? previousBindings.starts.get(legacyKey)) : undefined;
        const savedStart = directStart ?? legacyStart;
        const sessionHash = boundSession ? sessionFingerprint(boundSession) : null;
        const priorOwner = sessionHash ? previousBindings.sessionOwners.get(sessionHash) : undefined;
        const priorSeatOwner = sessionHash ? previousBindings.seatOwners.get(sessionHash) : undefined;
        const originDir = verifiedCodexMember ? observation?.sessionCwd ?? null
          : openCodeEntry?.sessionDir ?? agyEntry?.sessionDir ?? null;
        const originStartedAt = verifiedCodexMember ? observation?.sessionStartedAt ?? null
          : openCodeEntry?.sessionStartedAt ?? agyEntry?.sessionStartedAt ?? null;
        // Same-origin continuity: a session started inside the same git repository belongs to this seat when
        // unclaimed, already owned by this binding, or returning to the exact same `(pane, agent, occupant, session)`
        // after a Herdr daemon restart rotates `terminal_id`. Cross-pane moves (`priorSeatOwner !== seatOwnerKey`)
        // and non-origin sessions (no `originDir` / different repo) remain strictly gated at `sampledAt`.
        const sameSeatContinuity = Boolean(
          !priorOwner
          || priorOwner === bindingKey
          || (seatOwnerKey && priorSeatOwner === seatOwnerKey)
          || (seatOwnerKey && !priorSeatOwner),
        );
        const sameOrigin = Boolean(
          bindingKey && sameSeatContinuity &&
          typeof agent.cwd === "string" && originDir && await sameGitRepository(originDir, agent.cwd),
        );
        let switchedAt = savedStart !== undefined && savedStart <= sampledAt ? savedStart : sampledAt;
        if (sameOrigin && (directStart === undefined || (originStartedAt !== null && originStartedAt < switchedAt))) {
          switchedAt = originStartedAt !== null && originStartedAt <= sampledAt ? originStartedAt : 0;
        }
        if (bindingKey) nextStarts.set(bindingKey, switchedAt);
        if (sessionHash) {
          nextSessionOwners.set(sessionHash, bindingKey ?? (priorOwner || "claimed"));
          if (seatOwnerKey) nextSeatOwners.set(sessionHash, seatOwnerKey);
        }
        const openCodeMemberUsage = openCodeEntry?.usage(switchedAt);
        if (openCodeSession && openCodeMemberUsage) openCodeUsageByPane.set(id, { session: openCodeSession, usage: openCodeMemberUsage });
        const agyMemberUsage = agyEntry?.usage(switchedAt);
        if (agySession && agyMemberUsage) agyUsageByPane.set(id, { session: agySession, usage: agyMemberUsage });
        const usage = verifiedCodexMember && observation
          ? observation.memberUsage(switchedAt)
          : openCodeMemberUsage ?? agyMemberUsage ?? { tokenUsage24h: unavailableMemberUsage(), tokenUsage7d: unavailableMemberUsage() };
        const fallbackAgyMeta = !agyEntry && agent.agent === "agy" ? agyObservations.get(id) : undefined;
        const configuredAgy = !agyEntry && !fallbackAgyMeta && agyConfiguredOnly.has(id)
          ? resolveAgyConfiguredRuntime(home, agyConfiguredOnly.get(id) ?? null) : null;
        const member: LocalAgentMember = {
          id, name: dashboardText(agent.name, 100) || id, kind: dashboardText(agent.agent, 40) || "unknown",
          ...(occupantId ? { occupantId } : {}),
          role: dashboardText(roles.get(id), 40), model: observation?.model ?? pi?.model ?? openCode?.model ?? agyEntry?.model ?? fallbackAgyMeta?.model ?? configuredAgy?.model ?? null,
          reasoningEffort: observation?.reasoningEffort ?? pi?.reasoningEffort ?? openCode?.reasoningEffort ?? agyEntry?.reasoningEffort ?? fallbackAgyMeta?.reasoningEffort ?? configuredAgy?.effort ?? null,
          contextUsed: observation?.contextUsed ?? agyEntry?.contextUsed ?? fallbackAgyMeta?.contextUsed ?? null,
          contextWindow: observation?.contextWindow ?? (current() ? piContexts.get(id) : undefined) ?? agyEntry?.contextWindow ?? fallbackAgyMeta?.contextWindow ?? configuredAgy?.contextWindow ?? null,
          state: state(agent.agent_status), taskHint: observation?.taskHint ?? agyEntry?.taskHint ?? fallbackAgyMeta?.taskHint ?? null,
          messagePreview: verifiedIds.has(id) ? observation?.messagePreview ?? pi?.preview ?? openCode?.preview ?? agyEntry?.preview ?? null : null,
          tokenUsage24h: usage.tokenUsage24h,
          tokenUsage7d: usage.tokenUsage7d,
        };
        team.agents.push(member);
      }
      if (current()) {
        for (const [key, ts] of previousBindings.starts) {
          if (nextStarts.has(key) || invalidatedKeys.has(key) || ts < sampledAt - RETENTION_MS) continue;
          nextStarts.set(key, ts);
        }
        for (const [sessionHash, owner] of previousBindings.sessionOwners) {
          if (nextSessionOwners.has(sessionHash) || !nextStarts.has(owner)) continue;
          nextSessionOwners.set(sessionHash, owner);
        }
        for (const [sessionHash, seat] of previousBindings.seatOwners) {
          if (nextSeatOwners.has(sessionHash) || !nextSessionOwners.has(sessionHash)) continue;
          nextSeatOwners.set(sessionHash, seat);
        }
        bindingStarts = { starts: nextStarts, sessionOwners: nextSessionOwners, seatOwners: nextSeatOwners };
        const bindings = [...nextStarts].filter(([key]) => BINDING_FINGERPRINT.test(key)).sort((a, b) => b[1] - a[1]).slice(0, 200);
        const kept = new Set(bindings.map(([key]) => key));
        const sessions = [...nextSessionOwners].filter(([key, owner]) => BINDING_FINGERPRINT.test(key) && kept.has(owner)).sort().slice(0, 200);
        const keptSessions = new Set(sessions.map(([key]) => key));
        const seats = [...nextSeatOwners].filter(([key, seat]) => keptSessions.has(key) && BINDING_FINGERPRINT.test(seat)).sort().slice(0, 200);
        try { bindingFile?.write(JSON.stringify({ bindings, sessions, seats })); } catch { /* Keep the in-memory observations. */ }
      }
      for (const team of teams.values()) {
        team.agentCount = team.agents.length;
        team.activeAgentCount = team.agents.filter((member) => member.state === "working").length;
      }
      for (const team of teams.values()) {
        const totals = { tokenUsage24h: { known: 0, covered: 0, missing: false, partial: false },
          tokenUsage7d: { known: 0, covered: 0, missing: false, partial: false } };
        const counted = new Set<string>();
        for (const agent of agents.filter((row) => row.workspace_id === team.id)) {
          const codex = codexSessionId(agent);
          const openCode = typeof agent.pane_id === "string" ? openCodeUsageByPane.get(agent.pane_id) : undefined;
          const agy = typeof agent.pane_id === "string" ? agyUsageByPane.get(agent.pane_id) : undefined;
          const session = codex && sessionTeams.get(codex)?.size === 1 ? codex : openCode?.session ?? agy?.session;
          if (!session) {
            totals.tokenUsage24h.missing = true;
            totals.tokenUsage7d.missing = true;
            continue;
          }
          if (counted.has(session)) continue;
          counted.add(session);
          const source = codex ? observations.get(codex) : openCode?.usage ?? agy?.usage;
          for (const key of ["tokenUsage24h", "tokenUsage7d"] as const) {
            const usage = source?.[key];
            const total = totals[key];
            if (!usage || usage.coverage !== "ready") total.missing = true;
            if (usage?.coverage === "partial") total.partial = true;
            if (usage?.knownTokens === null || usage?.knownTokens === undefined) continue;
            if (!Number.isSafeInteger(total.known + usage.knownTokens)) { total.missing = true; continue; }
            total.known += usage.knownTokens;
            total.covered++;
          }
        }
        for (const key of ["tokenUsage24h", "tokenUsage7d"] as const) {
          const { known, covered, missing, partial } = totals[key];
          team[key] = !team.agentCount || (!covered && !partial) ? { coverage: "unavailable", knownTokens: null }
            : missing ? { coverage: "partial", knownTokens: known > 0 ? known : null }
              : { coverage: "ready", knownTokens: known };
        }
      }
      const response: LocalAgentTeamsResponse = { status: "ready", updatedAt: now(), teamCount: teams.size, teams: [...teams.values()] };
      if (current()) lastGood = response;
      return response;
    } catch {
      emitRoster(null);
      return lastGood ? { ...lastGood, status: "stale", teams: lastGood.teams.map((team) => ({ ...team,
        agents: team.agents.map((member) => ({ ...member, role: null, messagePreview: null,
          contextWindow: member.kind === "pi" ? null : member.contextWindow })),
      })) } : { status: "unavailable", updatedAt: null, teamCount: null, teams: [] };
    }
  }

  function startRefresh(): Promise<LocalAgentTeamsResponse> {
    const request = ++revision;
    lastAttempt = now();
    lastFastRoster = null;
    let resolveRoster!: (roster: LocalAgentTeamsResponse | null) => void;
    const rosterPromise = new Promise<LocalAgentTeamsResponse | null>((resolve) => { resolveRoster = resolve; });
    pendingRoster = rosterPromise;
    const next: Promise<LocalAgentTeamsResponse> = refresh(() => request === revision, resolveRoster).then((value) => {
      if (request === revision) {
        lastResult = value;
        lastAttempt = now();
        if (value.status !== "ready") lastGood = value.status === "stale" ? lastGood : null;
      }
      return value;
    }).finally(() => {
      if (pending === next) {
        pending = null;
        lastFastRoster = null;
      }
      if (pendingRoster === rosterPromise) pendingRoster = null;
    });
    pending = next;
    return next;
  }

  function raceWithFastRoster(full: Promise<LocalAgentTeamsResponse>, roster: Promise<LocalAgentTeamsResponse | null> | null): Promise<LocalAgentTeamsResponse> {
    if (fastRosterTimeoutMs <= 0 || !roster) return full;
    return new Promise<LocalAgentTeamsResponse>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (value: LocalAgentTeamsResponse) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      full.then(done, (error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(error);
      });
      timer = setTimeout(() => {
        void roster.then((fast) => {
          if (fast && !settled) done(fast);
        });
      }, fastRosterTimeoutMs);
    });
  }

  return {
    get(fresh = false): Promise<LocalAgentTeamsResponse> {
      if (!fresh && pending) {
        if (fastRosterTimeoutMs > 0) {
          if (lastResult && lastResult.status === "ready" &&
              !lastResult.teams.some((team) => team.agents.some((member) => member.kind === "pi" && member.contextWindow !== null))) {
            return Promise.resolve({ ...lastResult, enriching: true });
          }
          if (!lastResult && lastFastRoster) return Promise.resolve(lastFastRoster);
          if (!lastResult) return raceWithFastRoster(pending, pendingRoster);
        }
        return pending;
      }
      if (!fresh && lastResult && now() - lastAttempt < 1_000 &&
          !lastResult.teams.some((team) => team.agents.some((member) => member.kind === "pi" && member.contextWindow !== null))) {
        return Promise.resolve(lastResult);
      }
      if (!fresh && fastRosterTimeoutMs > 0 && lastResult && lastResult.status === "ready" &&
          !lastResult.teams.some((team) => team.agents.some((member) => member.kind === "pi" && member.contextWindow !== null))) {
        // Stale-while-revalidate: serve the last verified ready snapshot immediately and refresh in the background
        // so opening or returning to Agent Team never blocks on SQLite/transcript scans.
        void startRefresh();
        return Promise.resolve({ ...lastResult, enriching: true });
      }
      const next = startRefresh();
      if (!fresh && !lastResult) return raceWithFastRoster(next, pendingRoster);
      return next;
    },
  };
}
