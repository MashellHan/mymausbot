import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { createLocalAgentActivityProvider } from "./local-agent-activity.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const SESSION = "ses_ExampleOpenCode";
const OTHER = "ses_ExampleDifferent";
const pane = "w6:p1";
const agent = { pane_id: pane, workspace_id: "w6", name: "fixture-opencode", agent: "opencode",
  cwd: "/fixture/workspace", agent_status: "done",
  agent_session: { kind: "id", agent: "opencode", value: SESSION, source: "herdr:opencode" } };
const occupantId = localAgentOccupantId(agent, pane)!;
const listed = (agents: object[]) => JSON.stringify({ result: { agents, workspaces: [{ workspace_id: "w6", label: "Fixture" }] } });

async function fixture(test: (home: string, db: DatabaseSync) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "opencode-dashboard-"));
  const data = join(home, ".local", "share", "opencode");
  await mkdir(data, { recursive: true });
  const db = new DatabaseSync(join(data, "opencode.db"));
  try {
    db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL)`);
    await test(home, db);
  } finally { db.close(); await removeTempDir(home); }
}

describe("bounded OpenCode panel messages", () => {
  it("uses only the verified selected session for Tree preview, model and redacted recent activity", async () => {
    await fixture(async (home, db) => {
      const add = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
      const rows = [
        ["user", { text: "Check /Users/fixture/private.txt", files: [{ text: "Private file" }] }],
        ["assistant", { content: [{ type: "reasoning", text: "Private reasoning" }, { type: "tool", text: "Private tool" },
          { type: "text", text: "Visible reply" }, { type: "text", text: "at https://private.test/detail" }],
          model: { id: "fixture-model", variant: "high" } }],
        ["assistant", { content: [{ type: "text", text: "<SYSTEM_MESSAGE>Private envelope</SYSTEM_MESSAGE>" }] }],
        ["synthetic", { text: "Private synthetic" }],
      ] as const;
      rows.forEach(([kind, data], index) => add.run(`fixture-message-${index}`, SESSION, kind, index, 1000 + index, JSON.stringify(data)));
      add.run("other-message", OTHER, "assistant", 99, 1099, JSON.stringify({ content: [{ type: "text", text: "Private other session" }] }));
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("older-message", SESSION, 1100, '{"role":"assistant"}');
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run("older-part", SESSION, "older-message", '{"type":"text","text":"Private migrated duplicate"}');
      let agents: object[] = [agent];
      const run = async () => listed(agents);
      const team = createLocalAgentTeamsProvider({ home, run });
      const activity = createLocalAgentActivityProvider({ home, run });
      const expected = ["Check [path]", "Visible reply at [link]"];
      expect((await team.get()).teams[0]?.agents[0]).toMatchObject({
        messagePreview: "Visible reply at [link]", model: "fixture-model", reasoningEffort: "high",
      });
      for (const request of [undefined, { occupantId }]) {
        const response = await activity.get(pane, request);
        expect(response.status).toBe("ready");
        expect(response.events.map(({ text }) => text)).toEqual(expected);
        expect(JSON.stringify(response)).not.toMatch(/Private|ses_|fixture-message|private\.test/);
      }
      agents = [agent, { ...agent, pane_id: "w6:p2", name: "fixture-duplicate" }];
      expect((await team.get(true)).teams[0]?.agents.map(({ messagePreview }) => messagePreview)).toEqual([null, null]);
      expect(await activity.get(pane)).toMatchObject({ status: "unavailable", events: [] });
      expect(await activity.get(pane, { occupantId })).toMatchObject({ status: "unavailable", events: [] });

      agents = [{ ...agent, agent_session: { ...agent.agent_session, source: "untrusted:opencode" } }];
      expect(await activity.get(pane)).toMatchObject({ status: "unavailable", events: [] });
      agents = [{ ...agent, agent_session: { ...agent.agent_session, value: OTHER } }];
      expect(await activity.get(pane, { occupantId })).toMatchObject({ status: "unavailable", events: [] });

      let polls = 0;
      const switched = createLocalAgentActivityProvider({ home, run: async () => listed(++polls === 1 ? [agent] : agents) });
      expect(await switched.get(pane, { occupantId })).toMatchObject({ status: "unavailable", events: [] });
      polls = 0;
      const previewSwitched = createLocalAgentTeamsProvider({ home, run: async (args) =>
        listed(args.includes("agent") && ++polls !== 1 ? agents : [agent]) });
      expect((await previewSwitched.get()).teams[0]?.agents[0]).toMatchObject({
        messagePreview: null, model: null, reasoningEffort: null,
      });
    });
  });

  it("pages a bounded SQLite snapshot and keeps an older cursor after a WAL append", async () => {
    await fixture(async (home, db) => {
      const add = db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?)");
      const insert = (index: number) => add.run(`fixture-message-${index}`, SESSION, index, 1000 + index,
        JSON.stringify({ content: [{ type: "text", text: `Synthetic reply ${index}` }] }));
      for (let index = 0; index < 105; index++) insert(index);
      const activity = createLocalAgentActivityProvider({ home, run: async () => listed([agent]) });
      const latest = await activity.get(pane, { occupantId });
      expect(latest.events).toHaveLength(100);
      const before = latest.history!.nextBefore!;
      const first = await activity.get(pane, { occupantId, before });
      expect(first.events.map(({ text }) => text)).toEqual(Array.from({ length: 5 }, (_, index) => `Synthetic reply ${index}`));
      insert(105);
      const updated = await activity.get(pane, { occupantId });
      expect(updated.history?.streamId).toBe(latest.history?.streamId);
      expect(updated.events.at(-1)?.text).toBe("Synthetic reply 105");
      expect((await activity.get(pane, { occupantId, before })).events).toEqual(first.events);
      const recent = await activity.get(pane);
      expect(recent.events).toHaveLength(60);
      expect(recent.truncated).toBe(true);
    });
  });

  it("reads legacy text parts only when a session has no current store", async () => {
    await fixture(async (home, db) => {
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run("older-message", SESSION, 1100, '{"role":"assistant","modelID":"legacy-model"}');
      const part = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)");
      part.run("part-1", SESSION, "older-message", '{"type":"text","text":"Legacy reply"}');
      part.run("part-2", SESSION, "older-message", '{"type":"text","text":"Private synthetic","synthetic":true}');
      part.run("part-3", OTHER, "older-message", '{"type":"text","text":"Private different session"}');
      const activity = createLocalAgentActivityProvider({ home, run: async () => listed([agent]) });
      expect((await activity.get(pane, { occupantId })).events.map(({ text }) => text)).toEqual(["Legacy reply"]);
    });
  });

  it("finds visible content through a tool-heavy current session tail", async () => {
    await fixture(async (home, db) => {
      const add = db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', ?, ?, ?)");
      add.run("visible-message", SESSION, 1, 1000, JSON.stringify({
        content: [{ type: "text", text: "Last visible reply" }, { type: "text", text: "Private synthetic", synthetic: true }],
      }));
      const toolOnly = JSON.stringify({ model: { id: "fixture-model", variant: "high" },
        content: [{ type: "tool", result: "Private result".repeat(3000) }] });
      for (let index = 2; index < 68; index++) add.run(`fixture-message-${index}`, SESSION, index, 1000 + index, toolOnly);
      const run = async () => listed([agent]);
      const team = createLocalAgentTeamsProvider({ home, run });
      const activity = createLocalAgentActivityProvider({ home, run });
      expect((await team.get()).teams[0]?.agents[0]).toMatchObject({
        messagePreview: "Last visible reply", model: "fixture-model", reasoningEffort: "high",
      });
      expect((await activity.get(pane)).events.map(({ text }) => text)).toEqual(["Last visible reply"]);
    });
  });
});
