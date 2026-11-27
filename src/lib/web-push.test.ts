import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePwaAuth } from "./pwa-transport";
import {
  SW_PUSH_SUBSCRIPTION_CHANGE_TYPE,
  SW_SET_BADGE_TYPE,
  deleteWebPushSubscription,
  detectWebPushEnvironment,
  enableWebPush,
  getWebPushClientSnapshot,
  installWebPushSwSync,
  isWebPushOptedOut,
  requestWebPushPermissionOnGesture,
  resetWebPushClientStateForTests,
  sendTestWebPush,
  syncAppBadge,
  syncPushSubscriptionOnForeground,
  unsubscribeWebPush,
  updateWebPushPreferences,
  urlBase64ToUint8Array,
} from "./web-push";

const AUTH_FIXTURE = {
  ownerKey: "https://relay.mxhan.com::env::s1",
  relayUrl: "https://relay.mxhan.com",
  token: "omb_sess_1",
  deviceId: "dev-1",
  environmentId: "env",
  sessionId: "s1",
  serverName: "Mac",
  scopes: ["client"],
  pairedAt: 1,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  resetWebPushClientStateForTests();
  setActivePwaAuth(AUTH_FIXTURE);
});

afterEach(() => {
  setActivePwaAuth(null);
  resetWebPushClientStateForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("web-push environment detection & helpers", () => {
  it("distinguishes iOS non-standalone Safari tabs from standalone PWAs", () => {
    const iosUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
    vi.stubGlobal("Notification", { permission: "default" });

    expect(
      detectWebPushEnvironment({
        navigator: { userAgent: iosUa, standalone: false, serviceWorker: {} as ServiceWorkerContainer },
        window: { PushManager: function PushManager() {} },
        location: { protocol: "https:", hostname: "mausbot.mxhan.com" },
        isSecureContext: true,
      }).availability,
    ).toBe("needs-install");

    expect(
      detectWebPushEnvironment({
        navigator: { userAgent: iosUa, standalone: true, serviceWorker: {} as ServiceWorkerContainer },
        window: { PushManager: function PushManager() {} },
        location: { protocol: "https:", hostname: "mausbot.mxhan.com" },
        isSecureContext: true,
      }).availability,
    ).toBe("default");
  });

  it("reports unsupported when Notification/PushManager/serviceWorker are absent or insecure", () => {
    vi.stubGlobal("Notification", { permission: "granted" });
    expect(
      detectWebPushEnvironment({
        navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" },
        window: {},
        location: { protocol: "http:", hostname: "example.com" },
        isSecureContext: false,
      }).availability,
    ).toBe("unsupported");
  });

  it("converts base64url VAPID keys cleanly and rejects invalid strings", () => {
    const raw = new Uint8Array([4, 17, 255, 0, 128]);
    const b64 = btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(Array.from(urlBase64ToUint8Array(b64))).toEqual(Array.from(raw));
    expect(() => urlBase64ToUint8Array("not valid!!")).toThrow();
  });
});

describe("web-push subscription & preference lifecycle", () => {
  function installBrowserPush(permission: NotificationPermission = "default", nextPermission: NotificationPermission = "granted") {
    const requestPermission = vi.fn(async () => nextPermission);
    vi.stubGlobal("Notification", { permission, requestPermission });
    const browserSub = {
      endpoint: "https://web.push.apple.com/sub-1",
      toJSON: () => ({
        endpoint: "https://web.push.apple.com/sub-1",
        keys: { p256dh: "key-p256", auth: "key-auth" },
      }),
      unsubscribe: vi.fn(async () => true),
    };
    const subscribe = vi.fn(async () => browserSub);
    const getSubscription = vi.fn(async () => null as PushSubscription | null);
    const registration = {
      pushManager: { subscribe, getSubscription },
    };
    vi.stubGlobal("location", { protocol: "https:", hostname: "mausbot.mxhan.com" });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)",
      standalone: true,
      serviceWorker: {
        getRegistration: vi.fn(async () => registration),
        register: vi.fn(async () => registration),
      },
    });
    vi.stubGlobal("window", {
      PushManager: function PushManager() {},
      matchMedia: () => ({ matches: true }),
    });
    return { requestPermission, subscribe, getSubscription, browserSub };
  }

  it("requests permission, fetches VAPID key, subscribes PushManager, and syncs via remoteFetch", async () => {
    const { requestPermission, subscribe, getSubscription, browserSub } = installBrowserPush("default", "granted");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/push/web/vapid-key")) {
        const headers = init?.headers as Headers | undefined;
        expect(headers?.get("authorization")).toBe("Bearer omb_sess_1");
        return jsonResponse({ enabled: true, publicKey: btoa("1234").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") });
      }
      if (url.endsWith("/api/push/web/subscription") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        expect(body.endpoint).toBe("https://web.push.apple.com/sub-1");
        expect(body.keys).toEqual({ p256dh: "key-p256", auth: "key-auth" });
        return jsonResponse({
          subscription: {
            endpoint: body.endpoint,
            endpointOrigin: "https://web.push.apple.com",
            deviceLabel: body.deviceLabel,
            preferences: { ...body.preferences },
            createdAt: 100,
            updatedAt: 100,
            hasKeys: true,
          },
          vapidPublicKey: "pub",
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await enableWebPush({ fetchImpl: fetchMock });
    expect(result.ok).toBe(true);
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();

    // Update a preference while subscription is active.
    getSubscription.mockResolvedValueOnce(browserSub as unknown as PushSubscription);
    const updated = await updateWebPushPreferences({ liveActivities: true }, { fetchImpl: fetchMock });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.subscription.preferences.liveActivities).toBe(true);
    }

    // 410 on test push clears cached subscription as expired.
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "expired" }, 410));
    const testResult = await sendTestWebPush({ fetchImpl: fetchMock });
    expect(testResult).toEqual({ ok: false, expired: true, error: "expired" });
  });

  it("syncs app badge to both navigator and service worker controller and handles pushsubscriptionchange", async () => {
    const setAppBadge = vi.fn(async () => {});
    const clearAppBadge = vi.fn(async () => {});
    const postMessage = vi.fn();
    const listeners = new Set<(e: MessageEvent) => void>();

    vi.stubGlobal("navigator", {
      setAppBadge,
      clearAppBadge,
      serviceWorker: {
        controller: { postMessage },
        addEventListener: (_t: string, cb: (e: MessageEvent) => void) => listeners.add(cb),
        removeEventListener: (_t: string, cb: (e: MessageEvent) => void) => listeners.delete(cb),
      },
    });

    syncAppBadge(5);
    expect(setAppBadge).toHaveBeenCalledWith(5);
    expect(postMessage).toHaveBeenCalledWith({ type: SW_SET_BADGE_TYPE, unreadCount: 5 });

    syncAppBadge(0);
    expect(clearAppBadge).toHaveBeenCalledOnce();

    const putSpy = vi.fn(async () => jsonResponse({ subscription: null }));
    const stop = installWebPushSwSync({ fetchImpl: putSpy });
    for (const cb of listeners) {
      cb({
        data: {
          type: SW_PUSH_SUBSCRIPTION_CHANGE_TYPE,
          subscription: { endpoint: "https://push.example/refreshed", keys: { p256dh: "p", auth: "a" } },
        },
      } as MessageEvent);
    }
    await vi.waitFor(() => expect(putSpy).toHaveBeenCalledOnce());
    stop();
  });

  it("deletes subscriptions with endpoint in the query string instead of a DELETE body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ deleted: true }));
    const endpoint = "https://web.push.apple.com/sub-1?token=a&b=2";
    await deleteWebPushSubscription(endpoint, fetchMock);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://relay.mxhan.com/api/push/web/subscription?endpoint=${encodeURIComponent(endpoint)}`);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("unsubscribes and re-subscribes when an existing PushSubscription has a mismatched applicationServerKey", async () => {
    const { subscribe, getSubscription } = installBrowserPush("granted", "granted");
    const staleUnsubscribe = vi.fn(async () => true);
    const staleSub = {
      endpoint: "https://web.push.apple.com/stale",
      options: { applicationServerKey: new Uint8Array([9, 9, 9, 9]).buffer },
      toJSON: () => ({
        endpoint: "https://web.push.apple.com/stale",
        keys: { p256dh: "old-p256", auth: "old-auth" },
      }),
      unsubscribe: staleUnsubscribe,
    };
    getSubscription.mockResolvedValueOnce(staleSub as unknown as PushSubscription);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/push/web/vapid-key")) {
        return jsonResponse({ enabled: true, publicKey: btoa("1234").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") });
      }
      if (url.endsWith("/api/push/web/subscription") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        expect(body.endpoint).toBe("https://web.push.apple.com/sub-1");
        return jsonResponse({
          subscription: {
            endpoint: body.endpoint,
            endpointOrigin: "https://web.push.apple.com",
            deviceLabel: body.deviceLabel,
            preferences: { ...body.preferences },
            createdAt: 100,
            updatedAt: 100,
            hasKeys: true,
          },
          vapidPublicKey: "pub",
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await enableWebPush({ fetchImpl: fetchMock });
    expect(result.ok).toBe(true);
    expect(staleUnsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  function installMemoryStorage() {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };
    vi.stubGlobal("localStorage", storage);
    return { store, storage };
  }

  function makePushServerFetch(options: {
    getResponse?: { subscription: unknown; vapidPublicKey: string | null };
  } = {}) {
    const vapidKey = btoa("1234").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const puts: Array<Record<string, unknown>> = [];
    const gets: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/push/web/vapid-key")) {
        return jsonResponse({ enabled: true, publicKey: vapidKey });
      }
      if (url.endsWith("/api/push/web/subscription") && method === "GET") {
        gets.push(url);
        return jsonResponse(options.getResponse ?? { subscription: null, vapidPublicKey: vapidKey });
      }
      if (url.endsWith("/api/push/web/subscription") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        puts.push(body);
        return jsonResponse({
          subscription: {
            endpoint: body.endpoint,
            endpointOrigin: "https://web.push.apple.com",
            deviceLabel: body.deviceLabel,
            preferences: body.preferences,
            createdAt: 100,
            updatedAt: 200,
            hasKeys: true,
          },
          vapidPublicKey: vapidKey,
        });
      }
      if (url.includes("/api/push/web/subscription") && method === "DELETE") {
        return jsonResponse({ deleted: true });
      }
      return jsonResponse({}, 404);
    });
    return { fetchMock, puts, gets, vapidKey };
  }

  it("auto-subscribes & syncs on foreground when permission is granted and no cached subscription exists", async () => {
    installMemoryStorage();
    const { requestPermission, subscribe } = installBrowserPush("granted", "granted");
    const { fetchMock, puts } = makePushServerFetch();

    await Promise.all([
      syncPushSubscriptionOnForeground({ fetchImpl: fetchMock }),
      syncPushSubscriptionOnForeground({ fetchImpl: fetchMock }),
    ]);

    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(puts).toHaveLength(1);
    expect(puts[0]?.endpoint).toBe("https://web.push.apple.com/sub-1");
    expect(getWebPushClientSnapshot().subscription?.endpoint).toBe("https://web.push.apple.com/sub-1");
    expect(getWebPushClientSnapshot().loaded).toBe(true);
  });

  it("re-subscribes on first foreground load when server reports subscription: null for a granted device", async () => {
    const { storage } = installMemoryStorage();
    const { getSubscription, browserSub } = installBrowserPush("granted", "granted");
    getSubscription.mockResolvedValue(browserSub as unknown as PushSubscription);
    storage.setItem(
      `omb.webPush.sub.v1:${AUTH_FIXTURE.ownerKey}`,
      JSON.stringify({
        endpoint: browserSub.endpoint,
        endpointOrigin: "https://web.push.apple.com",
        deviceLabel: "My iPhone",
        preferences: {
          enabled: true,
          urgent: true,
          finished: true,
          failures: true,
          mentions: true,
          spend: true,
          liveActivities: true,
        },
        createdAt: 10,
        updatedAt: 10,
        hasKeys: true,
      }),
    );
    resetWebPushClientStateForTests();

    const { fetchMock, gets, puts } = makePushServerFetch();
    await syncPushSubscriptionOnForeground({ fetchImpl: fetchMock });

    expect(gets).toHaveLength(1);
    expect(puts).toHaveLength(1);
    expect((puts[0]?.preferences as { liveActivities?: boolean } | undefined)?.liveActivities).toBe(true);
    expect(getWebPushClientSnapshot().loaded).toBe(true);

    // Once loaded and matching, subsequent foreground syncs do not re-fetch or re-PUT.
    await syncPushSubscriptionOnForeground({ fetchImpl: fetchMock });
    expect(gets).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });

  it("respects explicit opt-out via unsubscribeWebPush and updateWebPushPreferences({ enabled: false }) until re-enabled", async () => {
    const { store } = installMemoryStorage();
    const { getSubscription, browserSub } = installBrowserPush("granted", "granted");
    const { fetchMock, puts } = makePushServerFetch();

    // Start subscribed.
    const enabled = await enableWebPush({ fetchImpl: fetchMock });
    expect(enabled.ok).toBe(true);
    expect(isWebPushOptedOut()).toBe(false);

    // Explicit unsubscribe sets opt-out and prevents foreground auto-re-enable.
    getSubscription.mockResolvedValue(browserSub as unknown as PushSubscription);
    await unsubscribeWebPush({ fetchImpl: fetchMock });
    expect(isWebPushOptedOut()).toBe(true);
    expect(store.get("omb.webPush.optOut.v1")).toBe("1");

    const putsBeforeSync = puts.length;
    await syncPushSubscriptionOnForeground({ fetchImpl: fetchMock });
    expect(puts.length).toBe(putsBeforeSync);

    // Re-enabling clears opt-out.
    const reenabled = await enableWebPush({ fetchImpl: fetchMock });
    expect(reenabled.ok).toBe(true);
    expect(isWebPushOptedOut()).toBe(false);
    expect(store.has("omb.webPush.optOut.v1")).toBe(false);

    // Disabling via preferences sets opt-out and blocks foreground sync.
    const disabled = await updateWebPushPreferences({ enabled: false }, { fetchImpl: fetchMock });
    expect(disabled.ok).toBe(true);
    expect(isWebPushOptedOut()).toBe(true);
    expect(store.get("omb.webPush.optOut.v1")).toBe("1");

    const putsAfterDisable = puts.length;
    getSubscription.mockResolvedValueOnce(null);
    await syncPushSubscriptionOnForeground({ fetchImpl: fetchMock });
    expect(puts.length).toBe(putsAfterDisable);

    // Re-enabling via preferences clears opt-out.
    getSubscription.mockResolvedValue(browserSub as unknown as PushSubscription);
    const toggledOn = await updateWebPushPreferences({ enabled: true }, { fetchImpl: fetchMock });
    expect(toggledOn.ok).toBe(true);
    expect(isWebPushOptedOut()).toBe(false);
    expect(store.has("omb.webPush.optOut.v1")).toBe(false);
  });

  it("requestWebPushPermissionOnGesture requests permission only when default and not opted out", async () => {
    const { storage } = installMemoryStorage();
    const { requestPermission } = installBrowserPush("default", "granted");

    requestWebPushPermissionOnGesture();
    expect(requestPermission).toHaveBeenCalledOnce();

    // Skips when opted out.
    requestPermission.mockClear();
    storage.setItem("omb.webPush.optOut.v1", "1");
    requestWebPushPermissionOnGesture();
    expect(requestPermission).not.toHaveBeenCalled();

    // Skips when already granted or denied.
    storage.removeItem("omb.webPush.optOut.v1");
    const granted = installBrowserPush("granted", "granted");
    requestWebPushPermissionOnGesture();
    expect(granted.requestPermission).not.toHaveBeenCalled();

    const denied = installBrowserPush("denied", "denied");
    requestWebPushPermissionOnGesture();
    expect(denied.requestPermission).not.toHaveBeenCalled();
  });
});
