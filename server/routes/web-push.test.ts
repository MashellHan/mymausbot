import { createECDH } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  WEB_PUSH_SUBSCRIPTION_ROUTE,
  WEB_PUSH_TEST_ROUTE,
  WEB_PUSH_VAPID_KEY_ROUTE,
} from "../../shared/web-push.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { WebPushService, type WebPushTransportResponse } from "../web-push.ts";
import { dispatchRoutes } from "./table.ts";
import { createWebPushRoutes } from "./web-push.ts";

function makeSubscriptionBody(endpoint = "https://web.push.apple.com/QMx/token-1") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey(undefined, "uncompressed").toString("base64url"),
      auth: Buffer.alloc(16, 0x22).toString("base64url"),
    },
    deviceLabel: "iPhone PWA",
    preferences: { enabled: true, liveActivities: true },
  };
}

const session = (id: string, cookieOnly = false): RequestAuth => ({
  kind: "session",
  via: "bearer",
  scopes: ["client"],
  session: { id, cookieOnly } as unknown as Extract<RequestAuth, { kind: "session" }>["session"],
});
const companion = (device: string): RequestAuth => ({
  kind: "loopback",
  scopes: ["admin", "client"],
  companionDevice: device,
});
const desktop: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
  await Promise.all(dirs.splice(0).map(removeTempDir));
});

async function setup(options: { enabled?: boolean; live?: boolean; response?: WebPushTransportResponse } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-web-push-routes-"));
  dirs.push(dir);
  const webPush = new WebPushService({
    dataDir: dir,
    enabled: () => options.enabled ?? true,
    log: () => {},
    lookup: async () => [{ address: "17.57.145.10", family: 4 }],
    transport: async () => options.response ?? { status: 201 },
  });
  let auth: RequestAuth = session("pwa-1");
  const routes = [createWebPushRoutes({ webPush, live: () => options.live ?? true })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req,
      res,
      url,
      path: url.pathname,
      method: req.method ?? "GET",
      auth,
      json,
      readBody,
    });
    if (!handled) json(res, 404, { error: "unhandled" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, contentType = "application/json") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": contentType },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return {
      status: response.status,
      cacheControl: response.headers.get("cache-control"),
      body: (await response.json()) as Record<string, unknown>,
    };
  };
  return { webPush, call, as: (next: RequestAuth) => { auth = next; } };
}

describe("Web Push routes", () => {
  it("returns public VAPID key and manages device-bound subscriptions without leaking private keys", async () => {
    const { call, as } = await setup();

    const vapid = await call("GET", WEB_PUSH_VAPID_KEY_ROUTE);
    expect(vapid.status).toBe(200);
    expect(vapid.cacheControl).toBe("no-store");
    expect(vapid.body).toEqual({ enabled: true, publicKey: expect.any(String) });

    const payload = makeSubscriptionBody();
    const put = await call("PUT", WEB_PUSH_SUBSCRIPTION_ROUTE, payload);
    expect(put.status).toBe(200);
    expect(put.body.subscription).toMatchObject({
      endpoint: payload.endpoint,
      endpointOrigin: "https://web.push.apple.com",
      deviceLabel: "iPhone PWA",
      hasKeys: true,
      preferences: { enabled: true, liveActivities: true },
    });
    const serialized = JSON.stringify(put.body);
    expect(serialized).not.toContain(payload.keys.p256dh);
    expect(serialized).not.toContain(payload.keys.auth);

    // Another device cannot read or delete pwa-1's subscription.
    as(session("pwa-2"));
    expect((await call("GET", WEB_PUSH_SUBSCRIPTION_ROUTE)).body.subscription).toBeNull();
    expect((await call("DELETE", WEB_PUSH_SUBSCRIPTION_ROUTE)).body.removed).toBe(0);

    // Original device still owns its subscription and can test & delete it.
    as(session("pwa-1"));
    expect((await call("POST", WEB_PUSH_TEST_ROUTE, {})).body).toEqual({ ok: true, sent: 1, failed: 0, pruned: 0 });
    expect((await call("DELETE", WEB_PUSH_SUBSCRIPTION_ROUTE)).body).toMatchObject({ removed: 1, subscription: null });
    expect((await call("POST", WEB_PUSH_TEST_ROUTE)).status).toBe(404);
  });

  it("enforces auth liveness, device ownership, schema validation, SSRF rules, and content types", async () => {
    const expired = await setup({ live: false });
    expect((await expired.call("GET", WEB_PUSH_VAPID_KEY_ROUTE)).status).toBe(401);

    const { call, as } = await setup();
    as(companion("phone-9"));
    expect((await call("PUT", WEB_PUSH_SUBSCRIPTION_ROUTE, makeSubscriptionBody())).status).toBe(200);

    for (const nonDevice of [desktop, session("cookie-only", true)]) {
      as(nonDevice);
      expect((await call("PUT", WEB_PUSH_SUBSCRIPTION_ROUTE, makeSubscriptionBody())).status).toBe(403);
      expect((await call("DELETE", WEB_PUSH_SUBSCRIPTION_ROUTE)).status).toBe(403);
      expect((await call("POST", WEB_PUSH_TEST_ROUTE)).status).toBe(403);
    }

    as(session("pwa-1"));
    expect((await call("PUT", WEB_PUSH_SUBSCRIPTION_ROUTE, "raw", "text/plain")).status).toBe(415);
    expect((await call("PUT", WEB_PUSH_SUBSCRIPTION_ROUTE, makeSubscriptionBody("http://web.push.apple.com/x"))).status).toBe(400);
    expect((await call("PUT", WEB_PUSH_SUBSCRIPTION_ROUTE, makeSubscriptionBody("https://127.0.0.1/x"))).status).toBe(400);
    expect((await call("POST", WEB_PUSH_SUBSCRIPTION_ROUTE)).status).toBe(405);
    expect((await call("POST", WEB_PUSH_VAPID_KEY_ROUTE)).status).toBe(405);
  });
});
