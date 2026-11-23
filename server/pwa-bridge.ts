// Outbound WSS bridge client (`omb-pwa-bridge.v1`) connecting the local Mac server to the DO relay and dispatching
// sanitized, allowlisted requests to `handleRequest` over an in-memory socket without loopback trust.
import {
  Agent,
  createServer,
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { duplexPair, type Duplex } from "node:stream";
import WebSocket from "ws";

import type { PwaBridgeState, PwaBridgeStatus } from "../shared/pwa-bridge.ts";
import { gzipTunnelReplies } from "./harness/tunnel-gzip.ts";
import { loadPwaBridgeConfig, type PwaBridgeConfig } from "./pwa-bridge-config.ts";
import { PROXY_HEADERS, sanitizeSource } from "./request-auth.ts";
import { isPairingCredential } from "./sessions.ts";

export const PWA_BRIDGE_SUBPROTOCOL = "omb-pwa-bridge.v1";
export const PWA_BRIDGE_MAX_FRAME_BYTES = 512 * 1024;
export const PWA_BRIDGE_MAX_BODY_BYTES = 12 * 1024 * 1024;
export const PWA_BRIDGE_MAX_CONCURRENT_STREAMS = 128;
export const PWA_BRIDGE_MAX_WS_BUFFERED_BYTES = 64 * 1024 * 1024;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 5_000] as const;
const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const FRAME_OVERHEAD_RESERVE = 512;
const MAX_RAW_CHUNK_BYTES = Math.floor((PWA_BRIDGE_MAX_FRAME_BYTES - FRAME_OVERHEAD_RESERVE) / 4) * 3;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PROXY_HEADER_SET = new Set<string>(PROXY_HEADERS);

