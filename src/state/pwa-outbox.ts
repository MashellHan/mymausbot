import { useSyncExternalStore } from "react";
import { t } from "@/lib/i18n";
import { randomUuid } from "@/lib/random-uuid";
import {
  OMB_PWA_OUTBOX_STORE,
  getPwaAuth,
  isRemotePwaMode,
  openPwaDb,
} from "@/lib/pwa-config";
import { api } from "./api";
import { optimisticMessageId, sendArrived } from "./optimistic-send";
import type { Action, AppState, Bot, Group } from "./store";
import { createOutboxLeaseCoordinator } from "./pwa-outbox-lease";
import {
  OUTBOX_MAX_AUTO_ATTEMPTS,
  OUTBOX_TEXT_POST_TIMEOUT_MS,
  StaleOutboxLeaseError,
  classifyOutboxError,
  jitteredAutoRetryDelayMs,
  makeOutboxLeaseKey,
  outboxRecordToOptimisticMessage,
  readAllOutboxFromStore,
  readThreadOutboxFromStore,
  requestPromise,
  transactionDone,
  type EnqueueOutboxInput,
  type OutboxLeaseHandle,
  type OutboxRecord,
  type OutboxRuntimeDeps,
  type OutboxStatus,
  type OutboxSummary,
} from "./pwa-outbox-types";

export * from "./pwa-outbox-types";

