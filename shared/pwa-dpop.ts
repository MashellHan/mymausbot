/** HTTP request header carrying a single-use DPoP proof. */
export const DPOP_HEADER = "dpop";

/** Wire format version for DPoP proof payloads. */
export const DPOP_VERSION = 1 as const;

/** Maximum allowed clock skew (in seconds) between proof timestamp and server time. */
export const DPOP_MAX_SKEW_SECONDS = 60;

/** Minimum length of a base64url DPoP proof nonce. */
export const DPOP_NONCE_MIN_LEN = 16;

/** Maximum length of a base64url DPoP proof nonce. */
export const DPOP_NONCE_MAX_LEN = 64;

/** Lowercase hex SHA-256 digest of an empty request body. */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Public EC P-256 JWK bound to a paired session for Proof-of-Possession verification. */
export interface DpopPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

/** Signed payload carried inside the first segment of a `DPoP` header. */
export interface DpopProofPayload {
  v: 1;
  ts: number;
  nonce: string;
  bodySha256: string;
}

const DPOP_HEADER_MAX_LEN = 1024;
const DPOP_SIGNATURE_BYTES = 64;
const JWK_COORD_RE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const BODY_SHA256_RE = /^[0-9a-f]{64}$/;

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i += 1) {
    table[B64URL_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63]! +
      B64URL_ALPHABET[(n >>> 12) & 63]! +
      B64URL_ALPHABET[(n >>> 6) & 63]! +
      B64URL_ALPHABET[n & 63]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64URL_ALPHABET[(n >>> 18) & 63]! + B64URL_ALPHABET[(n >>> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      B64URL_ALPHABET[(n >>> 18) & 63]! +
      B64URL_ALPHABET[(n >>> 12) & 63]! +
      B64URL_ALPHABET[(n >>> 6) & 63]!;
  }
  return out;
}

function decodeBase64Url(text: string): Uint8Array | null {
  const len = text.length;
  if (len === 0 || len % 4 === 1) return null;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let outPos = 0;
  let i = 0;

  const codeAt = (idx: number): number => {
    const code = text.charCodeAt(idx);
    return code < 128 ? B64URL_LOOKUP[code]! : -1;
  };

  for (; i + 3 < len; i += 4) {
    const c0 = codeAt(i);
    const c1 = codeAt(i + 1);
    const c2 = codeAt(i + 2);
    const c3 = codeAt(i + 3);
    if ((c0 | c1 | c2 | c3) < 0) return null;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[outPos++] = (n >>> 16) & 0xff;
    out[outPos++] = (n >>> 8) & 0xff;
    out[outPos++] = n & 0xff;
  }

  const rem = len - i;
  if (rem === 2) {
    const c0 = codeAt(i);
    const c1 = codeAt(i + 1);
    if ((c0 | c1) < 0 || (c1 & 0x0f) !== 0) return null;
    out[outPos++] = (c0 << 2) | (c1 >>> 4);
  } else if (rem === 3) {
    const c0 = codeAt(i);
    const c1 = codeAt(i + 1);
    const c2 = codeAt(i + 2);
    if ((c0 | c1 | c2) < 0 || (c2 & 0x03) !== 0) return null;
    out[outPos++] = (c0 << 2) | (c1 >>> 4);
    out[outPos++] = ((c1 & 0x0f) << 4) | (c2 >>> 2);
  }

  return out;
}

/** Validates that a value is a strict P-256 public JWK with no private key material or extra properties. */
export function isDpopPublicJwk(value: unknown): value is DpopPublicJwk {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length !== 4) return false;
  return (
    value.kty === "EC" &&
    value.crv === "P-256" &&
    typeof value.x === "string" &&
    JWK_COORD_RE.test(value.x) &&
    typeof value.y === "string" &&
    JWK_COORD_RE.test(value.y)
  );
}

/** Builds the canonical signing input bound to HTTP method, request target, timestamp, nonce, and body SHA-256. */
export function canonicalDpopInput(input: {
  method: string;
  target: string;
  ts: number;
  nonce: string;
  bodySha256: string;
}): string {
  return `omb-dpop-v1\n${input.method.toUpperCase()}\n${input.target}\n${input.ts}\n${input.nonce}\n${input.bodySha256.toLowerCase()}`;
}

/** Encodes a DPoP proof payload and raw IEEE P1363 ECDSA signature bytes as `<payload>.<signature>`. */
export function encodeDpopProof(payload: DpopProofPayload, signatureBytes: Uint8Array): string {
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(signatureBytes)}`;
}

/** Parses and structurally validates a `DPoP` header value without verifying its cryptographic signature. */
export function parseDpopProof(header: string): { payload: DpopProofPayload; signature: Uint8Array } | null {
  if (typeof header !== "string" || header.length === 0 || header.length > DPOP_HEADER_MAX_LEN) {
    return null;
  }
  const dot = header.indexOf(".");
  if (dot <= 0 || dot === header.length - 1 || header.indexOf(".", dot + 1) !== -1) {
    return null;
  }
  const payloadBytes = decodeBase64Url(header.slice(0, dot));
  const signature = decodeBase64Url(header.slice(dot + 1));
  if (!payloadBytes || !signature || signature.length !== DPOP_SIGNATURE_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(payloadBytes));
  } catch {
    return null;
  }

  if (!isPlainObject(parsed) || Object.keys(parsed).length !== 4) return null;
  if (parsed.v !== DPOP_VERSION) return null;
  if (typeof parsed.ts !== "number" || !Number.isSafeInteger(parsed.ts)) return null;
  if (typeof parsed.nonce !== "string" || !NONCE_RE.test(parsed.nonce)) return null;
  if (typeof parsed.bodySha256 !== "string" || !BODY_SHA256_RE.test(parsed.bodySha256)) return null;

  return {
    payload: {
      v: DPOP_VERSION,
      ts: parsed.ts,
      nonce: parsed.nonce,
      bodySha256: parsed.bodySha256,
    },
    signature,
  };
}
