import { appendFile, mkdtemp, mkdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPiSessionReader } from "./local-agent-pi-message.ts";
import { PI_CONTEXT_KEY, piContextToken, type PiContextBinding } from "./local-agent-pi-context.ts";
import { createLocalAgentActivityProvider } from "./local-agent-activity.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
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
  it("keeps older Pi pages bound to the current branch even when an abandoned fork shares the cursor history", async () => {
    const root = assistant("Start of selected history", "00000001");
    const sibling = assistant("Other branch", "00000002", root.id);
    const records: object[] = [root, sibling];
    let parent = root.id;
    for (let index = 0; index < 60; index++) {
      const id = (10 + 2 * index).toString(16).padStart(8, "0");
      const resultId = (11 + 2 * index).toString(16).padStart(8, "0");
      const toolCallId = `fixture-${index}`;
      records.push(entry(id, parent, { role: "assistant", content: [
        { type: "toolCall", id: toolCallId, name: "send_message_to_user_async", arguments: { message: `Synthetic update ${index}` } },
      ] }));
      const content = index === 3 ? [{ type: "text", text: "fixture-private-short", name: "Cookie" }] : [
        { type: "text", text: index === 1 ? "Authorization: fixture-token" : index === 2 ? " \n" : `Acknowledged ${index}` },
      ];
      records.push(entry(resultId, id, { role: "toolResult", toolCallId, content: index === 0 ? undefined : content }));
      parent = resultId;
    }
    const data = await fixture(records);
    const member = data.agent();
    const pane = member.pane_id;
    const occupantId = localAgentOccupantId(member, pane)!;
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: [member] } }) });
    const first = await activity.get(pane, { occupantId });
    expect(first.events).toHaveLength(100);
    expect(first.history).toMatchObject({ version: 1, streamId: expect.any(String), nextBefore: expect.any(String) });
    const before = first.history!.nextBefore!;
    const oldest = await activity.get(pane, { occupantId, before });
    expect(oldest.events).toHaveLength(21);
    expect(oldest.history!.nextBefore).toBeNull();
    expect(oldest.events.slice(0, 5).map(({ text, detailStatus }) => [text, detailStatus])).toEqual([
      ["Start of selected history", undefined], ["message: Synthetic update 0", "available"],
      ["[Result details unavailable]", "absent"], ["message: Synthetic update 1", "available"],
      ["[Result details unavailable]", "withheld"],
    ]);
    expect(oldest.events[6]).toMatchObject({ detailStatus: "absent", text: "[Result details unavailable]" });
    expect(oldest.events[8]).toMatchObject({ detailStatus: "withheld", text: "[Result details unavailable]" });
    expect(JSON.stringify([...first.events, ...oldest.events])).not.toMatch(/Other branch|fixture-token|fixture-private-short/);
    await appendFile(data.file, line(assistant("New descendant", "00000100", parent)));
    const appended = await activity.get(pane, { occupantId });
    expect(appended.history?.streamId).toBe(first.history?.streamId);
    expect((await activity.get(pane, { occupantId, before })).events).toEqual(oldest.events);
    await appendFile(data.file, line(assistant("Switched branch", "00000101", sibling.id)));
    expect(await activity.get(pane, { occupantId, before })).toMatchObject({ status: "unavailable", events: [],
      history: { version: 1, streamId: null, nextBefore: null } });
    const newBranch = await activity.get(pane, { occupantId });
    expect(newBranch.history?.streamId).not.toBe(first.history?.streamId);
    expect(newBranch.events.map((event) => event.text)).toEqual(["Start of selected history", "Other branch", "Switched branch"]);
  });

  it("joins a Pi ceiling only to the same foreground process and verified session, branch and model", async () => {
    const change = (id: string, parentId: string | null, provider: string, modelId: string) =>
      ({ type: "model_change", id, parentId, timestamp: "2026-11-17T01:00:00.000Z", provider, modelId });
    const original = change("11111111", null, "fixture", "model");
    const latest = change("22222222", "11111111", "fixture", "model");
    const data = await fixture([original, latest]);
    const pane = "w6:p1";
    const base = data.agent();
    const view = (await data.reader([base])).get(pane)!;
    const binding = { ...view.contextBinding!, pane };
    const validStart = "1790000000:123456";
    let now = 100_000;
    let pid = 123;
    let start: string | null = validStart;
    const token = (override: Partial<PiContextBinding> = {}) => piContextToken({ ...binding, ...override }, 123, validStart, 54_321, now);
    let roster: Record<string, unknown>[] = [];
    const set = (raw: unknown, agent = base) => { roster = [{ ...agent, tokens: { [PI_CONTEXT_KEY]: raw } }]; };
    let replaceDuringRead = false;
    const run = vi.fn(async (args: readonly string[]) => {
      if (args.includes("process-info")) return JSON.stringify({ result: { process_info: {
        pane_id: pane, foreground_processes: [{ pid, name: "node" }],
      } } });
      if (args.at(-2) === "workspace") return JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "Fixture" }] } });
      const current = roster;
      if (replaceDuringRead) { replaceDuringRead = false; roster = []; }
      return JSON.stringify({ result: { agents: current } });
    });
    const teams = createLocalAgentTeamsProvider({ home: data.home, codexHome: join(data.home, ".codex"), run,
      readProcessStart: async () => start, now: () => now });
    const read = async () => (await teams.get(true)).teams[0]!.agents[0]!;
    set(token());
    expect(await read()).toMatchObject({ model: "model", contextWindow: 54_321, contextUsed: null });
    replaceDuringRead = true;
    expect((await read()).contextWindow).toBeNull();
    set(token());
    pid = 456;
    expect((await read()).contextWindow).toBeNull();
    pid = 123;
    start = "1790000000:123457";
    expect((await read()).contextWindow).toBeNull();
    start = null;
    expect((await read()).contextWindow).toBeNull();
    start = validStart;
    for (const raw of [undefined, "invalid", "x".repeat(81), token({ leaf: original.id }),
      token({ provider: "different-provider" }), token({ model: "different-model" }), token({ sessionId: OTHER }),
      token({ pane: "w6:p2" }), token({ cwd: join(data.home, "another") })]) {
      set(raw);
      expect((await read()).contextWindow).toBeNull();
    }
    set(token());
    now += 4_001;
    expect((await read()).contextWindow).toBeNull();
    set(token());
    await data.save([original, latest, change("33333333", latest.id, "different-provider", "model")]);
    expect((await read()).contextWindow).toBeNull();
    set(token({ provider: "different-provider", leaf: "33333333" }));
    expect((await read()).contextWindow).toBe(54_321);
    const other = join(data.directory, `2026-11-17T01-00-00-000Z_${OTHER}.jsonl`);
    await writeFile(other, [data.header(OTHER), original, latest].map(line).join(""));
    set(token(), data.agent(other));
    expect((await read()).contextWindow).toBeNull();
  });

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

  it("uses current-branch Pi runtime model and thinking changes without inventing a context ceiling", async () => {
    const change = (type: string, id: string, parentId: string | null, fields: object) =>
      ({ type, id, parentId, timestamp: "2026-11-17T01:00:00.000Z", ...fields });
    const oldModel = change("model_change", "11111111", null, { provider: "raven", modelId: "old-model" });
    const oldEffort = change("thinking_level_change", "22222222", "11111111", { thinkingLevel: "low" });
    const abandoned = change("model_change", "33333333", "22222222", { provider: "raven", modelId: "abandoned-model" });
    const selected = change("model_change", "44444444", "22222222", {
      provider: "raven", modelId: "selected-model", contextWindow: 1_000_000,
    });
    const runtime = entry("55555555", "44444444", { role: "assistant", provider: "raven", model: "runtime-model",
      thinkingLevel: "max", usage: { input: 123 }, content: [{ type: "text", text: "Current response" }] });
    const data = await fixture([oldModel, oldEffort, abandoned, selected, runtime]);
    expect((await data.reader([data.agent()])).get("w6:p1")).toMatchObject({
      model: "runtime-model", reasoningEffort: "max", contextWindow: null, preview: "Current response",
    });
    let roster = [data.agent()];
    let now = 1000;
    const teams = createLocalAgentTeamsProvider({ home: data.home, codexHome: join(data.home, ".codex"), now: () => now,
      run: async (args) => args.at(-2) === "workspace"
        ? JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "Fixture" }] } })
        : JSON.stringify({ result: { agents: roster } }) });
    expect((await teams.get()).teams[0]!.agents[0]).toMatchObject({
      model: "runtime-model", reasoningEffort: "max", contextWindow: null,
    });
    await data.save([oldModel, oldEffort, abandoned]);
    now += 2000;
    expect((await teams.get()).teams[0]!.agents[0]).toMatchObject({
      model: "abandoned-model", reasoningEffort: "low", contextWindow: null,
    });
    await data.save([oldModel, oldEffort, abandoned, selected, runtime,
      change("model_change", "66666666", "55555555", { provider: "raven", modelId: "new-selection" })]);
    now += 2000;
    expect((await teams.get()).teams[0]!.agents[0]).toMatchObject({ model: "new-selection", contextWindow: null });
    await data.save([assistant("No runtime metadata")]);
    now += 2000;
    expect((await teams.get()).teams[0]!.agents[0]).toMatchObject({ model: null, reasoningEffort: null, contextWindow: null });
    const otherFile = join(data.directory, `2026-11-17T01-01-00-000Z_${OTHER}.jsonl`);
    await writeFile(otherFile, [data.header(OTHER),
      change("model_change", "11111111", null, { provider: "raven", modelId: "replacement-model" })].map(line).join(""));
    roster = [data.agent(otherFile)];
    now += 2000;
    expect((await teams.get()).teams[0]!.agents[0]).toMatchObject({
      model: "replacement-model", reasoningEffort: null, contextWindow: null,
    });
  });

  it("clears malformed Pi runtime metadata instead of carrying the previous branch value", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const data = await fixture([
      { type: "model_change", id: "11111111", parentId: null, provider: "raven", modelId: "safe-model" },
      { type: "thinking_level_change", id: "22222222", parentId: "11111111", thinkingLevel: "high" },
      { type: "model_change", id: "33333333", parentId: "22222222", provider: "raven", modelId: secret },
      { type: "thinking_level_change", id: "44444444", parentId: "33333333", thinkingLevel: secret },
    ]);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    expect(view).toMatchObject({ model: null, reasoningEffort: null, contextWindow: null });
    expect(JSON.stringify(view)).not.toContain(secret);
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
        { type: "toolCall", id: `call-${index}`, name: "shell.run", arguments: { secret: "HIDDEN_ARGUMENT" } }] }));
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
        { type: "toolCall", id: "call-1", name: "shell.run", arguments: { cmd: "rg synthetic-file", secret } },
      ] }),
      entry("c1b2c3d4", "b1b2c3d4", { role: "toolResult", toolCallId: "call-1", toolName: "shell.run",
        content: [{ type: "text", text: "synthetic file found" }] }),
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
      { kind: "tool-call", tool: "shell.run", text: "cmd: rg synthetic-file" },
      { kind: "tool-result", tool: "shell.run", text: "synthetic file found" },
      { kind: "assistant", text: "Finished safely" },
    ] } });
    expect(JSON.stringify(response)).not.toMatch(/ghp_|private|HIDDEN_/);
    expect((await activity.get("w6:p1")).events).toHaveLength(5);
  });

  it("keeps Pi tool text on the selected branch and withholds unpaired or nontext results", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const data = await fixture([
      entry("a1b2c3d4", null, { role: "assistant", content: [{ type: "toolCall", id: "current", name: "shell.run",
        arguments: { cmd: "rg synthetic", token: secret } }] }),
      entry("b1b2c3d4", "a1b2c3d4", { role: "toolResult", toolCallId: "current", content: [
        { type: "text", text: "synthetic row" }, { type: "image", data: "HIDDEN_IMAGE" },
      ] }),
      entry("c1b2c3d4", "b1b2c3d4", { role: "assistant", content: [
        { type: "toolCall", id: "abandoned", name: "shell.run", arguments: { cmd: "HIDDEN_BRANCH" } },
      ] }),
      entry("d1b2c3d4", "b1b2c3d4", { role: "toolResult", toolCallId: "abandoned",
        content: [{ type: "text", text: "UNPAIRED_RESULT" }] }),
      assistant("Current answer", "e1b2c3d4", "d1b2c3d4"),
    ]);
    const view = (await data.reader([data.agent()])).get("w6:p1")!;
    expect(view.truncated).toBe(true);
    expect(view.events.map((event) => [event.kind, event.tool, event.text])).toEqual([
      ["tool-call", "shell.run", "cmd: rg synthetic"],
      ["tool-result", "shell.run", "synthetic row"],
      ["tool-result", null, "[Result details unavailable]"],
      ["assistant", null, "Current answer"],
    ]);
    expect(JSON.stringify(view)).not.toMatch(/ghp_|HIDDEN_|UNPAIRED_RESULT/);
  });

  it("rejects secret-shaped Pi tool names from both call and result Trace fields", async () => {
    const secretName = "ghp_" + "x".repeat(36);
    const data = await fixture([
      entry("a1b2c3d4", null, { role: "assistant", content: [
        { type: "text", text: "Visible work" },
        { type: "toolCall", id: "safe", name: "shell.run", arguments: { secret: "HIDDEN_SAFE_ARGS" } },
        { type: "toolCall", id: "sensitive", name: secretName, arguments: { secret: "HIDDEN_SECRET_ARGS" } },
      ] }),
      entry("b1b2c3d4", "a1b2c3d4", { role: "toolResult", toolCallId: "safe", content: [{ type: "text", text: "safe result" }] }),
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

  it("withholds private fields in paired Pi result text", async () => {
    const outputs = [
      '{"cookie":"SID=fixture-cookie"}', 'Set-Cookie: SID=fixture-cookie',
      '{"sessionId":"fixture-session"}', 'Request-Header: fixture-header',
      '{"base64":"c3ludGhldGlj"}',
      '{"encoding":"base64","content":"c3ludGhldGlj"}',
      '[{"value":"fixture-opaque-cookie","name":"Cookie"}]',
      "Two matching rows",
    ];
    const messages = outputs.flatMap((text, index) => [
      { role: "assistant", content: [{ type: "toolCall", id: `read-${index}`, name: "fixture.read", arguments: { count: 2 } }] },
      { role: "toolResult", toolCallId: `read-${index}`, content: [{ type: "text", text }] },
    ]);
    const id = (index: number) => index.toString(16).padStart(8, "0");
    const data = await fixture(messages.map((message, index) => entry(id(index), index ? id(index - 1) : null, message)));
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: [data.agent()] } }) });
    const result = await activity.get("w6:p1");
    expect(result.events.filter((event) => event.kind === "tool-result").map(({ tool, text }) => [tool, text])).toEqual(
      outputs.map((output, index) => ["fixture.read", index < outputs.length - 1 ? "[Result details unavailable]" : output]),
    );
    expect(JSON.stringify(result)).not.toMatch(/fixture-cookie|fixture-session|fixture-header|fixture-opaque-cookie|c3ludGhldGlj/);
  });

  it("keeps reused and rejected Pi call IDs ineligible throughout the selected branch", async () => {
    const call = (id: string, name = "fixture.read") => ({
      role: "assistant", content: [{ type: "toolCall", id, name, arguments: { count: 2 } }],
    });
    const output = (toolCallId: string, text: string) => ({
      role: "toolResult", toolCallId, content: [{ type: "text", text }],
    });
    const messages = [
      call("older"), ...Array.from({ length: 70 }, (_, index) => call(`filler-${index}`)),
      call("older"), output("older", "OLD_ID_RESULT"),
      call("consumed"), output("consumed", "FIRST_RESULT"), call("consumed"), output("consumed", "REUSED_RESULT"),
      call("rejected"), call("rejected", "ghp_" + "x".repeat(36)), output("rejected", "REJECTED_NAME_RESULT"),
      call("safe"), output("safe", "Unique paired result"),
    ];
    const id = (index: number) => index.toString(16).padStart(8, "0");
    const data = await fixture(messages.map((message, index) => entry(id(index), index ? id(index - 1) : null, message)));
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: [data.agent()] } }) });
    const result = await activity.get("w6:p1");
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events.filter((event) => event.kind === "tool-result").map(({ tool, text }) => [tool, text])).toEqual([
      ...Array.from({ length: 4 }, () => [null, "[Result details unavailable]"]),
      ["fixture.read", "Unique paired result"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ghp_|OLD_ID_RESULT|FIRST_RESULT|REUSED_RESULT|REJECTED_NAME_RESULT/);
  });

  it("withholds declaration-dependent Pi arguments and incompletely inspected results", async () => {
    const details = [
      { args: { content: "c3ludGhldGlj", encoding: "base64" },
        output: ['{"content":"c3ludGhldGlj",', ...Array<string>(7).fill(" "), '"encoding":"base64"}'] },
      { args: { value: "fixture-opaque-cookie", name: "Cookie" },
        output: ['[{"value":"fixture-opaque-cookie",', " ".repeat(16 * 1024) + '"name":"Cookie"}]'] },
      { args: { count: 2 }, output: ["Two", "matching rows"] },
    ];
    const messages = details.flatMap(({ args, output }, index) => [
      { role: "assistant", content: [{ type: "toolCall", id: `read-${index}`, name: "fixture.read", arguments: args }] },
      { role: "toolResult", toolCallId: `read-${index}`, content: output.map((text) => ({ type: "text", text })) },
    ]);
    const id = (index: number) => index.toString(16).padStart(8, "0");
    const data = await fixture(messages.map((message, index) => entry(id(index), index ? id(index - 1) : null, message)));
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: [data.agent()] } }) });
    const result = await activity.get("w6:p1");
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events.map(({ kind, tool, text }) => [kind, tool, text])).toEqual([
      ["tool-call", "fixture.read", "[Arguments unavailable]"], ["tool-result", "fixture.read", "[Result details unavailable]"],
      ["tool-call", "fixture.read", "[Arguments unavailable]"], ["tool-result", "fixture.read", "[Result details unavailable]"],
      ["tool-call", "fixture.read", "count: 2"], ["tool-result", "fixture.read", "Two matching rows"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/fixture-opaque-cookie|c3ludGhldGlj/);
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
    const data = await fixture([
      assistant("Old occupant", "a1b2c3d4"),
      entry("b1b2c3d4", "a1b2c3d4", { role: "assistant", content: [
        { type: "toolCall", id: "old-call", name: "shell.run", arguments: { cmd: "old synthetic action" } },
      ] }),
      entry("c1b2c3d4", "b1b2c3d4", { role: "toolResult", toolCallId: "old-call",
        content: [{ type: "text", text: "old synthetic result" }] }),
    ]);
    const otherFile = join(data.directory, `2026-11-17T01-01-00-000Z_${OTHER}.jsonl`);
    await writeFile(otherFile, [data.header(OTHER), assistant("New occupant")].map(line).join(""));
    let roster = [data.agent()];
    const activity = createLocalAgentActivityProvider({ home: data.home,
      run: async () => JSON.stringify({ result: { agents: roster } }) });
    const oldTexts = ["Old occupant", "cmd: old synthetic action", "old synthetic result"];
    expect((await activity.get("w6:p1")).events.map((event) => event.text)).toEqual(oldTexts);
    roster = [data.agent(otherFile)];
    expect((await activity.get("w6:p1")).events.map((event) => event.text)).toEqual(["New occupant"]);
    roster = [data.agent(otherFile), data.agent(otherFile, "another", "w6:p2")];
    expect(await activity.get("w6:p1")).toMatchObject({ status: "unavailable", events: [] });
    roster = [data.agent()];
    expect((await activity.get("w6:p1")).events.map((event) => event.text)).toEqual(oldTexts);
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
