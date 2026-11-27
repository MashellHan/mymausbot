// Remote PWA pairing, IndexedDB (`omb-pwa-v1`) auth store, authenticated fetch wrappers, and blob media cache.
import type { PwaPairingPayload } from "../../shared/pwa-bridge.ts";
import { clearPwaMemoryCaches } from "./pwa-cache.ts";
import {
  OMB_PWA_DPOP_STORE,
  exportDpopPublicJwk,
  generateDpopKeyPair,
  prepareDpopSignedFetch,
  type GeneratedDpopKey,
} from "./pwa-dpop.ts";
import { randomUuid } from "./random-uuid.ts";
import {
  clearCachedMediaBlob,
  downloadRemoteUrl,
  resolveRemoteMediaUrl,
  revokeMediaBlobCache,
} from "./pwa-media.ts";
import {
  getActiveDpopKey,
  getPwaAuth,
  isElectronDesktop,
  isJsonResponse,
  isRelayMediaPath,
  isRelayTarget,
  isRemoteClientSession,
  isRemotePwaMode,
  remoteFetch,
  remoteFetchInit,
  remoteUrl,
  setActiveDpopKey,
  setActivePwaAuth,
  type PwaAuthRecord,
} from "./pwa-transport.ts";

export {
  OMB_PWA_DPOP_STORE,
  clearCachedMediaBlob,
  downloadRemoteUrl,
  getActiveDpopKey,
  getPwaAuth,
  isJsonResponse,
  isRelayMediaPath,
  isRelayTarget,
  isRemoteClientSession,
  isRemotePwaMode,
  remoteFetch,
  remoteFetchInit,
  remoteUrl,
  resolveRemoteMediaUrl,
  revokeMediaBlobCache,
  setActiveDpopKey,
  type PwaAuthRecord,
};

export function defaultDeviceLabel(userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : /Mac OS X/.test(userAgent) ? "Mac" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export const OMB_PWA_DB_NAME = "omb-pwa-v1";
export const OMB_PWA_DB_VERSION = 4;
export const OMB_PWA_AUTH_STORE = "auth";
export const OMB_PWA_PREFS_STORE = "prefs";
export const OMB_PWA_SNAPSHOT_STORE = "snapshot";
export const OMB_PWA_OUTBOX_STORE = "outbox";
export const OMB_PWA_OUTBOX_THREAD_INDEX = "byOwnerThreadSeq";
export const OMB_PWA_OUTBOX_LEASES_STORE = "outbox_leases";
export const OMB_PWA_AUTH_ACTIVE_KEY = "active";
export const DEFAULT_PWA_RELAY_ORIGIN = "https://relay.mxhan.com";

const PAIR_REQUEST_PREFIX = "omb.pwa.pairRequest.";
const OMB_PWA_AUTH_BACKUP_KEY = "omb.pwa.auth.v1";
const IDB_OPEN_TIMEOUT_MS = 5000;
const IDB_OPEN_BLOCKED_MS = 1500;
const IDB_TX_TIMEOUT_MS = 5000;
const IDB_RETRY_DELAY_MS = 150;

type DpopKeyReadResult =
  | { status: "ok"; pair: CryptoKeyPair }
  | { status: "missing" }
  | { status: "error" };

type StoredAuthReadResult =
  | { status: "ok"; record: PwaAuthRecord; dpop: DpopKeyReadResult | null }
  | { status: "missing" }
  | { status: "error" };

export type PwaPairingBootResult =
  | { status: "none" }
  | { status: "existing"; auth: PwaAuthRecord }
  | { status: "paired"; auth: PwaAuthRecord }
  | { status: "confirm"; existing: PwaAuthRecord; payload: PwaPairingPayload }
  | { status: "failed"; error: string };

export interface RelayValidationOptions {
  allowedOrigins?: readonly string[];
  allowLoopbackHttp?: boolean;
}

export interface ActivatePairingOptions extends RelayValidationOptions {
  fetchImpl?: typeof fetch;
  deviceName?: string;
  idb?: IDBFactory;
  now?: () => number;
}

let initPromise: Promise<PwaAuthRecord | null> | null = null;
const memoryPairRequests = new Map<string, string>();

export function makePwaOwnerKey(relayUrl: string, environmentId: string, sessionId: string): string {
  return `${relayUrl}::${environmentId}::${sessionId}`;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "::1" || lower === "[::1]";
}

function configuredRelayOrigins(): string[] {
  const out = new Set<string>([DEFAULT_PWA_RELAY_ORIGIN]);
  const envRaw = (import.meta as { env?: Record<string, unknown> }).env?.VITE_PWA_ALLOWED_RELAY_ORIGINS;
  if (typeof envRaw === "string") {
    for (const part of envRaw.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        out.add(new URL(trimmed).origin);
      } catch {
      }
    }
  }
  if (typeof location !== "undefined" && typeof location.origin === "string" && location.origin !== "null") {
    try {
      const loc = new URL(location.origin);
      if (loc.protocol === "https:" || (loc.protocol === "http:" && isLoopbackHost(loc.hostname))) {
        out.add(loc.origin);
      }
    } catch {
    }
  }
  return [...out];
}

