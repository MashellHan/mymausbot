/** Pure node:crypto RFC 8291 (aes128gcm) content encryption and RFC 8292 VAPID ES256 JWT signing. */
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";

interface EcJwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
}

export interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

export interface VapidJwtInput {
  endpoint: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  nowSec?: number;
  ttlSeconds?: number;
}

export interface EncryptWebPushInput {
  payload: Uint8Array | string;
  p256dh: string;
  auth: string;
  salt?: Buffer;
}

export interface EncryptedWebPushPayload {
  ciphertext: Buffer;
  salt: Buffer;
  serverPublicKey: Buffer;
}

export const WEB_PUSH_RECORD_SIZE = 4096;
/** Single aes128gcm record: 16-byte GCM auth tag + 1-byte RFC 8291 delimiter (0x02). */
export const WEB_PUSH_MAX_PLAINTEXT_BYTES = WEB_PUSH_RECORD_SIZE - 17;
export const VAPID_DEFAULT_TTL_SECONDS = 12 * 60 * 60;
export const VAPID_MAX_TTL_SECONDS = 24 * 60 * 60;

const VAPID_PUBLIC_KEY_BYTES = 65;
const VAPID_SCALAR_BYTES = 32;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const PRK_INFO_PREFIX = Buffer.from("WebPush: info\0", "ascii");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "ascii");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "ascii");

const b64url = (data: Uint8Array | Buffer): string => Buffer.from(data).toString("base64url");

export function decodeBase64UrlStrict(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Non-canonical base64url encoding");
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new Error(`Expected ${expectedBytes} bytes, got ${decoded.length}`);
  }
  return decoded;
}

/** Parses either an uncompressed 65-byte P-256 point (0x04 || x || y) or raw 32-byte scalar as base64url. */
export function generateVapidKeys(): VapidKeyPair {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" }) as EcJwk;
  if (!jwk.x || !jwk.y || !jwk.d) {
    throw new Error("Failed to export generated P-256 JWK");
  }
  const pub = Buffer.concat([
    Buffer.from([0x04]),
    decodeBase64UrlStrict(jwk.x, 32),
    decodeBase64UrlStrict(jwk.y, 32),
  ]);
  return {
    publicKey: b64url(pub),
    privateKey: b64url(decodeBase64UrlStrict(jwk.d, VAPID_SCALAR_BYTES)),
  };
}

export function isValidVapidKeyPair(pair: Partial<VapidKeyPair> | null | undefined): pair is VapidKeyPair {
  if (!pair || typeof pair.publicKey !== "string" || typeof pair.privateKey !== "string") return false;
  try {
    const pub = decodeBase64UrlStrict(pair.publicKey, VAPID_PUBLIC_KEY_BYTES);
    if (pub[0] !== 0x04) return false;
    const d = decodeBase64UrlStrict(pair.privateKey, VAPID_SCALAR_BYTES);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    const derived = ecdh.getPublicKey(undefined, "uncompressed");
    return derived.equals(pub);
  } catch {
    return false;
  }
}

export function vapidPrivateKeyObject(publicKeyB64Url: string, privateKeyB64Url: string) {
  const pub = decodeBase64UrlStrict(publicKeyB64Url, VAPID_PUBLIC_KEY_BYTES);
  if (pub[0] !== 0x04) throw new Error("VAPID public key must be an uncompressed P-256 point");
  const d = decodeBase64UrlStrict(privateKeyB64Url, VAPID_SCALAR_BYTES);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  if (!ecdh.getPublicKey(undefined, "uncompressed").equals(pub)) {
    throw new Error("VAPID private key does not match public key");
  }
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: b64url(d),
    },
    format: "jwk",
  });
}

export function vapidPublicKeyObject(publicKeyB64Url: string) {
  const pub = decodeBase64UrlStrict(publicKeyB64Url, VAPID_PUBLIC_KEY_BYTES);
  if (pub[0] !== 0x04) throw new Error("VAPID public key must be an uncompressed P-256 point");
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
}

function validateVapidSubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) throw new Error("VAPID subject is required");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("VAPID subject must be a valid mailto: or https: URL");
  }
  if (parsed.protocol !== "mailto:" && parsed.protocol !== "https:") {
    throw new Error("VAPID subject must use mailto: or https:");
  }
  return trimmed;
}

