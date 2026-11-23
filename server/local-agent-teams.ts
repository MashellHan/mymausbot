import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { LocalAgentMember, LocalAgentState, LocalAgentTeamsResponse, LocalAgentTeam } from "../shared/local-dashboard.ts";
import { OwnedFile } from "./atomic.ts";
import { augmentedPath } from "./env-path.ts";
import { readOpenCodeMessages } from "./local-agent-opencode-message.ts";
import { openCodeSessionId, openCodeUsageDatabase, readOpenCodeMemberUsage } from "./local-agent-opencode-usage.ts";
import { codexSessionId, createLocalAgentSessionReader, dashboardText, unavailableMemberUsage } from "./local-agent-session.ts";
import { PI_CONTEXT_KEY, parsePiContext, readPiProcessStart, type PiProcessStart } from "./local-agent-pi-context.ts";
import { createPiSessionReader, type PiSessionView } from "./local-agent-pi-message.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { localAgentRoles, readDocument, verifiedLocalAgentMembers } from "./local-agent-association.ts";

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

async function restoreBindingStarts(file: OwnedFile): Promise<Map<string, number>> {
  try {
    const saved = await readDocument(dirname(file.path), file.path);
    if (saved.status === "ready") {
      const entries: unknown = JSON.parse(saved.markdown!);
      if (Array.isArray(entries) && entries.length <= 200 && entries.every((entry): entry is [string, number] =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && BINDING_FINGERPRINT.test(entry[0]) &&
        Number.isSafeInteger(entry[1]) && entry[1] >= 0)) {
        file.loaded(saved.markdown!);
        return new Map(entries);
      }
    }
  } catch { /* The cache is optional. */ }
  return new Map();
}

