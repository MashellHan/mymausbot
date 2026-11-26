import { createHash, generateKeyPairSync, randomBytes, sign as signBytes, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DPOP_HEADER,
  DPOP_MAX_SKEW_SECONDS,
  DPOP_VERSION,
  EMPTY_BODY_SHA256,
  canonicalDpopInput,
  encodeDpopProof,
  isDpopPublicJwk,
  parseDpopProof,
  type DpopProofPayload,
  type DpopPublicJwk,
} from "../shared/pwa-dpop.ts";
import { DpopVerifier, parseDpopPublicJwk, verifyRequestDpop } from "./pwa-dpop.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry, type SessionRecord } from "./sessions.ts";

function makeP256KeyPair(): { privateKey: KeyObject; publicJwk: DpopPublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const exported = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const publicJwk: DpopPublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: String(exported.x),
    y: String(exported.y),
  };
  return { privateKey, publicJwk };
}

function sha256Hex(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function makeProof(input: {
  privateKey: KeyObject;
  method: string;
  target: string;
  body?: string | Buffer;
  bodySha256?: string;
  ts?: number;
  nonce?: string;
}): string {
  const payload: DpopProofPayload = {
    v: DPOP_VERSION,
    ts: input.ts ?? Math.floor(Date.now() / 1000),
    nonce: input.nonce ?? randomBytes(16).toString("base64url"),
    bodySha256: input.bodySha256 ?? (input.body !== undefined ? sha256Hex(input.body) : EMPTY_BODY_SHA256),
  };
  const signingInput = canonicalDpopInput({
    method: input.method,
    target: input.target,
    ts: payload.ts,
    nonce: payload.nonce,
    bodySha256: payload.bodySha256,
  });
  const sig = signBytes("sha256", Buffer.from(signingInput, "utf8"), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return encodeDpopProof(payload, new Uint8Array(sig));
}

function fakeReq(
  method: string,
  headers: Record<string, string | string[] | undefined>,
): IncomingMessage {
  return {
    method,
    headers,
    socket: { remoteAddress: "203.0.113.10", remoteFamily: "IPv4" },
  } as unknown as IncomingMessage;
}

describe("shared/pwa-dpop wire contract", () => {
  it("validates strict P-256 public JWKs and rejects private/extra fields", () => {
    const { privateKey, publicJwk } = makeP256KeyPair();
    expect(isDpopPublicJwk(publicJwk)).toBe(true);
    expect(isDpopPublicJwk(privateKey.export({ format: "jwk" }))).toBe(false);
    expect(isDpopPublicJwk({ ...publicJwk, extra: "nope" })).toBe(false);
    expect(isDpopPublicJwk({ ...publicJwk, kty: "RSA" })).toBe(false);
    expect(isDpopPublicJwk({ ...publicJwk, crv: "P-384" })).toBe(false);
    expect(isDpopPublicJwk({ ...publicJwk, x: publicJwk.x.slice(0, 42) })).toBe(false);
    expect(isDpopPublicJwk({ ...publicJwk, y: `${publicJwk.y.slice(0, 42)}+` })).toBe(false);
    expect(isDpopPublicJwk(null)).toBe(false);
    expect(isDpopPublicJwk([])).toBe(false);
  });

  it("canonicalizes method and bodySha256 casing", () => {
    expect(
      canonicalDpopInput({
        method: "post",
        target: "/api/bots/b1/messages?x=1",
        ts: 1700000000,
        nonce: "abcdefghijklmnop",
        bodySha256: EMPTY_BODY_SHA256.toUpperCase(),
      }),
    ).toBe(`omb-dpop-v1\nPOST\n/api/bots/b1/messages?x=1\n1700000000\nabcdefghijklmnop\n${EMPTY_BODY_SHA256}`);
  });

  it("encodes and parses valid proofs and rejects malformed headers", () => {
    const payload: DpopProofPayload = {
      v: 1,
      ts: 1700000000,
      nonce: "nonce_0123456789_abcdef",
      bodySha256: EMPTY_BODY_SHA256,
    };
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i += 1) sig[i] = i;

    const encoded = encodeDpopProof(payload, sig);
    const parsed = parseDpopProof(encoded);
    expect(parsed).not.toBeNull();
    expect(parsed!.payload).toEqual(payload);
    expect(Array.from(parsed!.signature)).toEqual(Array.from(sig));

    // Reject oversized header (> 1024 chars).
    expect(parseDpopProof(`${encoded}${"a".repeat(1025)}`)).toBeNull();
    // Reject wrong segment count.
    expect(parseDpopProof("onlyone")).toBeNull();
    expect(parseDpopProof(`${encoded}.extra`)).toBeNull();
    // Reject non-base64url chars and padding.
    expect(parseDpopProof(`${encoded}=`)).toBeNull();
    // Reject non-64-byte signatures.
    expect(parseDpopProof(encodeDpopProof(payload, new Uint8Array(63)))).toBeNull();
    expect(parseDpopProof(encodeDpopProof(payload, new Uint8Array(65)))).toBeNull();
    // Reject extra payload fields.
    const extraPayload = Buffer.from(JSON.stringify({ ...payload, extra: true })).toString("base64url");
    const sigPart = Buffer.from(sig).toString("base64url");
    expect(parseDpopProof(`${extraPayload}.${sigPart}`)).toBeNull();
    // Reject invalid version, timestamp, nonce, bodySha256.
    const badVersion = Buffer.from(JSON.stringify({ ...payload, v: 2 })).toString("base64url");
    expect(parseDpopProof(`${badVersion}.${sigPart}`)).toBeNull();
    const badTs = Buffer.from(JSON.stringify({ ...payload, ts: 1.5 })).toString("base64url");
    expect(parseDpopProof(`${badTs}.${sigPart}`)).toBeNull();
    const shortNonce = Buffer.from(JSON.stringify({ ...payload, nonce: "short" })).toString("base64url");
    expect(parseDpopProof(`${shortNonce}.${sigPart}`)).toBeNull();
    const upperHash = Buffer.from(JSON.stringify({ ...payload, bodySha256: EMPTY_BODY_SHA256.toUpperCase() })).toString("base64url");
    expect(parseDpopProof(`${upperHash}.${sigPart}`)).toBeNull();
  });
});

describe("server/pwa-dpop verification and replay protection", () => {
  it("rejects off-curve P-256 JWK coordinates in parseDpopPublicJwk", () => {
    const { publicJwk } = makeP256KeyPair();
    expect(parseDpopPublicJwk(publicJwk)).toEqual(publicJwk);

    // Flip one byte of y so the point is almost certainly off-curve (retry deterministic values until off-curve).
    const offCurve: DpopPublicJwk = {
      kty: "EC",
      crv: "P-256",
      x: Buffer.alloc(32, 0).toString("base64url"),
      y: Buffer.alloc(32, 0).toString("base64url"),
    };
    expect(isDpopPublicJwk(offCurve)).toBe(true);
    expect(parseDpopPublicJwk(offCurve)).toBeNull();
  });

  it("verifies valid proofs and rejects missing, wrong-key, tampered, skewed, and replayed proofs", () => {
    const verifier = new DpopVerifier();
    const alice = makeP256KeyPair();
    const mallory = makeP256KeyPair();
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const body = JSON.stringify({ text: "hello" });
    const bodyHash = sha256Hex(body);

    const proof = makeProof({
      privateKey: alice.privateKey,
      method: "POST",
      target: "/api/bots/b1/messages?foo=bar",
      body,
      ts: nowSec,
      nonce: "nonce_valid_000001",
    });

    // Missing proof fails.
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: undefined,
        method: "POST",
        target: "/api/bots/b1/messages?foo=bar",
        bodySha256: bodyHash,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/DPoP proof required/i);

    // Wrong key fails and does NOT consume the nonce.
    expect(
      verifier.verify({
        jwk: mallory.publicJwk,
        proofHeader: proof,
        method: "POST",
        target: "/api/bots/b1/messages?foo=bar",
        bodySha256: bodyHash,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/signature/i);

    // Tampered method, path, query, and body all fail without polluting replay cache.
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: proof,
        method: "DELETE",
        target: "/api/bots/b1/messages?foo=bar",
        bodySha256: bodyHash,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/signature/i);

    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: proof,
        method: "POST",
        target: "/api/bots/b2/messages?foo=bar",
        bodySha256: bodyHash,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/signature/i);

    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: proof,
        method: "POST",
        target: "/api/bots/b1/messages?foo=evil",
        bodySha256: bodyHash,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/signature/i);

    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: proof,
        method: "POST",
        target: "/api/bots/b1/messages?foo=bar",
        bodySha256: sha256Hex(JSON.stringify({ text: "tampered" })),
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/body hash/i);

    // Valid proof STILL passes after all the invalid attempts with the same nonce!
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: proof,
        method: "POST",
        target: "/api/bots/b1/messages?foo=bar",
        bodySha256: bodyHash,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toBeNull();

    // Immediate replay for the same session is rejected.
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: proof,
        method: "POST",
        target: "/api/bots/b1/messages?foo=bar",
        bodySha256: bodyHash,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/replay/i);

    // Same nonce on a different session is allowed (scoped per sessionId).
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: proof,
        method: "POST",
        target: "/api/bots/b1/messages?foo=bar",
        bodySha256: bodyHash,
        sessionId: "sess-2",
        nowMs,
      }),
    ).toBeNull();

    // Timestamp skew boundary (+/- 60s allowed, +/- 61s rejected).
    const pastOk = makeProof({
      privateKey: alice.privateKey,
      method: "GET",
      target: "/api/bots",
      ts: nowSec - DPOP_MAX_SKEW_SECONDS,
      nonce: "nonce_skew_past_ok_1",
    });
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: pastOk,
        method: "GET",
        target: "/api/bots",
        bodySha256: EMPTY_BODY_SHA256,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toBeNull();

    const futureOk = makeProof({
      privateKey: alice.privateKey,
      method: "GET",
      target: "/api/bots",
      ts: nowSec + DPOP_MAX_SKEW_SECONDS,
      nonce: "nonce_skew_future_ok_1",
    });
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: futureOk,
        method: "GET",
        target: "/api/bots",
        bodySha256: EMPTY_BODY_SHA256,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toBeNull();

    const expired = makeProof({
      privateKey: alice.privateKey,
      method: "GET",
      target: "/api/bots",
      ts: nowSec - DPOP_MAX_SKEW_SECONDS - 1,
      nonce: "nonce_skew_expired_1",
    });
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: expired,
        method: "GET",
        target: "/api/bots",
        bodySha256: EMPTY_BODY_SHA256,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/timestamp/i);

    const tooFarFuture = makeProof({
      privateKey: alice.privateKey,
      method: "GET",
      target: "/api/bots",
      ts: nowSec + DPOP_MAX_SKEW_SECONDS + 1,
      nonce: "nonce_skew_future_bad",
    });
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: tooFarFuture,
        method: "GET",
        target: "/api/bots",
        bodySha256: EMPTY_BODY_SHA256,
        sessionId: "sess-1",
        nowMs,
      }),
    ).toMatch(/timestamp/i);
  });

  it("rejects duplicate DPoP header arrays in verifyRequestDpop", () => {
    const verifier = new DpopVerifier();
    const { privateKey, publicJwk } = makeP256KeyPair();
    const url = new URL("http://pwa-bridge.invalid/api/bots?limit=10");
    const proof = makeProof({ privateKey, method: "GET", target: "/api/bots?limit=10" });
    const session = {
      id: "s-1",
      tokenHash: "a".repeat(64),
      label: "PWA",
      scopes: ["client"] as const,
      createdAt: 1,
      lastSeenAt: 1,
      expiresAt: 1000,
      dpopJwk: publicJwk,
    };

    const dupReq = fakeReq("GET", { [DPOP_HEADER]: [proof, proof] });
    expect(verifyRequestDpop(verifier, dupReq, { ...session, scopes: ["client"] }, "GET", url, EMPTY_BODY_SHA256)).toMatch(
      /multiple DPoP headers/i,
    );

    const okReq = fakeReq("GET", { [DPOP_HEADER]: proof });
    expect(verifyRequestDpop(verifier, okReq, { ...session, scopes: ["client"] }, "GET", url, EMPTY_BODY_SHA256)).toBeNull();
  });

  it("prunes expired entries and applies FIFO eviction when replay cache reaches capacity", () => {
    const verifier = new DpopVerifier({ maxEntries: 2 });
    const alice = makeP256KeyPair();
    const t0 = 1_700_000_000_000;
    const sec0 = Math.floor(t0 / 1000);

    const p1 = makeProof({ privateKey: alice.privateKey, method: "GET", target: "/api/bots", ts: sec0, nonce: "nonce_evict_000001" });
    const p2 = makeProof({ privateKey: alice.privateKey, method: "GET", target: "/api/bots", ts: sec0, nonce: "nonce_evict_000002" });
    const p3 = makeProof({ privateKey: alice.privateKey, method: "GET", target: "/api/bots", ts: sec0, nonce: "nonce_evict_000003" });

    expect(verifier.verify({ jwk: alice.publicJwk, proofHeader: p1, method: "GET", target: "/api/bots", bodySha256: EMPTY_BODY_SHA256, sessionId: "s", nowMs: t0 })).toBeNull();
    expect(verifier.verify({ jwk: alice.publicJwk, proofHeader: p2, method: "GET", target: "/api/bots", bodySha256: EMPTY_BODY_SHA256, sessionId: "s", nowMs: t0 })).toBeNull();
    // Inserting p3 evicts oldest entry (p1) while keeping p2.
    expect(verifier.verify({ jwk: alice.publicJwk, proofHeader: p3, method: "GET", target: "/api/bots", bodySha256: EMPTY_BODY_SHA256, sessionId: "s", nowMs: t0 })).toBeNull();
    expect(verifier.verify({ jwk: alice.publicJwk, proofHeader: p2, method: "GET", target: "/api/bots", bodySha256: EMPTY_BODY_SHA256, sessionId: "s", nowMs: t0 })).toMatch(/replay/i);
    expect(verifier.verify({ jwk: alice.publicJwk, proofHeader: p3, method: "GET", target: "/api/bots", bodySha256: EMPTY_BODY_SHA256, sessionId: "s", nowMs: t0 })).toMatch(/replay/i);
    // Oldest entry (p1) was evicted via FIFO.
    expect(verifier.verify({ jwk: alice.publicJwk, proofHeader: p1, method: "GET", target: "/api/bots", bodySha256: EMPTY_BODY_SHA256, sessionId: "s", nowMs: t0 })).toBeNull();
  });

  it("rejects replay of a future-skewed proof across the sub-second skew boundary", () => {
    const verifier = new DpopVerifier();
    const alice = makeP256KeyPair();
    const sec0 = 1_700_000_000;
    const t0 = sec0 * 1000;
    const futureProof = makeProof({
      privateKey: alice.privateKey,
      method: "GET",
      target: "/api/bots",
      ts: sec0 + DPOP_MAX_SKEW_SECONDS,
      nonce: "nonce_future_skew_01",
    });

    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: futureProof,
        method: "GET",
        target: "/api/bots",
        bodySha256: EMPTY_BODY_SHA256,
        sessionId: "sess-skew",
        nowMs: t0,
      }),
    ).toBeNull();

    // Still within the +/-60s skew window at (sec0 + 120) * 1000 + 500; replay cache MUST still reject it.
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: futureProof,
        method: "GET",
        target: "/api/bots",
        bodySha256: EMPTY_BODY_SHA256,
        sessionId: "sess-skew",
        nowMs: (sec0 + 2 * DPOP_MAX_SKEW_SECONDS) * 1000 + 500,
      }),
    ).toMatch(/replay/i);

    // Once past the skew window, timestamp validation rejects it.
    expect(
      verifier.verify({
        jwk: alice.publicJwk,
        proofHeader: futureProof,
        method: "GET",
        target: "/api/bots",
        bodySha256: EMPTY_BODY_SHA256,
        sessionId: "sess-skew",
        nowMs: (sec0 + 2 * DPOP_MAX_SKEW_SECONDS + 1) * 1000,
      }),
    ).toMatch(/timestamp/i);
  });

  it("rejects method or target containing CR or LF", () => {
    const verifier = new DpopVerifier();
    const alice = makeP256KeyPair();
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);

    for (const [method, target] of [
      ["GET\nPOST", "/api/bots"],
      ["GET\rPOST", "/api/bots"],
      ["GET", "/api/bots\n/evil"],
      ["GET", "/api/bots\r/evil"],
    ] as const) {
      const proof = makeProof({
        privateKey: alice.privateKey,
        method,
        target,
        ts: nowSec,
        nonce: `nonce_crlf_${randomBytes(8).toString("hex")}`,
      });
      expect(
        verifier.verify({
          jwk: alice.publicJwk,
          proofHeader: proof,
          method,
          target,
          bodySha256: EMPTY_BODY_SHA256,
          sessionId: "sess-crlf",
          nowMs,
        }),
      ).toMatch(/invalid DPoP request target/i);
    }
  });

  it("fails closed on non-bridge requests carrying a body without bodySha256 and enforces EMPTY_BODY_SHA256 on bodyless requests", () => {
    const verifier = new DpopVerifier();
    const { privateKey, publicJwk } = makeP256KeyPair();
    const session: SessionRecord = {
      id: "s-nonbridge",
      tokenHash: "b".repeat(64),
      label: "PWA",
      scopes: ["client"],
      createdAt: 1,
      lastSeenAt: 1,
      expiresAt: 1000,
      dpopJwk: publicJwk,
    };

    const postUrl = new URL("https://example.invalid/api/bots/b1/messages");
    const body = JSON.stringify({ text: "hello" });

    // Non-bridge POST with content-length > 0 fails closed when bodySha256 is omitted.
    const postProof = makeProof({ privateKey, method: "POST", target: "/api/bots/b1/messages", body });
    const postWithLengthReq = fakeReq("POST", {
      [DPOP_HEADER]: postProof,
      "content-length": String(Buffer.byteLength(body)),
    });
    expect(verifyRequestDpop(verifier, postWithLengthReq, session, "POST", postUrl)).toBe(
      "unauthorized: DPoP body digest required",
    );

    // Non-bridge POST with transfer-encoding fails closed when bodySha256 is omitted.
    const postChunkedReq = fakeReq("POST", {
      [DPOP_HEADER]: postProof,
      "transfer-encoding": "chunked",
    });
    expect(verifyRequestDpop(verifier, postChunkedReq, session, "POST", postUrl)).toBe(
      "unauthorized: DPoP body digest required",
    );

    // Non-bridge POST with provably empty body (content-length: 0) verifies EMPTY_BODY_SHA256.
    const emptyPostUrl = new URL("https://example.invalid/api/auth/stream-ticket");
    const emptyPostProof = makeProof({ privateKey, method: "POST", target: "/api/auth/stream-ticket" });
    const emptyPostReq = fakeReq("POST", {
      [DPOP_HEADER]: emptyPostProof,
      "content-length": "0",
    });
    expect(verifyRequestDpop(verifier, emptyPostReq, session, "POST", emptyPostUrl)).toBeNull();

    // Non-bridge GET with bodySha256 omitted verifies EMPTY_BODY_SHA256 and rejects mismatched bodySha256.
    const getUrl = new URL("https://example.invalid/api/bots");
    const mismatchedGetProof = makeProof({
      privateKey,
      method: "GET",
      target: "/api/bots",
      bodySha256: sha256Hex("unexpected body"),
    });
    const mismatchedGetReq = fakeReq("GET", { [DPOP_HEADER]: mismatchedGetProof });
    expect(verifyRequestDpop(verifier, mismatchedGetReq, session, "GET", getUrl)).toMatch(/body hash/i);

    const validGetProof = makeProof({ privateKey, method: "GET", target: "/api/bots" });
    const validGetReq = fakeReq("GET", { [DPOP_HEADER]: validGetProof });
    expect(verifyRequestDpop(verifier, validGetReq, session, "GET", getUrl)).toBeNull();
  });
});

