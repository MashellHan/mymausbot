import { useSyncExternalStore } from "react";
import { registerPwaServiceWorker } from "./pwa-sw";
import { defaultDeviceLabel, isJsonResponse, remoteFetch } from "./pwa-config";
import { getPwaAuth, isElectronDesktop, isRemotePwaMode } from "./pwa-transport";
import {
  DEFAULT_WEB_PUSH_PREFERENCES,
  WEB_PUSH_ROUTES,
  normalizeWebPushPreferences,
  type PublicWebPushSubscription,
  type WebPushPreferences,
  type WebPushSubscriptionInput,
  type WebPushSubscriptionKeys,
  type WebPushSubscriptionResponse,
  type WebPushTestResponse,
  type WebPushVapidKeyResponse,
} from "./web-push-contract";

export const SW_NOTIFICATION_CLICK_TYPE = "omb:notification-click" as const;
export const SW_PUSH_SUBSCRIPTION_CHANGE_TYPE = "omb:pushsubscriptionchange" as const;
export const SW_SET_BADGE_TYPE = "omb:set-app-badge" as const;

const CACHE_KEY_PREFIX = "omb.webPush.sub.v1:";

export type WebPushAvailabilityState = "needs-install" | "unsupported" | "default" | "denied" | "granted";

export interface WebPushEnvironment {
  navigator?: Partial<Navigator> & { standalone?: boolean } | null;
  window?: (Partial<Window> & { PushManager?: unknown }) | null;
  location?: Partial<Location> | null;
  isSecureContext?: boolean;
}

export interface WebPushEnvironmentSnapshot {
  availability: WebPushAvailabilityState;
  ios: boolean;
  standalone: boolean;
  supported: boolean;
  permission: NotificationPermission | "unsupported";
}

export class WebPushHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "WebPushHttpError";
    this.status = status;
    this.code = code;
  }
}

export interface WebPushClientSnapshot {
  loaded: boolean;
  syncing: boolean;
  subscribing: boolean;
  testing: boolean;
  subscription: PublicWebPushSubscription | null;
  vapidPublicKey: string | null;
  vapidEnabled: boolean;
  error: string | null;
  lastLoadedAt: number;
}

const INITIAL_SNAPSHOT: WebPushClientSnapshot = {
  loaded: false,
  syncing: false,
  subscribing: false,
  testing: false,
  subscription: null,
  vapidPublicKey: null,
  vapidEnabled: false,
  error: null,
  lastLoadedAt: 0,
};

let snapshotOwner: string | null = null;
let clientSnapshot: WebPushClientSnapshot = INITIAL_SNAPSHOT;
const snapshotListeners = new Set<() => void>();

function currentOwner(): string {
  return getPwaAuth()?.ownerKey ?? "local";
}

function cacheStorageKey(owner = currentOwner()): string {
  return `${CACHE_KEY_PREFIX}${owner}`;
}

function readCachedSubscription(owner = currentOwner()): PublicWebPushSubscription | null {
  try {
    const raw = globalThis.localStorage?.getItem(cacheStorageKey(owner));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PublicWebPushSubscription | null;
    if (!parsed || typeof parsed !== "object" || typeof parsed.endpoint !== "string") return null;
    return {
      ...parsed,
      preferences: normalizeWebPushPreferences(parsed.preferences),
      hasKeys: true,
    };
  } catch {
    return null;
  }
}

function writeCachedSubscription(subscription: PublicWebPushSubscription | null, owner = currentOwner()): void {
  try {
    if (!subscription) {
      globalThis.localStorage?.removeItem(cacheStorageKey(owner));
      return;
    }
    globalThis.localStorage?.setItem(cacheStorageKey(owner), JSON.stringify(subscription));
  } catch {}
}

function ensureOwnerSnapshot(): WebPushClientSnapshot {
  const owner = currentOwner();
  if (snapshotOwner !== owner) {
    snapshotOwner = owner;
    const cached = readCachedSubscription(owner);
    clientSnapshot = {
      ...INITIAL_SNAPSHOT,
      subscription: cached,
    };
  }
  return clientSnapshot;
}

