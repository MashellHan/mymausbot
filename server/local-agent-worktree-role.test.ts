import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localAgentRoles, verifiedLocalAgentMembers } from "./local-agent-association.ts";
import { createLocalAgentConfigurationProvider } from "./local-agent-configuration.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const execute = promisify(execFile);
const folders: string[] = [];
const session = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const git = async (...args: string[]) => execute("git", ["--no-optional-locks", ...args], { timeout: 5000 });
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "mausbot-worktree-role-")));
  folders.push(home);
  const root = join(home, "workspace/project");
  const worktree = join(home, "workspace/project-upstream");
  const unrelated = join(home, "workspace/other-project");
  const forged = join(home, "workspace/forged-worktree");
  await mkdir(join(root, ".agents/team"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), "Read `.agents/team/playbook.md` and `.agents/team/roles/`.");
  await writeFile(join(root, ".agents/team/playbook.md"),
    "| root-lead | Lead |\n| root-back | Backend |\n| fixture-upstream | Upstream integration |\n");
  await git("init", "-b", "main", root);
  await git("-C", root, "add", "AGENTS.md", ".agents/team/playbook.md");
  await git("-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic project");
  await git("-C", root, "worktree", "add", "-b", "fixture-upstream", worktree);
  await git("init", "-b", "main", unrelated);
  await mkdir(forged, { recursive: true });
  await writeFile(join(forged, ".git"), await readFile(join(worktree, ".git")));
  const agent = (name: string, cwd: string, pane: string, id: number) => ({
    pane_id: pane, workspace_id: "w6", name, cwd, agent: "codex", agent_status: "working",
    agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: session(id) },
  });
  const roots = [agent("root-lead", root, "w6:p1", 1), agent("root-back", root, "w6:p2", 2)];
  const upstream = agent("fixture-upstream", worktree, "w6:p3", 3);
  return { home, root, worktree, unrelated, forged, roots, upstream, agent };
}

describe("declared roles across registered project worktrees", () => {
  it("joins one active registered worktree without rewriting cwd or adding native calls", async () => {
    const data = await fixture();
    const agents = [...data.roots, data.upstream];
    const run = vi.fn(async (args: readonly string[]) => args.at(-2) === "workspace"
      ? JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "Fixture" }] } })
      : JSON.stringify({ result: { agents } }));
    const provider = createLocalAgentTeamsProvider({ home: data.home, codexHome: join(data.home, ".codex"), run, now: () => 1000 });
    const members = (await provider.get()).teams[0]!.agents;
    expect(members.map((member) => [member.name, member.role])).toEqual([
      ["root-lead", "Lead"], ["root-back", "Backend"], ["fixture-upstream", "Upstream integration"],
    ]);
    expect(data.upstream.cwd).toBe(data.worktree);
    expect(run.mock.calls.map(([args]) => args.join(" ")).sort()).toEqual([
      "--session default agent list", "--session default workspace list",
    ]);
  });

  it("rejects unrelated, forged, symlink, malformed and ambiguous worktree associations", async () => {
    const data = await fixture();
    const role = async (candidate: ReturnType<typeof data.agent>, roots = data.roots) =>
      (await localAgentRoles(verifiedLocalAgentMembers([...roots, candidate]), data.home)).get(candidate.pane_id) ?? null;
    expect(await role(data.upstream)).toBe("Upstream integration");
    expect(await role({ ...data.upstream, cwd: data.unrelated })).toBeNull();
    expect(await role({ ...data.upstream, cwd: data.forged })).toBeNull();
    const alias = join(data.home, "workspace/worktree-alias");
    await symlink(data.worktree, alias);
    expect(await role({ ...data.upstream, cwd: alias })).toBeNull();
    expect(await role({ ...data.upstream, cwd: `${data.root}/../project-upstream` })).toBeNull();
    expect(await role(data.upstream, [data.roots[0]!])).toBeNull();
    expect(await role({ ...data.upstream, agent_session: { ...data.upstream.agent_session, value: data.roots[0]!.agent_session.value } })).toBeNull();
    await git("-C", data.root, "worktree", "remove", "--force", data.worktree);
    expect(await role(data.upstream)).toBeNull();
  });

  it("only exposes a registered worktree role document and skill for a unique live member", async () => {
    const data = await fixture();
    const skill = join(data.worktree, ".agents/skills/upstream/SKILL.md");
    await mkdir(join(data.root, ".agents/team/roles"), { recursive: true });
    await mkdir(join(data.worktree, ".agents/skills/upstream"), { recursive: true });
    await writeFile(join(data.root, ".agents/team/roles/upstream.md"),
      `name: Upstream integration\n# Synthetic upstream role\nUse \`${skill}\`.`);
    await writeFile(skill, "# Synthetic upstream skill");
    let agents = [...data.roots, data.upstream];
    const run = async (args: readonly string[]) => JSON.stringify({ result: args.at(-2) === "workspace"
      ? { workspaces: [{ workspace_id: "w6", label: "Fixture" }] }
      : { agents } });
    const provider = createLocalAgentConfigurationProvider({ home: data.home, run,
      discoverSkills: async () => ({ status: "unavailable", skills: [] }) });
    const positive = await provider.getAgent("w6:p3");
    expect(positive).toMatchObject({ agent: { status: "ready", markdown: expect.stringContaining("Synthetic upstream role") },
      skillReferences: "verified", skills: [{ name: "upstream", association: "agent" }] });
    expect((await provider.getSkill("w6:p3", positive.skills[0]!.id)).markdown).toBe("# Synthetic upstream skill");

    for (const duplicate of [
      data.agent("other", data.worktree, "w6:p4", 3),
      data.agent("fixture-upstream", data.worktree, "w6:p4", 4),
    ]) {
      agents = [...data.roots, data.upstream, duplicate];
      expect(await provider.getAgent("w6:p3")).toMatchObject({ occupantId: null,
        agent: { status: "unavailable", markdown: null }, skillReferences: "unverified", skills: [] });
      expect((await provider.getSkill("w6:p3", positive.skills[0]!.id)).status).toBe("unavailable");
    }
  });
});
