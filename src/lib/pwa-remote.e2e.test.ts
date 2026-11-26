import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { startBridge, type BridgeServer } from "../../pwa-relay/src/bridge.ts";
import { loadConfig as loadRelayConfig } from "../../pwa-relay/src/config.ts";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-omb.ts";
import { api } from "@/state/api";
import { attachmentImageUrl, imageAttachmentFromFile } from "./composer-attachments";
import { openLiveEvents, type LiveEventSourceLike } from "./live-events";
import {
  OMB_PWA_AUTH_STORE,
  bootstrapPwaConfig,
  clearPwaAuth,
  getPwaAuth,
  isRemotePwaMode,
  remoteFetch,
  resetPwaConfigForTests,
  resolveRemoteMediaUrl,
} from "./pwa-config";
import { readSessionState } from "./session";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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
    open() {
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

class MemoryEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(ev: Event) {
    for (const listener of this.listeners.get(ev.type) ?? []) listener();
    return true;
  }
}

function createFetchEventSource(
  url: string,
  activeConnections: Set<{ drop: () => void; url: string }>,
): LiveEventSourceLike {
  const controller = new AbortController();
  const adapter: LiveEventSourceLike = {
    onopen: null,
    onerror: null,
    onmessage: null,
    close: () => {
      activeConnections.delete(entry);
      controller.abort();
    },
  };
  const entry = {
    url,
    drop: () => {
      activeConnections.delete(entry);
      controller.abort();
      adapter.onerror?.();
    },
  };
  activeConnections.add(entry);

  void (async () => {
    try {
      const res = await fetch(url, {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        activeConnections.delete(entry);
        adapter.onerror?.();
        return;
      }
      adapter.onopen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const splitAt = buffer.indexOf("\n\n");
          if (splitAt === -1) break;
          const rawEvent = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          let id = "";
          const dataLines: string[] = [];
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length > 0) {
            adapter.onmessage?.({ data: dataLines.join("\n"), ...(id ? { lastEventId: id } : {}) });
          }
        }
      }
      if (!controller.signal.aborted) {
        activeConnections.delete(entry);
        adapter.onerror?.();
      }
    } catch {
      if (!controller.signal.aborted) {
        activeConnections.delete(entry);
        adapter.onerror?.();
      }
    }
  })();

  return adapter;
}

