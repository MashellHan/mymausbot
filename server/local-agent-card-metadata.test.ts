import { appendFile, mkdir, mkdtemp, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { localAgentRoles, readDocument, verifiedLocalAgentMembers } from "./local-agent-association.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const folders: string[] = [];
const row = (type: string, payload: object) => ({ type, timestamp: "2026-11-17T01:00:00Z", payload });
const message = (text: string, phase = "commentary", fields: object = {}) => row("response_item", {
  type: "message", role: "assistant", phase, content: [{ type: "output_text", text }], ...fields,
});
const put = async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
const serialize = (rows: object[]) => rows.map((value) => JSON.stringify(value)).join("\n") + "\n";

afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

async function fixture(events: object[] = [message("Visible synthetic progress")]) {
  const home = await mkdtemp(join(tmpdir(), "mausbot-card-metadata-"));
  folders.push(home);
  const project = join(home, "workspace/project");
  const codexHome = join(home, ".codex");
  const file = join(codexHome, "sessions/2026/11/17", `rollout-2026-11-17-${SESSION}.jsonl`);
  const playbook = join(project, ".agents/team/playbook.md");
  await put(join(project, "AGENTS.md"), "Read `.agents/team/playbook.md` and `.agents/team/roles/`.");
  await put(playbook, "| Herdr name | Role |\n| card-dev | Developer |\n");
  await put(file, serialize([row("session_meta", { id: SESSION }),
    row("turn_context", { model: "observed-model", effort: "max" }),
    row("event_msg", { type: "user_message", message: "Latest synthetic task" }), ...events]));
  const agent = (id = SESSION, name = "card-dev", pane = "w6:p1") => ({
    pane_id: pane, workspace_id: "w6", name, cwd: project, agent: "codex", agent_status: "working",
    agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: id },
    tokens: { role: "Not a verified role" },
  });
  const state: { time: number; offline: boolean; agents: Record<string, unknown>[] } = { time: 1000, offline: false, agents: [agent()] };
  const run = vi.fn(async (args: readonly string[]) => {
    if (state.offline) throw new Error("Synthetic offline observation");
    expect(args).toEqual(["--session", "default", args.at(-2), "list"]);
    if (args.at(-2) === "workspace") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "Fixture team" }] } });
    expect(args.at(-2)).toBe("agent");
    return JSON.stringify({ result: { agents: state.agents } });
  });
  const provider = createLocalAgentTeamsProvider({ home, codexHome, run, now: () => state.time });
  const member = async () => (await provider.get()).teams[0]!.agents[0]!;
  const append = async (events: object[]) => { await appendFile(file, serialize(events)); state.time += 2000; };
  return { home, project, codexHome, file, playbook, agent, state, run, provider, member, append };
}

