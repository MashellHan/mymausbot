import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OMB_PWA_AUTH_ACTIVE_KEY,
  OMB_PWA_AUTH_STORE,
  OMB_PWA_DB_NAME,
  activatePwaPairing,
  bootstrapPwaConfig,
  clearPwaAuth,
  getPwaAuth,
  initPwaAuth,
  isRemotePwaMode,
  parsePwaPairHash,
  remoteFetch,
  remoteFetchInit,
  remoteUrl,
  resetPwaConfigForTests,
  resolveRemoteMediaUrl,
  takePwaPairFromLocation,
  validateRelayUrl,
} from "./pwa-config";

function encodeBase64Url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createMemoryIdb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const ensureStore = (name: string) => {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return store;
  };
  const makeRequest = <T>(run: () => T): IDBRequest<T> => {
    const req: {
      result?: T;
      error?: DOMException | null;
      onsuccess: ((ev: Event) => void) | null;
      onerror: ((ev: Event) => void) | null;
    } = { onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess?.(new Event("success"));
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.(new Event("error"));
      }
    });
    return req as unknown as IDBRequest<T>;
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
        objectStoreNames: {
          contains: (name: string) => stores.has(name),
        },
        createObjectStore: (name: string) => {
          ensureStore(name);
          return {} as IDBObjectStore;
        },
        close: () => {},
        transaction: (storeName: string) => {
          const tx: {
            error?: DOMException | null;
            oncomplete: ((ev: Event) => void) | null;
            onerror: ((ev: Event) => void) | null;
            onabort: ((ev: Event) => void) | null;
            objectStore: (name: string) => IDBObjectStore;
          } = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: (name: string) => {
              const store = ensureStore(name || storeName);
              return {
                get: (key: string) => makeRequest(() => store.get(key)),
                put: (value: unknown, key: string) => {
                  const req = makeRequest(() => {
                    store.set(key, value);
                    return key;
                  });
                  queueMicrotask(() => tx.oncomplete?.(new Event("complete")));
                  return req;
                },
                delete: (key: string) => {
                  const req = makeRequest(() => {
                    store.delete(key);
                    return undefined;
                  });
                  queueMicrotask(() => tx.oncomplete?.(new Event("complete")));
                  return req;
                },
              } as unknown as IDBObjectStore;
            },
          };
          return tx as unknown as IDBTransaction;
        },
      } as unknown as IDBDatabase;

      queueMicrotask(() => {
        openReq.result = db;
        if (!stores.has(OMB_PWA_AUTH_STORE)) {
          openReq.onupgradeneeded?.(new Event("upgradeneeded") as IDBVersionChangeEvent);
        }
        openReq.onsuccess?.(new Event("success"));
      });
      return openReq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

afterEach(() => {
  resetPwaConfigForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pwa relay validation and #pair= parsing", () => {
  it("accepts only trusted relay origins and rejects paths, queries, or non-https relays", () => {
    expect(validateRelayUrl("https://relay.mxhan.com")).toEqual({ ok: true, origin: "https://relay.mxhan.com" });
    expect(validateRelayUrl("https://evil.example.test").ok).toBe(false);
    expect(validateRelayUrl("https://relay.mxhan.com/path").ok).toBe(false);
    expect(validateRelayUrl("https://relay.mxhan.com?x=1").ok).toBe(false);
    expect(validateRelayUrl("http://relay.mxhan.com").ok).toBe(false);
    expect(validateRelayUrl("http://127.0.0.1:4199", { allowLoopbackHttp: true })).toEqual({
      ok: true,
      origin: "http://127.0.0.1:4199",
    });
  });

  it("extracts #pair= payload and strips location.hash immediately", () => {
    const credential = `omb_pair_${"a".repeat(43)}`;
    const hash = `#pair=${encodeBase64Url({
      relayUrl: "https://relay.mxhan.com",
      credential,
      defaultBotId: "acct-bot",
    })}`;
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    vi.stubGlobal("location", {
      origin: "https://mausbot.mxhan.com",
      hostname: "mausbot.mxhan.com",
      pathname: "/pair",
      search: "?next=%2F",
      hash,
    });

    const parsed = takePwaPairFromLocation();
    expect(parsed).toEqual({
      ok: true,
      payload: {
        relayUrl: "https://relay.mxhan.com",
        credential,
        defaultBotId: "acct-bot",
      },
    });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair?next=%2F");
    expect(parsePwaPairHash("#pair=not_valid_base64").ok).toBe(false);
  });
});

