import { describe, expect, it } from "vitest";

import type { LocalAgentActivityResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "../../shared/local-dashboard.ts";
import type { RouteContext } from "./table.ts";
import { PASS } from "./table.ts";
import { createLocalDashboardRoutes } from "./local-dashboard.ts";

const snapshot: LocalAgentTeamsResponse = { status: "ready", updatedAt: 1000, teamCount: 0, teams: [] };
const activitySnapshot: LocalAgentActivityResponse = { agentId: "w6:p1", status: "ready", updatedAt: 1000, truncated: false, events: [] };
const usageSnapshot: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
  sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };

function route() {
  let reads = 0;
  const handler = createLocalDashboardRoutes({
    agents: { get: async () => { reads++; return snapshot; } },
    activity: { get: async (agentId) => { reads++; return { ...activitySnapshot, agentId }; } },
    usage: { get: async () => { reads++; return usageSnapshot; } },
  });
  const request = async ({ auth = { kind: "loopback", scopes: ["admin"] }, peer = "127.0.0.1", path = "/api/local-dashboard/agents", method = "GET", search = "" }: {
    auth?: unknown; peer?: string; path?: string; method?: string; search?: string;
  } = {}) => {
    const replies: Array<{ status: number; body: unknown }> = [];
    const headers: Record<string, string> = {};
    const out = await handler({
      auth, path, method, url: new URL(`http://127.0.0.1${path}${search}`),
      req: { socket: { remoteAddress: peer } },
      res: { setHeader: (name: string, value: string) => { headers[name] = value; } },
      json: (_res: unknown, status: number, body: unknown) => { replies.push({ status, body }); },
    } as RouteContext);
    return { out, replies, headers, reads };
  };
  return request;
}

describe("GET /api/local-dashboard/agents", () => {
  it("serves only the local owner and does not accept query parameters", async () => {
    const request = route();
    expect(await request()).toMatchObject({ replies: [{ status: 200, body: snapshot }], reads: 1, headers: { "cache-control": "private, no-store" } });
    expect(await request({ path: "/api/local-dashboard/usage" })).toMatchObject({ replies: [{ status: 200, body: usageSnapshot }], reads: 2 });
    expect(await request({ path: "/api/local-dashboard/agents/w6%3Ap1/activity" })).toMatchObject({ replies: [{ status: 200, body: activitySnapshot }], reads: 3 });
    expect(await request({ path: "/api/local-dashboard/agents/w6:p1/activity", search: "?path=/private" })).toMatchObject({ replies: [{ status: 400 }], reads: 3 });
    expect(await request({ search: "?path=/private" })).toMatchObject({ replies: [{ status: 400 }], reads: 3 });
    expect((await request({ path: "/api/local-dashboard/agents/../activity" })).out).toBe(PASS);
    expect((await request({ method: "POST" })).out).toBe(PASS);
  });

  it.each([
    [{ kind: "session", scopes: ["admin"] }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["client"] }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"], trust: "service" }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"], companionDevice: "phone" }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"] }, "203.0.113.8"],
  ])("rejects paired, non-owner and remote callers before reading the host", async (auth, peer) => {
    for (const path of ["/api/local-dashboard/agents", "/api/local-dashboard/usage", "/api/local-dashboard/agents/w6:p1/activity"]) {
      const result = await route()({ auth, peer, path });
      expect(result).toMatchObject({ replies: [{ status: 403, body: { error: "local owner only" } }], reads: 0 });
    }
  });
});
