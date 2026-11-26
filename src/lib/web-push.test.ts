import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePwaAuth } from "./pwa-transport";
import {
  SW_PUSH_SUBSCRIPTION_CHANGE_TYPE,
  SW_SET_BADGE_TYPE,
  deleteWebPushSubscription,
  detectWebPushEnvironment,
  enableWebPush,
  installWebPushSwSync,
  resetWebPushClientStateForTests,
  sendTestWebPush,
  syncAppBadge,
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
});
