// Outbound WSS bridge client (`omb-pwa-bridge.v1`) connecting the local Mac server to the DO relay and dispatching
// sanitized, allowlisted requests to `handleRequest` over an in-memory socket without loopback trust.
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { duplexPair, type Duplex } from "node:stream";
import WebSocket from "ws";

import type { PwaBridgeState, PwaBridgeStatus } from "../shared/pwa-bridge.ts";
import { gzipTunnelReplies } from "./harness/tunnel-gzip.ts";
import { loadPwaBridgeConfig, type PwaBridgeConfig } from "./pwa-bridge-config.ts";
import {
  MAX_RAW_CHUNK_BYTES,
  PWA_BRIDGE_MAX_BODY_BYTES,
  PWA_BRIDGE_MAX_CONCURRENT_STREAMS,
  PWA_BRIDGE_MAX_FRAME_BYTES,
  PWA_BRIDGE_MAX_WS_BUFFERED_BYTES,
  PWA_BRIDGE_SUBPROTOCOL,
  decodeBase64Chunk,
  isBridgeRouteAllowed,
  mapBridgeCloseError,
  normalizeBridgeTarget,
  parseInboundFrame,
  relayWsUrl,
  sanitizeResponseHeaders,
  sanitizeTransportError,
  scrubHeadersObject,
  scrubIncomingRequest,
  socketLike,
  type HeaderMap,
  type InboundBridgeFrame,
} from "./pwa-bridge-wire.ts";
import { sanitizeSource } from "./request-auth.ts";
import { isPairingCredential } from "./sessions.ts";

export {
  PWA_BRIDGE_MAX_BODY_BYTES,
  PWA_BRIDGE_MAX_CONCURRENT_STREAMS,
  PWA_BRIDGE_MAX_FRAME_BYTES,
  PWA_BRIDGE_MAX_WS_BUFFERED_BYTES,
  PWA_BRIDGE_SUBPROTOCOL,
  isBridgeRouteAllowed,
  type HeaderMap,
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 5_000] as const;

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

interface StreamMeta {
  remoteAddr: string;
  expectedMethod: string;
  expectedPath: string;
  expectedPathname: string;
  handled: boolean;
}

interface ActiveStream {
  streamId: string;
  method: string;
  expectedPath: string;
  expectedPathname: string;
  remoteAddr: string;
  headers: HeaderMap;
  declaredContentLength?: number;
  pendingChunks: Buffer[];
  bodyBytesReceived: number;
  requestEnded: boolean;
  dispatched: boolean;
  responseStarted: boolean;
  finished: boolean;
  clientReq: ReturnType<typeof httpRequest> | null;
  near: Duplex | null;
  far: Duplex | null;
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
    stream.pendingChunks.length = 0;
    streams.delete(streamId);
    if (destroy) {
      stream.clientReq?.destroy();
      stream.near?.destroy();
      stream.far?.destroy();
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

  const dispatchStream = (socket: WebSocket, stream: ActiveStream) => {
    if (stream.finished || stream.dispatched || ws !== socket || socket.readyState !== WebSocket.OPEN) {
      cleanupStream(stream.streamId, true);
      return;
    }
    const refusal = options.managedRemoteAccessRefusal?.();
    if (refusal) {
      closeStreamsForPolicyRefusal(socket, refusal);
      return;
    }

    const body =
      stream.pendingChunks.length === 0
        ? Buffer.alloc(0)
        : stream.pendingChunks.length === 1
          ? stream.pendingChunks[0]!
          : Buffer.concat(stream.pendingChunks, stream.bodyBytesReceived);
    stream.pendingChunks.length = 0;

    if (stream.method !== "GET" && stream.method !== "HEAD" && stream.declaredContentLength === undefined) {
      stream.headers["content-length"] = String(body.length);
    }

    const [rawNear, rawFar] = duplexPair();
    const near = socketLike(rawNear);
    const far = socketLike(rawFar);
    bridgeSockets.add(far);
    streamMeta.set(far, {
      remoteAddr: stream.remoteAddr,
      expectedMethod: stream.method,
      expectedPath: stream.expectedPath,
      expectedPathname: stream.expectedPathname,
      handled: false,
    });
    originServer.emit("connection", far);

    const streamAgent = new Agent({ keepAlive: false });
    streamAgent.createConnection = () => near;
    let clientReq: ReturnType<typeof httpRequest>;
    try {
      clientReq = httpRequest({
        method: stream.method,
        path: stream.expectedPath,
        headers: stream.headers,
        agent: streamAgent,
      });
    } catch {
      near.destroy();
      far.destroy();
      sendImmediateJson(socket, stream.streamId, 400, { error: "invalid request parameters" });
      cleanupStream(stream.streamId, false);
      return;
    }
    clientReq.setTimeout(0);
    stream.clientReq = clientReq;
    stream.near = near;
    stream.far = far;
    stream.dispatched = true;

    clientReq.on("response", (proxyRes) => {
      if (stream.finished || ws !== socket || socket.readyState !== WebSocket.OPEN) {
        cleanupStream(stream.streamId, true);
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
        streamId: stream.streamId,
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
            { type: "res.body", streamId: stream.streamId, chunkB64: slice.toString("base64"), eof: false },
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
          sendFrame(socket, { type: "res.body", streamId: stream.streamId, chunkB64: "", eof: true });
        }
        cleanupStream(stream.streamId, false);
      });

      proxyRes.on("close", () => {
        if (stream.finished) return;
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          sendFrame(socket, { type: "res.body", streamId: stream.streamId, chunkB64: "", eof: true });
        }
        cleanupStream(stream.streamId, false);
      });

      proxyRes.on("error", () => {
        if (stream.finished) return;
        if (ws === socket && socket.readyState === WebSocket.OPEN) {
          sendFrame(socket, { type: "res.body", streamId: stream.streamId, chunkB64: "", eof: true });
        }
        cleanupStream(stream.streamId, true);
      });
    });

    clientReq.on("error", () => {
      if (stream.finished) return;
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        if (!stream.responseStarted) {
          sendImmediateJson(socket, stream.streamId, 502, { error: "upstream dispatch failed" });
        } else {
          sendFrame(socket, { type: "res.body", streamId: stream.streamId, chunkB64: "", eof: true });
        }
      }
      cleanupStream(stream.streamId, true);
    });

    if (body.length > 0) {
      clientReq.end(body);
    } else {
      clientReq.end();
    }
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
    const stream: ActiveStream = {
      streamId: frame.streamId,
      method: upperMethod,
      expectedPath,
      expectedPathname: target.url.pathname,
      remoteAddr,
      headers: scrubbed.headers,
      declaredContentLength: scrubbed.declaredContentLength,
      pendingChunks: [],
      bodyBytesReceived: 0,
      requestEnded: false,
      dispatched: false,
      responseStarted: false,
      finished: false,
      clientReq: null,
      near: null,
      far: null,
    };
    streams.set(frame.streamId, stream);
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
      } else {
        sendFrame(socket, { type: "res.body", streamId: frame.streamId, chunkB64: "", eof: true });
      }
      cleanupStream(frame.streamId, true);
      return;
    }
    if ((stream.method === "GET" || stream.method === "HEAD") && chunk.length > 0) {
      if (!stream.responseStarted) {
        sendImmediateJson(socket, frame.streamId, 400, { error: "unexpected request body on GET/HEAD" });
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
    if (chunk.length > 0) stream.pendingChunks.push(chunk);
    if (frame.eof) {
      stream.requestEnded = true;
      dispatchStream(socket, stream);
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