export function createLocalAgentTeamsProvider({ run = runHerdr, home = homedir(), codexHome = process.env.CODEX_HOME || join(home, ".codex"),
  bindingCachePath, now = Date.now, readProcessStart = readPiProcessStart }: {
  run?: HerdrRunner; home?: string; codexHome?: string; bindingCachePath?: string;
  now?: () => number; readProcessStart?: PiProcessStart;
} = {}) {
  const observationsFor = createLocalAgentSessionReader(codexHome, now);
  const piSessionsFor = createPiSessionReader(join(home, ".local", "share", "mausbot-team", "pi-agent"));
  let lastGood: LocalAgentTeamsResponse | null = null;
  let lastResult: LocalAgentTeamsResponse | null = null;
  let lastAttempt = -Infinity;
  let pending: Promise<LocalAgentTeamsResponse> | null = null;
  let revision = 0;
  const bindingFile = bindingCachePath ? new OwnedFile(bindingCachePath, { mode: 0o600 }) : null;
  let restoredBindings: Promise<Map<string, number>> | undefined;
  let bindingStarts: Map<string, number> | undefined;

  async function refresh(current: () => boolean): Promise<LocalAgentTeamsResponse> {
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
      const openCodeIds = [...openCodeSessions.values()];
      const openCodeFile = openCodeUsageDatabase(home);
      const openCodeUsage = readOpenCodeMemberUsage(openCodeFile, openCodeIds, sampledAt);
      const [observations, roles, piSessions] = await Promise.all([
        observationsFor(agents), localAgentRoles(verified, home), piSessionsFor(verified),
      ]);
      const piContexts = await observePiContexts(verified, piSessions, run, readProcessStart, now);
      const openCodeMessages = readOpenCodeMessages(openCodeFile, openCodeIds, "preview");
      const liveUsageMembers = openCodeIds.length || verified.some(codexSessionId)
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
      const previousBindings = bindingStarts ?? await (restoredBindings ??= bindingFile ? restoreBindingStarts(bindingFile) : Promise.resolve(new Map()));
      const nextBindings = new Map<string, number>();
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
        const openCode = openCodeSession ? openCodeMessages.get(openCodeSession) : undefined;
        const observation = sessionId ? observations.get(sessionId) : null;
        const pi = verifiedIds.has(id) ? piSessions.get(id) : null;
        if (observation?.lastActivityAt != null) team.lastActivityAt = Math.max(team.lastActivityAt ?? 0, observation.lastActivityAt);
        const boundSession = verifiedCodexMember ? sessionId : openCodeSession;
        const binding = boundSession && occupantId ? JSON.stringify([id, agent.agent, occupantId, boundSession, agent.cwd, agent.terminal_id]) : null;
        const bindingKey = binding && typeof agent.terminal_id === "string" && agent.terminal_id
          ? createHash("sha256").update(binding).digest("hex") : binding;
        const savedStart = bindingKey ? previousBindings.get(bindingKey) : undefined;
        const switchedAt = savedStart !== undefined && savedStart <= sampledAt ? savedStart : sampledAt;
        if (bindingKey) nextBindings.set(bindingKey, switchedAt);
        const usage = verifiedCodexMember && observation
          ? observation.memberUsage(switchedAt)
          : (openCodeSession ? openCodeUsage.get(openCodeSession)?.(switchedAt) : undefined)
            ?? { tokenUsage24h: unavailableMemberUsage(), tokenUsage7d: unavailableMemberUsage() };
        const member: LocalAgentMember = {
          id, name: dashboardText(agent.name, 100) || id, kind: dashboardText(agent.agent, 40) || "unknown",
          ...(occupantId ? { occupantId } : {}),
          role: dashboardText(roles.get(id), 40), model: observation?.model ?? pi?.model ?? openCode?.model ?? null,
          reasoningEffort: observation?.reasoningEffort ?? pi?.reasoningEffort ?? openCode?.reasoningEffort ?? null, contextUsed: observation?.contextUsed ?? null,
          contextWindow: observation?.contextWindow ?? (current() ? piContexts.get(id) : undefined) ?? null,
          state: state(agent.agent_status), taskHint: observation?.taskHint ?? null,
          messagePreview: verifiedIds.has(id) ? observation?.messagePreview ?? pi?.preview ?? openCode?.preview ?? null : null,
          tokenUsage24h: usage.tokenUsage24h,
          tokenUsage7d: usage.tokenUsage7d,
        };
        team.agents.push(member);
      }
      if (current()) {
        bindingStarts = nextBindings;
        const saved = [...nextBindings].filter(([key]) => BINDING_FINGERPRINT.test(key)).sort();
        try { bindingFile?.write(JSON.stringify(saved)); } catch { /* Keep the in-memory observations. */ }
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
          const session = codexSessionId(agent);
          if (!session || sessionTeams.get(session)?.size !== 1) {
            totals.tokenUsage24h.missing = true;
            totals.tokenUsage7d.missing = true;
            continue;
          }
          if (counted.has(session)) continue;
          counted.add(session);
          for (const key of ["tokenUsage24h", "tokenUsage7d"] as const) {
            const usage = observations.get(session)?.[key];
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
      return lastGood ? { ...lastGood, status: "stale", teams: lastGood.teams.map((team) => ({ ...team,
        agents: team.agents.map((member) => ({ ...member, role: null, messagePreview: null,
          contextWindow: member.kind === "pi" ? null : member.contextWindow })),
      })) } : { status: "unavailable", updatedAt: null, teamCount: null, teams: [] };
    }
  }

  return {
    get(fresh = false): Promise<LocalAgentTeamsResponse> {
      if (!fresh && pending) return pending;
      if (!fresh && lastResult && now() - lastAttempt < 1_000 &&
          !lastResult.teams.some((team) => team.agents.some((member) => member.kind === "pi" && member.contextWindow !== null))) {
        return Promise.resolve(lastResult);
      }
      const request = ++revision;
      lastAttempt = now();
      const next: Promise<LocalAgentTeamsResponse> = refresh(() => request === revision).then((value) => {
        if (request === revision) lastResult = value;
        return value;
      }).finally(() => { if (pending === next) pending = null; });
      pending = next;
      return next;
    },
  };
}
