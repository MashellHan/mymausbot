import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LocalAgentActivityResponse, LocalAgentTeamsResponse } from "../shared/local-dashboard.ts";
import type { Bot } from "../src/state/store.tsx";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const sample: LocalAgentTeamsResponse = {
  status: "ready", updatedAt: Date.UTC(2026, 10, 3, 8, 30), teamCount: 2,
  teams: [
    { id: "w6", name: "Atlas Studio", agentCount: 3, activeAgentCount: 1, agents: [
      { id: "w6:p1", name: "An intentionally long synthetic agent name for narrow layout checks", kind: "codex", role: "Lead", model: "a-very-long-synthetic-model-identifier-for-wrapping", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "working", taskHint: "Draft a sample release plan with enough words to fill two lines in a narrow panel. This text is invented for visual checks." },
      { id: "w6:p2", name: "Mira", kind: "codex", role: null, model: null, reasoningEffort: null, contextUsed: null, contextWindow: null, state: "blocked", taskHint: null },
      { id: "w6:p3", name: "Pine", kind: "codex", role: "Reviewer", model: "sample-model-b", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "idle", taskHint: "Review sample cards" },
    ] },
    { id: "w8", name: "Maple Ops", agentCount: 2, activeAgentCount: 0, agents: [
      { id: "w8:p1", name: "Lark", kind: "codex", role: "Developer", model: "sample-model-c", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "done", taskHint: "Prepare synthetic data" },
      { id: "w8:p2", name: "Sage", kind: "codex", role: "Designer", model: "sample-model-d", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "unknown", taskHint: null },
    ] },
  ],
};
const many: LocalAgentTeamsResponse = { ...sample, teamCount: 15, teams: [
  ...sample.teams,
  ...Array.from({ length: 13 }, (_, index) => ({
    id: `sample-extra-${index}`, name: `Sample Office ${index + 3}`, agentCount: 0, activeAgentCount: 0, agents: [],
  })),
] };
let liveSample = sample;
let activityRevision = 0;

function activityFor(agentId: string, scenario: string | null): LocalAgentActivityResponse {
  const status = scenario === "tools" ? "ready" : scenario === "unavailable" || scenario === "unsupported" || scenario === "stale" ? scenario
    : agentId === "w6:p2" ? "unavailable" : agentId === "w6:p3" ? "unsupported" : agentId === "w8:p1" ? "stale" : "ready";
  const tools: LocalAgentActivityResponse["events"] = Array.from({ length: 70 }, (_, index) => ({ id: `e${index + 3}`, at: Date.UTC(2026, 10, 5, 1, 2 + index),
    kind: index % 2 === 0 ? "tool-call" as const : "tool-result" as const, tool: "functions.exec", text: `Synthetic tool step ${index + 1}; [path] hidden.` }));
  const events: LocalAgentActivityResponse["events"] = status === "unavailable" || status === "unsupported" ? [] : scenario === "tools" ? tools : [
    { id: "e1", at: Date.UTC(2026, 10, 5, 1, 0), kind: "user", tool: null, text: "Review the synthetic release plan. " + "Long sample content. ".repeat(18) },
    { id: "e2", at: Date.UTC(2026, 10, 5, 1, 1), kind: "assistant", tool: null, text: "I am checking the sample now." },
    ...tools,
    { id: "e73", at: Date.UTC(2026, 10, 5, 2, 12), kind: "assistant", tool: null,
      text: activityRevision ? "New synthetic assistant update after polling." : "Initial synthetic assistant update." },
  ];
  return { agentId, status, updatedAt: status === "unavailable" || status === "unsupported" ? null : sample.updatedAt! + activityRevision * 2000,
    truncated: scenario !== "tools" && events.length > 0, events };
}

