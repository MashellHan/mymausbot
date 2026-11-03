import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "private conversation" } }),
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
    expect(snapshot).toEqual({ status: "ready", updatedAt: 1000, teamCount: 1, teams: [{ id: "w6", name: "MausBot", agentCount: 1, agents: [{
      id: "w6:p1", name: "mausbot-front", kind: "codex", role: null, model: "gpt-6-sol", state: "done", taskHint: "Build Agent Team secret",
    }] }] });
    expect(JSON.stringify(snapshot)).not.toMatch(/private conversation|private\/workspace|session_meta|effort|terminal_title/);
  });

  it("reports an unknown model when the file's session ID differs", async () => {
    const codexHome = await codexLog(SESSION, OTHER);
    const provider = createLocalAgentTeamsProvider({ codexHome, run: async (args) => args.at(-2) === "workspace" ? workspaces : agents() });
    expect((await provider.get()).teams[0]?.agents[0]?.model).toBeNull();
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
