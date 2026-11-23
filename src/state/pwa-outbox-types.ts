import type { FollowUp } from "../../shared/follow-up";
import type { PointedElement } from "../../shared/app-frame/point";
import type { DataContext } from "../../shared/data-context";
import type { OpenPage } from "@/lib/open-page";
import { OMB_PWA_OUTBOX_THREAD_INDEX } from "@/lib/pwa-config";
import { ApiError } from "./api";
import { optimisticMessageId } from "./optimistic-send";
import type { Action, AppState, Message } from "./store";

export const OUTBOX_TEXT_POST_TIMEOUT_MS = 5_000;
export const OUTBOX_LEASE_TTL_MS = 15_000;
export const OUTBOX_AUTO_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
export const OUTBOX_MAX_AUTO_ATTEMPTS = OUTBOX_AUTO_RETRY_DELAYS_MS.length;
export const OUTBOX_LEASE_CHANNEL = "omb-outbox-lease";
const RETRYABLE_409_CODES = new Set(["settling", "thread_busy", "guarded_busy"]);

export type OutboxStatus = "queued" | "sending" | "failed" | "resending" | "rejected";
export type OutboxTargetKind = "bot" | "group";
export type QueuedPointedChip = PointedElement & { id: string; title: string };

export interface OutboxRecord {
  sendId: string;
  ownerKey: string;
  threadId: string;
  targetKind: OutboxTargetKind;
  targetId: string;
  seq: number;
  text: string;
  replyToId?: string;
  dataContext?: DataContext;
  pointed?: PointedElement[];
  pointedChips?: QueuedPointedChip[];
  openPage?: OpenPage;
  mode?: "chat" | "goal";
  followUp?: FollowUp;
  mentions?: string[];
  status: OutboxStatus;
  createdAt: number;
  updatedAt: number;
  attemptCount: number;
  lastError?: string;
  lastErrorCode?: string;
  nextRetryAt?: number;
}

export interface OutboxLeaseRecord {
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: number;
}

export interface OutboxLeaseHandle {
  ownerKey: string;
  threadId: string;
  leaseKey: string;
  leaseOwner: string;
  leaseToken: string;
}

export interface OutboxSummary {
  failedCount: number;
  queuedCount: number;
  sendingCount: number;
  rejectedCount: number;
  priorSessionCount: number;
}

export type OutboxErrorClassification =
  | { kind: "retryable"; retryAfterMs?: number; code?: string; message: string }
  | { kind: "auth"; code?: string; message: string }
  | { kind: "terminal"; code?: string; message: string };

export interface EnqueueOutboxInput {
  ownerKey: string;
  sendId: string;
  threadId: string;
  targetKind: OutboxTargetKind;
  targetId: string;
  text: string;
  replyToId?: string;
  dataContext?: DataContext;
  pointed?: PointedElement[];
  pointedChips?: QueuedPointedChip[];
  openPage?: OpenPage;
  mode?: "chat" | "goal";
  followUp?: FollowUp;
  mentions?: string[];
}

export interface OutboxRuntimeDeps {
  idbFactory?: IDBFactory;
  now?: () => number;
  random?: () => number;
  leaseOwner?: string;
  locks?: { request: (name: string, options: { mode: "exclusive" }, callback: () => Promise<unknown>) => Promise<unknown> } | null;
  createBroadcastChannel?: (name: string) => BroadcastChannel | null;
  isOnline?: () => boolean;
  isVisible?: () => boolean;
  getOwnerKey?: () => string | null;
  apiRequest?: <T = any>(path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
  hasSendArrived?: (record: OutboxRecord) => boolean;
  dispatch?: (action: Action) => void;
  getState?: () => AppState | null;
  waitExecutionSettings?: (record: OutboxRecord) => Promise<void>;
}

export class StaleOutboxLeaseError extends Error {
  constructor(leaseKey: string) {
    super(`Stale outbox lease for ${leaseKey}`);
    this.name = "StaleOutboxLeaseError";
  }
}

export function makeOutboxLeaseKey(ownerKey: string, threadId: string): string {
  return `${ownerKey}::${threadId}`;
}

export function makeOutboxLockName(ownerKey: string, threadId: string): string {
  return `omb-outbox:${ownerKey}:${threadId}`;
}

function errorCodeFrom(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; body?: { code?: unknown } };
  if (typeof candidate.code === "string" && candidate.code) return candidate.code;
  if (typeof candidate.body?.code === "string" && candidate.body.code) return candidate.body.code;
  return undefined;
}