export function validateRelayUrl(
  raw: string,
  options: RelayValidationOptions = {},
): { ok: true; origin: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Relay URL is missing." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Relay URL is invalid." };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { ok: false, error: "Relay URL must be a plain origin." };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { ok: false, error: "Relay URL must not include a path." };
  }
  const loopback = isLoopbackHost(parsed.hostname);
  const allowLoopback =
    options.allowLoopbackHttp ??
    (typeof location !== "undefined" && typeof location.hostname === "string" && isLoopbackHost(location.hostname));
  if (parsed.protocol === "http:") {
    if (!loopback || !allowLoopback) {
      return { ok: false, error: "Relay URL must use https://." };
    }
  } else if (parsed.protocol !== "https:") {
    return { ok: false, error: "Relay URL must use https://." };
  }

  const allowed = options.allowedOrigins ?? configuredRelayOrigins();
  if (options.allowedOrigins) {
    if (!allowed.includes(parsed.origin)) {
      return { ok: false, error: `Relay origin ${parsed.origin} is not allowed.` };
    }
  } else if (!allowed.includes(parsed.origin) && !(loopback && allowLoopback)) {
    return { ok: false, error: `Relay origin ${parsed.origin} is not allowed.` };
  }
  return { ok: true, origin: parsed.origin };
}

