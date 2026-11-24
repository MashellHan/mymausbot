import { timingSafeEqual } from "node:crypto";

const MiB = 1024 * 1024;
const KiB = 1024;

export interface BridgeConfig {
  port: number;
  host: string;
  pinnedHostId: string;
  hostTokenHashes: ReadonlyMap<string, readonly Buffer[]>;
  pwaOrigin: string;
  upstreamHeaderTimeoutMs: number;
  uploadHeaderTimeoutMs: number;
  maxBodyBytes: number;
  maxFrameBytes: number;
  maxConcurrentStreams: number;
  maxStreamBufferBytes: number;
  maxWsBufferedBytes: number;
  heartbeatIntervalMs: number;
  maxMissedPongs: number;
  authDeadlineMs: number;
  shutdownMs: number;
}

const HOST_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

function parsePositiveInt(raw: string | undefined, fallback: number, name: string, min = 1, max = 2_147_483_647): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parsePwaOrigin(raw: string | undefined): string {
  const value = (raw ?? "https://mausbot.mxhan.com").trim();
  if (value === "*") throw new Error("PWA_ORIGIN must be an explicit origin, never '*'");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PWA_ORIGIN must be a valid URL origin");
  }
  if (!["https:", "http:"].includes(url.protocol) || url.origin !== value) {
    throw new Error("PWA_ORIGIN must be an exact http(s) origin without path or trailing slash");
  }
  return url.origin;
}

function parseDigest(hex: unknown): Buffer {
  if (typeof hex !== "string" || !SHA256_HEX_RE.test(hex)) {
    throw new Error("HOST_TOKEN_HASHES entries must be 64-character hex sha256 digests");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Parses `HOST_TOKEN_HASHES` as either:
 * - JSON object mapping hostId -> sha256 hex digest or array of digests, or
 * - comma-separated sha256 hex digests bound to `pinnedHostId`.
 */
export function parseHostTokenHashes(raw: string | undefined, pinnedHostId: string): Map<string, Buffer[]> {
  if (!raw || !raw.trim()) throw new Error("HOST_TOKEN_HASHES is required");
  const trimmed = raw.trim();
  const out = new Map<string, Buffer[]>();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("HOST_TOKEN_HASHES must be valid JSON or comma-separated sha256 hex digests");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("HOST_TOKEN_HASHES JSON must map hostId to sha256 digest(s)");
    }
    for (const [hostId, val] of Object.entries(parsed)) {
      if (!HOST_ID_RE.test(hostId)) throw new Error("HOST_TOKEN_HASHES contains an invalid hostId");
      const list = Array.isArray(val) ? val : [val];
      if (list.length === 0) throw new Error("HOST_TOKEN_HASHES host entry must not be empty");
      out.set(hostId, list.map(parseDigest));
    }
  } else {
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error("HOST_TOKEN_HASHES must include at least one sha256 digest");
    out.set(pinnedHostId, parts.map(parseDigest));
  }
  const pinnedDigests = out.get(pinnedHostId);
  if (!pinnedDigests || pinnedDigests.length === 0) {
    throw new Error("HOST_TOKEN_HASHES must include at least one digest for PINNED_HOST_ID");
  }
  return out;
}

export function verifyHostTokenHash(
  hostId: string,
  candidateDigest: Buffer,
  hashes: ReadonlyMap<string, readonly Buffer[]>,
): boolean {
  const allowed = hashes.get(hostId);
  if (!allowed || candidateDigest.length !== 32) return false;
  let matched = false;
  for (const digest of allowed) {
    if (digest.length === 32 && timingSafeEqual(candidateDigest, digest)) {
      matched = true;
    }
  }
  return matched;
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const pinnedHostId = (env.PINNED_HOST_ID ?? "").trim();
  if (!HOST_ID_RE.test(pinnedHostId)) {
    throw new Error("PINNED_HOST_ID is required and must match [a-zA-Z0-9._-]{1,64}");
  }
  const port = parsePositiveInt(env.BRIDGE_PORT, 8080, "BRIDGE_PORT", 0, 65_535);
  const host = (env.BRIDGE_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const hostTokenHashes = parseHostTokenHashes(env.HOST_TOKEN_HASHES, pinnedHostId);
  const pwaOrigin = parsePwaOrigin(env.PWA_ORIGIN);
  const maxBodyBytes = parsePositiveInt(env.MAX_BODY_BYTES, 12 * MiB, "MAX_BODY_BYTES", KiB, 64 * MiB);
  const maxFrameBytes = parsePositiveInt(env.MAX_FRAME_BYTES, 512 * KiB, "MAX_FRAME_BYTES", 4 * KiB, 8 * MiB);

  return {
    port,
    host,
    pinnedHostId,
    hostTokenHashes,
    pwaOrigin,
    upstreamHeaderTimeoutMs: parsePositiveInt(env.UPSTREAM_HEADER_TIMEOUT_MS, 5_000, "UPSTREAM_HEADER_TIMEOUT_MS", 100, 120_000),
    uploadHeaderTimeoutMs: parsePositiveInt(env.UPLOAD_HEADER_TIMEOUT_MS, 30_000, "UPLOAD_HEADER_TIMEOUT_MS", 100, 300_000),
    maxBodyBytes,
    maxFrameBytes,
    maxConcurrentStreams: parsePositiveInt(env.MAX_CONCURRENT_STREAMS, 128, "MAX_CONCURRENT_STREAMS", 1, 4096),
    maxStreamBufferBytes: parsePositiveInt(env.MAX_STREAM_BUFFER_BYTES, 4 * MiB, "MAX_STREAM_BUFFER_BYTES", 64 * KiB, 32 * MiB),
    maxWsBufferedBytes: parsePositiveInt(env.MAX_WS_BUFFERED_BYTES, 64 * MiB, "MAX_WS_BUFFERED_BYTES", 1024, 512 * MiB),
    heartbeatIntervalMs: parsePositiveInt(env.HEARTBEAT_INTERVAL_MS, 15_000, "HEARTBEAT_INTERVAL_MS", 200, 120_000),
    maxMissedPongs: parsePositiveInt(env.MAX_MISSED_PONGS, 2, "MAX_MISSED_PONGS", 1, 10),
    authDeadlineMs: parsePositiveInt(env.AUTH_DEADLINE_MS, 5_000, "AUTH_DEADLINE_MS", 200, 30_000),
    shutdownMs: parsePositiveInt(env.SHUTDOWN_MS, 5_000, "SHUTDOWN_MS", 100, 30_000),
  };
}
