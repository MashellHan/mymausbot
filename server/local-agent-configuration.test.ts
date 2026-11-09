import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { createLocalAgentConfigurationProvider } from "./local-agent-configuration.ts";

const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });
const noDiscovery = async () => ({ status: "ready" as const, skills: [] });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "mausbot-agent-config-"));
  folders.push(home);
  const repo = join(home, "workspace", "OpenMausBot");
  const mini = join(home, "workspace", ".agents", "teams", "mini-apps");
  const skill = (root: ".agents" | ".codex", name: string) => join(home, root, "skills", name, "SKILL.md");
  const put = async (path: string, content: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); };
  await put(join(repo, "AGENTS.md"), "Read `.agents/team/playbook.md` and the assigned role in `.agents/team/roles/`.");
  await put(join(repo, ".agents/team/playbook.md"), [
    "# MausBot development team", "| Herdr name | Role |", "| --- | --- |", "| mausbot-design | Designer |",
    "Use the Herdr skill for Herdr operations.", "Consult the github-accounts skill for repository auth.",
    `Designer follows \`${skill(".codex", "impeccable")}\`.`,
  ].join("\n"));
  await put(join(repo, ".agents/team/roles/designer.md"), "---\nname: MausBot Designer\n---\n# Agent design rules");
  await put(join(mini, "AGENTS.md"), "Read `playbook.md` and the explicitly assigned role in `roles/`.");
  await put(join(mini, "README.md"), [
    "| Role | Agent | Model | Effort | Role file |", "| --- | --- | --- | --- | --- |",
    "| Designer | miniapp-design | sol | high | [designer](roles/designer.md) |",
    "| Lead | miniapp-lead | astra | high | [leader](roles/leader.md) |",
  ].join("\n"));
  await put(join(mini, "playbook.md"), `# Actual mini-apps playbook\nRead the Herdr 技能.\nLead uses \`${skill(".codex", "ponytail")}\`.`);
  await put(join(mini, "TEAM.md"), "# Wrong team rules");
  await put(join(mini, "roles/designer.md"), `# Designer\n你是 miniapp-design。用 \`${skill(".agents", "hallmark")}\` 和 \`${skill(".codex", "impeccable")}\`。`);
  await put(join(mini, "roles/leader.md"), "# Lead\n你是 miniapp-lead。");
  for (const [root, name] of [[".agents", "herdr"], [".agents", "hallmark"], [".codex", "github-accounts"],
    [".codex", "impeccable"], [".codex", "ponytail"]] as const) await put(skill(root, name), `# ${name} actual SKILL.md`);
  const members = [
    { pane_id: "w6:p2", workspace_id: "w6", name: "mausbot-design", cwd: repo },
    { pane_id: "w6:pF", workspace_id: "w6", name: "mausbot-mini-review", cwd: repo },
    { pane_id: "w8:p1", workspace_id: "w8", name: "miniapp-lead", cwd: mini },
    { pane_id: "w8:p4", workspace_id: "w8", name: "miniapp-design", cwd: mini },
  ];
  const agent = (name: typeof members[number], session = name.name) => ({ ...name, agent: "codex", agent_session: {
    source: "herdr:codex", value: session,
  } });
  const run = async (args: readonly string[]) => JSON.stringify({ result: args.at(-2) === "workspace"
    ? { workspaces: [{ workspace_id: "w6", label: "mymausbot" }, { workspace_id: "w8", label: "Mini Apps" }] }
    : { agents: members.map((member) => agent(member)) } });
  return { home, repo, mini, skill, put, members, agent, run };
}

