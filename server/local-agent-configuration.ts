import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { LocalAgentConfigurationDocument, LocalAgentConfigurationResponse, LocalAgentConfigurationSkill,
  LocalAgentSkillDocumentResponse, LocalAgentTeamRulesResponse } from "../shared/local-dashboard.ts";
import { herdrRows, runHerdr, type HerdrRunner } from "./local-agent-teams.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { discoverCodexSkills, type CodexSkillDiscovery } from "./local-agent-skill-discovery.ts";

const PANE_ID = /^w\d+:p[0-9A-Za-z]+$/;
const TEAM_ID = /^w\d+$/;
const SKILL_ID = /^s[0-9a-f]{16}$/;
const MAX_DOCUMENT_BYTES = 128 * 1024;
const empty = (status: LocalAgentConfigurationDocument["status"]): LocalAgentConfigurationDocument => ({ status, markdown: null });
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
type TeamSource = { root: string; playbook: string; roles: string; roleFiles?: Map<string, string> };
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

async function savedTeamSource(agents: Record<string, unknown>[], teamId: string, home: string): Promise<{ source: TeamSource | null; error: boolean }> {
  const teamsRoot = join(home, "workspace/.agents/teams");
  try {
    if (!inside(await realpath(home), await realpath(teamsRoot))) return { source: null, error: true };
  } catch (error) { return { source: null, error: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
  let directories;
  try { directories = await readdir(teamsRoot, { withFileTypes: true }); }
  catch (error) { return { source: null, error: (error as NodeJS.ErrnoException).code !== "ENOENT" }; }
  if (directories.length > 64) return { source: null, error: true };
  const candidates: TeamSource[] = [];
  let error = false;
  for (const directory of directories) {
    if (!directory.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(directory.name)) continue;
    const root = join(teamsRoot, directory.name);
    const document = await readDocument(teamsRoot, join(root, "session.json"));
    if (document.status === "missing") continue;
    if (document.status !== "ready") { error = true; continue; }
    let metadata: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(document.markdown!);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid team metadata");
      metadata = parsed as Record<string, unknown>;
    }
    catch { error = true; continue; }
    if (metadata.workspace_id !== teamId || metadata.herdr_session !== "default" ||
        typeof metadata.project_root !== "string" || !isAbsolute(metadata.project_root) ||
        !Array.isArray(metadata.members) || metadata.members.length > 40) continue;
    const roleFiles = new Map<string, string>();
    for (const agent of agents) {
      if (agent.workspace_id !== teamId || agent.cwd !== metadata.project_root ||
          typeof agent.pane_id !== "string" || !PANE_ID.test(agent.pane_id) ||
          !localAgentOccupantId(agent, agent.pane_id)) continue;
      const session = agent.agent_session as Record<string, unknown> | null;
      const matched = metadata.members.filter((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const member = value as Record<string, unknown>;
        return member.pane_id === agent.pane_id && member.agent_name === agent.name &&
          member.agent_session_id === session?.value && typeof member.role === "string" &&
          /^[a-z][a-z0-9-]{0,39}$/.test(member.role);
      }) as Record<string, unknown>[];
      if (matched.length === 1) roleFiles.set(agent.pane_id, `roles/${matched[0]!.role}.md`);
    }
    if (roleFiles.size) candidates.push({ root, playbook: join(root, "playbook.md"), roles: join(root, "roles"), roleFiles });
  }
  return { source: candidates.length === 1 ? candidates[0]! : null, error: error || candidates.length > 1 };
}

async function teamSource(agents: Record<string, unknown>[], teamId: string, home: string): Promise<{ source: TeamSource | null; error: boolean }> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const cwd = agent.cwd;
    const pane = agent.pane_id;
    if (agent.workspace_id === teamId && typeof pane === "string" && PANE_ID.test(pane) && pane.startsWith(`${teamId}:`) &&
        typeof cwd === "string" && isAbsolute(cwd) && cwd.length < 4096 && !cwd.includes("\0") &&
        localAgentOccupantId(agent, pane)) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
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
  const source = candidates[0] && candidates[0].count > (candidates[1]?.count ?? 0) ? candidates[0] : null;
  if (source) return { source, error };
  const saved = await savedTeamSource(agents, teamId, home);
  return { source: saved.source, error: error || saved.error };
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
    const member = agentId ? live.agents.filter((agent) => agent.pane_id === agentId && agent.workspace_id === teamId) : [];
    if (agentId && member.length !== 1) return null;
    const selected = await teamSource(live.agents, teamId, home);
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
    const declared = found.source ? declaredRole(String(found.member.name), found.playbook, readme) : null;
    const roleFile = found.source?.roleFiles?.get(agentId);
    const role = found.source?.roleFiles
      ? roleFile && (!declared?.file || declared.file === roleFile)
        ? { label: declared?.label ?? basename(roleFile, ".md"), file: roleFile } : null
      : declared;
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
