import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import {
  OMB_PWA_OUTBOX_LEASES_STORE,
  OMB_PWA_OUTBOX_STORE,
  OMB_PWA_OUTBOX_THREAD_INDEX,
  makePwaOwnerKey,
} from "@/lib/pwa-config";
import {
  OUTBOX_AUTO_RETRY_DELAYS_MS,
  StaleOutboxLeaseError,
  classifyOutboxError,
  createOutboxManager,
  jitteredAutoRetryDelayMs,
  outboxRecordToOptimisticMessage,
  type OutboxLeaseRecord,
  type OutboxRecord,
} from "./pwa-outbox";

function createFakeIdb() {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string | undefined>();
  const ensureStore = (name: string) => {
    let map = stores.get(name);
    if (!map) {
      map = new Map();
      stores.set(name, map);
    }
    return map;
  };

  const factory = {
    open(_name: string) {
      const openReq: {
        result?: IDBDatabase;
        error: DOMException | null;
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
        onsuccess: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
      } = {
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };

      const db = {
        objectStoreNames: {
          contains: (name: string) => stores.has(name),
        },
        createObjectStore: (name: string, opts?: { keyPath?: string }) => {
          ensureStore(name);
          keyPaths.set(name, opts?.keyPath);
          return {
            createIndex: () => ({}),
          } as unknown as IDBObjectStore;
        },
        close: () => {},
        transaction: (_storeNames: string | string[], _mode?: IDBTransactionMode) => {
          let aborted = false;
          let completed = false;
          let pendingOps = 0;
          let commitScheduled = false;
          const maybeCommit = () => {
            if (commitScheduled || aborted || completed || pendingOps > 0) return;
            commitScheduled = true;
            // Real IndexedDB auto-commits only after the entire microtask checkpoint drains.
            Promise.resolve()
              .then(() => Promise.resolve())
              .then(() => Promise.resolve())
              .then(() => Promise.resolve())
              .then(() => {
                commitScheduled = false;
                if (!aborted && !completed && pendingOps === 0) {
                  completed = true;
                  tx.oncomplete?.(new Event("complete"));
                }
              });
          };
          const tx: {
            oncomplete: ((ev: Event) => void) | null;
            onerror: ((ev: Event) => void) | null;
            onabort: ((ev: Event) => void) | null;
            abort: () => void;
            objectStore: (name: string) => IDBObjectStore;
          } = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            abort: () => {
              aborted = true;
              queueMicrotask(() => tx.onabort?.(new Event("abort")));
            },
            objectStore: (name: string) => {
              const store = ensureStore(name);
              const kp = keyPaths.get(name);
              const schedule = <T>(fn: () => T) => {
                pendingOps += 1;
                const req: {
                  result?: T;
                  error: DOMException | null;
                  onsuccess: ((ev: Event) => void) | null;
                  onerror: ((ev: Event) => void) | null;
                } = { error: null, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  if (!aborted) {
                    req.result = fn();
                    req.onsuccess?.(new Event("success"));
                  }
                  pendingOps -= 1;
                  maybeCommit();
                });
                return req as unknown as IDBRequest<T>;
              };
              maybeCommit();
              return {
                indexNames: { contains: (idx: string) => idx === OMB_PWA_OUTBOX_THREAD_INDEX },
                index: () => ({
                  getAll: (range?: IDBKeyRange) =>
                    schedule(() => {
                      const values = [...store.values()] as Array<Record<string, unknown>>;
                      const filtered =
                        range && Array.isArray(range.lower)
                          ? values.filter(
                              (v) => v.ownerKey === range.lower[0] && v.threadId === range.lower[1],
                            )
                          : values;
                      return filtered.map((v) => structuredClone(v));
                    }),
                }),
                get: (key: string) => schedule(() => (store.has(key) ? structuredClone(store.get(key)) : undefined)),
                getAll: () => schedule(() => [...store.values()].map((v) => structuredClone(v))),
                put: (value: Record<string, unknown>, explicitKey?: string) =>
                  schedule(() => {
                    const k = explicitKey ?? (kp ? String(value[kp]) : "");
                    store.set(k, structuredClone(value));
                    return k;
                  }),
                delete: (key: string) =>
                  schedule(() => {
                    store.delete(key);
                    return undefined;
                  }),
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

  return {
    factory,
    readRawStore: (name: string) => ensureStore(name),
  };
}

describe("pwa-outbox", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("classifies 401 as auth, 429/5xx/retryable-409 as retryable, and terminal 4xx as terminal", () => {
    expect(classifyOutboxError(new ApiError("Unauthorized", 401))).toMatchObject({ kind: "auth" });
    expect(classifyOutboxError(new ApiError("Rate limited", 429, undefined, 4_500))).toMatchObject({
      kind: "retryable",
      retryAfterMs: 4_500,
    });
    expect(classifyOutboxError(new ApiError("Settling", 409, { code: "settling" }))).toMatchObject({
      kind: "retryable",
      code: "settling",
    });
    expect(classifyOutboxError(new ApiError("Thread busy", 409, { code: "thread_busy" }))).toMatchObject({
      kind: "retryable",
      code: "thread_busy",
    });
    expect(classifyOutboxError(new ApiError("Deleted", 409, { code: "thread_deleted" }))).toMatchObject({
      kind: "terminal",
      code: "thread_deleted",
    });
    expect(classifyOutboxError(new ApiError("Bad request", 400, { code: "invalid" }))).toMatchObject({
      kind: "terminal",
      code: "invalid",
    });
    expect(classifyOutboxError(new Error("timeout"))).toMatchObject({ kind: "retryable" });
  });

  it("applies +/-15% jitter around 1s/3s/8s while honoring Retry-After floors", () => {
    expect(jitteredAutoRetryDelayMs(0, undefined, () => 0)).toBe(Math.round(OUTBOX_AUTO_RETRY_DELAYS_MS[0] * 0.85));
    expect(jitteredAutoRetryDelayMs(1, undefined, () => 1)).toBe(Math.round(OUTBOX_AUTO_RETRY_DELAYS_MS[1] * 1.15));
    expect(jitteredAutoRetryDelayMs(0, 7_000, () => 0.5)).toBe(7_000);
  });

  it("enqueues with monotonic per-thread seq and drains strictly FIFO within a thread while allowing concurrent threads", async () => {
    const idb = createFakeIdb();
    const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-1");
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const mgr = createOutboxManager({
      idbFactory: idb.factory,
      locks: null,
      createBroadcastChannel: () => null,
      getOwnerKey: () => ownerKey,
      isOnline: () => true,
      apiRequest: (async (_path, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        order.push(`start:${body.sendId}`);
        if (body.sendId === "s1") await firstBlocked;
        order.push(`done:${body.sendId}`);
        return { threadId: body.threadId, message: { id: `srv-${body.sendId}`, sendId: body.sendId, role: "user", kind: "text", text: body.text, at: 1 } };
      }) as NonNullable<Parameters<typeof createOutboxManager>[0]>["apiRequest"],
    });

    const r1 = await mgr.enqueue({ ownerKey, sendId: "s1", threadId: "t1", targetKind: "bot", targetId: "b1", text: "first" });
    const r2 = await mgr.enqueue({ ownerKey, sendId: "s2", threadId: "t1", targetKind: "bot", targetId: "b1", text: "second" });
    const r3 = await mgr.enqueue({ ownerKey, sendId: "s3", threadId: "t2", targetKind: "bot", targetId: "b2", text: "other-thread" });
    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 1]);

    const drainT1 = mgr.drainThread(ownerKey, "t1");
    const drainT2 = mgr.drainThread(ownerKey, "t2");
    await drainT2;
    expect(order).toContain("done:s3");
    expect(order).not.toContain("start:s2");

    releaseFirst();
    await drainT1;
    expect(order.indexOf("done:s1")).toBeLessThan(order.indexOf("start:s2"));
    expect(idb.readRawStore(OMB_PWA_OUTBOX_STORE).size).toBe(0);
  });

  it("aborts fenced mutation with StaleOutboxLeaseError when another tab has taken over the lease", async () => {
    const idb = createFakeIdb();
    const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-1");
    let clock = 1_000;
    const mgr = createOutboxManager({
      idbFactory: idb.factory,
      now: () => clock,
      leaseOwner: "tab-a",
      locks: null,
      createBroadcastChannel: () => null,
      getOwnerKey: () => ownerKey,
    });

    const lease = await mgr.claimIdbLease(ownerKey, "t1", true);
    expect(lease).not.toBeNull();
    // Simulate tab-b taking over the lease in IDB while tab-a was suspended.
    idb.readRawStore(OMB_PWA_OUTBOX_LEASES_STORE).set(lease!.leaseKey, {
      leaseOwner: "tab-b",
      leaseToken: "foreign-token",
      leaseExpiresAt: clock + 15_000,
    } satisfies OutboxLeaseRecord);

    await expect(
      mgr.mutateWithFencedLease(lease!, (store) => {
        store.put({ sendId: "should-not-write" });
      }),
    ).rejects.toBeInstanceOf(StaleOutboxLeaseError);
    expect(idb.readRawStore(OMB_PWA_OUTBOX_STORE).size).toBe(0);
  });

  it("auto-retries up to 3 times on 5xx, pauses on 401, and rejects terminal 409 without auto-retrying", async () => {
    vi.useFakeTimers();
    const idb = createFakeIdb();
    const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-1");
    let mode: "503" | "401" | "409-terminal" = "503";
    let attempts = 0;

    const mgr = createOutboxManager({
      idbFactory: idb.factory,
      random: () => 0.5,
      locks: null,
      createBroadcastChannel: () => null,
      getOwnerKey: () => ownerKey,
      isOnline: () => true,
      apiRequest: async () => {
        attempts += 1;
        if (mode === "503") throw new ApiError("Unavailable", 503);
        if (mode === "401") throw new ApiError("Unauthorized", 401);
        throw new ApiError("Thread deleted", 409, { code: "thread_deleted" });
      },
    });

    await mgr.enqueue({ ownerKey, sendId: "s-retry", threadId: "t1", targetKind: "bot", targetId: "b1", text: "hello" });
    await mgr.drainThread(ownerKey, "t1");
    expect(mgr.getRecord("s-retry")?.status).toBe("failed");

    // 3 auto-retries (1s, 3s, 8s)
    for (const delay of OUTBOX_AUTO_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay + 10);
    }
    expect(attempts).toBe(4);
    expect(mgr.getRecord("s-retry")?.status).toBe("failed");

    // 401 pauses drain until explicit retry/reload
    mode = "401";
    await mgr.retrySend("s-retry");
    expect(mgr.isAuthPaused()).toBe(true);
    expect(mgr.getRecord("s-retry")?.status).toBe("failed");

    // Terminal 409 moves item to rejected and frees the next item in FIFO order
    mode = "409-terminal";
    await mgr.retrySend("s-retry");
    expect(mgr.getRecord("s-retry")?.status).toBe("rejected");
  });

  it("overlays persisted outbox rows without liveSendNonce and cleans up arrived rows or imports prior-session rows", async () => {
    const idb = createFakeIdb();
    const oldOwner = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-old");
    const newOwner = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-new");
    const dispatch = vi.fn();

    const mgr = createOutboxManager({
      idbFactory: idb.factory,
      locks: null,
      createBroadcastChannel: () => null,
      getOwnerKey: () => newOwner,
      isOnline: () => false,
      dispatch,
    });

    await mgr.enqueue({ ownerKey: oldOwner, sendId: "s-prior", threadId: "t1", targetKind: "bot", targetId: "b1", text: "from old session" });
    await mgr.reloadFromDb(newOwner);
    expect(mgr.getSummary().priorSessionCount).toBe(1);

    const imported = await mgr.importPriorSession(newOwner);
    expect(imported).toBe(1);
    expect(mgr.getSummary().priorSessionCount).toBe(0);
    expect(mgr.getRecord("s-prior")?.ownerKey).toBe(newOwner);

    const optimistic = outboxRecordToOptimisticMessage(mgr.getRecord("s-prior") as OutboxRecord);
    expect(optimistic.outboxRestored).toBe(true);
    expect(optimistic.liveSendNonce).toBeUndefined();

    const state = {
      bots: [{ id: "b1", threadId: "t1", name: "Bot", title: "", description: "", color: "blue", notifications: false, unread: false, modelSelection: { instanceId: "i1", model: "m" }, messages: [] }],
      groups: [],
    } as unknown as Parameters<typeof mgr.overlayOnState>[0];
    const overlaid = mgr.overlayOnState(state);
    expect(overlaid.bots[0]!.messages.map((m) => m.id)).toEqual(["optimistic-s-prior"]);
  });
});