describe("sessions + resolveRequestAuth DPoP integration", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("persists dpopJwk across restarts, keys exchange replay by dpopJwk, and enforces DPoP on bearer requests only", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-dpop-sess-"));
    dirs.push(dir);
    const file = join(dir, "sessions.json");
    const sessions = new SessionRegistry({ file });
    const verifier = new DpopVerifier();

    const keyA = makeP256KeyPair();
    const keyB = makeP256KeyPair();

    // Pair a DPoP-bound PWA session with attemptId.
    const invite = sessions.openPairing({ pwa: true, label: "iPhone DPoP" });
    const attemptId = "pair_attempt_123456";
    const bound = sessions.exchange({
      code: invite.credential,
      label: "iPhone DPoP",
      source: "203.0.113.10",
      attemptId,
      pwa: true,
      dpopJwk: keyA.publicJwk,
    });
    expect(bound.ok).toBe(true);
    if (!bound.ok) throw new Error("expected exchange to succeed");
    expect(bound.session.dpopBound).toBe(true);
    expect(bound.session.pwa).toBe(true);

    // Same attemptId + same dpopJwk replays cleanly.
    const replayed = sessions.exchange({
      code: invite.credential,
      label: "iPhone DPoP",
      source: "203.0.113.10",
      attemptId,
      pwa: true,
      dpopJwk: keyA.publicJwk,
    });
    expect(replayed).toEqual(bound);

    // Same attemptId + different dpopJwk (or omitted dpopJwk) does NOT replay.
    const wrongKeyReplay = sessions.exchange({
      code: invite.credential,
      label: "iPhone DPoP",
      source: "203.0.113.10",
      attemptId,
      pwa: true,
      dpopJwk: keyB.publicJwk,
    });
    expect(wrongKeyReplay.ok).toBe(false);

    const noKeyReplay = sessions.exchange({
      code: invite.credential,
      label: "iPhone DPoP",
      source: "203.0.113.10",
      attemptId,
      pwa: true,
    });
    expect(noKeyReplay.ok).toBe(false);

    // Pair a legacy non-DPoP PWA session.
    const legacyInvite = sessions.openPairing({ pwa: true, label: "Legacy PWA" });
    const legacy = sessions.exchange({
      code: legacyInvite.credential,
      label: "Legacy PWA",
      source: "203.0.113.10",
      pwa: true,
    });
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error("expected legacy exchange to succeed");
    expect(legacy.session.dpopBound).toBeUndefined();

    // Persist and reload on a fresh SessionRegistry.
    sessions.close();
    const reloaded = new SessionRegistry({ file });
    const loadedRecord = reloaded.authenticate(bound.token);
    expect(loadedRecord?.dpopJwk).toEqual(keyA.publicJwk);
    expect(reloaded.list().find((s) => s.id === bound.session.id)?.dpopBound).toBe(true);
    expect(reloaded.list().find((s) => s.id === legacy.session.id)?.dpopBound).toBeUndefined();

    const url = new URL("http://pwa-bridge.invalid/api/bots");
    const verifyDpop = (r: IncomingMessage, s: NonNullable<typeof loadedRecord>, m: string, u: URL) =>
      verifyRequestDpop(verifier, r, s, m, u, EMPTY_BODY_SHA256);

    // Missing verifyDpop option fails closed on fresh request.
    const noVerifierRes = resolveRequestAuth(
      fakeReq("GET", { authorization: `Bearer ${bound.token}` }),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url },
    );
    expect(noVerifierRes.auth).toBeNull();
    expect(noVerifierRes.status).toBe(401);

    // Missing DPoP header returns 401.
    const missingHeaderRes = resolveRequestAuth(
      fakeReq("GET", { authorization: `Bearer ${bound.token}` }),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url, verifyDpop },
    );
    expect(missingHeaderRes.auth).toBeNull();
    expect(missingHeaderRes.status).toBe(401);

    // Valid DPoP header succeeds.
    const proof1 = makeProof({ privateKey: keyA.privateKey, method: "GET", target: "/api/bots" });
    const req1 = fakeReq("GET", { authorization: `Bearer ${bound.token}`, [DPOP_HEADER]: proof1 });
    const okRes = resolveRequestAuth(req1, {
      sessions: reloaded,
      cookieName: "omb_c",
      streamPath: "/api/events",
      url,
      verifyDpop,
    });
    expect(okRes.auth?.kind).toBe("session");

    // Re-running resolveRequestAuth WITH verifyDpop rejects replay even on the same req object.
    const replaySameReq = resolveRequestAuth(req1, {
      sessions: reloaded,
      cookieName: "omb_c",
      streamPath: "/api/events",
      url,
      verifyDpop,
    });
    expect(replaySameReq.auth).toBeNull();
    expect(replaySameReq.status).toBe(401);

    // Post-await recheck WITHOUT verifyDpop succeeds for the already-verified req while session is live.
    const recheckOk = resolveRequestAuth(req1, {
      sessions: reloaded,
      cookieName: "omb_c",
      streamPath: "/api/events",
      url,
    });
    expect(recheckOk.auth?.kind).toBe("session");

    // Post-await recheck fails if URL target or method differs from the verified request.
    const recheckWrongUrl = resolveRequestAuth(req1, {
      sessions: reloaded,
      cookieName: "omb_c",
      streamPath: "/api/events",
      url: new URL("http://pwa-bridge.invalid/api/bots?extra=1"),
    });
    expect(recheckWrongUrl.auth).toBeNull();
    expect(recheckWrongUrl.status).toBe(401);

    // Cookie auth (via === "cookie") with a DPoP-bound session token is rejected with 401 (bypass blocked).
    const cookieRes = resolveRequestAuth(
      fakeReq("GET", {
        host: "example.invalid",
        origin: "http://example.invalid",
        cookie: `omb_c=${bound.token}`,
      }),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url, verifyDpop },
    );
    expect(cookieRes.auth).toBeNull();
    expect(cookieRes.status).toBe(401);
    expect(cookieRes.error).toBe("unauthorized: DPoP-bound session requires Bearer authentication");

    const cookieNoVerifierRes = resolveRequestAuth(
      fakeReq("GET", {
        host: "example.invalid",
        cookie: `omb_c=${bound.token}`,
      }),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url },
    );
    expect(cookieNoVerifierRes.auth).toBeNull();
    expect(cookieNoVerifierRes.status).toBe(401);
    expect(cookieNoVerifierRes.error).toBe("unauthorized: DPoP-bound session requires Bearer authentication");

    // Non-bridge POST carrying a body without pre-verified bodySha256 fails closed with 401.
    const verifyNonBridgeDpop = (r: IncomingMessage, s: NonNullable<typeof loadedRecord>, m: string, u: URL) =>
      verifyRequestDpop(verifier, r, s, m, u);
    const postUrl = new URL("https://example.invalid/api/bots/b1/messages");
    const postBody = JSON.stringify({ text: "hello" });
    const postProof = makeProof({
      privateKey: keyA.privateKey,
      method: "POST",
      target: "/api/bots/b1/messages",
      body: postBody,
    });
    const nonBridgePostRes = resolveRequestAuth(
      fakeReq("POST", {
        authorization: `Bearer ${bound.token}`,
        [DPOP_HEADER]: postProof,
        "content-length": String(Buffer.byteLength(postBody)),
      }),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url: postUrl, verifyDpop: verifyNonBridgeDpop },
    );
    expect(nonBridgePostRes.auth).toBeNull();
    expect(nonBridgePostRes.status).toBe(401);
    expect(nonBridgePostRes.error).toBe("unauthorized: DPoP body digest required");

    // Non-bridge GET verifies EMPTY_BODY_SHA256 and rejects a mismatched bodySha256 with 401.
    const badGetProof = makeProof({
      privateKey: keyA.privateKey,
      method: "GET",
      target: "/api/bots",
      bodySha256: sha256Hex("not-empty"),
    });
    const nonBridgeBadGetRes = resolveRequestAuth(
      fakeReq("GET", {
        authorization: `Bearer ${bound.token}`,
        [DPOP_HEADER]: badGetProof,
      }),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url, verifyDpop: verifyNonBridgeDpop },
    );
    expect(nonBridgeBadGetRes.auth).toBeNull();
    expect(nonBridgeBadGetRes.status).toBe(401);
    expect(nonBridgeBadGetRes.error).toMatch(/body hash/i);

    // Legacy non-DPoP session still works without a DPoP header.
    const legacyRes = resolveRequestAuth(
      fakeReq("GET", { authorization: `Bearer ${legacy.token}` }),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url, verifyDpop },
    );
    expect(legacyRes.auth?.kind).toBe("session");

    // Stream ticket (via === "ticket") on /api/events still works for a DPoP-bound session without DPoP header.
    const { ticket } = reloaded.issueStreamTicket(bound.session.id);
    const eventsUrl = new URL(`http://pwa-bridge.invalid/api/events?ticket=${encodeURIComponent(ticket)}`);
    const ticketRes = resolveRequestAuth(
      fakeReq("GET", {}),
      { sessions: reloaded, cookieName: "omb_c", streamPath: "/api/events", url: eventsUrl, verifyDpop },
    );
    expect(ticketRes.auth?.kind).toBe("session");
    if (ticketRes.auth?.kind === "session") {
      expect(ticketRes.auth.via).toBe("ticket");
    }

    // After revocation, post-await recheck on req1 fails with 401.
    reloaded.revoke(bound.session.id);
    const recheckRevoked = resolveRequestAuth(req1, {
      sessions: reloaded,
      cookieName: "omb_c",
      streamPath: "/api/events",
      url,
    });
    expect(recheckRevoked.auth).toBeNull();
    expect(recheckRevoked.status).toBe(401);

    reloaded.close();
  });
});