export function createOutboxManager(initialDeps: OutboxRuntimeDeps = {}) {
  let deps: OutboxRuntimeDeps = { ...initialDeps };
  const tabLeaseOwner = initialDeps.leaseOwner ?? randomUuid();
  const autoAttempts = new Map<string, number>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingWaitReady = new Map<string, () => Promise<void>>();
  const activeRecords = new Map<string, OutboxRecord>();
  const priorRecords = new Map<string, OutboxRecord>();
  const listeners = new Set<() => void>();
  let authPaused = false;
  let activeOwnerKeyCache: string | null = null;
  let summaryCache: OutboxSummary = {
    failedCount: 0,
    queuedCount: 0,
    sendingCount: 0,
    rejectedCount: 0,
    priorSessionCount: 0,
  };

  const now = () => (deps.now ?? Date.now)();
  const random = () => (deps.random ?? Math.random)();
  const isOnline = () => (deps.isOnline ? deps.isOnline() : typeof navigator === "undefined" || navigator.onLine !== false);
  const currentOwnerKey = () => (deps.getOwnerKey ? deps.getOwnerKey() : getPwaAuth()?.ownerKey ?? null);
  const dispatchStore = (action: Action) => {
    deps.dispatch?.(action);
  };

  const recomputeSummary = () => {
    let failedCount = 0;
    let queuedCount = 0;
    let sendingCount = 0;
    let rejectedCount = 0;
    for (const record of activeRecords.values()) {
      if (record.status === "failed") failedCount += 1;
      else if (record.status === "queued") queuedCount += 1;
      else if (record.status === "sending" || record.status === "resending") sendingCount += 1;
      else if (record.status === "rejected") rejectedCount += 1;
    }
    const priorSessionCount = priorRecords.size;
    if (
      summaryCache.failedCount !== failedCount ||
      summaryCache.queuedCount !== queuedCount ||
      summaryCache.sendingCount !== sendingCount ||
      summaryCache.rejectedCount !== rejectedCount ||
      summaryCache.priorSessionCount !== priorSessionCount
    ) {
      summaryCache = { failedCount, queuedCount, sendingCount, rejectedCount, priorSessionCount };
    }
  };

  const notify = () => {
    recomputeSummary();
    for (const listener of listeners) listener();
  };

  const setMirrorFromRows = (ownerKey: string | null, allRows: OutboxRecord[]) => {
    if (activeOwnerKeyCache && ownerKey && activeOwnerKeyCache !== ownerKey) {
      authPaused = false;
    }
    activeOwnerKeyCache = ownerKey;
    activeRecords.clear();
    priorRecords.clear();
    for (const row of allRows) {
      if (ownerKey && row.ownerKey === ownerKey) {
        activeRecords.set(row.sendId, row);
      } else if (ownerKey && row.ownerKey !== ownerKey) {
        priorRecords.set(row.sendId, row);
      }
    }
    notify();
  };

  const syncRecordToMirror = (record: OutboxRecord) => {
    const ownerKey = currentOwnerKey() ?? activeOwnerKeyCache;
    if (ownerKey && record.ownerKey === ownerKey) {
      activeRecords.set(record.sendId, record);
      priorRecords.delete(record.sendId);
    } else if (ownerKey && record.ownerKey !== ownerKey) {
      priorRecords.set(record.sendId, record);
      activeRecords.delete(record.sendId);
    } else {
      activeRecords.set(record.sendId, record);
    }
    notify();
  };

  const deleteFromMirror = (sendId: string) => {
    const removedActive = activeRecords.delete(sendId);
    const removedPrior = priorRecords.delete(sendId);
    if (removedActive || removedPrior) notify();
  };

  const openDb = () => openPwaDb(deps.idbFactory);
  const {
    claimIdbLease,
    releaseIdbLease,
    withThreadLease,
    mutateWithFencedLease,
    clearInTabMutexes,
  } = createOutboxLeaseCoordinator({
    tabLeaseOwner,
    now,
    openDb,
    getDeps: () => deps,
  });

  const readThreadRecords = async (ownerKey: string, threadId: string): Promise<OutboxRecord[]> => {
    const db = await openDb().catch(() => null);
    if (!db) {
      return [...activeRecords.values()]
        .filter((r) => r.ownerKey === ownerKey && r.threadId === threadId)
        .sort((a, b) => a.seq - b.seq);
    }
    try {
      const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readonly");
      const rows = await readThreadOutboxFromStore(tx.objectStore(OMB_PWA_OUTBOX_STORE), ownerKey, threadId);
      await transactionDone(tx);
      return rows;
    } finally {
      db.close();
    }
  };

  const clearThreadRetryTimer = (ownerKey: string, threadId: string) => {
    const key = makeOutboxLeaseKey(ownerKey, threadId);
    const existing = retryTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      retryTimers.delete(key);
    }
  };

  const scheduleThreadRetry = (ownerKey: string, threadId: string, delayMs: number) => {
    const key = makeOutboxLeaseKey(ownerKey, threadId);
    clearThreadRetryTimer(ownerKey, threadId);
    const timer = setTimeout(() => {
      retryTimers.delete(key);
      if (authPaused || !isOnline()) return;
      void drainThread(ownerKey, threadId, { retryFailed: true });
    }, Math.max(0, delayMs));
    retryTimers.set(key, timer);
  };

  const recordArrived = (record: OutboxRecord): boolean => {
    if (deps.hasSendArrived) return deps.hasSendArrived(record);
    const state = deps.getState?.();
    if (!state) return false;
    const panel = state.forkPanel;
    if (
      panel &&
      panel.kind === record.targetKind &&
      panel.ownerId === record.targetId &&
      panel.threadId === record.threadId &&
      sendArrived(panel.messages, record.sendId)
    ) {
      return true;
    }
    const messages =
      record.targetKind === "bot"
        ? state.bots.find((b) => b.id === record.targetId && b.threadId === record.threadId)?.messages
        : state.groups.find((g) => g.id === record.targetId && g.threadId === record.threadId)?.messages;
    return sendArrived(messages, record.sendId);
  };

  const deleteRecordFencedOrDirect = async (
    lease: OutboxLeaseHandle | null,
    sendId: string,
  ): Promise<void> => {
    if (lease) {
      await mutateWithFencedLease(lease, (store) => {
        store.delete(sendId);
      });
    } else {
      const db = await openDb().catch(() => null);
      if (db) {
        try {
          const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
          tx.objectStore(OMB_PWA_OUTBOX_STORE).delete(sendId);
          await transactionDone(tx);
        } finally {
          db.close();
        }
      }
    }
    deleteFromMirror(sendId);
  };

  const updateRecordFencedOrDirect = async (
    lease: OutboxLeaseHandle | null,
    next: OutboxRecord,
  ): Promise<void> => {
    if (lease) {
      await mutateWithFencedLease(lease, (store) => {
        store.put(next);
      });
    } else {
      const db = await openDb().catch(() => null);
      if (db) {
        try {
          const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
          tx.objectStore(OMB_PWA_OUTBOX_STORE).put(next);
          await transactionDone(tx);
        } finally {
          db.close();
        }
      }
    }
    syncRecordToMirror(next);
  };

  const sendOutboxHttp = async (record: OutboxRecord) => {
    const request = deps.apiRequest ?? api;
    if (record.targetKind === "bot") {
      return request(`/api/bots/${record.targetId}/messages`, {
        method: "POST",
        timeoutMs: OUTBOX_TEXT_POST_TIMEOUT_MS,
        body: JSON.stringify({
          text: record.text,
          replyToId: record.replyToId,
          threadId: record.threadId,
          sendId: record.sendId,
          ...(record.dataContext ? { dataContext: record.dataContext } : {}),
          ...(record.pointed?.length ? { pointed: record.pointed } : {}),
          ...(record.openPage ? { openPage: record.openPage } : {}),
          ...(record.mode === "goal" ? { mode: "goal" } : {}),
          ...(record.followUp ? { followUp: record.followUp } : {}),
          ...(record.mentions?.length ? { mentions: record.mentions } : {}),
        }),
      });
    }
    return request(`/api/groups/${record.targetId}/messages`, {
      method: "POST",
      timeoutMs: OUTBOX_TEXT_POST_TIMEOUT_MS,
      body: JSON.stringify({
        text: record.text,
        replyToId: record.replyToId,
        threadId: record.threadId,
        sendId: record.sendId,
        mode: record.mode ?? "chat",
        ...(record.mentions?.length ? { mentions: record.mentions } : {}),
        ...(record.pointed?.length ? { pointed: record.pointed } : {}),
      }),
    });
  };

  const reconcileAcceptedBody = (record: OutboxRecord, body: any) => {
    if (body?.message && typeof body.threadId === "string") {
      dispatchStore({ type: "messageAdded", threadId: body.threadId, message: body.message });
      dispatchStore({ type: "forkPanelMessage", threadId: body.threadId, message: body.message });
      return true;
    }
    if (body?.queued && typeof body.threadId === "string" && typeof body.queueId === "string") {
      dispatchStore({ type: "optimisticMessageRemoved", threadId: body.threadId, sendId: record.sendId });
      dispatchStore({
        type: "pendingQueued",
        threadId: body.threadId,
        queueId: body.queueId,
        text: record.text,
        ...(record.targetKind === "bot" && (body.reason === "capacity" || body.reason === "group-turn")
          ? { reason: body.reason }
          : {}),
        ...(record.targetKind === "group"
          ? {
              pointedChips: record.pointedChips,
              pointed: record.pointed,
              mentions: record.mentions,
              replyToId: record.replyToId,
              channelMode: record.mode,
            }
          : {}),
      });
      return true;
    }
    return false;
  };

  const drainThread = async (
    ownerKey: string,
    threadId: string,
    options: { retryFailed?: boolean } = {},
  ): Promise<void> => {
    if (!ownerKey || !threadId || authPaused) return;
    if (currentOwnerKey() && currentOwnerKey() !== ownerKey) return;
    const leaseKey = makeOutboxLeaseKey(ownerKey, threadId);

    try {
      await withThreadLease(ownerKey, threadId, async (lease) => {
        for (;;) {
          if (authPaused) return;
          if (currentOwnerKey() && currentOwnerKey() !== ownerKey) return;
          const items = await readThreadRecords(ownerKey, threadId);
          const head = items.find((item) => item.status !== "rejected");
          if (!head) {
            clearThreadRetryTimer(ownerKey, threadId);
            autoAttempts.delete(leaseKey);
            return;
          }

          if (recordArrived(head)) {
            await deleteRecordFencedOrDirect(lease, head.sendId);
            autoAttempts.delete(leaseKey);
            continue;
          }

          if (head.status === "failed" && !options.retryFailed) {
            return;
          }

          const ts = now();
          if (
            head.status === "failed" &&
            options.retryFailed &&
            head.nextRetryAt !== undefined &&
            head.nextRetryAt > ts &&
            !autoAttempts.has(leaseKey)
          ) {
            // Respect an active 429 Retry-After cooldown across visibility/reconnect bursts.
            scheduleThreadRetry(ownerKey, threadId, head.nextRetryAt - ts);
            return;
          }

          const isRecoveryOrRetry =
            head.status === "sending" || head.status === "resending" || head.status === "failed";
          const nextStatus: OutboxStatus = isRecoveryOrRetry ? "resending" : "sending";
          const inFlightRecord: OutboxRecord = {
            ...head,
            status: nextStatus,
            updatedAt: ts,
          };
          await updateRecordFencedOrDirect(lease, inFlightRecord);

          if (!isOnline()) {
            const failedOffline: OutboxRecord = {
              ...inFlightRecord,
              status: "failed",
              updatedAt: now(),
              lastError: t("liveConnection.offline"),
              lastErrorCode: "offline",
            };
            await updateRecordFencedOrDirect(lease, failedOffline);
            return;
          }

          try {
            const waitReady = pendingWaitReady.get(inFlightRecord.sendId);
            if (waitReady) {
              pendingWaitReady.delete(inFlightRecord.sendId);
              await waitReady();
            } else if (deps.waitExecutionSettings) {
              await deps.waitExecutionSettings(inFlightRecord);
            }
            const body = await sendOutboxHttp(inFlightRecord);
            reconcileAcceptedBody(inFlightRecord, body);
            await deleteRecordFencedOrDirect(lease, inFlightRecord.sendId);
            autoAttempts.delete(leaseKey);
            clearThreadRetryTimer(ownerKey, threadId);
            // Subsequent items in the same thread become eligible to drain immediately.
            options = { ...options, retryFailed: true };
          } catch (error) {
            if (error instanceof StaleOutboxLeaseError) return;
            if (recordArrived(inFlightRecord)) {
              await deleteRecordFencedOrDirect(lease, inFlightRecord.sendId);
              autoAttempts.delete(leaseKey);
              continue;
            }
            const classified = classifyOutboxError(error);
            if (classified.kind === "auth") {
              authPaused = true;
              clearThreadRetryTimer(ownerKey, threadId);
              await updateRecordFencedOrDirect(lease, {
                ...inFlightRecord,
                status: "failed",
                updatedAt: now(),
                lastError: classified.message,
                lastErrorCode: classified.code ?? "unauthorized",
              });
              return;
            }
            if (classified.kind === "terminal") {
              await updateRecordFencedOrDirect(lease, {
                ...inFlightRecord,
                status: "rejected",
                updatedAt: now(),
                attemptCount: inFlightRecord.attemptCount + 1,
                lastError: classified.message,
                ...(classified.code ? { lastErrorCode: classified.code } : {}),
              });
              continue;
            }
            const usedAuto = autoAttempts.get(leaseKey) ?? 0;
            const canAuto = isOnline() && usedAuto < OUTBOX_MAX_AUTO_ATTEMPTS;
            const delayMs = canAuto
              ? jitteredAutoRetryDelayMs(usedAuto, classified.retryAfterMs, random)
              : classified.retryAfterMs;
            const failedRecord: OutboxRecord = {
              ...inFlightRecord,
              status: "failed",
              updatedAt: now(),
              attemptCount: inFlightRecord.attemptCount + 1,
              lastError: classified.message,
              ...(classified.code ? { lastErrorCode: classified.code } : {}),
              ...(delayMs !== undefined ? { nextRetryAt: now() + delayMs } : {}),
            };
            await updateRecordFencedOrDirect(lease, failedRecord);
            if (canAuto && delayMs !== undefined) {
              autoAttempts.set(leaseKey, usedAuto + 1);
              scheduleThreadRetry(ownerKey, threadId, delayMs);
            }
            return;
          }
        }
      });
    } catch (error) {
      if (error instanceof StaleOutboxLeaseError) return;
    }
  };

  const enqueue = async (input: EnqueueOutboxInput): Promise<OutboxRecord> => {
    const db = await openDb().catch(() => null);
    const ts = now();
    let record: OutboxRecord = {
      sendId: input.sendId,
      ownerKey: input.ownerKey,
      threadId: input.threadId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      seq: 1,
      text: input.text,
      ...(input.replyToId !== undefined ? { replyToId: input.replyToId } : {}),
      ...(input.dataContext !== undefined ? { dataContext: input.dataContext } : {}),
      ...(input.pointed?.length ? { pointed: input.pointed } : {}),
      ...(input.pointedChips?.length ? { pointedChips: input.pointedChips } : {}),
      ...(input.openPage !== undefined ? { openPage: input.openPage } : {}),
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.followUp !== undefined ? { followUp: input.followUp } : {}),
      ...(input.mentions?.length ? { mentions: input.mentions } : {}),
      status: "queued",
      createdAt: ts,
      updatedAt: ts,
      attemptCount: 0,
    };

    if (db) {
      try {
        const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
        const store = tx.objectStore(OMB_PWA_OUTBOX_STORE);
        const existing = (await requestPromise(store.get(input.sendId))) as OutboxRecord | undefined;
        if (existing) {
          await transactionDone(tx);
          syncRecordToMirror(existing);
          return existing;
        }
        const threadRows = await readThreadOutboxFromStore(store, input.ownerKey, input.threadId);
        const maxSeq = threadRows.reduce((max, row) => Math.max(max, row.seq), 0);
        record = { ...record, seq: maxSeq + 1 };
        store.put(record);
        await transactionDone(tx);
      } finally {
        db.close();
      }
    } else {
      const maxSeq = [...activeRecords.values()]
        .filter((row) => row.ownerKey === input.ownerKey && row.threadId === input.threadId)
        .reduce((max, row) => Math.max(max, row.seq), 0);
      record = { ...record, seq: maxSeq + 1 };
    }
    syncRecordToMirror(record);
    return record;
  };

  const enqueueAndDrain = async (
    input: EnqueueOutboxInput,
    waitReady?: () => Promise<void>,
  ): Promise<OutboxRecord> => {
    if (waitReady) pendingWaitReady.set(input.sendId, waitReady);
    const record = await enqueue(input);
    void drainThread(record.ownerKey, record.threadId);
    return record;
  };

  const reloadFromDb = async (ownerKey: string | null = currentOwnerKey()): Promise<OutboxRecord[]> => {
    const db = await openDb().catch(() => null);
    if (!db) {
      setMirrorFromRows(ownerKey, [...activeRecords.values(), ...priorRecords.values()]);
      return [...activeRecords.values()].sort((a, b) => a.seq - b.seq);
    }
    try {
      const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readonly");
      const all = await readAllOutboxFromStore(tx.objectStore(OMB_PWA_OUTBOX_STORE));
      await transactionDone(tx);
      setMirrorFromRows(ownerKey, all);
      return [...activeRecords.values()].sort((a, b) => a.seq - b.seq);
    } catch {
      return [];
    } finally {
      db.close();
    }
  };

  const retrySend = async (sendId: string): Promise<void> => {
    const ownerKey = currentOwnerKey();
    const record = activeRecords.get(sendId) ?? (await reloadFromDb(ownerKey)).find((r) => r.sendId === sendId);
    if (!record || record.status === "rejected") return;
    authPaused = false;
    const leaseKey = makeOutboxLeaseKey(record.ownerKey, record.threadId);
    autoAttempts.set(leaseKey, 0);
    clearThreadRetryTimer(record.ownerKey, record.threadId);
    // Clear nextRetryAt cooldown on explicit manual tap so retry fires immediately.
    if (record.nextRetryAt !== undefined) {
      const cleared: OutboxRecord = { ...record, nextRetryAt: undefined };
      const db = await openDb().catch(() => null);
      if (db) {
        try {
          const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
          tx.objectStore(OMB_PWA_OUTBOX_STORE).put(cleared);
          await transactionDone(tx);
        } finally {
          db.close();
        }
      }
      syncRecordToMirror(cleared);
    }
    await drainThread(record.ownerKey, record.threadId, { retryFailed: true });
  };

  const retryAll = async (): Promise<void> => {
    const ownerKey = currentOwnerKey();
    if (!ownerKey) return;
    authPaused = false;
    const rows = await reloadFromDb(ownerKey);
    const threadIds = [...new Set(rows.filter((r) => r.status !== "rejected").map((r) => r.threadId))];
    for (const threadId of threadIds) {
      const leaseKey = makeOutboxLeaseKey(ownerKey, threadId);
      autoAttempts.set(leaseKey, 0);
      clearThreadRetryTimer(ownerKey, threadId);
    }
    const db = await openDb().catch(() => null);
    if (db) {
      try {
        const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
        const store = tx.objectStore(OMB_PWA_OUTBOX_STORE);
        for (const row of rows) {
          if (row.ownerKey === ownerKey && row.nextRetryAt !== undefined) {
            const cleared = { ...row, nextRetryAt: undefined };
            store.put(cleared);
            syncRecordToMirror(cleared);
          }
        }
        await transactionDone(tx);
      } finally {
        db.close();
      }
    }
    await Promise.all(threadIds.map((threadId) => drainThread(ownerKey, threadId, { retryFailed: true })));
  };

  const discardSend = async (sendId: string): Promise<void> => {
    const record = activeRecords.get(sendId) ?? priorRecords.get(sendId);
    const db = await openDb().catch(() => null);
    if (db) {
      try {
        const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
        tx.objectStore(OMB_PWA_OUTBOX_STORE).delete(sendId);
        await transactionDone(tx);
      } finally {
        db.close();
      }
    }
    deleteFromMirror(sendId);
    pendingWaitReady.delete(sendId);
    if (record) {
      dispatchStore({ type: "optimisticMessageRemoved", threadId: record.threadId, sendId });
      // Discarding a blocked head frees subsequent queued items in the same thread.
      if (record.ownerKey === currentOwnerKey()) {
        void drainThread(record.ownerKey, record.threadId);
      }
    }
  };

  const noteArrived = async (sendId: string): Promise<void> => {
    const record = activeRecords.get(sendId);
    if (!record) return;
    const db = await openDb().catch(() => null);
    if (db) {
      try {
        const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
        tx.objectStore(OMB_PWA_OUTBOX_STORE).delete(sendId);
        await transactionDone(tx);
      } finally {
        db.close();
      }
    }
    deleteFromMirror(sendId);
  };

  const recoverStaleOffline = async (): Promise<void> => {
    const ownerKey = currentOwnerKey();
    if (!ownerKey || isOnline()) return;
    const threadIds = [
      ...new Set(
        [...activeRecords.values()]
          .filter((r) => r.ownerKey === ownerKey && (r.status === "sending" || r.status === "resending"))
          .map((r) => r.threadId),
      ),
    ];
    for (const threadId of threadIds) {
      await drainThread(ownerKey, threadId);
    }
  };

  const handleReconnect = async (): Promise<void> => {
    const ownerKey = currentOwnerKey();
    if (!ownerKey || authPaused || !isOnline()) return;
    const rows = await reloadFromDb(ownerKey);
    const threadIds = [...new Set(rows.filter((r) => r.status !== "rejected").map((r) => r.threadId))];
    for (const threadId of threadIds) {
      const leaseKey = makeOutboxLeaseKey(ownerKey, threadId);
      const head = rows.filter((r) => r.threadId === threadId && r.status !== "rejected").sort((a, b) => a.seq - b.seq)[0];
      if (!head) continue;
      if (head.nextRetryAt !== undefined && head.nextRetryAt > now()) {
        scheduleThreadRetry(ownerKey, threadId, head.nextRetryAt - now());
        continue;
      }
      autoAttempts.set(leaseKey, 0);
      clearThreadRetryTimer(ownerKey, threadId);
      void drainThread(ownerKey, threadId, { retryFailed: true });
    }
  };

  const importPriorSession = async (targetOwnerKey: string | null = currentOwnerKey()): Promise<number> => {
    if (!targetOwnerKey) return 0;
    const db = await openDb().catch(() => null);
    if (!db) return 0;
    let importedCount = 0;
    const touchedThreads = new Set<string>();
    try {
      const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
      const store = tx.objectStore(OMB_PWA_OUTBOX_STORE);
      const all = await readAllOutboxFromStore(store);
      const maxSeqByThread = new Map<string, number>();
      for (const row of all) {
        if (row.ownerKey === targetOwnerKey) {
          maxSeqByThread.set(row.threadId, Math.max(maxSeqByThread.get(row.threadId) ?? 0, row.seq));
        }
      }
      const prior = all.filter((row) => row.ownerKey !== targetOwnerKey).sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
      const ts = now();
      for (const row of prior) {
        const nextSeq = (maxSeqByThread.get(row.threadId) ?? 0) + 1;
        maxSeqByThread.set(row.threadId, nextSeq);
        const migrated: OutboxRecord = {
          ...row,
          ownerKey: targetOwnerKey,
          seq: nextSeq,
          status: "queued",
          attemptCount: 0,
          updatedAt: ts,
          lastError: undefined,
          lastErrorCode: undefined,
          nextRetryAt: undefined,
        };
        store.put(migrated);
        touchedThreads.add(migrated.threadId);
        importedCount += 1;
      }
      await transactionDone(tx);
    } finally {
      db.close();
    }
    await reloadFromDb(targetOwnerKey);
    if (importedCount > 0) {
      dispatchStore({ type: "pwaOutboxOverlay" });
      for (const threadId of touchedThreads) {
        void drainThread(targetOwnerKey, threadId);
      }
    }
    return importedCount;
  };

  const discardPriorSession = async (targetOwnerKey: string | null = currentOwnerKey()): Promise<number> => {
    if (!targetOwnerKey) return 0;
    const db = await openDb().catch(() => null);
    if (!db) return 0;
    let deletedCount = 0;
    try {
      const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readwrite");
      const store = tx.objectStore(OMB_PWA_OUTBOX_STORE);
      const all = await readAllOutboxFromStore(store);
      for (const row of all) {
        if (row.ownerKey !== targetOwnerKey) {
          store.delete(row.sendId);
          deletedCount += 1;
        }
      }
      await transactionDone(tx);
    } finally {
      db.close();
    }
    await reloadFromDb(targetOwnerKey);
    return deletedCount;
  };

  const overlayOnState = (state: AppState): AppState => {
    if (activeRecords.size === 0) return state;
    const ownerKey = currentOwnerKey() ?? activeOwnerKeyCache;
    const rows = [...activeRecords.values()]
      .filter((r) => !ownerKey || r.ownerKey === ownerKey)
      .sort((a, b) => a.seq - b.seq);
    if (!rows.length) return state;

    const arrivedSendIds: string[] = [];
    const byBot = new Map<string, OutboxRecord[]>();
    const byGroup = new Map<string, OutboxRecord[]>();
    for (const row of rows) {
      const map = row.targetKind === "bot" ? byBot : byGroup;
      const list = map.get(row.targetId) ?? [];
      list.push(row);
      map.set(row.targetId, list);
    }

    let botsChanged = false;
    const bots: Bot[] = state.bots.map((bot) => {
      const entries = byBot.get(bot.id);
      if (!entries?.length) return bot;
      let messages = bot.messages;
      let activeLeafId = bot.activeLeafId ?? null;
      let changed = false;
      for (const entry of entries) {
        if (entry.threadId !== bot.threadId) continue;
        if (sendArrived(messages, entry.sendId)) {
          arrivedSendIds.push(entry.sendId);
          continue;
        }
        const optId = optimisticMessageId(entry.sendId);
        if (messages.some((m) => m.sendId === entry.sendId || m.id === optId)) continue;
        const parentId = activeLeafId ?? messages.at(-1)?.id ?? null;
        const msg = outboxRecordToOptimisticMessage(entry, parentId);
        messages = [...messages, msg];
        if (activeLeafId) activeLeafId = msg.id;
        changed = true;
      }
      if (!changed) return bot;
      botsChanged = true;
      return { ...bot, messages, activeLeafId };
    });

    let groupsChanged = false;
    const groups: Group[] = state.groups.map((group) => {
      const entries = byGroup.get(group.id);
      if (!entries?.length) return group;
      let messages = group.messages;
      let changed = false;
      for (const entry of entries) {
        if (entry.threadId !== group.threadId) continue;
        if (sendArrived(messages, entry.sendId)) {
          arrivedSendIds.push(entry.sendId);
          continue;
        }
        const optId = optimisticMessageId(entry.sendId);
        if (messages.some((m) => m.sendId === entry.sendId || m.id === optId)) continue;
        messages = [...messages, outboxRecordToOptimisticMessage(entry, null)];
        changed = true;
      }
      if (!changed) return group;
      groupsChanged = true;
      return { ...group, messages };
    });

    if (arrivedSendIds.length > 0) {
      setTimeout(() => {
        for (const sendId of arrivedSendIds) void noteArrived(sendId);
      }, 0);
    }

    if (!botsChanged && !groupsChanged) return state;
    return { ...state, bots, groups };
  };

  const resetForTests = (nextDeps: OutboxRuntimeDeps = {}) => {
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    autoAttempts.clear();
    clearInTabMutexes();
    pendingWaitReady.clear();
    activeRecords.clear();
    priorRecords.clear();
    activeOwnerKeyCache = null;
    authPaused = false;
    deps = { ...nextDeps };
    notify();
  };

  return {
    tabLeaseOwner,
    setDeps: (next: Partial<OutboxRuntimeDeps>) => {
      deps = { ...deps, ...next };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRecord: (sendId: string | undefined): OutboxRecord | undefined =>
      sendId ? activeRecords.get(sendId) : undefined,
    getSummary: (): OutboxSummary => summaryCache,
    isAuthPaused: () => authPaused,
    setBootRecords: (ownerKey: string, records: OutboxRecord[]) => {
      setMirrorFromRows(ownerKey, records);
    },
    enqueue,
    enqueueAndDrain,
    drainThread,
    reloadFromDb,
    retrySend,
    retryAll,
    discardSend,
    noteArrived,
    recoverStaleOffline,
    handleReconnect,
    importPriorSession,
    discardPriorSession,
    overlayOnState,
    mutateWithFencedLease,
    claimIdbLease,
    releaseIdbLease,
    resetForTests,
  };
}