export function classifyOutboxError(error: unknown): OutboxErrorClassification {
  const code = errorCodeFrom(error);
  if (error instanceof ApiError) {
    const message = error.message || `HTTP ${error.status}`;
    if (error.status === 401) {
      return { kind: "auth", ...(code ? { code } : {}), message };
    }
    if (error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504) {
      return {
        kind: "retryable",
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(code ? { code } : {}),
        message,
      };
    }
    if (error.status === 409) {
      if (code && RETRYABLE_409_CODES.has(code)) {
        return { kind: "retryable", code, message };
      }
      return { kind: "terminal", ...(code ? { code } : {}), message };
    }
    if (error.status >= 400 && error.status < 500) {
      return { kind: "terminal", ...(code ? { code } : {}), message };
    }
    return { kind: "retryable", ...(code ? { code } : {}), message };
  }
  const message = error instanceof Error ? error.message : String(error ?? "Network error");
  return { kind: "retryable", ...(code ? { code } : {}), message };
}

export function jitteredAutoRetryDelayMs(
  attemptIndex: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const clamped = Math.max(0, Math.min(attemptIndex, OUTBOX_AUTO_RETRY_DELAYS_MS.length - 1));
  const base = OUTBOX_AUTO_RETRY_DELAYS_MS[clamped]!;
  // +/-15% jitter around base schedule while strictly honoring Retry-After floors.
  const factor = 0.85 + Math.max(0, Math.min(1, random())) * 0.3;
  return Math.max(Math.round(base * factor), retryAfterMs ?? 0);
}

export function requestPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export async function readAllOutboxFromStore(store: IDBObjectStore): Promise<OutboxRecord[]> {
  if (typeof store.getAll === "function") {
    const rows = await requestPromise(store.getAll() as IDBRequest<unknown[]>);
    return Array.isArray(rows) ? (rows as OutboxRecord[]) : [];
  }
  return [];
}

export async function readThreadOutboxFromStore(
  store: IDBObjectStore,
  ownerKey: string,
  threadId: string,
): Promise<OutboxRecord[]> {
  let rows: OutboxRecord[];
  if (
    store.indexNames?.contains?.(OMB_PWA_OUTBOX_THREAD_INDEX) &&
    typeof store.index === "function" &&
    typeof IDBKeyRange !== "undefined"
  ) {
    const idx = store.index(OMB_PWA_OUTBOX_THREAD_INDEX);
    if (typeof idx.getAll === "function") {
      const range = IDBKeyRange.bound([ownerKey, threadId, 0], [ownerKey, threadId, Number.MAX_SAFE_INTEGER]);
      rows = (await requestPromise(idx.getAll(range) as IDBRequest<OutboxRecord[]>)) ?? [];
    } else {
      rows = (await readAllOutboxFromStore(store)).filter((r) => r.ownerKey === ownerKey && r.threadId === threadId);
    }
  } else {
    rows = (await readAllOutboxFromStore(store)).filter((r) => r.ownerKey === ownerKey && r.threadId === threadId);
  }
  return rows.sort((a, b) => a.seq - b.seq);
}

export function outboxRecordToOptimisticMessage(record: OutboxRecord, parentId: string | null = null): Message {
  return {
    id: optimisticMessageId(record.sendId),
    role: "user",
    kind: "text",
    text: record.text,
    at: record.createdAt,
    parentId,
    replyToId: record.replyToId,
    sendId: record.sendId,
    channelMode: record.mode,
    outboxRestored: true,
  };
}
