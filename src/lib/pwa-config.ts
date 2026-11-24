// Remote PWA pairing, IndexedDB (`omb-pwa-v1`) auth store, authenticated fetch wrappers, and blob media cache.
import type { PwaPairingPayload } from "../../shared/pwa-bridge.ts";
import {
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
  setActivePwaAuth,
  type PwaAuthRecord,
} from "./pwa-transport.ts";

export {
  getPwaAuth,
  isJsonResponse,
  isRelayMediaPath,
  isRelayTarget,
  isRemoteClientSession,
  isRemotePwaMode,
  remoteFetch,
  remoteFetchInit,
  remoteUrl,
  type PwaAuthRecord,
};

export function defaultDeviceLabel(userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  const browser = /Edg\//.test(userAgent) ? "Edge" : /OPR\//.test(userAgent) ? "Opera" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "Browser";
  const os = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : /Mac OS X/.test(userAgent) ? "Mac" : /Windows/.test(userAgent) ? "Windows" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export const OMB_PWA_DB_NAME = "omb-pwa-v1";
export const OMB_PWA_DB_VERSION = 3;
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
const MAX_CACHED_MEDIA_BLOBS = 128;

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
const mediaBlobCache = new Map<string, string>();
const mediaInFlight = new Map<string, Promise<string>>();

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

function generateRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

async function getOrCreatePairRequestId(relayUrl: string, credential: string): Promise<string> {
  const key = `${PAIR_REQUEST_PREFIX}${await pairAttemptKey(relayUrl, credential)}`;
  try {
    const existing = globalThis.sessionStorage?.getItem(key);
    if (existing) return existing;
    const created = generateRequestId();
    globalThis.sessionStorage?.setItem(key, created);
    return created;
  } catch {
    const existing = memoryPairRequests.get(key);
    if (existing) return existing;
    const created = generateRequestId();
    memoryPairRequests.set(key, created);
    return created;
  }
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
  { timeoutMs = 3000, blockedMs = 500 }: { timeoutMs?: number; blockedMs?: number } = {},
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
    };
    req.onblocked = () => {
      if (blockedTimer !== null || settled) return;
      blockedTimer = setTimeout(() => {
        finishReject(new Error("IndexedDB open blocked"));
      }, blockedMs);
    };
    req.onsuccess = () => {
      const db = req.result;
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
    typeof r.pairedAt === "number"
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

async function readStoredAuth(idbFactory?: IDBFactory): Promise<PwaAuthRecord | null> {
  const db = await openPwaDb(idbFactory).catch(() => null);
  let fromIdb: PwaAuthRecord | null = null;
  if (db) {
    try {
      fromIdb = await new Promise<PwaAuthRecord | null>((resolve) => {
        let done = false;
        const finish = (val: PwaAuthRecord | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(val);
        };
        const timer = setTimeout(() => finish(null), 3000);
        try {
          const tx = db.transaction(OMB_PWA_AUTH_STORE, "readonly");
          const req = tx.objectStore(OMB_PWA_AUTH_STORE).get(OMB_PWA_AUTH_ACTIVE_KEY);
          req.onsuccess = () => finish(isValidStoredAuth(req.result) ? req.result : null);
          req.onerror = () => finish(null);
          tx.onerror = () => finish(null);
          tx.onabort = () => finish(null);
        } catch {
          finish(null);
        }
      });
    } finally {
      db.close();
    }
  }
  if (fromIdb) {
    if (idbFactory === undefined) writeBackupAuth(fromIdb);
    return fromIdb;
  }
  if (idbFactory !== undefined) return null;
  const backup = readBackupAuth();
  if (backup) {
    void writeStoredAuth(backup).catch(() => undefined);
  }
  return backup;
}

async function writeStoredAuth(record: PwaAuthRecord, idbFactory?: IDBFactory): Promise<void> {
  const db = await openPwaDb(idbFactory);
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OMB_PWA_AUTH_STORE, "readwrite");
      tx.objectStore(OMB_PWA_AUTH_STORE).put(record, OMB_PWA_AUTH_ACTIVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Failed to persist PWA auth"));
      tx.onabort = () => reject(tx.error ?? new Error("Failed to persist PWA auth"));
    });
  } finally {
    db.close();
  }
}

async function deleteStoredAuth(idbFactory?: IDBFactory): Promise<void> {
  const db = await openPwaDb(idbFactory).catch(() => null);
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(OMB_PWA_AUTH_STORE, "readwrite");
      tx.objectStore(OMB_PWA_AUTH_STORE).delete(OMB_PWA_AUTH_ACTIVE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally {
    db.close();
  }
}

export function revokeMediaBlobCache(): void {
  if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    for (const blobUrl of mediaBlobCache.values()) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
      }
    }
  }
  mediaBlobCache.clear();
  mediaInFlight.clear();
}

export async function setPwaAuth(record: PwaAuthRecord, idbFactory?: IDBFactory): Promise<void> {
  if (getPwaAuth()?.ownerKey !== record.ownerKey) {
    revokeMediaBlobCache();
  }
  if (idbFactory === undefined) {
    writeBackupAuth(record);
  }
  try {
    await writeStoredAuth(record, idbFactory);
  } catch {
    // Restricted Safari/WebKit storage can reject writes; localStorage backup or in-memory auth still keeps pairing working.
  }
  setActivePwaAuth(record);
  initPromise = Promise.resolve(record);
}