function decodeBase64UrlUtf8(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function parsePwaPairHash(
  rawHash: string,
  options: RelayValidationOptions = {},
): { ok: true; payload: PwaPairingPayload } | { ok: false; error: string } {
  const match = /(?:^|[#&])pair=([^&]+)/.exec(rawHash);
  if (!match) return { ok: false, error: "Invalid pairing link." };
  const decoded = decodeBase64UrlUtf8(match[1]);
  if (!decoded) return { ok: false, error: "Pairing link is corrupted." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: "Pairing link is corrupted." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Pairing link is invalid." };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.relayUrl !== "string") {
    return { ok: false, error: "Pairing link is missing a relay URL." };
  }
  const relay = validateRelayUrl(record.relayUrl, options);
  if (!relay.ok) return relay;
  if (typeof record.credential !== "string" || !record.credential.startsWith("omb_pair_")) {
    return { ok: false, error: "Pairing link credential is invalid." };
  }
  if (record.defaultBotId !== undefined && (typeof record.defaultBotId !== "string" || !/^[\w-]{1,128}$/.test(record.defaultBotId))) {
    return { ok: false, error: "Pairing link bot ID is invalid." };
  }
  return {
    ok: true,
    payload: {
      relayUrl: relay.origin,
      credential: record.credential,
      ...(typeof record.defaultBotId === "string" ? { defaultBotId: record.defaultBotId } : {}),
    },
  };
}

export function takePwaPairFromLocation(
  options: RelayValidationOptions = {},
): ReturnType<typeof parsePwaPairHash> | null {
  if (typeof location === "undefined" || typeof location.hash !== "string") return null;
  if (!/[#&]pair=/.test(location.hash)) return null;
  const rawHash = location.hash;
  if (typeof history !== "undefined" && typeof history.replaceState === "function") {
    history.replaceState(null, "", location.pathname + location.search);
  }
  return parsePwaPairHash(rawHash, options);
}

async function pairAttemptKey(relayUrl: string, credential: string): Promise<string> {
  const input = `${relayUrl}\0${credential}`;
  if (typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function") {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

async function getOrCreatePairRequestId(relayUrl: string, credential: string): Promise<string> {
  const key = `${PAIR_REQUEST_PREFIX}${await pairAttemptKey(relayUrl, credential)}`;
  try {
    const storage = globalThis.sessionStorage;
    if (storage && typeof storage.getItem === "function" && typeof storage.setItem === "function") {
      const existing = storage.getItem(key);
      if (existing) return existing;
      const created = randomUuid();
      storage.setItem(key, created);
      return created;
    }
  } catch {
  }
  const existing = memoryPairRequests.get(key);
  if (existing) return existing;
  const created = randomUuid();
  memoryPairRequests.set(key, created);
  return created;
}

async function clearPairRequestId(relayUrl: string, credential: string): Promise<void> {
  const key = `${PAIR_REQUEST_PREFIX}${await pairAttemptKey(relayUrl, credential)}`;
  memoryPairRequests.delete(key);
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
  }
}

function resolveIdbFactory(override?: IDBFactory): IDBFactory | null {
  if (override) return override;
  try {
    return typeof indexedDB !== "undefined" ? indexedDB : null;
  } catch {
    return null;
  }
}

export function openPwaDb(
  idbFactory?: IDBFactory,
  { timeoutMs = IDB_OPEN_TIMEOUT_MS, blockedMs = IDB_OPEN_BLOCKED_MS }: { timeoutMs?: number; blockedMs?: number } = {},
): Promise<IDBDatabase | null> {
  const idb = resolveIdbFactory(idbFactory);
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;
    const clearTimers = () => {
      clearTimeout(timer);
      if (blockedTimer !== null) clearTimeout(blockedTimer);
    };
    const finishResolve = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(db);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const timer = setTimeout(() => {
      finishReject(new Error("Timed out opening IndexedDB"));
    }, timeoutMs);

    let req: IDBOpenDBRequest;
    try {
      req = idb.open(OMB_PWA_DB_NAME, OMB_PWA_DB_VERSION);
    } catch (err) {
      finishReject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OMB_PWA_AUTH_STORE)) {
        db.createObjectStore(OMB_PWA_AUTH_STORE);
      }
      if (!db.objectStoreNames.contains(OMB_PWA_PREFS_STORE)) {
        db.createObjectStore(OMB_PWA_PREFS_STORE);
      }
      if (!db.objectStoreNames.contains(OMB_PWA_SNAPSHOT_STORE)) {
        db.createObjectStore(OMB_PWA_SNAPSHOT_STORE);
      }
      if (!db.objectStoreNames.contains(OMB_PWA_OUTBOX_STORE)) {
        const outbox = db.createObjectStore(OMB_PWA_OUTBOX_STORE, { keyPath: "sendId" });
        outbox?.createIndex?.(OMB_PWA_OUTBOX_THREAD_INDEX, ["ownerKey", "threadId", "seq"], { unique: false });
      }
      if (!db.objectStoreNames.contains(OMB_PWA_OUTBOX_LEASES_STORE)) {
        db.createObjectStore(OMB_PWA_OUTBOX_LEASES_STORE);
      }
      if (!db.objectStoreNames.contains(OMB_PWA_DPOP_STORE)) {
        db.createObjectStore(OMB_PWA_DPOP_STORE);
      }
    };
    req.onblocked = () => {
      if (blockedTimer !== null || settled) return;
      blockedTimer = setTimeout(() => {
        finishReject(new Error("IndexedDB open blocked"));
      }, blockedMs);
    };
    req.onsuccess = () => {
      const db = req.result;
      if (settled) {
        try { db?.close?.(); } catch {}
        return;
      }
      if (db && typeof db === "object") {
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
          }
        };
      }
      finishResolve(db);
    };
    req.onerror = () => finishReject(req.error ?? new Error("Failed to open IndexedDB"));
  });
}

function isValidStoredAuth(value: unknown): value is PwaAuthRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Partial<PwaAuthRecord>;
  return (
    typeof r.ownerKey === "string" &&
    r.ownerKey.length > 0 &&
    typeof r.relayUrl === "string" &&
    r.relayUrl.length > 0 &&
    validateRelayUrl(r.relayUrl).ok &&
    typeof r.token === "string" &&
    r.token.length > 0 &&
    typeof r.deviceId === "string" &&
    r.deviceId.length > 0 &&
    typeof r.environmentId === "string" &&
    r.environmentId.length > 0 &&
    typeof r.sessionId === "string" &&
    r.sessionId.length > 0 &&
    typeof r.serverName === "string" &&
    Array.isArray(r.scopes) &&
    typeof r.pairedAt === "number" &&
    (r.dpopBound === undefined || typeof r.dpopBound === "boolean")
  );
}

