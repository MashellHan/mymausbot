import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { createMiniAppRoutes, createMiniAppsInternalRoutes } from "./mini-apps.ts";

it("rejects local Mini App writes before reading a write-disallowed turn", async () => {
  const deps = {
    localEnabled: () => true,
    bots: () => [{ id: "producer", name: "Producer" }],
  } as unknown as Parameters<typeof createMiniAppsInternalRoutes>[0];
  const route = createMiniAppsInternalRoutes(deps);
  const response = {} as ServerResponse;
  const json = vi.fn();
  const readBody = vi.fn(async () => ({}));
  const requireActive = vi.fn();
  const writeAllowed = vi.fn(() => false);

  for (const path of ["/api/internal/mini-apps/publish", "/api/internal/mini-apps/report"]) {
    json.mockClear();
    await route({ method: "POST", path, res: response, json, botId: "producer", threadId: "turn",
      readBody, requireActive, writeAllowed });
    expect(json).toHaveBeenCalledWith(response, 403, { error: "This turn may only read Mini Apps." });
  }
  expect(requireActive).toHaveBeenCalledTimes(2);
  expect(writeAllowed).toHaveBeenCalledTimes(2);
  expect(readBody).not.toHaveBeenCalled();
});

it("publishes a metadata-only app without promoting the bot's Data", async () => {
  const publish = vi.fn(async () => ({ app: { id: "installed" }, replayed: false }));
  const promoteForBot = vi.fn(async () => { throw new Error("unrelated Data is unavailable"); });
  const deps = { localEnabled: () => true, bots: () => [{ id: "producer", name: "Producer" }],
    apps: { publish }, data: { promoteForBot } } as unknown as Parameters<typeof createMiniAppsInternalRoutes>[0];
  const route = createMiniAppsInternalRoutes(deps);
  const response = {} as ServerResponse;
  const json = vi.fn();
  const publication = { requestKey: "metadata", expectedRevision: 0, slug: "dashboard", title: "Dashboard",
    description: "Synthetic", html: "<p>Fallback</p>", bindings: [] };
  await route({ method: "POST", path: "/api/internal/mini-apps/publish", res: response, json,
    botId: "producer", threadId: "turn", readBody: async () => ({ publication }), requireActive: () => undefined,
    writeAllowed: () => true });
  expect(json).toHaveBeenCalledWith(response, 200, { app: { id: "installed" }, replayed: false });
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ botId: "producer" }), publication, undefined);
  expect(promoteForBot).not.toHaveBeenCalled();
  await route({ method: "POST", path: "/api/internal/mini-apps/publish", res: response, json,
    botId: "producer", threadId: "turn", readBody: async () => ({ publication: { ...publication,
      requestKey: "bot-label", shippedTemplateKind: "bookkeeping" } }), requireActive: () => undefined, writeAllowed: () => true });
  expect(json).toHaveBeenLastCalledWith(response, 403, { error: "Only the workspace owner can identify a shipped template." });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(promoteForBot).not.toHaveBeenCalled();
});

it("keeps app-scoped dashboard reads behind the existing local owner gate", async () => {
  const dashboardRead = vi.fn(async () => ({ appId: "fixture", revision: 1, resource: "teams", snapshot: {} }));
  const deps = { localEnabled: () => true, apps: { dashboardRead } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const route = createMiniAppRoutes(deps);
  const json = vi.fn();
  const path = "/api/mini-apps/11111111-1111-4111-8111-111111111111/dashboard";
  const readBody = vi.fn(async () => ({ resource: "teams", expectedRevision: 1 }));
  const call = (auth: RequestAuth, peer = "127.0.0.1") => {
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = path;
    Object.defineProperty(req.socket, "remoteAddress", { value: peer, configurable: true });
    return route({ method: "POST", path, url: new URL(`http://127.0.0.1${path}`),
      req, res: new ServerResponse(req), auth, json, readBody });
  };
  const denied: Array<[RequestAuth, string]> = [
    [{ kind: "session", via: "bearer", scopes: ["admin"], session: { id: "fixture", tokenHash: "0".repeat(64),
      label: "Fixture phone", scopes: ["admin"], createdAt: 1, lastSeenAt: 1, expiresAt: 2 } }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"], trust: "service" }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"], companionDevice: "phone" }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"] }, "203.0.113.8"],
  ];
  for (const [auth, peer] of denied) await call(auth, peer);
  expect(json).toHaveBeenCalledTimes(4);
  expect(json.mock.calls.every(([, status]) => status === 403)).toBe(true);
  expect(readBody).not.toHaveBeenCalled();
  expect(dashboardRead).not.toHaveBeenCalled();
  await call({ kind: "loopback", scopes: ["admin"] });
  expect(dashboardRead).toHaveBeenCalledWith(expect.objectContaining({ writeAllowed: true }),
    "11111111-1111-4111-8111-111111111111", { resource: "teams", expectedRevision: 1 });
});
