import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { LocalAgentConfigurationDocument, LocalAgentConfigurationResponse, LocalAgentConfigurationSkill,
  LocalAgentSkillDocumentResponse, LocalAgentTeamRulesResponse } from "../shared/local-dashboard.ts";
import { herdrRows, runHerdr, type HerdrRunner } from "./local-agent-teams.ts";

const PANE_ID = /^w\d+:p[0-9A-Za-z]+$/;
const TEAM_ID = /^w\d+$/;
const SKILL_ID = /^s[0-9a-f]{16}$/;
const MAX_DOCUMENT_BYTES = 128 * 1024;
const empty = (status: LocalAgentConfigurationDocument["status"]): LocalAgentConfigurationDocument => ({ status, markdown: null });
const row = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const inside = (root: string, file: string) => {
  const part = relative(root, file);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

async function readDocument(root: string, file: string): Promise<LocalAgentConfigurationDocument> {
  if (!isAbsolute(root) || !isAbsolute(file) || !inside(resolve(root), resolve(file))) return empty("error");
  let base: string;
  try { base = await realpath(root); } catch { return empty("error"); }
  let entry;
  try { entry = await lstat(file); }
  catch (error) { return empty((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error"); }
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_DOCUMENT_BYTES) return empty("error");
  let canonical: string;
  try { canonical = await realpath(file); } catch { return empty("error"); }
  if (!inside(base, canonical)) return empty("error");
  let handle;
  try { handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return empty("error"); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size > MAX_DOCUMENT_BYTES) return empty("error");
    const bytes = Buffer.alloc(stat.size);
    for (let offset = 0; offset < bytes.length;) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) return empty("error");
      offset += read.bytesRead;
    }
    if (!inside(base, await realpath(file))) return empty("error");
    return { status: "ready", markdown: bytes.toString("utf8") };
  } catch { return empty("error"); }
  finally { await handle.close(); }
}

type LiveRows = { workspaces: Record<string, unknown>[]; agents: Record<string, unknown>[] };
type TeamSource = { root: string; playbook: string; roles: string };
type SkillReference = { path: string; association: "agent" | "team" };

async function liveRows(run: HerdrRunner): Promise<LiveRows | null> {
  try {
    const [workspaces, agents] = await Promise.all([
      run(["--session", "default", "workspace", "list"]),
      run(["--session", "default", "agent", "list"]),
    ]);
    return { workspaces: herdrRows(workspaces, "workspaces"), agents: herdrRows(agents, "agents") };
  } catch { return null; }
}

function verifiedOccupant(agent: Record<string, unknown>, agentId: string): string | null {
  const session = row(agent.agent_session);
  if (typeof session.source !== "string" || typeof session.value !== "string" || !session.source || !session.value ||
      typeof agent.name !== "string" || !agent.name) return null;
  return `o${digest(`${agentId}\0${agent.name}\0${session.source}\0${session.value}`)}`;
}

async function teamSource(agents: Record<string, unknown>[], teamId: string): Promise<{ source: TeamSource | null; error: boolean }> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const cwd = agent.cwd;
    const pane = agent.pane_id;
    if (agent.workspace_id === teamId && typeof pane === "string" && PANE_ID.test(pane) && pane.startsWith(`${teamId}:`) &&
        typeof cwd === "string" && isAbsolute(cwd) && cwd.length < 4096 && !cwd.includes("\0") &&
        verifiedOccupant(agent, pane)) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }
  if (counts.size > 20) return { source: null, error: true };
  const candidates: Array<TeamSource & { count: number }> = [];
  let error = false;
  for (const [root, count] of counts) {
    const guide = await readDocument(root, join(root, "AGENTS.md"));
    if (guide.status === "error") { error = true; continue; }
    if (guide.status !== "ready") continue;
    const repo = guide.markdown!.includes("`.agents/team/playbook.md`") && guide.markdown!.includes("`.agents/team/roles/`");
    const direct = guide.markdown!.includes("`playbook.md`") && guide.markdown!.includes("`roles/`");
    if (repo === direct) continue;
    const playbook = join(root, repo ? ".agents/team/playbook.md" : "playbook.md");
    candidates.push({ root, playbook, roles: join(dirname(playbook), "roles"), count });
  }
  candidates.sort((a, b) => b.count - a.count);
  return { source: candidates[0] && candidates[0].count > (candidates[1]?.count ?? 0) ? candidates[0] : null, error };
}

