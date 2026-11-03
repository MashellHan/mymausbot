import type { LocalAgentTeamsResponse } from "../../shared/local-dashboard.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createLocalDashboardRoutes(agents: { get(): Promise<LocalAgentTeamsResponse> }): RouteHandler {
  return async ({ req, res, url, path, method, auth, json }) => {
    if (path !== "/api/local-dashboard/agents" || method !== "GET") return PASS;
    res.setHeader("cache-control", "private, no-store");
    const peer = req.socket.remoteAddress;
    if (auth.kind !== "loopback" || auth.trust === "service" || auth.companionDevice || !auth.scopes.includes("admin") ||
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer || "")) {
      return json(res, 403, { error: "local owner only" });
    }
    if (url.search) return json(res, 400, { error: "query parameters are not supported" });
    return json(res, 200, await agents.get());
  };
}
