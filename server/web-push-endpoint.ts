/** SSRF and DNS-rebinding guards for Web Push subscription endpoints. */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

export const WEB_PUSH_ENDPOINT_MAX = 2048;

const BLOCKED_IPV4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const;
const BLOCKED_IPV6 = [
  ["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const;

const NON_PUBLIC_BLOCKLIST = (() => {
  const l = new BlockList();
  BLOCKED_IPV4.forEach(([n, p]) => l.addSubnet(n, p, "ipv4"));
  BLOCKED_IPV6.forEach(([n, p]) => l.addSubnet(n, p, "ipv6"));
  l.addAddress("255.255.255.255", "ipv4");
  return l;
})();
const NAT64_PREFIX = (() => { const l = new BlockList(); l.addSubnet("64:ff9b::", 96, "ipv6"); return l; })();
const SIX_TO_FOUR_PREFIX = (() => { const l = new BlockList(); l.addSubnet("2002::", 16, "ipv6"); return l; })();
const GLOBAL_UNICAST_V6 = (() => { const l = new BlockList(); l.addSubnet("2000::", 3, "ipv6"); return l; })();

function ipv6Groups(address: string): number[] {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? `${address.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : address;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(fill).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
}

function unwrapEmbeddedIpv4(address: string): string | undefined {
  const mappedMatch = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i.exec(address);
  if (mappedMatch) {
    if (mappedMatch[1]!.includes(".")) return mappedMatch[1]!;
    const [hi, lo] = mappedMatch[1]!.split(":").map((part) => Number.parseInt(part, 16));
    if (hi !== undefined && lo !== undefined) {
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
  }
  const offset = NAT64_PREFIX.check(address, "ipv6") ? 6 : SIX_TO_FOUR_PREFIX.check(address, "ipv6") ? 1 : -1;
  if (offset === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[offset] ?? 0;
  const low = groups[offset + 1] ?? 0;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isForbiddenWebPushIp(rawAddress: string): boolean {
  const bare = rawAddress.replace(/^\[|\]$/g, "").split("%", 1)[0]!.trim();
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 4) {
    return NON_PUBLIC_BLOCKLIST.check(bare, "ipv4");
  }
  const embedded = unwrapEmbeddedIpv4(bare);
  if (embedded && isIP(embedded) === 4 && NON_PUBLIC_BLOCKLIST.check(embedded, "ipv4")) {
    return true;
  }
  if (!GLOBAL_UNICAST_V6.check(bare, "ipv6")) return true;
  return NON_PUBLIC_BLOCKLIST.check(bare, "ipv6");
}

const RESERVED_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|invalid|home\.arpa|arpa|localdomain)$/i;

export class WebPushEndpointError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WebPushEndpointError";
    this.status = status;
  }
}

function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || /\s/.test(value[i])) return true;
  }
  return false;
}

/** Validates syntactic SSRF invariants for a browser PushSubscription endpoint before storage or outbound delivery. */
export function validateWebPushEndpoint(rawEndpoint: string): URL {
  const trimmed = rawEndpoint.trim();
  if (!trimmed || trimmed.length > WEB_PUSH_ENDPOINT_MAX || hasControlOrSpace(trimmed)) {
    throw new WebPushEndpointError("Invalid Web Push endpoint URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new WebPushEndpointError("Invalid Web Push endpoint URL");
  }
  if (parsed.protocol !== "https:") {
    throw new WebPushEndpointError("Web Push endpoint must use https:");
  }
  if (parsed.username || parsed.password) {
    throw new WebPushEndpointError("Web Push endpoint must not contain credentials");
  }
  if (parsed.hash) {
    throw new WebPushEndpointError("Web Push endpoint must not contain a fragment");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253) {
    throw new WebPushEndpointError("Web Push endpoint host is invalid");
  }
  const bareHost = hostname.replace(/^\[|\]$/g, "");
  if (isIP(bareHost) !== 0) {
    if (isForbiddenWebPushIp(bareHost)) {
      throw new WebPushEndpointError("Web Push endpoint IP address is not allowed");
    }
    return parsed;
  }
  if (RESERVED_HOST_SUFFIX.test(hostname) || !hostname.includes(".")) {
    throw new WebPushEndpointError("Web Push endpoint host is not allowed");
  }
  if (!hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new WebPushEndpointError("Web Push endpoint host is invalid");
  }
  return parsed;
}

export async function resolveAndValidateWebPushEndpoint(
  rawEndpoint: string,
  lookup: (hostname: string) => Promise<LookupAddress[]> = (hostname) => dnsLookup(hostname, { all: true, verbatim: true }),
): Promise<{ url: URL; address: LookupAddress }> {
  const url = validateWebPushEndpoint(rawEndpoint);
  const bareHost = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const literalFamily = isIP(bareHost);
  if (literalFamily === 4 || literalFamily === 6) {
    return { url, address: { address: bareHost, family: literalFamily } };
  }
  const addresses = await lookup(bareHost);
  if (!addresses.length) {
    throw new WebPushEndpointError("Web Push endpoint host could not be resolved");
  }
  for (const entry of addresses) {
    if (isIP(entry.address) !== entry.family || isForbiddenWebPushIp(entry.address)) {
      throw new WebPushEndpointError("Web Push endpoint resolves to a forbidden IP address");
    }
  }
  const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { url, address: chosen };
}
