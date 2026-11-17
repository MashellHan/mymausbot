import { mkdtemp, mkdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPiSessionReader } from "./local-agent-pi-message.ts";
import { createLocalAgentActivityProvider } from "./local-agent-activity.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";
import { createLocalDashboardRoutes } from "./routes/local-dashboard.ts";
import type { RouteContext } from "./routes/table.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const folders: string[] = [];
const line = (value: object) => JSON.stringify(value) + "\n";
const entry = (id: string, parentId: string | null, message: object) => ({
  type: "message", id, parentId, timestamp: "2026-11-17T01:00:00.000Z", message,
});
const assistant = (text: string, id = "a1b2c3d4", parentId: string | null = null) =>
  entry(id, parentId, { role: "assistant", content: [{ type: "text", text }] });

afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

async function fixture(rows: object[] = [assistant("Visible Pi progress")], projectPath = "workspace/project") {
  const home = await mkdtemp(join(tmpdir(), "mausbot-pi-card-"));
  folders.push(home);
  const project = join(home, projectPath);
  const piRoot = join(home, ".local/share/mausbot-team/pi-agent");
  const directory = join(piRoot, "sessions", `--${project.slice(1).replaceAll("/", "-")}--`);
  const file = join(directory, `2026-11-17T01-00-00-000Z_${SESSION}.jsonl`);
  await mkdir(directory, { recursive: true });
  const header = (id = SESSION, cwd = project) => ({ type: "session", version: 3, id, timestamp: "2026-11-17T01:00:00.000Z", cwd });
  const save = async (data: object[], id = SESSION, cwd = project) =>
    writeFile(file, [header(id, cwd), ...data].map(line).join(""));
  await save(rows);
  const agent = (value = file, name = "pi-dev", pane = "w6:p1") => ({
    pane_id: pane, workspace_id: "w6", name, cwd: project, agent: "pi", agent_status: "working",
    agent_session: { kind: "path", agent: "pi", source: "herdr:pi", value },
  });
  const reader = createPiSessionReader(piRoot);
  return { home, project, piRoot, directory, file, header, save, agent, reader };
}

