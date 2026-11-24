import { randomUUID } from "node:crypto";
import {
  createServer,
  validateHeaderName,
  validateHeaderValue,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { verifyHostTokenHash, type BridgeConfig } from "./config.ts";
import { createJsonLogger, type BridgeLogger } from "./log.ts";
import {
  BRIDGE_SUBPROTOCOL,
  CloseCode,
  decodeBase64Chunk,
  maxRawChunkForFrame,
  parseBridgeFrame,
  sha256Hex,
  type HeaderMap,
} from "./wire.ts";

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

const HOP_BY_HOP_AND_MANAGED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "vary",
  "cache-control",
  "set-cookie",
  "x-content-type-options",
]);

interface InFlightStream {
  streamId: string;
  res: ServerResponse;
  req: IncomingMessage;
  headersSent: boolean;
  finished: boolean;
  hasRequestBody: boolean;
  bodyEnded: boolean;
  uploadEofSent: boolean;
  headerTimer: NodeJS.Timeout | undefined;
  bodyTimer: NodeJS.Timeout | undefined;
  bodyBytesReceived: number;
  pendingBytes: number;
  isSse: boolean;
  pausedForBackpressure: boolean;
  pendingChunks: Buffer[];
  pendingEof: boolean;
  onDrain: () => void;
}

interface HostSession {
  ws: WebSocket;
  hostId: string;
  streams: Map<string, InFlightStream>;
  pingTimer: NodeJS.Timeout | undefined;
  awaitingPong: boolean;
  missedPongs: number;
  drainWaiters: Set<() => void>;
}

export interface BridgeServer {
  readonly port: number;
  readonly hostConnected: () => boolean;
  drain(): Promise<void>;
  close(): Promise<void>;
}

