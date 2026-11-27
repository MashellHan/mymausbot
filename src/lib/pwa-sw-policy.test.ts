import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SW_PATH = resolve(ROOT, "public/sw.js");

interface MockCacheStore {
  entries: Map<string, Response>;
  match(req: string | Request): Promise<Response | undefined>;
  put(req: string | Request, res: Response): Promise<void>;
  delete(req: string | Request): Promise<boolean>;
  keys(): Promise<Request[]>;
}

function makeMockCache(): MockCacheStore {
  const entries = new Map<string, Response>();
  const keyOf = (req: string | Request) => (typeof req === "string" ? req : req.url);
  return {
    entries,
    async match(req) {
      return entries.get(keyOf(req));
    },
    async put(req, res) {
      entries.set(keyOf(req), res);
    },
    async delete(req) {
      return entries.delete(keyOf(req));
    },
    async keys() {
      return Array.from(entries.keys(), (u) => new Request(u.startsWith("http") ? u : `https://mausbot.mxhan.com${u}`));
    },
  };
}

function createSwHarness(fetchImpl: (req: Request | string) => Promise<Response>) {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const storeMap = new Map<string, MockCacheStore>();
  const postedMessages: unknown[] = [];
  const navigated: string[] = [];

  const cachesMock = {
    async open(name: string) {
      let c = storeMap.get(name);
      if (!c) {
        c = makeMockCache();
        storeMap.set(name, c);
      }
      return c;
    },
    async keys() {
      return Array.from(storeMap.keys());
    },
    async delete(name: string) {
      return storeMap.delete(name);
    },
  };

  const selfObj = {
    location: { origin: "https://mausbot.mxhan.com" },
    skipWaiting: vi.fn(async () => {}),
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => [
        {
          url: "https://mausbot.mxhan.com/",
          postMessage: (msg: unknown) => postedMessages.push(msg),
          navigate: async (url: string) => {
            navigated.push(url);
            return null;
          },
        },
      ]),
    },
    addEventListener(type: string, cb: (event: any) => void) {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
  };

  const sandbox = {
    self: selfObj,
    caches: cachesMock,
    fetch: fetchImpl,
    URL,
    Request,
    Response,
    Headers,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    console,
  };

  vm.runInNewContext(readFileSync(SW_PATH, "utf8"), sandbox);

  async function dispatchLifecycle(type: "install" | "activate") {
    const waits: Promise<unknown>[] = [];
    for (const cb of listeners.get(type) ?? []) {
      cb({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    }
    await Promise.all(waits);
  }

  async function dispatchFetch(request: Request): Promise<Response | null> {
    const waits: Promise<unknown>[] = [];
    let responsePromise: Promise<Response> | null = null;
    for (const cb of listeners.get("fetch") ?? []) {
      cb({
        request,
        waitUntil: (p: Promise<unknown>) => waits.push(p),
        respondWith: (p: Promise<Response>) => {
          responsePromise = p;
        },
      });
    }
    const response = responsePromise ? await responsePromise : null;
    await Promise.all(waits);
    return response;
  }

  return { storeMap, postedMessages, navigated, dispatchLifecycle, dispatchFetch };
}

function makeBasicResponse(body: string, contentType: string): Response {
  const res = new Response(body, { status: 200, headers: { "content-type": contentType } });
  Object.defineProperty(res, "type", { value: "basic" });
  return res;
}

describe("public/sw.js v6 bounded asset cache & font protection", () => {
  it("preserves omb-pwa-assets-v1 across shell v5 -> v6 upgrades while deleting old shell caches", async () => {
    const harness = createSwHarness(async () => makeBasicResponse("ok", "application/javascript"));
    harness.storeMap.set("omb-pwa-shell-v5", makeMockCache());
    const assets = makeMockCache();
    await assets.put(
      "https://mausbot.mxhan.com/assets/vendor-react-abc.js",
      makeBasicResponse("react", "application/javascript"),
    );
    harness.storeMap.set("omb-pwa-assets-v1", assets);

    await harness.dispatchLifecycle("activate");
    expect(harness.storeMap.has("omb-pwa-shell-v5")).toBe(false);
    expect(harness.storeMap.has("omb-pwa-assets-v1")).toBe(true);
    expect(harness.storeMap.get("omb-pwa-assets-v1")?.entries.size).toBe(1);
  });

  it("prunes oldest JS chunks past 96 entries while protecting cached .woff2 fonts", async () => {
    const harness = createSwHarness(async (req) => {
      const url = typeof req === "string" ? req : req.url;
      return makeBasicResponse("body", url.endsWith(".woff2") ? "font/woff2" : "application/javascript");
    });

    await harness.dispatchFetch(new Request("https://mausbot.mxhan.com/assets/inter-latin.woff2"));
    for (let i = 0; i < 104; i += 1) {
      await harness.dispatchFetch(new Request(`https://mausbot.mxhan.com/assets/chunk-${i}.js`));
    }

    const assetCache = harness.storeMap.get("omb-pwa-assets-v1")!;
    expect(assetCache.entries.size).toBe(96);
    expect(assetCache.entries.has("https://mausbot.mxhan.com/assets/inter-latin.woff2")).toBe(true);
    expect(assetCache.entries.has("https://mausbot.mxhan.com/assets/chunk-0.js")).toBe(false);
    expect(assetCache.entries.has("https://mausbot.mxhan.com/assets/chunk-103.js")).toBe(true);
  });

  it("refuses to cache SPA HTML fallback for missing /assets/* and clears stale shell '/'", async () => {
    const harness = createSwHarness(async () => makeBasicResponse("<html>fallback</html>", "text/html"));
    const shell = makeMockCache();
    await shell.put("/", makeBasicResponse("<html>old</html>", "text/html"));
    harness.storeMap.set("omb-pwa-shell-v6", shell);

    const res = await harness.dispatchFetch(new Request("https://mausbot.mxhan.com/assets/deleted-hash.js"));
    expect(res?.status).toBe(404);
    expect(shell.entries.has("/")).toBe(false);
    expect(harness.postedMessages).toEqual([{ type: "omb:stale-asset-reload" }]);
    expect(harness.navigated).toEqual(["https://mausbot.mxhan.com/"]);
  });
});