function setClientSnapshot(patch: Partial<WebPushClientSnapshot>): void {
  const base = ensureOwnerSnapshot();
  clientSnapshot = { ...base, ...patch };
  for (const listener of snapshotListeners) listener();
}

export function getWebPushClientSnapshot(): WebPushClientSnapshot {
  return ensureOwnerSnapshot();
}

export function subscribeWebPushClientSnapshot(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

export function useWebPushClientSnapshot(): WebPushClientSnapshot {
  return useSyncExternalStore(
    subscribeWebPushClientSnapshot,
    getWebPushClientSnapshot,
    getWebPushClientSnapshot,
  );
}

export function resetWebPushClientStateForTests(): void {
  snapshotOwner = null;
  clientSnapshot = INITIAL_SNAPSHOT;
}

function resolveEnv(env: WebPushEnvironment = {}): {
  nav: (Partial<Navigator> & { standalone?: boolean }) | null;
  win: (Partial<Window> & { PushManager?: unknown }) | null;
  loc: Partial<Location> | null;
  secure: boolean;
} {
  const win = env.window === undefined
    ? (typeof window !== "undefined" ? (window as Partial<Window> & { PushManager?: unknown }) : null)
    : env.window;
  const nav = env.navigator === undefined
    ? (typeof navigator !== "undefined" ? (navigator as Partial<Navigator> & { standalone?: boolean }) : null)
    : env.navigator;
  const loc = env.location === undefined
    ? (typeof location !== "undefined" ? location : null)
    : env.location;
  const secure = env.isSecureContext ?? (typeof isSecureContext === "boolean" ? isSecureContext : true);
  return { nav, win, loc, secure };
}

export function isIosDevice(env: WebPushEnvironment = {}): boolean {
  const { nav } = resolveEnv(env);
  if (!nav) return false;
  const ua = typeof nav.userAgent === "string" ? nav.userAgent : "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && typeof nav.maxTouchPoints === "number" && nav.maxTouchPoints > 1;
}

export function isStandalonePwa(env: WebPushEnvironment = {}): boolean {
  const { nav, win } = resolveEnv(env);
  if (nav?.standalone === true) return true;
  if (win && typeof win.matchMedia === "function") {
    try {
      if (win.matchMedia("(display-mode: standalone)").matches) return true;
    } catch {}
  }
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}

export function isSecurePushOrigin(env: WebPushEnvironment = {}): boolean {
  const { loc, secure } = resolveEnv(env);
  if (!secure) return false;
  if (!loc || typeof loc.protocol !== "string" || !loc.protocol) return true;
  if (loc.protocol === "https:") return true;
  return loc.protocol === "http:" && typeof loc.hostname === "string" && isLoopbackHost(loc.hostname);
}

export function isWebPushSupported(env: WebPushEnvironment = {}): boolean {
  const { nav, win } = resolveEnv(env);
  if (!nav || !win) return false;
  if (!isSecurePushOrigin(env)) return false;
  const hasSw = "serviceWorker" in nav && Boolean(nav.serviceWorker);
  const hasPushManager = "PushManager" in win && Boolean(win.PushManager);
  const hasNotification = typeof Notification !== "undefined";
  return hasSw && hasPushManager && hasNotification;
}

export function currentNotificationPermission(env: WebPushEnvironment = {}): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  void env;
  try {
    return Notification.permission;
  } catch {
    return "unsupported";
  }
}

export function detectWebPushEnvironment(env: WebPushEnvironment = {}): WebPushEnvironmentSnapshot {
  const ios = isIosDevice(env);
  const standalone = isStandalonePwa(env);
  const supported = isWebPushSupported(env);
  const permission = currentNotificationPermission(env);
  if (ios && !standalone) {
    return { availability: "needs-install", ios, standalone, supported, permission };
  }
  if (!supported || permission === "unsupported") {
    return { availability: "unsupported", ios, standalone, supported: false, permission };
  }
  if (permission === "denied") {
    return { availability: "denied", ios, standalone, supported, permission };
  }
  if (permission === "granted") {
    return { availability: "granted", ios, standalone, supported, permission };
  }
  return { availability: "default", ios, standalone, supported, permission };
}

