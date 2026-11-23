import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import type { PwaPairingPayload } from "../shared/pwa-bridge.ts";
import { json, readBody } from "./harness/http.ts";
import { PWA_BRIDGE_SUBPROTOCOL, isPwaBridgeRequest, pwaBridgePairingRefusal, startPwaBridge } from "./pwa-bridge.ts";
import { PWA_BRIDGE_CONFIG_FILE, loadPwaBridgeConfig } from "./pwa-bridge-config.ts";
import { resolveRequestAuth, type RequestAuth } from "./request-auth.ts";
import { createPwaBridgeRoutes } from "./routes/pwa-bridge.ts";
import { dispatchRoutes } from "./routes/table.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir } from "./testing/cleanup.ts";

interface MockRelayStream {
  headersPromise: Promise<{ status: number; headers: Record<string, string | string[]> }>;
  resolveHeaders: (head: { status: number; headers: Record<string, string | string[]> }) => void;
  chunks: Buffer[];
  eof: boolean;
  onData?: (chunk: Buffer) => void;
  onEnd?: () => void;
}

class MockBridgeRelay {
  readonly wss: WebSocketServer;
  readonly port: number;
  readonly url: string;
  readonly hellos: Array<{ hostId: string; token: string }> = [];
  readonly pings: number[] = [];
  ws: WebSocket | null = null;
  private readonly streams = new Map<string, MockRelayStream>();
  private readonly onConnectCallbacks: Array<() => void> = [];