const BRIDGE_ALLOW: ReadonlyArray<{ methods: readonly string[]; path: RegExp }> = [
  { methods: ["GET"], path: /^\/\.well-known\/openmausbot\/environment$/ },
  { methods: ["POST"], path: /^\/api\/pair$/ },
  { methods: ["GET"], path: /^\/api\/health$/ },
  { methods: ["GET"], path: /^\/api\/edition$/ },
  { methods: ["GET"], path: /^\/api\/brand$/ },
  { methods: ["GET"], path: /^\/api\/auth\/session$/ },
  { methods: ["POST"], path: /^\/api\/auth\/stream-ticket$/ },
  { methods: ["POST"], path: /^\/api\/auth\/logout$/ },
  { methods: ["GET"], path: /^\/api\/events$/ },
  { methods: ["GET"], path: /^\/api\/config$/ },
  { methods: ["GET"], path: /^\/api\/today$/ },
  { methods: ["GET"], path: /^\/api\/announcements$/ },
  { methods: ["GET"], path: /^\/api\/workspace\/banner$/ },
  { methods: ["GET"], path: /^\/api\/notifications$/ },
  { methods: ["POST"], path: /^\/api\/notifications\/read-all$/ },
  { methods: ["POST"], path: /^\/api\/notifications\/[\w-]+\/read$/ },
  { methods: ["GET"], path: /^\/api\/needs-you$/ },
  { methods: ["GET"], path: /^\/api\/updates\/check$/ },
  { methods: ["GET"], path: /^\/api\/team-map$/ },
  { methods: ["GET"], path: /^\/api\/search$/ },
  { methods: ["POST"], path: /^\/api\/stop-line$/ },
  { methods: ["GET"], path: /^\/api\/bots$/ },
  { methods: ["GET", "PATCH"], path: /^\/api\/bots\/[\w-]+$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/profile$/ },
  { methods: ["PUT"], path: /^\/api\/bots\/order$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/messages\/[\w-]+\/edit$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/read$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/active-branch$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/compact$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/start-fresh$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/context$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/helper-followup$/ },
  { methods: ["POST", "DELETE"], path: /^\/api\/bots\/[\w-]+\/setup-request$/ },
  { methods: ["DELETE"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/queue\/[\w-]+\/steer$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+\/forks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/tasks\/[\w-]+\/title$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/respond$/ },
  { methods: ["PATCH"], path: /^\/api\/bots\/[\w-]+\/cards\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/always-allow$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/secret-cards\/[\w-]+\/(?:resume|dismiss|save)$/ },
  { methods: ["GET", "POST"], path: /^\/api\/bots\/[\w-]+\/sign-in-cards\/[\w-]+\/save-login$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/sign-in-cards\/[\w-]+\/(?:done|cancel)$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/status$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/connector-cards\/[\w-]+\/(?:resume|dismiss|authorize)$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/data$/ },
  { methods: ["POST"], path: /^\/api\/bots\/[\w-]+\/data\/page$/ },
  { methods: ["GET"], path: /^\/api\/bots\/[\w-]+\/data\/cards\/c_\d+\/image$/ },
  { methods: ["GET"], path: /^\/api\/bursts\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/bursts\/[\w-]+\/(?:run|cancel|retry|edit)$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/tool$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/app(?:\/download)?$/ },
  { methods: ["GET", "POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/file$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/export$/ },
  { methods: ["GET"], path: /^\/api\/threads\/[\w-]+\/job$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/respond$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/undo$/ },
  { methods: ["POST"], path: /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/reactions$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/interrupt$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/read$/ },
  { methods: ["DELETE"], path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/queue\/[\w-]+\/steer$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/tasks$/ },
  { methods: ["POST"], path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+\/forks$/ },
  { methods: ["POST", "PATCH", "DELETE"], path: /^\/api\/groups\/[\w-]+\/tasks\/[\w-]+$/ },
  { methods: ["PATCH"], path: /^\/api\/groups\/[\w-]+$/ },
  { methods: ["POST"], path: /^\/api\/attachments$/ },
  { methods: ["GET", "DELETE"], path: /^\/api\/attachments\/[\w.-]+$/ },
  { methods: ["POST"], path: /^\/api\/files$/ },
  { methods: ["GET"], path: /^\/api\/tts\/voices$/ },
  { methods: ["POST"], path: /^\/api\/tts\/prepare$/ },
  { methods: ["POST"], path: /^\/api\/tts\/speak$/ },
  { methods: ["GET"], path: /^\/api\/themes(?:\/[a-z0-9-]+(?:\/export)?)?$/ },
  { methods: ["GET", "HEAD"], path: /^\/api\/theme-assets\/[a-z0-9-]+\/[\w.-]+$/ },
  { methods: ["POST"], path: /^\/api\/presence\/active$/ },
  { methods: ["POST"], path: /^\/api\/presence\/here$/ },
];

export type HeaderMap = Record<string, string | string[]>;

type InboundBridgeFrame =
  | { type: "req.open"; streamId: string; method: string; path: string; headers: HeaderMap; remoteAddr: string }
  | { type: "req.body"; streamId: string; chunkB64: string; eof: boolean }
  | { type: "req.cancel"; streamId: string }
  | { type: "ping"; ts: number }
  | { type: "pong"; ts: number };

export interface PwaBridge {
  status(): PwaBridgeStatus;
  config(): PwaBridgeConfig;
  applyConfig(next: PwaBridgeConfig): void;
  stop(): void;
}

export interface PwaBridgeOptions {
  dataDir: string;
  handle: (req: IncomingMessage, res: ServerResponse) => unknown;
  managedRemoteAccessRefusal?: () => string | undefined;
  refusal?: string | null;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
  jitterFactor?: () => number;
  log?: (line: string) => void;
}

const bridgeSockets = new WeakSet<object>();

/** True only for requests dispatched through the in-memory PWA bridge virtual socket. */
export function isPwaBridgeRequest(req: IncomingMessage): boolean {
  return Boolean(req.socket && bridgeSockets.has(req.socket));
}

export function pwaBridgePairingRefusal(req: IncomingMessage, input: string): string | null {
  return isPwaBridgeRequest(req) && !isPairingCredential(input)
    ? "pair a PWA with its pairing link"
    : null;
}

export function isBridgeRouteAllowed(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return BRIDGE_ALLOW.some((rule) => rule.methods.includes(upper) && rule.path.test(path));
}

function normalizeBridgeTarget(rawPath: string): { ok: true; url: URL } | { ok: false; error: string } {
  if (!rawPath.startsWith("/") || rawPath.startsWith("//") || rawPath.includes("\\") || rawPath.includes("\0")) {
    return { ok: false, error: "invalid request path" };
  }
  let decodedPathname: string;
  try {
    const parsed = new URL(rawPath, "http://pwa-bridge.invalid");
    if (parsed.origin !== "http://pwa-bridge.invalid") {
      return { ok: false, error: "invalid request path" };
    }
    decodedPathname = decodeURIComponent(rawPath.split("?")[0] ?? rawPath);
    if (decodedPathname.includes("\\") || decodedPathname.includes("\0") || decodedPathname.split("/").includes("..")) {
      return { ok: false, error: "invalid request path" };
    }
    return { ok: true, url: parsed };
  } catch {
    return { ok: false, error: "invalid request path" };
  }
}

function sanitizeInboundHeaders(raw: unknown): HeaderMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (!key || /[\r\n:]/.test(key)) return undefined;
    if (typeof v === "string") {
      if (/[\r\n]/.test(v)) return undefined;
      out[key] = v;
    } else if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
      if (v.some((item) => /[\r\n]/.test(item))) return undefined;
      out[key] = v;
    } else {
      return undefined;
    }
  }
  return out;
}

