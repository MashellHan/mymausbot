import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { LocalAgentMember, LocalAgentState, LocalAgentTeamsResponse, LocalAgentTeam } from "../shared/local-dashboard.ts";
import { augmentedPath } from "./env-path.ts";
import { codexSessionId, createLocalAgentSessionReader, dashboardText } from "./local-agent-session.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";

const execute = promisify(execFile);
const STATES = new Set<LocalAgentState>(["idle", "working", "blocked", "done", "unknown"]);
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

export function createLocalAgentTeamsProvider({ run = runHerdr, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), now = Date.now }: {
  run?: HerdrRunner; codexHome?: string; now?: () => number;
} = {}) {
  const observationsFor = createLocalAgentSessionReader(codexHome, now);
  let lastGood: LocalAgentTeamsResponse | null = null;
  let lastResult: LocalAgentTeamsResponse | null = null;
  let lastAttempt = -Infinity;
  let pending: Promise<LocalAgentTeamsResponse> | null = null;

  async function refresh(): Promise<LocalAgentTeamsResponse> {
    try {
      const responses = await Promise.allSettled([
        run(["--session", "default", "workspace", "list"]),
        run(["--session", "default", "agent", "list"]),
      ]);
      if (responses.some((response) => response.status === "rejected")) throw new Error("Herdr read failed");
      const [workspaceOutput, agentOutput] = responses.map((response) => (response as PromiseFulfilledResult<string>).value);
      const workspaces = herdrRows(workspaceOutput, "workspaces");
      const agents = herdrRows(agentOutput, "agents");
      const teams = new Map<string, LocalAgentTeam>();
      for (const workspace of workspaces) {
        const id = workspace.workspace_id;
        if (typeof id !== "string" || !id || teams.has(id)) throw new Error("Invalid workspace identity");
        teams.set(id, { id, name: dashboardText(workspace.label, 100) || id, agentCount: 0, activeAgentCount: 0, lastActivityAt: null, agents: [] });
      }
      const observations = await observationsFor(agents);
      const seen = new Set<string>();
      for (const agent of agents) {
        const id = agent.pane_id;
        const team = teams.get(String(agent.workspace_id));
        if (typeof id !== "string" || !id || seen.has(id) || !team) throw new Error("Invalid agent identity");
        seen.add(id);
        const sessionId = codexSessionId(agent);
        const observation = sessionId ? observations.get(sessionId) : null;
        if (observation?.lastActivityAt != null) team.lastActivityAt = Math.max(team.lastActivityAt ?? 0, observation.lastActivityAt);
        const tokens = agent.tokens as Record<string, unknown> | null;
        const occupantId = localAgentOccupantId(agent, id);
        const member: LocalAgentMember = {
          id, name: dashboardText(agent.name, 100) || id, kind: dashboardText(agent.agent, 40) || "unknown",
          ...(occupantId ? { occupantId } : {}),
          role: dashboardText(tokens?.role, 40), model: observation?.model ?? null,
          reasoningEffort: observation?.reasoningEffort ?? null, contextUsed: observation?.contextUsed ?? null,
          contextWindow: observation?.contextWindow ?? null, state: state(agent.agent_status), taskHint: observation?.taskHint ?? null,
        };
        team.agents.push(member);
      }
      for (const team of teams.values()) {
        team.agentCount = team.agents.length;
        team.activeAgentCount = team.agents.filter((member) => member.state === "working").length;
      }
      const sessionTeams = new Map<string, Set<string>>();
      for (const agent of agents) {
        const session = codexSessionId(agent);
        if (!session) continue;
        const owners = sessionTeams.get(session) ?? new Set<string>();
        owners.add(String(agent.workspace_id));
        sessionTeams.set(session, owners);
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
      lastGood = { status: "ready", updatedAt: now(), teamCount: teams.size, teams: [...teams.values()] };
      return lastGood;
    } catch {
      return lastGood ? { ...lastGood, status: "stale" } : { status: "unavailable", updatedAt: null, teamCount: null, teams: [] };
    }
  }

  return {
    get(): Promise<LocalAgentTeamsResponse> {
      if (pending) return pending;
      if (lastResult && now() - lastAttempt < 1_000) return Promise.resolve(lastResult);
      lastAttempt = now();
      pending = refresh().then((value) => { lastResult = value; return value; }).finally(() => { pending = null; });
      return pending;
    },
  };
}
