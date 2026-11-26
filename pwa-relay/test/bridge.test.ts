import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { dirname, resolve as resolvePath } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startBridge, type BridgeServer } from "../src/bridge.ts";
import { loadConfig, type BridgeConfig } from "../src/config.ts";
import type { BridgeLogEvent } from "../src/log.ts";
import { BRIDGE_SUBPROTOCOL, CloseCode, type BridgeFrame } from "../src/wire.ts";

const SECRET = "bridge-secret-value-123456";
const SECRET_SHA256 = createHash("sha256").update(SECRET, "utf8").digest("hex");
const PWA_ORIGIN = "https://mausbot.mxhan.com";
const HOST_ID = "mac-mini-test";
const AUTH_HEADER = { Authorization: "Bearer omb_sess_test_token_12345678" };

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const base = loadConfig({
    BRIDGE_PORT: "0",
    BRIDGE_HOST: "127.0.0.1",
    PINNED_HOST_ID: HOST_ID,
    HOST_TOKEN_HASHES: SECRET_SHA256,
    PWA_ORIGIN,
    UPSTREAM_HEADER_TIMEOUT_MS: "500",
    UPLOAD_HEADER_TIMEOUT_MS: "1500",
    HEARTBEAT_INTERVAL_MS: "10000",
    AUTH_DEADLINE_MS: "500",
  });
  return { ...base, ...overrides };
}

function assertCorsAndNoStore(headers: Headers) {
  assert.equal(headers.get("access-control-allow-origin"), PWA_ORIGIN);
  assert.equal(headers.get("vary"), "Origin");
  assert.equal(headers.get("access-control-expose-headers"), "Retry-After");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.match(headers.get("access-control-allow-headers") ?? "", /Authorization/i);
  assert.match(headers.get("access-control-allow-headers") ?? "", /x-omb-background/i);
}

interface MockMac {
  ws: WebSocket;
  frames: BridgeFrame[];
  closePromise: Promise<{ code: number; reason: string }>;
  waitForFrame: (predicate: (frame: BridgeFrame) => boolean, timeoutMs?: number) => Promise<BridgeFrame>;
  sendFrame: (frame: BridgeFrame) => void;
}