describe("verified local Agent Team configuration", () => {
  it("binds the real role and multiple declared skills without claiming session loading", async () => {
    const data = await fixture();
    const provider = createLocalAgentConfigurationProvider({ home: data.home, run: data.run, discoverSkills: noDiscovery });
    const design = await provider.getAgent("w6:p2");
    expect(design).toMatchObject({ agentId: "w6:p2", teamId: "w6", agent: { status: "ready", markdown: expect.stringContaining("# Agent design rules") },
      skillReferences: "verified", skills: [
        { name: "github-accounts", association: "team", loadedState: "unknown" },
        { name: "herdr", association: "team", loadedState: "unknown" },
        { name: "impeccable", association: "team", loadedState: "unknown" },
      ] });
    expect(design.occupantId).toMatch(/^o[0-9a-f]{16}$/);
    for (const skill of design.skills) {
      expect(await provider.getSkill("w6:p2", skill.id)).toMatchObject({ agentId: "w6:p2", teamId: "w6",
        occupantId: design.occupantId, skillId: skill.id, status: "ready", markdown: `# ${skill.name} actual SKILL.md` });
    }
    expect(await provider.getTeamRules("w6")).toEqual({ teamId: "w6", status: "ready", markdown: expect.stringContaining("# MausBot development team") });
    const temporary = await provider.getAgent("w6:pF");
    expect(temporary.agent).toEqual({ status: "unverified", markdown: null });
    expect(temporary.skills.map((skill) => skill.name)).toEqual(["github-accounts", "herdr"]);
  });

  it("keeps verified role and declared skills when optional Codex discovery times out", async () => {
    const data = await fixture();
    const provider = createLocalAgentConfigurationProvider({ home: data.home, run: data.run,
      discoverSkills: async () => ({ status: "timeout", skills: [] }) });
    const result = await provider.getAgent("w6:p2");
    expect(result).toMatchObject({ agent: { status: "ready", markdown: expect.stringContaining("# Agent design rules") },
      skillReferences: "verified", skillDiscovery: "timeout" });
    expect(result.skills.map((skill) => skill.name)).toEqual(["github-accounts", "herdr", "impeccable"]);
    expect((await provider.getSkill("w6:p2", result.skills[2]!.id)).status).toBe("ready");
  });

  it("uses the exact Mini Apps playbook and role links, then distinguishes absent and failed reads", async () => {
    const data = await fixture();
    const provider = createLocalAgentConfigurationProvider({ home: data.home, run: data.run, discoverSkills: noDiscovery });
    const design = await provider.getAgent("w8:p4");
    expect(design.agent).toEqual({ status: "ready", markdown: expect.stringContaining("miniapp-design") });
    expect(design.skills.map((skill) => [skill.name, skill.loadedState])).toEqual([
      ["hallmark", "unknown"], ["herdr", "unknown"], ["impeccable", "unknown"],
    ]);
    const lead = await provider.getAgent("w8:p1");
    expect(lead.skills.map((skill) => skill.name)).toEqual(["herdr", "ponytail"]);
    expect((await provider.getTeamRules("w8")).markdown).toContain("Actual mini-apps playbook");
    const playbook = join(data.mini, "playbook.md");
    await unlink(playbook);
    expect(await provider.getTeamRules("w8")).toEqual({ teamId: "w8", status: "missing", markdown: null });
    await mkdir(playbook);
    expect(await provider.getTeamRules("w8")).toEqual({ teamId: "w8", status: "error", markdown: null });
    await rm(playbook, { recursive: true });
    const outside = join(data.home, "wrong-playbook.md");
    await data.put(outside, "# Wrong team rules");
    await symlink(outside, playbook);
    expect(await provider.getTeamRules("w8")).toEqual({ teamId: "w8", status: "error", markdown: null });
  });

  it("reports missing and unreadable SKILL.md, and rejects role and skill symlink escapes", async () => {
    const data = await fixture();
    const provider = createLocalAgentConfigurationProvider({ home: data.home, run: data.run, discoverSkills: noDiscovery });
    const design = await provider.getAgent("w8:p4");
    const hallmark = design.skills.find((skill) => skill.name === "hallmark")!;
    const path = data.skill(".agents", "hallmark");
    await unlink(path);
    expect((await provider.getSkill("w8:p4", hallmark.id)).status).toBe("missing");
    await mkdir(path);
    expect((await provider.getSkill("w8:p4", hallmark.id)).status).toBe("error");
    const outside = join(data.home, "outside.md");
    await data.put(outside, "# private outside content");
    await rm(path, { recursive: true });
    await symlink(outside, path);
    expect((await provider.getSkill("w8:p4", hallmark.id)).status).toBe("error");
    const role = join(data.mini, "roles/designer.md");
    await unlink(role);
    expect((await provider.getAgent("w8:p4")).agent).toEqual({ status: "missing", markdown: null });
    await symlink(outside, role);
    expect((await provider.getAgent("w8:p4")).agent).toEqual({ status: "error", markdown: null });
    expect(JSON.stringify(await provider.getAgent("w8:p4"))).not.toContain("private outside content");
    await unlink(role);
    await data.put(join(data.mini, "README.md"), "| Designer | miniapp-design | sol | high | [designer](roles/../outside.md) |");
    expect((await provider.getAgent("w8:p4")).agent.status).toBe("unverified");
  });

  it("rejects skill-root redirects into sibling private directories under home and cwd", async () => {
    const data = await fixture();
    const homeRoot = join(data.home, ".codex/skills");
    const homeSibling = join(data.home, "workspace/department-b/private-skills");
    await data.put(join(homeSibling, "impeccable/SKILL.md"), "# private home sibling");
    await rm(homeRoot, { recursive: true });
    await symlink(homeSibling, homeRoot);
    const cwdRoot = join(data.repo, ".agents/skills");
    const cwdSibling = join(data.repo, "department-b/private-skills");
    await data.put(join(cwdSibling, "review/SKILL.md"), "# private cwd sibling");
    await symlink(cwdSibling, cwdRoot);
    const provider = createLocalAgentConfigurationProvider({ home: data.home, run: data.run,
      discoverSkills: async () => ({ status: "ready", skills: [{ name: "review", path: join(cwdRoot, "review/SKILL.md") }] }) });
    const result = await provider.getAgent("w6:p2");
    for (const name of ["impeccable", "review"]) {
      const skill = result.skills.find((item) => item.name === name)!;
      expect((await provider.getSkill("w6:p2", skill.id)).status).toBe("error");
    }
    expect(JSON.stringify(result)).not.toMatch(/private home sibling|private cwd sibling/);
  });

  it("revalidates the live occupant for opaque skill handles and binds concurrent results to their own identity", async () => {
    const data = await fixture();
    let reads = 0;
    let releaseFirst!: () => void;
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const waitFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const run = async (args: readonly string[]) => JSON.stringify({ result: args.at(-2) === "workspace"
      ? { workspaces: [{ workspace_id: "w8", label: "Mini Apps" }] }
      : { agents: [data.agent(data.members[3]!, "second-session"), data.agent(data.members[2]!, "lead-session")] } });
    const delayedRun = async (args: readonly string[]) => {
      if (args.at(-2) !== "agent") return run(args);
      if (++reads === 1) {
        startedFirst();
        await waitFirst;
        return JSON.stringify({ result: { agents: [data.agent(data.members[3]!, "first-session")] } });
      }
      return run(args);
    };
    const provider = createLocalAgentConfigurationProvider({ home: data.home, run: delayedRun, discoverSkills: noDiscovery });
    const firstRead = provider.getAgent("w8:p4");
    await firstStarted;
    const second = await provider.getAgent("w8:p4");
    releaseFirst();
    const first = await firstRead;
    expect(second.occupantId).not.toBe(first.occupantId);
    expect((await provider.getSkill("w8:p4", first.skills[0]!.id)).status).toBe("unavailable");
    expect((await provider.getSkill("w8:p4", second.skills[0]!.id)).status).toBe("ready");
    expect((await provider.getAgent("w8:p4")).agentId).toBe("w8:p4");
    const switched = await provider.getAgent("w8:p1");
    expect(switched).toMatchObject({ agentId: "w8:p1", teamId: "w8", agent: { status: "ready", markdown: expect.stringContaining("miniapp-lead") } });
    expect(switched.occupantId).not.toBe(second.occupantId);
    expect((await provider.getAgent("w8:p4/../p1")).agent.status).toBe("unavailable");
    expect((await provider.getTeamRules("../w8")).status).toBe("unavailable");
  });

  it("binds an external Herdr team record to the live pane and keeps Codex discovery separate from session loading", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-safety-config-"));
    folders.push(home);
    const project = join(home, "workspace/m365-mobile-analysis");
    const team = join(home, "workspace/.agents/teams/copilot-safety");
    const put = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value); };
    const metadata = join(team, "session.json");
    const playbook = join(team, "playbook.md");
    const desktop = join(home, ".codex/skills/agent-desktop/SKILL.md");
    const herdr = join(home, ".agents/skills/herdr/SKILL.md");
    await put(join(project, "AGENTS.md"), "# Project instructions without a team playbook marker");
    await put(metadata, JSON.stringify({ workspace_id: "w7", herdr_session: "default", project_root: project,
      members: [{ pane_id: "w7:p1", agent_name: "safety-lead", agent_session_id: "session-one", role: "leader" }] }));
    await put(playbook, "# Exact Copilot Safety playbook");
    await put(join(team, "README.md"), "| Lead | safety-lead | astra | max | [leader](roles/leader.md) |");
    await put(join(team, "roles/leader.md"), "# Verified Safety Lead role");
    await put(desktop, "# Actual agent-desktop SKILL.md");
    await put(herdr, "# Actual herdr SKILL.md");
    let session = "session-one";
    const run = async (args: readonly string[]) => JSON.stringify({ result: args.at(-2) === "workspace"
      ? { workspaces: [{ workspace_id: "w7", label: "Copilot Safety" }] }
      : { agents: [{ workspace_id: "w7", pane_id: "w7:p1", name: "safety-lead", cwd: project, agent: "codex",
        agent_session: { source: "herdr:codex", value: session } }] } });
    const provider = createLocalAgentConfigurationProvider({ home, run, discoverSkills: async (cwd) => {
      expect(cwd).toBe(project);
      return { status: "ready", skills: [{ name: "agent-desktop", path: desktop }, { name: "herdr", path: herdr }] };
    } });
    const first = await provider.getAgent("w7:p1");
    expect(first).toMatchObject({ agent: { status: "ready", markdown: "# Verified Safety Lead role" },
      skillReferences: "verified", skillDiscovery: "ready", skills: [
        { name: "agent-desktop", association: "codex", codexAvailable: true, loadedState: "unknown" },
        { name: "herdr", association: "codex", codexAvailable: true, loadedState: "unknown" },
      ] });
    expect((await provider.getTeamRules("w7")).markdown).toBe("# Exact Copilot Safety playbook");
    expect((await provider.getSkill("w7:p1", first.skills[0]!.id)).markdown).toBe("# Actual agent-desktop SKILL.md");
    await unlink(playbook);
    expect((await provider.getTeamRules("w7")).status).toBe("missing");
    session = "session-two";
    const replaced = await provider.getAgent("w7:p1");
    expect(replaced.agent.status).toBe("unverified");
    expect(replaced.skillDiscovery).toBe("ready");
    expect(replaced.occupantId).not.toBe(first.occupantId);
    expect((await provider.getSkill("w7:p1", first.skills[0]!.id)).status).toBe("unavailable");
    await unlink(metadata);
    await symlink(join(home, "outside.json"), metadata);
    expect((await provider.getTeamRules("w7")).status).toBe("error");
    const escaped = await mkdtemp(join(tmpdir(), "mausbot-escaped-team-"));
    folders.push(escaped);
    const teamsRoot = join(home, "workspace/.agents/teams");
    await rm(teamsRoot, { recursive: true });
    await symlink(escaped, teamsRoot);
    expect((await provider.getTeamRules("w7")).status).toBe("error");
  });
});