/** Signs an RFC 8292 ES256 JWT (`vapid t=<jwt>, k=<publicKey>`) scoped to the endpoint origin. */
export function buildVapidHeaders(input: VapidJwtInput): { authorization: string; jwt: string } {
  const endpointUrl = new URL(input.endpoint);
  if (endpointUrl.protocol !== "https:") {
    throw new Error("VAPID audience endpoint must use https:");
  }
  const aud = endpointUrl.origin;
  const sub = validateVapidSubject(input.subject);
  const nowSec = Math.floor(input.nowSec ?? Date.now() / 1000);
  const ttlSeconds = Math.max(60, Math.min(Math.floor(input.ttlSeconds ?? VAPID_DEFAULT_TTL_SECONDS), VAPID_MAX_TTL_SECONDS));
  const exp = nowSec + ttlSeconds;

  const headerB64 = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"));
  const claimsB64 = b64url(Buffer.from(JSON.stringify({ aud, exp, sub }), "utf8"));
  const signingInput = `${headerB64}.${claimsB64}`;

  const key = vapidPrivateKeyObject(input.publicKey, input.privateKey);
  const sig = sign("sha256", Buffer.from(signingInput, "ascii"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  const jwt = `${signingInput}.${b64url(sig)}`;
  return {
    jwt,
    authorization: `vapid t=${jwt}, k=${input.publicKey}`,
  };
}

/** Validates a browser `PushSubscription` P-256 public key and converts it to a normalized 65-byte buffer. */
export function normalizeP256dhKey(p256dhB64Url: string): Buffer {
  const raw = decodeBase64UrlStrict(p256dhB64Url, VAPID_PUBLIC_KEY_BYTES);
  if (raw[0] !== 0x04) {
    throw new Error("Subscription p256dh key must be an uncompressed P-256 public key");
  }
  // Confirm the point sits cleanly on prime256v1 using Node's OpenSSL curve check.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  ecdh.computeSecret(raw);
  return raw;
}

export function normalizeAuthSecret(authB64Url: string): Buffer {
  return decodeBase64UrlStrict(authB64Url, AUTH_SECRET_BYTES);
}

/**
 * Encrypts payload bytes per RFC 8291 (Message Encryption for Web Push) and RFC 8188 (`aes128gcm`),
 * returning a single self-contained record body ready for HTTP POST with `Content-Encoding: aes128gcm`.
 */
export function encryptWebPushPayload(input: EncryptWebPushInput): EncryptedWebPushPayload {
  const plaintext = typeof input.payload === "string" ? Buffer.from(input.payload, "utf8") : Buffer.from(input.payload);
  if (plaintext.length > WEB_PUSH_MAX_PLAINTEXT_BYTES) {
    throw new Error(`Web Push plaintext exceeds single-record limit (${WEB_PUSH_MAX_PLAINTEXT_BYTES} bytes)`);
  }

  const uaPublic = normalizeP256dhKey(input.p256dh);
  const authSecret = normalizeAuthSecret(input.auth);
  const salt = input.salt ? Buffer.from(input.salt) : randomBytes(SALT_BYTES);
  if (salt.length !== SALT_BYTES) {
    throw new Error(`Salt must be ${SALT_BYTES} bytes`);
  }

  const asEcdh = createECDH("prime256v1");
  asEcdh.generateKeys();
  const asPublic = asEcdh.getPublicKey(undefined, "uncompressed");
  const ecdhSecret = asEcdh.computeSecret(uaPublic);

  // RFC 8291 §3.3 / §3.4:
  // PRK_key = HMAC-SHA256(auth_secret, ecdh_secret)
  // IKM = HKDF-Expand(PRK_key, "WebPush: info\0" || ua_public || as_public, 32)
  const prkKey = createHmac("sha256", authSecret).update(ecdhSecret).digest();
  const keyInfo = Buffer.concat([PRK_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(createHmac("sha256", prkKey).update(Buffer.concat([keyInfo, Buffer.from([0x01])])).digest());

  // RFC 8188 §2.2-2.3 using Node's native HKDF-SHA256.
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, NONCE_INFO, 12));

  const paddedPlaintext = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(paddedPlaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // RFC 8188 §2.1 header: salt(16) || rs(uint32be) || idlen(uint8) || keyid(65)
  const header = Buffer.allocUnsafe(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(WEB_PUSH_RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  asPublic.copy(header, 21);

  return {
    ciphertext: Buffer.concat([header, encrypted, authTag]),
    salt,
    serverPublicKey: asPublic,
  };
}
