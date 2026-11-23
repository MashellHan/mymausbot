/**
 * Optional same-origin Cloudflare Worker proxy:
 *   https://mausbot.mxhan.com/api/* -> https://relay.mxhan.com/api/*
 *
 * Stateless, zero-cache, zero-logging pass-through. Independently deployable
 * and revertible via `wrangler deploy` / route removal without touching the
 * DO relay or Cloudflare Pages static build.
 */

export interface Env {
  RELAY_ORIGIN?: string;
}

const DEFAULT_RELAY_ORIGIN = "https://relay.mxhan.com";
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

function resolveRelayOrigin(raw: string | undefined): string {
  const candidate = (raw ?? DEFAULT_RELAY_ORIGIN).trim();
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("RELAY_ORIGIN must be an https:// origin without path or query");
  }
  return parsed.origin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.pathname !== "/api" && !incomingUrl.pathname.startsWith("/api/")) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    let relayOrigin: string;
    try {
      relayOrigin = resolveRelayOrigin(env.RELAY_ORIGIN);
    } catch {
      return new Response(JSON.stringify({ error: "Invalid relay origin configuration" }), {
        status: 500,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }

    const upstreamUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, relayOrigin);
    const forwardedHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
      forwardedHeaders.set(key, value);
    }

    const init: RequestInit & { cf?: { cacheTtl: number; cacheEverything: boolean } } = {
      method: request.method,
      headers: forwardedHeaders,
      redirect: "manual",
      cf: { cacheTtl: 0, cacheEverything: false },
    };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      init.body = request.body;
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl.toString(), init);
    } catch {
      return new Response(
        JSON.stringify({ error: "Relay unavailable", code: "relay_unavailable" }),
        {
          status: 503,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        },
      );
    }

    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.delete("set-cookie");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};