function parseInboundFrame(rawText: string): InboundBridgeFrame | undefined {
  if (Buffer.byteLength(rawText, "utf8") > PWA_BRIDGE_MAX_FRAME_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case "req.open": {
      if (
        typeof obj.streamId !== "string" ||
        !STREAM_ID_RE.test(obj.streamId) ||
        typeof obj.method !== "string" ||
        typeof obj.path !== "string" ||
        typeof obj.remoteAddr !== "string"
      ) {
        return undefined;
      }
      const headers = sanitizeInboundHeaders(obj.headers);
      if (!headers) return undefined;
      return {
        type: "req.open",
        streamId: obj.streamId,
        method: obj.method,
        path: obj.path,
        headers,
        remoteAddr: obj.remoteAddr,
      };
    }
    case "req.body": {
      if (
        typeof obj.streamId !== "string" ||
        !STREAM_ID_RE.test(obj.streamId) ||
        typeof obj.chunkB64 !== "string" ||
        typeof obj.eof !== "boolean"
      ) {
        return undefined;
      }
      return { type: "req.body", streamId: obj.streamId, chunkB64: obj.chunkB64, eof: obj.eof };
    }
    case "req.cancel": {
      if (typeof obj.streamId !== "string" || !STREAM_ID_RE.test(obj.streamId)) return undefined;
      return { type: "req.cancel", streamId: obj.streamId };
    }
    case "ping":
    case "pong": {
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return undefined;
      return { type: obj.type, ts: obj.ts };
    }
    default:
      return undefined;
  }
}

function decodeBase64Chunk(text: string, maxDecodedBytes: number): Buffer | undefined {
  if (text.length === 0) return Buffer.alloc(0);
  if (text.length % 4 !== 0 || !B64_RE.test(text)) return undefined;
  const maxEncoded = Math.ceil(maxDecodedBytes / 3) * 4;
  if (text.length > maxEncoded) return undefined;
  const buf = Buffer.from(text, "base64");
  if (buf.length > maxDecodedBytes) return undefined;
  return buf;
}

function isSensitiveHeader(name: string): boolean {
  return (
    name === "cookie" ||
    name === "host" ||
    name.startsWith("x-openmausbot-") ||
    name.startsWith("x-omb-") ||
    PROXY_HEADER_SET.has(name) ||
    HOP_BY_HOP_HEADERS.has(name)
  );
}

function scrubHeadersObject(
  headers: IncomingHttpHeaders | HeaderMap,
  remoteAddr: string,
): { ok: true; headers: HeaderMap; declaredContentLength?: number } | { ok: false; status: number; error: string } {
  const clean: HeaderMap = {};
  let declaredContentLength: number | undefined;
  for (const [rawName, value] of Object.entries(headers)) {
    try {
      validateHeaderName(rawName);
    } catch {
      return { ok: false, status: 400, error: "invalid request header name" };
    }
    const name = rawName.toLowerCase();
    if (value === undefined || isSensitiveHeader(name)) continue;
    try {
      if (Array.isArray(value)) {
        for (const item of value) validateHeaderValue(name, item);
      } else {
        validateHeaderValue(name, value);
      }
    } catch {
      return { ok: false, status: 400, error: "invalid request header value" };
    }
    if (name === "content-length") {
      if (Array.isArray(value) || !/^\d+$/.test(value)) {
        return { ok: false, status: 400, error: "invalid content-length header" };
      }
      const parsedLength = Number(value);
      if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
        return { ok: false, status: 400, error: "invalid content-length header" };
      }
      if (parsedLength > PWA_BRIDGE_MAX_BODY_BYTES) {
        return { ok: false, status: 413, error: "Request body too large" };
      }
      declaredContentLength = parsedLength;
    }
    clean[name] = value;
  }
  clean.host = "pwa-bridge.invalid";
  clean["x-forwarded-for"] = sanitizeSource(remoteAddr || "pwa-bridge");
  return { ok: true, headers: clean, declaredContentLength };
}

