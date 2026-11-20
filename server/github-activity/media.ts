import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { githubMediaUrlAllowed } from "../../electron/github-activity-frame.mjs";
import { isPublicDomainAddress } from "../custom-domain.ts";
import { appFailure } from "../mini-apps/validation.ts";

export const GITHUB_ACTIVITY_APP_ID = "0643df6c-24ea-4076-87b6-572d3637a4d9";
export const GITHUB_MEDIA_POLICY_DENIED = "github_media_policy_denied";
export const MAX_GITHUB_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_GITHUB_VIDEO_BYTES = 32 * 1024 * 1024;

const MEDIA_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export interface GithubMediaHttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export function expectedMediaMimeType(rawUrl: string): string | null {
  if (!githubMediaUrlAllowed(rawUrl)) return null;
  const pathname = new URL(rawUrl).pathname.toLowerCase();
  const ext = Object.keys(MEDIA_MIME_BY_EXT).find((candidate) => pathname.endsWith(candidate));
  return ext ? MEDIA_MIME_BY_EXT[ext]! : null;
}

export function isValidMediaSha256(raw: unknown): raw is string {
  return typeof raw === "string" && /^[0-9a-f]{64}$/.test(raw);
}

export function verifyMediaSignature(mimeType: string, bytes: Buffer): boolean {
  if (!bytes.length) return false;
  switch (mimeType) {
    case "image/png":
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif": {
      const head = bytes.subarray(0, 6).toString("ascii");
      return head === "GIF87a" || head === "GIF89a";
    }
    case "image/webp":
      return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case "image/avif": {
      if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") return false;
      const major = bytes.subarray(8, 12).toString("ascii");
      return major === "avif" || major === "avis"
        || (major === "mif1" && bytes.subarray(16, Math.min(bytes.length, 64)).includes("avif"));
    }
    case "video/mp4":
      return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
    case "video/webm":
      return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    default:
      return false;
  }
}

export async function githubMediaRequest(rawUrl: string, options: {
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<GithubMediaHttpResult> {
  if (!githubMediaUrlAllowed(rawUrl)) throw appFailure(400, "Unsupported GitHub Activity media address.");
  const url = new URL(rawUrl);
  options.signal?.throwIfAborted();
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(() => reject(appFailure(504, "The GitHub Activity media host timed out.")), 5_000);
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicDomainAddress(address))) {
    throw appFailure(403, "The GitHub Activity media host is unavailable.", GITHUB_MEDIA_POLICY_DENIED);
  }
  const address = addresses.find((item) => item.family === 4) ?? addresses[0]!;
  const pinnedLookup: LookupFunction = (_host, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      signal: options.signal,
      agent: false,
      lookup: pinnedLookup,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) req.destroy(appFailure(413, "This GitHub Activity media asset is too large."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode ?? 502,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    const timer = setTimeout(() => req.destroy(appFailure(504, "The GitHub Activity media request timed out.")), 20_000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end();
  });
}

export async function fetchGithubActivityMedia(rawUrl: string, expectedSha256: string, signal?: AbortSignal,
  requestFn: typeof githubMediaRequest = githubMediaRequest): Promise<{ mimeType: string; bytes: Buffer; sha256: string }> {
  const expectedMime = expectedMediaMimeType(rawUrl);
  if (!expectedMime || !isValidMediaSha256(expectedSha256)) {
    throw appFailure(400, "Invalid GitHub Activity media request.");
  }
  let currentUrl = rawUrl;
  for (let hop = 0; hop < 4; hop++) {
    const hopMime = expectedMediaMimeType(currentUrl);
    if (!hopMime) throw appFailure(403, "Redirected GitHub Activity media address is not allowed.", GITHUB_MEDIA_POLICY_DENIED);
    const hopMaxBytes = hopMime.startsWith("video/") ? MAX_GITHUB_VIDEO_BYTES : MAX_GITHUB_IMAGE_BYTES;
    const result = await requestFn(currentUrl, { maxBytes: hopMaxBytes, signal });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      currentUrl = new URL(result.headers.location, currentUrl).href;
      continue;
    }
    if (result.body.length > hopMaxBytes) {
      throw appFailure(413, "This GitHub Activity media asset is too large.");
    }
    if (result.status === 404) throw appFailure(404, "This GitHub Activity media asset was not found.");
    if (result.status !== 200) throw appFailure(502, "This GitHub Activity media asset is unavailable.");
    const contentType = String(result.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (contentType !== hopMime || !verifyMediaSignature(hopMime, result.body)) {
      throw appFailure(422, "This GitHub Activity media asset failed content validation.");
    }
    const actualSha256 = createHash("sha256").update(result.body).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw appFailure(422, "This GitHub Activity media asset failed integrity verification.");
    }
    return { mimeType: hopMime, bytes: result.body, sha256: actualSha256 };
  }
  throw appFailure(502, "This GitHub Activity media asset exceeded the redirect limit.");
}