describe("verified Pi visible assistant preview", () => {
  it("returns only shared-redacted text blocks with a 400-codepoint limit", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const data = await fixture([entry("a1b2c3d4", null, {
      role: "assistant", content: [
        { type: "thinking", thinking: "HIDDEN_THINKING" },
        { type: "toolCall", name: "shell", arguments: { secret: "HIDDEN_TOOL" } },
        { type: "text", text: `Progress ${secret} /Users/fixture/private/report.md https://private.test/report ` + "😀".repeat(500) },
      ],
    })]);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    const preview = view.preview!;
    expect(view.truncated).toBe(true);
    expect(preview).toMatch(/^Progress /);
    expect(Array.from(preview)).toHaveLength(400);
    expect(preview).toContain("[path]");
    expect(preview).toContain("[link]");
    expect(preview).not.toMatch(/ghp_|private|HIDDEN_/);
  });

  it("walks the current branch and ignores later user, tool, thinking and coordinator records", async () => {
    const data = await fixture([
      assistant("Current branch answer", "a1b2c3d4"),
      entry("b1b2c3d4", "a1b2c3d4", { role: "user", content: "HIDDEN_USER" }),
      assistant("Abandoned branch answer", "c1b2c3d4", "b1b2c3d4"),
      entry("d1b2c3d4", "a1b2c3d4", { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "HIDDEN_RESULT" }] }),
      entry("e1b2c3d4", "d1b2c3d4", { role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN_REASONING" }] }),
      assistant("[From @Fixture (bot) - assignment synthetic - information only]\nHIDDEN_COORDINATOR", "f1b2c3d4", "e1b2c3d4"),
    ]);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    expect(view.preview).toBe("Current branch answer");
    expect(view.events.map((event) => [event.kind, event.text])).toEqual([
      ["assistant", "Current branch answer"],
      ["tool-result", "[Result details unavailable]"],
    ]);
  });

  it("fails closed for mismatched header, escaped path, symlink and duplicate bindings", async () => {
    const data = await fixture();
    expect((await data.reader([data.agent()])).get("w6:p1")?.preview).toBe("Visible Pi progress");
    await data.save([assistant("HIDDEN_MISMATCH")], OTHER);
    expect((await data.reader([data.agent()])).get("w6:p1")).toBeNull();
    await data.save([assistant("HIDDEN_CWD")], SESSION, join(data.home, "elsewhere"));
    expect((await data.reader([data.agent()])).get("w6:p1")).toBeNull();
    await data.save([assistant("Visible Pi progress")]);
    expect((await data.reader([data.agent(join(data.home, "elsewhere.jsonl"))])).size).toBe(0);
    expect((await data.reader([data.agent(data.file + "/../" + basename(data.file))])).size).toBe(0);
    const replacement = data.file + ".original";
    await rename(data.file, replacement);
    await symlink(replacement, data.file);
    expect((await data.reader([data.agent()])).get("w6:p1")).toBeNull();
    await rename(replacement, data.file);
    expect((await data.reader([data.agent(), data.agent(data.file, "other-pi", "w6:p2")])).get("w6:p1")).toBeNull();
  });

  it("reports malformed, incomplete and oversized records as unavailable", async () => {
    const data = await fixture();
    await writeFile(data.file, line(data.header()) + JSON.stringify(assistant("Incomplete")));
    expect((await data.reader([data.agent()])).get("w6:p1")).toBeNull();
    await writeFile(data.file, line(data.header()) + "{bad json}\n");
    expect((await data.reader([data.agent()])).get("w6:p1")).toBeNull();
    await data.save([assistant("x".repeat(1024 * 1024))]);
    expect((await data.reader([data.agent()])).get("w6:p1")).toBeNull();
    await data.save([assistant("Orphan", "a1b2c3d4", "b1b2c3d4")]);
    expect((await data.reader([data.agent()])).get("w6:p1")).toBeNull();
  });

  it("keeps short visible text across large hidden thinking, arguments and tool results", async () => {
    const data = await fixture([
      entry("a1b2c3d4", null, { role: "assistant", content: [
        { type: "text", text: "Visible before tool" },
        { type: "thinking", thinking: "HIDDEN_THINKING" + "x".repeat(320 * 1024) },
        { type: "toolCall", id: "call-1", name: "shell.run", arguments: { secret: "HIDDEN_ARGUMENT" + "y".repeat(220 * 1024) } },
      ] }),
      entry("b1b2c3d4", "a1b2c3d4", { role: "toolResult", toolCallId: "call-1", toolName: "shell.run",
        content: [{ type: "text", text: "HIDDEN_RESULT" + "z".repeat(120 * 1024) }] }),
      assistant("Visible after tool", "c1b2c3d4", "b1b2c3d4"),
      entry("d1b2c3d4", "c1b2c3d4", { role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN_LAST" + "x".repeat(320 * 1024) }] }),
    ]);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    expect(view.preview).toBe("Visible after tool");
    expect(view.events.map((event) => [event.kind, event.text, event.tool])).toEqual([
      ["assistant", "Visible before tool", null], ["tool-call", "[Arguments unavailable]", "shell.run"],
      ["tool-result", "[Result details unavailable]", "shell.run"], ["assistant", "Visible after tool", null],
    ]);
    expect(JSON.stringify(view)).not.toMatch(/HIDDEN_/);
  });

  it("reads the bounded tail of a file above 8 MiB and marks missing history truncated", async () => {
    const rows: object[] = [assistant("Old text", "00000000")];
    for (let index = 1; index <= 18; index++) {
      rows.push(entry(index.toString(16).padStart(8, "0"), (index - 1).toString(16).padStart(8, "0"),
        { role: "toolResult", toolCallId: `call-${index}`, content: [{ type: "text", text: "HIDDEN_RESULT" + "z".repeat(500 * 1024) }] }));
    }
    rows.push(assistant("Latest visible text", "00000013", "00000012"));
    const data = await fixture(rows);
    expect((await stat(data.file)).size).toBeGreaterThan(8 * 1024 * 1024);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    expect(view.preview).toBe("Latest visible text");
    expect(view.truncated).toBe(true);
    expect(view.events.at(-1)?.text).toBe("Latest visible text");
    expect(JSON.stringify(view)).not.toMatch(/Old text|HIDDEN_/);
  });

  it("caps current-branch events and tool metadata without losing the latest assistant preview", async () => {
    const rows = Array.from({ length: 70 }, (_, index) => entry(index.toString(16).padStart(8, "0"),
      index ? (index - 1).toString(16).padStart(8, "0") : null,
      { role: "assistant", content: [{ type: "text", text: `Visible ${index}` },
        { type: "toolCall", id: `call-${index}`, name: "shell.run", arguments: { hidden: "HIDDEN_ARGUMENT" } }] }));
    const data = await fixture(rows);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    expect(view.preview).toBe("Visible 69");
    expect(view.truncated).toBe(true);
    expect(view.events).toHaveLength(60);
    expect(view.events.filter((event) => event.kind === "tool-call")).toHaveLength(30);
    expect(JSON.stringify(view)).not.toContain("HIDDEN_ARGUMENT");
  });

  it("serves a real Pi provider through the owner Trace route with only safe tool metadata", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const data = await fixture([
      entry("a1b2c3d4", null, { role: "user", content: `Review /Users/fixture/private/notes.txt ${secret}` }),
      entry("b1b2c3d4", "a1b2c3d4", { role: "assistant", content: [
        { type: "text", text: "I will check" },
        { type: "thinking", thinking: "HIDDEN_THINKING" },
        { type: "toolCall", id: "call-1", name: "shell.run", arguments: { secret: "HIDDEN_ARGUMENT" } },
      ] }),
      entry("c1b2c3d4", "b1b2c3d4", { role: "toolResult", toolCallId: "call-1", toolName: "shell.run",
        content: [{ type: "text", text: "HIDDEN_OUTPUT" }] }),
      assistant("Finished safely", "d1b2c3d4", "c1b2c3d4"),
      entry("e1b2c3d4", "d1b2c3d4", { role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN_LAST" }] }),
    ]);
    const run = vi.fn(async (args: readonly string[]) => args.at(-2) === "workspace"
      ? JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "Fixture" }] } })
      : JSON.stringify({ result: { agents: [data.agent()] } }));
    const activity = createLocalAgentActivityProvider({ home: data.home, run, now: () => 1000 });
    const handler = createLocalDashboardRoutes({
      agents: createLocalAgentTeamsProvider({ home: data.home, run, now: () => 1000 }), activity,
      configuration: { getAgent: async () => { throw new Error("unexpected"); },
        getSkill: async () => { throw new Error("unexpected"); }, getTeamRules: async () => { throw new Error("unexpected"); } },
      usage: { get: async () => { throw new Error("unexpected"); } },
    });
    let response: { status: number; body: unknown } | null = null;
    await handler({ method: "GET", path: "/api/local-dashboard/agents/w6%3Ap1/activity",
      url: new URL("http://127.0.0.1/api/local-dashboard/agents/w6%3Ap1/activity"),
      auth: { kind: "loopback", scopes: ["admin"] }, req: { socket: { remoteAddress: "127.0.0.1" } },
      res: { setHeader: () => undefined }, json: (_res: unknown, status: number, body: unknown) => { response = { status, body }; },
      readBody: async () => { throw new Error("unexpected"); },
    } as unknown as RouteContext);
    expect(response).toMatchObject({ status: 200, body: { status: "ready", truncated: false, events: [
      { kind: "user", tool: null }, { kind: "assistant", text: "I will check" },
      { kind: "tool-call", tool: "shell.run", text: "[Arguments unavailable]" },
      { kind: "tool-result", tool: "shell.run", text: "[Result details unavailable]" },
      { kind: "assistant", text: "Finished safely" },
    ] } });
    expect(JSON.stringify(response)).not.toMatch(/ghp_|private|HIDDEN_/);
    expect((await activity.get("w6:p1")).events).toHaveLength(5);
  });

  it("rejects secret-shaped Pi tool names from both call and result Trace fields", async () => {
    const secretName = "ghp_" + "x".repeat(36);
    const data = await fixture([
      entry("a1b2c3d4", null, { role: "assistant", content: [
        { type: "text", text: "Visible work" },
        { type: "toolCall", id: "safe", name: "shell.run", arguments: { hidden: "HIDDEN_SAFE_ARGS" } },
        { type: "toolCall", id: "sensitive", name: secretName, arguments: { hidden: "HIDDEN_SECRET_ARGS" } },
      ] }),
      entry("b1b2c3d4", "a1b2c3d4", { role: "toolResult", toolCallId: "safe", content: [{ type: "text", text: "HIDDEN_SAFE_RESULT" }] }),
      entry("c1b2c3d4", "b1b2c3d4", { role: "toolResult", toolCallId: "sensitive", content: [{ type: "text", text: "HIDDEN_SECRET_RESULT" }] }),
    ]);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    expect(view.events.map((event) => [event.kind, event.tool])).toEqual([
      ["assistant", null], ["tool-call", "shell.run"], ["tool-result", "shell.run"], ["tool-result", null],
    ]);
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: [data.agent()] } }) });
    const response = await activity.get("w6:p1");
    expect(response.status).toBe("ready");
    expect(JSON.stringify(response)).not.toMatch(/ghp_|HIDDEN_/);
  });

  it("revalidates header cwd on a warm same-file cache hit when Pi path encoding collides", async () => {
    const data = await fixture([assistant("First occupant text")], "workspace/a/b");
    const collidingCwd = join(data.home, "workspace/a-b");
    const first = data.agent();
    const second = { ...first, cwd: collidingCwd };
    expect((await data.reader([first])).get("w6:p1")?.preview).toBe("First occupant text");
    expect((await data.reader([second])).get("w6:p1")).toBeNull();
    let roster = [first];
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: roster } }) });
    expect((await activity.get("w6:p1")).events[0]?.text).toBe("First occupant text");
    roster = [second];
    expect(await activity.get("w6:p1")).toMatchObject({ status: "unavailable", events: [] });
    roster = [first];
    let now = 1000;
    const teams = createLocalAgentTeamsProvider({ home: data.home, codexHome: join(data.home, ".codex"), now: () => now,
      run: async (args) => args.at(-2) === "workspace"
        ? JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "Fixture" }] } })
        : JSON.stringify({ result: { agents: roster } }) });
    expect((await teams.get()).teams[0]!.agents[0]!.messagePreview).toBe("First occupant text");
    roster = [second];
    now += 2000;
    expect((await teams.get()).teams[0]!.agents[0]!.messagePreview).toBeNull();
  });

  it("drops an old Pi session after occupant replacement or ambiguous binding", async () => {
    const data = await fixture([assistant("Old occupant")]);
    const otherFile = join(data.directory, `2026-11-17T01-01-00-000Z_${OTHER}.jsonl`);
    await writeFile(otherFile, [data.header(OTHER), assistant("New occupant")].map(line).join(""));
    let roster = [data.agent()];
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: roster } }) });
    expect((await activity.get("w6:p1")).events.map((event) => event.text)).toEqual(["Old occupant"]);
    roster = [data.agent(otherFile)];
    expect((await activity.get("w6:p1")).events.map((event) => event.text)).toEqual(["New occupant"]);
    roster = [data.agent(otherFile), data.agent(otherFile, "another", "w6:p2")];
    expect(await activity.get("w6:p1")).toMatchObject({ status: "unavailable", events: [] });
    roster = [data.agent()];
    expect((await activity.get("w6:p1")).events.map((event) => event.text)).toEqual(["Old occupant"]);
  });

  it("joins the same verified occupant without another native list call or Codex count change", async () => {
    const data = await fixture();
    const guide = join(data.project, "AGENTS.md");
    await mkdir(dirname(guide), { recursive: true });
    await writeFile(guide, "Read `.agents/team/playbook.md` and `.agents/team/roles/`.");
    await mkdir(join(data.project, ".agents/team"), { recursive: true });
    await writeFile(join(data.project, ".agents/team/playbook.md"), "| pi-dev | Developer |\n");
    const roster = [data.agent()];
    const run = vi.fn(async (args: readonly string[]) => args.at(-2) === "workspace"
      ? JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "Fixture" }] } })
      : JSON.stringify({ result: { agents: roster } }));
    let now = 1000;
    const provider = createLocalAgentTeamsProvider({ home: data.home, codexHome: join(data.home, ".codex"), run, now: () => now });
    const first = (await provider.get()).teams[0]!;
    expect(first.agents[0]).toMatchObject({ role: "Developer", messagePreview: "Visible Pi progress", model: null, taskHint: null,
      occupantId: expect.stringMatching(/^o[0-9a-f]{16}$/) });
    expect(first.tokenUsage24h).toEqual({ coverage: "unavailable", knownTokens: null });
    expect(run.mock.calls.map(([args]) => args.join(" ")).sort()).toEqual([
      "--session default agent list", "--session default workspace list",
    ]);
    roster[0] = data.agent(join(data.directory, `2026-11-17T01-01-00-000Z_${OTHER}.jsonl`));
    now += 2000;
    expect((await provider.get()).teams[0]!.agents[0]!.messagePreview).toBeNull();
  });
});