const bot = {
  id: "fixture-bot", threadId: "fixture-thread", name: "Sample assistant", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, computer: "off", messages: [],
  modelSelection: { instanceId: "fixture-engine", model: "fixture-model" },
  tasks: [{ threadId: "fixture-thread", title: "Sample thread", createdAt: 1, approvalMode: "ask" }],
} as Bot;
const server = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url?.includes("/computer/control")) res.end(JSON.stringify({ held: false, helpReason: null }));
  else res.end("{}");
});
await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
let preview: MountedPreview | undefined;
try {
  preview = await mountPreview({ info: { url: `http://127.0.0.1:${address.port}` } }, {
    entry: "/scripts/testing/agent-team-preview.tsx", route: "/__agent-team.html", title: "Isolated Agent Team panel",
    extraRoutes: [
      { path: "/__agent-team-update", method: "POST", handler: (req, res) => {
        if (req.url?.includes("reset=1")) liveSample = sample;
        else if (req.url?.includes("remove=1")) liveSample = { ...sample, updatedAt: sample.updatedAt! + 2000, teamCount: 1, teams: [sample.teams[0]!] };
        else liveSample = { ...sample, updatedAt: sample.updatedAt! + 2000,
          teams: sample.teams.map((team) => team.id === "w6" ? { ...team, activeAgentCount: 0,
            agents: team.agents.map((agent) => agent.id === "w6:p1" ? { ...agent, state: "done", reasoningEffort: "max", contextUsed: 64_000,
              taskHint: "Only the newest synthetic instruction remains visible." } : agent) } : team) };
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ updated: true }));
      } },
      { path: "/__agent-activity-update", method: "POST", handler: (_req, res) => {
        activityRevision++;
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ updated: true }));
      } },
      { path: "/__agent-team-bot", handler: (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(bot));
      } },
      { path: "/api/local-dashboard/agents", handler: (req, res) => {
        const scenario = new URL(req.headers.referer ?? "http://127.0.0.1/").searchParams.get("scenario");
        const data = scenario === "unavailable" ? { status: "unavailable", updatedAt: null, teamCount: null, teams: [] }
          : scenario === "empty" ? { status: "ready", updatedAt: sample.updatedAt, teamCount: 0, teams: [] }
          : scenario === "stale" ? { ...sample, status: "stale" } : scenario === "live" ? liveSample
            : scenario === "one" ? { ...sample, teamCount: 1, teams: [sample.teams[0]!] }
              : scenario === "many" ? many : sample;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(data));
      } },
      { path: /^\/api\/local-dashboard\/teams\/(w\d+)\/rules$/, handler: (_req, res, match) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(match![1] === "w6" ? { teamId: "w6", status: "ready", markdown: "# Synthetic playbook.md\nTeam guidance for this isolated fixture." }
          : { teamId: match![1], status: "missing", markdown: null }));
      } },
      { path: /^\/api\/local-dashboard\/agents\/(w\d+(?::|%3A)p[0-9a-z]+)\/configuration$/i, handler: (_req, res, match) => {
        const agentId = decodeURIComponent(match![1]!);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ agentId, teamId: agentId.split(":")[0], occupantId: "o1111111111111111",
          agent: { status: "ready", markdown: "# Synthetic Agent instructions\nThis text is fixture-only.\n[local file](file:///private/fixture)" },
          skillReferences: "verified", skills: [
            { id: "s1111111111111111", name: "herdr", association: "team", loadedState: "unknown" },
            { id: "s2222222222222222", name: "impeccable", association: "agent", loadedState: "unknown" },
          ] }));
      } },
      { path: /^\/api\/local-dashboard\/agents\/(w\d+(?::|%3A)p[0-9a-z]+)\/skills\/(s[0-9a-f]{16})$/i, handler: (_req, res, match) => {
        const agentId = decodeURIComponent(match![1]!);
        const skillId = match![2]!;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ agentId, teamId: agentId.split(":")[0], occupantId: "o1111111111111111", skillId,
          status: "ready", markdown: `# Synthetic ${skillId === "s1111111111111111" ? "Herdr" : "Impeccable"} SKILL.md\nFixture-only skill content.` }));
      } },
      { path: /^\/api\/local-dashboard\/agents\/([^/]+)\/activity$/, handler: (req, res, match) => {
        const scenario = new URL(req.headers.referer ?? "http://127.0.0.1/").searchParams.get("activity");
        const id = decodeURIComponent(match![1]!);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(activityFor(id, scenario)));
      } },
    ],
  });
  console.log(JSON.stringify({ previewUrl: preview.previewUrl + "?mode=simple&width=400&scenario=ready&skin=midnight", fixture: "synthetic Agent Team data only" }));
  await parkUntilSignal();
} finally {
  await preview?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