function scrubIncomingRequest(req: IncomingMessage, remoteAddr: string): void {
  for (const name of Object.keys(req.headers)) {
    const lower = name.toLowerCase();
    if (
      lower === "cookie" ||
      lower.startsWith("x-openmausbot-") ||
      lower.startsWith("x-omb-") ||
      PROXY_HEADER_SET.has(lower)
    ) {
      delete req.headers[name];
    }
  }
  req.headers.host = "pwa-bridge.invalid";
  req.headers["x-forwarded-for"] = sanitizeSource(remoteAddr || "pwa-bridge");
}

function sanitizeResponseHeaders(headers: IncomingHttpHeaders): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP_HEADERS.has(lower) || lower === "set-cookie") continue;
    out[lower] = v;
  }
  return out;
}

/** Virtual socket wrapper matching `net.Socket` calls made by `http.Server` / `http.ClientRequest` while keeping
 * `remoteAddress === undefined && remoteFamily === undefined` so `ipcPeer(req)` and `isProxied(req)` are always true. */
function socketLike(socket: Duplex): Duplex {
  let idleMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = idleMs > 0 ? setTimeout(() => socket.emit("timeout"), idleMs) : null;
    timer?.unref?.();
  };
  socket.on("data", arm);
  socket.on("close", () => {
    if (timer) clearTimeout(timer);
  });
  return Object.assign(socket, {
    setTimeout(ms: number, listener?: () => void) {
      idleMs = ms;
      if (listener) socket.once("timeout", listener);
      arm();
      return socket;
    },
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
  });
}