const cells = (line: string) => line.startsWith("|") && line.endsWith("|") ? line.slice(1, -1).split("|").map((part) => part.trim()) : [];

function declaredRole(name: string, playbook: LocalAgentConfigurationDocument, readme: LocalAgentConfigurationDocument): { label: string; file: string | null } | null {
  const fromRules = playbook.markdown?.split("\n").map(cells).filter((parts) => parts[0] === name && /^[A-Za-z][A-Za-z ]+$/.test(parts[1] ?? "")) ?? [];
  const fromReadme = readme.markdown?.split("\n").map(cells).filter((parts) => parts[1] === name &&
    /^[A-Za-z][A-Za-z ]+$/.test(parts[0] ?? "") && /^\[[^\]]+\]\(roles\/[a-z][a-z0-9-]*\.md\)$/.test(parts[4] ?? "")) ?? [];
  if (fromRules.length > 1 || fromReadme.length > 1) return null;
  const ruleLabel = fromRules[0]?.[1];
  const readmeLabel = fromReadme[0]?.[0];
  if (ruleLabel && readmeLabel && ruleLabel.toLowerCase() !== readmeLabel.toLowerCase()) return null;
  const label = ruleLabel ?? readmeLabel;
  if (!label) return null;
  const file = /^\[[^\]]+\]\((roles\/[a-z][a-z0-9-]*\.md)\)$/.exec(fromReadme[0]?.[4] ?? "")?.[1] ?? null;
  return { label, file };
}

async function agentDocument(source: TeamSource, role: { label: string; file: string | null } | null): Promise<LocalAgentConfigurationDocument> {
  if (!role) return empty("unverified");
  if (role.file) return readDocument(source.root, join(dirname(source.playbook), role.file));
  let names: string[];
  try {
    if (!inside(await realpath(source.root), await realpath(source.roles))) return empty("error");
    names = (await readdir(source.roles)).filter((name) => /^[a-z][a-z0-9-]*\.md$/.test(name));
    if (names.length > 40) return empty("error");
  }
  catch { return empty("error"); }
  const matches: LocalAgentConfigurationDocument[] = [];
  for (const name of names) {
    const doc = await readDocument(source.root, join(source.roles, name));
    if (doc.status === "error") return doc;
    const declaredName = /^name:\s*(.+)$/m.exec(doc.markdown ?? "")?.[1]?.toLowerCase();
    if (declaredName && declaredName.includes(role.label.toLowerCase())) matches.push(doc);
  }
  return matches.length === 1 ? matches[0]! : empty("unverified");
}

