import { createHash } from "node:crypto";

export const BRIDGE_SUBPROTOCOL = "omb-pwa-bridge.v1";

export const CloseCode = {
  Malformed: 4400,
  Unauthorized: 4401,
  ForbiddenHost: 4403,
  Replaced: 4409,
  Unavailable: 4503,
} as const;

export type HeaderMap = Record<string, string | string[]>;

export type BridgeFrame =
  | { type: "hello"; hostId: string; token?: string }
  | { type: "req.open"; streamId: string; method: string; path: string; headers: HeaderMap; remoteAddr: string }
  | { type: "req.body"; streamId: string; chunkB64: string; eof: boolean }
  | { type: "req.cancel"; streamId: string }
  | { type: "res.head"; streamId: string; status: number; headers: HeaderMap; invalidMetadata?: boolean }
  | { type: "res.body"; streamId: string; chunkB64: string; eof: boolean }
  | { type: "ping"; ts: number }
  | { type: "pong"; ts: number };

const STREAM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const FORBIDDEN_HEADER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sha256Hex(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function decodeBase64Chunk(text: unknown, maxDecodedBytes: number): Buffer | undefined {
  if (typeof text !== "string") return undefined;
  if (text.length === 0) return Buffer.alloc(0);
  if (text.length % 4 !== 0 || !B64_RE.test(text)) return undefined;
  const maxEncoded = Math.ceil(maxDecodedBytes / 3) * 4;
  if (text.length > maxEncoded) return undefined;
  const buf = Buffer.from(text, "base64");
  if (buf.length > maxDecodedBytes) return undefined;
  return buf;
}

function sanitizeHeaders(raw: unknown, strictRequestCheck: boolean): HeaderMap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out = Object.create(null) as HeaderMap;
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (!key || FORBIDDEN_HEADER_KEYS.has(key)) return undefined;
    if (strictRequestCheck && /[\r\n:]/.test(key)) return undefined;
    if (typeof v === "string") {
      if (strictRequestCheck && /[\r\n]/.test(v)) return undefined;
      out[key] = v;
    } else if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
      if (strictRequestCheck && v.some((item) => /[\r\n]/.test(item))) return undefined;
      out[key] = v;
    } else {
      return undefined;
    }
  }
  return out;
}

export function parseBridgeFrame(rawText: string, maxFrameBytes: number): BridgeFrame | undefined {
  if (Buffer.byteLength(rawText, "utf8") > maxFrameBytes) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") return undefined;

  switch (type) {
    case "hello": {
      if (typeof obj.hostId !== "string" || obj.hostId.length === 0 || obj.hostId.length > 64) return undefined;
      if (obj.token !== undefined && (typeof obj.token !== "string" || obj.token.length === 0 || obj.token.length > 512)) {
        return undefined;
      }
      return { type: "hello", hostId: obj.hostId, ...(obj.token !== undefined ? { token: obj.token } : {}) };
    }
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
      const headers = sanitizeHeaders(obj.headers, true);
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
    case "req.body":
    case "res.body": {
      if (
        typeof obj.streamId !== "string" ||
        !STREAM_ID_RE.test(obj.streamId) ||
        typeof obj.chunkB64 !== "string" ||
        typeof obj.eof !== "boolean"
      ) {
        return undefined;
      }
      return { type, streamId: obj.streamId, chunkB64: obj.chunkB64, eof: obj.eof };
    }
    case "req.cancel": {
      if (typeof obj.streamId !== "string" || !STREAM_ID_RE.test(obj.streamId)) return undefined;
      return { type: "req.cancel", streamId: obj.streamId };
    }
    case "res.head": {
      if (typeof obj.streamId !== "string" || !STREAM_ID_RE.test(obj.streamId)) {
        return undefined;
      }
      const validStatus =
        typeof obj.status === "number" && Number.isInteger(obj.status) && obj.status >= 100 && obj.status <= 599;
      const headers = sanitizeHeaders(obj.headers, false);
      if (!validStatus || !headers) {
        return {
          type: "res.head",
          streamId: obj.streamId,
          status: validStatus ? (obj.status as number) : 0,
          headers: headers ?? {},
          invalidMetadata: true,
        };
      }
      return { type: "res.head", streamId: obj.streamId, status: obj.status as number, headers };
    }
    case "ping":
    case "pong": {
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return undefined;
      return { type, ts: obj.ts };
    }
    default:
      return undefined;
  }
}

/** Max raw chunk bytes whose base64 + JSON envelope stays strictly within `maxFrameBytes`. */
export function maxRawChunkForFrame(maxFrameBytes: number): number {
  const overhead = 256;
  const availableB64 = Math.max(4, maxFrameBytes - overhead);
  return Math.floor(availableB64 / 4) * 3;
}
