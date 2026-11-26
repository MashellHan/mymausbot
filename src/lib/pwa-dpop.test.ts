import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DPOP_HEADER,
  DPOP_VERSION,
  EMPTY_BODY_SHA256,
  canonicalDpopInput,
  isDpopPublicJwk,
  parseDpopProof,
  type DpopPublicJwk,
} from "../../shared/pwa-dpop.ts";
import { generateDpopKeyPair, prepareDpopSignedFetch } from "./pwa-dpop.ts";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function importVerifyKey(jwk: DpopPublicJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

async function verifySignedHeader(params: {
  publicJwk: DpopPublicJwk;
  header: string | null;
  method: string;
  target: string;
  expectedBodySha256: string;
  expectedTs?: number;
}): Promise<{ nonce: string; ts: number }> {
  expect(params.header).toBeTruthy();
  const parsed = parseDpopProof(params.header!);
  expect(parsed).not.toBeNull();
  expect(parsed!.payload.v).toBe(DPOP_VERSION);
  expect(parsed!.payload.bodySha256).toBe(params.expectedBodySha256);
  if (params.expectedTs !== undefined) {
    expect(parsed!.payload.ts).toBe(params.expectedTs);
  }
  expect(parsed!.signature.byteLength).toBe(64);

  const canonical = canonicalDpopInput({
    method: params.method,
    target: params.target,
    ts: parsed!.payload.ts,
    nonce: parsed!.payload.nonce,
    bodySha256: parsed!.payload.bodySha256,
  });
  const verifyKey = await importVerifyKey(params.publicJwk);
  const sigBytes = new Uint8Array(parsed!.signature.byteLength);
  sigBytes.set(parsed!.signature);
  const canonicalBytes = new TextEncoder().encode(canonical);
  const msgBytes = new Uint8Array(canonicalBytes.byteLength);
  msgBytes.set(canonicalBytes);

  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    sigBytes,
    msgBytes,
  );
  expect(valid).toBe(true);
  return { nonce: parsed!.payload.nonce, ts: parsed!.payload.ts };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pwa-dpop WebCrypto key generation and request signing", () => {
  it("generates a non-exportable P-256 ECDSA keypair with a valid public JWK", async () => {
    const generated = await generateDpopKeyPair();
    expect(generated).not.toBeNull();
    expect(generated!.keyPair.privateKey.extractable).toBe(false);
    expect(generated!.keyPair.publicKey.extractable).toBe(true);
    expect(isDpopPublicJwk(generated!.publicJwk)).toBe(true);
    expect(generated!.publicJwk.kty).toBe("EC");
    expect(generated!.publicJwk.crv).toBe("P-256");
    await expect(crypto.subtle.exportKey("jwk", generated!.keyPair.privateKey)).rejects.toThrow();
  });

  it("returns null gracefully when WebCrypto subtle API is unavailable", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(await generateDpopKeyPair()).toBeNull();
  });

  it("signs GET requests with empty body hash and preserves query parameters", async () => {
    const generated = (await generateDpopKeyPair())!;
    const originalHeaders = new Headers({ authorization: "Bearer tok-1" });
    const signed = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/bots?limit=20&active=1",
      init: { headers: originalHeaders },
      nowMs: 1_700_000_123_456,
    });

    expect(originalHeaders.has(DPOP_HEADER)).toBe(false);
    const outHeaders = new Headers(signed.headers);
    expect(outHeaders.get("authorization")).toBe("Bearer tok-1");

    const first = await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: outHeaders.get(DPOP_HEADER),
      method: "GET",
      target: "/api/bots?limit=20&active=1",
      expectedBodySha256: EMPTY_BODY_SHA256,
      expectedTs: 1_700_000_123,
    });

    const signed2 = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/bots?limit=20&active=1",
      init: { headers: originalHeaders },
      nowMs: 1_700_000_123_456,
    });
    const second = await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: new Headers(signed2.headers).get(DPOP_HEADER),
      method: "GET",
      target: "/api/bots?limit=20&active=1",
      expectedBodySha256: EMPTY_BODY_SHA256,
      expectedTs: 1_700_000_123,
    });
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("signs POST JSON requests with exact UTF-8 body SHA-256", async () => {
    const generated = (await generateDpopKeyPair())!;
    const jsonBody = JSON.stringify({ text: "hello café", count: 2 });
    const signed = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/bots/b1/messages",
      init: {
        method: "post",
        headers: { "content-type": "application/json" },
        body: jsonBody,
      },
      nowMs: 1_700_000_200_000,
    });

    expect(signed.body).toBe(jsonBody);
    await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: new Headers(signed.headers).get(DPOP_HEADER),
      method: "POST",
      target: "/api/bots/b1/messages",
      expectedBodySha256: sha256Hex(jsonBody),
      expectedTs: 1_700_000_200,
    });
  });

  it("signs Uint8Array, ArrayBuffer, URLSearchParams, and Blob bodies accurately", async () => {
    const generated = (await generateDpopKeyPair())!;

    const rawBytes = new Uint8Array([1, 2, 3, 4, 255]);
    const signedBytes = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/upload/bytes",
      init: { method: "PUT", body: rawBytes },
    });
    await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: new Headers(signedBytes.headers).get(DPOP_HEADER),
      method: "PUT",
      target: "/api/upload/bytes",
      expectedBodySha256: sha256Hex(rawBytes),
    });

    const signedBuf = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/upload/buf",
      init: { method: "PUT", body: rawBytes.buffer },
    });
    await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: new Headers(signedBuf.headers).get(DPOP_HEADER),
      method: "PUT",
      target: "/api/upload/buf",
      expectedBodySha256: sha256Hex(rawBytes),
    });

    const params = new URLSearchParams({ a: "1", b: "two words" });
    const signedParams = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/form",
      init: { method: "POST", body: params },
    });
    await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: new Headers(signedParams.headers).get(DPOP_HEADER),
      method: "POST",
      target: "/api/form",
      expectedBodySha256: sha256Hex(params.toString()),
    });

    const blob = new Blob(["binary-blob-data"], { type: "application/octet-stream" });
    const signedBlob = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/blob",
      init: { method: "POST", body: blob },
    });
    await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: new Headers(signedBlob.headers).get(DPOP_HEADER),
      method: "POST",
      target: "/api/blob",
      expectedBodySha256: sha256Hex("binary-blob-data"),
    });
  });

  it("serializes FormData once so hashed bytes and wire bytes share the exact multipart boundary", async () => {
    const generated = (await generateDpopKeyPair())!;
    const form = new FormData();
    form.append("title", "Receipt");
    form.append("file", new Blob(["png-bytes"], { type: "image/png" }), "receipt.png");

    const signed = await prepareDpopSignedFetch({
      privateKey: generated.keyPair.privateKey,
      url: "https://relay.mxhan.com/api/attachments",
      init: { method: "POST", body: form },
      nowMs: 1_700_000_500_000,
    });

    expect(signed.body).toBeInstanceOf(Uint8Array);
    const wireBytes = signed.body as Uint8Array;
    const headers = new Headers(signed.headers);
    const contentType = headers.get("content-type") ?? "";
    expect(contentType).toMatch(/^multipart\/form-data;\s*boundary=/i);
    const boundary = contentType.split("boundary=")[1]?.trim();
    expect(boundary).toBeTruthy();

    const wireText = new TextDecoder().decode(wireBytes);
    expect(wireText).toContain(`--${boundary}`);
    expect(wireText).toContain("Receipt");
    expect(wireText).toContain("png-bytes");

    await verifySignedHeader({
      publicJwk: generated.publicJwk,
      header: headers.get(DPOP_HEADER),
      method: "POST",
      target: "/api/attachments",
      expectedBodySha256: sha256Hex(wireBytes),
      expectedTs: 1_700_000_500,
    });
  });
});
