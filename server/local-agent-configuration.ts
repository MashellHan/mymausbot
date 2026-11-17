import { createHash } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { LocalAgentConfigurationDocument, LocalAgentConfigurationResponse, LocalAgentConfigurationSkill,
  LocalAgentSkillDocumentResponse, LocalAgentTeamRulesResponse } from "../shared/local-dashboard.ts";
import { herdrRows, runHerdr, type HerdrRunner } from "./local-agent-teams.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { discoverCodexSkills, type CodexSkillDiscovery } from "./local-agent-skill-discovery.ts";
import { inside, memberRole, readDocument, teamSource, verifiedLocalAgentMembers, type TeamSource } from "./local-agent-association.ts";

const PANE_ID = /^w\d+:p[0-9A-Za-z]+$/;
const TEAM_ID = /^w\d+$/;
const SKILL_ID = /^s[0-9a-f]{16}$/;
const empty = (status: LocalAgentConfigurationDocument["status"]): LocalAgentConfigurationDocument => ({ status, markdown: null });
const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

type LiveRows = { workspaces: Record<string, unknown>[]; agents: Record<string, unknown>[] };
type SkillReference = { path: string; association: "agent" | "team" | "codex"; name?: string; codexAvailable?: boolean };

async function liveRows(run: HerdrRunner): Promise<LiveRows | null> {
  try {
    const [workspaces, agents] = await Promise.all([
      run(["--session", "default", "workspace", "list"]),
      run(["--session", "default", "agent", "list"]),
    ]);
    return { workspaces: herdrRows(workspaces, "workspaces"), agents: herdrRows(agents, "agents") };
  } catch { return null; }
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

function skillRoot(home: string, cwd: string, path: string): { root: string; base: string } | undefined {
  return [{ root: join(home, ".agents/skills"), base: home }, { root: join(home, ".codex/skills"), base: home },
    { root: join(cwd, ".agents/skills"), base: cwd }, { root: join(cwd, ".codex/skills"), base: cwd }]
    .find(({ root }) => inside(resolve(root), resolve(path)));
}

async function readSkill(home: string, cwd: string, path: string): Promise<LocalAgentConfigurationDocument> {
  const allowed = skillRoot(home, cwd, path);
  if (!allowed || basename(path) !== "SKILL.md") return empty("error");
  try {
    const canonicalBase = await realpath(allowed.base);
    const expectedRoot = join(canonicalBase, relative(allowed.base, allowed.root));
    if (await realpath(allowed.root) !== expectedRoot) return empty("error");
  } catch (error) { return empty((error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error"); }
  return readDocument(allowed.root, path);
}

export function createLocalAgentConfigurationProvider({ run = runHerdr, home = homedir(), discoverSkills = discoverCodexSkills }: {
  run?: HerdrRunner; home?: string; discoverSkills?: (cwd: string) => Promise<CodexSkillDiscovery>;
} = {}) {
  async function context(teamId: string, agentId?: string) {
    const live = await liveRows(run);
    if (!live || live.workspaces.filter((workspace) => workspace.workspace_id === teamId).length !== 1) return null;
    const agents = verifiedLocalAgentMembers(live.agents);
    const member = agentId ? agents.filter((agent) => agent.pane_id === agentId && agent.workspace_id === teamId) : [];
    if (agentId && member.length !== 1) return null;
    const selected = await teamSource(agents, teamId, home);
    const playbook = selected.source ? await readDocument(selected.source.root, selected.source.playbook)
      : empty(selected.error ? "error" : "unverified");
    return { source: selected.source, playbook, member: member[0] ?? null };
  }

  async function memberConfiguration(agentId: string) {
    const teamId = agentId.split(":")[0]!;
    const unavailable: LocalAgentConfigurationResponse = { agentId, teamId, occupantId: null,
      agent: empty("unavailable"), skillReferences: "unverified", skillDiscovery: "unavailable", skills: [] };
    if (!PANE_ID.test(agentId)) return { response: unavailable, references: [] as SkillReference[], cwd: null };
    const found = await context(teamId, agentId);
    if (!found?.member) return { response: unavailable, references: [] as SkillReference[], cwd: null };
    const occupantId = localAgentOccupantId(found.member, agentId);
    if (!occupantId) return { response: { ...unavailable, agent: empty("unverified") }, references: [] as SkillReference[], cwd: null };
    const cwd = typeof found.member.cwd === "string" && isAbsolute(found.member.cwd) &&
      found.member.cwd.length < 4096 && !found.member.cwd.includes("\0") ? found.member.cwd : null;
    const discovered = found.member.agent === "codex" && cwd
      ? await discoverSkills(cwd).catch((): CodexSkillDiscovery => ({ status: "error", skills: [] }))
      : { status: "unavailable", skills: [] } as CodexSkillDiscovery;
    const readme = found.source && dirname(found.source.playbook) === found.source.root
      ? await readDocument(found.source.root, join(found.source.root, "README.md")) : empty("unverified");
    const roleFile = found.source?.roleFiles?.get(agentId);
    const role = found.source ? memberRole(found.source, found.member, found.playbook, readme) : null;
    const agent = found.source ? await agentDocument(found.source, role) : empty(found.playbook.status);
    const references = found.source && (!found.source.roleFiles || roleFile)
      ? skillReferences(role, agent, found.playbook, home) : [];
    const combined = new Map(references.map((reference) => [reference.path, reference]));
    let skillDiscovery = discovered.status;
    for (const skill of discovered.skills) {
      if (!cwd || !isAbsolute(skill.path) || !skillRoot(home, cwd, skill.path)) { skillDiscovery = "partial"; continue; }
      const current = combined.get(skill.path);
      combined.set(skill.path, current ? { ...current, codexAvailable: true }
        : { path: skill.path, name: skill.name, association: "codex", codexAvailable: true });
    }
    const verifiedReferences = [...combined.values()].sort((a, b) =>
      (a.name ?? basename(dirname(a.path))).localeCompare(b.name ?? basename(dirname(b.path))));
    const skills: LocalAgentConfigurationSkill[] = verifiedReferences.map(({ path, name, association, codexAvailable }) => ({
      id: skillHandle(occupantId, path), name: name ?? basename(dirname(path)), association,
      ...(codexAvailable ? { codexAvailable: true } : {}), loadedState: "unknown",
    }));
    const response: LocalAgentConfigurationResponse = { agentId, teamId, occupantId, agent,
      skillReferences: found.source && (!found.source.roleFiles || roleFile) &&
        (found.playbook.status === "ready" || agent.status === "ready") ? "verified" : "unverified",
      skillDiscovery, skills };
    return { response, references: verifiedReferences, cwd };
  }

  return {
    async getAgent(agentId: string): Promise<LocalAgentConfigurationResponse> {
      return (await memberConfiguration(agentId)).response;
    },
    async getSkill(agentId: string, skillId: string): Promise<LocalAgentSkillDocumentResponse> {
      const { response, references, cwd } = await memberConfiguration(agentId);
      const base = { agentId: response.agentId, teamId: response.teamId, occupantId: response.occupantId, skillId };
      const reference = SKILL_ID.test(skillId) && response.occupantId
        ? references.find(({ path }) => skillHandle(response.occupantId!, path) === skillId) : null;
      return { ...base, ...(reference && cwd ? await readSkill(home, cwd, reference.path) : empty("unavailable")) };
    },
    async getTeamRules(teamId: string): Promise<LocalAgentTeamRulesResponse> {
      if (!TEAM_ID.test(teamId)) return { teamId, ...empty("unavailable") };
      const found = await context(teamId);
      return { teamId, ...(found?.playbook ?? empty("unavailable")) };
    },
  };
}