export async function clearPwaAuth(idbFactory?: IDBFactory): Promise<void> {
  setActivePwaAuth(null);
  initPromise = Promise.resolve(null);
  revokeMediaBlobCache();
  if (idbFactory === undefined) {
    deleteBackupAuth();
  }
  await deleteStoredAuth(idbFactory);
}

export function initPwaAuth(idbFactory?: IDBFactory): Promise<PwaAuthRecord | null> {
  if (isElectronDesktop()) {
    setActivePwaAuth(null);
    return Promise.resolve(null);
  }
  if (initPromise) return initPromise;
  initPromise = readStoredAuth(idbFactory)
    .then((record) => {
      setActivePwaAuth(record);
      return record;
    })
    .catch(() => {
      setActivePwaAuth(null);
      return null;
    });
  return initPromise;
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
    return { ok: false, error: "Relay returned an invalid pairing response." };
  }

  const authHeaders = { authorization: `Bearer ${token}` };
  let sessionRes: Response;
  let envRes: Response;
  try {
    [sessionRes, envRes] = await Promise.all([
      fetchImpl(`${relay.origin}/api/auth/session`, { credentials: "omit", headers: authHeaders }),
      fetchImpl(`${relay.origin}/.well-known/openmausbot/environment`, { credentials: "omit", headers: authHeaders }),
    ]);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not verify paired session.",
    };
  }

  if (!sessionRes.ok || !isJsonResponse(sessionRes)) {
    return { ok: false, error: "Paired session verification failed.", status: sessionRes.status };
  }
  if (!envRes.ok || !isJsonResponse(envRes)) {
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
    pairedAt: (options.now ?? Date.now)(),
  };

  await setPwaAuth(record, options.idb);
  await clearPairRequestId(relay.origin, payload.credential);
  return { ok: true, auth: record };
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

function setCachedMediaBlob(cacheKey: string, blobUrl: string): void {
  if (mediaBlobCache.has(cacheKey)) {
    const existing = mediaBlobCache.get(cacheKey)!;
    mediaBlobCache.delete(cacheKey);
    if (existing !== blobUrl) {
      try {
        URL.revokeObjectURL(existing);
      } catch {
      }
    }
  }
  mediaBlobCache.set(cacheKey, blobUrl);
  while (mediaBlobCache.size > MAX_CACHED_MEDIA_BLOBS) {
    const oldestKey = mediaBlobCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestUrl = mediaBlobCache.get(oldestKey);
    mediaBlobCache.delete(oldestKey);
    if (oldestUrl) {
      try {
        URL.revokeObjectURL(oldestUrl);
      } catch {
      }
    }
  }
}

function isAllowedMediaMime(raw: string | null | undefined): boolean {
  const mime = (raw ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mime || mime === "image/svg+xml") return false;
  return mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/");
}

export function resolveRemoteMediaUrl(src: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const auth = getPwaAuth();
  if (!auth || !isRelayMediaPath(src)) return Promise.resolve(src);
  const fullUrl = remoteUrl(src);
  const cacheKey = `${auth.ownerKey}\0${fullUrl}`;
  const cached = mediaBlobCache.get(cacheKey);
  if (cached) {
    mediaBlobCache.delete(cacheKey);
    mediaBlobCache.set(cacheKey, cached);
    return Promise.resolve(cached);
  }
  const existingFlight = mediaInFlight.get(cacheKey);
  if (existingFlight) return existingFlight;

  const flight = remoteFetch(src, { cache: "no-store" }, fetchImpl)
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`Media load failed (${res.status})`);
      }
      const headerMime = res.headers.get("content-type");
      if (headerMime !== null && !isAllowedMediaMime(headerMime)) {
        throw new Error(`Unsupported media type (${headerMime || "unknown"})`);
      }
      const blob = await res.blob();
      if (!isAllowedMediaMime(headerMime ?? blob.type)) {
        throw new Error(`Unsupported media type (${blob.type || "unknown"})`);
      }
      const blobUrl = URL.createObjectURL(blob);
      if (getPwaAuth()?.ownerKey !== auth.ownerKey) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
        }
        throw new Error("PWA session changed");
      }
      setCachedMediaBlob(cacheKey, blobUrl);
      return blobUrl;
    })
    .finally(() => {
      if (mediaInFlight.get(cacheKey) === flight) {
        mediaInFlight.delete(cacheKey);
      }
    });

  mediaInFlight.set(cacheKey, flight);
  return flight;
}

export function clearCachedMediaBlob(src: string): void {
  const auth = getPwaAuth();
  if (!auth) return;
  const key = `${auth.ownerKey}\0${remoteUrl(src)}`;
  const prev = mediaBlobCache.get(key);
  if (prev) {
    mediaBlobCache.delete(key);
    try {
      URL.revokeObjectURL(prev);
    } catch {
    }
  }
}

export async function downloadRemoteUrl(url: string, filename: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await remoteFetch(url, undefined, fetchImpl);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = new Blob([await res.arrayBuffer()], { type: "application/octet-stream" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}
