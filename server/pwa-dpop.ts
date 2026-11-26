import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  DPOP_HEADER,
  DPOP_MAX_SKEW_SECONDS,
  EMPTY_BODY_SHA256,
  canonicalDpopInput,
  isDpopPublicJwk,
  parseDpopProof,
  type DpopPublicJwk,
} from "../shared/pwa-dpop.ts";
import type { SessionRecord } from "./sessions.ts";

const MAX_REPLAY_ENTRIES = 10_000;
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hasNoRequestBody(req: IncomingMessage, method: string): boolean {
  if (BODYLESS_METHODS.has(method.toUpperCase())) return true;
  return (
    req.headers["transfer-encoding"] === undefined &&
    (req.headers["content-length"] === undefined || req.headers["content-length"] === "0")
  );
}

function toPublicKey(jwk: DpopPublicJwk): KeyObject | null {
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    return key.asymmetricKeyType === "ec" ? key : null;
  } catch {
    return null;
  }
}

export function parseDpopPublicJwk(raw: unknown): DpopPublicJwk | null {
  if (!isDpopPublicJwk(raw)) return null;
  const clean: DpopPublicJwk = { kty: "EC", crv: "P-256", x: raw.x, y: raw.y };
  return toPublicKey(clean) ? clean : null;
}

export interface DpopVerifyInput {
  jwk: DpopPublicJwk;
  proofHeader: string | undefined;
  method: string;
  target: string;
  bodySha256: string;
  sessionId: string;
  nowMs?: number;
}

export class DpopVerifier {
  private readonly seenNonces = new Map<string, number>();
  private readonly keyCache = new WeakMap<DpopPublicJwk, KeyObject>();
  private readonly maxEntries: number;

  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? MAX_REPLAY_ENTRIES;
  }

  verify(input: DpopVerifyInput): string | null {
    if (!input.proofHeader) {
      return "unauthorized: DPoP proof required";
    }
    if (/[\r\n]/.test(input.method) || /[\r\n]/.test(input.target)) {
      return "unauthorized: invalid DPoP request target";
    }
    const parsed = parseDpopProof(input.proofHeader);
    if (!parsed) {
      return "unauthorized: invalid DPoP proof";
    }

    const nowMs = input.nowMs ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    if (Math.abs(nowSeconds - parsed.payload.ts) > DPOP_MAX_SKEW_SECONDS) {
      return "unauthorized: DPoP proof timestamp out of range";
    }

    if (parsed.payload.bodySha256 !== input.bodySha256.toLowerCase()) {
      return "unauthorized: DPoP body hash mismatch";
    }

    if (!isDpopPublicJwk(input.jwk)) {
      return "unauthorized: invalid DPoP key";
    }
    let publicKey = this.keyCache.get(input.jwk);
    if (!publicKey) {
      const created = toPublicKey(input.jwk);
      if (!created) return "unauthorized: invalid DPoP key";
      publicKey = created;
      this.keyCache.set(input.jwk, publicKey);
    }

    const message = canonicalDpopInput({
      method: input.method,
      target: input.target,
      ts: parsed.payload.ts,
      nonce: parsed.payload.nonce,
      bodySha256: parsed.payload.bodySha256,
    });
    const ok = verifySignature(
      "sha256",
      Buffer.from(message, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      parsed.signature,
    );
    if (!ok) {
      return "unauthorized: invalid DPoP signature";
    }

    // Check and record nonce only after signature verification so forged proofs cannot fill the replay cache.
    const replayKey = `${input.sessionId}:${parsed.payload.nonce}`;
    const existingExpiry = this.seenNonces.get(replayKey);
    if (existingExpiry !== undefined) {
      if (existingExpiry >= nowMs) {
        return "unauthorized: DPoP proof replay";
      }
      this.seenNonces.delete(replayKey);
    }

    if (this.seenNonces.size >= this.maxEntries) {
      for (const [key, entryExpiresAt] of this.seenNonces) {
        if (entryExpiresAt < nowMs) this.seenNonces.delete(key);
      }
      while (this.seenNonces.size >= this.maxEntries) {
        const oldest = this.seenNonces.keys().next().value;
        if (oldest === undefined) break;
        this.seenNonces.delete(oldest);
      }
    }
    const expiresAt = (parsed.payload.ts + DPOP_MAX_SKEW_SECONDS + 1) * 1000;
    this.seenNonces.set(replayKey, expiresAt);
    return null;
  }
}

export function verifyRequestDpop(
  verifier: DpopVerifier,
  req: IncomingMessage,
  session: SessionRecord,
  method: string,
  url: URL,
  bodySha256?: string,
): string | null {
  if (!session.dpopJwk) return null;
  const rawHeader = req.headers[DPOP_HEADER];
  if (Array.isArray(rawHeader)) {
    return "unauthorized: multiple DPoP headers not allowed";
  }
  let resolvedBodySha256 = bodySha256;
  if (resolvedBodySha256 === undefined) {
    if (!hasNoRequestBody(req, method)) {
      return "unauthorized: DPoP body digest required";
    }
    resolvedBodySha256 = EMPTY_BODY_SHA256;
  }
  return verifier.verify({
    jwk: session.dpopJwk,
    proofHeader: rawHeader,
    method,
    target: url.pathname + url.search,
    bodySha256: resolvedBodySha256,
    sessionId: session.id,
  });
}