export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const trimmed = base64Url.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) {
    throw new Error("Invalid VAPID public key format");
  }
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(`${normalized}${padding}`);
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(value: ArrayBuffer | ArrayBufferView | null | undefined): string {
  if (!value) return "";
  const view = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) {
    binary += String.fromCharCode(view[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sameByteArray(existing: ArrayBuffer | ArrayBufferView | null | undefined, expected: Uint8Array): boolean {
  if (!existing) return false;
  const view = existing instanceof ArrayBuffer
    ? new Uint8Array(existing)
    : new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength);
  if (view.byteLength !== expected.byteLength) return false;
  for (let i = 0; i < view.byteLength; i += 1) {
    if (view[i] !== expected[i]) return false;
  }
  return true;
}

export function extractPushSubscriptionKeys(subscription: Pick<PushSubscription, "toJSON"> & Partial<Pick<PushSubscription, "getKey">>): WebPushSubscriptionKeys | null {
  try {
    const json = typeof subscription.toJSON === "function" ? subscription.toJSON() : null;
    const p256dh = json?.keys?.p256dh ?? (typeof subscription.getKey === "function" ? bytesToBase64Url(subscription.getKey("p256dh")) : "");
    const auth = json?.keys?.auth ?? (typeof subscription.getKey === "function" ? bytesToBase64Url(subscription.getKey("auth")) : "");
    if (!p256dh || !auth) return null;
    return { p256dh, auth };
  } catch {
    return null;
  }
}

async function readErrorBody(res: Response): Promise<{ message: string; code?: string }> {
  if (isJsonResponse(res)) {
    const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown; code?: unknown } | null;
    const message = typeof body?.error === "string"
      ? body.error
      : typeof body?.message === "string"
        ? body.message
        : `Request failed (${res.status})`;
    const code = typeof body?.code === "string" ? body.code : undefined;
    return { message, code };
  }
  return { message: `Request failed (${res.status})` };
}

export async function fetchVapidKey(fetchImpl: typeof fetch = fetch): Promise<WebPushVapidKeyResponse> {
  const res = await remoteFetch(WEB_PUSH_ROUTES.vapidKey, { cache: "no-store" }, fetchImpl);
  if (!res.ok) {
    const err = await readErrorBody(res);
    throw new WebPushHttpError(res.status, err.message, err.code);
  }
  return (await res.json()) as WebPushVapidKeyResponse;
}

export async function fetchWebPushSubscription(fetchImpl: typeof fetch = fetch): Promise<WebPushSubscriptionResponse> {
  const res = await remoteFetch(WEB_PUSH_ROUTES.subscription, { cache: "no-store" }, fetchImpl);
  if (!res.ok) {
    const err = await readErrorBody(res);
    throw new WebPushHttpError(res.status, err.message, err.code);
  }
  return (await res.json()) as WebPushSubscriptionResponse;
}

export async function upsertWebPushSubscription(
  input: WebPushSubscriptionInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicWebPushSubscription | null> {
  const res = await remoteFetch(
    WEB_PUSH_ROUTES.subscription,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    },
    fetchImpl,
  );
  if (!res.ok) {
    const err = await readErrorBody(res);
    throw new WebPushHttpError(res.status, err.message, err.code);
  }
  const body = (await res.json().catch(() => null)) as { subscription?: PublicWebPushSubscription | null } | PublicWebPushSubscription | null;
  if (!body) return null;
  if ("subscription" in body) return body.subscription ?? null;
  return body as PublicWebPushSubscription;
}

export async function deleteWebPushSubscription(endpoint?: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const route = endpoint
    ? `${WEB_PUSH_ROUTES.subscription}?endpoint=${encodeURIComponent(endpoint)}`
    : WEB_PUSH_ROUTES.subscription;
  const res = await remoteFetch(
    route,
    { method: "DELETE" },
    fetchImpl,
  );
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const err = await readErrorBody(res);
    throw new WebPushHttpError(res.status, err.message, err.code);
  }
}

