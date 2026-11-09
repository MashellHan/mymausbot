import { appendFile, chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { resetPathCache } from "./env-path.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const folders: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetPathCache();
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

async function codexLog(id: string, recordedId = id) {
  const home = await mkdtemp(join(tmpdir(), "mausbot-agent-team-"));
  folders.push(home);
  const directory = join(home, "sessions", "2026", "11", "03");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-2026-11-03-${id}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: recordedId } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol", effort: "xhigh" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-11-03T08:00:00Z", payload: { type: "user_message", message: "latest synthetic instruction" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "private conversation" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 120, output_tokens: 30 }, total_token_usage: { input_tokens: 900000 }, model_context_window: 256000 } } }),
  ].join("\n") + "\n");
  return home;
}

async function usageLog(id: string, events: Array<{ at: string; total?: number; last?: number }>, home?: string) {
  home ??= await mkdtemp(join(tmpdir(), "mausbot-team-tokens-"));
  if (!folders.includes(home)) folders.push(home);
  const directory = join(home, "sessions", "2026", "11", "08");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `rollout-2026-11-08-${id}.jsonl`), [
    JSON.stringify({ type: "session_meta", timestamp: "2026-11-08T10:00:00Z", payload: { id } }),
    ...events.map(({ at, total, last }) => JSON.stringify({ type: "event_msg", timestamp: at,
      payload: { type: "token_count", info: { total_token_usage: total === undefined ? {} : { total_tokens: total },
        last_token_usage: last === undefined ? {} : { total_tokens: last } } } })),
  ].join("\n") + "\n");
  return home;
}

const workspaces = JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "MausBot", agent_status: "working" }] } });
const agents = (id = SESSION) => JSON.stringify({ result: { agents: [{
  pane_id: "w6:p1", workspace_id: "w6", name: "mausbot-front", agent: "codex", agent_status: "done",
  agent_session: { kind: "id", agent: "codex", value: id },
  terminal_title_stripped: "⠋ Build Agent Team\nsecret | OpenMausBot", cwd: "/private/workspace",
}] } });

