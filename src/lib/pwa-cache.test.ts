import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot, ConfigStatus, Group, Message } from "@/state/store";
import { makePwaOwnerKey, OMB_PWA_DB_NAME, OMB_PWA_DB_VERSION } from "./pwa-config";
import {
  deletePwaOwnerCache,
  patchPwaPrefs,
  preloadPwaBootCache,
  PWA_SNAPSHOT_MESSAGE_LIMIT,
  readPwaPrefs,
  readPwaSnapshot,
  resetPwaCacheForTests,
  resolvePwaLaunchSelection,
  togglePinnedPwaBot,
  trimBotForSnapshot,
  trimGroupForSnapshot,
  writePwaPrefs,
  writePwaSnapshot,
} from "./pwa-cache";
import { registerPwaServiceWorker, shouldRegisterPwaServiceWorker } from "./pwa-sw";
import { setActivePwaAuth } from "./pwa-transport";

function createFakeIdbFactory(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const ensureStore = (name: string) => {
    let map = stores.get(name);
    if (!map) {
      map = new Map();
      stores.set(name, map);
    }
    return map;
  };
  return {
    open(_name: string) {
      const openReq: {
        result?: IDBDatabase;
        error?: DOMException | null;
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
        onsuccess: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
      } = { onupgradeneeded: null, onsuccess: null, onerror: null };
      const db = {
        objectStoreNames: { contains: (name: string) => stores.has(name) },
        createObjectStore: (name: string) => {
          ensureStore(name);
          return { createIndex: () => ({}) } as unknown as IDBObjectStore;
        },
        close: () => {},
        transaction: (storeNames: string | string[]) => {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          const tx = {
            error: null as DOMException | null,
            oncomplete: null as ((ev: Event) => void) | null,
            onerror: null as ((ev: Event) => void) | null,
            onabort: null as ((ev: Event) => void) | null,
            objectStore: (name: string) => {
              if (!names.includes(name)) throw new Error(`Missing store ${name}`);
              const store = ensureStore(name);
              return {
                getAll: () => {
                  const req = {
                    result: undefined as unknown,
                    error: null as DOMException | null,
                    onsuccess: null as ((ev: Event) => void) | null,
                    onerror: null as ((ev: Event) => void) | null,
                  };
                  queueMicrotask(() => {
                    req.result = [...store.values()];
                    req.onsuccess?.(new Event("success"));
                  });
                  return req as unknown as IDBRequest;
                },
                get: (key: string) => {
                  const req = {
                    result: undefined as unknown,
                    error: null as DOMException | null,
                    onsuccess: null as ((ev: Event) => void) | null,
                    onerror: null as ((ev: Event) => void) | null,
                  };
                  queueMicrotask(() => {
                    req.result = store.get(key);
                    req.onsuccess?.(new Event("success"));
                  });
                  return req as unknown as IDBRequest;
                },
                put: (value: unknown, key: string) => {
                  const req = {
                    result: key,
                    error: null as DOMException | null,
                    onsuccess: null as ((ev: Event) => void) | null,
                    onerror: null as ((ev: Event) => void) | null,
                  };
                  queueMicrotask(() => {
                    store.set(key, structuredClone(value));
                    req.onsuccess?.(new Event("success"));
                    tx.oncomplete?.(new Event("complete"));
                  });
                  return req as unknown as IDBRequest;
                },
                delete: (key: string) => {
                  const req = {
                    result: undefined,
                    error: null as DOMException | null,
                    onsuccess: null as ((ev: Event) => void) | null,
                    onerror: null as ((ev: Event) => void) | null,
                  };
                  queueMicrotask(() => {
                    store.delete(key);
                    req.onsuccess?.(new Event("success"));
                    tx.oncomplete?.(new Event("complete"));
                  });
                  return req as unknown as IDBRequest;
                },
              } as unknown as IDBObjectStore;
            },
          };
          return tx as unknown as IDBTransaction;
        },
      } as unknown as IDBDatabase;
      queueMicrotask(() => {
        openReq.result = db;
        openReq.onupgradeneeded?.({ target: openReq } as unknown as IDBVersionChangeEvent);
        openReq.onsuccess?.(new Event("success"));
      });
      return openReq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

function makeMessage(index: number): Message {
  return { id: `m-${index}`, role: "user", kind: "text", text: `msg ${index}`, at: 1_000 + index };
}

function makeBot(id: string, messageCount = 2): Bot {
  return {
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    busy: true,
    turnStartedAt: 1234,
    waitingForTeammates: true,
    awaitingThreadSnapshot: true,
    switchingTo: "other-thread",
    modelSelection: { instanceId: "inst-1", model: "gpt-6" },
    messages: Array.from({ length: messageCount }, (_, i) => makeMessage(i)),
    tasks: [{ threadId: `thread-${id}`, title: "Main", createdAt: 10, updatedAt: 10, busy: true, turnStartedAt: 1234, waitingForTeammates: true }],
  };
}

function makeGroup(id: string, messageCount = 2): Group {
  return {
    id,
    threadId: `group-thread-${id}`,
    name: id,
    memberIds: ["accounting"],
    defaultResponder: { kind: "everyone" },
    bulletin: "",
    createdAt: 10,
    unread: false,
    busyBotId: "accounting",
    turnStartedAt: 1234,
    messages: Array.from({ length: messageCount }, (_, i) => makeMessage(i)),
  };
}

describe("pwa-cache", () => {
  afterEach(() => {
    setActivePwaAuth(null);
    resetPwaCacheForTests();
    vi.restoreAllMocks();
  });

  it("partitions snapshot and prefs strictly by ownerKey so a re-paired session never sees prior data", async () => {
    const idb = createFakeIdbFactory();
    const ownerA = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-a");
    const ownerB = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-b");

    await writePwaPrefs({
      ownerKey: ownerA,
      pinnedBotId: "accounting",
      openPinnedOnLaunch: true,
      lastBotId: "accounting",
      lastThreadId: "thread-accounting",
      updatedAt: 100,
    }, idb);
    await writePwaSnapshot({
      ownerKey: ownerA,
      savedAt: 200,
      bots: [makeBot("accounting", 75)],
      groups: [makeGroup("room-1", 60)],
      sections: ["Finance"],
      config: { setup: false } as unknown as ConfigStatus,
    }, idb);

    expect(await readPwaSnapshot(ownerB, idb)).toBeNull();
    expect(await readPwaPrefs(ownerB, idb)).toBeNull();
    expect(await preloadPwaBootCache({ ownerKey: ownerB, defaultBotId: "general" }, { idb })).toBeNull();

    const snapA = await readPwaSnapshot(ownerA, idb);
    expect(snapA).not.toBeNull();
    expect(snapA!.bots[0]!.messages).toHaveLength(PWA_SNAPSHOT_MESSAGE_LIMIT);
    expect(snapA!.bots[0]!.messages[0]!.id).toBe("m-25");
    expect(snapA!.bots[0]!.hasMore).toBe(true);
    expect(snapA!.bots[0]!.busy).toBe(false);
    expect(snapA!.bots[0]!.awaitingThreadSnapshot).toBeUndefined();
    expect(snapA!.groups[0]!.messages).toHaveLength(PWA_SNAPSHOT_MESSAGE_LIMIT);
    expect(snapA!.groups[0]!.hasMore).toBe(true);
    expect(snapA!.groups[0]!.busyBotId).toBeNull();

    await deletePwaOwnerCache(ownerB, idb);
    expect(await readPwaSnapshot(ownerA, idb)).not.toBeNull();
    await deletePwaOwnerCache(ownerA, idb);
    expect(await readPwaSnapshot(ownerA, idb)).toBeNull();
    expect(await readPwaPrefs(ownerA, idb)).toBeNull();
  });

  it("resets transient running flags and strips optimistic rows when trimming bots and groups", () => {
    const botWithOptimistic = {
      ...makeBot("b1", 10),
      messages: [
        ...makeBot("b1", 10).messages,
        { id: "optimistic-pending-1", role: "user" as const, kind: "text" as const, text: "queued", at: 9_999, sendId: "pending-1" },
      ],
    };
    const trimmedBot = trimBotForSnapshot(botWithOptimistic, 5);
    expect(trimmedBot.messages).toHaveLength(5);
    expect(trimmedBot.messages.some((m) => m.id.startsWith("optimistic-"))).toBe(false);
    expect(trimmedBot.hasMore).toBe(true);
    expect(trimmedBot.busy).toBe(false);
    expect(trimmedBot.turnStartedAt).toBeNull();
    expect(trimmedBot.waitingForTeammates).toBe(false);
    expect(trimmedBot.tasks?.[0]?.busy).toBe(false);

    const groupWithOptimistic = {
      ...makeGroup("g1", 3),
      messages: [
        ...makeGroup("g1", 3).messages,
        { id: "optimistic-pending-2", role: "user" as const, kind: "text" as const, text: "queued", at: 9_999, sendId: "pending-2" },
      ],
    };
    const trimmedGroup = trimGroupForSnapshot(groupWithOptimistic, 5);
    expect(trimmedGroup.messages).toHaveLength(3);
    expect(trimmedGroup.messages.some((m) => m.id.startsWith("optimistic-"))).toBe(false);
    expect(trimmedGroup.hasMore).toBe(false);
    expect(trimmedGroup.busyBotId).toBeNull();
  });

  it("applies selection precedence: ?bot= -> pinnedBotId -> lastBotId -> defaultBotId -> first", () => {
    const bots = [
      makeBot("general"),
      { ...makeBot("accounting"), tasks: [{ threadId: "thread-accounting", title: "Main", createdAt: 1, updatedAt: 1 }, { threadId: "t-acc-2", title: "Tax", createdAt: 2, updatedAt: 2 }] },
      makeBot("ops"),
    ];
    const groups = [makeGroup("finance-room")];

    expect(resolvePwaLaunchSelection({
      queryBotId: "ops",
      prefs: { ownerKey: "k", pinnedBotId: "accounting", openPinnedOnLaunch: true, lastBotId: "general", updatedAt: 1 },
      defaultBotId: "general",
      bots,
      groups,
    })).toEqual({ selectedId: "ops", source: "query" });

    expect(resolvePwaLaunchSelection({
      queryBotId: "missing",
      prefs: { ownerKey: "k", pinnedBotId: "accounting", openPinnedOnLaunch: true, lastBotId: "general", updatedAt: 1 },
      defaultBotId: "general",
      bots,
      groups,
    })).toEqual({ selectedId: "accounting", source: "pinned" });

    expect(resolvePwaLaunchSelection({
      prefs: { ownerKey: "k", pinnedBotId: "accounting", openPinnedOnLaunch: false, lastBotId: "accounting", lastThreadId: "t-acc-2", updatedAt: 1 },
      defaultBotId: "general",
      bots,
      groups,
    })).toEqual({ selectedId: "accounting", threadId: "t-acc-2", source: "last" });

    expect(resolvePwaLaunchSelection({
      prefs: null,
      defaultBotId: "ops",
      bots,
      groups,
    })).toEqual({ selectedId: "ops", source: "default" });

    expect(resolvePwaLaunchSelection({
      prefs: null,
      bots,
      groups,
    })).toEqual({ selectedId: "general", source: "first" });
  });

  it("toggles pinned bot via 1-tap togglePinnedPwaBot", async () => {
    const idb = createFakeIdbFactory();
    const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-pin");
    await patchPwaPrefs(ownerKey, { lastBotId: "general" }, idb);

    const pinned = await togglePinnedPwaBot("accounting", ownerKey, idb);
    expect(pinned?.pinnedBotId).toBe("accounting");
    expect(pinned?.openPinnedOnLaunch).toBe(true);

    const unpinned = await togglePinnedPwaBot("accounting", ownerKey, idb);
    expect(unpinned?.pinnedBotId).toBeUndefined();
  });

  it("registers service worker only on HTTPS production web origins", async () => {
    const register = vi.fn().mockResolvedValue({ scope: "/" });
    expect(shouldRegisterPwaServiceWorker({ protocol: "https:", isDev: false, isElectron: false, serviceWorker: { register } })).toBe(true);
    expect(shouldRegisterPwaServiceWorker({ protocol: "http:", isDev: false, isElectron: false, serviceWorker: { register } })).toBe(false);
    expect(shouldRegisterPwaServiceWorker({ protocol: "https:", isDev: true, isElectron: false, serviceWorker: { register } })).toBe(false);
    expect(shouldRegisterPwaServiceWorker({ protocol: "https:", isDev: false, isElectron: true, serviceWorker: { register } })).toBe(false);

    await registerPwaServiceWorker({ protocol: "https:", isDev: false, isElectron: false, serviceWorker: { register } });
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
  });

  it("keeps public/sw.js scoped to static shell caches without touching /api/* or IndexedDB", () => {
    const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    expect(sw).toContain('pathname.startsWith("/api/")');
    expect(sw).toContain("omb-pwa-shell-");
    expect(sw).not.toContain("indexedDB");
    expect(sw).not.toContain("deleteDatabase");
    expect(OMB_PWA_DB_NAME).toBe("omb-pwa-v1");
    expect(OMB_PWA_DB_VERSION).toBe(3);
  });

  it("never caches or serves redirected responses for navigation or HTML fallbacks for /assets/*", async () => {
    const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
    const listeners = new Map<string, (event: any) => void>();
    const cacheEntries = new Map<string, Map<string, Response>>();
    const ensureCache = (name: string) => {
      let store = cacheEntries.get(name);
      if (!store) {
        store = new Map();
        cacheEntries.set(name, store);
      }
      return {
        put: async (req: string | Request, res: Response) => {
          const key = typeof req === "string" ? req : new URL(req.url).pathname;
          store!.set(key, res);
        },
        match: async (req: string | Request) => {
          const key = typeof req === "string" ? req : new URL(req.url).pathname;
          return store!.get(key);
        },
        delete: async (req: string | Request) => {
          const key = typeof req === "string" ? req : new URL(req.url).pathname;
          return store!.delete(key);
        },
      };
    };
    cacheEntries.set("omb-pwa-shell-v1", new Map([["/index.html", new Response("stale")]]));

    const mockFetch = vi.fn(async (input: string | Request) => {
      const path = typeof input === "string" ? input : new URL(input.url).pathname;
      const res = new Response(`<html>${path}</html>`, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "type", { value: "basic" });
      Object.defineProperty(res, "redirected", { value: path !== "/manifest.webmanifest" && path !== "/app-icon.svg" && path !== "/app-icon-192.png" && path !== "/app-icon-512.png" && path !== "/apple-touch-icon.png" && path !== "/" && !path.startsWith("/assets/") });
      return res;
    });

    const swGlobal = {
      location: { origin: "https://mausbot.mxhan.com" },
      skipWaiting: vi.fn(async () => {}),
      clients: { claim: vi.fn(async () => {}) },
      caches: {
        open: async (name: string) => ensureCache(name),
        keys: async () => Array.from(cacheEntries.keys()),
        delete: async (name: string) => cacheEntries.delete(name),
      },
      fetch: mockFetch,
      Response,
      Headers,
      URL,
      addEventListener: (type: string, handler: (event: any) => void) => {
        listeners.set(type, handler);
      },
    };

    new Function("self", "caches", "fetch", "Response", "Headers", "URL", sw)(
      swGlobal,
      swGlobal.caches,
      swGlobal.fetch,
      Response,
      Headers,
      URL,
    );

    const installPromises: Promise<unknown>[] = [];
    listeners.get("install")!({ waitUntil: (p: Promise<unknown>) => installPromises.push(p) });
    await Promise.all(installPromises);

    const precachedPaths = mockFetch.mock.calls.map((call) => String(call[0]));
    expect(precachedPaths).toContain("/");
    expect(precachedPaths).not.toContain("/index.html");
    expect(cacheEntries.has("omb-pwa-shell-v3")).toBe(true);

    const activatePromises: Promise<unknown>[] = [];
    listeners.get("activate")!({ waitUntil: (p: Promise<unknown>) => activatePromises.push(p) });
    await Promise.all(activatePromises);
    expect(cacheEntries.has("omb-pwa-shell-v1")).toBe(false);

    // Poison cache entry with a redirected Response to verify navigation strips `.redirected`.
    const poisoned = new Response("<html>poisoned</html>", { status: 200 });
    Object.defineProperty(poisoned, "redirected", { value: true });
    cacheEntries.get("omb-pwa-shell-v3")!.set("/", poisoned);

    let navResponsePromise!: Promise<Response>;
    const bgPromises: Promise<unknown>[] = [];
    listeners.get("fetch")!({
      request: { method: "GET", mode: "navigate", url: "https://mausbot.mxhan.com/" },
      respondWith: (p: Promise<Response>) => { navResponsePromise = p; },
      waitUntil: (p: Promise<unknown>) => { bgPromises.push(p); },
    });
    const navResponse = await navResponsePromise;
    expect(navResponse.redirected).toBe(false);
    expect(await navResponse.text()).toBe("<html>poisoned</html>");
    await Promise.all(bgPromises);

    // SPA HTML fallback for a stale /assets/*.js request must return 404, not be cached, and clear cached "/".
    let staleAssetPromise!: Promise<Response>;
    listeners.get("fetch")!({
      request: { method: "GET", mode: "cors", url: "https://mausbot.mxhan.com/assets/App-stale.js" },
      respondWith: (p: Promise<Response>) => { staleAssetPromise = p; },
      waitUntil: () => {},
    });
    const staleAsset = await staleAssetPromise;
    expect(staleAsset.status).toBe(404);
    expect(cacheEntries.get("omb-pwa-shell-v3")!.has("/assets/App-stale.js")).toBe(false);
    expect(cacheEntries.get("omb-pwa-shell-v3")!.has("/")).toBe(false);

    // Cold cache redirected navigation (e.g. /legacy/) must also resolve with redirected === false.
    cacheEntries.get("omb-pwa-shell-v3")!.delete("/");
    let coldNavPromise!: Promise<Response>;
    listeners.get("fetch")!({
      request: { method: "GET", mode: "navigate", url: "https://mausbot.mxhan.com/legacy/" },
      respondWith: (p: Promise<Response>) => { coldNavPromise = p; },
      waitUntil: () => {},
    });
    const coldNav = await coldNavPromise;
    expect(coldNav.redirected).toBe(false);
    expect(await coldNav.text()).toBe("<html>/legacy/</html>");
  });
});
