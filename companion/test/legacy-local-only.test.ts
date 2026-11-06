import { randomBytes } from "node:crypto";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server) => new Promise<void>((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

it("keeps a legacy phone's direct route while retiring its hosted bearer and stream", async () => {
  let routes: "any" | "local" = "any";
  const streams = new Set<ServerResponse>();
  const harness = createServer((req, res) => {
    if (req.url === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      streams.add(res);
      res.once("close", () => streams.delete(res));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ app: "openmausbot" }));
  });
  const harnessPort = await listen(harness);
  const proxy = createProxyHandler({
    harnessPort,
    authenticate: (token) => token === "legacy-token" ? { id: "legacy", routes, cloudDesktopAccess: true, browserControlAccess: false } : null,
    redeem: () => ({ error: "not used" }),
    serverName: () => "Fixture",
    endpoints: () => [{ kind: "hosted", priority: 0, url: "https://retained.example.test" }],
  });
  const hosted = createServer((req, res) => proxy(req, res, "origin"));
  hosted.on("upgrade", (req, socket, head) => proxy.upgrade(req, socket, head, "origin"));
  const direct = createServer((req, res) => proxy(req, res, "lan"));
  const hostedPort = await listen(hosted);
  const directPort = await listen(direct);
  const headers = { authorization: "Bearer legacy-token" };
  const hostedAbort = new AbortController();
  const directAbort = new AbortController();
  try {
    const hostedStream = await fetch(`http://127.0.0.1:${hostedPort}/api/events`, { headers, signal: hostedAbort.signal });
    const directStream = await fetch(`http://127.0.0.1:${directPort}/api/events`, { headers, signal: directAbort.signal });
    expect(hostedStream.status).toBe(200);
    expect(directStream.status).toBe(200);
    const hostedReader = hostedStream.body!.getReader();
    const directReader = directStream.body!.getReader();

    routes = "local";
    proxy.closeHostedDevice("legacy");
    const ended = await Promise.race([
      hostedReader.read().then(({ done }) => done, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    expect(ended).toBe(true);
    expect((await fetch(`http://127.0.0.1:${hostedPort}/api/health`, { headers })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${directPort}/api/health`, { headers })).status).toBe(200);
    const endpoints = await (await fetch(`http://127.0.0.1:${directPort}/api/companion/endpoints`, { headers })).json();
    expect(endpoints.endpoints).toEqual([{ kind: "hosted", priority: 0, url: "https://retained.example.test" }]);

    const upgrade = await new Promise<number>((resolve, reject) => {
      const req = request(`http://127.0.0.1:${hostedPort}/vps-viewer/fixture/websockify`, { headers: {
        ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"),
      } });
      req.once("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.once("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
      req.once("error", reject);
      req.end();
    });
    expect(upgrade).toBe(403);

    for (const stream of streams) stream.write('data: {"ok":true}\n\n');
    expect((await directReader.read()).done).toBe(false);
    routes = "any";
    expect((await fetch(`http://127.0.0.1:${hostedPort}/api/health`, { headers })).status).toBe(200);
  } finally {
    hostedAbort.abort();
    directAbort.abort();
    for (const stream of streams) stream.destroy();
    await Promise.all([close(hosted), close(direct), close(harness)]);
  }
}, 15_000);
