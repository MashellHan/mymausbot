import { createDecipheriv, createECDH, createHmac, hkdfSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  WEB_PUSH_MAX_PLAINTEXT_BYTES,
  buildVapidHeaders,
  decodeBase64UrlStrict,
  encryptWebPushPayload,
  generateVapidKeys,
  isValidVapidKeyPair,
  normalizeAuthSecret,
  normalizeP256dhKey,
  vapidPublicKeyObject,
} from "./web-push-crypto.ts";

function decryptAes128Gcm(ciphertext: Buffer, uaPrivateKey: Buffer, authSecret: Buffer): Buffer {
  const salt = ciphertext.subarray(0, 16);
  const rs = ciphertext.readUInt32BE(16);
  const idlen = ciphertext.readUInt8(20);
  expect(rs).toBe(4096);
  expect(idlen).toBe(65);
  const asPublic = ciphertext.subarray(21, 21 + idlen);
  const encryptedRecord = ciphertext.subarray(21 + idlen);
  const body = encryptedRecord.subarray(0, encryptedRecord.length - 16);
  const tag = encryptedRecord.subarray(encryptedRecord.length - 16);

  const uaEcdh = createECDH("prime256v1");
  uaEcdh.setPrivateKey(uaPrivateKey);
  const uaPublic = uaEcdh.getPublicKey(undefined, "uncompressed");
  const ecdhSecret = uaEcdh.computeSecret(asPublic);

  const prkKey = createHmac("sha256", authSecret).update(ecdhSecret).digest();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), uaPublic, asPublic]);
  const ikm = createHmac("sha256", prkKey).update(Buffer.concat([keyInfo, Buffer.from([0x01])])).digest();

  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12));

  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(body), decipher.final()]);
  const delimIndex = padded.lastIndexOf(0x02);
  expect(delimIndex).toBeGreaterThanOrEqual(0);
  for (let i = delimIndex + 1; i < padded.length; i++) {
    expect(padded[i]).toBe(0);
  }
  return padded.subarray(0, delimIndex);
}

describe("web-push-crypto", () => {
  it("generates valid P-256 VAPID keys and detects mismatched pairs", () => {
    const first = generateVapidKeys();
    const second = generateVapidKeys();

    expect(isValidVapidKeyPair(first)).toBe(true);
    expect(isValidVapidKeyPair(second)).toBe(true);
    expect(decodeBase64UrlStrict(first.publicKey).length).toBe(65);
    expect(decodeBase64UrlStrict(first.privateKey).length).toBe(32);
    expect(isValidVapidKeyPair({ publicKey: first.publicKey, privateKey: second.privateKey })).toBe(false);
    expect(isValidVapidKeyPair({ publicKey: "bad", privateKey: first.privateKey })).toBe(false);
  });

  it("signs verifiable ES256 VAPID JWT headers scoped to the push service origin", () => {
    const keys = generateVapidKeys();
    const headers = buildVapidHeaders({
      endpoint: "https://web.push.apple.com/QMx123/token-abc?ignored=query",
      subject: "mailto:ops@openmausbot.example",
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      nowSec: 1_700_000_000,
      ttlSeconds: 3600,
    });

    expect(headers.authorization).toBe(`vapid t=${headers.jwt}, k=${keys.publicKey}`);
    const parts = headers.jwt.split(".");
    expect(parts).toHaveLength(3);
    const [headB64, claimsB64, sigB64] = parts as [string, string, string];
    expect(JSON.parse(Buffer.from(headB64, "base64url").toString("utf8"))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(Buffer.from(claimsB64, "base64url").toString("utf8"))).toEqual({
      aud: "https://web.push.apple.com",
      exp: 1_700_003_600,
      sub: "mailto:ops@openmausbot.example",
    });

    const sig = decodeBase64UrlStrict(sigB64, 64);
    const verified = verify(
      "sha256",
      Buffer.from(`${headB64}.${claimsB64}`, "ascii"),
      { key: vapidPublicKeyObject(keys.publicKey), dsaEncoding: "ieee-p1363" },
      sig,
    );
    expect(verified).toBe(true);
  });

  it("rejects invalid VAPID subjects and non-https push endpoints", () => {
    const keys = generateVapidKeys();
    expect(() =>
      buildVapidHeaders({
        endpoint: "http://web.push.apple.com/abc",
        subject: "mailto:ops@openmausbot.example",
        ...keys,
      }),
    ).toThrow(/https/);
    expect(() =>
      buildVapidHeaders({
        endpoint: "https://web.push.apple.com/abc",
        subject: "http://insecure.example",
        ...keys,
      }),
    ).toThrow(/mailto:|https:/);
    for (const badSubject of [
      "mailto:notifications@openmausbot.invalid",
      "mailto:ops@localhost",
      "mailto:ops@host.local",
      "mailto:missing-domain",
      "https://openmausbot.invalid",
      "https://localhost:3000",
      "https://sub.localhost",
      "https://127.0.0.1:8443",
      "https://[::1]",
      "https://mac.local",
    ]) {
      expect(
        () =>
          buildVapidHeaders({
            endpoint: "https://web.push.apple.com/abc",
            subject: badSubject,
            ...keys,
          }),
        badSubject,
      ).toThrow();
    }
    const httpsHeaders = buildVapidHeaders({
      endpoint: "https://web.push.apple.com/abc",
      subject: "https://openmausbot.com",
      ...keys,
    });
    const claims = JSON.parse(Buffer.from(httpsHeaders.jwt.split(".")[1]!, "base64url").toString("utf8")) as { sub: string };
    expect(claims.sub).toBe("https://openmausbot.com");
  });

  it("encrypts RFC 8291 aes128gcm payloads that round-trip cleanly with the subscriber keys", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const p256dh = ua.getPublicKey(undefined, "uncompressed").toString("base64url");
    const auth = Buffer.alloc(16, 0x5a).toString("base64url");
    const message = JSON.stringify({ version: 1, id: "n1", kind: "approval", title: "Scout needs approval", tag: "omb:approval:t1", ts: 123 });

    const { ciphertext, serverPublicKey, salt } = encryptWebPushPayload({
      payload: message,
      p256dh,
      auth,
    });

    expect(serverPublicKey).toHaveLength(65);
    expect(salt).toHaveLength(16);
    expect(ciphertext.length).toBe(16 + 4 + 1 + 65 + Buffer.byteLength(message, "utf8") + 1 + 16);

    const recovered = decryptAes128Gcm(ciphertext, ua.getPrivateKey(), Buffer.alloc(16, 0x5a));
    expect(recovered.toString("utf8")).toBe(message);
  });

  it("validates p256dh points, auth length, non-canonical base64url, and single-record size", () => {
    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const p256dh = ua.getPublicKey(undefined, "uncompressed").toString("base64url");
    const auth = Buffer.alloc(16, 1).toString("base64url");

    expect(() => normalizeP256dhKey("not-valid-b64!")).toThrow();
    expect(() => normalizeP256dhKey(Buffer.alloc(65, 0x04).toString("base64url"))).toThrow();
    expect(() => normalizeAuthSecret(Buffer.alloc(15, 1).toString("base64url"))).toThrow();
    expect(() => decodeBase64UrlStrict(`${auth}=`)).toThrow();

    expect(() =>
      encryptWebPushPayload({
        payload: Buffer.alloc(WEB_PUSH_MAX_PLAINTEXT_BYTES + 1, 0x61),
        p256dh,
        auth,
      }),
    ).toThrow(/single-record/);
  });
});
