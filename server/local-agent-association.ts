import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fromMarkdown } from "mdast-util-from-markdown";

import type { LocalAgentConfigurationDocument } from "../shared/local-dashboard.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { codexSessionId } from "./local-agent-session.ts";

const PANE_ID = /^w\d+:p[0-9A-Za-z]+$/;
const MAX_DOCUMENT_BYTES = 128 * 1024;
const empty = (status: LocalAgentConfigurationDocument["status"]): LocalAgentConfigurationDocument => ({ status, markdown: null });
export const inside = (root: string, file: string) => {
  const part = relative(root, file);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

export async function readDocument(root: string, file: string): Promise<LocalAgentConfigurationDocument> {
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

type DocumentReader = typeof readDocument;
export type TeamSource = { root: string; playbook: string; roles: string; roleFiles?: Map<string, string>; worktrees?: Set<string>;
  sessionDocument?: LocalAgentConfigurationDocument };
type Role = { label: string; file: string | null };
const executeGit = promisify(execFile);

async function gitOutput(root: string, args: string[]): Promise<string | null> {
  try {
    return (await executeGit("git", ["--no-optional-locks", "-C", root, ...args], {
      timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true,
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
    })).stdout;
  } catch { return null; }
}

async function gitIdentity(root: string): Promise<{ common: string } | null> {
  const output = await gitOutput(root, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  const lines = output?.split("\n");
  if (lines?.length !== 3 || lines[0] !== root || !lines[1] || lines[2] !== "") return null;
  try { return { common: await realpath(lines[1]) }; } catch { return null; }
}

async function registeredWorktrees(root: string, candidates: string[]): Promise<Set<string>> {
  const matched = new Set<string>();
  if (!candidates.length || candidates.length > 20 || root !== resolve(root)) return matched;
  try { if (await realpath(root) !== root) return matched; } catch { return matched; }
  const [identity, listed] = await Promise.all([
    gitIdentity(root),
    gitOutput(root, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  if (!identity || !listed) return matched;
  const registered = new Set(listed.split("\0").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9)));
  if (!registered.has(root)) return matched;
  const canonical = await Promise.all(candidates.filter((candidate) => candidate !== root &&
    candidate === resolve(candidate) && registered.has(candidate)).map(async (candidate) =>
    await realpath(candidate).catch(() => null) === candidate ? candidate : null));
  const candidateIdentities = await Promise.all(canonical.filter((candidate) => candidate !== null).map(async (candidate) => ({
    candidate, identity: await gitIdentity(candidate),
  })));
  for (const entry of candidateIdentities) {
    if (entry.identity?.common === identity.common) matched.add(entry.candidate);
  }
  return matched;
}

async function savedTeamSource(agents: Record<string, unknown>[], teamId: string, home: string, read: DocumentReader): Promise<{ source: TeamSource | null; error: boolean }> {
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
    const document = await read(teamsRoot, join(root, "session.json"));
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
    if (roleFiles.size) candidates.push({ root, playbook: join(root, "playbook.md"), roles: join(root, "roles"), roleFiles, sessionDocument: document });
  }
  return { source: candidates.length === 1 ? candidates[0]! : null, error: error || candidates.length > 1 };
}

export async function teamSource(agents: Record<string, unknown>[], teamId: string, home: string, read: DocumentReader = readDocument): Promise<{ source: TeamSource | null; error: boolean }> {
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
    const guide = await read(root, join(root, "AGENTS.md"));
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
  if (source) return { source: { ...source,
    worktrees: await registeredWorktrees(source.root, [...counts.keys()].filter((cwd) => cwd !== source.root)) }, error };
  const saved = await savedTeamSource(agents, teamId, home, read);
  return { source: saved.source, error: error || saved.error };
}

const cells = (line: string) => line.startsWith("|") && line.endsWith("|") ? line.slice(1, -1).split("|").map((part) => part.trim()) : [];
const roleLink = (cell: string) => /^\[[^\]]+\]\((roles\/[a-z][a-z0-9-]*\.md)\)$/.exec(cell)?.[1];

function rosterRows(markdown: string, grouped: boolean, requireTable: boolean): string[][] {
  if (!markdown.includes("|")) return [];
  const rows: string[][] = [];
  const legacy: string[][] = [];
  let hasRoster = false;
  for (const block of fromMarkdown(markdown).children) {
    if (block.type !== "paragraph" || !block.position) continue;
    const [header = [], separator = [], ...body] = markdown.slice(block.position.start.offset, block.position.end.offset)
      .split(/\r?\n/).map((line) => cells(line.trim()));
    if (separator.length < 2 || !separator.every((cell) => /^:?-+:?$/.test(cell))) {
      if (!requireTable) legacy.push(header, separator, ...body);
      continue;
    }
    if (header.length !== separator.length) continue;
    const columns = header.join("|");
    if (grouped ? columns !== "Role|Agent|Model|Effort|Role file" && columns !== "角色|Herdr agent|模型|推理强度|定义"
      : header[0] !== "Herdr name" || header[1] !== "Role") continue;
    hasRoster = true;
    for (const parts of body) {
      if (!parts.length) break;
      if (parts.length !== header.length) continue;
      rows.push(grouped ? parts : [parts[0]!, parts[1]!, parts[header.indexOf("Role file")] ?? ""]);
    }
  }
  return hasRoster ? rows : legacy;
}

export function teamRoleRoster(playbook: LocalAgentConfigurationDocument, readme: LocalAgentConfigurationDocument, requireTable = false) {
  return { rules: rosterRows(playbook.markdown ?? "", false, requireTable), grouped: rosterRows(readme.markdown ?? "", true, requireTable) };
}

type TeamRoleRoster = ReturnType<typeof teamRoleRoster>;

function declaredRole(name: string, roster: TeamRoleRoster): Role | null | undefined {
  const fromRules = roster.rules.filter((parts) => parts[0] === name && /^[A-Za-z][A-Za-z ]+$/.test(parts[1] ?? ""));
  const fromReadme = roster.grouped.filter((parts) => parts[1]?.split(/[、,，]/).some((entry) => entry.trim() === name) &&
    /^[A-Za-z][A-Za-z ]+$/.test(parts[0] ?? "") && roleLink(parts[4] ?? ""));
  if (fromRules.length > 1 || fromReadme.length > 1) return null;
  const ruleLabel = fromRules[0]?.[1];
  const readmeLabel = fromReadme[0]?.[0];
  if (ruleLabel && readmeLabel && ruleLabel.toLowerCase() !== readmeLabel.toLowerCase()) return null;
  const label = ruleLabel ?? readmeLabel;
  if (!label) return undefined;
  const ruleFiles = fromRules[0]?.slice(2).map(roleLink).filter(Boolean) ?? [];
  const readmeFile = roleLink(fromReadme[0]?.[4] ?? "");
  if (ruleFiles.length > 1 || (ruleFiles[0] && readmeFile && ruleFiles[0] !== readmeFile)) return null;
  const file = ruleFiles[0] ?? readmeFile ?? null;
  return { label, file };
}

export function memberRole(source: TeamSource, member: Record<string, unknown>, roster: TeamRoleRoster): Role | null {
  const declared = declaredRole(String(member.name), roster);
  if (source.roleFiles) {
    const file = source.roleFiles.get(String(member.pane_id));
    return file && declared !== null && (!declared?.file || declared.file === file)
      ? { label: declared?.label ?? basename(file, ".md"), file } : null;
  }
  return member.cwd === source.root || source.worktrees?.has(String(member.cwd)) ? declared ?? null : null;
}

export function verifiedLocalAgentMembers(agents: Record<string, unknown>[]): Record<string, unknown>[] {
  const key = (agent: Record<string, unknown>) => {
    const session = agent.agent_session as Record<string, unknown> | null;
    return JSON.stringify([session?.source, codexSessionId(agent) ?? session?.value]);
  };
  return agents.filter((agent) => {
    const pane = agent.pane_id;
    const session = agent.agent_session as Record<string, unknown> | null;
    return typeof pane === "string" && PANE_ID.test(pane) && pane.startsWith(`${agent.workspace_id}:`) &&
      typeof agent.agent === "string" && session?.source === `herdr:${agent.agent}` && localAgentOccupantId(agent, pane) &&
      agents.filter((row) => row.pane_id === pane || row.name === agent.name || key(row) === key(agent)).length === 1;
  });
}

export async function localAgentRoles(agents: Record<string, unknown>[], home: string, read: DocumentReader = readDocument): Promise<Map<string, string>> {
  const documents = new Map<string, Promise<LocalAgentConfigurationDocument>>();
  const cachedRead: DocumentReader = (root, file) => {
    const key = JSON.stringify([root, file]);
    let pending = documents.get(key);
    if (!pending) { pending = read(root, file); documents.set(key, pending); }
    return pending;
  };
  const roles = new Map<string, string>();
  const teams = new Set(agents.map((agent) => String(agent.workspace_id)));
  for (const teamId of teams) {
    const { source, error } = await teamSource(agents, teamId, home, cachedRead);
    if (!source || error) continue;
    const playbook = await cachedRead(source.root, source.playbook);
    const readme = dirname(source.playbook) === source.root ? await cachedRead(source.root, join(source.root, "README.md")) : empty("unverified");
    if (playbook.status === "error" || readme.status === "error") continue;
    const roster = teamRoleRoster(playbook, readme);
    for (const member of agents.filter((agent) => agent.workspace_id === teamId)) {
      const role = memberRole(source, member, roster);
      if (role) roles.set(String(member.pane_id), role.label);
    }
  }
  return roles;
}
