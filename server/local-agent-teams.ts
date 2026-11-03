import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { LocalAgentMember, LocalAgentState, LocalAgentTeamsResponse, LocalAgentTeam } from "../shared/local-dashboard.ts";
import { augmentedPath } from "./env-path.ts";

const execute = promisify(execFile);
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SESSION_FILE = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/;
const STATES = new Set<LocalAgentState>(["idle", "working", "blocked", "done", "unknown"]);
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
const DISCOVERY_LIMIT = 5000;
const MODEL_LIMIT = 64;

type HerdrRunner = (args: readonly string[]) => Promise<string>;

const runHerdr: HerdrRunner = async (args) => (await execute("herdr", [...args], {
  timeout: 4000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true,
  env: { ...process.env, PATH: augmentedPath() },
})).stdout;

function safeText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, limit).join("") : null;
}

function taskHint(value: unknown): string | null {
  const title = safeText(value, 300);
  if (!title) return null;
  const task = title.split(" | ", 1)[0]!.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/, "");
  return safeText(task, 100);
}

function rows(output: string, field: "workspaces" | "agents"): Record<string, unknown>[] {
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

async function entries(path: string): Promise<Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }); }
  catch { return []; }
}

async function sessionFiles(codexHome: string, ids: Set<string>): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  if (!ids.size) return found;
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
        if (inspected > DISCOVERY_LIMIT) return found;
        for (const file of files) {
          const id = file.isFile() ? SESSION_FILE.exec(file.name)?.[1]?.toLowerCase() : undefined;
          if (!id || !ids.has(id)) continue;
          found.set(id, found.has(id) ? null : join(directory, file.name));
        }
      }
    }
  }
  return found;
}

async function modelFromSession(file: string, id: string): Promise<string | null> {
  try {
    const handle = await open(file, "r");
    try {
      const { size } = await handle.stat();
      const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
      const firstRead = await handle.read(head, 0, head.length, 0);
      const firstLine = head.toString("utf8", 0, firstRead.bytesRead).split("\n", 1)[0];
      if (!firstLine || !head.toString("utf8", 0, firstRead.bytesRead).includes("\n")) return null;
      const meta = JSON.parse(firstLine) as { type?: string; payload?: { id?: string } };
      if (meta.type !== "session_meta" || meta.payload?.id?.toLowerCase() !== id) return null;
      const start = Math.max(0, size - TAIL_BYTES);
      const tail = Buffer.alloc(size - start);
      const lastRead = await handle.read(tail, 0, tail.length, start);
      let text = tail.toString("utf8", 0, lastRead.bytesRead);
      if (start) text = text.slice(text.indexOf("\n") + 1);
      for (const line of text.split("\n").reverse()) {
        if (!line.includes('"turn_context"')) continue;
        let event: { type?: string; payload?: { model?: unknown } };
        try { event = JSON.parse(line) as typeof event; }
        catch { continue; }
        const model = event.type === "turn_context" ? event.payload?.model : null;
        if (typeof model === "string" && MODEL.test(model)) return model;
      }
    } finally { await handle.close(); }
  } catch { return null; }
  return null;
}

async function modelsFor(agents: Record<string, unknown>[], codexHome: string): Promise<Map<string, string | null>> {
  const ids = new Set<string>();
  for (const agent of agents) {
    const session = agent.agent_session;
    if (agent.agent !== "codex" || !session || typeof session !== "object") continue;
    const info = session as { kind?: unknown; agent?: unknown; value?: unknown };
    if (ids.size < MODEL_LIMIT && info.kind === "id" && info.agent === "codex" && typeof info.value === "string" && SESSION_ID.test(info.value)) ids.add(info.value.toLowerCase());
  }
  const files = await sessionFiles(codexHome, ids);
  const models = new Map<string, string | null>();
  for (const id of ids) {
    const file = files.get(id);
    models.set(id, file ? await modelFromSession(file, id) : null);
  }
  return models;
}

function state(value: unknown): LocalAgentState {
  return STATES.has(value as LocalAgentState) ? value as LocalAgentState : "unknown";
}

export function createLocalAgentTeamsProvider({ run = runHerdr, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"), now = Date.now }: {
  run?: HerdrRunner; codexHome?: string; now?: () => number;
} = {}) {
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
      const workspaces = rows(workspaceOutput, "workspaces");
      const agents = rows(agentOutput, "agents");
      const teams = new Map<string, LocalAgentTeam>();
      for (const workspace of workspaces) {
        const id = workspace.workspace_id;
        if (typeof id !== "string" || !id || teams.has(id)) throw new Error("Invalid workspace identity");
        teams.set(id, { id, name: safeText(workspace.label, 100) || id, agentCount: 0, agents: [] });
      }
      const models = await modelsFor(agents, codexHome);
      const seen = new Set<string>();
      for (const agent of agents) {
        const id = agent.pane_id;
        const team = teams.get(String(agent.workspace_id));
        if (typeof id !== "string" || !id || seen.has(id) || !team) throw new Error("Invalid agent identity");
        seen.add(id);
        const session = agent.agent_session as { kind?: unknown; agent?: unknown; value?: unknown } | null;
        const sessionId = agent.agent === "codex" && session?.kind === "id" && session.agent === "codex" && typeof session.value === "string" && SESSION_ID.test(session.value)
          ? session.value.toLowerCase() : null;
        const tokens = agent.tokens as Record<string, unknown> | null;
        const member: LocalAgentMember = {
          id, name: safeText(agent.name, 100) || id, kind: safeText(agent.agent, 40) || "unknown",
          role: safeText(tokens?.role, 40), model: sessionId ? models.get(sessionId) || null : null,
          state: state(agent.agent_status), taskHint: taskHint(agent.terminal_title_stripped),
        };
        team.agents.push(member);
      }
      for (const team of teams.values()) team.agentCount = team.agents.length;
      lastGood = { status: "ready", updatedAt: now(), teamCount: teams.size, teams: [...teams.values()] };
      return lastGood;
    } catch {
      return lastGood ? { ...lastGood, status: "stale" } : { status: "unavailable", updatedAt: null, teamCount: null, teams: [] };
    }
  }

  return {
    get(): Promise<LocalAgentTeamsResponse> {
      if (pending) return pending;
      if (lastResult && now() - lastAttempt < 3000) return Promise.resolve(lastResult);
      lastAttempt = now();
      pending = refresh().then((value) => { lastResult = value; return value; }).finally(() => { pending = null; });
      return pending;
    },
  };
}
