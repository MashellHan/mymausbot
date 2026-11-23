import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { WebSocket } from "ws";
import { startBridge, type BridgeServer } from "../src/bridge.ts";
import { loadConfig, type BridgeConfig } from "../src/config.ts";
import type { BridgeLogEvent } from "../src/log.ts";
import { BRIDGE_SUBPROTOCOL, CloseCode, type BridgeFrame } from "../src/wire.ts";

const SECRET = "bridge-secret-value-123456";
const SECRET_SHA256 = createHash("sha256").update(SECRET, "utf8").digest("hex");
const PWA_ORIGIN = "https://mausbot.mxhan.com";
const HOST_ID = "mac-mini-test";

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

  it("returns 503 mac_offline fast with CORS + no-store when Mac is disconnected and answers OPTIONS", async () => {
    const bridge = await startBridge(makeConfig(), { log: () => {} });
    bridges.push(bridge);

    const health = await fetch(`http://127.0.0.1:${bridge.port}/healthz`);
    assert.equal(health.status, 200);
    assertCorsAndNoStore(health.headers);
    assert.deepEqual(await health.json(), { ok: true, hostConnected: false });

    const preflight = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assertCorsAndNoStore(preflight.headers);

    const start = Date.now();
    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`);
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
        "x-omb-background": "1",
      },
      body: JSON.stringify({ text: "lunch 42rmb secret_body_marker" }),
    });

    const open = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    assert.equal(open.method, "POST");
    assert.equal(open.path, "/api/bots/b1/messages?ticket=secret-ticket-999");
    assert.equal(open.headers.authorization, "Bearer omb_sess_secret_token_xyz");
    assert.equal(open.headers["x-omb-background"], "1");

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

    const pendingHttp = fetch(`http://127.0.0.1:${bridge.port}/api/bots`);
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
    const okReq = fetch(`http://127.0.0.1:${bridge.port}/api/health`);
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

    const res = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`);
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
      headers: { "x-forwarded-for": "203.0.113.42" },
    });
    const firstOpen = (await mac.waitForFrame((f) => f.type === "req.open")) as Extract<BridgeFrame, { type: "req.open" }>;
    assert.equal(firstOpen.remoteAddr, "203.0.113.42");

    const secondRes = await fetch(`http://127.0.0.1:${bridge.port}/api/bots`);
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
});