describe("pwa pairing lifecycle, IndexedDB persistence, and authenticated fetch", () => {
  it("activates a #pair= payload, verifies environment identity, persists across reload, and clears on sign-out", async () => {
    const idb = createMemoryIdb();
    const credential = `omb_pair_${"c".repeat(43)}`;
    const hash = `#pair=${encodeBase64Url({
      relayUrl: "https://relay.mxhan.com",
      credential,
      defaultBotId: "accounting",
    })}`;
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    vi.stubGlobal("location", {
      origin: "https://mausbot.mxhan.com",
      hostname: "mausbot.mxhan.com",
      pathname: "/",
      search: "",
      hash,
    });

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "https://relay.mxhan.com/api/pair") {
        return new Response(
          JSON.stringify({
            token: "tok-pwa-1",
            device: { id: "dev-1", name: "Safari on iPhone" },
            serverName: "Home Mac mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://relay.mxhan.com/api/auth/session") {
        return new Response(
          JSON.stringify({
            kind: "session",
            id: "ses-1",
            environmentId: "env-mac-1",
            scopes: ["admin", "client"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://relay.mxhan.com/.well-known/openmausbot/environment") {
        return new Response(
          JSON.stringify({
            environmentId: "env-mac-1",
            label: "Home Mac mini",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://relay.mxhan.com/api/bots") {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const boot = await bootstrapPwaConfig({
      idb,
      fetchImpl: fetchMock,
      deviceName: "Test iPhone",
      now: () => 1700000000000,
    });
    expect(boot.status).toBe("paired");
    expect(isRemotePwaMode()).toBe(true);
    expect(getPwaAuth()).toEqual({
      ownerKey: "https://relay.mxhan.com::env-mac-1::ses-1",
      relayUrl: "https://relay.mxhan.com",
      token: "tok-pwa-1",
      deviceId: "dev-1",
      environmentId: "env-mac-1",
      sessionId: "ses-1",
      serverName: "Home Mac mini",
      scopes: ["admin", "client"],
      defaultBotId: "accounting",
      pairedAt: 1700000000000,
    });
    expect(OMB_PWA_DB_NAME).toBe("omb-pwa-v1");
    expect(OMB_PWA_AUTH_ACTIVE_KEY).toBe("active");

    await remoteFetch("/api/bots", undefined, fetchMock);
    await remoteFetch("https://third-party.example.test/asset.png", undefined, fetchMock);
    const botCall = calls.find((c) => c.url === "https://relay.mxhan.com/api/bots");
    const externalCall = calls.find((c) => c.url === "https://third-party.example.test/asset.png");
    expect(botCall?.init?.credentials).toBe("omit");
    expect(new Headers(botCall?.init?.headers).get("authorization")).toBe("Bearer tok-pwa-1");
    expect(new Headers(externalCall?.init?.headers).has("authorization")).toBe(false);
    expect(remoteUrl("/api/events?window=1")).toBe("https://relay.mxhan.com/api/events?window=1");
    expect(remoteFetchInit({ method: "POST" }).credentials).toBe("omit");

    // Simulate reload: clear in-memory cache and re-read from IndexedDB.
    resetPwaConfigForTests();
    expect(isRemotePwaMode()).toBe(false);
    const restored = await initPwaAuth(idb);
    expect(restored?.token).toBe("tok-pwa-1");
    expect(isRemotePwaMode()).toBe(true);

    // Media blob URL resolution deduplicates requests and revokes cached blob URLs on logout.
    const createObjectURL = vi.fn(() => "blob:https://mausbot.mxhan.com/1");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const mediaFetch = vi.fn(async () => new Response(new Blob(["img"]), { status: 200 })) as unknown as typeof fetch;
    const [u1, u2] = await Promise.all([
      resolveRemoteMediaUrl("/api/attachments/pic.png", mediaFetch),
      resolveRemoteMediaUrl("/api/attachments/pic.png", mediaFetch),
    ]);
    expect(u1).toBe("blob:https://mausbot.mxhan.com/1");
    expect(u2).toBe("blob:https://mausbot.mxhan.com/1");
    expect(mediaFetch).toHaveBeenCalledTimes(1);

    await clearPwaAuth(idb);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://mausbot.mxhan.com/1");
    expect(isRemotePwaMode()).toBe(false);
    expect(await initPwaAuth(idb)).toBeNull();
  });

  it("rejects pairing when session and environment descriptors disagree on environmentId", async () => {
    const idb = createMemoryIdb();
    const credential = `omb_pair_${"d".repeat(43)}`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/pair")) {
        return new Response(JSON.stringify({ token: "tok", device: { id: "d1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({ kind: "session", id: "s1", environmentId: "env-a", scopes: ["client"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ environmentId: "env-b", label: "Other" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await activatePwaPairing(
      { relayUrl: "https://relay.mxhan.com", credential },
      { idb, fetchImpl: fetchMock },
    );
    expect(res.ok).toBe(false);
    expect(isRemotePwaMode()).toBe(false);
  });
});
