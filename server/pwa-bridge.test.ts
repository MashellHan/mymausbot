import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { startBridge } from "../pwa-relay/src/bridge.ts";
import { loadConfig as loadRelayConfig } from "../pwa-relay/src/config.ts";
import type { PwaPairingPayload } from "../shared/pwa-bridge.ts";
import { json, readBody } from "./harness/http.ts";
import { PWA_BRIDGE_SUBPROTOCOL, isPwaBridgeRequest, pwaBridgePairingRefusal, startPwaBridge } from "./pwa-bridge.ts";
import { isBridgeRouteAllowed } from "./pwa-bridge-wire.ts";
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
    bodyFrames?: Array<{ chunkB64: string; eof: boolean }>;
    remoteAddr?: string;
    omitEof?: boolean;
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
    bodyFrames?: Array<{ chunkB64: string; eof: boolean }>;
    remoteAddr?: string;
    omitEof?: boolean;
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

    if (input.bodyFrames) {
      for (const frame of input.bodyFrames) {
        this.ws.send(JSON.stringify({
          type: "req.body",
          streamId,
          chunkB64: frame.chunkB64,
          eof: frame.eof,
        }));
      }
    } else if (input.body !== undefined) {
      const buf = typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body;
      this.ws.send(JSON.stringify({
        type: "req.body",
        streamId,
        chunkB64: buf.toString("base64"),
        eof: true,
      }));
    } else if (!input.omitEof) {
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
    expect(initial.body.config.enabled).toBe(true);
    expect(initial.body.status.state).toBe("off");
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
      { method: "GET", path: "/api/instances" },
      { method: "POST", path: "/api/auth/pairing" },
    ]) {
      const res = await relay.request(blocked);
      expect(res.status).toBe(403);
      expect(res.json.code).toBe("bridge_route_forbidden");
    }
    expect(seenSocketProps.length).toBe(beforeCalls);

    // Routine, notification, activity, and Web Push endpoints are allowed on the bridge allowlist; /api/instances stays blocked.
    for (const [method, path] of [
      ["GET", "/api/routines"],
      ["POST", "/api/routines"],
      ["PATCH", "/api/routines/r1"],
      ["DELETE", "/api/routines/r1"],
      ["POST", "/api/routines/r1/run"],
      ["POST", "/api/routine-runs/run-1/cancel"],
      ["POST", "/api/routine-runs/run-1/seen"],
      ["POST", "/api/routine-runs/seen-all"],
      ["GET", "/api/notifications"],
      ["POST", "/api/notifications/read-all"],
      ["POST", "/api/notifications/n-1/read"],
      ["GET", "/api/bots/b1/activity"],
      ["GET", "/api/push/web/vapid-key"],
      ["GET", "/api/push/web/subscription"],
      ["PUT", "/api/push/web/subscription"],
      ["DELETE", "/api/push/web/subscription"],
      ["POST", "/api/push/web/test"],
    ] as const) {
      expect(isBridgeRouteAllowed(method, path), `${method} ${path}`).toBe(true);
    }
    for (const [method, path] of [
      ["POST", "/api/push/web/vapid-key"],
      ["POST", "/api/push/web/subscription"],
      ["GET", "/api/push/web/test"],
      ["POST", "/api/bots/b1/activity"],
    ] as const) {
      expect(isBridgeRouteAllowed(method, path), `${method} ${path}`).toBe(false);
    }
    expect(isBridgeRouteAllowed("GET", "/api/instances")).toBe(false);

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

    // Peer-provided close reasons (including any secret marker) must never leak into status().lastError.
    relay.ws?.close(4401, `bad secret ${rotated.body.bridgeSecret}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(bridgeRef!.status().state).toBe("error");
    expect(bridgeRef!.status().lastError).toBe("bridge authentication rejected (4401)");
    expect(bridgeRef!.status().lastError).not.toContain(rotated.body.bridgeSecret);

    // Invalid header names/values and Content-Length mismatches fail cleanly at the bridge boundary.
    await adminCall("PUT", "/api/pwa-bridge", {
      enabled: true,
      relayUrl: relay.url,
      hostId: "mac-mini",
      pwaOrigin: "https://mausbot.mxhan.com",
    });
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 5_000;
      const poll = () => {
        if (bridgeRef!.status().state === "connected" && relay.ws?.readyState === 1) return resolve();
        if (Date.now() > deadline) return reject(new Error("timed out waiting for reconnect"));
        setTimeout(poll, 20);
      };
      poll();
    });

    const badHeader = await relay.request({
      method: "GET",
      path: "/api/bots",
      headers: { "bad header": "value" },
    });
    expect(badHeader.status).toBe(400);

    const mismatchedLen = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "100" },
      body: JSON.stringify({ text: "short" }),
    });
    expect(mismatchedLen.status).toBe(400);

    sessions.close();
  });

  it("closes active SSE streams on managed-policy denial and aborts CONNECTING sockets without uncaught errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwa-bridge-policy-"));
    dirs.push(dir);
    const relay = await MockBridgeRelay.start();
    relays.push(relay);

    let policyRefusal: string | undefined;
    let originClosed = false;
    let pushSseEvent: ((chunk: string) => void) | null = null;

    const bridge = startPwaBridge({
      dataDir: dir,
      managedRemoteAccessRefusal: () => policyRefusal,
      reconnectDelaysMs: [100],
      jitterFactor: () => 0.5,
      handle: (req, res) => {
        const url = new URL(req.url ?? "/", "http://pwa-bridge.invalid");
        if (url.pathname === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          res.write("event: hello\ndata: {\"ok\":true}\n\n");
          pushSseEvent = (chunk: string) => {
            if (!res.writableEnded) res.write(chunk);
          };
          res.on("close", () => {
            originClosed = true;
          });
          return;
        }
        json(res, 200, { ok: true });
      },
    })!;
    bridges.push(bridge);

    const rot = createPwaBridgeRoutes({
      bridge: () => bridge,
      dataDir: dir,
      sessions: new SessionRegistry({ file: join(dir, "sessions.json") }),
    });
    const adminServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      await dispatchRoutes([rot], {
        req,
        res,
        url,
        path: url.pathname,
        method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin", "client"] },
        json,
        readBody,
      });
    });
    servers.push(adminServer);
    await new Promise<void>((r) => adminServer.listen(0, "127.0.0.1", r));
    const adminBase = `http://127.0.0.1:${(adminServer.address() as AddressInfo).port}`;

    await fetch(`${adminBase}/api/pwa-bridge/rotate-secret`, { method: "POST", body: "{}" });
    await fetch(`${adminBase}/api/pwa-bridge`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, relayUrl: relay.url, hostId: "mac-mini" }),
    });
    await relay.waitForHost();

    const sse = relay.openStream({ method: "GET", path: "/api/events?ticket=t1" });
    const head = await sse.head;
    expect(head.status).toBe(200);
    const initial = await sse.readUntil((txt) => txt.includes("event: hello"));
    expect(initial).toContain("hello");

    // Flip managed policy to deny and emit an event; stream must close without delivering the post-denial event.
    policyRefusal = "Org Policy disables remote access.";
    pushSseEvent!("event: secret\ndata: {\"shouldNotDeliver\":true}\n\n");
    const closedBody = (await sse.body).toString("utf8");
    expect(closedBody).not.toContain("shouldNotDeliver");
    await new Promise((r) => setTimeout(r, 50));
    expect(originClosed).toBe(true);
    expect(bridge.status().activeStreams).toBe(0);

    // Stopping during a CONNECTING WebSocket handshake must not throw an uncaught error.
    const stalledSockets = new Set<import("node:net").Socket>();
    const stalledTcp = createNetServer((sock) => {
      stalledSockets.add(sock);
      sock.on("close", () => stalledSockets.delete(sock));
    });
    await new Promise<void>((r) => stalledTcp.listen(0, "127.0.0.1", r));
    const stalledPort = (stalledTcp.address() as AddressInfo).port;

    const dir2 = mkdtempSync(join(tmpdir(), "pwa-bridge-connecting-"));
    dirs.push(dir2);
    const bridge2 = startPwaBridge({ dataDir: dir2, handle: () => {} })!;
    bridge2.applyConfig({
      enabled: true,
      relayUrl: `http://127.0.0.1:${stalledPort}`,
      hostId: "mac-mini",
      bridgeSecret: "omb_bridge_test_secret_12345",
      pwaOrigin: "https://mausbot.mxhan.com",
      defaultBotId: null,
    });
    expect(bridge2.status().state).toBe("connecting");
    bridge2.stop();
    await new Promise((r) => setTimeout(r, 80));
    for (const sock of stalledSockets) sock.destroy();
    await new Promise<void>((r) => stalledTcp.close(() => r()));
  });

  it("completes framing before origin dispatch and interoperates end-to-end with the Stage 1 relay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwa-bridge-framing-"));
    dirs.push(dir);
    const mockRelay = await MockBridgeRelay.start();
    relays.push(mockRelay);

    let mutationCount = 0;
    const seenPosts: unknown[] = [];
    const bridge = startPwaBridge({
      dataDir: dir,
      handle: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://pwa-bridge.invalid");
        if (req.method === "POST" && url.pathname === "/api/bots/bot-acct/messages") {
          mutationCount += 1;
          const body = await readBody(req);
          seenPosts.push(body);
          json(res, 201, { ok: true, count: mutationCount });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/bots") {
          json(res, 200, { bots: [{ id: "bot-acct" }] });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          res.write("event: ready\ndata: {\"ok\":true}\n\n");
          res.end();
          return;
        }
        json(res, 404, { error: "not found" });
      },
    })!;
    bridges.push(bridge);

    const secret = "omb_bridge_stage1_interop_secret_123456";
    bridge.applyConfig({
      enabled: true,
      relayUrl: mockRelay.url,
      hostId: "mac-mini",
      bridgeSecret: secret,
      pwaOrigin: "https://mausbot.mxhan.com",
      defaultBotId: null,
    });
    await mockRelay.waitForHost();

    // Full Content-Length body in frame 1 followed by malformed terminal frame must fail 400 BEFORE handler runs.
    const payload = JSON.stringify({ text: "should not mutate" });
    const badTerminal = await mockRelay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
      bodyFrames: [
        { chunkB64: Buffer.from(payload, "utf8").toString("base64"), eof: false },
        { chunkB64: "!", eof: true },
      ],
    });
    expect(badTerminal.status).toBe(400);
    expect(mutationCount).toBe(0);

    // Mixed-case duplicate Content-Length headers must fail 400 at the wire parser before reaching handlers.
    const dupContentLengthDiff = await mockRelay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: {
        "content-type": "application/json",
        "Content-Length": "5",
        "content-length": "10",
      },
      body: payload,
    });
    expect(dupContentLengthDiff.status).toBe(400);
    expect(mutationCount).toBe(0);

    const dupContentLengthSame = await mockRelay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: {
        "content-type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
        "content-length": String(Buffer.byteLength(payload)),
      },
      body: payload,
    });
    expect(dupContentLengthSame.status).toBe(400);
    expect(mutationCount).toBe(0);

    // Body on GET must be rejected 400 before origin handler runs.
    const badGetBody = await mockRelay.request({
      method: "GET",
      path: "/api/bots",
      bodyFrames: [{ chunkB64: Buffer.from("x", "utf8").toString("base64"), eof: true }],
    });
    expect(badGetBody.status).toBe(400);

    // Valid Stage 1 pattern (data frame + separate empty EOF frame) dispatches cleanly once.
    const goodSplit = await mockRelay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(payload)),
      },
      bodyFrames: [
        { chunkB64: Buffer.from(payload, "utf8").toString("base64"), eof: false },
        { chunkB64: "", eof: true },
      ],
    });
    expect(goodSplit.status).toBe(201);
    expect(mutationCount).toBe(1);
    expect(seenPosts).toEqual([{ text: "should not mutate" }]);

    // Now wire the actual Stage 1 relay (pwa-relay/src/bridge.ts) to Stage 2 bridge and verify bodyless GET, SSE, and POST.
    const realRelay = await startBridge(
      loadRelayConfig({
        BRIDGE_PORT: "0",
        BRIDGE_HOST: "127.0.0.1",
        PINNED_HOST_ID: "mac-mini",
        HOST_TOKEN_HASHES: createHash("sha256").update(secret, "utf8").digest("hex"),
        PWA_ORIGIN: "https://mausbot.mxhan.com",
      }),
      { log: () => {} },
    );
    try {
      bridge.applyConfig({
        enabled: true,
        relayUrl: `http://127.0.0.1:${realRelay.port}`,
        hostId: "mac-mini",
        bridgeSecret: secret,
        pwaOrigin: "https://mausbot.mxhan.com",
        defaultBotId: null,
      });

      const deadline = Date.now() + 5_000;
      while (!realRelay.hostConnected()) {
        if (Date.now() > deadline) throw new Error("timed out waiting for real Stage 1 relay connection");
        await new Promise((r) => setTimeout(r, 20));
      }

      const relayBase = `http://127.0.0.1:${realRelay.port}`;
      const botsRes = await fetch(`${relayBase}/api/bots`);
      expect(botsRes.status).toBe(200);
      expect(await botsRes.json()).toEqual({ bots: [{ id: "bot-acct" }] });

      const sseRes = await fetch(`${relayBase}/api/events?ticket=t1`);
      expect(sseRes.status).toBe(200);
      expect(await sseRes.text()).toContain("event: ready");

      const postRes = await fetch(`${relayBase}/api/bots/bot-acct/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "via real relay" }),
      });
      expect(postRes.status).toBe(201);
      expect(mutationCount).toBe(2);
      expect(seenPosts[1]).toEqual({ text: "via real relay" });
    } finally {
      bridge.stop();
      await realRelay.close();
    }
  });

  it("enforces aggregate pending request byte budget and releases reservations on dispatch, cancel, policy denial, and disconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwa-bridge-budget-"));
    dirs.push(dir);
    const relay = await MockBridgeRelay.start();
    relays.push(relay);

    let policyRefusal: string | undefined;
    let handledCount = 0;
    const bridge = startPwaBridge({
      dataDir: dir,
      maxPendingBodyBytes: 120,
      managedRemoteAccessRefusal: () => policyRefusal,
      reconnectDelaysMs: [80],
      jitterFactor: () => 0.5,
      handle: async (req, res) => {
        handledCount += 1;
        await readBody(req);
        json(res, 201, { ok: true, handledCount });
      },
    })!;
    bridges.push(bridge);

    bridge.applyConfig({
      enabled: true,
      relayUrl: relay.url,
      hostId: "mac-mini",
      bridgeSecret: "omb_bridge_budget_secret_123456",
      pwaOrigin: "https://mausbot.mxhan.com",
      defaultBotId: null,
    });
    await relay.waitForHost();

    // Stream 1 buffers 90 bytes without EOF yet (leaves 30 bytes of aggregate budget).
    const chunk90 = Buffer.alloc(90, 97).toString("base64");
    const stream1 = relay.openStream({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json" },
      bodyFrames: [{ chunkB64: chunk90, eof: false }],
    });

    // Stream 2 declaring 50 bytes fails immediately at req.open (90 + 50 > 120).
    const overDeclared = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "50" },
      body: JSON.stringify({ text: "12345678901234567890123456789012345678" }),
    });
    expect(overDeclared.status).toBe(503);
    expect(overDeclared.json.code).toBe("bridge_busy");

    // Stream 3 omitting Content-Length and sending 40 bytes fails at req.body (90 + 40 > 120).
    const overChunked = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json" },
      bodyFrames: [{ chunkB64: Buffer.alloc(40, 98).toString("base64"), eof: false }],
    });
    expect(overChunked.status).toBe(503);
    expect(overChunked.json.code).toBe("bridge_busy");
    expect(handledCount).toBe(0);

    // Cancelling stream 1 releases its 90-byte reservation so a complete 90-byte request dispatches and releases.
    stream1.cancel();
    await new Promise((r) => setTimeout(r, 30));

    const validJson = JSON.stringify({ text: "a".repeat(79) }); // 90 bytes
    expect(Buffer.byteLength(validJson)).toBe(90);
    const afterCancel = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "90" },
      body: validJson,
    });
    expect(afterCancel.status).toBe(201);
    expect(handledCount).toBe(1);

    // Dispatch released the 90 bytes, so another 90-byte request also succeeds.
    const afterDispatch = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "90" },
      body: validJson,
    });
    expect(afterDispatch.status).toBe(201);
    expect(handledCount).toBe(2);

    // Policy denial on a pending stream releases its reservation.
    const stream4 = relay.openStream({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json" },
      bodyFrames: [{ chunkB64: chunk90, eof: false }],
    });
    await new Promise((r) => setTimeout(r, 20));
    policyRefusal = "Org Policy disables remote access.";
    const triggerPolicy = await relay.request({ method: "GET", path: "/api/bots" });
    expect(triggerPolicy.status).toBe(403);
    expect((await stream4.head).status).toBe(403);
    policyRefusal = undefined;

    const afterPolicy = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "90" },
      body: validJson,
    });
    expect(afterPolicy.status).toBe(201);

    // Socket disconnect releases pending reservations before reconnect.
    relay.openStream({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json" },
      bodyFrames: [{ chunkB64: chunk90, eof: false }],
    });
    await new Promise((r) => setTimeout(r, 20));
    relay.ws?.terminate();
    await relay.waitForHost();

    const afterReconnect = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "90" },
      body: validJson,
    });
    expect(afterReconnect.status).toBe(201);
  });

  it("rechecks admin session liveness and managed policy after reading route bodies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwa-bridge-recheck-"));
    dirs.push(dir);
    let live = true;
    let policyRefusal: string | undefined;
    let openPairingCalls = 0;

    let currentConfig = loadPwaBridgeConfig(dir);
    currentConfig = {
      ...currentConfig,
      enabled: true,
      relayUrl: "https://relay.mxhan.com",
      hostId: "mac-mini",
      bridgeSecret: "omb_bridge_recheck_secret_12345",
    };

    const handler = createPwaBridgeRoutes({
      bridge: () => ({
        status: () => ({ state: "connected", lastConnectedAt: Date.now(), lastError: null, activeStreams: 0 }),
        config: () => ({ ...currentConfig }),
        applyConfig: (next) => {
          currentConfig = { ...next };
        },
        stop: () => {},
      }),
      dataDir: dir,
      sessions: {
        isLive: () => live,
        openPairing: () => {
          openPairingCalls += 1;
          return { id: "p1", code: "123456", credential: "omb_pair_123", expiresAt: Date.now() + 60_000 };
        },
      },
      managedRemoteAccessRefusal: () => policyRefusal,
    });

    const invoke = async (method: string, path: string, body: unknown, duringRead: () => void) => {
      const statusOut: { status?: number; body?: Record<string, unknown> } = {};
      const res = {} as any;
      await dispatchRoutes([handler], {
        req: {} as any,
        res,
        url: new URL(`http://127.0.0.1${path}`),
        path,
        method,
        auth: {
          kind: "session",
          via: "cookie",
          scopes: ["admin", "client"],
          session: { id: "admin-sess-1" } as any,
        },
        json: (_r, status, payload) => {
          statusOut.status = status;
          statusOut.body = payload as Record<string, unknown>;
        },
        readBody: async () => {
          duringRead();
          return body;
        },
      });
      return statusOut;
    };

    // Session revoked while awaiting PUT /api/pwa-bridge body -> 401 and no config mutation.
    live = true;
    const putRevoked = await invoke("PUT", "/api/pwa-bridge", { hostId: "hijacked-host" }, () => {
      live = false;
    });
    expect(putRevoked.status).toBe(401);
    expect(currentConfig.hostId).toBe("mac-mini");

    // Session revoked while awaiting POST /api/pwa-bridge/invite body -> 401 and 0 invites opened.
    live = true;
    const inviteRevoked = await invoke("POST", "/api/pwa-bridge/invite", { label: "Phone" }, () => {
      live = false;
    });
    expect(inviteRevoked.status).toBe(401);
    expect(openPairingCalls).toBe(0);

    // Policy flips to deny while awaiting POST /api/pwa-bridge/invite body -> 403 and 0 invites opened.
    live = true;
    policyRefusal = undefined;
    const inviteDenied = await invoke("POST", "/api/pwa-bridge/invite", { label: "Phone" }, () => {
      policyRefusal = "Org Policy disables remote access.";
    });
    expect(inviteDenied.status).toBe(403);
    expect(inviteDenied.body?.code).toBe("managed_policy");
    expect(openPairingCalls).toBe(0);
  });

  it("strips trailers, replaces loopback/empty remoteAddr with pwa-bridge, and times out incomplete req.body streams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pwa-bridge-hardening-"));
    dirs.push(dir);
    const relay = await MockBridgeRelay.start();
    relays.push(relay);

    const seen: Array<{ xff: unknown; trailers: unknown }> = [];
    const bridge = startPwaBridge({
      dataDir: dir,
      bodyTimeoutMs: 80,
      maxPendingBodyBytes: 120,
      handle: (req, res) => {
        seen.push({ xff: req.headers["x-forwarded-for"], trailers: req.headers.trailers });
        res.setHeader("trailers", "X-Checksum");
        json(res, 200, { ok: true });
      },
    })!;
    bridges.push(bridge);

    bridge.applyConfig({
      enabled: true,
      relayUrl: relay.url,
      hostId: "mac-mini",
      bridgeSecret: "omb_bridge_hardening_secret_1234",
      pwaOrigin: "https://mausbot.mxhan.com",
      defaultBotId: null,
    });
    await relay.waitForHost();

    for (const remoteAddr of ["127.0.0.1", "::1", "::ffff:127.0.0.1", ""]) {
      const res = await relay.request({
        method: "GET",
        path: "/api/bots",
        remoteAddr,
        headers: { trailers: "X-Checksum" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.trailers).toBeUndefined();
    }
    expect(seen).toEqual([
      { xff: "pwa-bridge", trailers: undefined },
      { xff: "pwa-bridge", trailers: undefined },
      { xff: "pwa-bridge", trailers: undefined },
      { xff: "pwa-bridge", trailers: undefined },
    ]);

    // Incomplete req.body stream (without EOF) times out after bodyTimeoutMs with 408 and releases pending byte budget.
    const stalled = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "100" },
      bodyFrames: [{ chunkB64: Buffer.alloc(90, 97).toString("base64"), eof: false }],
      omitEof: true,
    });
    expect(stalled.status).toBe(408);
    expect(stalled.json.code).toBe("request_timeout");
    expect(bridge.status().activeStreams).toBe(0);

    // Budget was released so a full 90-byte POST succeeds immediately afterward.
    const afterTimeout = await relay.request({
      method: "POST",
      path: "/api/bots/bot-acct/messages",
      headers: { "content-type": "application/json", "content-length": "90" },
      body: JSON.stringify({ text: "a".repeat(79) }),
    });
    expect(afterTimeout.status).toBe(200);
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
      { method: "GET", path: "/api/instances" },
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

    // 7b. Client-scoped routine routes work over the PWA bridge.
    const routinesGet = await relay.request({
      method: "GET",
      path: "/api/routines",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(routinesGet.status).toBe(200);
    expect(Array.isArray(routinesGet.json.routines)).toBe(true);
    expect(Array.isArray(routinesGet.json.runs)).toBe(true);

    const routineCreate = await relay.request({
      method: "POST",
      path: "/api/routines",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bridge Routine",
        prompt: "Say hello",
        botId,
        enabled: false,
        schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
      }),
    });
    expect(routineCreate.status).toBe(201);
    const routineId = String(routineCreate.json.routine.id);

    const routinePatch = await relay.request({
      method: "PATCH",
      path: `/api/routines/${routineId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated Bridge Routine" }),
    });
    expect(routinePatch.status).toBe(200);
    expect(routinePatch.json.routine.name).toBe("Updated Bridge Routine");

    const seenAll = await relay.request({
      method: "POST",
      path: "/api/routine-runs/seen-all",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(seenAll.status).toBe(200);

    const routineDelete = await relay.request({
      method: "DELETE",
      path: `/api/routines/${routineId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(routineDelete.status).toBe(200);

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
    });
    expect(logout.status).toBe(200);

    const afterLogout = await relay.request({
      method: "GET",
      path: "/api/bots",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(afterLogout.status).toBe(401);

    // 10. Pre-gate DNS-rebinding Host checks (403) and 8_192-byte body cap (413) on /api/auth/pair and /api/pair.
    const rawHttp = async (method: string, path: string, hostHeader: string, bodyText?: string) => {
      const target = new URL(base);
      const { request } = await import("node:http");
      return await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            host: target.hostname,
            port: Number(target.port),
            method,
            path,
            headers: {
              Host: hostHeader,
              ...(bodyText !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(bodyText)) } : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          },
        );
        req.on("error", reject);
        if (bodyText !== undefined) req.write(bodyText);
        req.end();
      });
    };

    expect((await rawHttp("GET", "/.well-known/openmausbot/environment", "evil.attacker.com:4199")).status).toBe(403);
    expect((await rawHttp("POST", "/api/auth/pair", "evil.attacker.com:4199", "{}")).status).toBe(403);
    expect((await rawHttp("POST", "/api/pair", "evil.attacker.com:4199", "{}")).status).toBe(403);

    const oversizedPair = JSON.stringify({ code: "ABCD-EFGH-JK23", pad: "x".repeat(9_000) });
    expect((await rawHttp("POST", "/api/auth/pair", targetHost(base), oversizedPair)).status).toBe(413);
    expect((await rawHttp("POST", "/api/pair", targetHost(base), oversizedPair)).status).toBe(413);
  });
});

function targetHost(baseUrl: string): string {
  return new URL(baseUrl).host;
}