function readBackupAuth(): PwaAuthRecord | null {
  try {
    const raw = globalThis.localStorage?.getItem(OMB_PWA_AUTH_BACKUP_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidStoredAuth(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeBackupAuth(record: PwaAuthRecord): void {
  try {
    globalThis.localStorage?.setItem(OMB_PWA_AUTH_BACKUP_KEY, JSON.stringify(record));
  } catch {
  }
}

function deleteBackupAuth(): void {
  try {
    globalThis.localStorage?.removeItem(OMB_PWA_AUTH_BACKUP_KEY);
  } catch {
  }
}

function withIdbTimeout<T>(fallback: T, run: (finish: (val: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (val: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(fallback), IDB_TX_TIMEOUT_MS);
    try {
      run(finish);
    } catch {
      finish(fallback);
    }
  });
}

function hasObjectStore(db: IDBDatabase, name: string): boolean | null {
  try {
    return db.objectStoreNames.contains(name);
  } catch {
    return null;
  }
}

async function openPwaDbState(idbFactory?: IDBFactory): Promise<{ db: IDBDatabase | null; error: boolean }> {
  try {
    return { db: await openPwaDb(idbFactory), error: false };
  } catch {
    return { db: null, error: true };
  }
}

function readDpopKeyFromDb(db: IDBDatabase, ownerKey: string): Promise<DpopKeyReadResult> {
  if (!ownerKey) return Promise.resolve({ status: "missing" });
  const hasStore = hasObjectStore(db, OMB_PWA_DPOP_STORE);
  if (hasStore !== true) return Promise.resolve({ status: hasStore === false ? "missing" : "error" });
  return withIdbTimeout<DpopKeyReadResult>({ status: "error" }, (finish) => {
    const tx = db.transaction(OMB_PWA_DPOP_STORE, "readonly");
    tx.onerror = () => finish({ status: "error" });
    tx.onabort = () => finish({ status: "error" });
    const req = tx.objectStore(OMB_PWA_DPOP_STORE).get(ownerKey);
    req.onsuccess = () =>
      finish(isCryptoKeyPair(req.result) ? { status: "ok", pair: req.result } : { status: "missing" });
    req.onerror = () => finish({ status: "error" });
  });
}

function readStoredAuthFromDb(db: IDBDatabase): Promise<StoredAuthReadResult> {
  const hasAuth = hasObjectStore(db, OMB_PWA_AUTH_STORE);
  if (hasAuth !== true) return Promise.resolve({ status: hasAuth === false ? "missing" : "error" });
  const hasDpop = hasObjectStore(db, OMB_PWA_DPOP_STORE);
  if (hasDpop === null) return Promise.resolve({ status: "error" });
  return withIdbTimeout<StoredAuthReadResult>({ status: "error" }, (finish) => {
    const tx = db.transaction(hasDpop ? [OMB_PWA_AUTH_STORE, OMB_PWA_DPOP_STORE] : OMB_PWA_AUTH_STORE, "readonly");
    tx.onerror = () => finish({ status: "error" });
    tx.onabort = () => finish({ status: "error" });
    const authReq = tx.objectStore(OMB_PWA_AUTH_STORE).get(OMB_PWA_AUTH_ACTIVE_KEY);
    authReq.onerror = () => finish({ status: "error" });
    authReq.onsuccess = () => {
      if (!isValidStoredAuth(authReq.result)) {
        finish({ status: "missing" });
        return;
      }
      const record = authReq.result;
      if (record.dpopBound !== true) {
        finish({ status: "ok", record, dpop: null });
        return;
      }
      if (!hasDpop) {
        finish({ status: "ok", record, dpop: { status: "missing" } });
        return;
      }
      try {
        const dpopReq = tx.objectStore(OMB_PWA_DPOP_STORE).get(record.ownerKey);
        dpopReq.onsuccess = () =>
          finish({
            status: "ok",
            record,
            dpop: isCryptoKeyPair(dpopReq.result) ? { status: "ok", pair: dpopReq.result } : { status: "missing" },
          });
        dpopReq.onerror = () => finish({ status: "ok", record, dpop: { status: "error" } });
      } catch {
        finish({ status: "ok", record, dpop: { status: "error" } });
      }
    };
  });
}

async function readStoredAuthState(idbFactory?: IDBFactory): Promise<StoredAuthReadResult> {
  const { db, error: openError } = await openPwaDbState(idbFactory);
  let dbResult: StoredAuthReadResult = { status: openError ? "error" : "missing" };
  let backup: PwaAuthRecord | null = null;
  let backupDpop: DpopKeyReadResult | null = null;

  if (db) {
    try {
      dbResult = await readStoredAuthFromDb(db);
      if (dbResult.status === "ok") {
        if (idbFactory === undefined && (dbResult.dpop === null || dbResult.dpop.status === "ok")) deleteBackupAuth();
        return dbResult;
      }
      if (dbResult.status === "missing" && idbFactory === undefined) {
        backup = readBackupAuth();
        if (backup?.dpopBound === true) backupDpop = await readDpopKeyFromDb(db, backup.ownerKey);
      }
    } finally {
      db.close();
    }
  }

  if (idbFactory !== undefined) return dbResult;
  backup ??= readBackupAuth();
  if (!backup) return dbResult;
  if (!backup.dpopBound) {
    void writeStoredAuth(backup).then((ok) => { if (ok) deleteBackupAuth(); }).catch(() => undefined);
    return { status: "ok", record: backup, dpop: null };
  }
  const dpop: DpopKeyReadResult = backupDpop ?? { status: dbResult.status === "error" ? "error" : "missing" };
  return { status: "ok", record: backup, dpop };
}

async function writeStoredAuth(record: PwaAuthRecord, idbFactory?: IDBFactory): Promise<boolean> {
  const db = await openPwaDb(idbFactory);
  if (!db) return false;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OMB_PWA_AUTH_STORE, "readwrite");
      tx.objectStore(OMB_PWA_AUTH_STORE).put(record, OMB_PWA_AUTH_ACTIVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to persist PWA auth"));
      tx.onabort = () => reject(tx.error ?? new Error("Failed to persist PWA auth"));
    });
    return true;
  } finally {
    db.close();
  }
}

async function clearAllStoredPwaData(idbFactory?: IDBFactory): Promise<void> {
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return;
  try {
    const storeNames = [
      OMB_PWA_AUTH_STORE,
      OMB_PWA_SNAPSHOT_STORE,
      OMB_PWA_OUTBOX_STORE,
      OMB_PWA_OUTBOX_LEASES_STORE,
      OMB_PWA_PREFS_STORE,
      OMB_PWA_DPOP_STORE,
    ].filter((name) => {
      try {
        return db.objectStoreNames?.contains?.(name) !== false;
      } catch {
        return true;
      }
    });
    if (storeNames.length === 0) return;
    await withIdbTimeout<void>(undefined, (done) => {
      const tx = db.transaction(storeNames, "readwrite");
      for (const name of storeNames) {
        try {
          const store = tx.objectStore(name);
          if (typeof store.clear === "function") store.clear();
          else if (name === OMB_PWA_AUTH_STORE) store.delete(OMB_PWA_AUTH_ACTIVE_KEY);
        } catch {}
      }
      tx.oncomplete = () => done(undefined);
      tx.onerror = () => done(undefined);
      tx.onabort = () => done(undefined);
    });
  } finally {
    db.close();
  }
}

function isCryptoKeyPair(value: unknown): value is CryptoKeyPair {
  if (!value || typeof value !== "object") return false;
  const pair = value as { privateKey?: unknown; publicKey?: unknown };
  return Boolean(
    pair.privateKey &&
      typeof pair.privateKey === "object" &&
      pair.publicKey &&
      typeof pair.publicKey === "object",
  );
}

async function runDpopStoreTx<T>(
  mode: IDBTransactionMode,
  fallback: T,
  idbFactory: IDBFactory | undefined,
  run: (store: IDBObjectStore, tx: IDBTransaction, finish: (val: T) => void) => void,
): Promise<T> {
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return fallback;
  try {
    if (!db.objectStoreNames.contains(OMB_PWA_DPOP_STORE)) return fallback;
    // Some runtimes reject structured clone of non-extractable CryptoKey objects.
    return await withIdbTimeout(fallback, (finish) => {
      const tx = db.transaction(OMB_PWA_DPOP_STORE, mode);
      tx.onerror = () => finish(fallback);
      tx.onabort = () => finish(fallback);
      run(tx.objectStore(OMB_PWA_DPOP_STORE), tx, finish);
    });
  } finally {
    db.close();
  }
}

export async function readDpopKey(ownerKey: string, idbFactory?: IDBFactory): Promise<CryptoKeyPair | null> {
  if (!ownerKey) return null;
  const { db } = await openPwaDbState(idbFactory);
  if (!db) return null;
  try {
    const result = await readDpopKeyFromDb(db, ownerKey);
    return result.status === "ok" ? result.pair : null;
  } finally {
    db.close();
  }
}

export function writeDpopKey(
  ownerKey: string,
  keyPair: CryptoKeyPair,
  idbFactory?: IDBFactory,
): Promise<boolean> {
  if (!ownerKey) return Promise.resolve(false);
  return runDpopStoreTx("readwrite", false, idbFactory, (store, tx, finish) => {
    const req = store.put(keyPair, ownerKey);
    req.onerror = () => finish(false);
    tx.oncomplete = () => finish(true);
  });
}

export function deleteDpopKey(ownerKey: string, idbFactory?: IDBFactory): Promise<void> {
  if (!ownerKey) return Promise.resolve();
  return runDpopStoreTx("readwrite", undefined, idbFactory, (store, tx, finish) => {
    const req = store.delete(ownerKey);
    req.onerror = () => finish(undefined);
    tx.oncomplete = () => finish(undefined);
  });
}

function clearStoredDpopKeys(idbFactory?: IDBFactory): Promise<void> {
  return runDpopStoreTx("readwrite", undefined, idbFactory, (store, tx, finish) => {
    if (typeof store.clear !== "function") {
      finish(undefined);
      return;
    }
    const req = store.clear();
    req.onerror = () => finish(undefined);
    tx.oncomplete = () => finish(undefined);
  });
}

export async function setPwaAuth(
  record: PwaAuthRecord,
  idbFactory?: IDBFactory,
  dpopPrivateKey?: CryptoKey | null,
): Promise<void> {
  if (getPwaAuth()?.ownerKey !== record.ownerKey) {
    revokeMediaBlobCache();
  }
  let persistedInIdb = false;
  try {
    persistedInIdb = await writeStoredAuth(record, idbFactory);
  } catch {
    // Restricted Safari/WebKit storage can reject IndexedDB writes; fall back to localStorage/in-memory auth below.
  }
  if (idbFactory === undefined) {
    if (persistedInIdb) deleteBackupAuth();
    else writeBackupAuth(record);
  }
  setActivePwaAuth(record, dpopPrivateKey ?? null);
  initPromise = Promise.resolve(record);
}

export async function clearPwaAuth(idbFactory?: IDBFactory): Promise<void> {
  const activeOwnerKey = getPwaAuth()?.ownerKey ?? null;
  setActivePwaAuth(null);
  setActiveDpopKey(null);
  initPromise = Promise.resolve(null);
  revokeMediaBlobCache();
  clearPwaMemoryCaches();
  if (idbFactory === undefined) {
    deleteBackupAuth();
  }
  const stored = activeOwnerKey ? null : await readStoredAuthState(idbFactory);
  const storedOwnerKey = activeOwnerKey ?? (stored?.status === "ok" ? stored.record.ownerKey : null);
  if (storedOwnerKey) {
    await deleteDpopKey(storedOwnerKey, idbFactory);
  }
  await clearStoredDpopKeys(idbFactory);
  await clearAllStoredPwaData(idbFactory);
}

function isTransientAuthReadError(result: StoredAuthReadResult): boolean {
  return result.status === "error" || (result.status === "ok" && result.dpop?.status === "error");
}

export function initPwaAuth(idbFactory?: IDBFactory): Promise<PwaAuthRecord | null> {
  if (isElectronDesktop()) {
    setActivePwaAuth(null);
    return Promise.resolve(null);
  }
  if (initPromise) return initPromise;
  const resetPending = () => {
    if (initPromise === pending) {
      initPromise = null;
      setActivePwaAuth(null);
    }
    return null;
  };
  const pending: Promise<PwaAuthRecord | null> = (async () => {
    let result = await readStoredAuthState(idbFactory);
    if (isTransientAuthReadError(result)) {
      await new Promise((resolve) => setTimeout(resolve, IDB_RETRY_DELAY_MS));
      result = await readStoredAuthState(idbFactory);
    }
    if (isTransientAuthReadError(result)) return resetPending();
    if (result.status !== "ok") {
      setActivePwaAuth(null);
      return null;
    }
    if (result.record.dpopBound === true) {
      if (result.dpop?.status === "ok" && result.dpop.pair.privateKey) {
        setActivePwaAuth(result.record, result.dpop.pair.privateKey);
        return result.record;
      }
      await clearPwaAuth(idbFactory);
      return null;
    }
    setActivePwaAuth(result.record, null);
    return result.record;
  })().catch(resetPending);
  initPromise = pending;
  return pending;
}

export function pwaReady(): Promise<PwaAuthRecord | null> {
  if (isElectronDesktop()) return Promise.resolve(null);
  if (initPromise) return initPromise;
  const current = getPwaAuth();
  if (current) return Promise.resolve(current);
  if (!resolveIdbFactory()) return Promise.resolve(null);
  return initPwaAuth();
}

export function resetPwaConfigForTests(): void {
  setActivePwaAuth(null);
  setActiveDpopKey(null);
  initPromise = null;
  memoryPairRequests.clear();
  revokeMediaBlobCache();
}

export async function activatePwaPairing(
  payload: PwaPairingPayload,
  options: ActivatePairingOptions = {},
): Promise<{ ok: true; auth: PwaAuthRecord } | { ok: false; error: string; status?: number; code?: string }> {
  const relay = validateRelayUrl(payload.relayUrl, options);
  if (!relay.ok) return { ok: false, error: relay.error };
  const fetchImpl = options.fetchImpl ?? fetch;
  const pairRequestId = await getOrCreatePairRequestId(relay.origin, payload.credential);
  const deviceName = options.deviceName ?? defaultDeviceLabel();
  const stagingKey = `pending:${pairRequestId}`;
  let generated: GeneratedDpopKey | null = null;
  const stagedPair = await readDpopKey(stagingKey, options.idb);
  if (stagedPair) {
    const publicJwk = await exportDpopPublicJwk(stagedPair.publicKey);
    if (publicJwk) {
      generated = { keyPair: stagedPair, publicJwk };
    } else {
      await deleteDpopKey(stagingKey, options.idb);
    }
  }
  if (!generated) {
    const fresh = await generateDpopKeyPair();
    if (fresh && (await writeDpopKey(stagingKey, fresh.keyPair, options.idb))) {
      generated = fresh;
    }
  }

  let cleanupStaging = false;
  try {
    let pairRes: Response;
    try {
      pairRes = await fetchImpl(`${relay.origin}/api/pair`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credential: payload.credential,
          deviceName,
          pairRequestId,
          ...(generated ? { dpopPublicKey: generated.publicJwk } : {}),
        }),
      });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not reach relay.",
      };
    }

    const pairBody = isJsonResponse(pairRes)
      ? ((await pairRes.json().catch(() => null)) as Record<string, unknown> | null)
      : null;
    if (!pairRes.ok) {
      if (pairRes.status === 400 || pairRes.status === 401 || pairRes.status === 403 || pairRes.status === 415) {
        cleanupStaging = true;
        await clearPairRequestId(relay.origin, payload.credential);
      }
      const errText =
        typeof pairBody?.error === "string"
          ? pairBody.error
          : `Pairing failed (${pairRes.status})`;
      return {
        ok: false,
        error: errText,
        status: pairRes.status,
        ...(typeof pairBody?.code === "string" ? { code: pairBody.code } : {}),
      };
    }

    const token = typeof pairBody?.token === "string" ? pairBody.token : "";
    const device = pairBody?.device && typeof pairBody.device === "object" ? (pairBody.device as Record<string, unknown>) : null;
    const deviceId = typeof device?.id === "string" ? device.id : "";
    const serverName = typeof pairBody?.serverName === "string" ? pairBody.serverName : "";
    if (!token || !deviceId) {
      cleanupStaging = true;
      await clearPairRequestId(relay.origin, payload.credential);
      return { ok: false, error: "Relay returned an invalid pairing response." };
    }

    const sessionUrl = `${relay.origin}/api/auth/session`;
    const envUrl = `${relay.origin}/.well-known/openmausbot/environment`;
    const baseVerifyInit: RequestInit = {
      credentials: "omit",
      headers: { authorization: `Bearer ${token}` },
    };
    let sessionRes: Response;
    let envRes: Response;
    try {
      const [sessionInit, envInit] = generated
        ? await Promise.all([
            prepareDpopSignedFetch({
              privateKey: generated.keyPair.privateKey,
              url: sessionUrl,
              init: baseVerifyInit,
            }),
            prepareDpopSignedFetch({
              privateKey: generated.keyPair.privateKey,
              url: envUrl,
              init: baseVerifyInit,
            }),
          ])
        : [baseVerifyInit, baseVerifyInit];
      [sessionRes, envRes] = await Promise.all([
        fetchImpl(sessionUrl, sessionInit),
        fetchImpl(envUrl, envInit),
      ]);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not verify paired session.",
      };
    }

    if (!sessionRes.ok || !isJsonResponse(sessionRes)) {
      if (sessionRes.status === 400 || sessionRes.status === 401 || sessionRes.status === 403) {
        cleanupStaging = true;
        await clearPairRequestId(relay.origin, payload.credential);
      }
      return { ok: false, error: "Paired session verification failed.", status: sessionRes.status };
    }
    if (!envRes.ok || !isJsonResponse(envRes)) {
      if (envRes.status === 400 || envRes.status === 401 || envRes.status === 403) {
        cleanupStaging = true;
        await clearPairRequestId(relay.origin, payload.credential);
      }
      return { ok: false, error: "Server environment verification failed.", status: envRes.status };
    }

    const sessionBody = (await sessionRes.json().catch(() => null)) as Record<string, unknown> | null;
    const envBody = (await envRes.json().catch(() => null)) as Record<string, unknown> | null;
    const sessionId = typeof sessionBody?.id === "string" ? sessionBody.id : "";
    const sessionEnvId = typeof sessionBody?.environmentId === "string" ? sessionBody.environmentId : "";
    const envId = typeof envBody?.environmentId === "string" ? envBody.environmentId : "";
    const scopes = Array.isArray(sessionBody?.scopes)
      ? sessionBody.scopes.filter((s): s is string => typeof s === "string")
      : [];

    if (
      sessionBody?.kind !== "session" ||
      !sessionId ||
      !scopes.includes("client") ||
      !sessionEnvId ||
      !envId ||
      sessionEnvId !== envId
    ) {
      cleanupStaging = true;
      await clearPairRequestId(relay.origin, payload.credential);
      return { ok: false, error: "Server returned an unexpected session or environment identity." };
    }

    const record: PwaAuthRecord = {
      ownerKey: makePwaOwnerKey(relay.origin, envId, sessionId),
      relayUrl: relay.origin,
      token,
      deviceId,
      environmentId: envId,
      sessionId,
      serverName: serverName || (typeof envBody?.label === "string" ? envBody.label : "OpenMausBot"),
      scopes,
      ...(payload.defaultBotId ? { defaultBotId: payload.defaultBotId } : {}),
      dpopBound: Boolean(generated),
      pairedAt: (options.now ?? Date.now)(),
    };

    if (generated) {
      const persisted = await writeDpopKey(record.ownerKey, generated.keyPair, options.idb);
      if (!persisted) {
        cleanupStaging = true;
        await clearPairRequestId(relay.origin, payload.credential);
        return { ok: false, error: "Could not persist device signing key in browser storage." };
      }
    }
    cleanupStaging = true;
    await setPwaAuth(record, options.idb, generated?.keyPair.privateKey ?? null);
    await clearPairRequestId(relay.origin, payload.credential);
    return { ok: true, auth: record };
  } finally {
    if (cleanupStaging && generated) {
      await deleteDpopKey(stagingKey, options.idb);
    }
  }
}

export async function bootstrapPwaConfig(options: ActivatePairingOptions = {}): Promise<PwaPairingBootResult> {
  if (isElectronDesktop()) return { status: "none" };
  try {
    const parsedPair = takePwaPairFromLocation(options);
    const existing = await initPwaAuth(options.idb);
    if (!parsedPair) {
      return existing ? { status: "existing", auth: existing } : { status: "none" };
    }
    if (!parsedPair.ok) {
      return { status: "failed", error: parsedPair.error };
    }
    if (existing) {
      return { status: "confirm", existing, payload: parsedPair.payload };
    }
    const activated = await activatePwaPairing(parsedPair.payload, options);
    if (!activated.ok) {
      return { status: "failed", error: activated.error };
    }
    return { status: "paired", auth: activated.auth };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