describe("PWA remote transport E2E through local pwa-relay and Mac server fixture", () => {
  let fixture: VerificationServer | undefined;
  let relay: BridgeServer | undefined;
  let macBase = "";
  let relayBase = "";

  beforeAll(async () => {
    fixture = await launchVerificationServer({ ...process.env, OMB_DEV_TRUST_LOCAL_BROWSER: "1" });
    macBase = fixture.info.url;

    const rotRes = await fetch(`${macBase}/api/pwa-bridge/rotate-secret`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(rotRes.status).toBe(200);
    const { bridgeSecret } = (await rotRes.json()) as { bridgeSecret: string };

    relay = await startBridge(
      loadRelayConfig({
        BRIDGE_PORT: "0",
        BRIDGE_HOST: "127.0.0.1",
        PINNED_HOST_ID: "mac-mini",
        HOST_TOKEN_HASHES: createHash("sha256").update(bridgeSecret, "utf8").digest("hex"),
        PWA_ORIGIN: "http://127.0.0.1:4173",
      }),
      { log: () => {} },
    );
    relayBase = `http://127.0.0.1:${relay.port}`;

    const putRes = await fetch(`${macBase}/api/pwa-bridge`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        relayUrl: relayBase,
        hostId: "mac-mini",
        pwaOrigin: "http://127.0.0.1:4173",
      }),
    });
    expect(putRes.status).toBe(200);

    const deadline = Date.now() + 10_000;
    while (!relay.hostConnected()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for Mac server bridge to connect to pwa-relay");
      await new Promise((r) => setTimeout(r, 25));
    }
  }, 60_000);

  afterEach(async () => {
    await clearPwaAuth().catch(() => undefined);
    resetPwaConfigForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await relay?.close();
    await fixture?.close();
  });

  it("pairs via #pair=, validates session, runs REST/POST/media blobs, reconnects SSE with fresh tickets, and halts on logout", async () => {
    const createBotRes = await fetch(`${macBase}/api/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Accounting Bot" }),
    });
    expect(createBotRes.status).toBe(201);
    const createdBot = (await createBotRes.json()) as { bot: { id: string } };
    const botId = createdBot.bot.id;

    const inviteRes = await fetch(`${macBase}/api/pwa-bridge/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "iPhone PWA", defaultBotId: botId }),
    });
    expect(inviteRes.status).toBe(200);
    const { inviteUrl } = (await inviteRes.json()) as { inviteUrl: string };
    const hash = `#${inviteUrl.split("#")[1]}`;

    const idb = createMemoryIdb();
    const replaceState = vi.fn();
    const blobBytes = new Map<string, Uint8Array>();
    let blobSeq = 0;

    const windowTarget = new MemoryEventTarget();
    const documentTarget = new MemoryEventTarget();
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);
    vi.stubGlobal("history", { replaceState });
    vi.stubGlobal("location", {
      origin: "http://127.0.0.1:4173",
      hostname: "127.0.0.1",
      pathname: "/pair",
      search: "",
      hash,
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) => {
      const key = `blob:http://127.0.0.1:4173/${++blobSeq}`;
      if (obj instanceof Blob) {
        void obj.arrayBuffer().then((buf) => blobBytes.set(key, new Uint8Array(buf)));
      }
      return key;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
      blobBytes.delete(url);
    });

    // 1. Pair from #pair= -> /api/pair -> /api/auth/session -> /.well-known/openmausbot/environment.
    const boot = await bootstrapPwaConfig({
      idb,
      deviceName: "Test iPhone",
      allowLoopbackHttp: true,
    });
    expect(boot).toEqual({ status: "paired", auth: expect.any(Object) });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/pair");
    expect(isRemotePwaMode()).toBe(true);
    expect(getPwaAuth()).toMatchObject({
      relayUrl: relayBase,
      defaultBotId: botId,
      scopes: ["client"],
      dpopBound: true,
    });

    // 2. readSessionState() and api.listBots() work over the relay using Bearer + DPoP auth,
    // while a stolen Bearer token without a valid DPoP proof is rejected.
    const stolenBearerRes = await fetch(`${relayBase}/api/bots`, {
      headers: { authorization: `Bearer ${getPwaAuth()!.token}` },
    });
    expect(stolenBearerRes.status).toBe(401);

    const session = await readSessionState();
    expect(session).toMatchObject({ kind: "session", scopes: ["client"] });

    const botsRes = await api<{ bots: Array<{ id: string }> }>("/api/bots");
    expect(botsRes.bots.some((b) => b.id === botId)).toBe(true);

    // 3. Upload an image attachment and fetch it back as an authenticated blob: URL.
    const pngFile = new File([ONE_PIXEL_PNG], "receipt.png", { type: "image/png" });
    const uploaded = await imageAttachmentFromFile(pngFile);
    expect(uploaded).not.toBeNull();
    const mediaPath = attachmentImageUrl(uploaded!.path)!;
    const blobUrl = await resolveRemoteMediaUrl(mediaPath);
    expect(blobUrl.startsWith("blob:http://127.0.0.1:4173/")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(Buffer.from(blobBytes.get(blobUrl) ?? [])).toEqual(ONE_PIXEL_PNG);

    // 4. Open SSE through openLiveEvents() with single-use stream tickets, receive hello + message, drop, and reconnect.
    const activeConnections = new Set<{ drop: () => void; url: string }>();
    const openedUrls: string[] = [];
    const seenFrames: Array<{ kind: string }> = [];
    let snapshotCalls = 0;
    let unauthCalls = 0;

    const stop = openLiveEvents(
      {
        onFrame: (frame) => seenFrames.push(frame),
        onSnapshotRequired: async () => {
          snapshotCalls += 1;
          return true;
        },
        onUnauthenticated: () => {
          unauthCalls += 1;
        },
        retryMinMs: 25,
        retryMaxMs: 50,
      },
      {
        createEventSource: (url) => {
          openedUrls.push(url);
          return createFetchEventSource(url, activeConnections);
        },
        windowTarget,
        documentTarget,
        isVisible: () => true,
        isOnline: () => true,
      },
    );

    try {
      const waitFor = async (predicate: () => boolean, label: string) => {
        const deadline = Date.now() + 8_000;
        while (!predicate()) {
          if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      };

      await waitFor(() => snapshotCalls >= 1, "initial SSE hello/snapshot");
      expect(openedUrls).toHaveLength(1);
      expect(openedUrls[0]).toContain(`${relayBase}/api/events?`);
      expect(openedUrls[0]).toContain("ticket=");

      // Send a message over POST /api/bots/:id/messages and observe it arriving over SSE.
      const sendRes = await remoteFetch(`/api/bots/${botId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "Coffee $4.50", sendId: randomUUID() }),
      });
      expect(sendRes.status).toBe(202);
      await waitFor(() => seenFrames.some((f) => f.kind === "message"), "live message frame");

      // Simulate dropped SSE connection; openLiveEvents must acquire a fresh ticket and reconnect with since=.
      const firstConn = [...activeConnections][0];
      expect(firstConn).toBeDefined();
      firstConn!.drop();

      await waitFor(() => openedUrls.length >= 2, "SSE reconnect with second ticket");
      expect(openedUrls[1]).toContain("since=");
      expect(openedUrls[1]).toContain("ticket=");
      const ticket1 = new URL(openedUrls[0]!).searchParams.get("ticket");
      const ticket2 = new URL(openedUrls[1]!).searchParams.get("ticket");
      expect(ticket1).toBeTruthy();
      expect(ticket2).toBeTruthy();
      expect(ticket2).not.toBe(ticket1);

      // Logout revokes the session; next stream failure probes /api/auth/session and calls onUnauthenticated.
      const logoutRes = await remoteFetch("/api/auth/logout", { method: "POST" });
      expect(logoutRes.status).toBe(200);

      const secondConn = [...activeConnections][0];
      secondConn?.drop();
      await waitFor(() => unauthCalls === 1, "onUnauthenticated after logout");
    } finally {
      stop();
      await clearPwaAuth(idb);
    }
  }, 30_000);
});
