import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { agyModelFromArgv, agySessionId } from "./local-agent-agy.ts";
import { createLocalAgentActivityProvider } from "./local-agent-activity.ts";
import { createLocalAgentConfigurationProvider } from "./local-agent-configuration.ts";
import { localAgentOccupantId } from "./local-agent-occupant.ts";
import { createLocalAgentTeamsProvider } from "./local-agent-teams.ts";

const SESSION = "434a295d-b277-43f9-942c-8899d25c25c8";
const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

async function createAgyFixture(nowMs: number) {
  const home = await mkdtemp(join(tmpdir(), "mausbot-agy-team-"));
  folders.push(home);
  const project = join(home, "workspace", "OpenMausBot");
  const agyHome = join(home, ".gemini", "antigravity-cli");
  const transcriptDir = join(agyHome, "brain", SESSION, ".system_generated", "logs");
  await mkdir(join(project, ".agents", "team", "roles"), { recursive: true });
  await mkdir(transcriptDir, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "Read `.agents/team/playbook.md` and `.agents/team/roles/`.\n");
  await writeFile(join(project, ".agents", "team", "playbook.md"), [
    "| Herdr name | Role | Observed runtime | Observed model | Observed effort | Context requested at launch | Role file |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| mausbot-review | Reviewer One | agy | gemini-4-neon | high | 1,048,576 | [reviewer](roles/reviewer.md) |",
  ].join("\n") + "\n");
  await writeFile(join(project, ".agents", "team", "roles", "reviewer.md"), "---\nid: reviewer\nname: MausBot Reviewer One\n---\n# Reviewer\n");
  await writeFile(join(agyHome, "settings.json"), JSON.stringify({
    model: "Gemini 4 Neon (1M / High)",
    modelProvider: "gemini",
    customModelsConfig: {
      customModels: {
        "gemini-4-neon-1m": {
          maxTokens: 1048576,
          modelName: "gemini-api://127.0.0.1:7024/models/gemini-4-neon",
          label: "Gemini 4 Neon (1M / High)",
        },
      },
    },
  }));
  const db = new DatabaseSync(join(agyHome, "conversation_summaries.db"));
  try {
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)");
    db.prepare("INSERT INTO conversation_summaries VALUES (?, ?)").run(SESSION, JSON.stringify([pathToFileURL(project).href]));
  } finally {
    db.close();
  }
  const t1 = new Date(nowMs - 60_000).toISOString();
  const t2 = new Date(nowMs - 30_000).toISOString();
  await writeFile(join(transcriptDir, "transcript.jsonl"), [
    JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: t1, content: "<USER_REQUEST>\nReview PR #1218 at exact head.\n</USER_REQUEST>" }),
    JSON.stringify({
      step_index: 1, type: "PLANNER_RESPONSE", created_at: t2, model: "MODEL_GOOGLE_GEMINI_INTERNAL_BYOM",
      input_tokens: 15_000, cache_read_tokens: 20_000, output_tokens: 1_000,
      tool_calls: [{ name: "read_file", args: { Path: "server/local-agent-teams.ts" } }],
      content: "READY: mausbot-review (agy / Gemini 4 Neon High 1M)",
    }),
  ].join("\n") + "\n");
  return { home, project, agyHome };
}

describe("Antigravity CLI (agy) support in Agent Team", () => {
  it("parses herdr:antigravity_cli session identity and --model argv", () => {
    expect(agySessionId({
      agent: "agy",
      agent_session: { agent: "agy", kind: "id", source: "herdr:antigravity_cli", value: SESSION.toUpperCase() },
    })).toBe(SESSION);
    expect(agySessionId({
      agent: "agy",
      agent_session: { agent: "agy", kind: "id", source: "other:agy", value: SESSION },
    })).toBeNull();
    expect(agyModelFromArgv(["antigravity", "--model", "gemini-4-neon-1m", "--dangerously-skip-permissions"])).toBe("gemini-4-neon-1m");
    expect(agyModelFromArgv(["agy", "--model=gemini-4-neon-high"])).toBe("gemini-4-neon-high");
  });

  it("verifies agy member identity, role, model, effort, 1M context, tokens, cost, configuration, and activity", async () => {
    const nowMs = Date.UTC(2026, 10, 25, 3, 30);
    const { home, project } = await createAgyFixture(nowMs);
    const seat = {
      pane_id: "w6:p5",
      workspace_id: "w6",
      name: "mausbot-review",
      agent: "agy",
      agent_status: "idle",
      cwd: project,
      terminal_id: "term_agy_review",
      agent_session: { agent: "agy", kind: "id", source: "herdr:antigravity_cli", value: SESSION },
    };
    const run = async (args: readonly string[]) => {
      if (args.includes("workspace")) {
        return JSON.stringify({ result: { workspaces: [{ workspace_id: "w6", label: "mymausbot" }] } });
      }
      if (args.includes("process-info")) {
        return JSON.stringify({
          result: {
            process_info: {
              pane_id: "w6:p5",
              foreground_processes: [{ argv: ["antigravity", "--model", "gemini-4-neon-1m"] }],
            },
          },
        });
      }
      return JSON.stringify({ result: { agents: [seat] } });
    };

    const teams = createLocalAgentTeamsProvider({ home, codexHome: join(home, ".codex"), run, now: () => nowMs });
    const snapshot = await teams.get();
    const team = snapshot.teams[0]!;
    const member = team.agents[0]!;
    expect(member).toMatchObject({
      id: "w6:p5",
      name: "mausbot-review",
      kind: "agy",
      role: "Reviewer One",
      model: "gemini-4-neon",
      reasoningEffort: "high",
      contextUsed: 35_000,
      contextWindow: 1_048_576,
      state: "idle",
      taskHint: "Review PR #1218 at exact head.",
      messagePreview: "READY: mausbot-review (agy / Gemini 4 Neon High 1M)",
    });
    expect(member.tokenUsage24h).toMatchObject({ coverage: "partial", knownTokens: 36_000, estimatedCost: { coverage: "partial" } });
    expect(member.tokenUsage24h!.estimatedCost.usd).toBeGreaterThan(0);
    expect(team.tokenUsage24h).toEqual({ coverage: "partial", knownTokens: 36_000 });

    const config = createLocalAgentConfigurationProvider({ home, run });
    const cfg = await config.getAgent("w6:p5");
    expect(cfg.occupantId).toBe(localAgentOccupantId(seat, "w6:p5"));
    expect(cfg.agent).toMatchObject({ status: "ready", markdown: expect.stringContaining("# Reviewer") });

    const activity = createLocalAgentActivityProvider({ home, codexHome: join(home, ".codex"), run, now: () => nowMs });
    const recent = await activity.get("w6:p5");
    expect(recent.status).toBe("ready");
    expect(recent.events.map((e) => [e.kind, e.tool, e.text])).toEqual([
      ["user", null, "Review PR #1218 at exact head."],
      ["tool-call", "read_file", "Path: [path]"],
      ["assistant", null, "READY: mausbot-review (agy / Gemini 4 Neon High 1M)"],
    ]);
    const paged = await activity.get("w6:p5", { occupantId: cfg.occupantId! });
    expect(paged.status).toBe("ready");
    expect(paged.events).toHaveLength(3);
  });
});
