import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LocalAgentTeamsResponse } from "../shared/local-dashboard.ts";
import type { Bot } from "../src/state/store.tsx";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const sample: LocalAgentTeamsResponse = {
  status: "ready", updatedAt: Date.UTC(2026, 10, 3, 8, 30), teamCount: 2,
  teams: [
    { id: "sample-a", name: "Atlas Studio", agentCount: 3, agents: [
      { id: "a1", name: "An intentionally long synthetic agent name for narrow layout checks", kind: "codex", role: "Lead", model: "a-very-long-synthetic-model-identifier-for-wrapping", state: "working", taskHint: "Draft a sample release plan with enough words to fill two lines in a narrow panel. This text is invented for visual checks." },
      { id: "a2", name: "Mira", kind: "codex", role: null, model: null, state: "blocked", taskHint: null },
      { id: "a3", name: "Pine", kind: "codex", role: "Reviewer", model: "sample-model-b", state: "idle", taskHint: "Review sample cards" },
    ] },
    { id: "sample-b", name: "Maple Ops", agentCount: 2, agents: [
      { id: "b1", name: "Lark", kind: "codex", role: "Developer", model: "sample-model-c", state: "done", taskHint: "Prepare synthetic data" },
      { id: "b2", name: "Sage", kind: "codex", role: "Designer", model: "sample-model-d", state: "unknown", taskHint: null },
    ] },
  ],
};

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
      { path: "/__agent-team-bot", handler: (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(bot));
      } },
      { path: "/api/local-dashboard/agents", handler: (req, res) => {
        const scenario = new URL(req.headers.referer ?? "http://127.0.0.1/").searchParams.get("scenario");
        const data = scenario === "unavailable" ? { status: "unavailable", updatedAt: null, teamCount: null, teams: [] }
          : scenario === "empty" ? { status: "ready", updatedAt: sample.updatedAt, teamCount: 0, teams: [] }
          : scenario === "stale" ? { ...sample, status: "stale" } : sample;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(data));
      } },
    ],
  });
  console.log(JSON.stringify({ previewUrl: preview.previewUrl + "?mode=simple&width=400&scenario=ready&skin=midnight", fixture: "synthetic Agent Team data only" }));
  await parkUntilSignal();
} finally {
  await preview?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