describe("verified Agent Team card metadata", () => {
  it("returns only the bounded redacted visible assistant text, independently of the latest task", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const data = await fixture([
      row("event_msg", { type: "agent_message", message: "Older visible answer" }),
      message(`Current progress ${secret} /Users/fixture/private/report.md https://private.test/report ./private/file C:\\private\\file ` + "😀".repeat(500), "final_answer", {
        content: [{ type: "output_text", text: `Current progress ${secret} /Users/fixture/private/report.md https://private.test/report ./private/file C:\\private\\file ` + "😀".repeat(500) },
          { type: "tool_result", text: "HIDDEN_TOOL_PART" }],
      }),
      row("event_msg", { type: "user_message", message: "Newest user instruction, not a response" }),
      message("HIDDEN_ANALYSIS", "analysis"),
      row("response_item", { type: "function_call", arguments: "HIDDEN_ARGUMENTS" }),
      row("response_item", { type: "function_call_output", output: "HIDDEN_RESULT" }),
    ]);
    const member = await data.member();
    expect(member).toMatchObject({ role: "Developer", state: "working", model: "observed-model", reasoningEffort: "max",
      taskHint: "Newest user instruction, not a response", occupantId: expect.stringMatching(/^o[0-9a-f]{16}$/) });
    expect(member.messagePreview).toMatch(/^Current progress/);
    expect(Array.from(member.messagePreview!)).toHaveLength(400);
    expect(member.messagePreview).toContain("[path]");
    expect(member.messagePreview).toContain("[link]");
    expect(member.messagePreview).not.toMatch(/ghp_|private|HIDDEN_|Newest user|Older visible|Not a verified role/);
  });

  it.each(["commentary", "final_answer", "final"])("advances the incremental preview for visible %s without replacing taskHint", async (phase) => {
    const data = await fixture();
    expect((await data.member()).messagePreview).toBe("Visible synthetic progress");
    await data.append([message(`Newest ${phase}`, phase)]);
    expect(await data.member()).toMatchObject({ messagePreview: `Newest ${phase}`, taskHint: "Latest synthetic task" });
  });

  it.each([
    message("HIDDEN_ANALYSIS", "analysis"),
    message("HIDDEN_CHANNEL", "commentary", { channel: "analysis" }),
    message("HIDDEN_RECIPIENT", "final", { recipient: "functions.exec" }),
    row("event_msg", { type: "agent_message", channel: "analysis", message: "HIDDEN_LEGACY_ANALYSIS" }),
    row("event_msg", { type: "agent_message", phase: "analysis", message: "HIDDEN_LEGACY_PHASE" }),
    row("event_msg", { type: "user_message", message: "HIDDEN_USER_PREVIEW" }),
    row("response_item", { type: "message", role: "developer", phase: "final", content: [{ type: "output_text", text: "HIDDEN_DEVELOPER" }] }),
    row("response_item", { type: "reasoning", summary: "HIDDEN_REASONING" }),
    message("[From @Fixture (bot) · assignment synthetic · information only]\nHIDDEN_COORDINATOR"),
    message("[aside from @Fixture — peer context, not steering]\nHIDDEN_ASIDE\n[end aside]"),
    message("<SYSTEM_NOTIFICATION>HIDDEN_HARNESS</SYSTEM_NOTIFICATION>"),
    message("<teammate-message>HIDDEN_TEAM_ENVELOPE</teammate-message>"),
    message("HIDDEN_OVERSIZED " + "x".repeat(64 * 1024)),
  ])("ignores hidden, directed, coordinator and oversized records %#", async (hidden) => {
    const data = await fixture();
    await data.member();
    await data.append([hidden]);
    expect((await data.member()).messagePreview).toBe("Visible synthetic progress");
  });

  it("uses legacy visible replies, skips incomplete appends and resets after file replacement", async () => {
    const data = await fixture();
    await data.member();
    await data.append([row("event_msg", { type: "agent_message", message: "Legacy visible response" })]);
    expect((await data.member()).messagePreview).toBe("Legacy visible response");
    const partial = JSON.stringify(message("Completed incremental response", "final"));
    await appendFile(data.file, partial.slice(0, 40));
    data.state.time += 2000;
    expect((await data.member()).messagePreview).toBe("Legacy visible response");
    await appendFile(data.file, partial.slice(40) + "\n");
    data.state.time += 2000;
    expect((await data.member()).messagePreview).toBe("Completed incremental response");
    const replacement = data.file + ".replacement";
    await put(replacement, serialize([row("session_meta", { id: SESSION }), message("Replacement response", "final")]));
    await rename(replacement, data.file);
    data.state.time += 2000;
    expect(await data.member()).toMatchObject({ messagePreview: "Replacement response", taskHint: null });
  });

  it("drops prior metadata when a pane gets a different occupant and does not infer a role from a name or tokens", async () => {
    const data = await fixture();
    const first = await data.member();
    data.state.agents = [data.agent(OTHER, "card-temporary")];
    data.state.time += 2000;
    const next = await data.member();
    expect(next.occupantId).not.toBe(first.occupantId);
    expect(next).toMatchObject({ role: null, messagePreview: null, taskHint: null, state: "working" });
  });

  it("rejects missing and mismatched sources, duplicate session bindings, and unsupported preview runtimes", async () => {
    const data = await fixture();
    for (const source of [undefined, "herdr:pi"]) {
      const current = data.agent();
      data.state.agents = [{ ...current, agent_session: { ...current.agent_session, source } }];
      data.state.time += 2000;
      expect(await data.member()).toMatchObject({ role: null, messagePreview: null });
    }
    data.state.agents = [data.agent(), data.agent(SESSION, "other-member", "w6:p2")];
    data.state.time += 2000;
    expect((await data.provider.get()).teams[0]!.agents.every((member) => member.role === null && member.messagePreview === null)).toBe(true);
    const current = data.agent();
    data.state.agents = [{ ...current, agent: "pi", agent_session: { ...current.agent_session, agent: "pi", source: "herdr:pi" } }];
    data.state.time += 2000;
    expect(await data.member()).toMatchObject({ role: "Developer", messagePreview: null, model: null });
  });

  it("does not return preview text from a mismatched or ambiguously discovered log", async () => {
    const data = await fixture();
    await data.member();
    await writeFile(data.file, serialize([row("session_meta", { id: OTHER }), message("HIDDEN_MISMATCH")]));
    data.state.time += 2000;
    expect((await data.member()).messagePreview).toBeNull();
    await writeFile(data.file, serialize([row("session_meta", { id: SESSION }), message("Visible exact session")]));
    data.state.time += 2000;
    expect((await data.member()).messagePreview).toBe("Visible exact session");
    await put(join(dirname(data.file), `duplicate-${SESSION}.jsonl`), serialize([row("session_meta", { id: SESSION }), message("HIDDEN_DUPLICATE")]));
    data.state.time += 11000;
    expect((await data.member()).messagePreview).toBeNull();
  });

  it("keeps metadata null in a stale snapshot without inventing different tasks or status", async () => {
    const data = await fixture();
    const first = await data.provider.get();
    data.state.offline = true;
    data.state.time += 2000;
    const stale = await data.provider.get();
    expect(stale).toMatchObject({ status: "stale", updatedAt: first.updatedAt });
    expect(stale.teams[0]!.agents[0]).toMatchObject({ role: null, messagePreview: null, state: "working", taskHint: "Latest synthetic task" });
  });

  it("shares the existing snapshot cache and never fans out to Trace, configuration or skills", async () => {
    const data = await fixture();
    const [first, concurrent] = await Promise.all([data.provider.get(), data.provider.get()]);
    expect(first).toEqual(concurrent);
    expect(await data.provider.get()).toEqual(first);
    expect(data.run.mock.calls.map(([args]) => args.join(" ")).sort()).toEqual([
      "--session default agent list", "--session default workspace list",
    ]);
    await data.append([message("Appended without another discovery", "final")]);
    expect((await data.member()).messagePreview).toBe("Appended without another discovery");
    expect(data.run).toHaveBeenCalledTimes(4);
  });

  it("does not let an older pending snapshot restore metadata after a fresh occupant observation", async () => {
    const data = await fixture();
    await writeFile(data.playbook, "| card-dev | Developer |\n| card-review | Reviewer |\n");
    await put(join(dirname(data.file), `rollout-2026-11-17-${OTHER}.jsonl`), serialize([
      row("session_meta", { id: OTHER }), message("New occupant response", "final"),
    ]));
    let release!: () => void, started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { started = resolve; });
    let reads = 0;
    const run = async (args: readonly string[]) => {
      const result = await data.run(args);
      if (args.at(-2) === "agent" && ++reads === 1) { started(); await held; }
      return result;
    };
    const provider = createLocalAgentTeamsProvider({ home: data.home, codexHome: data.codexHome, run, now: () => data.state.time });
    const older = provider.get();
    await reading;
    data.state.agents = [data.agent(OTHER, "card-review")];
    const newer = await provider.get(true);
    expect(newer.teams[0]!.agents[0]).toMatchObject({ name: "card-review", role: "Reviewer", messagePreview: "New occupant response" });
    release();
    await older;
    expect(await provider.get()).toEqual(newer);
    data.state.offline = true;
    const stale = await provider.get(true);
    expect(stale.teams[0]!.agents[0]).toMatchObject({ name: "card-review", role: null, messagePreview: null });
  });

  it("batches role documents once for many cards, with no role-document or skill reads", async () => {
    const data = await fixture();
    const members = Array.from({ length: 40 }, (_, index) => data.agent(
      `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, `member-${index}`, `w6:p${index}`,
    ));
    await writeFile(data.playbook, members.map((member) => `| ${member.name} | Developer |`).join("\n"));
    const read = vi.fn(readDocument);
    const roles = await localAgentRoles(verifiedLocalAgentMembers(members), data.home, read);
    expect(roles.size).toBe(40);
    expect(read.mock.calls.map(([, file]) => file)).toEqual([join(data.project, "AGENTS.md"), data.playbook]);
    data.state.agents = members;
    expect((await data.provider.get()).teams[0]!.agents.every((member) => member.role === "Developer")).toBe(true);
    expect(data.run).toHaveBeenCalledTimes(2);
  });

  it("revalidates declarations without a stale role cache and rejects ambiguous or redirected documents", async () => {
    const data = await fixture();
    expect((await data.member()).role).toBe("Developer");
    await writeFile(data.playbook, "| card-dev | Developer |\n| card-dev | Reviewer |\n");
    data.state.time += 2000;
    expect((await data.member()).role).toBeNull();
    await writeFile(data.playbook, "| card-dev | " + "D".repeat(60) + " |\n");
    data.state.time += 2000;
    expect((await data.member()).role).toHaveLength(40);
    await unlink(data.playbook);
    const elsewhere = join(data.home, "elsewhere.md");
    await put(elsewhere, "| card-dev | Unverified |\n");
    await symlink(elsewhere, data.playbook);
    data.state.time += 2000;
    expect((await data.member()).role).toBeNull();
  });

  it("binds saved team roles to the exact session member and never falls back to a stale name", async () => {
    const data = await fixture();
    await writeFile(join(data.project, "AGENTS.md"), "# Project with external team association");
    const team = join(data.home, "workspace/.agents/teams/fixture-team");
    const metadata = join(team, "session.json");
    const member = { pane_id: "w6:p1", agent_name: "card-dev", agent_session_id: SESSION, role: "developer" };
    const save = async (members: object[]) => put(metadata, JSON.stringify({ workspace_id: "w6", herdr_session: "default", project_root: data.project, members }));
    await save([member]);
    await put(join(team, "playbook.md"), "# Declared team");
    await put(join(team, "README.md"), "| Developer | card-dev | model | max | [developer](roles/developer.md) |");
    expect((await data.member()).role).toBe("Developer");
    data.state.agents = [data.agent(OTHER)];
    data.state.time += 2000;
    expect((await data.member()).role).toBeNull();
    await save([{ ...member, agent_session_id: OTHER }, { ...member, agent_session_id: OTHER }]);
    data.state.time += 2000;
    expect((await data.member()).role).toBeNull();
    await save([{ ...member, agent_session_id: OTHER }]);
    await put(join(team, "README.md"), "| Developer | card-dev | model | max | [reviewer](roles/reviewer.md) |");
    data.state.time += 2000;
    expect((await data.member()).role).toBeNull();
  });
});
