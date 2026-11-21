import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { createLocalAgentActivityProvider } from "./local-agent-activity.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const pane = "w6:p3";
const folders: string[] = [];
const row = (type: string, payload: object) => ({ timestamp: "2026-11-05T01:00:00.000Z", type, payload });
const agent = (session = SESSION, kind = "codex", paneId = pane) => ({ pane_id: paneId, workspace_id: "w6", agent: kind,
  agent_session: { kind: "id", agent: kind, value: session } });
const listed = (agents: object[]) => JSON.stringify({ result: { agents } });

afterEach(async () => { for (const folder of folders.splice(0)) await removeTempDir(folder); });

async function fixture(lines: object[], recordedId = SESSION) {
  const home = await mkdtemp(join(tmpdir(), "mausbot-activity-"));
  folders.push(home);
  const directory = join(home, "sessions", "2026", "11", "05");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `rollout-2026-11-05-${SESSION}.jsonl`);
  await writeFile(file, [row("session_meta", { id: recordedId }), ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n");
  return home;
}

describe("bounded per-agent Codex activity", () => {
  it("reads actual exec text block shapes and distinguishes safe async detail from absent or withheld data", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const call = (id: string, name: string, input: object) => row("response_item", {
      type: "function_call", call_id: id, name, arguments: JSON.stringify(input),
    });
    const result = (id: string, output?: unknown) => row("response_item", { type: "function_call_output", call_id: id, output });
    const asyncName = "functions.send_message_to_user_async";
    const home = await fixture([
      call("exec", "functions.exec", { cmd: "printf 'Synthetic line'", max_output_tokens: 300, token: secret }),
      result("exec", [{ type: "input_text", text: "Synthetic line" }, { type: "input_text", text: "second line" }]),
      call("async", asyncName, { message: "The fixture check finished." }),
      result("async", "Message delivered."),
      call("absent", asyncName, { message: "Another fixture update" }),
      result("absent"),
      call("opaque", asyncName, { message: "A".repeat(120), max_output_tokens: secret }),
      result("opaque", [{ type: "input_text", text: 'Set-Cookie: fixture-private-cookie' }]),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const { events } = await provider.get(pane);
    expect(events.map(({ text, detailStatus }) => [text, detailStatus])).toEqual([
      ["cmd: printf 'Synthetic line'; max_output_tokens: 300", "available"],
      ["Synthetic line second line", "available"],
      ["message: The fixture check finished.", "available"],
      ["Message delivered.", "available"],
      ["message: Another fixture update", "available"],
      ["[Result details unavailable]", "absent"],
      ["[Arguments unavailable]", "withheld"],
      ["[Result details unavailable]", "withheld"],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ghp_|fixture-private-cookie|AAAAAAAAAA/);
  });

  it("checks output block metadata before displaying text and requires a verified association for absent", async () => {
    const outputs = [
      [{ type: "input_text", text: "Ordinary fixture text" }],
      [{ type: "input_text", text: " \n" }, { type: "output_text", text: "" }],
      [{ type: "input_text", text: "c2hvcnQ=", encoding: "base64" }],
      [{ type: "input_text", text: "fixture-cookie-value", name: "Cookie" }],
      [{ type: "input_text", text: "", encoding: "base64" }],
      [{ type: "input_text", text: "fixture-late-declaration", ...Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`annotation${index}`, true])), encoding: "base64" }],
    ];
    const home = await fixture([
      ...outputs.flatMap((output, index) => [
        row("response_item", { type: "function_call", call_id: `call-${index}`, name: "functions.exec", arguments: '{"cmd":"fixture"}' }),
        row("response_item", { type: "function_call_output", call_id: `call-${index}`, output }),
      ]),
      row("response_item", { type: "function_call_output", call_id: "unpaired" }),
    ]);
    const activity = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const results = (await activity.get(pane)).events.filter((event) => event.kind === "tool-result");
    expect(results.map((event) => event.detailStatus)).toEqual([
      "available", "absent", "withheld", "withheld", "withheld", "withheld", "withheld",
    ]);
    expect(results[0]?.text).toBe("Ordinary fixture text");
    expect(results[1]?.text).toBe("[Result details unavailable]");
    expect(results.at(-1)).toMatchObject({ text: "[Result details unavailable]", tool: null });
    expect(JSON.stringify(results)).not.toMatch(/c2hvcnQ|fixture-cookie-value|fixture-late-declaration/);
  });

  it("pages a bounded Codex tail in source order without moving an older cursor after append", async () => {
    const pairs = Array.from({ length: 65 }, (_, index) => [
      row("response_item", { type: "function_call", call_id: `call-${index}`, name: "functions.exec", arguments: '{"cmd":"fixture"}' }),
      row("response_item", { type: "function_call_output", call_id: `call-${index}`,
        output: index === 0 ? [{ type: "input_text", text: "Large result " + "x".repeat(300_000) }] : `Result ${index}` }),
    ]).flat();
    const home = await fixture([
      row("event_msg", { type: "user_message", message: "Below scan budget " + "x".repeat(4 * 1024 * 1024) }),
      row("event_msg", { type: "user_message", message: "Oldest retained" }), ...pairs,
    ]);
    const original = { ...agent(), name: "fixture-codex", agent_session: { ...agent().agent_session, source: "herdr:codex" } };
    let active = original;
    const occupantId = localAgentOccupantId(original, pane)!;
    const activity = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([active]) });
    const first = await activity.get(pane, { occupantId });
    expect(first).toMatchObject({ status: "ready", truncated: true, history: { version: 1, streamId: expect.any(String) } });
    expect(first.events).toHaveLength(100);
    const before = first.history!.nextBefore!;
    const older = await activity.get(pane, { occupantId, before });
    expect(older.events).toHaveLength(31);
    expect(older.events[0]?.text).toBe("Oldest retained");
    expect(older.events[2]).toMatchObject({ detailStatus: "withheld", text: "[Result details unavailable]" });
    expect(older.history!.nextBefore).toBeNull();
    const ids = [...older.events, ...first.events].map((event) => event.id);
    expect(new Set(ids).size).toBe(131);
    expect(JSON.stringify(older)).not.toMatch(/Below scan budget|Large result/);
    const file = join(home, "sessions", "2026", "11", "05", `rollout-2026-11-05-${SESSION}.jsonl`);
    await appendFile(file, JSON.stringify(row("event_msg", { type: "agent_message", message: "Latest reply" })) + "\n");
    const latest = await activity.get(pane, { occupantId });
    expect(latest.history?.streamId).toBe(first.history?.streamId);
    expect(latest.events.at(-1)?.text).toBe("Latest reply");
    expect((await activity.get(pane, { occupantId, before })).events).toEqual(older.events);
    active = { ...original, name: "replacement" };
    expect(await activity.get(pane, { occupantId, before })).toMatchObject({ status: "unavailable", events: [], history: { streamId: null } });
  });

  it("retires the stream if an issued earlier anchor rolls out while a newer anchor is still retained", async () => {
    const line = (index: number) => row("event_msg", { type: "user_message", message: `Message ${index}` });
    const home = await fixture(Array.from({ length: 500 }, (_, index) => line(index)));
    const member = { ...agent(), name: "fixture-codex", agent_session: { ...agent().agent_session, source: "herdr:codex" } };
    const occupantId = localAgentOccupantId(member, pane)!;
    const observe = () => createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([member]) });
    const first = observe();
    const second = observe();
    async function cursors(activity: ReturnType<typeof observe>) {
      const newest = (await activity.get(pane, { occupantId })).history!;
      const older = (await activity.get(pane, { occupantId, before: newest.nextBefore! })).history!;
      expect(older.nextBefore).not.toBeNull();
      return { newest, older };
    }
    const prior = await cursors(first);
    const other = await cursors(second);
    const file = join(home, "sessions", "2026", "11", "05", `rollout-2026-11-05-${SESSION}.jsonl`);
    await appendFile(file, Array.from({ length: 301 }, (_, index) => JSON.stringify(line(500 + index))).join("\n") + "\n");
    expect(await first.get(pane, { occupantId, before: prior.older.nextBefore! })).toMatchObject({
      status: "unavailable", events: [], history: { streamId: null },
    });
    expect((await first.get(pane, { occupantId })).history?.streamId).not.toBe(prior.newest.streamId);
    expect((await second.get(pane, { occupantId })).history?.streamId).not.toBe(other.newest.streamId);
    expect(await second.get(pane, { occupantId, before: other.newest.nextBefore! })).toMatchObject({
      status: "unavailable", events: [], history: { streamId: null },
    });
  });

  it("lets two same-occupant frames finish concurrent newest history reads", async () => {
    const home = await fixture([row("event_msg", { type: "user_message", message: "Same fixture session" })]);
    const member = { ...agent(), name: "fixture-codex", agent_session: { ...agent().agent_session, source: "herdr:codex" } };
    const occupantId = localAgentOccupantId(member, pane)!;
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const activity = createLocalAgentActivityProvider({ codexHome: home, run: async () => {
      if (++calls === 1) { started(); await held; }
      return listed([member]);
    } });
    const first = activity.get(pane, { occupantId });
    await began;
    const second = activity.get(pane, { occupantId });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: "ready", events: [{ text: "Same fixture session" }], history: { streamId: expect.any(String) } });
    expect(b).toEqual(a);
    expect(calls).toBe(2);
  });

  it("reads visible current-format messages without duplicating legacy copies or exposing hidden content", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const home = await fixture([
      row("event_msg", { type: "user_message", message: "Plan briefly" }),
      row("response_item", { type: "message", role: "user", content: [
        { type: "input_text", text: "Plan" }, { type: "input_image", image_url: "HIDDEN_IMAGE" }, { type: "input_text", text: "briefly" },
      ] }),
      row("event_msg", { type: "agent_message", message: "Checking synthetic notes" }),
      row("response_item", { type: "message", role: "assistant", phase: "commentary", status: "completed", content: [
        { type: "output_text", text: "Checking synthetic notes" }, { type: "tool_result", text: "HIDDEN_TOOL" },
      ] }),
      row("response_item", { type: "message", role: "assistant", phase: "analysis", status: "completed",
        content: [{ type: "output_text", text: "HIDDEN_ANALYSIS" }] }),
      row("response_item", { type: "message", role: "assistant", phase: "commentary", channel: "analysis",
        content: [{ type: "output_text", text: "HIDDEN_CHANNEL" }] }),
      row("response_item", { type: "message", role: "system", content: [{ type: "input_text", text: "HIDDEN_SYSTEM" }] }),
      row("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "HIDDEN_DEVELOPER" }] }),
      row("response_item", { type: "function_call", name: "functions.exec", call_id: "call-1",
        arguments: JSON.stringify({ cmd: "rg synthetic-notes" }) }),
      row("response_item", { type: "function_call_output", call_id: "call-1", output: "2 synthetic matches" }),
      row("response_item", { type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [
        { type: "output_text", text: `Synthetic answer. ${secret}` }, { type: "output_image", data: "HIDDEN_IMAGE" },
      ] }),
      row("event_msg", { type: "user_message", message: "Legacy-only question" }),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: false });
    expect(result.events.map((event) => [event.kind, event.text?.startsWith("Synthetic answer") ? "Synthetic answer" : event.text])).toEqual([
      ["user", "Plan briefly"], ["assistant", "Checking synthetic notes"],
      ["tool-call", "cmd: rg synthetic-notes"], ["tool-result", "2 synthetic matches"],
      ["assistant", "Synthetic answer"], ["user", "Legacy-only question"],
    ]);
    expect(result.events.filter((event) => event.kind.startsWith("tool")).map((event) => event.tool)).toEqual(["functions.exec", "functions.exec"]);
    expect(JSON.stringify(result)).not.toMatch(/ghp_|HIDDEN_/);
  });

  it("returns only redacted user and assistant messages from the exact session", async () => {
    const secret = "ghp_" + "x".repeat(36);
    const home = await fixture([
      row("event_msg", { type: "user_message", message: `Review /Users/fixture/private/notes.txt ${secret} ` + "x".repeat(700) }),
      row("event_msg", { type: "agent_message", message: "I checked ./private/report.md." }),
      row("response_item", { type: "function_call", name: "functions.exec", call_id: "call-1",
        arguments: JSON.stringify({ cmd: "cat /tmp/private.txt", token: secret }) }),
      row("response_item", { type: "function_call_output", call_id: "call-1", output: "Bearer abcdefghijklmnop at https://private.test/file" }),
      row("response_item", { type: "reasoning", summary: "HIDDEN_REASONS" }),
      row("response_item", { type: "message", role: "system", content: [{ text: "SYSTEM_SECRET" }] }),
      row("response_item", { type: "message", role: "developer", content: [{ text: "DEVELOPER_SECRET" }] }),
      row("response_item", { type: "message", role: "assistant", channel: "analysis", content: [{ text: "HIDDEN_ANALYSIS" }] }),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, now: () => 1234,
      run: async (args) => { expect(args).toEqual(["--session", "default", "agent", "list"]); return listed([agent()]); } });
    const first = await provider.get(pane);
    expect(first).toMatchObject({ agentId: pane, status: "ready", updatedAt: 1234, truncated: true });
    expect(first.events.map((event) => [event.kind, event.tool])).toEqual([
      ["user", null], ["assistant", null], ["tool-call", "functions.exec"], ["tool-result", "functions.exec"],
    ]);
    expect(first.events.every((event) => (event.text?.length ?? 0) <= 600)).toBe(true);
    expect(first.events[0]?.at).toBe(Date.parse("2026-11-05T01:00:00.000Z"));
    expect((await provider.get(pane)).events.map((event) => event.id)).toEqual(first.events.map((event) => event.id));
    expect(JSON.stringify(first)).not.toMatch(/ghp_|Users\/fixture|private\/report|tmp\/private|private\.test|abcdefghijklmnop|SYSTEM_SECRET|DEVELOPER_SECRET|HIDDEN_/);
  });

  it("retains bounded safe tool metadata without letting a tool burst crowd out visible chat", async () => {
    const tools = Array.from({ length: 75 }, (_, index) => [
      row("response_item", { type: "function_call", name: "functions.exec", call_id: `call-${index}`, arguments: "synthetic tool input" }),
      row("response_item", { type: "function_call_output", call_id: `call-${index}`, output: "synthetic tool output" }),
    ]).flat();
    const home = await fixture([
      row("event_msg", { type: "user_message", message: "First question" }),
      ...tools,
      row("event_msg", { type: "agent_message", message: "Final reply" }),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events).toHaveLength(32);
    expect(result.events[0]).toMatchObject({ kind: "user", text: "First question" });
    expect(result.events.at(-1)).toMatchObject({ kind: "assistant", text: "Final reply" });
    expect(result.events.filter((event) => event.kind.startsWith("tool"))).toHaveLength(30);
    expect(result.events.filter((event) => event.kind.startsWith("tool")).every((event) => (event.text?.length ?? 0) <= 600)).toBe(true);
  });

  it("reads custom tool text and supports alphanumeric current pane IDs without exposing other records", async () => {
    const input = 'const run = await tools.exec_command({ cmd: "printf synthetic", max_output_tokens: 300 });';
    const blockInput = '{ const run = await tools.exec_command({ cmd: "printf block", max_output_tokens: 300 }); }';
    const minimalOutput = [
      { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ chunk_id: "abc123", wall_time_seconds: 0.1, exit_code: 0, output: "Minimal output" }) },
    ];
    const output = [
      { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ chunk_id: "abc123", wall_time_seconds: 0.1, exit_code: 0,
        session_id: 12345, original_token_count: 7, output: "Synthetic command output" }) },
    ];
    const home = await fixture([
      row("response_item", { type: "custom_tool_call_output", call_id: "missing", output }),
      row("response_item", { type: "custom_tool_call", name: "functions.exec", call_id: "c1",
        input, arguments: "ignored alternative" }),
      row("response_item", { type: "custom_tool_call_output", call_id: "c1", output }),
      row("response_item", { type: "custom_tool_call", name: "functions.exec", call_id: "c-block", input: blockInput }),
      row("response_item", { type: "custom_tool_call_output", call_id: "c-block", output: minimalOutput }),
      row("response_item", { type: "function_call", name: "functions.exec", call_id: "mismatch-fn", arguments: '{"cmd":"ok"}' }),
      row("response_item", { type: "custom_tool_call_output", call_id: "mismatch-fn", output: minimalOutput }),
      row("response_item", { type: "custom_tool_call", name: "functions.exec", call_id: "mismatch-custom", input }),
      row("response_item", { type: "function_call_output", call_id: "mismatch-custom", output: "MISMATCH_FN_RESULT" }),
      row("response_item", { type: "function_call", name: "/private/tool", call_id: "c2", arguments: "private path" }),
      row("response_item", { type: "reasoning", summary: "private reasoning" }),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent(SESSION, "codex", "w6:pG")]) });
    const result = await provider.get("w6:pG");
    expect(result.events.map(({ kind, tool, text }) => [kind, tool, text])).toEqual([
      ["tool-result", null, "[Result details unavailable]"],
      ["tool-call", "functions.exec", "cmd: printf synthetic"],
      ["tool-result", "functions.exec", "Script completed Wall time 0.1 seconds Exit code: 0 Synthetic command output"],
      ["tool-call", "functions.exec", "cmd: printf block"],
      ["tool-result", "functions.exec", "Script completed Wall time 0.1 seconds Exit code: 0 Minimal output"],
      ["tool-call", "functions.exec", "cmd: ok"],
      ["tool-result", null, "[Result details unavailable]"],
      ["tool-call", "functions.exec", "cmd: printf synthetic"],
      ["tool-result", null, "[Result details unavailable]"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ignored alternative|private path|private reasoning|c1|c2|12345|original_token_count|chunk_id|MISMATCH_FN_RESULT/);
  });

  it("does not reveal malformed, unpaired or encoded Codex tool details", async () => {
    const home = await fixture([
      row("response_item", { type: "function_call_output", call_id: "missing", output: "UNPAIRED_RESULT" }),
      row("response_item", { type: "function_call", name: "functions.exec", call_id: "bad", arguments: "{malformed" }),
      row("response_item", { type: "function_call_output", call_id: "bad", output: "safe paired result" }),
      row("response_item", { type: "function_call", name: "functions.exec", call_id: "encoded",
        arguments: { cmd: "data:image/png;base64," + "A".repeat(256) } }),
      row("response_item", { type: "function_call_output", call_id: "encoded",
        output: [{ type: "image", data: "BINARY_RESULT" }] }),
      row("response_item", { type: "function_call", name: "functions.exec", call_id: "duplicate", arguments: "first" }),
      row("response_item", { type: "function_call", name: "functions.exec", call_id: "duplicate", arguments: "second" }),
      row("response_item", { type: "function_call_output", call_id: "duplicate", output: "AMBIGUOUS_RESULT" }),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events.map((event) => [event.kind, event.tool, event.text])).toEqual([
      ["tool-result", null, "[Result details unavailable]"],
      ["tool-call", "functions.exec", "[Arguments unavailable]"],
      ["tool-result", "functions.exec", "safe paired result"],
      ["tool-call", "functions.exec", "[Arguments unavailable]"],
      ["tool-result", "functions.exec", "[Result details unavailable]"],
      ["tool-call", "functions.exec", "first"],
      ["tool-call", "functions.exec", "second"],
      ["tool-result", null, "[Result details unavailable]"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/UNPAIRED_RESULT|AMBIGUOUS_RESULT|BINARY_RESULT|base64/);
  });

  it("keeps the most recent 60 visible messages and reports omitted history", async () => {
    const home = await fixture(Array.from({ length: 70 }, (_, index) => row("event_msg", { type: "user_message", message: `message ${index}` })));
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events).toHaveLength(60);
    expect(result.events[0]?.text).toBe("message 10");
    expect(result.events.at(-1)?.text).toBe("message 69");
  });

  it("withholds private fields in paired Codex result text", async () => {
    const outputs = [
      '{"cookie":"SID=fixture-cookie"}', 'Set-Cookie: SID=fixture-cookie',
      '{"sessionId":"fixture-session"}', 'Request-Header: fixture-header',
      '{"base64":"c3ludGhldGlj"}',
      '{"content":"c3ludGhldGlj","encoding":"base64"}',
      '[{"name":"Cookie","value":"fixture-opaque-cookie"}]',
      "Two matching rows",
    ];
    const home = await fixture(outputs.flatMap((output, index) => [
      row("response_item", { type: "function_call", name: "fixture.read", call_id: `read-${index}`, arguments: '{"count":2}' }),
      row("response_item", { type: "function_call_output", call_id: `read-${index}`, output }),
    ]));
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result.events.filter((event) => event.kind === "tool-result").map(({ tool, text }) => [tool, text])).toEqual(
      outputs.map((output, index) => ["fixture.read", index < outputs.length - 1 ? "[Result details unavailable]" : output]),
    );
    expect(JSON.stringify(result)).not.toMatch(/fixture-cookie|fixture-session|fixture-header|fixture-opaque-cookie|c3ludGhldGlj/);
  });

  it("keeps reused and rejected Codex call IDs ineligible throughout the scan", async () => {
    const call = (id: string, name = "fixture.read") => row("response_item", {
      type: "function_call", name, call_id: id, arguments: '{"count":2}',
    });
    const output = (id: string, text: string) => row("response_item", { type: "function_call_output", call_id: id, output: text });
    const home = await fixture([
      call("older"), ...Array.from({ length: 70 }, (_, index) => call(`filler-${index}`)),
      call("older"), output("older", "OLD_ID_RESULT"),
      call("consumed"), output("consumed", "FIRST_RESULT"), call("consumed"), output("consumed", "REUSED_RESULT"),
      call("rejected"), call("rejected", "ghp_" + "x".repeat(36)), output("rejected", "REJECTED_NAME_RESULT"),
      call("safe"), output("safe", "Unique paired result"),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events.filter((event) => event.kind === "tool-result").map(({ tool, text }) => [tool, text])).toEqual([
      ...Array.from({ length: 4 }, () => [null, "[Result details unavailable]"]),
      ["fixture.read", "Unique paired result"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ghp_|OLD_ID_RESULT|FIRST_RESULT|REUSED_RESULT|REJECTED_NAME_RESULT/);
  });

  it("withholds declaration-dependent Codex arguments and incompletely inspected results", async () => {
    const details = [
      { args: { content: "c3ludGhldGlj", encoding: "base64" },
        output: ['{"content":"c3ludGhldGlj",', ...Array<string>(7).fill(" "), '"encoding":"base64"}'] },
      { args: { value: "fixture-opaque-cookie", name: "Cookie" },
        output: ['[{"value":"fixture-opaque-cookie",', " ".repeat(16 * 1024) + '"name":"Cookie"}]'] },
      { args: { count: 2 }, output: ["Two", "matching rows"] },
    ];
    const home = await fixture(details.flatMap(({ args, output }, index) => [
      row("response_item", { type: "function_call", name: "fixture.read", call_id: `read-${index}`, arguments: JSON.stringify(args) }),
      row("response_item", { type: "function_call_output", call_id: `read-${index}`,
        output: output.map((text) => ({ type: "output_text", text })) }),
    ]));
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events.map(({ kind, tool, text }) => [kind, tool, text])).toEqual([
      ["tool-call", "fixture.read", "[Arguments unavailable]"], ["tool-result", "fixture.read", "[Result details unavailable]"],
      ["tool-call", "fixture.read", "[Arguments unavailable]"], ["tool-result", "fixture.read", "[Result details unavailable]"],
      ["tool-call", "fixture.read", "count: 2"], ["tool-result", "fixture.read", "Two matching rows"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/fixture-opaque-cookie|c3ludGhldGlj/);
  });

  it("reads only the bounded tail and ignores an incomplete or oversized record", async () => {
    const home = await fixture([
      row("event_msg", { type: "user_message", message: "PRIVATE_OLD " + "x".repeat(600_000) }),
      row("event_msg", { type: "user_message", message: "recent visible line" }),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: true });
    expect(result.events.map((event) => event.text)).toEqual(["recent visible line"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_OLD");
  });

  it("does not expose mismatched, missing or unsupported sessions", async () => {
    const home = await fixture([row("event_msg", { type: "user_message", message: "private line" })], OTHER);
    let rows = listed([agent()]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => rows });
    expect(await provider.get(pane)).toEqual({ agentId: pane, status: "unavailable", updatedAt: null, truncated: false, events: [] });
    rows = listed([agent(SESSION, "claude")]);
    expect(await provider.get(pane)).toMatchObject({ status: "unsupported", events: [] });
    rows = listed([]);
    expect(await provider.get(pane)).toMatchObject({ status: "unavailable", events: [] });
    expect(await provider.get("not-a-pane")).toMatchObject({ status: "unavailable", events: [] });
  });

  it("retains stale rows only while Herdr still names the same exact session", async () => {
    const home = await fixture([]);
    let failed = false, session = SESSION, herdrFailed = false;
    const visible = [{ id: "e1", at: null, kind: "user" as const, tool: null, text: "safe prior line" }];
    const provider = createLocalAgentActivityProvider({ codexHome: home, now: () => 1000,
      run: async () => { if (herdrFailed) throw new Error("offline"); return listed([agent(session)]); },
      read: async () => { if (failed) throw new Error("temporarily unreadable"); return { events: visible, truncated: false }; } });
    expect(await provider.get(pane)).toMatchObject({ status: "ready", events: visible });
    failed = true;
    expect(await provider.get(pane)).toMatchObject({ status: "stale", updatedAt: 1000, events: visible });
    session = OTHER;
    expect(await provider.get(pane)).toMatchObject({ status: "unavailable", events: [] });
    session = SESSION; herdrFailed = true;
    expect(await provider.get(pane)).toMatchObject({ status: "unavailable", events: [] });
  });

  it("revalidates the live session for each concurrent request instead of sharing an older result", async () => {
    const home = await fixture([row("event_msg", { type: "user_message", message: "old session line" })]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => {
      reads++;
      if (reads === 1) { await held; return listed([agent()]); }
      return listed([agent(OTHER)]);
    } });
    const first = provider.get(pane);
    const second = provider.get(pane);
    release();
    const [older, newer] = await Promise.all([first, second]);
    expect(reads).toBe(2);
    expect(older).toMatchObject({ status: "ready", events: [{ text: "old session line" }] });
    expect(newer).toMatchObject({ status: "unavailable", events: [] });
  });

  it.each(["ready", "missing", "error"] as const)("keeps the newer session cache when an older %s read finishes late", async (olderResult) => {
    const home = await fixture([]);
    const directory = join(home, "sessions", "2026", "11", "05");
    await writeFile(join(directory, `rollout-2026-11-05-${OTHER}.jsonl`), JSON.stringify(row("session_meta", { id: OTHER })) + "\n");
    let releaseOlder!: () => void, olderStarted!: () => void;
    const held = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const started = new Promise<void>((resolve) => { olderStarted = resolve; });
    const oldEvents = [{ id: "old", at: null, kind: "user" as const, tool: null, text: "old session" }];
    const newEvents = [{ id: "new", at: null, kind: "user" as const, tool: null, text: "new session" }];
    let herdrReads = 0, newReads = 0;
    const provider = createLocalAgentActivityProvider({ codexHome: home,
      run: async () => listed([agent(++herdrReads === 1 ? SESSION : OTHER)]),
      read: async (_file, id) => {
        if (id === SESSION) {
          olderStarted();
          await held;
          if (olderResult === "error") throw new Error("old file unreadable");
          return olderResult === "missing" ? null : { events: oldEvents, truncated: false };
        }
        if (++newReads > 1) throw new Error("new file temporarily unreadable");
        return { events: newEvents, truncated: false };
      } });
    const oldRequest = provider.get(pane);
    await started;
    expect(await provider.get(pane)).toMatchObject({ status: "ready", events: newEvents });
    releaseOlder();
    await oldRequest;
    expect(await provider.get(pane)).toMatchObject({ status: "stale", events: newEvents });
    expect(herdrReads).toBe(3);
  });
});
