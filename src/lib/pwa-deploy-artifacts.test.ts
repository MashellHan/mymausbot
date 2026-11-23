import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import workerProxy from "../../deploy/pwa-cf/worker-proxy";

const ROOT = resolve(__dirname, "../..");

describe("Stage 8 Cloudflare Pages headers & optional Worker proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defines no-cache for sw.js, immutable for assets, and strict CSP allowing relay.mxhan.com + blob:", () => {
    const headersPath = resolve(ROOT, "deploy/pwa-cf/public/_headers");
    expect(existsSync(headersPath)).toBe(true);
    const content = readFileSync(headersPath, "utf8");
    expect(content).toContain("https://relay.mxhan.com");
    expect(content).toContain("wss://relay.mxhan.com");
    expect(content).toContain("blob:");
    expect(content).toMatch(/\/sw\.js[\s\S]*?Cache-Control:\s*no-cache/);
    expect(content).toMatch(/\/assets\/\*[\s\S]*?Cache-Control:[^\n]*immutable/);
  });

  it("proxies /api/* without caching or leaking cookies and rejects non-/api/* paths", async () => {
    const nonApi = await workerProxy.fetch(new Request("https://mausbot.mxhan.com/index.html"), {});
    expect(nonApi.status).toBe(404);
    expect(nonApi.headers.get("cache-control")).toBe("no-store");

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedInit = init;
        return new Response(JSON.stringify({ ok: true }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": "5",
            "set-cookie": "bad=1",
          },
        });
      }),
    );

    const proxied = await workerProxy.fetch(
      new Request("https://mausbot.mxhan.com/api/snapshot?bot=accounting", {
        method: "GET",
        headers: {
          authorization: "Bearer tok-1",
          cookie: "secret=bad",
          "x-forwarded-for": "1.2.3.4",
          "x-omb-background": "1",
        },
      }),
      { RELAY_ORIGIN: "https://relay.mxhan.com" },
    );

    expect(capturedUrl).toBe("https://relay.mxhan.com/api/snapshot?bot=accounting");
    const sentHeaders = new Headers(capturedInit?.headers);
    expect(sentHeaders.get("authorization")).toBe("Bearer tok-1");
    expect(sentHeaders.get("x-omb-background")).toBe("1");
    expect(sentHeaders.has("cookie")).toBe(false);
    expect(sentHeaders.has("x-forwarded-for")).toBe(false);
    expect(proxied.status).toBe(503);
    expect(proxied.headers.get("retry-after")).toBe("5");
    expect(proxied.headers.get("cache-control")).toBe("no-store");
    expect(proxied.headers.has("set-cookie")).toBe(false);
  });
});