function isLoopbackAddr(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function sanitizeRemoteAddr(value: string): string {
  const clean = value.replace(/[^\w.:%[\]-]/g, "");
  return (clean || "0.0.0.0").slice(0, 64);
}

function resolveRemoteAddr(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "";
  if (isLoopbackAddr(peer)) {
    const raw = req.headers["x-forwarded-for"];
    const xff = Array.isArray(raw) ? raw.join(",") : raw;
    if (typeof xff === "string") {
      const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
      const last = hops.length > 0 ? hops[hops.length - 1] : "";
      if (last) return sanitizeRemoteAddr(last);
    }
  }
  return sanitizeRemoteAddr(peer || "0.0.0.0");
}

function rawDataByteLength(raw: RawData): number {
  if (Buffer.isBuffer(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  if (Array.isArray(raw)) {
    let total = 0;
    for (const buf of raw) total += buf.byteLength;
    return total;
  }
  return Buffer.byteLength(String(raw), "utf8");
}

function rawDataToUtf8(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return String(raw);
}

function pathnameOf(urlText: string | undefined): string {
  if (!urlText) return "/";
  const q = urlText.indexOf("?");
  return q === -1 ? urlText : urlText.slice(0, q);
}

function isUploadPath(pathname: string): boolean {
  return pathname.startsWith("/api/attachments") || pathname.startsWith("/api/files");
}

function applyCorsAndNoStore(res: ServerResponse, pwaOrigin: string): void {
  res.setHeader("Access-Control-Allow-Origin", pwaOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-omb-background");
  res.setHeader("Access-Control-Expose-Headers", "Retry-After");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function closeRequestAfterError(req: IncomingMessage, res: ServerResponse): void {
  if (!req.readableEnded && !req.destroyed) {
    req.resume();
  }
  const timer = setTimeout(() => {
    if (!req.destroyed) req.destroy();
  }, 500);
  timer.unref();
  req.once("end", () => {
    clearTimeout(timer);
    if (!req.destroyed) req.destroy();
  });
  res.socket?.once("close", () => clearTimeout(timer));
}

function sendJsonError(
  res: ServerResponse,
  pwaOrigin: string,
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
  onFlushed?: () => void,
): void {
  if (res.writableEnded) {
    onFlushed?.();
    return;
  }
  if (!res.headersSent) {
    applyCorsAndNoStore(res, pwaOrigin);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    }
    res.statusCode = status;
  }
  res.end(JSON.stringify(body), onFlushed);
}

function filterRequestHeaders(raw: IncomingMessage["headers"]): HeaderMap {
  const out: HeaderMap = {};
  for (const [k, v] of Object.entries(raw)) {
    const lower = k.toLowerCase();
    if (
      v === undefined ||
      HOP_BY_HOP_REQUEST_HEADERS.has(lower) ||
      lower === "cookie" ||
      lower === "host" ||
      lower.startsWith("x-openmausbot-") ||
      lower.startsWith("x-omb-")
    ) {
      continue;
    }
    out[lower] = v;
  }
  return out;
}

function sendWsPayload(ws: WebSocket, payload: string, onFlushed?: () => void): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(payload, onFlushed);
  return true;
}

function sendSessionPayload(session: HostSession, payload: string, maxWsBufferedBytes: number): boolean {
  return sendWsPayload(session.ws, payload, () => {
    if (session.ws.bufferedAmount < maxWsBufferedBytes && session.drainWaiters.size > 0) {
      const waiters = Array.from(session.drainWaiters);
      session.drainWaiters.clear();
      for (const wake of waiters) wake();
    }
  });
}

function sendFrame(ws: WebSocket, frame: unknown): boolean {
  return sendWsPayload(ws, JSON.stringify(frame));
}

function validateUpstreamHeaders(headers: HeaderMap): Array<[string, string | string[]]> | undefined {
  const filtered: Array<[string, string | string[]]> = [];
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP_AND_MANAGED_RESPONSE_HEADERS.has(lower)) continue;
    try {
      validateHeaderName(lower);
      if (typeof v === "string") {
        validateHeaderValue(lower, v);
      } else {
        for (const item of v) validateHeaderValue(lower, item);
      }
    } catch {
      return undefined;
    }
    filtered.push([lower, v]);
  }
  return filtered;
}

export async function startBridge(
  config: BridgeConfig,
  options: { log?: BridgeLogger } = {},
): Promise<BridgeServer> {
  const log = options.log ?? createJsonLogger();
  const maxRawChunk = maxRawChunkForFrame(config.maxFrameBytes);
  const maxPendingBodyBytes = config.maxPendingBodyBytes ?? 32 * 1024 * 1024;
  const idleUploadTimeoutMs = config.idleUploadTimeoutMs ?? 10_000;
  const maxPendingAuth = config.maxPendingAuth ?? 16;
  const preAuthMaxFrameBytes = config.preAuthMaxFrameBytes ?? 4096;
  const authFailWindowMs = config.authFailWindowMs ?? 60_000;
  const authMaxFailures = config.authMaxFailures ?? 5;
  const authBlockMs = config.authBlockMs ?? 60_000;

  let activeHost: HostSession | null = null;
  let draining = false;
  let pendingBodyBytes = 0;
  let pendingAuthCount = 0;
  const pendingAuthReleases = new WeakMap<WebSocket, () => void>();
  const authFailures = new Map<string, { count: number; windowStart: number; blockedUntil: number }>();

  const isAuthBlocked = (ip: string, now = Date.now()): boolean => {
    const rec = authFailures.get(ip);
    if (!rec) return false;
    if (rec.blockedUntil > now) return true;
    if (now - rec.windowStart > authFailWindowMs) {
      authFailures.delete(ip);
    }
    return false;
  };

  const recordAuthFailure = (ip: string, now = Date.now()): void => {
    let rec = authFailures.get(ip);
    if (!rec || now - rec.windowStart > authFailWindowMs) {
      if (!rec && authFailures.size >= 4096) {
        for (const [k, v] of authFailures) {
          if (v.blockedUntil <= now && now - v.windowStart > authFailWindowMs) {
            authFailures.delete(k);
          }
        }
        if (authFailures.size >= 4096) {
          const oldest = authFailures.keys().next().value;
          if (oldest !== undefined) authFailures.delete(oldest);
        }
      }
      rec = { count: 1, windowStart: now, blockedUntil: 0 };
      authFailures.set(ip, rec);
    } else {
      rec.count += 1;
    }
    if (rec.count >= authMaxFailures) {
      rec.blockedUntil = now + authBlockMs;
    }
  };

  const clearBodyTimer = (stream: InFlightStream) => {
    if (stream.bodyTimer) {
      clearTimeout(stream.bodyTimer);
      stream.bodyTimer = undefined;
    }
  };

  const cleanupStreamUpload = (host: HostSession, stream: InFlightStream, cancelIfUnfinished: boolean) => {
    clearBodyTimer(stream);
    if (stream.pendingBytes > 0) {
      pendingBodyBytes = Math.max(0, pendingBodyBytes - stream.pendingBytes);
      stream.pendingBytes = 0;
    }
    stream.pendingChunks.length = 0;
    stream.pendingEof = false;
    stream.pausedForBackpressure = false;
    host.drainWaiters.delete(stream.onDrain);
    if (cancelIfUnfinished && stream.hasRequestBody && !stream.uploadEofSent) {
      sendFrame(host.ws, { type: "req.cancel", streamId: stream.streamId });
    }
  };

  const failStream = (
    host: HostSession,
    stream: InFlightStream,
    status: number,
    code: string,
    message: string,
    cancelUpstream: boolean,
  ) => {
    if (!host.streams.delete(stream.streamId)) return;
    stream.finished = true;
    cleanupStreamUpload(host, stream, false);
    if (stream.headerTimer) clearTimeout(stream.headerTimer);
    if (cancelUpstream) {
      sendFrame(host.ws, { type: "req.cancel", streamId: stream.streamId });
    }
    const closeReqAfterEnd = !stream.req.readableEnded && !stream.req.destroyed;
    if (!stream.headersSent && !stream.res.writableEnded) {
      log({ ev: "stream_error", status, reason: code });
      const extraHeaders: Record<string, string> = {};
      if (code === "bridge_busy") extraHeaders["Retry-After"] = "1";
      if (closeReqAfterEnd) extraHeaders.Connection = "close";
      sendJsonError(
        stream.res,
        config.pwaOrigin,
        status,
        { error: message, code },
        Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
        closeReqAfterEnd
          ? () => {
              closeRequestAfterError(stream.req, stream.res);
            }
          : undefined,
      );
    } else {
      if (!stream.res.writableEnded) stream.res.destroy();
      if (!stream.req.destroyed) stream.req.destroy();
    }
  };

  const armBodyTimer = (host: HostSession, stream: InFlightStream) => {
    clearBodyTimer(stream);
    if (stream.finished || stream.bodyEnded || stream.pausedForBackpressure || !stream.hasRequestBody) return;
    stream.bodyTimer = setTimeout(() => {
      failStream(host, stream, 408, "request_timeout", "Request body timed out", true);
    }, idleUploadTimeoutMs);
  };

  const flushStreamBody = (host: HostSession, stream: InFlightStream) => {
    if (stream.finished || !host.streams.has(stream.streamId) || host.ws.readyState !== WebSocket.OPEN) return;
    while (stream.pendingChunks.length > 0) {
      if (host.ws.bufferedAmount >= config.maxWsBufferedBytes) {
        if (!stream.pausedForBackpressure) {
          stream.pausedForBackpressure = true;
          clearBodyTimer(stream);
          stream.req.pause();
        }
        host.drainWaiters.add(stream.onDrain);
        return;
      }
      const head = stream.pendingChunks[0]!;
      const slice = head.length <= maxRawChunk ? stream.pendingChunks.shift()! : head.subarray(0, maxRawChunk);
      if (head.length > maxRawChunk) {
        stream.pendingChunks[0] = head.subarray(maxRawChunk);
      }
      if (stream.pendingBytes > 0) {
        pendingBodyBytes = Math.max(0, pendingBodyBytes - slice.length);
        stream.pendingBytes = Math.max(0, stream.pendingBytes - slice.length);
      }
      sendSessionPayload(
        host,
        JSON.stringify({
          type: "req.body",
          streamId: stream.streamId,
          chunkB64: slice.toString("base64"),
          eof: false,
        }),
        config.maxWsBufferedBytes,
      );
    }
    if (stream.pendingEof) {
      if (host.ws.bufferedAmount >= config.maxWsBufferedBytes) {
        host.drainWaiters.add(stream.onDrain);
        return;
      }
      stream.pendingEof = false;
      stream.uploadEofSent = true;
      sendSessionPayload(
        host,
        JSON.stringify({
          type: "req.body",
          streamId: stream.streamId,
          chunkB64: "",
          eof: true,
        }),
        config.maxWsBufferedBytes,
      );
    }
    if (stream.pausedForBackpressure) {
      stream.pausedForBackpressure = false;
      stream.req.resume();
      armBodyTimer(host, stream);
    }
  };

  const teardownHost = (host: HostSession, code: number, closeWs: boolean, reason?: string) => {
    if (host.pingTimer) {
      clearInterval(host.pingTimer);
      host.pingTimer = undefined;
    }
    host.drainWaiters.clear();
    const inFlight = host.streams.size;
    if (activeHost === host) {
      activeHost = null;
    }
    const streams = Array.from(host.streams.values());
    for (const stream of streams) {
      failStream(host, stream, 503, "mac_offline", "Mac host is offline", false);
    }
    if (closeWs) {
      if (host.ws.readyState === WebSocket.OPEN) {
        host.ws.close(code, reason);
      } else if (host.ws.readyState === WebSocket.CONNECTING) {
        host.ws.terminate();
      }
    }
    log({ ev: "host_disconnect", hostId: host.hostId, code, inFlight });
  };

  const httpServer: Server = createServer((req, res) => {
    const pathname = pathnameOf(req.url);

    if (req.method === "OPTIONS") {
      applyCorsAndNoStore(res, config.pwaOrigin);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/healthz") {
      applyCorsAndNoStore(res, config.pwaOrigin);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          hostConnected: activeHost !== null && activeHost.ws.readyState === WebSocket.OPEN && !draining,
        }),
      );
      return;
    }

    if (draining || !activeHost || activeHost.ws.readyState !== WebSocket.OPEN) {
      sendJsonError(res, config.pwaOrigin, 503, { error: "Mac host is offline", code: "mac_offline" });
      return;
    }

    const host = activeHost;
    if (
      host.streams.size >= config.maxConcurrentStreams ||
      host.ws.bufferedAmount >= config.maxWsBufferedBytes ||
      pendingBodyBytes >= maxPendingBodyBytes
    ) {
      sendJsonError(
        res,
        config.pwaOrigin,
        503,
        { error: "Too many concurrent requests", code: "bridge_busy" },
        { "Retry-After": "1" },
      );
      return;
    }

    const contentLengthHeader = req.headers["content-length"];
    if (typeof contentLengthHeader === "string") {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
        const closeAfter = !req.readableEnded && !req.destroyed;
        sendJsonError(
          res,
          config.pwaOrigin,
          413,
          { error: "Request body too large", code: "payload_too_large" },
          closeAfter ? { Connection: "close" } : undefined,
          closeAfter
            ? () => {
                closeRequestAfterError(req, res);
              }
            : undefined,
        );
        return;
      }
    }

    const streamId = randomUUID();
    const openPayload = JSON.stringify({
      type: "req.open",
      streamId,
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: filterRequestHeaders(req.headers),
      remoteAddr: resolveRemoteAddr(req),
    });
    if (Buffer.byteLength(openPayload, "utf8") > config.maxFrameBytes) {
      const closeAfter = !req.readableEnded && !req.destroyed;
      sendJsonError(
        res,
        config.pwaOrigin,
        431,
        { error: "Request headers too large", code: "headers_too_large" },
        closeAfter ? { Connection: "close" } : undefined,
        closeAfter
          ? () => {
              closeRequestAfterError(req, res);
            }
          : undefined,
      );
      return;
    }

    const headerTimeoutMs = isUploadPath(pathname) ? config.uploadHeaderTimeoutMs : config.upstreamHeaderTimeoutMs;
    const hasRequestBody =
      (typeof contentLengthHeader === "string" && Number(contentLengthHeader) > 0) ||
      req.headers["transfer-encoding"] !== undefined;

    const stream: InFlightStream = {
      streamId,
      res,
      req,
      headersSent: false,
      finished: false,
      hasRequestBody,
      bodyEnded: false,
      uploadEofSent: false,
      headerTimer: undefined,
      bodyTimer: undefined,
      bodyBytesReceived: 0,
      pendingBytes: 0,
      isSse: false,
      pausedForBackpressure: false,
      pendingChunks: [],
      pendingEof: false,
      onDrain: () => flushStreamBody(host, stream),
    };

    host.streams.set(streamId, stream);

    stream.headerTimer = setTimeout(() => {
      failStream(host, stream, 504, "upstream_timeout", "Upstream response timed out", true);
    }, headerTimeoutMs);

    const opened = sendSessionPayload(host, openPayload, config.maxWsBufferedBytes);

    if (!opened) {
      failStream(host, stream, 503, "mac_offline", "Mac host is offline", false);
      return;
    }

    if (stream.hasRequestBody) {
      armBodyTimer(host, stream);
    }

    const onClientAbort = () => {
      if (!stream.finished && host.streams.has(streamId)) {
        stream.finished = true;
        cleanupStreamUpload(host, stream, false);
        if (stream.headerTimer) clearTimeout(stream.headerTimer);
        host.streams.delete(streamId);
        sendFrame(host.ws, { type: "req.cancel", streamId });
      }
    };

    res.on("close", onClientAbort);
    req.on("aborted", onClientAbort);

    let bodyExceeded = false;
    let bodyDone = false;

    req.on("data", (chunk: Buffer) => {
      if (bodyExceeded || bodyDone || stream.finished || !host.streams.has(streamId)) return;
      if (chunk.length > 0) stream.hasRequestBody = true;
      stream.bodyBytesReceived += chunk.length;
      if (stream.bodyBytesReceived > config.maxBodyBytes) {
        bodyExceeded = true;
        failStream(host, stream, 413, "payload_too_large", "Request body too large", true);
        return;
      }
      armBodyTimer(host, stream);
      stream.pendingChunks.push(chunk);
      stream.pendingBytes += chunk.length;
      pendingBodyBytes += chunk.length;
      flushStreamBody(host, stream);
      if (!stream.finished && pendingBodyBytes > maxPendingBodyBytes) {
        bodyExceeded = true;
        failStream(host, stream, 503, "bridge_busy", "Relay request buffer full", true);
      }
    });

    req.on("end", () => {
      if (bodyExceeded || bodyDone || stream.finished || !host.streams.has(streamId)) return;
      bodyDone = true;
      stream.bodyEnded = true;
      clearBodyTimer(stream);
      stream.pendingEof = true;
      flushStreamBody(host, stream);
    });

    req.on("error", () => {
      if (!bodyDone && !stream.finished && host.streams.has(streamId)) {
        failStream(host, stream, 400, "request_error", "Client request stream failed", true);
      }
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxFrameBytes,
    handleProtocols: (protocols) => (protocols.has(BRIDGE_SUBPROTOCOL) ? BRIDGE_SUBPROTOCOL : false),
  });

  httpServer.on("upgrade", (req, socket, head) => {
    if (draining || pathnameOf(req.url) !== "/v1/bridge") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const remoteIp = resolveRemoteAddr(req);
    if (isAuthBlocked(remoteIp)) {
      log({ ev: "host_reject", code: CloseCode.Unauthorized, reason: "auth_throttled" });
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n");
      socket.destroy();
      return;
    }
    if (pendingAuthCount >= maxPendingAuth) {
      log({ ev: "host_reject", code: CloseCode.Unavailable, reason: "too_many_pending_auth" });
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    let promoted = false;
    let pendingReleased = false;
    const releasePendingAuth = () => {
      if (pendingReleased) return;
      pendingReleased = true;
      pendingAuthCount = Math.max(0, pendingAuthCount - 1);
    };
    pendingAuthCount += 1;
    socket.once("close", () => {
      if (!promoted) releasePendingAuth();
    });
    wss.handleUpgrade(req, socket, head, (ws) => {
      promoted = true;
      if (socket.destroyed) {
        releasePendingAuth();
        return;
      }
      pendingAuthReleases.set(ws, releasePendingAuth);
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const releasePendingAuth = pendingAuthReleases.get(ws) ?? (() => {});
    ws.once("close", releasePendingAuth);
    const remoteIp = resolveRemoteAddr(req);

    if (ws.protocol !== BRIDGE_SUBPROTOCOL) {
      releasePendingAuth();
      log({ ev: "host_reject", code: CloseCode.Malformed, reason: "subprotocol" });
      ws.close(CloseCode.Malformed, "missing subprotocol");
      return;
    }

    if (isAuthBlocked(remoteIp)) {
      releasePendingAuth();
      log({ ev: "host_reject", code: CloseCode.Unauthorized, reason: "auth_throttled" });
      ws.close(CloseCode.Unauthorized, "too many auth failures");
      return;
    }

    let authedSession: HostSession | null = null;
    const authTimer = setTimeout(() => {
      if (!authedSession) {
        log({ ev: "host_reject", code: CloseCode.Malformed, reason: "auth_timeout" });
        if (ws.readyState === WebSocket.OPEN) ws.close(CloseCode.Malformed, "auth timeout");
      }
    }, config.authDeadlineMs);

    ws.once("close", (code) => {
      clearTimeout(authTimer);
      if (authedSession) {
        teardownHost(authedSession, code || 1006, false);
      }
    });

    ws.on("error", () => {
      clearTimeout(authTimer);
      releasePendingAuth();
      if (authedSession) {
        authedSession.ws.terminate();
        teardownHost(authedSession, 1006, false);
      }
    });

    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (!authedSession) {
          log({ ev: "host_reject", code: CloseCode.Malformed, reason: "binary_pre_auth" });
          ws.close(CloseCode.Malformed, "binary frame");
        } else {
          teardownHost(authedSession, CloseCode.Malformed, true, "binary frame");
        }
        return;
      }

      if (!authedSession && rawDataByteLength(raw) > preAuthMaxFrameBytes) {
        log({ ev: "host_reject", code: CloseCode.Malformed, reason: "pre_auth_payload_too_large" });
        ws.close(CloseCode.Malformed, "pre-auth frame too large");
        return;
      }

      const text = rawDataToUtf8(raw);
      const frame = parseBridgeFrame(text, !authedSession ? preAuthMaxFrameBytes : config.maxFrameBytes);
      if (!frame) {
        if (!authedSession) {
          log({ ev: "host_reject", code: CloseCode.Malformed, reason: "malformed_frame" });
          ws.close(CloseCode.Malformed, "malformed frame");
        } else {
          teardownHost(authedSession, CloseCode.Malformed, true, "malformed frame");
        }
        return;
      }

      if (!authedSession) {
        clearTimeout(authTimer);
        if (frame.type !== "hello") {
          log({ ev: "host_reject", code: CloseCode.Malformed, reason: "expected_hello" });
          ws.close(CloseCode.Malformed, "expected hello");
          return;
        }
        if (frame.hostId !== config.pinnedHostId) {
          recordAuthFailure(remoteIp);
          log({ ev: "host_reject", code: CloseCode.ForbiddenHost, reason: "wrong_host_id" });
          ws.close(CloseCode.ForbiddenHost, "forbidden host");
          return;
        }
        if (!frame.token || !verifyHostTokenHash(frame.hostId, sha256Hex(frame.token), config.hostTokenHashes)) {
          recordAuthFailure(remoteIp);
          log({ ev: "host_reject", code: CloseCode.Unauthorized, reason: "invalid_token" });
          ws.close(CloseCode.Unauthorized, "unauthorized");
          return;
        }
        if (draining) {
          ws.close(CloseCode.Unavailable, "shutting down");
          return;
        }

        authFailures.delete(remoteIp);
        releasePendingAuth();

        if (activeHost) {
          const stale = activeHost;
          const abortedStreams = stale.streams.size;
          log({ ev: "host_replaced", hostId: stale.hostId, abortedStreams });
          teardownHost(stale, CloseCode.Replaced, true, "replaced");
        }

        const session: HostSession = {
          ws,
          hostId: frame.hostId,
          streams: new Map(),
          pingTimer: undefined,
          awaitingPong: false,
          missedPongs: 0,
          drainWaiters: new Set(),
        };

        session.pingTimer = setInterval(() => {
          if (session.ws.readyState !== WebSocket.OPEN) return;
          if (session.awaitingPong) {
            session.missedPongs += 1;
            if (session.missedPongs >= config.maxMissedPongs) {
              session.ws.terminate();
              teardownHost(session, 1006, false);
              return;
            }
          }
          session.awaitingPong = true;
          sendFrame(session.ws, { type: "ping", ts: Date.now() });
        }, config.heartbeatIntervalMs);

        authedSession = session;
        activeHost = session;
        sendFrame(ws, { type: "hello", hostId: config.pinnedHostId });
        log({ ev: "host_connect", hostId: session.hostId });
        return;
      }

      const session = authedSession;
      switch (frame.type) {
        case "ping": {
          sendFrame(session.ws, { type: "pong", ts: frame.ts });
          break;
        }
        case "pong": {
          session.awaitingPong = false;
          session.missedPongs = 0;
          break;
        }
        case "res.head": {
          const stream = session.streams.get(frame.streamId);
          if (!stream || stream.headersSent || stream.finished) return;
          if (frame.invalidMetadata || frame.status < 200 || frame.status > 599) {
            failStream(session, stream, 502, "bad_gateway", "Upstream sent invalid response metadata", true);
            return;
          }
          const validatedHeaders = validateUpstreamHeaders(frame.headers);
          if (!validatedHeaders) {
            failStream(session, stream, 502, "bad_gateway", "Upstream sent invalid response headers", true);
            return;
          }
          if (stream.headerTimer) {
            clearTimeout(stream.headerTimer);
            stream.headerTimer = undefined;
          }
          try {
            applyCorsAndNoStore(stream.res, config.pwaOrigin);
            let contentType = "";
            for (const [lower, v] of validatedHeaders) {
              if (lower === "content-type") {
                contentType = Array.isArray(v) ? (v[0] ?? "") : v;
              }
              stream.res.setHeader(lower, v);
            }
            stream.isSse = contentType.toLowerCase().startsWith("text/event-stream");
            if (stream.isSse) {
              stream.res.setHeader("X-Accel-Buffering", "no");
            }
            if (stream.hasRequestBody && !stream.uploadEofSent) {
              stream.res.setHeader("Connection", "close");
            }
            stream.res.statusCode = frame.status;
            stream.res.flushHeaders();
            stream.headersSent = true;
          } catch {
            if (!stream.res.headersSent) {
              failStream(session, stream, 502, "bad_gateway", "Upstream sent invalid response headers", true);
            } else {
              failStream(session, stream, 502, "bad_gateway", "Upstream response failed", true);
            }
          }
          break;
        }
        case "res.body": {
          const stream = session.streams.get(frame.streamId);
          if (!stream) return;
          if (!stream.headersSent) {
            failStream(session, stream, 502, "bad_gateway", "Upstream sent body before headers", true);
            return;
          }
          const chunk = decodeBase64Chunk(frame.chunkB64, config.maxFrameBytes);
          if (!chunk) {
            failStream(session, stream, 502, "bad_gateway", "Upstream sent invalid body encoding", true);
            return;
          }
          if (stream.res.writableEnded || stream.res.destroyed) {
            stream.finished = true;
            session.streams.delete(stream.streamId);
            cleanupStreamUpload(session, stream, false);
            sendFrame(session.ws, { type: "req.cancel", streamId: stream.streamId });
            if (!stream.req.destroyed) stream.req.destroy();
            return;
          }
          if (stream.res.writableLength + chunk.length > config.maxStreamBufferBytes) {
            log({ ev: "stream_error", status: 502, reason: "stream_buffer_overflow" });
            stream.finished = true;
            session.streams.delete(stream.streamId);
            cleanupStreamUpload(session, stream, false);
            sendFrame(session.ws, { type: "req.cancel", streamId: stream.streamId });
            stream.res.destroy();
            if (!stream.req.destroyed) stream.req.destroy();
            return;
          }
          if (chunk.length > 0) {
            stream.res.write(chunk);
          }
          if (frame.eof) {
            stream.finished = true;
            session.streams.delete(stream.streamId);
            const uploadUnfinished = stream.hasRequestBody && !stream.uploadEofSent;
            cleanupStreamUpload(session, stream, uploadUnfinished);
            if (uploadUnfinished && !stream.req.destroyed) {
              stream.res.end(() => {
                if (!stream.req.destroyed) stream.req.destroy();
              });
            } else {
              stream.res.end();
            }
          }
          break;
        }
        case "hello":
        case "req.open":
        case "req.body":
        case "req.cancel":
          teardownHost(session, CloseCode.Malformed, true, "unexpected frame direction");
          break;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.headersTimeout = 10_000;
    httpServer.requestTimeout = 0;
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  log({ ev: "start", port: address.port });

  return {
    get port() {
      return (httpServer.address() as AddressInfo | null)?.port ?? config.port;
    },
    hostConnected: () => activeHost !== null && activeHost.ws.readyState === WebSocket.OPEN && !draining,
    async drain() {
      draining = true;
      log({
        ev: "drain",
        hostConnected: activeHost !== null,
        inFlight: activeHost?.streams.size ?? 0,
      });
      if (activeHost) {
        teardownHost(activeHost, CloseCode.Unavailable, true, "draining");
      }
    },
    async close() {
      draining = true;
      if (activeHost) {
        teardownHost(activeHost, CloseCode.Unavailable, true, "closing");
      }
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
