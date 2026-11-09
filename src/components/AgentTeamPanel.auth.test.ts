// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalAgentTeamsResponse } from "../../shared/local-dashboard";

vi.mock("@/state/store", async () => {
  const { api, ApiError } = await import("@/state/api");
  return { api, ApiError };
});
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

const { AgentTeamPanel } = await import("./AgentTeamPanel");
const { sessionCheck, sessionEnded } = await import("@/lib/session-ended");

const ready: LocalAgentTeamsResponse = {
  status: "ready", updatedAt: Date.UTC(2026, 10, 3, 8), teamCount: 1,
  teams: [{ id: "sample-team", name: "Atlas Studio", agentCount: 1, activeAgentCount: 1, agents: [
    { id: "sample-pane", name: "Mira", kind: "codex", role: "Lead", model: "sample-model", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "working", taskHint: "Draft sample plan" },
  ] }],
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

it("clears the owner snapshot on a real API 401 even when session recheck is unreachable", async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  let agentReads = 0;
  const fetch = vi.fn(async (input: string) => {
    if (input === "/api/auth/session") throw new Error("offline");
    if (input !== "/api/local-dashboard/agents") throw new Error(`Unexpected request: ${input}`);
    agentReads++;
    return agentReads === 1
      ? new Response(JSON.stringify(ready), { status: 200, headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ error: "session expired" }), { status: 401, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(AgentTeamPanel)));
    expect(host.textContent).toContain("Atlas Studio");

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); await sessionCheck(); });
    expect(fetch).toHaveBeenCalledWith("/api/auth/session", expect.objectContaining({ credentials: "same-origin" }));
    expect(sessionEnded()).toBe(false);
    expect(host.textContent).toContain("— teams");
    expect(host.textContent).toContain("teams are unavailable");
    expect(host.textContent).not.toContain("Atlas Studio");
  } finally {
    await act(async () => root.unmount());
  }
});