async function connectMockMac(port: number, opts: { hostId?: string; token?: string; subprotocol?: string } = {}): Promise<MockMac> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/bridge`, opts.subprotocol === undefined ? [BRIDGE_SUBPROTOCOL] : opts.subprotocol ? [opts.subprotocol] : []);
  const frames: BridgeFrame[] = [];
  const waiters: Array<{ predicate: (frame: BridgeFrame) => boolean; resolve: (frame: BridgeFrame) => void; reject: (err: Error) => void }> = [];

  const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });

  ws.on("message", (raw) => {
    const parsed = JSON.parse(raw.toString("utf8")) as BridgeFrame;
    frames.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]!;
      if (w.predicate(parsed)) {
        waiters.splice(i, 1);
        w.resolve(parsed);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  ws.send(JSON.stringify({ type: "hello", hostId: opts.hostId ?? HOST_ID, token: opts.token ?? SECRET }));

  return {
    ws,
    frames,
    closePromise,
    sendFrame: (frame) => ws.send(JSON.stringify(frame)),
    waitForFrame: (predicate, timeoutMs = 2000) => {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for bridge frame")), timeoutMs);
        waiters.push({
          predicate,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
  };
}

describe("pwa-relay bridge", () => {
  const bridges: BridgeServer[] = [];

  afterEach(async () => {
    for (const b of bridges.splice(0)) {
      await b.close();
    }
  });

  it("validates config strictly and rejects wildcard PWA_ORIGIN", () => {
    assert.throws(() => loadConfig({ PINNED_HOST_ID: HOST_ID, HOST_TOKEN_HASHES: SECRET_SHA256, PWA_ORIGIN: "*" }), /PWA_ORIGIN/);
    assert.throws(() => loadConfig({ PINNED_HOST_ID: "", HOST_TOKEN_HASHES: SECRET_SHA256 }), /PINNED_HOST_ID/);
    assert.throws(() => loadConfig({ PINNED_HOST_ID: HOST_ID, HOST_TOKEN_HASHES: "not-hex" }), /HOST_TOKEN_HASHES/);
  });

  it("rejects wrong hostId, invalid token, missing subprotocol, and auth timeout", async () => {
    const bridge = await startBridge(makeConfig({ authDeadlineMs: 250 }), { log: () => {} });
    bridges.push(bridge);

    const wrongHost = await connectMockMac(bridge.port, { hostId: "other-host" });
    assert.equal((await wrongHost.closePromise).code, CloseCode.ForbiddenHost);

    const badToken = await connectMockMac(bridge.port, { token: "wrong-secret" });
    assert.equal((await badToken.closePromise).code, CloseCode.Unauthorized);

    const noProto = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/bridge`);
    const noProtoClosed = await new Promise<number>((resolve) => {
      noProto.once("close", (code) => resolve(code));
      noProto.once("error", () => {});
    });
    assert.ok(noProtoClosed >= 1000);

    const silent = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/bridge`, [BRIDGE_SUBPROTOCOL]);
    const silentClosed = await new Promise<number>((resolve) => silent.once("close", (code) => resolve(code)));
    assert.equal(silentClosed, CloseCode.Malformed);
  });

  it("blocks unauthenticated HTTP paths with 401 before checking Mac state, removes hostConnected from /healthz, and allows POST /api/pair", async () => {
    const bridge = await startBridge(makeConfig(), { log: () => {} });
    bridges.push(bridge);

    const health = await fetch(`http://127.0.0.1:${bridge.port}/healthz`);
    assert.equal(health.status, 200);
    assertCorsAndNoStore(health.headers);
    assert.deepEqual(await health.json(), { ok: true });

    const preflight = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assertCorsAndNoStore(preflight.headers);

    for (const blockedPath of [
      "/api/brand",
      "/api/health",
      "/.well-known/openmausbot/environment",
      "/api/bots",
      "/api/events",
      "/api/pair",
    ]) {
      const unauth = await fetch(`http://127.0.0.1:${bridge.port}${blockedPath}`);
      assert.equal(unauth.status, 401, `Expected 401 for unauthenticated GET ${blockedPath}`);
      assertCorsAndNoStore(unauth.headers);
      assert.deepEqual(await unauth.json(), { error: "Unauthorized", code: "unauthorized" });
    }

    const pairRes = await fetch(`http://127.0.0.1:${bridge.port}/api/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "omb_pair_abc", deviceName: "iPhone" }),
    });
    assert.equal(pairRes.status, 503);
    assert.deepEqual(await pairRes.json(), { error: "Mac host is offline", code: "mac_offline" });

    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
    const elapsed = Date.now() - start;
    assert.equal(res.status, 503);
    assert.ok(elapsed < 250, `Expected <250ms fast fail, got ${elapsed}ms`);
    assertCorsAndNoStore(res.headers);
    assert.deepEqual(await res.json(), { error: "Mac host is offline", code: "mac_offline" });
  });

  it("proxies REST requests, enforces CORS + no-store + Retry-After, and redacts secrets from logs", async () => {
    const logs: BridgeLogEvent[] = [];
    const bridge = await startBridge(makeConfig(), { log: (e) => logs.push(e) });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");
    assert.equal(bridge.hostConnected(), true);

    const resPromise = fetch(`http://127.0.0.1:${bridge.port}/api/bots/b1/messages?ticket=secret-ticket-999`, {
      method: "POST",
      headers: {
        Authorization: "Bearer omb_sess_secret_token_xyz",
        "Content-Type": "application/json",
        Cookie: "omb_session=forged",
        "x-omb-background": "1",
        "x-openmausbot-desktop-owner": "forged",
      },
      body: JSON.stringify({ text: "lunch 42rmb secret_body_marker" }),
    });

    const open = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    assert.equal(open.method, "POST");
    assert.equal(open.path, "/api/bots/b1/messages?ticket=secret-ticket-999");
    assert.equal(open.headers.authorization, "Bearer omb_sess_secret_token_xyz");
    assert.equal(open.headers.cookie, undefined);
    assert.equal(open.headers.host, undefined);
    assert.equal(open.headers["x-omb-background"], undefined);
    assert.equal(open.headers["x-openmausbot-desktop-owner"], undefined);

    const bodyFrame = (await mac.waitForFrame((f) => f.type === "req.body" && f.streamId === open.streamId && f.chunkB64.length > 0)) as Extract<
      BridgeFrame,
      { type: "req.body" }
    >;
    assert.equal(JSON.parse(Buffer.from(bodyFrame.chunkB64, "base64").toString("utf8")).text, "lunch 42rmb secret_body_marker");

    mac.sendFrame({
      type: "res.head",
      streamId: open.streamId,
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "7",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
        "set-cookie": "spoofed=1",
      },
    });
    mac.sendFrame({
      type: "res.body",
      streamId: open.streamId,
      chunkB64: Buffer.from(JSON.stringify({ error: "rate limited" })).toString("base64"),
      eof: true,
    });

    const res = await resPromise;
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
    assert.equal(res.headers.get("set-cookie"), null);
    assertCorsAndNoStore(res.headers);
    assert.deepEqual(await res.json(), { error: "rate limited" });

    const serializedLogs = JSON.stringify(logs);
    assert.ok(!serializedLogs.includes("omb_sess_secret_token_xyz"));
    assert.ok(!serializedLogs.includes("secret-ticket-999"));
    assert.ok(!serializedLogs.includes("secret_body_marker"));
    assert.ok(!serializedLogs.includes(SECRET));

    mac.ws.close();
    await mac.closePromise;
  });

  it("replaces stale host with 4409 and immediately closes old in-flight HTTP and SSE streams", async () => {
    const bridge = await startBridge(makeConfig({ upstreamHeaderTimeoutMs: 5_000 }), { log: () => {} });
    bridges.push(bridge);

    const mac1 = await connectMockMac(bridge.port);
    await mac1.waitForFrame((f) => f.type === "hello");

    const pendingHttp = fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
    await mac1.waitForFrame((f) => f.type === "req.open");

    const sseAbort = new AbortController();
    const ssePromise = fetch(`http://127.0.0.1:${bridge.port}/api/events?ticket=t1`, { signal: sseAbort.signal });
    const sseOpen = (await mac1.waitForFrame((f) => f.type === "req.open" && f.path.includes("/api/events"))) as Extract<
      BridgeFrame,
      { type: "req.open" }
    >;
    mac1.sendFrame({ type: "res.head", streamId: sseOpen.streamId, status: 200, headers: { "content-type": "text/event-stream" } });
    mac1.sendFrame({ type: "res.body", streamId: sseOpen.streamId, chunkB64: Buffer.from(": hello\n\n").toString("base64"), eof: false });

    const sseRes = await ssePromise;
    assert.equal(sseRes.status, 200);
    const sseReader = sseRes.body!.getReader();
    const firstChunk = await sseReader.read();
    assert.match(Buffer.from(firstChunk.value!).toString("utf8"), /: hello/);

    // Takeover by newer host
    const mac2 = await connectMockMac(bridge.port);
    await mac2.waitForFrame((f) => f.type === "hello");

    const closed1 = await mac1.closePromise;
    assert.equal(closed1.code, CloseCode.Replaced);

    const failedHttp = await pendingHttp;
    assert.equal(failedHttp.status, 503);
    assertCorsAndNoStore(failedHttp.headers);

    // Old SSE stream terminates immediately rather than hanging
    const nextRead = await Promise.race([
      sseReader.read().then((r) => (r.done ? "done" : "data")).catch(() => "aborted"),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    assert.notEqual(nextRead, "hung");

    // New host serves traffic cleanly
    const okReq = fetch(`http://127.0.0.1:${bridge.port}/api/health`, { headers: AUTH_HEADER });
    const okOpen = (await mac2.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    mac2.sendFrame({ type: "res.head", streamId: okOpen.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac2.sendFrame({ type: "res.body", streamId: okOpen.streamId, chunkB64: Buffer.from('{"ok":true}').toString("base64"), eof: true });
    const okRes = await okReq;
    assert.equal(okRes.status, 200);

    sseAbort.abort();
    mac2.ws.close();
  });

  it("streams SSE chunks unbuffered and sends req.cancel immediately when client closes", async () => {
    const bridge = await startBridge(makeConfig(), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const controller = new AbortController();
    const resPromise = fetch(`http://127.0.0.1:${bridge.port}/api/events?ticket=tk1`, { signal: controller.signal });
    const open = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;

    mac.sendFrame({ type: "res.head", streamId: open.streamId, status: 200, headers: { "content-type": "text/event-stream" } });
    const res = await resPromise;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-accel-buffering"), "no");
    assertCorsAndNoStore(res.headers);

    mac.sendFrame({ type: "res.body", streamId: open.streamId, chunkB64: Buffer.from("data: ping\n\n").toString("base64"), eof: false });
    const reader = res.body!.getReader();
    const chunk = await reader.read();
    assert.equal(Buffer.from(chunk.value!).toString("utf8"), "data: ping\n\n");

    controller.abort();
    const cancel = (await mac.waitForFrame((f) => f.type === "req.cancel" && f.streamId === open.streamId)) as Extract<
      BridgeFrame,
      { type: "req.cancel" }
    >;
    assert.equal(cancel.streamId, open.streamId);
    mac.ws.close();
  });

  it("returns 504 on upstream header timeout and emits req.cancel", async () => {
    const bridge = await startBridge(makeConfig({ upstreamHeaderTimeoutMs: 120 }), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
    assert.equal(res.status, 504);
    assertCorsAndNoStore(res.headers);
    const cancel = await mac.waitForFrame((f) => f.type === "req.cancel");
    assert.equal(cancel.type, "req.cancel");
    mac.ws.close();
  });

  it("enforces decoded MAX_BODY_BYTES (413) and chunks payloads within MAX_FRAME_BYTES", async () => {
    const maxBodyBytes = 200 * 1024;
    const maxFrameBytes = 16 * 1024;
    const bridge = await startBridge(makeConfig({ maxBodyBytes, maxFrameBytes }), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    // 1. Valid multi-frame body under maxBodyBytes but larger than maxFrameBytes
    const validBuf = Buffer.alloc(64 * 1024, 0x61);
    const okPromise = fetch(`http://127.0.0.1:${bridge.port}/api/attachments?uploadId=u1`, {
      method: "POST",
      headers: AUTH_HEADER,
      body: validBuf,
    });
    const okOpen = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    await mac.waitForFrame((f) => f.type === "req.body" && f.streamId === okOpen.streamId && f.eof);

    const bodyFrames = mac.frames.filter(
      (f): f is Extract<BridgeFrame, { type: "req.body" }> => f.type === "req.body" && f.streamId === okOpen.streamId,
    );
    assert.ok(bodyFrames.length > 4, "Expected multi-frame chunking");
    for (const f of bodyFrames) {
      assert.ok(Buffer.byteLength(JSON.stringify(f), "utf8") <= maxFrameBytes);
    }
    const reassembled = Buffer.concat(bodyFrames.map((f) => Buffer.from(f.chunkB64, "base64")));
    assert.equal(reassembled.length, validBuf.length);
    assert.ok(reassembled.equals(validBuf));

    mac.sendFrame({ type: "res.head", streamId: okOpen.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: okOpen.streamId, chunkB64: Buffer.from('{"ok":true}').toString("base64"), eof: true });
    assert.equal((await okPromise).status, 200);

    // 2. Oversized body (> maxBodyBytes) returns 413 with CORS + no-store
    const hugeBuf = Buffer.alloc(maxBodyBytes + 1024, 0x62);
    const overRes = await fetch(`http://127.0.0.1:${bridge.port}/api/attachments?uploadId=u2`, {
      method: "POST",
      headers: AUTH_HEADER,
      body: hugeBuf,
    });
    assert.equal(overRes.status, 413);
    assertCorsAndNoStore(overRes.headers);

    // 3. Streaming chunked body without Content-Length exceeding maxBodyBytes triggers 413 + req.cancel
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(120 * 1024));
        controller.enqueue(new Uint8Array(120 * 1024));
        controller.close();
      },
    });
    const streamOverRes = await fetch(`http://127.0.0.1:${bridge.port}/api/attachments?uploadId=u3`, {
      method: "POST",
      headers: AUTH_HEADER,
      body: streamBody,
      duplex: "half",
    } as RequestInit);
    assert.equal(streamOverRes.status, 413);
    assertCorsAndNoStore(streamOverRes.headers);
    const cancel = await mac.waitForFrame((f) => f.type === "req.cancel");
    assert.equal(cancel.type, "req.cancel");

    mac.ws.close();
  });

  it("enforces maxConcurrentStreams (503 bridge_busy + Retry-After) and forwards Caddy X-Forwarded-For", async () => {
    const bridge = await startBridge(makeConfig({ maxConcurrentStreams: 1, upstreamHeaderTimeoutMs: 2_000 }), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const firstPromise = fetch(`http://127.0.0.1:${bridge.port}/api/bots`, {
      headers: { ...AUTH_HEADER, "x-forwarded-for": "203.0.113.42" },
    });
    const firstOpen = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    assert.equal(firstOpen.remoteAddr, "203.0.113.42");

    const secondRes = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
    assert.equal(secondRes.status, 503);
    assert.equal(secondRes.headers.get("retry-after"), "1");
    assertCorsAndNoStore(secondRes.headers);
    assert.deepEqual(await secondRes.json(), { error: "Too many concurrent requests", code: "bridge_busy" });

    mac.sendFrame({ type: "res.head", streamId: firstOpen.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: firstOpen.streamId, chunkB64: Buffer.from("{}").toString("base64"), eof: true });
    assert.equal((await firstPromise).status, 200);

    mac.ws.close();
  });

  it("tears down dead tunnel after missed heartbeat pongs", async () => {
    const bridge = await startBridge(makeConfig({ heartbeatIntervalMs: 60, maxMissedPongs: 2 }), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");
    assert.equal(bridge.hostConnected(), true);

    const closed = await mac.closePromise;
    assert.equal(closed.code, 1006);
    assert.equal(bridge.hostConnected(), false);
  });

  it("rejects oversized req.open frames (431) without poisoning the host tunnel", async () => {
    const bridge = await startBridge(makeConfig({ maxFrameBytes: 4096 }), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const hugePath = `/api/bots?pad=${"a".repeat(5000)}`;
    const tooBigRes = await fetch(`http://127.0.0.1:${bridge.port}${hugePath}`, { headers: AUTH_HEADER });
    assert.equal(tooBigRes.status, 431);
    assertCorsAndNoStore(tooBigRes.headers);
    assert.deepEqual(await tooBigRes.json(), { error: "Request headers too large", code: "headers_too_large" });
    assert.equal(mac.frames.filter((f) => f.type === "req.open").length, 0);

    // Subsequent valid request still succeeds on the same tunnel
    const okPromise = fetch(`http://127.0.0.1:${bridge.port}/api/health`, { headers: AUTH_HEADER });
    const open = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    mac.sendFrame({ type: "res.head", streamId: open.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: open.streamId, chunkB64: Buffer.from('{"ok":true}').toString("base64"), eof: true });
    assert.equal((await okPromise).status, 200);
    assert.equal(bridge.hostConnected(), true);

    mac.ws.close();
  });

  it("fails only the affected stream (502 + req.cancel) on invalid res.head headers without dropping the tunnel", async () => {
    const bridge = await startBridge(makeConfig({ upstreamHeaderTimeoutMs: 2_000 }), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const healthyPromise = fetch(`http://127.0.0.1:${bridge.port}/api/health`, { headers: AUTH_HEADER });
    const healthyOpen = (await mac.waitForFrame((f) => f.type === "req.open" && f.path === "/api/health")) as Extract<
      BridgeFrame,
      { type: "req.open" }
    >;

    const badPromise = fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
    const badOpen = (await mac.waitForFrame((f) => f.type === "req.open" && f.path === "/api/bots")) as Extract<
      BridgeFrame,
      { type: "req.open" }
    >;

    mac.sendFrame({
      type: "res.head",
      streamId: badOpen.streamId,
      status: 200,
      headers: { "bad header name": "value", "x-nul": "ok\u0000bad" },
    });

    const badRes = await badPromise;
    assert.equal(badRes.status, 502);
    assertCorsAndNoStore(badRes.headers);
    assert.deepEqual(await badRes.json(), { error: "Upstream sent invalid response headers", code: "bad_gateway" });
    await mac.waitForFrame((f) => f.type === "req.cancel" && f.streamId === badOpen.streamId);

    const badStatusPromise = fetch(`http://127.0.0.1:${bridge.port}/api/bots?case=bad-status`, { headers: AUTH_HEADER });
    const badStatusOpen = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes("bad-status"))) as Extract<
      BridgeFrame,
      { type: "req.open" }
    >;
    mac.ws.send(JSON.stringify({ type: "res.head", streamId: badStatusOpen.streamId, status: 999, headers: {} }));
    const badStatusRes = await badStatusPromise;
    assert.equal(badStatusRes.status, 502);
    assertCorsAndNoStore(badStatusRes.headers);
    await mac.waitForFrame((f) => f.type === "req.cancel" && f.streamId === badStatusOpen.streamId);

    const badShapePromise = fetch(`http://127.0.0.1:${bridge.port}/api/bots?case=bad-shape`, { headers: AUTH_HEADER });
    const badShapeOpen = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes("bad-shape"))) as Extract<
      BridgeFrame,
      { type: "req.open" }
    >;
    mac.ws.send(JSON.stringify({ type: "res.head", streamId: badShapeOpen.streamId, status: 200, headers: { "x-num": 123 } }));
    const badShapeRes = await badShapePromise;
    assert.equal(badShapeRes.status, 502);
    assertCorsAndNoStore(badShapeRes.headers);
    await mac.waitForFrame((f) => f.type === "req.cancel" && f.streamId === badShapeOpen.streamId);

    // Concurrent healthy stream and tunnel remain unaffected
    assert.equal(bridge.hostConnected(), true);
    mac.sendFrame({ type: "res.head", streamId: healthyOpen.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({
      type: "res.body",
      streamId: healthyOpen.streamId,
      chunkB64: Buffer.from('{"ok":true}').toString("base64"),
      eof: true,
    });
    const healthyRes = await healthyPromise;
    assert.equal(healthyRes.status, 200);
    assert.deepEqual(await healthyRes.json(), { ok: true });

    mac.ws.close();
  });

  it("applies backpressure and rejects new requests with 503 bridge_busy when ws bufferedAmount reaches MAX_WS_BUFFERED_BYTES", async () => {
    const bridge = await startBridge(
      makeConfig({ maxWsBufferedBytes: 16 * 1024, maxFrameBytes: 32 * 1024, uploadHeaderTimeoutMs: 5_000, upstreamHeaderTimeoutMs: 2_000 }),
      { log: () => {} },
    );
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    // Pause reads on the mock Mac socket so loopback TCP buffers fill and ws.bufferedAmount exceeds maxWsBufferedBytes
    const macSocket = (mac.ws as unknown as { _socket?: { pause: () => void; resume: () => void } })._socket;
    assert.ok(macSocket, "Expected underlying socket on mock ws");
    macSocket.pause();

    const payload = Buffer.alloc(4 * 1024 * 1024, 0x7a);
    let settled = false;
    const uploadPromise = fetch(`http://127.0.0.1:${bridge.port}/api/attachments?uploadId=bp1`, {
      method: "POST",
      headers: AUTH_HEADER,
      body: payload,
    }).then((r) => {
      settled = true;
      return r;
    });

    // Wait until ws.bufferedAmount hits maxWsBufferedBytes and new requests are rejected with 503 bridge_busy
    let busyRes: Response | undefined;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const probe = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
      if (probe.status === 503) {
        const body = (await probe.json()) as { code?: string };
        if (body.code === "bridge_busy") {
          busyRes = probe;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(busyRes, "Expected 503 bridge_busy while ws.bufferedAmount is saturated");
    assert.equal(busyRes.headers.get("retry-after"), "1");
    assertCorsAndNoStore(busyRes.headers);
    assert.equal(settled, false);

    // Resume reading on the mock Mac socket so bufferedAmount drains and the paused upload completes
    macSocket.resume();
    const uploadOpen = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes("uploadId=bp1"))) as Extract<
      BridgeFrame,
      { type: "req.open" }
    >;
    await mac.waitForFrame((f) => f.type === "req.body" && f.streamId === uploadOpen.streamId && f.eof, 5000);

    const uploadedFrames = mac.frames.filter(
      (f): f is Extract<BridgeFrame, { type: "req.body" }> => f.type === "req.body" && f.streamId === uploadOpen.streamId,
    );
    assert.ok(Buffer.concat(uploadedFrames.map((f) => Buffer.from(f.chunkB64, "base64"))).equals(payload));

    mac.sendFrame({ type: "res.head", streamId: uploadOpen.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: uploadOpen.streamId, chunkB64: Buffer.from('{"ok":true}').toString("base64"), eof: true });
    assert.equal((await uploadPromise).status, 200);

    mac.ws.close();
  });

  it("cancels stalled backpressured uploads with 504 + req.cancel on uploadHeaderTimeoutMs", async () => {
    const bridge = await startBridge(
      makeConfig({ maxWsBufferedBytes: 16 * 1024, maxFrameBytes: 32 * 1024, uploadHeaderTimeoutMs: 200 }),
      { log: () => {} },
    );
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const macSocket = (mac.ws as unknown as { _socket?: { pause: () => void; resume: () => void } })._socket;
    assert.ok(macSocket);
    macSocket.pause();

    const uploadRes = await fetch(`http://127.0.0.1:${bridge.port}/api/attachments?uploadId=bp-stall`, {
      method: "POST",
      headers: AUTH_HEADER,
      body: Buffer.alloc(4 * 1024 * 1024, 0x63),
    });
    assert.equal(uploadRes.status, 504);
    assertCorsAndNoStore(uploadRes.headers);
    assert.deepEqual(await uploadRes.json(), { error: "Upstream response timed out", code: "upstream_timeout" });

    macSocket.resume();
    await mac.waitForFrame((f) => f.type === "req.cancel");
    assert.equal(bridge.hostConnected(), true);
    mac.ws.close();
  });

  it("cleans up paused upload and emits req.cancel on early terminal upstream rejection (401)", async () => {
    const bridge = await startBridge(
      makeConfig({ maxWsBufferedBytes: 16 * 1024, maxFrameBytes: 32 * 1024, uploadHeaderTimeoutMs: 1_500 }),
      { log: () => {} },
    );
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const macSocket = (mac.ws as unknown as { _socket?: { pause: () => void; resume: () => void } })._socket;
    assert.ok(macSocket);
    macSocket.pause();

    const uploadPromise = fetch(`http://127.0.0.1:${bridge.port}/api/attachments?uploadId=bp-401`, {
      method: "POST",
      headers: AUTH_HEADER,
      body: Buffer.alloc(4 * 1024 * 1024, 0x64),
    });

    // Wait until backpressure engages
    const deadline = Date.now() + 3000;
    let engaged = false;
    while (Date.now() < deadline) {
      const probe = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
      if (probe.status === 503) {
        engaged = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(engaged, true);

    // Resume socket just enough to read req.open, then immediately reject with 401 before upload EOF
    macSocket.resume();
    const open = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes("bp-401"))) as Extract<
      BridgeFrame,
      { type: "req.open" }
    >;
    mac.sendFrame({ type: "res.head", streamId: open.streamId, status: 401, headers: { "content-type": "application/json" } });
    mac.sendFrame({
      type: "res.body",
      streamId: open.streamId,
      chunkB64: Buffer.from('{"error":"Unauthorized"}').toString("base64"),
      eof: true,
    });

    const uploadRes = await uploadPromise;
    assert.equal(uploadRes.status, 401);
    assertCorsAndNoStore(uploadRes.headers);
    assert.deepEqual(await uploadRes.json(), { error: "Unauthorized" });

    await mac.waitForFrame((f) => f.type === "req.cancel" && f.streamId === open.streamId);
    assert.equal(
      mac.frames.some((f) => f.type === "req.body" && f.streamId === open.streamId && f.eof),
      false,
      "Early rejection should abort upload before req.body EOF",
    );

    // Wait past uploadHeaderTimeoutMs to verify no lingering timer or stranded stream tears down the tunnel
    await new Promise((r) => setTimeout(r, 1_100));
    assert.equal(bridge.hostConnected(), true);
    mac.ws.close();
  });

  it("propagates SSE client cancellation through an HTTP reverse proxy and enforces Caddyfile hardening", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const caddyfile = readFileSync(resolvePath(here, "../deploy/Caddyfile"), "utf8");
    const caddySite = readFileSync(resolvePath(here, "../deploy/Caddyfile.pwa-site.example"), "utf8");
    const cfHeaders = readFileSync(resolvePath(here, "../../deploy/pwa-cf/public/_headers"), "utf8");
    assert.ok(!caddyfile.includes("flush_interval -1"), "Caddyfile must not set flush_interval -1 (breaks SSE cancellation)");
    assert.match(caddyfile, /handle_errors\s*\{[\s\S]*Access-Control-Allow-Origin\s+\{\$PWA_ORIGIN\}/);
    assert.match(caddyfile, /handle_errors\s*\{[\s\S]*Cache-Control\s+"no-store"/);
    assert.match(caddyfile, /replace ticket REDACTED/);
    assert.match(caddyfile, /request>headers>Authorization delete/);
    assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
    assert.match(caddyfile, /X-Content-Type-Options "nosniff"/);
    assert.match(caddyfile, /Referrer-Policy "no-referrer"/);
    assert.match(caddyfile, /header_up X-Forwarded-For \{http\.request\.remote\.host\}/);
    assert.match(caddyfile, /max_size 64KB/);
    assert.match(caddyfile, /max_size 13MB/);
    assert.match(caddySite, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
    assert.match(cfHeaders, /Strict-Transport-Security: max-age=31536000; includeSubDomains/);

    const bridge = await startBridge(makeConfig(), { log: () => {} });
    bridges.push(bridge);
    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    // Simulate a reverse proxy forwarding SSE and tearing down upstream request on client close
    const proxy = createHttpServer((clientReq, clientRes) => {
      const upstreamReq = httpRequest(
        {
          host: "127.0.0.1",
          port: bridge.port,
          method: clientReq.method,
          path: clientReq.url,
          headers: clientReq.headers,
        },
        (upstreamRes) => {
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(clientRes);
        },
      );
      clientRes.on("close", () => {
        if (!clientRes.writableEnded) upstreamReq.destroy();
      });
      upstreamReq.on("error", () => {
        if (!clientRes.writableEnded) clientRes.destroy();
      });
      clientReq.pipe(upstreamReq);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
      const ac = new AbortController();
      const ssePromise = fetch(`http://127.0.0.1:${proxyPort}/api/events?ticket=tk-proxy`, { signal: ac.signal });
      const open = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
      mac.sendFrame({ type: "res.head", streamId: open.streamId, status: 200, headers: { "content-type": "text/event-stream" } });
      mac.sendFrame({ type: "res.body", streamId: open.streamId, chunkB64: Buffer.from("data: ok\n\n").toString("base64"), eof: false });

      const sseRes = await ssePromise;
      const reader = sseRes.body!.getReader();
      await reader.read();

      ac.abort();
      const cancel = await mac.waitForFrame((f) => f.type === "req.cancel" && f.streamId === open.streamId);
      assert.equal(cancel.type, "req.cancel");
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      mac.ws.close();
    }
  });

  it("extracts rightmost sanitized X-Forwarded-For hop capped at 64 chars and rejects prototype-pollution header keys", async () => {
    const bridge = await startBridge(makeConfig(), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    const longAddr = `${"a".repeat(70)}!@#`;
    const req1 = fetch(`http://127.0.0.1:${bridge.port}/api/bots`, {
      headers: { ...AUTH_HEADER, "x-forwarded-for": `198.51.100.1, ${longAddr}, ` },
    });
    const open1 = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    assert.equal(open1.remoteAddr, "a".repeat(64));
    mac.sendFrame({ type: "res.head", streamId: open1.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: open1.streamId, chunkB64: Buffer.from("{}").toString("base64"), eof: true });
    assert.equal((await req1).status, 200);

    for (const badKey of ["__proto__", "constructor", "prototype"]) {
      const reqBad = fetch(`http://127.0.0.1:${bridge.port}/api/bots?k=${badKey}`, { headers: AUTH_HEADER });
      const openBad = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes(badKey))) as Extract<
        BridgeFrame,
        { type: "req.open" }
      >;
      mac.ws.send(`{"type":"res.head","streamId":"${openBad.streamId}","status":200,"headers":{"${badKey}":"bad"}}`);
      const resBad = await reqBad;
      assert.equal(resBad.status, 502);
    }
    mac.ws.close();
  });

  it("caps pending unauthenticated upgrades, pre-auth frame size, and throttles repeated auth failures", async () => {
    const bridge = await startBridge(
      makeConfig({ maxPendingAuth: 2, preAuthMaxFrameBytes: 4096, authMaxFailures: 2, authBlockMs: 5_000, authDeadlineMs: 5_000 }),
      { log: () => {} },
    );
    bridges.push(bridge);

    // 1. Pre-auth payload > 4096 bytes rejected with 4400.
    const bigWs = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/bridge`, [BRIDGE_SUBPROTOCOL]);
    await new Promise<void>((resolve) => bigWs.once("open", resolve));
    const bigClosed = new Promise<number>((resolve) => bigWs.once("close", (c) => resolve(c)));
    bigWs.send(JSON.stringify({ type: "hello", hostId: HOST_ID, token: "x".repeat(5000) }));
    assert.equal(await bigClosed, CloseCode.Malformed);

    // 2. Concurrent unauthenticated upgrades capped at maxPendingAuth (2).
    const pending1 = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/bridge`, [BRIDGE_SUBPROTOCOL]);
    const pending2 = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/bridge`, [BRIDGE_SUBPROTOCOL]);
    await Promise.all([
      new Promise<void>((resolve) => pending1.once("open", resolve)),
      new Promise<void>((resolve) => pending2.once("open", resolve)),
    ]);
    const rejected3 = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/bridge`, [BRIDGE_SUBPROTOCOL]);
    const rejErr = await new Promise<Error>((resolve) => rejected3.once("error", resolve));
    assert.match(rejErr.message, /503/);
    pending1.close();
    pending2.close();
    await new Promise((r) => setTimeout(r, 30));

    // 3. Repeated 4401/4403 auth failures throttle subsequent upgrades from the same IP with 429.
    const bad1 = await connectMockMac(bridge.port, { token: "wrong-1" });
    assert.equal((await bad1.closePromise).code, CloseCode.Unauthorized);
    const bad2 = await connectMockMac(bridge.port, { hostId: "wrong-host" });
    assert.equal((await bad2.closePromise).code, CloseCode.ForbiddenHost);

    const throttled = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/bridge`, [BRIDGE_SUBPROTOCOL]);
    const throttledErr = await new Promise<Error>((resolve) => throttled.once("error", resolve));
    assert.match(throttledErr.message, /429/);
  });

  it("handles ws.on('error') cleanly without RangeError on close(1006)", async () => {
    const bridge = await startBridge(makeConfig({ upstreamHeaderTimeoutMs: 5_000 }), { log: () => {} });
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");
    const pendingReq = fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { headers: AUTH_HEADER });
    await mac.waitForFrame((f) => f.type === "req.open");

    // Abruptly destroy the underlying TCP socket with a RST-like error; bridge must not throw RangeError on 1006.
    const rawSock = (mac.ws as unknown as { _socket?: { destroy: (err?: Error) => void } })._socket;
    rawSock?.destroy(new Error("ECONNRESET"));
    await mac.closePromise;

    const res = await pendingReq;
    assert.equal(res.status, 503);
    assert.equal(bridge.hostConnected(), false);
  });

  it("times out stalled upload bodies (408 + req.cancel) and enforces relay-wide maxPendingBodyBytes (503 bridge_busy)", async () => {
    const bridge = await startBridge(
      makeConfig({
        idleUploadTimeoutMs: 100,
        uploadHeaderTimeoutMs: 5_000,
        maxWsBufferedBytes: 1024,
        maxFrameBytes: 16 * 1024,
        maxPendingBodyBytes: 16 * 1024,
      }),
      { log: () => {} },
    );
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    // 1. Stalled upload stream triggers 408 request_timeout + req.cancel.
    const stalledRes = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: bridge.port,
          method: "POST",
          path: "/api/attachments?uploadId=stall-1",
          headers: { ...AUTH_HEADER, "content-length": "1024" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            clearTimeout(killTimer);
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          });
        },
      );
      req.on("error", () => {});
      req.write("partial");
      const killTimer = setTimeout(() => req.destroy(), 1000);
    });
    assert.equal(stalledRes.status, 408);
    assert.equal(stalledRes.body.code, "request_timeout");
    await mac.waitForFrame((f) => f.type === "req.cancel");

    // 2. Relay-wide maxPendingBodyBytes returns 503 bridge_busy when pending chunks exceed cap under backpressure.
    const macSocket = (mac.ws as unknown as { _socket?: { pause: () => void; resume: () => void } })._socket;
    assert.ok(macSocket);
    macSocket.pause();

    const overflowRes = await new Promise<{ status: number; retryAfter: string | undefined; body: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: bridge.port,
          method: "POST",
          path: "/api/attachments?uploadId=over-buf",
          headers: AUTH_HEADER,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              retryAfter: typeof res.headers["retry-after"] === "string" ? res.headers["retry-after"] : undefined,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            }),
          );
        },
      );
      req.on("error", () => {});
      req.end(Buffer.alloc(4 * 1024 * 1024, 0x65));
      setTimeout(() => reject(new Error("Timed out waiting for 503 bridge_busy")), 3000).unref();
    });
    assert.equal(overflowRes.status, 503);
    assert.equal(overflowRes.retryAfter, "1");
    assert.equal(overflowRes.body.code, "bridge_busy");

    macSocket.resume();
    mac.ws.close();
  });

  it("enforces per-IP concurrent stream cap (429 + Retry-After) and per-IP HTTP rate limiting (429)", async () => {
    const bridge = await startBridge(
      makeConfig({ maxConcurrentStreamsPerIp: 2, ipRateWindowMs: 10_000, ipRateMaxRequests: 5, upstreamHeaderTimeoutMs: 5_000 }),
      { log: () => {} },
    );
    bridges.push(bridge);

    const mac = await connectMockMac(bridge.port);
    await mac.waitForFrame((f) => f.type === "hello");

    // 1. Two concurrent streams from same IP allowed; third hits 429 too_many_streams; another IP still succeeds.
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const s1 = fetch(`http://127.0.0.1:${bridge.port}/api/bots?s=1`, {
      headers: { ...AUTH_HEADER, "x-forwarded-for": "198.51.100.10" },
      signal: ac1.signal,
    });
    const s2 = fetch(`http://127.0.0.1:${bridge.port}/api/bots?s=2`, {
      headers: { ...AUTH_HEADER, "x-forwarded-for": "198.51.100.10" },
      signal: ac2.signal,
    });
    const open1 = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes("s=1"))) as Extract<BridgeFrame, { type: "req.open" }>;
    const open2 = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes("s=2"))) as Extract<BridgeFrame, { type: "req.open" }>;

    const capped = await fetch(`http://127.0.0.1:${bridge.port}/api/bots?s=3`, {
      headers: { ...AUTH_HEADER, "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(capped.status, 429);
    assert.equal(capped.headers.get("retry-after"), "1");
    assert.deepEqual(await capped.json(), { error: "Too many concurrent streams from IP", code: "too_many_streams" });

    const otherIp = fetch(`http://127.0.0.1:${bridge.port}/api/bots?other=1`, {
      headers: { ...AUTH_HEADER, "x-forwarded-for": "198.51.100.20" },
    });
    const openOther = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes("other=1"))) as Extract<BridgeFrame, { type: "req.open" }>;
    mac.sendFrame({ type: "res.head", streamId: openOther.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: openOther.streamId, chunkB64: Buffer.from("{}").toString("base64"), eof: true });
    assert.equal((await otherIp).status, 200);

    // Finish s1/s2 and verify slot is released and rate limit applies at 6th request for 198.51.100.10.
    mac.sendFrame({ type: "res.head", streamId: open1.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: open1.streamId, chunkB64: Buffer.from("{}").toString("base64"), eof: true });
    mac.sendFrame({ type: "res.head", streamId: open2.streamId, status: 200, headers: { "content-type": "application/json" } });
    mac.sendFrame({ type: "res.body", streamId: open2.streamId, chunkB64: Buffer.from("{}").toString("base64"), eof: true });
    assert.equal((await s1).status, 200);
    assert.equal((await s2).status, 200);

    for (let i = 4; i <= 5; i++) {
      const okP = fetch(`http://127.0.0.1:${bridge.port}/api/bots?s=${i}`, {
        headers: { ...AUTH_HEADER, "x-forwarded-for": "198.51.100.10" },
      });
      const o = (await mac.waitForFrame((f) => f.type === "req.open" && f.path.includes(`s=${i}`))) as Extract<BridgeFrame, { type: "req.open" }>;
      mac.sendFrame({ type: "res.head", streamId: o.streamId, status: 200, headers: { "content-type": "application/json" } });
      mac.sendFrame({ type: "res.body", streamId: o.streamId, chunkB64: Buffer.from("{}").toString("base64"), eof: true });
      assert.equal((await okP).status, 200);
    }

    const rateLimited = await fetch(`http://127.0.0.1:${bridge.port}/api/bots?s=6`, {
      headers: { ...AUTH_HEADER, "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(rateLimited.status, 429);
    assertCorsAndNoStore(rateLimited.headers);
    assert.ok(Number(rateLimited.headers.get("retry-after")) >= 1);
    assert.deepEqual(await rateLimited.json(), { error: "Rate limit exceeded", code: "rate_limited" });

    // /healthz stays exempt from rate limiting.
    const health = await fetch(`http://127.0.0.1:${bridge.port}/healthz`, {
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    assert.equal(health.status, 200);

    ac1.abort();
    ac2.abort();
    mac.ws.close();
  });
});
