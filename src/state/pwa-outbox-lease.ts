import { randomUuid } from "@/lib/random-uuid";
import { OMB_PWA_OUTBOX_LEASES_STORE, OMB_PWA_OUTBOX_STORE } from "@/lib/pwa-config";
import {
  OUTBOX_LEASE_CHANNEL,
  OUTBOX_LEASE_TTL_MS,
  StaleOutboxLeaseError,
  makeOutboxLeaseKey,
  makeOutboxLockName,
  requestPromise,
  transactionDone,
  type OutboxLeaseHandle,
  type OutboxLeaseRecord,
  type OutboxRuntimeDeps,
} from "./pwa-outbox-types";

export function createOutboxLeaseCoordinator(options: {
  tabLeaseOwner: string;
  now: () => number;
  openDb: () => Promise<IDBDatabase | null>;
  getDeps: () => OutboxRuntimeDeps;
}) {
  const inTabMutexes = new Map<string, Promise<void>>();

  const openBroadcastChannel = (): BroadcastChannel | null => {
    const deps = options.getDeps();
    if (deps.createBroadcastChannel !== undefined) {
      return deps.createBroadcastChannel(OUTBOX_LEASE_CHANNEL);
    }
    if (typeof BroadcastChannel !== "undefined") {
      try {
        return new BroadcastChannel(OUTBOX_LEASE_CHANNEL);
      } catch {
        return null;
      }
    }
    return null;
  };

  const getLocksApi = () => {
    const deps = options.getDeps();
    if (deps.locks !== undefined) return deps.locks;
    if (typeof navigator !== "undefined" && navigator.locks && typeof navigator.locks.request === "function") {
      return navigator.locks;
    }
    return null;
  };

  const claimIdbLease = async (
    ownerKey: string,
    threadId: string,
    allowTakeover: boolean,
  ): Promise<OutboxLeaseHandle | null> => {
    const db = await options.openDb().catch(() => null);
    if (!db) return null;
    const leaseKey = makeOutboxLeaseKey(ownerKey, threadId);
    const leaseToken = randomUuid();
    try {
      let acquired = false;
      const tx = db.transaction(OMB_PWA_OUTBOX_LEASES_STORE, "readwrite");
      const store = tx.objectStore(OMB_PWA_OUTBOX_LEASES_STORE);
      const existing = (await requestPromise(store.get(leaseKey))) as OutboxLeaseRecord | undefined;
      const ts = options.now();
      if (
        allowTakeover ||
        !existing ||
        existing.leaseExpiresAt <= ts ||
        existing.leaseOwner === options.tabLeaseOwner
      ) {
        const next: OutboxLeaseRecord = {
          leaseOwner: options.tabLeaseOwner,
          leaseToken,
          leaseExpiresAt: ts + OUTBOX_LEASE_TTL_MS,
        };
        store.put(next, leaseKey);
        acquired = true;
      }
      await transactionDone(tx);
      if (!acquired) return null;
      return { ownerKey, threadId, leaseKey, leaseOwner: options.tabLeaseOwner, leaseToken };
    } finally {
      db.close();
    }
  };

  const releaseIdbLease = async (handle: OutboxLeaseHandle): Promise<void> => {
    const db = await options.openDb().catch(() => null);
    if (!db) return;
    try {
      const tx = db.transaction(OMB_PWA_OUTBOX_LEASES_STORE, "readwrite");
      const store = tx.objectStore(OMB_PWA_OUTBOX_LEASES_STORE);
      const existing = (await requestPromise(store.get(handle.leaseKey))) as OutboxLeaseRecord | undefined;
      if (existing && existing.leaseOwner === handle.leaseOwner && existing.leaseToken === handle.leaseToken) {
        store.delete(handle.leaseKey);
      }
      await transactionDone(tx);
    } catch {
    } finally {
      db.close();
    }
    const channel = openBroadcastChannel();
    if (channel) {
      try {
        channel.postMessage({ type: "released", leaseKey: handle.leaseKey });
        channel.close();
      } catch {
      }
    }
  };

  const waitForFallbackLease = async (ownerKey: string, threadId: string): Promise<OutboxLeaseHandle | null> => {
    const leaseKey = makeOutboxLeaseKey(ownerKey, threadId);
    const channel = openBroadcastChannel();
    try {
      for (;;) {
        const handle = await claimIdbLease(ownerKey, threadId, false);
        if (handle) return handle;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (channel) channel.onmessage = null;
            resolve();
          };
          const timer = setTimeout(finish, 120);
          if (channel) {
            channel.onmessage = (ev: MessageEvent<{ type?: string; leaseKey?: string }>) => {
              if (ev.data?.type === "released" && ev.data?.leaseKey === leaseKey) finish();
            };
          }
        });
      }
    } finally {
      try {
        channel?.close();
      } catch {
      }
    }
  };

  const withThreadLease = async <T>(
    ownerKey: string,
    threadId: string,
    fn: (lease: OutboxLeaseHandle | null) => Promise<T>,
  ): Promise<T> => {
    const leaseKey = makeOutboxLeaseKey(ownerKey, threadId);
    const previous = inTabMutexes.get(leaseKey) ?? Promise.resolve();
    let releaseMutex!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    const tail = previous.then(() => current, () => current);
    inTabMutexes.set(leaseKey, tail);
    await previous.catch(() => {});

    const runWithCrossTabLock = async (): Promise<T> => {
      const locks = getLocksApi();
      if (locks) {
        return locks.request(makeOutboxLockName(ownerKey, threadId), { mode: "exclusive" }, async () => {
          const handle = await claimIdbLease(ownerKey, threadId, true);
          try {
            return await fn(handle);
          } finally {
            if (handle) await releaseIdbLease(handle);
          }
        }) as Promise<T>;
      }
      const handle = await waitForFallbackLease(ownerKey, threadId);
      try {
        return await fn(handle);
      } finally {
        if (handle) await releaseIdbLease(handle);
      }
    };

    try {
      return await runWithCrossTabLock();
    } finally {
      releaseMutex();
      if (inTabMutexes.get(leaseKey) === tail) {
        inTabMutexes.delete(leaseKey);
      }
    }
  };

  const mutateWithFencedLease = async <T>(
    lease: OutboxLeaseHandle,
    mutator: (outboxStore: IDBObjectStore, ts: number) => Promise<T> | T,
  ): Promise<T> => {
    const db = await options.openDb();
    if (!db) throw new Error("IndexedDB unavailable");
    try {
      const tx = db.transaction([OMB_PWA_OUTBOX_STORE, OMB_PWA_OUTBOX_LEASES_STORE], "readwrite");
      const leases = tx.objectStore(OMB_PWA_OUTBOX_LEASES_STORE);
      const outbox = tx.objectStore(OMB_PWA_OUTBOX_STORE);
      const currentLease = (await requestPromise(leases.get(lease.leaseKey))) as OutboxLeaseRecord | undefined;
      const ts = options.now();
      if (
        !currentLease ||
        currentLease.leaseOwner !== lease.leaseOwner ||
        currentLease.leaseToken !== lease.leaseToken ||
        currentLease.leaseExpiresAt <= ts
      ) {
        try {
          tx.abort();
        } catch {
        }
        throw new StaleOutboxLeaseError(lease.leaseKey);
      }
      leases.put(
        {
          leaseOwner: lease.leaseOwner,
          leaseToken: lease.leaseToken,
          leaseExpiresAt: ts + OUTBOX_LEASE_TTL_MS,
        } satisfies OutboxLeaseRecord,
        lease.leaseKey,
      );
      const result = await mutator(outbox, ts);
      await transactionDone(tx);
      return result;
    } finally {
      db.close();
    }
  };

  const clearInTabMutexes = () => {
    inTabMutexes.clear();
  };

  return {
    claimIdbLease,
    releaseIdbLease,
    withThreadLease,
    mutateWithFencedLease,
    clearInTabMutexes,
  };
}