export async function sendTestWebPushRequest(fetchImpl: typeof fetch = fetch): Promise<WebPushTestResponse> {
  const res = await remoteFetch(
    WEB_PUSH_ROUTES.test,
    { method: "POST" },
    fetchImpl,
  );
  if (!res.ok) {
    const err = await readErrorBody(res);
    throw new WebPushHttpError(res.status, err.message, err.code);
  }
  return (await res.json()) as WebPushTestResponse;
}

export async function resolvePushRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const sw = navigator.serviceWorker;
  if (typeof sw.getRegistration === "function") {
    const existing = await sw.getRegistration("/").catch(() => undefined);
    if (existing) return existing;
  }
  const registered = await registerPwaServiceWorker().catch(() => null);
  if (registered) return registered;
  if (typeof sw.register === "function" && isSecurePushOrigin()) {
    try {
      return await sw.register("/sw.js", { scope: "/", updateViaCache: "none" });
    } catch {}
  }
  if (sw.ready) {
    try {
      return await Promise.race([
        sw.ready,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
    } catch {}
  }
  return null;
}

export async function getBrowserPushSubscription(): Promise<PushSubscription | null> {
  const registration = await resolvePushRegistration();
  if (!registration?.pushManager || typeof registration.pushManager.getSubscription !== "function") return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function refreshWebPushState(options: { fetchImpl?: typeof fetch } = {}): Promise<WebPushSubscriptionResponse | null> {
  if (isElectronDesktop()) return null;
  const env = detectWebPushEnvironment();
  if (env.availability === "needs-install" || env.availability === "unsupported") {
    setClientSnapshot({ loaded: true, syncing: false, error: null });
    return null;
  }
  setClientSnapshot({ syncing: true, error: null });
  try {
    const data = await fetchWebPushSubscription(options.fetchImpl);
    const subscription = data.subscription
      ? { ...data.subscription, preferences: normalizeWebPushPreferences(data.subscription.preferences) }
      : null;
    writeCachedSubscription(subscription);
    setClientSnapshot({
      loaded: true,
      syncing: false,
      subscription,
      vapidPublicKey: data.vapidPublicKey,
      vapidEnabled: Boolean(data.vapidPublicKey),
      error: null,
      lastLoadedAt: Date.now(),
    });
    return { ...data, subscription };
  } catch (error) {
    setClientSnapshot({
      loaded: true,
      syncing: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function enableWebPush(options: {
  preferences?: Partial<WebPushPreferences>;
  deviceLabel?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<
  | { ok: true; subscription: PublicWebPushSubscription }
  | { ok: false; reason: "unsupported" | "denied" | "dismissed" | "server_disabled" | "error"; error?: string }
> {
  if (typeof Notification === "undefined" || !isWebPushSupported()) {
    return { ok: false, reason: "unsupported" };
  }
  setClientSnapshot({ subscribing: true, error: null });
  try {
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission === "denied") {
      setClientSnapshot({ subscribing: false });
      return { ok: false, reason: "denied" };
    }
    if (permission !== "granted") {
      setClientSnapshot({ subscribing: false });
      return { ok: false, reason: "dismissed" };
    }

    const vapid = await fetchVapidKey(options.fetchImpl);
    if (!vapid.enabled || !vapid.publicKey) {
      setClientSnapshot({ subscribing: false, vapidEnabled: false, vapidPublicKey: null });
      return { ok: false, reason: "server_disabled" };
    }

    const registration = await resolvePushRegistration();
    if (!registration?.pushManager) {
      setClientSnapshot({ subscribing: false });
      return { ok: false, reason: "unsupported" };
    }

    const applicationServerKey = urlBase64ToUint8Array(vapid.publicKey);
    let browserSub = await registration.pushManager.getSubscription();
    const existingKey = browserSub?.options?.applicationServerKey;
    if (browserSub && existingKey && !sameByteArray(existingKey, applicationServerKey)) {
      try {
        await browserSub.unsubscribe();
      } catch {}
      browserSub = null;
    }
    if (!browserSub || !extractPushSubscriptionKeys(browserSub)) {
      browserSub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }
    const keys = extractPushSubscriptionKeys(browserSub);
    if (!browserSub.endpoint || !keys) {
      throw new Error("Push subscription keys are unavailable");
    }

    const preferences = normalizeWebPushPreferences(options.preferences ?? DEFAULT_WEB_PUSH_PREFERENCES);
    const saved = await upsertWebPushSubscription(
      {
        endpoint: browserSub.endpoint,
        keys,
        preferences,
        deviceLabel: options.deviceLabel ?? defaultDeviceLabel(),
      },
      options.fetchImpl,
    );
    const normalized: PublicWebPushSubscription = saved
      ? { ...saved, preferences: normalizeWebPushPreferences(saved.preferences) }
      : {
          endpoint: browserSub.endpoint,
          endpointOrigin: new URL(browserSub.endpoint).origin,
          deviceLabel: options.deviceLabel ?? defaultDeviceLabel(),
          preferences,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          hasKeys: true,
        };
    writeCachedSubscription(normalized);
    setClientSnapshot({
      loaded: true,
      subscribing: false,
      subscription: normalized,
      vapidPublicKey: vapid.publicKey,
      vapidEnabled: true,
      error: null,
      lastLoadedAt: Date.now(),
    });
    return { ok: true, subscription: normalized };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setClientSnapshot({ subscribing: false, error: message });
    return { ok: false, reason: "error", error: message };
  }
}

export async function updateWebPushPreferences(
  patch: Partial<WebPushPreferences>,
  options: { fetchImpl?: typeof fetch; deviceLabel?: string } = {},
): Promise<{ ok: true; subscription: PublicWebPushSubscription } | { ok: false; error: string; expired?: boolean }> {
  const prev = ensureOwnerSnapshot().subscription;
  if (!prev) {
    return { ok: false, error: "No active subscription" };
  }
  const nextPrefs = normalizeWebPushPreferences({ ...prev.preferences, ...patch });
  const optimistic: PublicWebPushSubscription = {
    ...prev,
    preferences: nextPrefs,
    updatedAt: Date.now(),
  };
  writeCachedSubscription(optimistic);
  setClientSnapshot({ subscription: optimistic, error: null });

  try {
    const browserSub = await getBrowserPushSubscription();
    const keys = browserSub ? extractPushSubscriptionKeys(browserSub) : null;
    if (!browserSub || !keys) {
      const enabledOnly = await enableWebPush({ preferences: nextPrefs, ...options });
      if (!enabledOnly.ok) {
        writeCachedSubscription(prev);
        setClientSnapshot({ subscription: prev });
        return { ok: false, error: enabledOnly.error ?? "Subscription expired", expired: true };
      }
      return { ok: true, subscription: enabledOnly.subscription };
    }
    const saved = await upsertWebPushSubscription(
      {
        endpoint: browserSub.endpoint,
        keys,
        preferences: nextPrefs,
        deviceLabel: options.deviceLabel ?? prev.deviceLabel ?? defaultDeviceLabel(),
      },
      options.fetchImpl,
    );
    const finalized: PublicWebPushSubscription = saved
      ? { ...saved, preferences: normalizeWebPushPreferences(saved.preferences) }
      : optimistic;
    writeCachedSubscription(finalized);
    setClientSnapshot({ subscription: finalized, error: null, lastLoadedAt: Date.now() });
    return { ok: true, subscription: finalized };
  } catch (error) {
    writeCachedSubscription(prev);
    const expired = error instanceof WebPushHttpError && error.status === 410;
    const message = error instanceof Error ? error.message : String(error);
    setClientSnapshot({
      subscription: expired ? null : prev,
      error: message,
    });
    if (expired) writeCachedSubscription(null);
    return { ok: false, error: message, expired };
  }
}

export async function unsubscribeWebPush(options: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  const browserSub = await getBrowserPushSubscription();
  const endpoint = browserSub?.endpoint ?? ensureOwnerSnapshot().subscription?.endpoint;
  await deleteWebPushSubscription(endpoint, options.fetchImpl);
  if (browserSub) {
    try {
      await browserSub.unsubscribe();
    } catch {}
  }
  writeCachedSubscription(null);
  setClientSnapshot({ subscription: null, error: null });
}

export async function sendTestWebPush(options: { fetchImpl?: typeof fetch } = {}): Promise<
  | { ok: true; response: WebPushTestResponse }
  | { ok: false; expired: boolean; error: string }
> {
  setClientSnapshot({ testing: true, error: null });
  try {
    const response = await sendTestWebPushRequest(options.fetchImpl);
    const expired = response.pruned > 0 && response.sent === 0;
    if (expired) {
      writeCachedSubscription(null);
      setClientSnapshot({ testing: false, subscription: null });
      return { ok: false, expired: true, error: "Subscription expired" };
    }
    setClientSnapshot({ testing: false });
    return { ok: true, response };
  } catch (error) {
    const expired = error instanceof WebPushHttpError && error.status === 410;
    if (expired) {
      writeCachedSubscription(null);
      setClientSnapshot({ testing: false, subscription: null });
    } else {
      setClientSnapshot({ testing: false });
    }
    return {
      ok: false,
      expired,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function syncAppBadge(unreadCount: number): void {
  const safeCount = Number.isFinite(unreadCount) ? Math.max(0, Math.floor(unreadCount)) : 0;
  if (typeof navigator !== "undefined") {
    try {
      const result = safeCount > 0 ? navigator.setAppBadge?.(safeCount) : navigator.clearAppBadge?.();
      void result?.catch(() => {});
    } catch {}
    try {
      navigator.serviceWorker?.controller?.postMessage({
        type: SW_SET_BADGE_TYPE,
        unreadCount: safeCount,
      });
    } catch {}
  }
}

export async function syncPushSubscriptionOnForeground(options: { fetchImpl?: typeof fetch } = {}): Promise<void> {
  if (!isRemotePwaMode()) return;
  const env = detectWebPushEnvironment();
  if (env.availability !== "granted") return;
  const cached = ensureOwnerSnapshot().subscription;
  if (!cached) return;
  const browserSub = await getBrowserPushSubscription();
  if (!browserSub || browserSub.endpoint === cached.endpoint) return;
  const keys = extractPushSubscriptionKeys(browserSub);
  if (!keys) return;
  try {
    const saved = await upsertWebPushSubscription(
      {
        endpoint: browserSub.endpoint,
        keys,
        preferences: cached.preferences,
        deviceLabel: cached.deviceLabel ?? defaultDeviceLabel(),
      },
      options.fetchImpl,
    );
    if (saved) {
      const normalized = { ...saved, preferences: normalizeWebPushPreferences(saved.preferences) };
      writeCachedSubscription(normalized);
      setClientSnapshot({ subscription: normalized, lastLoadedAt: Date.now() });
    }
  } catch {}
}

export function installWebPushSwSync(options: { fetchImpl?: typeof fetch } = {}): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !navigator.serviceWorker) {
    return () => {};
  }
  const onMessage = (event: MessageEvent) => {
    const data = event.data as {
      type?: unknown;
      subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    } | null;
    if (!data || data.type !== SW_PUSH_SUBSCRIPTION_CHANGE_TYPE) return;
    if (!isRemotePwaMode()) return;
    const sub = data.subscription;
    if (
      sub &&
      typeof sub.endpoint === "string" &&
      sub.keys &&
      typeof sub.keys.p256dh === "string" &&
      typeof sub.keys.auth === "string"
    ) {
      const cached = ensureOwnerSnapshot().subscription;
      void upsertWebPushSubscription(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
          preferences: cached?.preferences ?? DEFAULT_WEB_PUSH_PREFERENCES,
          deviceLabel: cached?.deviceLabel ?? defaultDeviceLabel(),
        },
        options.fetchImpl,
      )
        .then((saved) => {
          if (!saved) return;
          const normalized = { ...saved, preferences: normalizeWebPushPreferences(saved.preferences) };
          writeCachedSubscription(normalized);
          setClientSnapshot({ subscription: normalized, lastLoadedAt: Date.now() });
        })
        .catch(() => {});
    } else {
      void syncPushSubscriptionOnForeground(options);
    }
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