describe("local Agent Team provider", () => {
  it("joins the exact live Codex session and returns only bounded dashboard fields", async () => {
    const codexHome = await codexLog(SESSION);
    const commands: string[] = [];
    const provider = createLocalAgentTeamsProvider({ codexHome, now: () => 1000, run: async (args) => {
      commands.push(args.join(" "));
      return args.at(-1) === "list" && args.at(-2) === "workspace" ? workspaces : agents();
    } });
    const snapshot = await provider.get();
    expect(commands.sort()).toEqual(["--session default agent list", "--session default workspace list"]);
    expect(snapshot).toEqual({ status: "ready", updatedAt: 1000, teamCount: 1, teams: [{ id: "w6", name: "MausBot", agentCount: 1, activeAgentCount: 0, lastActivityAt: Date.UTC(2026, 10, 3, 8), agents: [{
      id: "w6:p1", name: "mausbot-front", kind: "codex", role: null, model: "gpt-6-sol", reasoningEffort: "xhigh", contextUsed: 150, contextWindow: 256000, state: "done", taskHint: "latest synthetic instruction",
    }], tokenUsage24h: { coverage: "partial", knownTokens: null },
      tokenUsage7d: { coverage: "partial", knownTokens: null } }] });
    expect(JSON.stringify(snapshot)).not.toMatch(/private conversation|private\/workspace|session_meta|terminal_title|900000/);
  });

  it("sums only verified sessions in one team across a rolling 24-hour window", async () => {
    const codexHome = await usageLog(SESSION, [
      { at: "2026-11-08T11:00:00Z", total: 100, last: 100 },
      { at: "2026-11-08T13:00:00Z", total: 150, last: 50 },
      { at: "2026-11-08T13:01:00Z", total: 150, last: 0 },
      { at: "2026-11-09T11:00:00Z", total: 300, last: 150 },
    ]);
    await usageLog(OTHER, [{ at: "2026-11-09T10:00:00Z", total: 40, last: 40 }], codexHome);
    let time = Date.UTC(2026, 10, 9, 12);
    const provider = createLocalAgentTeamsProvider({ codexHome, now: () => time, run: async (args) => args.at(-2) === "workspace" ? workspaces
      : JSON.stringify({ result: { agents: [SESSION, OTHER].map((id, index) => ({
        pane_id: `w6:p${index + 1}`, workspace_id: "w6", name: `agent-${index}`, agent: "codex", agent_status: "done",
        agent_session: { kind: "id", agent: "codex", value: id },
      })) } }) });
    expect((await provider.get()).teams[0]?.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 240 });
    expect((await provider.get()).teams[0]?.tokenUsage7d).toEqual({ coverage: "ready", knownTokens: 340 });
    time += 2 * 60 * 60 * 1000;
    expect((await provider.get()).teams[0]?.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 190 });
    expect((await provider.get()).teams[0]?.tokenUsage7d).toEqual({ coverage: "ready", knownTokens: 340 });
  });

  it("does not recount unchanged cumulative snapshots within a read or after an incremental read", async () => {
    const codexHome = await usageLog(SESSION, [0, 1, 2].map((minute) => ({
      at: `2026-11-09T11:0${minute}:00Z`, total: 100, last: 100,
    })));
    const file = join(codexHome, "sessions", "2026", "11", "08", `rollout-2026-11-08-${SESSION}.jsonl`);
    let time = Date.UTC(2026, 10, 9, 12);
    const provider = createLocalAgentTeamsProvider({ codexHome, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : agents() });
    const usage = async () => (await provider.get()).teams[0]?.tokenUsage24h;
    expect(await usage()).toEqual({ coverage: "partial", knownTokens: 100 });
    await appendFile(file, `${JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:03:00Z", payload: {
      type: "token_count", info: { total_token_usage: { total_tokens: 100 }, last_token_usage: { total_tokens: 100 } },
    } })}\n`);
    time += 2_000;
    expect(await usage()).toEqual({ coverage: "partial", knownTokens: 100 });
    await appendFile(file, `${JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:04:00Z", payload: {
      type: "token_count", info: { total_token_usage: { total_tokens: 150 }, last_token_usage: { total_tokens: 50 } },
    } })}\n`);
    time += 2_000;
    expect(await usage()).toEqual({ coverage: "partial", knownTokens: 150 });
    expect((await provider.get()).teams[0]?.tokenUsage7d).toEqual({ coverage: "partial", knownTokens: 150 });
  });

  it("keeps an unexplained first cumulative balance partial when the session starts inside the window", async () => {
    const codexHome = await usageLog(SESSION, [{ at: "2026-11-08T11:00:00Z", total: 100, last: 40 }]);
    const provider = createLocalAgentTeamsProvider({ codexHome, now: () => Date.UTC(2026, 10, 8, 12),
      run: async (args) => args.at(-2) === "workspace" ? workspaces : agents() });
    const team = (await provider.get()).teams[0]!;
    expect(team.tokenUsage24h).toEqual({ coverage: "partial", knownTokens: 40 });
    expect(team.tokenUsage7d).toEqual({ coverage: "partial", knownTokens: 40 });
  });

  it("keeps incomplete session counts partial and refuses cross-team session attribution", async () => {
    const codexHome = await usageLog(SESSION, [
      { at: "2026-11-09T09:00:00Z", total: 50, last: 50 },
      { at: "2026-11-09T10:00:00Z", last: 20 },
      { at: "2026-11-09T11:00:00Z", total: 100, last: 30 },
    ]);
    const now = () => Date.UTC(2026, 10, 9, 12);
    const one = createLocalAgentTeamsProvider({ codexHome, now, run: async (args) => args.at(-2) === "workspace" ? workspaces : agents() });
    expect((await one.get()).teams[0]?.tokenUsage24h).toEqual({ coverage: "partial", knownTokens: 80 });
    expect((await one.get()).teams[0]?.tokenUsage7d).toEqual({ coverage: "partial", knownTokens: 80 });
    const duplicate = createLocalAgentTeamsProvider({ codexHome, now, run: async (args) => args.at(-2) === "workspace"
      ? JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "MausBot" }, { workspace_id: "w7", label: "Other" }] } })
      : JSON.stringify({ result: { agents: ["w6", "w7"].map((workspace, index) => ({
        pane_id: `${workspace}:p${index + 1}`, workspace_id: workspace, name: "same session", agent: "codex", agent_status: "done",
        agent_session: { kind: "id", agent: "codex", value: SESSION },
      })) } }) });
    expect((await duplicate.get()).teams.map((team) => team.tokenUsage24h)).toEqual([
      { coverage: "unavailable", knownTokens: null }, { coverage: "unavailable", knownTokens: null },
    ]);
    expect((await duplicate.get()).teams.map((team) => team.tokenUsage7d)).toEqual([
      { coverage: "unavailable", knownTokens: null }, { coverage: "unavailable", knownTokens: null },
    ]);
  });

  it("reports an unknown model when the file's session ID differs", async () => {
    const codexHome = await codexLog(SESSION, OTHER);
    const provider = createLocalAgentTeamsProvider({ codexHome, run: async (args) => args.at(-2) === "workspace" ? workspaces : agents() });
    expect((await provider.get()).teams[0]?.agents[0]?.model).toBeNull();
    expect((await provider.get()).teams[0]?.agents[0]?.taskHint).toBeNull();
    expect((await provider.get()).teams[0]?.lastActivityAt).toBeNull();
    expect((await provider.get()).teams[0]?.tokenUsage24h).toEqual({ coverage: "unavailable", knownTokens: null });
    expect((await provider.get()).teams[0]?.tokenUsage7d).toEqual({ coverage: "unavailable", knownTokens: null });
  });

  it("keeps a truncated seven-day session partial while its fully scanned 24-hour tail stays exact", async () => {
    const codexHome = await usageLog(SESSION, []);
    const file = join(codexHome, "sessions", "2026", "11", "08", `rollout-2026-11-08-${SESSION}.jsonl`);
    await writeFile(file, JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }) + "\n");
    await appendFile(file, [
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-07T10:00:00Z", payload: { type: "agent_message", message: "x".repeat(8 * 1024 * 1024) } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-07T12:00:00Z", payload: { type: "token_count", info: {
        total_token_usage: { total_tokens: 100 }, last_token_usage: { total_tokens: 100 } } } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:00:00Z", payload: { type: "token_count", info: {
        total_token_usage: { total_tokens: 150 }, last_token_usage: { total_tokens: 50 } } } }),
    ].join("\n") + "\n");
    const provider = createLocalAgentTeamsProvider({ codexHome, now: () => Date.UTC(2026, 10, 9, 12),
      run: async (args) => args.at(-2) === "workspace" ? workspaces : agents() });
    const team = (await provider.get()).teams[0]!;
    expect(team.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 50 });
    expect(team.tokenUsage7d).toEqual({ coverage: "partial", knownTokens: 50 });
  });

  it("does not count a replayed first counter from an unobserved truncated prefix", async () => {
    const codexHome = await usageLog(SESSION, []);
    const file = join(codexHome, "sessions", "2026", "11", "08", `rollout-2026-11-08-${SESSION}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-08T09:00:00Z", payload: { id: SESSION } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-08T10:00:00Z", payload: { type: "token_count", info: {
        total_token_usage: { total_tokens: 100 }, last_token_usage: { total_tokens: 100 } } } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-08T10:30:00Z", payload: { type: "agent_message", message: "x".repeat(8 * 1024 * 1024) } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-08T11:00:00Z", payload: { model: "gpt-6-sol" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:00:00Z", payload: { type: "token_count", info: {
        total_token_usage: { total_tokens: 100 }, last_token_usage: { total_tokens: 100 } } } }),
    ].join("\n") + "\n");
    let time = Date.UTC(2026, 10, 9, 12);
    const provider = createLocalAgentTeamsProvider({ codexHome, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : agents() });
    const usage = async () => (await provider.get()).teams[0]!;
    expect((await usage()).tokenUsage24h).toEqual({ coverage: "partial", knownTokens: null });
    await appendFile(file, `${JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:10:00Z", payload: {
      type: "token_count", info: { total_token_usage: { total_tokens: 150 }, last_token_usage: { total_tokens: 50 } },
    } })}\n`);
    time += 2_000;
    const after = await usage();
    expect(after.tokenUsage24h).toEqual({ coverage: "partial", knownTokens: 50 });
    expect(after.tokenUsage7d).toEqual({ coverage: "partial", knownTokens: 50 });
  });

  it("refreshes the latest instruction and per-turn context without retaining transcript history", async () => {
    const codexHome = await codexLog(SESSION);
    const file = join(codexHome, "sessions", "2026", "11", "03", `rollout-2026-11-03-${SESSION}.jsonl`);
    let time = 1000;
    const run = vi.fn(async (args: readonly string[]) => args.at(-2) === "workspace" ? workspaces : agents());
    const provider = createLocalAgentTeamsProvider({ codexHome, now: () => time, run });
    const [first, concurrent] = await Promise.all([provider.get(), provider.get()]);
    expect(first).toEqual(concurrent);
    expect(run).toHaveBeenCalledTimes(2);
    expect(first.teams[0]?.agents[0]).toMatchObject({ contextUsed: 150, reasoningEffort: "xhigh" });
    const secret = "ghp_" + "a".repeat(36);
    await appendFile(file, [
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-03T09:00:00Z", payload: { type: "user_message", message: `Latest request ${secret} ` + "x".repeat(500) } }),
      JSON.stringify({ type: "event_msg", timestamp: "invalid", payload: { type: "token_count" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "new-model", collaboration_mode: { settings: { reasoning_effort: "max" } } } }),
    ].join("\n") + "\n");
    time += 2000;
    const next = await provider.get();
    expect(next.teams[0]?.lastActivityAt).toBe(Date.UTC(2026, 10, 3, 9));
    const member = next.teams[0]!.agents[0]!;
    expect(member).toMatchObject({ model: "new-model", reasoningEffort: "max", contextUsed: null, contextWindow: null });
    expect(member.taskHint).toMatch(/^Latest request/);
    expect(member.taskHint?.length).toBeLessThanOrEqual(400);
    expect(JSON.stringify(next)).not.toContain(secret);
    expect(JSON.stringify(next)).not.toMatch(/latest synthetic instruction|private conversation/);
    const partial = JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ text: "Newest item instruction" }] } } });
    await appendFile(file, partial.slice(0, 30));
    time += 2000;
    expect((await provider.get()).teams[0]!.agents[0]!.taskHint).toBe(member.taskHint);
    await appendFile(file, partial.slice(30) + "\n");
    time += 2000;
    expect((await provider.get()).teams[0]!.agents[0]!.taskHint).toBe("Newest item instruction");
  });

  it("counts only working agents as active and never guesses metadata from role settings", async () => {
    const provider = createLocalAgentTeamsProvider({ codexHome: "/no-fixture-sessions", run: async (args) => args.at(-2) === "workspace" ? workspaces
      : JSON.stringify({ result: { agents: ["working", "blocked", "idle", "done", "unknown"].map((state, index) => ({
        pane_id: `w6:p${index}`, workspace_id: "w6", name: state, agent: "codex", agent_status: state,
        tokens: { model: "configured-model", reasoning_effort: "max" }, terminal_title_stripped: "Not a user instruction",
      })) } }) });
    const team = (await provider.get()).teams[0]!;
    expect(team).toMatchObject({ agentCount: 5, activeAgentCount: 1 });
    expect(team.agents.every((agent) => agent.model === null && agent.reasoningEffort === null && agent.taskHint === null)).toBe(true);
  });

  it("retains the last good snapshot as stale, and has no invented zero before a good read", async () => {
    const codexHome = await codexLog(SESSION);
    let fail = false;
    let time = 1000;
    const run = async (args: readonly string[]) => {
      if (fail) throw new Error("Herdr unavailable");
      return args.at(-2) === "workspace" ? workspaces : agents();
    };
    const empty = createLocalAgentTeamsProvider({ codexHome, run: async () => { throw new Error("offline"); } });
    expect(await empty.get()).toEqual({ status: "unavailable", updatedAt: null, teamCount: null, teams: [] });
    const provider = createLocalAgentTeamsProvider({ codexHome, run, now: () => time });
    expect((await provider.get()).status).toBe("ready");
    fail = true;
    time = 5000;
    expect(await provider.get()).toMatchObject({ status: "stale", updatedAt: 1000, teamCount: 1 });
  });

  it.skipIf(process.platform === "win32")("finds the fixed Herdr command through the sealed fixture path", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-herdr-path-"));
    folders.push(home);
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    const binary = join(bin, "herdr");
    await writeFile(binary, `#!/bin/sh\nif [ "$3" = workspace ]; then\n  printf '%s\\n' '{"result":{"workspaces":[{"workspace_id":"fixture-team","label":"Fixture team"}]}}'\nelse\n  printf '%s\\n' '{"result":{"agents":[]}}'\nfi\n`);
    await chmod(binary, 0o755);
    vi.stubEnv("HOME", home);
    vi.stubEnv("PATH", dirname(process.execPath));
    vi.stubEnv("OMB_EXTRA_PATH", bin);
    vi.stubEnv("OMB_TEST_SEALED_PATH", "1");
    resetPathCache();
    const provider = createLocalAgentTeamsProvider({ codexHome: join(home, ".codex") });
    expect(await provider.get()).toMatchObject({ status: "ready", teamCount: 1, teams: [{ id: "fixture-team", agentCount: 0 }] });
  });
});