export const defaultOutboxManager = createOutboxManager();

export async function readOwnerOutboxRecords(ownerKey: string, idbFactory?: IDBFactory): Promise<OutboxRecord[]> {
  if (!ownerKey) return [];
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return [];
  try {
    const tx = db.transaction(OMB_PWA_OUTBOX_STORE, "readonly");
    const all = await readAllOutboxFromStore(tx.objectStore(OMB_PWA_OUTBOX_STORE));
    await transactionDone(tx);
    return all;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export function setBootPwaOutboxRecords(ownerKey: string, records: OutboxRecord[]): void {
  defaultOutboxManager.setBootRecords(ownerKey, records);
}

export function overlayPwaOutboxOnState(state: AppState): AppState {
  return defaultOutboxManager.overlayOnState(state);
}

export function noteOutboxSendArrived(_threadId: string, sendId: string): void {
  void defaultOutboxManager.noteArrived(sendId);
}

export function enqueuePwaBotSend(
  input: Omit<EnqueueOutboxInput, "ownerKey" | "targetKind">,
  waitReady?: () => Promise<void>,
): Promise<OutboxRecord> | null {
  const auth = getPwaAuth();
  if (!isRemotePwaMode() || !auth) return null;
  return defaultOutboxManager.enqueueAndDrain({ ...input, ownerKey: auth.ownerKey, targetKind: "bot" }, waitReady);
}

export function enqueuePwaGroupSend(
  input: Omit<EnqueueOutboxInput, "ownerKey" | "targetKind">,
  waitReady?: () => Promise<void>,
): Promise<OutboxRecord> | null {
  const auth = getPwaAuth();
  if (!isRemotePwaMode() || !auth) return null;
  return defaultOutboxManager.enqueueAndDrain({ ...input, ownerKey: auth.ownerKey, targetKind: "group" }, waitReady);
}

export function retryOutboxSend(sendId: string): Promise<void> {
  return defaultOutboxManager.retrySend(sendId);
}

export function retryAllOutboxSends(): Promise<void> {
  return defaultOutboxManager.retryAll();
}

export function discardOutboxSend(sendId: string): Promise<void> {
  return defaultOutboxManager.discardSend(sendId);
}

export function importPriorSessionOutbox(): Promise<number> {
  return defaultOutboxManager.importPriorSession();
}

export function discardPriorSessionOutbox(): Promise<number> {
  return defaultOutboxManager.discardPriorSession();
}

export function useOutboxRecord(sendId: string | undefined): OutboxRecord | undefined {
  return useSyncExternalStore(
    defaultOutboxManager.subscribe,
    () => defaultOutboxManager.getRecord(sendId),
    () => defaultOutboxManager.getRecord(sendId),
  );
}

export function useOutboxSummary(): OutboxSummary {
  return useSyncExternalStore(
    defaultOutboxManager.subscribe,
    defaultOutboxManager.getSummary,
    defaultOutboxManager.getSummary,
  );
}
