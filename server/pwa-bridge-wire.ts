// Wire framing, route allowlist, header scrubbing, and virtual socket helpers for the Mac PWA bridge.
import {
  validateHeaderName,
  validateHeaderValue,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import type { Duplex } from "node:stream";

import { PROXY_HEADERS, sanitizeSource } from "./request-auth.ts";

export const PWA_BRIDGE_SUBPROTOCOL = "omb-pwa-bridge.v1";
export const PWA_BRIDGE_MAX_FRAME_BYTES = 512 * 1024;
export const PWA_BRIDGE_MAX_BODY_BYTES = 12 * 1024 * 1024;
export const PWA_BRIDGE_MAX_PENDING_BODY_BYTES = 32 * 1024 * 1024;
export const PWA_BRIDGE_MAX_CONCURRENT_STREAMS = 128;
export const PWA_BRIDGE_MAX_WS_BUFFERED_BYTES = 64 * 1024 * 1024;

const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const FRAME_OVERHEAD_RESERVE = 512;
export const MAX_RAW_CHUNK_BYTES = Math.floor((PWA_BRIDGE_MAX_FRAME_BYTES - FRAME_OVERHEAD_RESERVE) / 4) * 3;

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

export type InboundBridgeFrame =
  | { type: "req.open"; streamId: string; method: string; path: string; headers: HeaderMap; remoteAddr: string }
  | { type: "req.body"; streamId: string; chunkB64: string; eof: boolean }
  | { type: "req.cancel"; streamId: string }
  | { type: "ping"; ts: number }
  | { type: "pong"; ts: number };

export function isBridgeRouteAllowed(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return BRIDGE_ALLOW.some((rule) => rule.methods.includes(upper) && rule.path.test(path));
}

export function normalizeBridgeTarget(rawPath: string): { ok: true; url: URL } | { ok: false; error: string } {
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

function appendHeaderValue(out: HeaderMap, key: string, next: string | string[]): void {
  if (Object.hasOwn(out, key)) {
    const existing = out[key];
    out[key] = Array.isArray(existing)
      ? Array.isArray(next)
        ? [...existing, ...next]
        : [...existing, next]
      : Array.isArray(next)
        ? [existing, ...next]
        : [existing, next];
    return;
  }
  out[key] = next;
}

function sanitizeInboundHeaders(raw: unknown): HeaderMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (!key || key === "__proto__" || /[\r\n:]/.test(key)) return undefined;
    if (typeof v === "string") {
      if (/[\r\n]/.test(v)) return undefined;
      appendHeaderValue(out, key, v);
    } else if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
      if (v.some((item) => /[\r\n]/.test(item))) return undefined;
      appendHeaderValue(out, key, v);
    } else {
      return undefined;
    }
  }
  return out;
}

export function parseInboundFrame(rawText: string): InboundBridgeFrame | undefined {
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

export function decodeBase64Chunk(text: string, maxDecodedBytes: number): Buffer | undefined {
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

export function scrubHeadersObject(
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
      if (declaredContentLength !== undefined || Array.isArray(value)) {
        return { ok: false, status: 400, error: "duplicate content-length header" };
      }
      if (!/^\d+$/.test(value)) {
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

export function scrubIncomingRequest(req: IncomingMessage, remoteAddr: string): void {
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

export function sanitizeResponseHeaders(headers: IncomingHttpHeaders): HeaderMap {
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
export function socketLike(socket: Duplex): Duplex {
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

export function relayWsUrl(relayUrl: string): string | null {
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

export function sanitizeTransportError(message: string, secret: string): string {
  let clean = message.trim();
  if (secret) clean = clean.split(secret).join("[REDACTED]");
  clean = clean.replace(/\bomb_(?:bridge|sess|pair)_[A-Za-z0-9_-]+/g, "[REDACTED]");
  return clean.slice(0, 200) || "bridge socket error";
}

export function mapBridgeCloseError(code: number): string | null {
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
