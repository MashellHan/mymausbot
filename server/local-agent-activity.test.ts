import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { createLocalAgentActivityProvider } from "./local-agent-activity.ts";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const pane = "w6:p3";
const folders: string[] = [];
const row = (type: string, payload: object) => ({ timestamp: "2026-11-05T01:00:00.000Z", type, payload });
const agent = (session = SESSION, kind = "codex") => ({ pane_id: pane, workspace_id: "w6", agent: kind,
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
      row("response_item", { type: "function_call", name: "functions.exec", arguments: "HIDDEN_CALL" }),
      row("response_item", { type: "function_call_output", output: "HIDDEN_RESULT" }),
      row("response_item", { type: "message", role: "assistant", phase: "final_answer", status: "completed", content: [
        { type: "output_text", text: `Synthetic answer. ${secret}` }, { type: "output_image", data: "HIDDEN_IMAGE" },
      ] }),
      row("event_msg", { type: "user_message", message: "Legacy-only question" }),
    ]);
    const provider = createLocalAgentActivityProvider({ codexHome: home, run: async () => listed([agent()]) });
    const result = await provider.get(pane);
    expect(result).toMatchObject({ status: "ready", truncated: false });
    expect(result.events.map((event) => [event.kind, event.text?.startsWith("Synthetic answer") ? "Synthetic answer" : event.text])).toEqual([
      ["user", "Plan briefly"], ["assistant", "Checking synthetic notes"], ["assistant", "Synthetic answer"], ["user", "Legacy-only question"],
    ]);
    expect(JSON.stringify(result)).not.toMatch(/ghp_|HIDDEN_|functions\.exec/);
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
      ["user", null], ["assistant", null],
    ]);
    expect(first.events.every((event) => (event.text?.length ?? 0) <= 600)).toBe(true);
    expect(first.events[0]?.at).toBe(Date.parse("2026-11-05T01:00:00.000Z"));
    expect((await provider.get(pane)).events.map((event) => event.id)).toEqual(first.events.map((event) => event.id));
    expect(JSON.stringify(first)).not.toMatch(/ghp_|Users\/fixture|private\/report|tmp\/private|private\.test|abcdefghijklmnop|SYSTEM_SECRET|DEVELOPER_SECRET|HIDDEN_|functions\.exec/);
  });

  it("does not let more than 60 tool events crowd out chat messages", async () => {
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
    expect(result).toMatchObject({ status: "ready", truncated: false });
    expect(result.events.map((event) => [event.kind, event.text])).toEqual([["user", "First question"], ["assistant", "Final reply"]]);
    expect(JSON.stringify(result)).not.toContain("synthetic tool");
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
