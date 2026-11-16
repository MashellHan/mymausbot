import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";
import { isPublicDomainAddress } from "../custom-domain.ts";

const API_DOMAINS = ["fqnovel.com", "reading.snssdk.com"];
const MEDIA_DOMAINS = ["douyinvod.com", "bytevod.com", "ibytedtos.com", "bytedance.com", "fqnovel.com", "qznovelvod.com"];
const IMAGE_DOMAINS = ["byteimg.com", "fqnovelpic.com", "fqnovel.com"];
export type HongguoUrlKind = "api" | "media" | "image";

export function hongguoUrl(raw: string, kind: HongguoUrlKind): URL | null {
  try {
    const url = new URL(raw);
    const domains = kind === "api" ? API_DOMAINS : kind === "media" ? MEDIA_DOMAINS : IMAGE_DOMAINS;
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.port
      && domains.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url : null;
  } catch { return null; }
}

export interface HongguoHttpResult { status: number; headers: IncomingHttpHeaders; body: Buffer }

export async function hongguoRequest(raw: string, kind: HongguoUrlKind, options: {
  method?: string; headers?: Record<string, string>; body?: Uint8Array; signal?: AbortSignal; maxBytes?: number;
} = {}): Promise<HongguoHttpResult> {
  const url = hongguoUrl(raw, kind);
  if (!url) throw new Error("The provider returned an unsupported address.");
  options.signal?.throwIfAborted();
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(() => reject(new Error("The provider address timed out.")), 5_000);
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicDomainAddress(address))) {
    throw new Error("The provider address is unavailable.");
  }
  const address = addresses.find((item) => item.family === 4) ?? addresses[0]!;
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method ?? "GET", headers: options.headers, signal: options.signal,
      agent: false, lookup: pinnedLookup,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > (options.maxBytes ?? 8 * 1024 * 1024)) req.destroy(new Error("The provider response is too large."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => req.destroy(new Error("The provider request timed out.")), 20_000);
    req.once("close", () => clearTimeout(timer));
    req.once("error", reject);
    req.end(options.body);
  });
}

export async function hongguoMediaBytes(raw: string, signal?: AbortSignal): Promise<Buffer> {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const result = await hongguoRequest(url, "media", { maxBytes: 64 * 1024 * 1024, signal });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      url = new URL(result.headers.location, url).href;
      continue;
    }
    if (result.status !== 200 || result.body.length < 12 || result.body.toString("ascii", 4, 8) !== "ftyp") {
      throw new Error("This episode's media is unavailable.");
    }
    return result.body;
  }
  throw new Error("This episode's media could not be reached.");
}