function skillPaths(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\r\n]+\/SKILL\.md)`/g)].map((match) => match[1]!);
}

function skillReferences(role: { label: string; file: string | null } | null, agent: LocalAgentConfigurationDocument,
  playbook: LocalAgentConfigurationDocument, home: string): SkillReference[] {
  const paths: SkillReference[] = [];
  for (const path of skillPaths(agent.markdown ?? "")) paths.push({ path, association: "agent" });
  if (playbook.markdown) {
    for (const line of playbook.markdown.split("\n")) {
      if (role && new RegExp(`\\b${role.label}\\b`, "i").test(line)) {
        for (const path of skillPaths(line)) paths.push({ path, association: "team" });
      }
    }
    if (/Use the Herdr skill for Herdr operations|Herdr 技能/.test(playbook.markdown)) {
      paths.push({ path: join(home, ".agents/skills/herdr/SKILL.md"), association: "team" });
    }
    if (/Consult the github-accounts skill/.test(playbook.markdown)) {
      paths.push({ path: join(home, ".codex/skills/github-accounts/SKILL.md"), association: "team" });
    }
  }
  const seen = new Set<string>();
  return paths.filter(({ path }) => { if (seen.has(path)) return false; seen.add(path); return true; })
    .sort((a, b) => basename(dirname(a.path)).localeCompare(basename(dirname(b.path))));
}

function skillHandle(occupantId: string, path: string): string { return `s${digest(`${occupantId}\0${path}`)}`; }

async function readSkill(home: string, path: string): Promise<LocalAgentConfigurationDocument> {
  const roots = [join(home, ".agents/skills"), join(home, ".codex/skills")];
  const root = roots.find((candidate) => inside(resolve(candidate), resolve(path)));
  if (!root || basename(path) !== "SKILL.md") return empty("error");
  try {
    const canonicalHome = await realpath(home);
    if (await realpath(root) !== join(canonicalHome, relative(home, root))) return empty("error");
  } catch (error) { return empty((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error"); }
  return readDocument(root, path);
}

export function createLocalAgentConfigurationProvider({ run = runHerdr, home = homedir() }: { run?: HerdrRunner; home?: string } = {}) {
  async function context(teamId: string, agentId?: string) {
    const live = await liveRows(run);
    if (!live || live.workspaces.filter((workspace) => workspace.workspace_id === teamId).length !== 1) return null;
    const member = agentId ? live.agents.filter((agent) => agent.pane_id === agentId && agent.workspace_id === teamId) : [];
    if (agentId && member.length !== 1) return null;
    const selected = await teamSource(live.agents, teamId);
    const playbook = selected.source ? await readDocument(selected.source.root, selected.source.playbook)
      : empty(selected.error ? "error" : "unverified");
    return { source: selected.source, playbook, member: member[0] ?? null };
  }

  async function memberConfiguration(agentId: string) {
    const teamId = agentId.split(":")[0]!;
    const unavailable: LocalAgentConfigurationResponse = { agentId, teamId, occupantId: null,
      agent: empty("unavailable"), skillReferences: "unverified", skills: [] };
    if (!PANE_ID.test(agentId)) return { response: unavailable, references: [] as SkillReference[] };
    const found = await context(teamId, agentId);
    if (!found?.member) return { response: unavailable, references: [] as SkillReference[] };
    const occupantId = verifiedOccupant(found.member, agentId);
    if (!occupantId) return { response: { ...unavailable, agent: empty("unverified") }, references: [] as SkillReference[] };
    if (!found.source) return { response: { ...unavailable, occupantId, agent: empty(found.playbook.status) }, references: [] as SkillReference[] };
    const readme = dirname(found.source.playbook) === found.source.root
      ? await readDocument(found.source.root, join(found.source.root, "README.md")) : empty("unverified");
    const role = declaredRole(String(found.member.name), found.playbook, readme);
    const agent = await agentDocument(found.source, role);
    const references = skillReferences(role, agent, found.playbook, home);
    const skills: LocalAgentConfigurationSkill[] = references.map(({ path, association }) => ({
      id: skillHandle(occupantId, path), name: basename(dirname(path)), association, loadedState: "unknown",
    }));
    const response: LocalAgentConfigurationResponse = { agentId, teamId, occupantId, agent,
      skillReferences: found.playbook.status === "ready" || agent.status === "ready" ? "verified" : "unverified", skills };
    return { response, references };
  }

  return {
    async getAgent(agentId: string): Promise<LocalAgentConfigurationResponse> {
      return (await memberConfiguration(agentId)).response;
    },
    async getSkill(agentId: string, skillId: string): Promise<LocalAgentSkillDocumentResponse> {
      const { response, references } = await memberConfiguration(agentId);
      const base = { agentId: response.agentId, teamId: response.teamId, occupantId: response.occupantId, skillId };
      const reference = SKILL_ID.test(skillId) && response.occupantId
        ? references.find(({ path }) => skillHandle(response.occupantId!, path) === skillId) : null;
      return { ...base, ...(reference ? await readSkill(home, reference.path) : empty("unavailable")) };
    },
    async getTeamRules(teamId: string): Promise<LocalAgentTeamRulesResponse> {
      if (!TEAM_ID.test(teamId)) return { teamId, ...empty("unavailable") };
      const found = await context(teamId);
      return { teamId, ...(found?.playbook ?? empty("unavailable")) };
    },
  };
}