  private constructor(wss: WebSocketServer, port: number) {
    this.wss = wss;
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    wss.on("connection", (socket) => {
      this.ws = socket;
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        if (frame.type === "hello") {
          this.hellos.push({ hostId: String(frame.hostId), token: String(frame.token) });
          for (const cb of this.onConnectCallbacks.splice(0)) cb();
        } else if (frame.type === "ping") {
          this.pings.push(Number(frame.ts));
          socket.send(JSON.stringify({ type: "pong", ts: frame.ts }));
        } else if (frame.type === "res.head") {
          const stream = this.streams.get(String(frame.streamId));
          stream?.resolveHeaders({
            status: Number(frame.status),
            headers: (frame.headers ?? {}) as Record<string, string | string[]>,
          });
        } else if (frame.type === "res.body") {
          const stream = this.streams.get(String(frame.streamId));
          if (!stream) return;
          const chunk = frame.chunkB64 ? Buffer.from(String(frame.chunkB64), "base64") : Buffer.alloc(0);
          if (chunk.length > 0) {
            stream.chunks.push(chunk);
            stream.onData?.(chunk);
          }
          if (frame.eof === true) {
            stream.eof = true;
            stream.onEnd?.();
            this.streams.delete(String(frame.streamId));
          }
        }
      });
      socket.on("close", () => {
        if (this.ws === socket) this.ws = null;
      });
    });
  }

  static async start(): Promise<MockBridgeRelay> {
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: (protocols) => (protocols.has(PWA_BRIDGE_SUBPROTOCOL) ? PWA_BRIDGE_SUBPROTOCOL : false),
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;
    return new MockBridgeRelay(wss, port);
  }

  async waitForHost(timeoutMs = 10_000): Promise<void> {
    if (this.hellos.length > 0 && this.ws?.readyState === 1) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for bridge hello")), timeoutMs);
      this.onConnectCallbacks.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request(input: {
    method: string;
    path: string;
    headers?: Record<string, string | string[]>;
    body?: string | Buffer;
    remoteAddr?: string;
    sendEmptyEof?: boolean;
  }): Promise<{ status: number; headers: Record<string, string | string[]>; bodyText: string; json: any }> {
    const stream = this.openStream(input);
    const head = await stream.head;
    const bodyBuf = await stream.body;
    const bodyText = bodyBuf.toString("utf8");
    let parsedJson: any = null;
    try {
      parsedJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsedJson = null;
    }
    return { status: head.status, headers: head.headers, bodyText, json: parsedJson };
  }

  openStream(input: {
    method: string;
    path: string;
    headers?: Record<string, string | string[]>;
    body?: string | Buffer;
    remoteAddr?: string;
    sendEmptyEof?: boolean;
  }): {
    streamId: string;
    head: Promise<{ status: number; headers: Record<string, string | string[]> }>;
    body: Promise<Buffer>;
    readUntil: (predicate: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
    cancel: () => void;
  } {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("bridge socket is not connected");
    const streamId = randomUUID();
    let resolveHeaders!: (head: { status: number; headers: Record<string, string | string[]> }) => void;
    const headersPromise = new Promise<{ status: number; headers: Record<string, string | string[]> }>((r) => {
      resolveHeaders = r;
    });
    const stream: MockRelayStream = {
      headersPromise,
      resolveHeaders,
      chunks: [],
      eof: false,
    };
    this.streams.set(streamId, stream);

    const bodyPromise = new Promise<Buffer>((resolve) => {
      if (stream.eof) {
        resolve(Buffer.concat(stream.chunks));
        return;
      }
      stream.onEnd = () => resolve(Buffer.concat(stream.chunks));
    });

    this.ws.send(JSON.stringify({
      type: "req.open",
      streamId,
      method: input.method,
      path: input.path,
      headers: input.headers ?? {},
      remoteAddr: input.remoteAddr ?? "203.0.113.42",
    }));

    if (input.body !== undefined) {
      const buf = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
      this.ws.send(JSON.stringify({
        type: "req.body",
        streamId,
        chunkB64: buf.toString("base64"),
        eof: true,
      }));
    } else if (input.sendEmptyEof) {
      this.ws.send(JSON.stringify({
        type: "req.body",
        streamId,
        chunkB64: "",
        eof: true,
      }));
    }

    return {
      streamId,
      head: headersPromise,
      body: bodyPromise,
      readUntil: (predicate, timeoutMs = 5_000) => {
        const current = Buffer.concat(stream.chunks).toString("utf8");
        if (predicate(current)) return Promise.resolve(current);
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timed out reading stream")), timeoutMs);
          stream.onData = () => {
            const text = Buffer.concat(stream.chunks).toString("utf8");
            if (predicate(text)) {
              clearTimeout(timer);
              resolve(text);
            }
          };
        });
      },
      cancel: () => {
        this.ws?.send(JSON.stringify({ type: "req.cancel", streamId }));
        this.streams.delete(streamId);
      },
    };
  }

  async close(): Promise<void> {
    this.ws?.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

describe("PWA bridge unit, config, and route enforcement", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  const relays: MockBridgeRelay[] = [];
  const bridges: Array<NonNullable<ReturnType<typeof startPwaBridge>>> = [];

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.stop();
    await Promise.all(relays.splice(0).map((r) => r.close()));
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
    await Promise.all(dirs.splice(0).map(removeTempDir));
  });

  it("masks secrets on GET/PUT, rotates secrets with 0600 persistence, enforces client scope, and respects managed policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwa-bridge-unit-"));
    dirs.push(dir);
    const sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
    const relay = await MockBridgeRelay.start();
    relays.push(relay);

    let policyRefusal: string | undefined;
    let bridgeRef: ReturnType<typeof startPwaBridge> = null;
    const routes = [createPwaBridgeRoutes({
      bridge: () => bridgeRef,
      dataDir: dir,
      sessions,
      managedRemoteAccessRefusal: () => policyRefusal,
    })];

    let currentAuth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const handled = await dispatchRoutes(routes, {
        req,
        res,
        url,
        path: url.pathname,
        method: req.method ?? "GET",
        auth: currentAuth,
        json,
        readBody,
      });
      if (!handled) json(res, 404, { error: "not found" });
    });
    servers.push(httpServer);
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const adminBase = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

    const seenSocketProps: Array<{
      remoteAddress: unknown;
      remoteFamily: unknown;
      host: unknown;
      xff: unknown;
      cookie: unknown;
      ombHeader: unknown;
      openmausbotHeader: unknown;
      isBridge: boolean;
      pairingRefusal: string | null;
      authStatus: number;
    }> = [];

    bridgeRef = startPwaBridge({
      dataDir: dir,
      managedRemoteAccessRefusal: () => policyRefusal,
      reconnectDelaysMs: [80, 160],
      jitterFactor: () => 0.5,
      handle: (req, res) => {
        const url = new URL(req.url ?? "/", "http://pwa-bridge.invalid");
        const gate = resolveRequestAuth(req, {
          sessions,
          cookieName: "omb_test_cookie",
          streamPath: "/api/events",
          url,
        });
        seenSocketProps.push({
          remoteAddress: req.socket.remoteAddress,
          remoteFamily: req.socket.remoteFamily,
          host: req.headers.host,
          xff: req.headers["x-forwarded-for"],
          cookie: req.headers.cookie,
          ombHeader: req.headers["x-omb-cloud-signature"],
          openmausbotHeader: req.headers["x-openmausbot-desktop-owner"],
          isBridge: isPwaBridgeRequest(req),
          pairingRefusal: pwaBridgePairingRefusal(req, "123456"),
          authStatus: gate.auth ? 200 : gate.status,
        });
        if (!gate.auth) return json(res, gate.status, { error: gate.error });
        return json(res, 200, { ok: true, scopes: gate.auth.scopes });
      },
    });
    bridges.push(bridgeRef!);

    const adminCall = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${adminBase}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };

    const initial = await adminCall("GET", "/api/pwa-bridge");
    expect(initial.status).toBe(200);
    expect(initial.body.config.enabled).toBe(false);
    expect(initial.body.config.hasBridgeSecret).toBe(false);
    expect("bridgeSecret" in initial.body.config).toBe(false);

    const rotated = await adminCall("POST", "/api/pwa-bridge/rotate-secret", {});
    expect(rotated.status).toBe(200);
    expect(rotated.body.bridgeSecret).toMatch(/^omb_bridge_/);
    expect(rotated.body.bridgeSecretSha256).toBe(createHash("sha256").update(rotated.body.bridgeSecret).digest("hex"));
    expect(rotated.body.config.hasBridgeSecret).toBe(true);
    expect("bridgeSecret" in rotated.body.config).toBe(false);

    if (process.platform !== "win32") {
      expect(statSync(join(dir, PWA_BRIDGE_CONFIG_FILE)).mode & 0o777).toBe(0o600);
    }

    const enabled = await adminCall("PUT", "/api/pwa-bridge", {
      enabled: true,
      relayUrl: relay.url,
      hostId: "mac-mini",
      pwaOrigin: "https://mausbot.mxhan.com",
      defaultBotId: "bot-acct",
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.config.enabled).toBe(true);
    expect("bridgeSecret" in enabled.body.config).toBe(false);
    expect(loadPwaBridgeConfig(dir).bridgeSecret).toBe(rotated.body.bridgeSecret);

    await relay.waitForHost();
    expect(relay.hellos[0]).toEqual({ hostId: "mac-mini", token: rotated.body.bridgeSecret });

    // Spoofed headers must be scrubbed/overwritten, socket has no remoteAddress/remoteFamily, and unauthenticated requests get 403.
    const unauthed = await relay.request({
      method: "GET",
      path: "/api/bots",
      remoteAddr: "198.51.100.77",
      headers: {
        host: "127.0.0.1:41999",
        cookie: "omb_test_cookie=forged",
        "x-forwarded-for": "127.0.0.1",
        "x-omb-cloud-signature": "forged",
        "x-openmausbot-desktop-owner": "forged",
      },
    });
    expect(unauthed.status).toBe(403);
    expect(seenSocketProps[0]).toEqual({
      remoteAddress: undefined,
      remoteFamily: undefined,
      host: "pwa-bridge.invalid",
      xff: "198.51.100.77",
      cookie: undefined,
      ombHeader: undefined,
      openmausbotHeader: undefined,
      isBridge: true,
      pairingRefusal: "pair a PWA with its pairing link",
      authStatus: 403,
    });

    // Blocked internal/admin routes fail at bridge allowlist with 403 before reaching handleRequest.
    const beforeCalls = seenSocketProps.length;
    for (const blocked of [
      { method: "GET", path: "/api/internal/status" },
      { method: "GET", path: "/api/local-computer" },
      { method: "GET", path: "/api/desktop-viewer/status" },
      { method: "GET", path: "/api/setup-import/grok" },
      { method: "GET", path: "/api/pwa-bridge" },
      { method: "POST", path: "/api/auth/pairing" },
    ]) {
      const res = await relay.request(blocked);
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("bridge_route_forbidden");
    }
    expect(seenSocketProps.length).toBe(beforeCalls);

    // Mint a PWA invite (never includes bridgeSecret) and verify client-scoped session cannot access /api/pwa-bridge.
    const invite = await adminCall("POST", "/api/pwa-bridge/invite", { label: "Test iPhone" });
    expect(invite.status).toBe(200);
    expect(invite.body.inviteUrl).toMatch(/^https:\/\/mausbot\.mxhan\.com\/#pair=/);
    const fragment = String(invite.body.inviteUrl).split("#pair=")[1]!;
    const payload = JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")) as PwaPairingPayload;
    expect(payload.relayUrl).toBe(relay.url);
    expect(payload.defaultBotId).toBe("bot-acct");
    expect(payload.credential).not.toBe(rotated.body.bridgeSecret);
    expect(invite.body.inviteUrl).not.toContain(rotated.body.bridgeSecret);

    currentAuth = {
      kind: "session",
      via: "bearer",
      scopes: ["client"],
      session: { id: "s1", cookieOnly: false } as any,
    };
    expect((await adminCall("GET", "/api/pwa-bridge")).status).toBe(403);
    expect((await adminCall("POST", "/api/pwa-bridge/rotate-secret", {})).status).toBe(403);

    // Managed remote-access policy refusal blocks both invite minting and inbound bridge requests.
    currentAuth = { kind: "loopback", scopes: ["admin", "client"] };
    policyRefusal = "Org Policy disables remote access.";
    const refusedInvite = await adminCall("POST", "/api/pwa-bridge/invite", {});
    expect(refusedInvite.status).toBe(403);
    expect(refusedInvite.body.code).toBe("managed_policy");

    const refusedBridgeReq = await relay.request({ method: "GET", path: "/api/bots" });
    expect(refusedBridgeReq.status).toBe(403);
    expect(refusedBridgeReq.json.code).toBe("managed_policy");
    policyRefusal = undefined;

    // Reconnect after socket drop.
    relay.ws?.terminate();
    await relay.waitForHost();
    expect(relay.hellos.length).toBe(2);

    sessions.close();
  });
});

