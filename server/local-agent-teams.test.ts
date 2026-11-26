import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { resetPathCache } from "./env-path.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";
import { PI_CONTEXT_KEY, piContextToken } from "./local-agent-pi-context.ts";

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
      id: "w6:p1", name: "mausbot-front", kind: "codex", role: null, model: "gpt-6-sol", reasoningEffort: "xhigh", contextUsed: 150, contextWindow: 256000, state: "done", taskHint: "latest synthetic instruction", messagePreview: null,
      tokenUsage24h: { coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } },
      tokenUsage7d: { coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } },
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

  it("uses completed OpenCode messages only for the uniquely verified seat and rolling window", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-opencode-member-"));
    folders.push(home);
    const dataHome = join(home, "xdg-data");
    const directory = join(dataHome, "opencode");
    vi.stubEnv("XDG_DATA_HOME", dataHome);
    vi.stubEnv("OPENCODE_DB", "fixture.sqlite");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "fixture.sqlite");
    const database = new DatabaseSync(file);
    try { database.exec(`CREATE TABLE session_message (session_id TEXT, type TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)`); }
    finally { database.close(); }
    const sessionId = "ses_MausbotFixture";
    const legacyId = "ses_LegacyFixture";
    const write = (at: number, session = sessionId, type = "assistant", completedAt: number | null = at) => {
      const fixture = new DatabaseSync(file);
      try {
        const usage = {
          time: completedAt === null ? {} : { completed: completedAt },
          tokens: { input: 120, output: 10, reasoning: 2, cache: { read: 100, write: 3 } },
        };
        const providerID = "raven", modelID = "gpt-6.2-sol";
        if (session !== legacyId) fixture.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)")
          .run(session, type, at, JSON.stringify({ ...usage, model: { providerID, id: modelID } }));
        fixture.prepare("INSERT INTO message VALUES (?, ?, ?)")
          .run(session, at, JSON.stringify({ ...usage, role: type, providerID, modelID }));
      } finally { fixture.close(); }
    };
    const day = 24 * 60 * 60 * 1000;
    let time = Date.UTC(2026, 10, 9, 10);
    const seat = {
      pane_id: "w6:p1", workspace_id: "w6", name: "opencode-member", agent: "opencode", agent_status: "done",
      terminal_id: "term_opencode",
      agent_session: { kind: "id", agent: "opencode", source: "herdr:opencode", value: sessionId },
    };
    let agents = [seat, { ...seat, pane_id: "w6:p2", name: "unverified", agent_session: { ...seat.agent_session, source: "other:opencode" } },
      { ...seat, pane_id: "w6:p3", name: "legacy", agent_session: { ...seat.agent_session, value: legacyId } }];
    let recheckedAgents: typeof agents | undefined;
    const makeProvider = () => {
      let firstRead = true;
      return createLocalAgentTeamsProvider({ home, codexHome: join(home, ".codex"), now: () => time,
        bindingCachePath: join(home, "bindings.json"), run: async (args) => {
          if (args.at(-2) === "workspace") return workspaces;
          const listed = firstRead ? agents : recheckedAgents ?? agents;
          firstRead = !firstRead;
          return JSON.stringify({ result: { agents: listed } });
        } });
    };
    const provider = makeProvider();
    write(time - 500);
    expect((await provider.get()).teams[0]!.agents[0]!.tokenUsage24h).toMatchObject({ coverage: "unavailable", knownTokens: null });

    write(time - 500, sessionId, "assistant", time + 500);
    write(time + 500);
    time += 2 * day;
    write(time - 500);
    write(time - 500, legacyId);
    write(time - 500, "ses_Unrelated");
    write(time - 500, sessionId, "user");
    write(time - 500, sessionId, "assistant", null);
    write(time + 500);
    const [verified, unverified, legacy] = (await provider.get()).teams[0]!.agents;
    expect(verified!.tokenUsage24h).toMatchObject({ coverage: "partial", knownTokens: 235, estimatedCost: { coverage: "partial" } });
    expect(verified!.tokenUsage24h!.estimatedCost.usd).toBeGreaterThan(0);
    expect(verified!.tokenUsage7d).toMatchObject({ coverage: "partial", knownTokens: 470 });
    expect(unverified!.tokenUsage24h).toMatchObject({ coverage: "unavailable", knownTokens: null });
    expect(legacy!.tokenUsage24h).toMatchObject({ coverage: "partial", knownTokens: 235, estimatedCost: { coverage: "partial" } });

    const restarted = makeProvider();
    const restored = (await restarted.get()).teams[0]!.agents[0]!;
    expect(restored.tokenUsage24h).toEqual(verified!.tokenUsage24h);
    expect(restored.tokenUsage7d).toEqual(verified!.tokenUsage7d);

    recheckedAgents = [...agents, { ...seat, pane_id: "w6:p4", name: "duplicate" }];
    time += 2_000;
    const duplicate = (await restarted.get()).teams[0]!.agents;
    expect(duplicate.map((member) => member.tokenUsage24h?.coverage)).toEqual(["unavailable", "unavailable", "partial"]);

    agents = [seat];
    recheckedAgents = undefined;
    const rebound = (await makeProvider().get()).teams[0]!.agents[0]!;
    expect(rebound.tokenUsage7d).toMatchObject({ coverage: "unavailable", knownTokens: null });
  });

  it("discovers isolated OpenCode SQLite databases and prefers the freshest store when a session migrated", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-opencode-isolated-"));
    folders.push(home);
    const dataHome = join(home, "xdg-data");
    const opencodeDir = join(dataHome, "opencode");
    const isolatedDir = join(opencodeDir, "isolated");
    vi.stubEnv("XDG_DATA_HOME", dataHome);
    vi.stubEnv("OPENCODE_DB", "");
    await mkdir(isolatedDir, { recursive: true });
    const repo = join(home, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const sharedDb = new DatabaseSync(join(opencodeDir, "opencode.db"));
    const isolatedDb = new DatabaseSync(join(isolatedDir, "worker-front.db"));
    const day = 24 * 60 * 60 * 1000;
    const now = Date.UTC(2026, 10, 25, 8, 0);
    const migratedSession = "ses_IsolatedMigrated1";
    const isolatedOnlySession = "ses_IsolatedOnly2";
    try {
      const schema = `CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);`;
      sharedDb.exec(schema);
      isolatedDb.exec(schema);
      // Stale copy in shared opencode.db (>24h old)
      sharedDb.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run(migratedSession, repo, now - 3 * day, now - 2 * day);
      sharedDb.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', 1, ?, ?)").run(
        "old-1", migratedSession, now - 2 * day, JSON.stringify({
          time: { completed: now - 2 * day },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
          model: { providerID: "raven", id: "gemini-4-hydrogen", variant: "high" },
          content: [{ type: "text", text: "Stale shared reply" }],
        }),
      );
      // Active copy in isolated/worker-front.db with fresh 24h tokens
      isolatedDb.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run(migratedSession, repo, now - 3 * day, now - 60_000);
      isolatedDb.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', 2, ?, ?)").run(
        "new-1", migratedSession, now - 60_000, JSON.stringify({
          time: { completed: now - 50_000 },
          tokens: { input: 500, output: 100, reasoning: 20, cache: { read: 400, write: 0 } },
          model: { providerID: "raven", id: "gemini-4-hydrogen", variant: "high" },
          content: [{ type: "text", text: "Fresh isolated reply" }],
        }),
      );
      isolatedDb.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)").run(isolatedOnlySession, repo, now - 2 * 3600_000, now - 30_000);
      isolatedDb.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', 1, ?, ?)").run(
        "only-1", isolatedOnlySession, now - 30_000, JSON.stringify({
          time: { completed: now - 20_000 },
          tokens: { input: 200, output: 50, reasoning: 0, cache: { read: 100, write: 0 } },
          model: { providerID: "raven", id: "gpt-6.2-sol", variant: "high" },
          content: [{ type: "text", text: "Isolated only reply" }],
        }),
      );
    } finally {
      sharedDb.close();
      isolatedDb.close();
    }
    const agents = [
      {
        pane_id: "w6:p6", workspace_id: "w6", name: "mausbot-upstream", agent: "opencode", agent_status: "working",
        cwd: repo, terminal_id: "term_up",
        agent_session: { kind: "id", agent: "opencode", source: "herdr:opencode", value: migratedSession },
      },
      {
        pane_id: "w6:p3", workspace_id: "w6", name: "mausbot-front", agent: "opencode", agent_status: "working",
        cwd: repo, terminal_id: "term_fr",
        agent_session: { kind: "id", agent: "opencode", source: "herdr:opencode", value: isolatedOnlySession },
      },
    ];
    const provider = createLocalAgentTeamsProvider({
      home, codexHome: join(home, ".codex"), now: () => now,
      bindingCachePath: join(home, "bindings.json"),
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents } }),
    });
    const team = (await provider.get()).teams[0]!;
    expect(team.agents[0]).toMatchObject({
      name: "mausbot-upstream",
      model: "gemini-4-hydrogen",
      messagePreview: "Fresh isolated reply",
      tokenUsage24h: { coverage: "partial", knownTokens: 1020 },
    });
    expect(team.agents[1]).toMatchObject({
      name: "mausbot-front",
      model: "gpt-6.2-sol",
      messagePreview: "Isolated only reply",
      tokenUsage24h: { coverage: "partial", knownTokens: 350 },
    });
  });

  it("computes per-member 24h and 7d tokens and sub-cent USD cost across turn_context model switches", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-cost-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `rollout-2026-11-01-${SESSION}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION, timestamp: "2026-11-01T10:00:00Z" } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-02T10:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-02T10:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    let time = Date.UTC(2026, 10, 2, 12);
    const verifiedAgents = () => JSON.stringify({ result: { agents: [{
      pane_id: "w6:p1", workspace_id: "w6", name: "mausbot-front", agent: "codex", agent_status: "done",
      agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
    }] } });
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : verifiedAgents() });
    const initial = (await provider.get()).teams[0]!.agents[0]!;
    expect(initial.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });

    await appendFile(file, [
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-05T10:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-05T10:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 260 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T10:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T10:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 390 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T11:00:00Z", payload: { model: "gpt-6.1-sol" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 460 },
          last_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20, total_tokens: 70 },
        },
      } }),
    ].join("\n") + "\n");
    time = Date.UTC(2026, 10, 9, 12);
    const ready = (await provider.get()).teams[0]!.agents[0]!;
    expect(ready.tokenUsage24h).toMatchObject({ coverage: "ready", knownTokens: 200, estimatedCost: { coverage: "ready" } });
    expect(ready.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.0009, 12);
    expect(ready.tokenUsage24h!.estimatedCost.usd!).toBeGreaterThan(0);
    expect(ready.tokenUsage24h!.estimatedCost.usd!).toBeLessThan(0.01);
    expect(ready.tokenUsage7d).toMatchObject({ coverage: "ready", knownTokens: 330, estimatedCost: { coverage: "ready" } });
    expect(ready.tokenUsage7d!.estimatedCost.usd).toBeCloseTo(0.0015, 12);

    await appendFile(file, JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:10:00Z", payload: {
      type: "token_count", info: {
        total_token_usage: { total_tokens: 510 },
        last_token_usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 10, total_tokens: 50 },
      },
    } }) + "\n");
    time += 2_000;
    const after = (await provider.get()).teams[0]!.agents[0]!;
    expect(after.tokenUsage24h!.knownTokens).toBe(250);
    expect(after.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.00108, 12);
  });

  it("degrades member cost coverage independently when cached_input_tokens, split or model price is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-split-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    const fileA = join(directory, `rollout-2026-11-01-${SESSION}.jsonl`);
    const fileB = join(directory, `rollout-2026-11-01-${OTHER}.jsonl`);
    await writeFile(fileA, JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }) + "\n");
    await writeFile(fileB, JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: OTHER } }) + "\n");
    let time = Date.UTC(2026, 10, 8, 12);
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: [
        { pane_id: "w6:p1", workspace_id: "w6", name: "missing-split", agent: "codex", agent_status: "done", agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION } },
        { pane_id: "w6:p2", workspace_id: "w6", name: "unknown-price", agent: "codex", agent_status: "done", agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: OTHER } },
      ] } }) });
    await provider.get();

    await appendFile(fileA, [
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T10:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 190 },
          last_token_usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        },
      } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T10:15:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 230 },
          last_token_usage: { input_tokens: 0, output_tokens: 0, total_tokens: 40 },
        },
      } }),
    ].join("\n") + "\n");
    await appendFile(fileB, [
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "unknown-private-model" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 50 },
          last_token_usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 10, total_tokens: 50 },
        },
      } }),
    ].join("\n") + "\n");
    time = Date.UTC(2026, 10, 9, 12);
    const [missingSplit, unknownPrice] = (await provider.get()).teams[0]!.agents;
    expect(missingSplit!.tokenUsage24h).toMatchObject({ coverage: "ready", knownTokens: 230, estimatedCost: { coverage: "partial" } });
    expect(missingSplit!.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.0006, 12);
    expect(unknownPrice!.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 50, activeSeconds: 1, estimatedCost: { coverage: "unavailable", usd: null } });
  });

  it("distinguishes known zero from short-session unavailability and partial lower bounds", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-short-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    const third = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await writeFile(join(directory, `rollout-2026-11-01-${SESSION}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-05T10:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-05T10:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    await writeFile(join(directory, `rollout-2026-11-01-${OTHER}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-09T10:00:00Z", payload: { id: OTHER } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T10:01:00Z", payload: { model: "gpt-6.2-astra" } }),
    ].join("\n") + "\n");
    const fileThird = join(directory, `rollout-2026-11-01-${third}.jsonl`);
    await writeFile(fileThird, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-09T10:00:00Z", payload: { id: third } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T10:01:00Z", payload: { model: "gpt-6.2-astra" } }),
    ].join("\n") + "\n");
    let time = Date.UTC(2026, 10, 8, 12);
    let list = [
      { pane_id: "w6:p1", workspace_id: "w6", name: "known-zero", agent: "codex", agent_status: "idle", agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION } },
    ];
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: list } }) });
    await provider.get();

    time = Date.UTC(2026, 10, 9, 10, 2);
    list = [
      ...list,
      { pane_id: "w6:p2", workspace_id: "w6", name: "short-empty", agent: "codex", agent_status: "idle", agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: OTHER } },
      { pane_id: "w6:p3", workspace_id: "w6", name: "short-partial", agent: "codex", agent_status: "done", agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: third } },
    ];
    await provider.get();

    await appendFile(fileThird, JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T10:05:00Z", payload: {
      type: "token_count", info: {
        total_token_usage: { total_tokens: 130 },
        last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
      },
    } }) + "\n");
    time = Date.UTC(2026, 10, 9, 12);
    const [knownZero, shortEmpty, shortPartial] = (await provider.get()).teams[0]!.agents;
    expect(knownZero!.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 0, activeSeconds: 0, estimatedCost: { coverage: "ready", usd: 0 } });
    expect(knownZero!.tokenUsage7d).toEqual({ coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } });
    expect(shortEmpty!.tokenUsage24h).toEqual({ coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } });
    expect(shortPartial!.tokenUsage24h).toMatchObject({ coverage: "partial", knownTokens: 130, estimatedCost: { coverage: "partial" } });
    expect(shortPartial!.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.0006, 12);
  });

  it("filters pre-switch events when a pane switches from session A to an existing session B and preserves team aggregate", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-switch-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    const fileA = join(directory, `rollout-2026-11-01-${SESSION}.jsonl`);
    await writeFile(fileA, JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }) + "\n");
    const fileB = join(directory, `rollout-2026-11-01-${OTHER}.jsonl`);
    await writeFile(fileB, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: OTHER } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "gpt-6.1-sol" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 500 },
          last_token_usage: { input_tokens: 400, cached_input_tokens: 0, output_tokens: 100, total_tokens: 500 },
        },
      } }),
    ].join("\n") + "\n");
    let currentSession = SESSION;
    let time = Date.UTC(2026, 10, 8, 10, 0);
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: [{
        pane_id: "w6:p1", workspace_id: "w6", name: "seat-one", agent: "codex", agent_status: "working",
        agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: currentSession },
      }] } }) });
    await provider.get();
    await appendFile(fileA, [
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T08:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T08:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    time = Date.UTC(2026, 10, 9, 10, 0);
    expect((await provider.get()).teams[0]!.agents[0]!.tokenUsage24h).toMatchObject({ coverage: "ready", knownTokens: 130 });

    currentSession = OTHER;
    time = Date.UTC(2026, 10, 9, 11, 0);
    const afterSwitch = (await provider.get()).teams[0]!;
    expect(afterSwitch.agents[0]!.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });
    expect(afterSwitch.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 500 });

    await appendFile(fileB, JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:05:00Z", payload: {
      type: "token_count", info: {
        total_token_usage: { total_tokens: 570 },
        last_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20, total_tokens: 70 },
      },
    } }) + "\n");
    time = Date.UTC(2026, 10, 9, 11, 10);
    const afterAppend = (await provider.get()).teams[0]!;
    expect(afterAppend.agents[0]!.tokenUsage24h).toMatchObject({
      coverage: "partial", knownTokens: 70, estimatedCost: { coverage: "partial" },
    });
    expect(afterAppend.agents[0]!.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.0003, 12);
    expect(afterAppend.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 570 });
  });

  it("caps first-seen seat attribution at its first verified observation and prevents old session drift", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-first-seen-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `rollout-2026-11-01-${SESSION}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    let pane = "w6:p1";
    let time = Date.UTC(2026, 10, 9, 10);
    let terminal = "term_original";
    const makeProvider = () => createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      bindingCachePath: join(home, "bindings.json"),
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: [{
        pane_id: pane, workspace_id: "w6", name: "migrated-seat", agent: "codex", agent_status: "working", terminal_id: terminal,
        agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
      }] } }) });
    const provider = makeProvider();
    const first = (await provider.get()).teams[0]!.agents[0]!;
    expect(first.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });

    pane = "w6:p2";
    time = Date.UTC(2026, 10, 9, 11);
    const moved = (await provider.get()).teams[0]!.agents[0]!;
    expect(moved.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });

    await appendFile(file, JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:05:00Z", payload: {
      type: "token_count", info: {
        total_token_usage: { total_tokens: 200 },
        last_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20, total_tokens: 70 },
      },
    } }) + "\n");
    time = Date.UTC(2026, 10, 9, 11, 10);
    const afterPostBound = (await provider.get()).teams[0]!.agents[0]!;
    expect(afterPostBound.tokenUsage24h).toMatchObject({
      coverage: "partial", knownTokens: 70, estimatedCost: { coverage: "partial" },
    });
    expect(afterPostBound.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.0012, 12);
    expect(afterPostBound.tokenUsage7d).toMatchObject({
      coverage: "partial", knownTokens: 70, estimatedCost: { coverage: "partial" },
    });
    expect(afterPostBound.tokenUsage7d!.estimatedCost.usd).toBeCloseTo(0.0012, 12);

    time = Date.UTC(2026, 10, 9, 11, 15);
    const afterRestart = (await makeProvider().get()).teams[0]!.agents[0]!;
    expect(afterRestart.tokenUsage24h).toEqual(afterPostBound.tokenUsage24h);
    expect(afterRestart.tokenUsage7d).toEqual(afterPostBound.tokenUsage7d);

    terminal = "term_replacement";
    const replacement = makeProvider();
    const afterReplacement = (await replacement.get()).teams[0]!.agents[0]!;
    expect(afterReplacement.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });
    expect(afterReplacement.tokenUsage7d).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });

    await appendFile(file, JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T11:20:00Z", payload: {
      type: "token_count", info: {
        total_token_usage: { total_tokens: 250 },
        last_token_usage: { input_tokens: 40, cached_input_tokens: 0, output_tokens: 10, total_tokens: 50 },
      },
    } }) + "\n");
    time = Date.UTC(2026, 10, 9, 11, 25);
    const postRestartAppend = (await replacement.get()).teams[0]!.agents[0]!;
    expect(postRestartAppend.tokenUsage24h).toMatchObject({
      coverage: "partial", knownTokens: 50, estimatedCost: { coverage: "partial" },
    });
    expect(postRestartAppend.tokenUsage7d).toMatchObject({
      coverage: "partial", knownTokens: 50, estimatedCost: { coverage: "partial" },
    });
    expect(postRestartAppend.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.00072, 12);
  });

  it("rejects member usage when agent_session.source is missing while keeping legacy team aggregate", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-unverified-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `rollout-2026-11-01-${SESSION}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    let time = Date.UTC(2026, 10, 8, 12);
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: [{
        pane_id: "w6:p1", workspace_id: "w6", name: "missing-source", agent: "codex", agent_status: "done",
        agent_session: { kind: "id", agent: "codex", value: SESSION },
      }] } }) });
    await provider.get();
    time = Date.UTC(2026, 10, 9, 12);
    const team = (await provider.get()).teams[0]!;
    expect(team.agents[0]!.occupantId).toBeUndefined();
    expect(team.agents[0]!.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });
    expect(team.agents[0]!.tokenUsage7d).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });
    expect(team.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 130 });
  });

  it("refuses to report ready zero after an observed session log is shortened to its header", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-shortened-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `rollout-2026-11-01-${SESSION}.jsonl`);
    await writeFile(file, JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }) + "\n");
    let time = Date.UTC(2026, 10, 8, 12);
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: [{
        pane_id: "w6:p1", workspace_id: "w6", name: "seat-one", agent: "codex", agent_status: "working",
        agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
      }] } }) });
    await provider.get();

    await appendFile(file, [
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    time = Date.UTC(2026, 10, 9, 12);
    expect((await provider.get()).teams[0]!.agents[0]!.tokenUsage24h).toMatchObject({ coverage: "ready", knownTokens: 130 });

    await writeFile(file, JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }) + "\n");
    time = Date.UTC(2026, 10, 9, 12, 1);
    const afterTruncate = (await provider.get()).teams[0]!.agents[0]!;
    expect(afterTruncate.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });

    await appendFile(file, [
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T12:02:00Z", payload: { model: "gpt-6.1-sol" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T12:03:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 70 },
          last_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20, total_tokens: 70 },
        },
      } }),
    ].join("\n") + "\n");
    time = Date.UTC(2026, 10, 9, 12, 5);
    const afterRecovery = (await provider.get()).teams[0]!.agents[0]!;
    expect(afterRecovery.tokenUsage24h).toMatchObject({
      coverage: "partial", knownTokens: 70, estimatedCost: { coverage: "partial" },
    });
    expect(afterRecovery.tokenUsage24h!.estimatedCost.usd).toBeCloseTo(0.0003, 12);
  });

  it("refuses ready zero when a same-size replacement inode keeps only outside-24h tokens", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-inode-swap-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    const file = join(directory, `rollout-2026-11-01-${SESSION}.jsonl`);
    const initialContent = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n";
    await writeFile(file, initialContent);
    const originalStat = await stat(file);
    let time = Date.UTC(2026, 10, 2, 12);
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: [{
        pane_id: "w6:p1", workspace_id: "w6", name: "seat-one", agent: "codex", agent_status: "working",
        agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
      }] } }) });
    await provider.get();

    time = Date.UTC(2026, 10, 9, 12);
    const beforeSwap = (await provider.get()).teams[0]!.agents[0]!;
    expect(beforeSwap.tokenUsage24h).toMatchObject({ coverage: "ready", knownTokens: 130 });
    expect(beforeSwap.tokenUsage7d).toMatchObject({ coverage: "ready", knownTokens: 130 });

    const swappedContent = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-05T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-05T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n";
    expect(Buffer.byteLength(swappedContent)).toBe(Buffer.byteLength(initialContent));
    const replacement = join(directory, "replacement.tmp");
    await writeFile(replacement, swappedContent);
    await rename(replacement, file);
    const swappedStat = await stat(file);
    expect(swappedStat.ino).not.toBe(originalStat.ino);
    expect(swappedStat.size).toBe(originalStat.size);

    time = Date.UTC(2026, 10, 9, 12, 1);
    const afterSwapTeam = (await provider.get()).teams[0]!;
    expect(afterSwapTeam.agents[0]!.tokenUsage24h).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });
    expect(afterSwapTeam.agents[0]!.tokenUsage7d).toMatchObject({
      coverage: "partial", knownTokens: 130, estimatedCost: { coverage: "partial" },
    });
    expect(afterSwapTeam.agents[0]!.tokenUsage7d!.estimatedCost.usd).toBeCloseTo(0.0006, 12);
    expect(afterSwapTeam.tokenUsage24h).toEqual({ coverage: "ready", knownTokens: 0 });
    expect(afterSwapTeam.tokenUsage7d).toEqual({ coverage: "ready", knownTokens: 130 });
  });

  it("excludes ambiguous intra-team claims for members while keeping non-Codex roster unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-member-ambiguous-"));
    folders.push(home);
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `rollout-2026-11-01-${SESSION}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-09T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-09T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    const provider = createLocalAgentTeamsProvider({ codexHome: home, now: () => Date.UTC(2026, 10, 9, 12),
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({ result: { agents: [
        { pane_id: "w6:p1", workspace_id: "w6", name: "dup-a", agent: "codex", agent_status: "done", agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION } },
        { pane_id: "w6:p2", workspace_id: "w6", name: "dup-b", agent: "codex", agent_status: "done", agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION.toUpperCase() } },
        { pane_id: "w6:p3", workspace_id: "w6", name: "opencode-seat", agent: "opencode", agent_status: "idle", cwd: "/private/workspace", tokens: { model: "gpt-6.2-astra" } },
        { pane_id: "w6:p4", workspace_id: "w6", name: "pi-seat", agent: "pi", agent_status: "idle", agent_session: { kind: "path", agent: "pi", source: "herdr:pi", value: join(home, "missing.jsonl") } },
      ] } }) });
    const team = (await provider.get()).teams[0]!;
    expect(team.agents).toHaveLength(4);
    for (const member of team.agents) {
      expect(member.tokenUsage24h).toEqual({ coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } });
      expect(member.tokenUsage7d).toEqual({ coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } });
    }
    expect(team.tokenUsage24h).toEqual({ coverage: "partial", knownTokens: 130 });
  });

  it("retains same-origin workspace session history across legacy v1 upgrade and transient misses while still gating moves", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-same-origin-"));
    folders.push(home);
    const repo = join(home, "repo");
    const directory = join(home, "sessions", "2026", "11", "01");
    await mkdir(repo, { recursive: true });
    await mkdir(directory, { recursive: true });
    const file = join(directory, `rollout-2026-11-01-${SESSION}.jsonl`);
    await writeFile(file, [
      JSON.stringify({ type: "session_meta", timestamp: "2026-11-01T10:00:00Z", payload: { id: SESSION, timestamp: "2026-11-01T10:00:00Z", cwd: repo } }),
      JSON.stringify({ type: "turn_context", timestamp: "2026-11-08T09:00:00Z", payload: { model: "gpt-6.2-astra" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-11-08T09:05:00Z", payload: {
        type: "token_count", info: {
          total_token_usage: { total_tokens: 130 },
          last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 10, total_tokens: 130 },
        },
      } }),
    ].join("\n") + "\n");
    let time = Date.UTC(2026, 10, 9, 10);
    const bindingFile = join(home, "bindings.json");
    const legacyRaw = JSON.stringify(["w6:p1", "codex", "o000", SESSION, repo, "term_a"]);
    const legacyHash = createHash("sha256").update(legacyRaw).digest("hex");
    await writeFile(bindingFile, JSON.stringify([[legacyHash, Date.UTC(2026, 10, 9, 9)]]), { mode: 0o600 });

    let present = true;
    let pane = "w6:p1";
    const provider = createLocalAgentTeamsProvider({
      codexHome: home,
      bindingCachePath: bindingFile,
      now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({
        result: {
          agents: present ? [{
            pane_id: pane, workspace_id: "w6", name: "origin-seat", agent: "codex", agent_status: "done",
            cwd: repo, terminal_id: "term_a",
            agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
          }] : [],
        },
      }),
    });

    const first = (await provider.get()).teams[0]!.agents[0]!;
    expect(first.tokenUsage7d).toMatchObject({ coverage: "ready", knownTokens: 130 });

    present = false;
    time += 2_000;
    expect((await provider.get()).teams[0]!.agents).toHaveLength(0);
    present = true;
    time += 2_000;
    const afterMiss = (await provider.get()).teams[0]!.agents[0]!;
    expect(afterMiss.tokenUsage7d).toMatchObject({ coverage: "ready", knownTokens: 130 });

    pane = "w6:p2";
    time += 2_000;
    const afterMove = (await provider.get()).teams[0]!.agents[0]!;
    expect(afterMove.tokenUsage7d).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });

    // A second poll on the destination pane must remain gated and never rewind back to sessionStartedAt.
    time += 2_000;
    const afterMoveSecondPoll = (await provider.get()).teams[0]!.agents[0]!;
    expect(afterMoveSecondPoll.tokenUsage7d).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });

    // A pre-`seats` bindings.json (`bindings` + `sessions` only) must also fail closed on a cross-pane move.
    const preSeatsFile = join(home, "pre-seats-bindings.json");
    const priorKey = createHash("sha256").update(JSON.stringify(["w6:p1", "codex", "o_prior", SESSION, "term_a"])).digest("hex");
    const sessionHash = createHash("sha256").update(`session:${SESSION}`).digest("hex");
    await writeFile(preSeatsFile, JSON.stringify({
      bindings: [[priorKey, Date.UTC(2026, 10, 1, 10)]],
      sessions: [[sessionHash, priorKey]],
    }), { mode: 0o600 });
    const preSeatsProvider = createLocalAgentTeamsProvider({
      codexHome: home,
      bindingCachePath: preSeatsFile,
      now: () => time,
      run: async (args) => args.at(-2) === "workspace" ? workspaces : JSON.stringify({
        result: {
          agents: [{
            pane_id: "w6:p2", workspace_id: "w6", name: "origin-seat", agent: "codex", agent_status: "done",
            cwd: repo, terminal_id: "term_b",
            agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
          }],
        },
      }),
    });
    const afterPreSeatsMove = (await preSeatsProvider.get()).teams[0]!.agents[0]!;
    expect(afterPreSeatsMove.tokenUsage7d).toEqual({
      coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null },
    });
  });

  it("returns the fast Herdr roster immediately on slow cold enrichment and serves full enriched data once ready", async () => {
    const codexHome = await codexLog(SESSION);
    let releaseSecondList: (() => void) | null = null;
    let agentListCalls = 0;
    let time = 10_000;
    const verifiedAgents = JSON.stringify({
      result: {
        agents: [{
          pane_id: "w6:p1", workspace_id: "w6", name: "mausbot-front", agent: "codex", agent_status: "done",
          cwd: "/private/workspace", terminal_id: "term_fast",
          agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
        }],
      },
    });
    const provider = createLocalAgentTeamsProvider({
      codexHome,
      fastRosterTimeoutMs: 20,
      now: () => time,
      run: async (args) => {
        if (args.at(-2) === "workspace") return workspaces;
        agentListCalls++;
        // Hold only the first enrichment verification pass (2nd agent list call) so cold enrichment exceeds fastRosterTimeoutMs.
        if (agentListCalls === 2) {
          await new Promise<void>((resolve) => { releaseSecondList = resolve; });
        }
        return verifiedAgents;
      },
    });

    const first = await provider.get();
    expect(first.status).toBe("ready");
    expect(first.enriching).toBe(true);
    expect(first.teamCount).toBe(1);
    expect(first.teams[0]?.agents[0]).toMatchObject({ id: "w6:p1", name: "mausbot-front", kind: "codex", state: "done", model: null });

    // A second non-fresh read while enrichment is still running returns the fast roster immediately.
    const during = await provider.get();
    expect(during.enriching).toBe(true);

    // Advance clock past 1_000ms while enrichment is still in flight; once it finishes,
    // a non-fresh get() must see the settled snapshot (enriching === undefined), never loop forever.
    time += 2_000;
    expect(releaseSecondList).not.toBeNull();
    releaseSecondList!();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const settled = await provider.get();
    expect(settled.enriching).toBeUndefined();
    expect(settled.teams[0]?.agents[0]).toMatchObject({ model: "gpt-6-sol", reasoningEffort: "xhigh", contextUsed: 150 });

    // Warm SWR returns lastResult immediately with enriching: true after >1s, then clears once background refresh finishes.
    time += 2_000;
    const warm = await provider.get();
    expect(warm.status).toBe("ready");
    expect(warm.enriching).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const afterWarm = await provider.get();
    expect(afterWarm.enriching).toBeUndefined();
  });

  it("awaits full enrichment on concurrent cold calls when fastRosterTimeoutMs is disabled (0) and transitions warm SWR to stale on Herdr failure", async () => {
    const codexHome = await codexLog(SESSION);
    let releaseSecondList: (() => void) | null = null;
    let agentListCalls = 0;
    let failHerdr = false;
    let time = 10_000;
    const verifiedAgents = JSON.stringify({
      result: {
        agents: [{
          pane_id: "w6:p1", workspace_id: "w6", name: "mausbot-front", agent: "codex", agent_status: "done",
          cwd: "/private/workspace", terminal_id: "term_sync",
          agent_session: { kind: "id", agent: "codex", source: "herdr:codex", value: SESSION },
        }],
      },
    });
    const run = async (args: readonly string[]) => {
      if (failHerdr) throw new Error("herdr offline");
      if (args.at(-2) === "workspace") return workspaces;
      agentListCalls++;
      if (agentListCalls === 2) {
        await new Promise<void>((resolve) => { releaseSecondList = resolve; });
      }
      return verifiedAgents;
    };

    // With fastRosterTimeoutMs = 0, concurrent cold get() calls both await full enrichment (no fast roster returned).
    const syncProvider = createLocalAgentTeamsProvider({ codexHome, fastRosterTimeoutMs: 0, now: () => time, run });
    const p1 = syncProvider.get();
    const p2 = syncProvider.get();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(releaseSecondList).not.toBeNull();
    releaseSecondList!();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.enriching).toBeUndefined();
    expect(r2.enriching).toBeUndefined();
    expect(r1.teams[0]?.agents[0]?.model).toBe("gpt-6-sol");

    // With fastRosterTimeoutMs > 0, a warm SWR refresh whose Herdr read fails transitions the cached snapshot to stale.
    agentListCalls = 10;
    const swrProvider = createLocalAgentTeamsProvider({ codexHome, fastRosterTimeoutMs: 5_000, now: () => time, run });
    const ready = await swrProvider.get();
    expect(ready.status).toBe("ready");
    expect(ready.enriching).toBeUndefined();

    failHerdr = true;
    time += 2_000;
    const duringFailure = await swrProvider.get();
    expect(duringFailure.status).toBe("ready");
    expect(duringFailure.enriching).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const settledStale = await swrProvider.get();
    expect(settledStale.status).toBe("stale");
    expect(settledStale.enriching).toBeUndefined();
  });

  it("bypasses SWR cache when a Pi agent has a live contextWindow", async () => {
    const rawHome = await mkdtemp(join(tmpdir(), "mausbot-pi-swr-bypass-"));
    folders.push(rawHome);
    const home = await realpath(rawHome);
    const repo = join(home, "repo");
    await mkdir(repo, { recursive: true });
    const cwdSlug = `--${repo.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const piSession = join(
      home, ".local", "share", "mausbot-team", "pi-agent", "sessions", cwdSlug,
      `2026-11-09T10-00-00-000Z_${SESSION}.jsonl`,
    );
    await mkdir(dirname(piSession), { recursive: true });
    await writeFile(piSession, JSON.stringify({
      type: "session", version: 3, id: SESSION, timestamp: "2026-11-09T10:00:00Z", cwd: repo,
    }) + "\n" + JSON.stringify({
      type: "model_change", id: "00000001", parentId: null, timestamp: "2026-11-09T10:00:01Z", provider: "raven", modelId: "gpt-6.2-sol",
    }) + "\n");
    let time = Date.UTC(2026, 10, 9, 10, 0, 5);
    let listCalls = 0;
    const binding = {
      pane: "w6:p1", sessionId: SESSION, file: piSession, cwd: repo,
      leaf: "00000001", provider: "raven", model: "gpt-6.2-sol",
    };
    const makeAgents = (windowSize: number) => JSON.stringify({
      result: {
        agents: [{
          pane_id: "w6:p1", workspace_id: "w6", name: "mausbot-dev1", agent: "pi", agent_status: "idle",
          cwd: repo, terminal_id: "term_pi",
          agent_session: { kind: "path", agent: "pi", source: "herdr:pi", value: piSession },
          tokens: {
            [PI_CONTEXT_KEY]: piContextToken(binding, 4242, "1700000000:123456", windowSize, time),
          },
        }],
      },
    });
    let currentWindow = 1_000_000;
    const provider = createLocalAgentTeamsProvider({
      home,
      fastRosterTimeoutMs: 5_000,
      now: () => time,
      readProcessStart: async (pid) => pid === 4242 ? "1700000000:123456" : null,
      run: async (args) => {
        if (args.at(-2) === "workspace") return workspaces;
        if (args.includes("process-info")) {
          return JSON.stringify({
            result: { process_info: { pane_id: "w6:p1", foreground_processes: [{ pid: 4242, name: "node" }] } },
          });
        }
        listCalls++;
        return makeAgents(currentWindow);
      },
    });

    // Seed an enriched snapshot before verifying that non-fresh reads bypass SWR when a Pi member has contextWindow.
    const first = await provider.get(true);
    expect(first.teams[0]?.agents[0]?.contextWindow).toBe(1_000_000);
    const callsAfterFirst = listCalls;

    // Even >1s later with fastRosterTimeoutMs > 0, a Pi member with contextWindow must bypass SWR and re-verify live.
    currentWindow = 500_000;
    time += 2_000;
    const second = await provider.get();
    expect(listCalls).toBeGreaterThan(callsAfterFirst);
    expect(second.enriching).toBeUndefined();
    expect(second.teams[0]?.agents[0]?.contextWindow).toBe(500_000);
  });

  it("recovers Agy model/effort/context/usage from process-info --conversation when Herdr has not emitted agent_session yet, and preserves same-origin history across terminal_id rotation", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-agy-argv-continuity-"));
    folders.push(home);
    const repo = join(home, "repo");
    const brainLogs = join(home, ".gemini", "antigravity-cli", "brain", SESSION, ".system_generated", "logs");
    await mkdir(repo, { recursive: true });
    await mkdir(brainLogs, { recursive: true });
    const summaryDb = new DatabaseSync(join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"));
    summaryDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)");
    summaryDb.prepare("INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)").run(
      SESSION, JSON.stringify([`file://${repo}`]),
    );
    summaryDb.close();
    await writeFile(join(brainLogs, "transcript.jsonl"), [
      JSON.stringify({ type: "USER_INPUT", created_at: "2026-11-24T08:00:00Z", content: "Review PR #1271" }),
      JSON.stringify({
        type: "PLANNER_RESPONSE", created_at: "2026-11-25T09:00:00Z", model: "gemini-4-neon-high",
        input_tokens: 1000, output_tokens: 200, cache_read_tokens: 300, content: "Looks good",
      }),
    ].join("\n") + "\n");

    const bindingFile = join(home, "bindings.json");
    let term = "term_before_restart";
    let withSession = true;
    let time = Date.UTC(2026, 10, 26, 3, 0);
    const run = async (args: readonly string[]) => {
      if (args.at(-2) === "workspace") return workspaces;
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: "w6:pQ",
              foreground_processes: [{
                argv: ["/opt/homebrew/bin/antigravity", "--dangerously-skip-permissions", "--conversation", SESSION],
              }],
            },
          },
        });
      }
      return JSON.stringify({
        result: {
          agents: [{
            pane_id: "w6:pQ", workspace_id: "w6", name: "mausbot-review3", agent: "agy", agent_status: "idle",
            cwd: repo, terminal_id: term,
            ...(withSession ? { agent_session: { kind: "id", agent: "agy", source: "herdr:antigravity_cli", value: SESSION } } : {}),
          }],
        },
      });
    };

    const firstProvider = createLocalAgentTeamsProvider({ home, bindingCachePath: bindingFile, now: () => time, run });
    const first = (await firstProvider.get()).teams[0]!.agents[0]!;
    expect(first).toMatchObject({ model: "gemini-4-neon", reasoningEffort: "high", contextUsed: 1300, contextWindow: 1_048_576 });
    expect(first.tokenUsage7d).toMatchObject({ coverage: "partial", knownTokens: 1500 });

    // Simulate Herdr daemon restart rotating terminal_id and idle Agy omitting agent_session before next turn.
    term = "term_after_restart";
    withSession = false;
    time += 60_000;
    const secondProvider = createLocalAgentTeamsProvider({ home, bindingCachePath: bindingFile, now: () => time, run });
    const afterRestart = (await secondProvider.get()).teams[0]!.agents[0]!;
    expect(afterRestart).toMatchObject({ model: "gemini-4-neon", reasoningEffort: "high", contextUsed: 1300, contextWindow: 1_048_576 });
    expect(afterRestart.tokenUsage7d).toMatchObject({ coverage: "partial", knownTokens: 1500 });
  });

  it("fails closed on duplicate idle Agy --conversation claims, mismatched process-info pane_id, and mid-read pane occupant changes", async () => {
    const home = await mkdtemp(join(tmpdir(), "mausbot-agy-fallback-guards-"));
    folders.push(home);
    const repo = join(home, "repo");
    const brainLogs = join(home, ".gemini", "antigravity-cli", "brain", SESSION, ".system_generated", "logs");
    await mkdir(repo, { recursive: true });
    await mkdir(brainLogs, { recursive: true });
    const summaryDb = new DatabaseSync(join(home, ".gemini", "antigravity-cli", "conversation_summaries.db"));
    summaryDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)");
    summaryDb.prepare("INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)").run(
      SESSION, JSON.stringify([`file://${repo}`]),
    );
    summaryDb.close();
    await writeFile(join(brainLogs, "transcript.jsonl"), [
      JSON.stringify({ type: "USER_INPUT", created_at: "2026-11-24T08:00:00Z", content: "Secret prompt" }),
      JSON.stringify({
        type: "PLANNER_RESPONSE", created_at: "2026-11-25T09:00:00Z", model: "gemini-4-neon-high",
        input_tokens: 1000, output_tokens: 200, cache_read_tokens: 300, content: "Reply",
      }),
    ].join("\n") + "\n");

    const now = () => Date.UTC(2026, 10, 26, 3, 0);

    // 1. Two idle Agy panes claiming the same --conversation must both fail closed.
    const dupProvider = createLocalAgentTeamsProvider({
      home, now,
      run: async (args) => {
        if (args.at(-2) === "workspace") return workspaces;
        if (args.includes("process-info")) {
          const pane = args.at(-1)!;
          return JSON.stringify({
            result: {
              process_info: {
                pane_id: pane,
                foreground_processes: [{ argv: ["/opt/homebrew/bin/antigravity", "--conversation", SESSION] }],
              },
            },
          });
        }
        return JSON.stringify({
          result: {
            agents: [
              { pane_id: "w6:p1", workspace_id: "w6", name: "dup-a", agent: "agy", agent_status: "idle", cwd: repo, terminal_id: "t1" },
              { pane_id: "w6:p2", workspace_id: "w6", name: "dup-b", agent: "agy", agent_status: "idle", cwd: repo, terminal_id: "t2" },
            ],
          },
        });
      },
    });
    const dupAgents = (await dupProvider.get()).teams[0]!.agents;
    for (const member of dupAgents) {
      expect(member.contextUsed).toBeNull();
      expect(member.taskHint).toBeNull();
      expect(member.tokenUsage7d).toEqual({ coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } });
    }

    // 2. Mismatched process_info.pane_id must be rejected.
    const mismatchProvider = createLocalAgentTeamsProvider({
      home, now,
      run: async (args) => {
        if (args.at(-2) === "workspace") return workspaces;
        if (args.includes("process-info")) {
          return JSON.stringify({
            result: {
              process_info: {
                pane_id: "w6:pOTHER",
                foreground_processes: [{ argv: ["/opt/homebrew/bin/antigravity", "--conversation", SESSION] }],
              },
            },
          });
        }
        return JSON.stringify({
          result: {
            agents: [
              { pane_id: "w6:pQ", workspace_id: "w6", name: "mausbot-review3", agent: "agy", agent_status: "idle", cwd: repo, terminal_id: "t1" },
            ],
          },
        });
      },
    });
    const mismatchMember = (await mismatchProvider.get()).teams[0]!.agents[0]!;
    expect(mismatchMember.contextUsed).toBeNull();
    expect(mismatchMember.tokenUsage7d).toEqual({ coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } });

    // 3. Mid-read occupant change on the 2nd agent list must fail closed and never leak metadata via fallbackAgyMeta.
    let listCall = 0;
    const swappedProvider = createLocalAgentTeamsProvider({
      home, now,
      run: async (args) => {
        if (args.at(-2) === "workspace") return workspaces;
        if (args.includes("process-info")) {
          return JSON.stringify({
            result: {
              process_info: {
                pane_id: "w6:pQ",
                foreground_processes: [{ argv: ["/opt/homebrew/bin/antigravity", "--conversation", SESSION] }],
              },
            },
          });
        }
        listCall++;
        return JSON.stringify({
          result: {
            agents: [{
              pane_id: "w6:pQ", workspace_id: "w6", name: "mausbot-review3", agent: "agy", agent_status: "idle",
              cwd: repo, terminal_id: listCall === 1 ? "t1" : "t2_replaced",
            }],
          },
        });
      },
    });
    const swappedMember = (await swappedProvider.get()).teams[0]!.agents[0]!;
    expect(swappedMember.model).toBeNull();
    expect(swappedMember.contextUsed).toBeNull();
    expect(swappedMember.taskHint).toBeNull();
    expect(swappedMember.tokenUsage7d).toEqual({ coverage: "unavailable", knownTokens: null, estimatedCost: { coverage: "unavailable", usd: null } });
  });
});
