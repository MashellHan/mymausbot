import type { LocalAgentActivityResponse, LocalAgentConfigurationResponse, LocalAgentSkillDocumentResponse, LocalAgentTeamRulesResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "../../shared/local-dashboard.ts";
import { createLocalAgentActivityProvider } from "../local-agent-activity.ts";
import { createLocalAgentConfigurationProvider } from "../local-agent-configuration.ts";
import { createLocalAgentTeamsProvider } from "../local-agent-teams.ts";
import { createLocalUsageProvider } from "../local-usage.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface LocalDashboardProviders {
  agents: { get(): Promise<LocalAgentTeamsResponse> };
  activity: { get(agentId: string): Promise<LocalAgentActivityResponse> };
  configuration: {
    getAgent(agentId: string): Promise<LocalAgentConfigurationResponse>;
    getSkill(agentId: string, skillId: string): Promise<LocalAgentSkillDocumentResponse>;
    getTeamRules(teamId: string): Promise<LocalAgentTeamRulesResponse>;
  };
  usage: { get(): Promise<LocalUsageResponse> };
}

export function createLocalDashboardRoutes(providers: LocalDashboardProviders): RouteHandler {
  return async ({ req, res, url, path, method, auth, json }) => {
    const activity = /^\/api\/local-dashboard\/agents\/(w\d+(?::|%3A)p\d+)\/activity$/i.exec(path);
    const configuration = /^\/api\/local-dashboard\/agents\/(w\d+(?::|%3A)p[0-9a-z]+)\/configuration$/i.exec(path);
    const skill = /^\/api\/local-dashboard\/agents\/(w\d+(?::|%3A)p[0-9a-z]+)\/skills\/(s[0-9a-f]{16})$/i.exec(path);
    const teamRules = /^\/api\/local-dashboard\/teams\/(w\d+)\/rules$/.exec(path);
    if (method !== "GET" || (!["/api/local-dashboard/agents", "/api/local-dashboard/usage"].includes(path) && !activity && !configuration && !skill && !teamRules)) return PASS;
    res.setHeader("cache-control", "private, no-store");
    const peer = req.socket.remoteAddress;
    if (auth.kind !== "loopback" || auth.trust === "service" || auth.companionDevice || !auth.scopes.includes("admin") ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer || "")) {
      return json(res, 403, { error: "local owner only" });
    }
    if (url.search) return json(res, 400, { error: "query parameters are not supported" });
    if (activity) return json(res, 200, await providers.activity.get(activity[1]!.replace(/%3A/i, ":")));
    if (configuration) return json(res, 200, await providers.configuration.getAgent(configuration[1]!.replace(/%3A/i, ":")));
    if (skill) return json(res, 200, await providers.configuration.getSkill(skill[1]!.replace(/%3A/i, ":"), skill[2]!));
    if (teamRules) return json(res, 200, await providers.configuration.getTeamRules(teamRules[1]!));
    return json(res, 200, await (path === "/api/local-dashboard/agents" ? providers.agents.get() : providers.usage.get()));
  };
}

export const localDashboardProviders: LocalDashboardProviders = {
  agents: createLocalAgentTeamsProvider(),
  activity: createLocalAgentActivityProvider(),
  configuration: createLocalAgentConfigurationProvider(),
  usage: createLocalUsageProvider(),
};
export const localDashboardRoutes = createLocalDashboardRoutes(localDashboardProviders);