describe("PWA bridge real handleRequest integration", () => {
  let relay: MockBridgeRelay;
  let fixture: VerificationServer | undefined;
  let base: string;
  let bridgeSecret: string;

  beforeAll(async () => {
    relay = await MockBridgeRelay.start();
    fixture = await launchVerificationServer({ ...process.env, OMB_DEV_TRUST_LOCAL_BROWSER: "1" });
    base = fixture.info.url;

    const rot = await fetch(`${base}/api/pwa-bridge/rotate-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const rotBody = (await rot.json()) as { bridgeSecret: string };
    bridgeSecret = rotBody.bridgeSecret;

    const put = await fetch(`${base}/api/pwa-bridge`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        relayUrl: relay.url,
        hostId: "mac-mini",
        pwaOrigin: "https://mausbot.mxhan.com",
      }),
    });
    expect(put.status).toBe(200);
    await relay.waitForHost(15_000);
    expect(relay.hellos[0]?.token).toBe(bridgeSecret);
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
    await relay?.close();
  });

  const admin = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("enforces proxied auth, scrubs spoofed headers, restricts pairing to PWA invites, dispatches messages, and cleans up SSE on req.cancel", async () => {
    // 1. Create a bot locally as admin.
    const createdBot = await admin("POST", "/api/bots", { name: "Accounting Bot" });
    expect(createdBot.status).toBe(201);
    const botId = String(createdBot.body.bot.id);

    // 2. Unauthenticated proxied read & write rejected with 403 (request-auth.ts:730).
    const unauthedRead = await relay.request({ method: "GET", path: "/api/bots" });
    expect(unauthedRead.status).toBe(403);

    const unauthedWrite = await relay.request({
      method: "POST",
      path: `/api/bots/${botId}/messages`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", sendId: randomUUID() }),
    });
    expect(unauthedWrite.status).toBe(403);

    // 3. Invalid Bearer rejected with 401.
    const badBearer = await relay.request({
      method: "GET",
      path: "/api/bots",
      headers: { authorization: "Bearer omb_sess_not_a_real_session" },
    });
    expect(badBearer.status).toBe(401);

    // 4. Spoofed cookie (even a valid session cookie), Host: 127.0.0.1, x-forwarded-for, and x-openmausbot-* are rejected (403).
    const browserInvite = await admin("POST", "/api/auth/pairing", { label: "Browser Test" });
    expect(browserInvite.status).toBe(200);
    const browserPairRes = await fetch(`${base}/api/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: browserInvite.body.credential, cookie: true, label: "Browser" }),
    });
    expect(browserPairRes.status).toBe(200);
    const setCookie = browserPairRes.headers.get("set-cookie") ?? "";
    const cookiePair = setCookie.split(";")[0] ?? "";
    expect(cookiePair).toContain("omb_session_");

    const spoofed = await relay.request({
      method: "GET",
      path: "/api/bots",
      headers: {
        host: "127.0.0.1",
        cookie: cookiePair,
        "x-forwarded-for": "127.0.0.1",
        "x-openmausbot-desktop-owner": "forged",
        "x-omb-internal": "1",
      },
    });
    expect(spoofed.status).toBe(403);

    // 5. Regular admin pairing invite & 6-digit code are refused on bridge POST /api/pair.
    const adminInvite = await admin("POST", "/api/auth/pairing", { scopes: ["admin", "client"], label: "Admin Phone" });
    expect(adminInvite.status).toBe(200);

    const codeRefused = await relay.request({
      method: "POST",
      path: "/api/pair",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: adminInvite.body.code, deviceName: "PWA" }),
    });
    expect(codeRefused.status).toBe(400);
    expect(codeRefused.json.code).toBe("pairing_qr_only");

    const adminInviteRefused = await relay.request({
      method: "POST",
      path: "/api/pair",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: adminInvite.body.credential, deviceName: "PWA" }),
    });
    expect(adminInviteRefused.status).toBe(401);
    expect(adminInviteRefused.json.code).toBe("pairing_code_wrong");

    // 6. PWA-bound invite succeeds over bridge POST /api/pair and issues a client-scoped session.
    const pwaInvite = await admin("POST", "/api/pwa-bridge/invite", {
      label: "iPhone PWA",
      defaultBotId: botId,
    });
    expect(pwaInvite.status).toBe(200);
    const payload = JSON.parse(
      Buffer.from(String(pwaInvite.body.inviteUrl).split("#pair=")[1]!, "base64url").toString("utf8"),
    ) as PwaPairingPayload;
    expect(payload.defaultBotId).toBe(botId);

    const pairRes = await relay.request({
      method: "POST",
      path: "/api/pair",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credential: payload.credential,
        deviceName: "iPhone Safari",
        pairRequestId: randomUUID(),
      }),
    });
    expect(pairRes.status).toBe(200);
    const token = String(pairRes.json.token);
    expect(token.startsWith("omb_sess_")).toBe(true);

    const sessionRes = await relay.request({
      method: "GET",
      path: "/api/auth/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.json.kind).toBe("session");
    expect(sessionRes.json.scopes).toEqual(["client"]);

    // 7. Admin-only and blocked internal routes are rejected (403) even with a valid client Bearer token.
    for (const blocked of [
      { method: "POST", path: "/api/auth/pairing", body: JSON.stringify({ scopes: ["client"] }) },
      { method: "GET", path: "/api/pwa-bridge" },
      { method: "PUT", path: "/api/config", body: JSON.stringify({}) },
      { method: "GET", path: "/api/internal/status" },
      { method: "GET", path: "/api/local-computer" },
      { method: "GET", path: "/api/desktop-viewer/status" },
      { method: "GET", path: "/api/setup-import/grok" },
    ]) {
      const res = await relay.request({
        method: blocked.method,
        path: blocked.path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(blocked.body ? { "content-type": "application/json" } : {}),
        },
        ...(blocked.body ? { body: blocked.body } : {}),
      });
      expect(res.status).toBe(403);
    }

    // 8. Client-scoped POST /api/bots/:id/messages over the bridge succeeds (202).
    const sendId = randomUUID();
    const sent = await relay.request({
      method: "POST",
      path: `/api/bots/${botId}/messages`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text: "Lunch receipt $18.50", sendId }),
    });
    expect(sent.status).toBe(202);
    expect(sent.json.message?.text).toBe("Lunch receipt $18.50");

    // 9. Single-use stream ticket -> SSE /api/events?ticket=... streams hello, and req.cancel cleans up.
    const ticketRes = await relay.request({
      method: "POST",
      path: "/api/auth/stream-ticket",
      headers: { authorization: `Bearer ${token}` },
      sendEmptyEof: true,
    });
    expect(ticketRes.status).toBe(200);
    const ticket = String(ticketRes.json.ticket);
    expect(ticket.length).toBeGreaterThan(10);

    const sse = relay.openStream({
      method: "GET",
      path: `/api/events?ticket=${encodeURIComponent(ticket)}`,
    });
    const sseHead = await sse.head;
    expect(sseHead.status).toBe(200);
    expect(String(sseHead.headers["content-type"])).toContain("text/event-stream");
    const firstEvents = await sse.readUntil((txt) => txt.includes("event: hello") || txt.includes("\"kind\":\"hello\""));
    expect(firstEvents).toContain("hello");
    sse.cancel();

    // Give cleanup a moment and verify the single-use ticket cannot be redeemed again.
    await new Promise((r) => setTimeout(r, 100));
    const reused = await relay.request({
      method: "GET",
      path: `/api/events?ticket=${encodeURIComponent(ticket)}`,
    });
    expect(reused.status).toBe(401);

    // Revoking the session causes subsequent bridge requests to fail with 401.
    const logout = await relay.request({
      method: "POST",
      path: "/api/auth/logout",
      headers: { authorization: `Bearer ${token}` },
      sendEmptyEof: true,
    });
    expect(logout.status).toBe(200);

    const afterLogout = await relay.request({
      method: "GET",
      path: "/api/bots",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterLogout.status).toBe(401);
  });
});
