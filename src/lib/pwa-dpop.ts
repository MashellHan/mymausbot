import {
  DPOP_HEADER,
  DPOP_VERSION,
  EMPTY_BODY_SHA256,
  canonicalDpopInput,
  encodeDpopProof,
  isDpopPublicJwk,
  type DpopPublicJwk,
} from "../../shared/pwa-dpop.ts";

export const OMB_PWA_DPOP_STORE = "dpop_keys";

export interface DpopCryptoKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface GeneratedDpopKey {
  keyPair: DpopCryptoKeyPair;
  publicJwk: DpopPublicJwk;
}

const NativeURL = globalThis.URL;
const textEncoder = new TextEncoder();

function parseRequestTarget(url: string): { target: string; href: string } {
  const Ctor = typeof globalThis.URL === "function" ? globalThis.URL : NativeURL;
  if (typeof Ctor === "function") {
    const parsed = new Ctor(url, "http://localhost");
    return { target: `${parsed.pathname}${parsed.search}`, href: parsed.href };
  }
  const withoutHash = url.split("#", 1)[0] ?? url;
  const schemeIdx = withoutHash.indexOf("://");
  if (schemeIdx !== -1) {
    const slashIdx = withoutHash.indexOf("/", schemeIdx + 3);
    const target = slashIdx === -1 ? "/" : withoutHash.slice(slashIdx);
    return { target, href: withoutHash };
  }
  const target = withoutHash.startsWith("/") ? withoutHash : `/${withoutHash}`;
  return { target, href: `http://localhost${target}` };
}

function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  const encoded = textEncoder.encode(text);
  const out = new Uint8Array(encoded.byteLength);
  out.set(encoded);
  return out;
}

function toArrayBufferBytes(view: ArrayBufferView): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength);
  out.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (bytes.byteLength === 0) return EMPTY_BODY_SHA256;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function exportDpopPublicJwk(publicKey: CryptoKey): Promise<DpopPublicJwk | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.exportKey !== "function") {
    return null;
  }
  try {
    const raw = await subtle.exportKey("jwk", publicKey);
    const candidate = { kty: raw.kty, crv: raw.crv, x: raw.x, y: raw.y };
    return isDpopPublicJwk(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export async function generateDpopKeyPair(): Promise<GeneratedDpopKey | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.generateKey !== "function" || typeof subtle.exportKey !== "function") {
    return null;
  }
  try {
    const keyPair = await subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    if (!keyPair || !("privateKey" in keyPair) || !("publicKey" in keyPair)) {
      return null;
    }
    const publicJwk = await exportDpopPublicJwk(keyPair.publicKey);
    if (!publicJwk) {
      return null;
    }
    return { keyPair, publicJwk };
  } catch {
    return null;
  }
}

export async function prepareDpopSignedFetch(input: {
  privateKey: CryptoKey;
  url: string;
  init?: RequestInit;
  nowMs?: number;
}): Promise<RequestInit> {
  const { target, href } = parseRequestTarget(input.url);
  const method = (input.init?.method ?? "GET").toUpperCase();
  const headers = new Headers(input.init?.headers);
  const body = input.init?.body;
  let nextBody: RequestInit["body"] = body;
  let bodySha256: string = EMPTY_BODY_SHA256;

  if (body === undefined || body === null) {
    bodySha256 = EMPTY_BODY_SHA256;
  } else if (typeof body === "string") {
    bodySha256 = await sha256Hex(utf8Bytes(body));
  } else if (body instanceof ArrayBuffer) {
    bodySha256 = await sha256Hex(new Uint8Array(body));
  } else if (ArrayBuffer.isView(body)) {
    bodySha256 = await sha256Hex(toArrayBufferBytes(body));
  } else if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    bodySha256 = await sha256Hex(utf8Bytes(body.toString()));
  } else if (typeof FormData !== "undefined" && body instanceof FormData) {
    // Serialize FormData once so the multipart boundary in the hash matches the wire payload.
    const serialized = new Request(href, {
      method: method === "GET" || method === "HEAD" ? "POST" : method,
      body,
    });
    const bytes = new Uint8Array(await serialized.arrayBuffer());
    const contentType = serialized.headers.get("content-type");
    if (contentType) {
      headers.set("content-type", contentType);
    }
    nextBody = bytes;
    bodySha256 = await sha256Hex(bytes);
  } else if (typeof Blob !== "undefined" && body instanceof Blob) {
    bodySha256 = await sha256Hex(new Uint8Array(await body.arrayBuffer()));
  } else {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    nextBody = bytes;
    bodySha256 = await sha256Hex(bytes);
  }

  const nonce = randomNonce();
  const ts = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const canonical = canonicalDpopInput({ method, target, ts, nonce, bodySha256 });
  // WebCrypto ECDSA P-256 sign outputs 64-byte IEEE P1363 (R||S) directly.
  const sigBuffer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    utf8Bytes(canonical),
  );
  const proof = encodeDpopProof(
    { v: DPOP_VERSION, ts, nonce, bodySha256 },
    new Uint8Array(sigBuffer),
  );
  headers.set(DPOP_HEADER, proof);

  const nextInit: RequestInit = {
    ...input.init,
    headers,
  };
  if (nextBody !== body) {
    nextInit.body = nextBody;
  }
  return nextInit;
}