function relayWsUrl(relayUrl: string): string | null {
  try {
    const parsed = new URL(relayUrl);
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    else if (parsed.protocol === "http:") parsed.protocol = "ws:";
    else return null;
    parsed.pathname = "/v1/bridge";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeTransportError(message: string, secret: string): string {
  let clean = message.trim();
  if (secret) clean = clean.split(secret).join("[REDACTED]");
  clean = clean.replace(/\bomb_(?:bridge|sess|pair)_[A-Za-z0-9_-]+/g, "[REDACTED]");
  return clean.slice(0, 200) || "bridge socket error";
}

function mapBridgeCloseError(code: number): string | null {
  switch (code) {
    case 4401:
      return "bridge authentication rejected (4401)";
    case 4403:
      return "bridge host forbidden (4403)";
    case 4409:
      return "bridge connection replaced by another host session (4409)";
    case 1000:
    case 1001:
      return null;
    default:
      return `bridge disconnected (${code})`;
  }
}

interface StreamMeta {
  remoteAddr: string;
  expectedMethod: string;
  expectedPath: string;
  expectedPathname: string;
  handled: boolean;
}

interface ActiveStream {
  streamId: string;
  clientReq: ReturnType<typeof httpRequest>;
  near: Duplex;
  far: Duplex;
  declaredContentLength?: number;
  bodyBytesReceived: number;
  requestEnded: boolean;
  responseStarted: boolean;
  finished: boolean;
}

export function startPwaBridge(options: PwaBridgeOptions): PwaBridge | null {
  const log = options.log ?? ((line: string) => console.log(line));
  if (options.refusal) {
    log(`pwa bridge: off on ${options.refusal}`);
    return null;
  }

  let currentConfig = loadPwaBridgeConfig(options.dataDir);
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const reconnectDelays = options.reconnectDelaysMs ?? RECONNECT_BACKOFF_MS;
  const jitter = options.jitterFactor ?? Math.random;

  let state: PwaBridgeState = "off";
  let lastConnectedAt: number | null = null;
  let lastError: string | null = null;
  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let attempt = 0;
  let lastInboundAt = 0;

  const streamMeta = new WeakMap<object, StreamMeta>();
  const streams = new Map<string, ActiveStream>();

  const sendImmediateLocalResponse = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(text),
      "cache-control": "no-store",
    });
    res.end(text);
  };

  const originServer = createServer(
    gzipTunnelReplies((req, res) => {
      const meta = streamMeta.get(req.socket);
      if (!meta || meta.handled) {
        sendImmediateLocalResponse(res, 400, { error: "one request per bridge stream" });
        req.socket.destroy();
        return;
      }
      meta.handled = true;
      const actualMethod = (req.method ?? "").toUpperCase();
      const actualUrl = req.url ?? "";
      if (
        actualMethod !== meta.expectedMethod ||
        actualUrl !== meta.expectedPath ||
        !isBridgeRouteAllowed(meta.expectedMethod, meta.expectedPathname)
      ) {
        sendImmediateLocalResponse(res, 403, {
          error: "forbidden: route not available over PWA bridge",
          code: "bridge_route_forbidden",
        });
        req.socket.destroy();
        return;
      }
      const refusal = options.managedRemoteAccessRefusal?.();
      if (refusal) {
        sendImmediateLocalResponse(res, 403, { error: refusal, code: "managed_policy" });
        req.socket.destroy();
        return;
      }
      scrubIncomingRequest(req, meta.remoteAddr);
      Promise.resolve(options.handle(req, res)).catch(() => {
        if (!res.headersSent) {
          sendImmediateLocalResponse(res, 500, { error: "request failed" });
        } else {
          res.destroy();
        }
      });
    }),
  );
  originServer.requestTimeout = 0;

  const clearTimers = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const cleanupStream = (streamId: string, destroy = true) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    stream.finished = true;
    streams.delete(streamId);
    if (destroy) {
      stream.clientReq.destroy();
      stream.near.destroy();
      stream.far.destroy();
    }
  };

  const cleanupAllStreams = () => {
    for (const streamId of streams.keys()) {
      cleanupStream(streamId, true);
    }
  };

  const closeStreamsForPolicyRefusal = (socket: WebSocket | null, refusal: string) => {
    for (const stream of streams.values()) {
      if (socket && ws === socket && socket.readyState === WebSocket.OPEN) {
        if (!stream.responseStarted) {
          sendImmediateJson(socket, stream.streamId, 403, { error: refusal, code: "managed_policy" });
        } else {
          sendFrame(socket, { type: "res.body", streamId: stream.streamId, chunkB64: "", eof: true });
        }
      }
      cleanupStream(stream.streamId, true);
    }
  };

  const sendFrame = (socket: WebSocket, frame: unknown, onFlushed?: () => void): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame), onFlushed);
    return true;
  };

  const sendImmediateJson = (socket: WebSocket, streamId: string, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    sendFrame(socket, {
      type: "res.head",
      streamId,
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(text)),
        "cache-control": "no-store",
      },
    });
    sendFrame(socket, {
      type: "res.body",
      streamId,
      chunkB64: Buffer.from(text, "utf8").toString("base64"),
      eof: true,
    });
  };

  const handleReqOpen = (socket: WebSocket, frame: Extract<InboundBridgeFrame, { type: "req.open" }>) => {
    if (streams.has(frame.streamId)) {
      sendImmediateJson(socket, frame.streamId, 400, { error: "duplicate stream id" });
      return;
    }
    if (streams.size >= PWA_BRIDGE_MAX_CONCURRENT_STREAMS) {
      sendImmediateJson(socket, frame.streamId, 503, { error: "Too many concurrent streams", code: "bridge_busy" });
      return;
    }
    const refusal = options.managedRemoteAccessRefusal?.();
    if (refusal) {
      closeStreamsForPolicyRefusal(socket, refusal);
      sendImmediateJson(socket, frame.streamId, 403, { error: refusal, code: "managed_policy" });
      return;
    }
    const target = normalizeBridgeTarget(frame.path);
    if (!target.ok) {
      sendImmediateJson(socket, frame.streamId, 400, { error: target.error });
      return;
    }
    const upperMethod = frame.method.toUpperCase();
    if (!isBridgeRouteAllowed(upperMethod, target.url.pathname)) {
      sendImmediateJson(socket, frame.streamId, 403, {
        error: "forbidden: route not available over PWA bridge",
        code: "bridge_route_forbidden",
      });
      return;
    }

    const remoteAddr = sanitizeSource(frame.remoteAddr || "pwa-bridge");
    const scrubbed = scrubHeadersObject(frame.headers, remoteAddr);
    if (!scrubbed.ok) {
      sendImmediateJson(socket, frame.streamId, scrubbed.status, { error: scrubbed.error });
      return;
    }
    if ((upperMethod === "GET" || upperMethod === "HEAD") && scrubbed.declaredContentLength !== undefined && scrubbed.declaredContentLength > 0) {
      sendImmediateJson(socket, frame.streamId, 400, { error: "unexpected request body on GET/HEAD" });
      return;
    }

    const expectedPath = target.url.pathname + target.url.search;
    const [rawNear, rawFar] = duplexPair();
    const near = socketLike(rawNear);
    const far = socketLike(rawFar);
    bridgeSockets.add(far);
    streamMeta.set(far, {
      remoteAddr,
      expectedMethod: upperMethod,
      expectedPath,
      expectedPathname: target.url.pathname,
      handled: false,
    });
    originServer.emit("connection", far);

    const streamAgent = new Agent({ keepAlive: false });
    streamAgent.createConnection = () => near;
    let clientReq: ReturnType<typeof httpRequest>;
    try {
      clientReq = httpRequest({
        method: upperMethod,
        path: expectedPath,
        headers: scrubbed.headers,
        agent: streamAgent,
      });
    } catch {
      near.destroy();
      far.destroy();
      sendImmediateJson(socket, frame.streamId, 400, { error: "invalid request parameters" });
      return;
    }
    clientReq.setTimeout(0);

    const stream: ActiveStream = {
      streamId: frame.streamId,
      clientReq,
      near,
      far,
      declaredContentLength: scrubbed.declaredContentLength,
      bodyBytesReceived: 0,
      requestEnded: false,
      responseStarted: false,
      finished: false,
    };
    streams.set(frame.streamId, stream);

    if (upperMethod === "GET" || upperMethod === "HEAD") {
      stream.requestEnded = true;
      clientReq.end();
    }

    clientReq.on("response", (proxyRes) => {
      if (stream.finished || ws !== socket || socket.readyState !== WebSocket.OPEN) {
        cleanupStream(frame.streamId, true);
        return;
      }
      const policyRefusal = options.managedRemoteAccessRefusal?.();
      if (policyRefusal) {
        closeStreamsForPolicyRefusal(socket, policyRefusal);
        return;
      }
      stream.responseStarted = true;
      sendFrame(socket, {
        type: "res.head",
        streamId: frame.streamId,
        status: proxyRes.statusCode ?? 500,
        headers: sanitizeResponseHeaders(proxyRes.headers),
      });

      proxyRes.on("data", (chunk: Buffer) => {
        if (stream.finished || ws !== socket || socket.readyState !== WebSocket.OPEN) return;
        const activeRefusal = options.managedRemoteAccessRefusal?.();
        if (activeRefusal) {
          closeStreamsForPolicyRefusal(socket, activeRefusal);
          return;
        }
        for (let offset = 0; offset < chunk.length; offset += MAX_RAW_CHUNK_BYTES) {
          const slice = chunk.subarray(offset, offset + MAX_RAW_CHUNK_BYTES);
          const overBuffered = socket.bufferedAmount >= PWA_BRIDGE_MAX_WS_BUFFERED_BYTES;
          if (overBuffered) proxyRes.pause();
          sendFrame(
            socket,
            { type: "res.body", streamId: frame.streamId, chunkB64: slice.toString("base64"), eof: false },
            overBuffered
              ? () => {
                  if (!stream.finished && socket.bufferedAmount < PWA_BRIDGE_MAX_WS_BUFFERED_BYTES) {
                    proxyRes.resume();
                  }
                }
              : undefined,
          );
        }
      });

      proxyRes.on("end", () => {
        if (stream.finished) return;
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          sendFrame(socket, { type: "res.body", streamId: frame.streamId, chunkB64: "", eof: true });
        }
        cleanupStream(frame.streamId, false);
      });

      proxyRes.on("close", () => {
        if (stream.finished) return;
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          sendFrame(socket, { type: "res.body", streamId: frame.streamId, chunkB64: "", eof: true });
        }
        cleanupStream(frame.streamId, false);
      });

      proxyRes.on("error", () => {
        if (stream.finished) return;
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          sendFrame(socket, { type: "res.body", streamId: frame.streamId, chunkB64: "", eof: true });
        }
        cleanupStream(frame.streamId, true);
      });
    });

    clientReq.on("error", () => {
      if (stream.finished) return;
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        if (!stream.responseStarted) {
          sendImmediateJson(socket, frame.streamId, 502, { error: "upstream dispatch failed" });
        } else {
          sendFrame(socket, { type: "res.body", streamId: frame.streamId, chunkB64: "", eof: true });
        }
      }
      cleanupStream(frame.streamId, true);
    });
  };

  const handleReqBody = (socket: WebSocket, frame: Extract<InboundBridgeFrame, { type: "req.body" }>) => {
    const stream = streams.get(frame.streamId);
    if (!stream || stream.finished) return;
    const refusal = options.managedRemoteAccessRefusal?.();
    if (refusal) {
      closeStreamsForPolicyRefusal(socket, refusal);
      return;
    }
    const chunk = decodeBase64Chunk(frame.chunkB64, PWA_BRIDGE_MAX_BODY_BYTES);
    if (!chunk) {
      if (!stream.responseStarted) {
        sendImmediateJson(socket, frame.streamId, 400, { error: "invalid request body chunk" });
      }
      cleanupStream(frame.streamId, true);
      return;
    }
    if (stream.requestEnded) {
      if (!stream.responseStarted) {
        sendImmediateJson(socket, frame.streamId, 400, { error: "unexpected request body after end" });
      }
      cleanupStream(frame.streamId, true);
      return;
    }
    stream.bodyBytesReceived += chunk.length;
    if (stream.bodyBytesReceived > PWA_BRIDGE_MAX_BODY_BYTES) {
      if (!stream.responseStarted) {
        sendImmediateJson(socket, frame.streamId, 413, { error: "Request body too large", code: "payload_too_large" });
      }
      cleanupStream(frame.streamId, true);
      return;
    }
    if (stream.declaredContentLength !== undefined && stream.bodyBytesReceived > stream.declaredContentLength) {
      if (!stream.responseStarted) {
        sendImmediateJson(socket, frame.streamId, 400, { error: "request body exceeds declared content-length" });
      }
      cleanupStream(frame.streamId, true);
      return;
    }
    if (frame.eof && stream.declaredContentLength !== undefined && stream.bodyBytesReceived !== stream.declaredContentLength) {
      if (!stream.responseStarted) {
        sendImmediateJson(socket, frame.streamId, 400, { error: "request body shorter than declared content-length" });
      }
      cleanupStream(frame.streamId, true);
      return;
    }
    if (chunk.length > 0) stream.clientReq.write(chunk);
    if (frame.eof) {
      stream.requestEnded = true;
      stream.clientReq.end();
    }
  };

  const canConnect = (cfg: PwaBridgeConfig): boolean =>
    Boolean(cfg.enabled && cfg.hostId && cfg.bridgeSecret && relayWsUrl(cfg.relayUrl));

  const scheduleReconnect = () => {
    if (stopped || !canConnect(currentConfig) || reconnectTimer) return;
    const baseDelay = reconnectDelays[Math.min(attempt, reconnectDelays.length - 1)] ?? 5_000;
    attempt = Math.min(attempt + 1, reconnectDelays.length - 1);
    const jitterMultiplier = 0.8 + jitter() * 0.4;
    const delayMs = Math.max(50, Math.round(baseDelay * jitterMultiplier));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
    reconnectTimer.unref?.();
  };

  const disconnectSocket = (code = 1000, reason = "bridge disabled") => {
    clearTimers();
    const existing = ws;
    ws = null;
    if (existing) {
      try {
        existing.removeAllListeners();
        // `ws` emits an async error when closing a CONNECTING socket before open; keep a no-op listener attached.
        existing.on("error", () => {});
        if (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING) {
          existing.close(code, reason);
        } else {
          existing.terminate();
        }
      } catch {
        // Ignore close errors during teardown.
      }
    }
    cleanupAllStreams();
  };

  const connect = () => {
    if (stopped || ws || !canConnect(currentConfig)) return;
    const targetUrl = relayWsUrl(currentConfig.relayUrl);
    if (!targetUrl) {
      state = "error";
      lastError = "invalid relay URL";
      return;
    }

    state = "connecting";
    const socket = new WebSocket(targetUrl, PWA_BRIDGE_SUBPROTOCOL, {
      maxPayload: PWA_BRIDGE_MAX_FRAME_BYTES,
    });
    ws = socket;

    socket.on("open", () => {
      if (ws !== socket || stopped) return;
      lastInboundAt = Date.now();
      sendFrame(socket, {
        type: "hello",
        hostId: currentConfig.hostId,
        token: currentConfig.bridgeSecret,
      });
      state = "connected";
      lastConnectedAt = Date.now();
      lastError = null;
      attempt = 0;

      heartbeatTimer = setInterval(() => {
        if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
        const refusal = options.managedRemoteAccessRefusal?.();
        if (refusal && streams.size > 0) {
          closeStreamsForPolicyRefusal(socket, refusal);
        }
        if (Date.now() - lastInboundAt > heartbeatTimeoutMs) {
          lastError = "relay heartbeat timeout";
          state = "error";
          socket.terminate();
          return;
        }
        sendFrame(socket, { type: "ping", ts: Date.now() });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    });

    socket.on("message", (data, isBinary) => {
      if (ws !== socket || stopped) return;
      lastInboundAt = Date.now();
      if (isBinary) return;
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
      const frame = parseInboundFrame(text);
      if (!frame) return;
      if (frame.type === "ping") {
        sendFrame(socket, { type: "pong", ts: frame.ts });
      } else if (frame.type === "pong") {
        // `lastInboundAt` updated above.
      } else if (frame.type === "req.open") {
        handleReqOpen(socket, frame);
      } else if (frame.type === "req.body") {
        handleReqBody(socket, frame);
      } else if (frame.type === "req.cancel") {
        cleanupStream(frame.streamId, true);
      }
    });

    socket.on("error", (err) => {
      if (ws !== socket || stopped) return;
      lastError = sanitizeTransportError(err.message || "", currentConfig.bridgeSecret);
      state = "error";
    });

    socket.on("close", (code) => {
      if (ws !== socket) return;
      ws = null;
      clearTimers();
      cleanupAllStreams();
      if (stopped || !canConnect(currentConfig)) {
        state = "off";
        return;
      }
      const mapped = mapBridgeCloseError(code);
      if (code === 4401 || code === 4403 || code === 4409) {
        state = "error";
        lastError = mapped;
      } else if (state !== "error") {
        state = "connecting";
        if (mapped) lastError = mapped;
      }
      scheduleReconnect();
    });
  };

  if (canConnect(currentConfig)) {
    connect();
  }

  return {
    status: () => ({
      state,
      lastConnectedAt,
      lastError,
      activeStreams: streams.size,
    }),
    config: () => ({ ...currentConfig }),
    applyConfig(next: PwaBridgeConfig) {
      const sameTransport =
        next.enabled === currentConfig.enabled &&
        next.relayUrl === currentConfig.relayUrl &&
        next.hostId === currentConfig.hostId &&
        next.bridgeSecret === currentConfig.bridgeSecret;
      currentConfig = { ...next };
      if (stopped) return;
      if (sameTransport && (ws || !canConnect(currentConfig))) {
        return;
      }
      disconnectSocket(1000, "bridge reconfigured");
      attempt = 0;
      if (canConnect(currentConfig)) {
        lastError = null;
        connect();
      } else {
        state = "off";
        lastError = currentConfig.enabled ? "missing relay URL, hostId, or bridgeSecret" : null;
      }
    },
    stop() {
      stopped = true;
      disconnectSocket(1000, "server shutdown");
      originServer.closeAllConnections();
      state = "off";
    },
  };
}
