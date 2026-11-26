import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OMB_PWA_AUTH_ACTIVE_KEY,
  OMB_PWA_AUTH_STORE,
  OMB_PWA_DB_NAME,
  activatePwaPairing,
  bootstrapPwaConfig,
  clearPwaAuth,
  downloadRemoteUrl,
  getPwaAuth,
  initPwaAuth,
  isRemotePwaMode,
  openPwaDb,
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
                clear: () => {
                  const req = makeRequest(() => {
                    store.clear();
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
    const mediaFetch = vi.fn(
      async () =>
        new Response(new Blob(["img"], { type: "image/png" }), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
    ) as unknown as typeof fetch;
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

  it("rejects openPwaDb cleanly when blocked instead of hanging", async () => {
    const blockedIdb = {
      open() {
        const openReq: {
          onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
          onsuccess: ((ev: Event) => void) | null;
          onerror: ((ev: Event) => void) | null;
          onblocked: ((ev: Event) => void) | null;
        } = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
        queueMicrotask(() => {
          openReq.onblocked?.(new Event("blocked"));
        });
        return openReq as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;

    await expect(openPwaDb(blockedIdb, { timeoutMs: 2000, blockedMs: 20 })).rejects.toThrow("IndexedDB open blocked");
  });

  it("keeps pairing working in-memory when IndexedDB storage is unavailable or rejects writes", async () => {
    const throwingIdb = {
      open() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    } as unknown as IDBFactory;
    const credential = `omb_pair_${"e".repeat(43)}`;
    const encoded = encodeBase64Url({
      relayUrl: "https://relay.mxhan.com",
      credential,
    });
    vi.stubGlobal("location", {
      origin: "https://mausbot.mxhan.com",
      pathname: "/",
      search: "",
      hash: `#pair=${encoded}`,
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/pair")) {
        return new Response(JSON.stringify({ token: "tok-mem-1", device: { id: "dev-m1" }, serverName: "Mac" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({ kind: "session", id: "sess-m1", environmentId: "env-m1", scopes: ["client"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ environmentId: "env-m1", label: "Mac" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const boot = await bootstrapPwaConfig({ idb: throwingIdb, fetchImpl: fetchMock });
    expect(boot.status).toBe("paired");
    expect(getPwaAuth()?.token).toBe("tok-mem-1");
    expect(isRemotePwaMode()).toBe(true);
  });

  it("persists and restores PWA auth via localStorage backup when IndexedDB is unavailable across restart", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    vi.stubGlobal("indexedDB", {
      open() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
    const credential = `omb_pair_${"f".repeat(43)}`;
    const encoded = encodeBase64Url({
      relayUrl: "https://relay.mxhan.com",
      credential,
    });
    vi.stubGlobal("location", {
      origin: "https://mausbot.mxhan.com",
      pathname: "/",
      search: "",
      hash: `#pair=${encoded}`,
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/pair")) {
        return new Response(JSON.stringify({ token: "tok-ls-1", device: { id: "dev-ls1" }, serverName: "Mac" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({ kind: "session", id: "sess-ls1", environmentId: "env-ls1", scopes: ["client"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ environmentId: "env-ls1", label: "Mac" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const boot1 = await bootstrapPwaConfig({ fetchImpl: fetchMock });
    expect(boot1.status).toBe("paired");
    expect(store.has("omb.pwa.auth.v1")).toBe(true);

    // Simulate full browser restart: reset in-memory state and clear #pair= from location.
    resetPwaConfigForTests();
    vi.stubGlobal("location", {
      origin: "https://mausbot.mxhan.com",
      pathname: "/",
      search: "",
      hash: "",
    });
    const boot2 = await bootstrapPwaConfig({ fetchImpl: fetchMock });
    expect(boot2.status).toBe("existing");
    expect(getPwaAuth()?.token).toBe("tok-ls-1");
    expect(isRemotePwaMode()).toBe(true);

    await clearPwaAuth();
    expect(store.has("omb.pwa.auth.v1")).toBe(false);
  });

  it("rejects stored auth records with disallowed relayUrl in localStorage backup", async () => {
    const store = new Map<string, string>([
      [
        "omb.pwa.auth.v1",
        JSON.stringify({
          ownerKey: "https://evil.example.test::env-1::ses-1",
          relayUrl: "https://evil.example.test",
          token: "tok-bad",
          deviceId: "d1",
          environmentId: "env-1",
          sessionId: "ses-1",
          serverName: "Evil",
          scopes: ["client"],
          pairedAt: 1700000000000,
        }),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    vi.stubGlobal("indexedDB", {
      open() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
    expect(await initPwaAuth()).toBeNull();
    expect(isRemotePwaMode()).toBe(false);
  });

  it("returns status: 'confirm' instead of overwriting an existing session when #pair= is present", async () => {
    const idb = createMemoryIdb();
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    const fetchMockFn = vi.fn(async (url: string) => {
      if (url.endsWith("/api/pair")) {
        return new Response(JSON.stringify({ token: "tok-existing", device: { id: "dev-1" }, serverName: "Existing Mac" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({ kind: "session", id: "ses-existing", environmentId: "env-1", scopes: ["client"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ environmentId: "env-1", label: "Existing Mac" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const fetchMock = fetchMockFn as unknown as typeof fetch;

    const first = await activatePwaPairing(
      { relayUrl: "https://relay.mxhan.com", credential: `omb_pair_${"a".repeat(43)}` },
      { idb, fetchImpl: fetchMock },
    );
    expect(first.ok).toBe(true);
    fetchMockFn.mockClear();

    resetPwaConfigForTests();
    const nextCred = `omb_pair_${"b".repeat(43)}`;
    vi.stubGlobal("history", { replaceState: vi.fn() });
    vi.stubGlobal("location", {
      origin: "https://mausbot.mxhan.com",
      hostname: "mausbot.mxhan.com",
      pathname: "/",
      search: "",
      hash: `#pair=${encodeBase64Url({ relayUrl: "https://relay.mxhan.com", credential: nextCred })}`,
    });

    const boot = await bootstrapPwaConfig({ idb, fetchImpl: fetchMock });
    expect(boot.status).toBe("confirm");
    if (boot.status === "confirm") {
      expect(boot.existing.token).toBe("tok-existing");
      expect(boot.payload.credential).toBe(nextCred);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPwaAuth()?.token).toBe("tok-existing");
  });

  it("rejects non-media MIME types in resolveRemoteMediaUrl and forces application/octet-stream in downloadRemoteUrl", async () => {
    const idb = createMemoryIdb();
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/pair")) {
        return new Response(JSON.stringify({ token: "tok-media", device: { id: "d1" }, serverName: "Mac" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({ kind: "session", id: "s1", environmentId: "e1", scopes: ["client"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ environmentId: "e1", label: "Mac" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await activatePwaPairing({ relayUrl: "https://relay.mxhan.com", credential: `omb_pair_${"m".repeat(43)}` }, { idb, fetchImpl: fetchMock });

    const createdBlobs: Blob[] = [];
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn((blob: Blob) => {
        createdBlobs.push(blob);
        return `blob:https://mausbot.mxhan.com/${createdBlobs.length}`;
      }),
      revokeObjectURL: vi.fn(),
    });

    for (const badType of ["image/svg+xml", "text/html", "application/javascript", ""]) {
      const badFetch = vi.fn(async () =>
        new Response(new Blob(["<svg/>"]), {
          status: 200,
          ...(badType ? { headers: { "content-type": badType } } : {}),
        }),
      ) as unknown as typeof fetch;
      await expect(resolveRemoteMediaUrl(`/api/attachments/bad-${badType || "none"}`, badFetch)).rejects.toThrow();
    }

    for (const goodType of ["image/png", "audio/mpeg", "video/mp4"]) {
      const goodFetch = vi.fn(async () =>
        new Response(new Blob(["ok"], { type: goodType }), {
          status: 200,
          headers: { "content-type": goodType },
        }),
      ) as unknown as typeof fetch;
      const url = await resolveRemoteMediaUrl(`/api/attachments/good-${goodType.replace("/", "-")}`, goodFetch);
      expect(url.startsWith("blob:")).toBe(true);
    }

    const link = { href: "", download: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => link),
      body: { append: vi.fn() },
    });
    const htmlDownloadFetch = vi.fn(async () =>
      new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }),
    ) as unknown as typeof fetch;
    await downloadRemoteUrl("/api/threads/t1/messages/m1/file", "report.html", htmlDownloadFetch);
    expect(createdBlobs.at(-1)?.type).toBe("application/octet-stream");
    expect(link.click).toHaveBeenCalledTimes(1);
  });

  it("generates a valid v4 pairRequestId when crypto.randomUUID is unavailable", async () => {
    const idb = createMemoryIdb();
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    let sentPairRequestId: string | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/pair")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { pairRequestId?: string };
        sentPairRequestId = body.pairRequestId;
        return new Response(JSON.stringify({ token: "tok-http-1", device: { id: "dev-http-1" }, serverName: "Mac" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({ kind: "session", id: "sess-http-1", environmentId: "env-http-1", scopes: ["client"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ environmentId: "env-http-1", label: "Mac" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await activatePwaPairing(
      { relayUrl: "https://relay.mxhan.com", credential: `omb_pair_${"u".repeat(43)}` },
      { idb, fetchImpl: fetchMock },
    );
    expect(result.ok).toBe(true);
    expect(sentPairRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("omits localStorage backup when IndexedDB succeeds, deletes stale backup on IDB read, and purges all stores on clearPwaAuth", async () => {
    const lsStore = new Map<string, string>([
      [
        "omb.pwa.auth.v1",
        JSON.stringify({
          ownerKey: "https://relay.mxhan.com::env-stale::ses-stale",
          relayUrl: "https://relay.mxhan.com",
          token: "tok-stale",
          deviceId: "dev-stale",
          environmentId: "env-stale",
          sessionId: "ses-stale",
          serverName: "Mac",
          scopes: ["client"],
          pairedAt: 1700000000000,
        }),
      ],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => lsStore.get(k) ?? null,
      setItem: (k: string, v: string) => { lsStore.set(k, v); },
      removeItem: (k: string) => { lsStore.delete(k); },
    });

    const idb = createMemoryIdb();
    vi.stubGlobal("indexedDB", idb);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/pair")) {
        return new Response(JSON.stringify({ token: "tok-idb-only", device: { id: "dev-1" }, serverName: "Mac" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({ kind: "session", id: "ses-1", environmentId: "env-1", scopes: ["client"] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ environmentId: "env-1", label: "Mac" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const paired = await activatePwaPairing(
      { relayUrl: "https://relay.mxhan.com", credential: `omb_pair_${"z".repeat(43)}` },
      { fetchImpl: fetchMock },
    );
    expect(paired.ok).toBe(true);
    expect(lsStore.has("omb.pwa.auth.v1")).toBe(false);

    // Populate offline cache stores before clearing auth.
    const {
      OMB_PWA_OUTBOX_LEASES_STORE,
      OMB_PWA_OUTBOX_STORE,
      OMB_PWA_PREFS_STORE,
      OMB_PWA_SNAPSHOT_STORE,
    } = await import("./pwa-config");
    const { setBootPwaCache, peekBootPwaCache, setActivePwaPrefs, getActivePwaPrefs } = await import("./pwa-cache");
    const db = (await openPwaDb())!;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(
        [OMB_PWA_SNAPSHOT_STORE, OMB_PWA_OUTBOX_STORE, OMB_PWA_OUTBOX_LEASES_STORE, OMB_PWA_PREFS_STORE],
        "readwrite",
      );
      tx.objectStore(OMB_PWA_SNAPSHOT_STORE).put({ ownerKey: "k", savedAt: 1, bots: [], groups: [], sections: [], config: null }, "k");
      tx.objectStore(OMB_PWA_OUTBOX_STORE).put({ sendId: "s1", ownerKey: "k" }, "s1");
      tx.objectStore(OMB_PWA_OUTBOX_LEASES_STORE).put({ leasedUntil: 999 }, "k");
      tx.objectStore(OMB_PWA_PREFS_STORE).put({ ownerKey: "k", openPinnedOnLaunch: true, updatedAt: 1 }, "k");
      tx.oncomplete = () => resolve();
    });
    db.close();
    setBootPwaCache({ ownerKey: "k", snapshot: { ownerKey: "k", savedAt: 1, bots: [], groups: [], sections: [], config: null }, prefs: null, queryBotId: null });
    setActivePwaPrefs({ ownerKey: "k", openPinnedOnLaunch: true, updatedAt: 1 });

    // Reading valid IDB auth also deletes any lingering localStorage backup.
    lsStore.set("omb.pwa.auth.v1", "{\"stale\":true}");
    resetPwaConfigForTests();
    const restored = await initPwaAuth();
    expect(restored?.token).toBe("tok-idb-only");
    expect(lsStore.has("omb.pwa.auth.v1")).toBe(false);

    await clearPwaAuth();
    expect(peekBootPwaCache()).toBeNull();
    expect(getActivePwaPrefs()).toBeNull();

    const dbAfter = (await openPwaDb())!;
    const checkEmpty = async (storeName: string, key: string) =>
      await new Promise<unknown>((resolve) => {
        const tx = dbAfter.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
      });
    expect(await checkEmpty(OMB_PWA_AUTH_STORE, OMB_PWA_AUTH_ACTIVE_KEY)).toBeUndefined();
    expect(await checkEmpty(OMB_PWA_SNAPSHOT_STORE, "k")).toBeUndefined();
    expect(await checkEmpty(OMB_PWA_OUTBOX_STORE, "s1")).toBeUndefined();
    expect(await checkEmpty(OMB_PWA_OUTBOX_LEASES_STORE, "k")).toBeUndefined();
    expect(await checkEmpty(OMB_PWA_PREFS_STORE, "k")).toBeUndefined();
    dbAfter.close();
  });
});
