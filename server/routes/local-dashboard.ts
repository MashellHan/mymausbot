import type { LocalAgentActivityResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "../../shared/local-dashboard.ts";
import { createLocalAgentActivityProvider } from "../local-agent-activity.ts";
import { createLocalAgentTeamsProvider } from "../local-agent-teams.ts";
import { createLocalUsageProvider } from "../local-usage.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LocalDashboardProviders {
  agents: { get(): Promise<LocalAgentTeamsResponse> };
  activity: { get(agentId: string): Promise<LocalAgentActivityResponse> };
  usage: { get(): Promise<LocalUsageResponse> };
}

export function createLocalDashboardRoutes(providers: LocalDashboardProviders): RouteHandler {
  return async ({ req, res, url, path, method, auth, json }) => {
    const activity = /^\/api\/local-dashboard\/agents\/(w\d+(?::|%3A)p\d+)\/activity$/i.exec(path);
    if (method !== "GET" || (!["/api/local-dashboard/agents", "/api/local-dashboard/usage"].includes(path) && !activity)) return PASS;
    res.setHeader("cache-control", "private, no-store");
    const peer = req.socket.remoteAddress;
    if (auth.kind !== "loopback" || auth.trust === "service" || auth.companionDevice || !auth.scopes.includes("admin") ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer || "")) {
      return json(res, 403, { error: "local owner only" });
    }
    if (url.search) return json(res, 400, { error: "query parameters are not supported" });
    if (activity) return json(res, 200, await providers.activity.get(activity[1]!.replace(/%3A/i, ":")));
    return json(res, 200, await (path === "/api/local-dashboard/agents" ? providers.agents.get() : providers.usage.get()));
  };
}

export const localDashboardProviders: LocalDashboardProviders = {
  agents: createLocalAgentTeamsProvider(),
  activity: createLocalAgentActivityProvider(),
  usage: createLocalUsageProvider(),
};
export const localDashboardRoutes = createLocalDashboardRoutes(localDashboardProviders);
