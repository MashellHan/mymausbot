const CACHE_PREFIX = "omb-pwa-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v4`;
const NAV_NETWORK_TIMEOUT_MS = 400;
const STALE_ASSET_HEAL_COOLDOWN_MS = 10_000;
let lastStaleAssetHealAt = 0;
const APP_SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/app-icon.svg",
  "/app-icon-192.png",
  "/app-icon-512.png",
  "/apple-touch-icon.png",
];

function isHtmlResponse(response) {
  const contentType = response && response.headers ? response.headers.get("content-type") || "" : "";
  return /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
}

function isApiOrDynamicPath(rawPathname) {
  const pathname = String(rawPathname || "").toLowerCase();
  return (
    pathname === "/sw.js" ||
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/.well-known/") ||
    pathname.startsWith("/@vite") ||
    pathname.startsWith("/@react-refresh") ||
    pathname.startsWith("/src/") ||
    pathname.startsWith("/node_modules/")
  );
}

// Safari/WebKit rejects navigation responses with `.redirected === true`
// ("Response served by service worker has redirections"); Cloudflare Pages
// redirects `/index.html` -> `/` with 308.
async function cleanResponse(response) {
  if (!response || !response.redirected) return response;
  const body = await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
}

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(
    APP_SHELL_URLS.map(async (path) => {
      const response = await fetch(path, { cache: "no-cache" });
      if (!response || !response.ok || response.type !== "basic") {
        throw new Error(`Failed to precache ${path}: ${response ? response.status : "network error"}`);
      }
      await cache.put(path, await cleanResponse(response));
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

// Only prune old shell caches; never touch IndexedDB (omb-pwa-v1).
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApiOrDynamicPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match("/");
        const networkTarget = url.pathname === "/index.html" ? "/" : request;
        const networkUpdate = fetch(networkTarget, { cache: "no-cache" })
          .then(async (response) => {
            if (response && response.ok && response.type === "basic") {
              const clean = await cleanResponse(response);
              if (isHtmlResponse(clean)) {
                void cache.put("/", clean.clone());
              }
              return clean;
            }
            return cleanResponse(response);
          })
          .catch(() => null);
        if (cached) {
          event.waitUntil(networkUpdate);
          const fresh = await Promise.race([
            networkUpdate,
            new Promise((resolve) => setTimeout(() => resolve(null), NAV_NETWORK_TIMEOUT_MS)),
          ]);
          if (fresh && fresh.ok) return fresh;
          return cached.redirected ? cleanResponse(cached) : cached;
        }
        return (await networkUpdate) || Response.error();
      }),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached && !isHtmlResponse(cached)) return cached;
        const response = await fetch(request);
        // Cloudflare Pages returns 200 text/html (SPA fallback) for pruned /assets/* hashes;
        // never cache it under an asset URL, drop stale cached "/", and trigger one reload so the fresh shell takes over.
        if (isHtmlResponse(response)) {
          if (typeof cache.delete === "function") await cache.delete("/");
          const now = Date.now();
          if (
            now - lastStaleAssetHealAt > STALE_ASSET_HEAL_COOLDOWN_MS &&
            self.clients &&
            typeof self.clients.matchAll === "function"
          ) {
            lastStaleAssetHealAt = now;
            event.waitUntil(
              self.clients
                .matchAll({ type: "window" })
                .then((clients) =>
                  Promise.all(
                    clients.map((client) =>
                      typeof client.navigate === "function" ? client.navigate(client.url).catch(() => null) : null,
                    ),
                  ),
                )
                .catch(() => {}),
            );
          }
          return new Response("", { status: 404, statusText: "Not Found" });
        }
        if (response && response.ok && response.type === "basic" && !response.redirected) {
          void cache.put(request, response.clone());
        }
        return response;
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkUpdate = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic" && !response.redirected && !isHtmlResponse(response)) {
            void cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(networkUpdate);
        return cached;
      }
      return (await networkUpdate) || Response.error();
    }),
  );
});

const DEFAULT_PUSH_TITLE = "MausBot";
const SW_NOTIFICATION_CLICK_TYPE = "omb:notification-click";
const SW_PUSH_SUBSCRIPTION_CHANGE_TYPE = "omb:pushsubscriptionchange";
const SW_SET_BADGE_TYPE = "omb:set-app-badge";
const PUSH_ICON_URL = "/app-icon-192.png";
const ACTIVITY_TAG_PREFIX = "omb:activity:";

function cleanString(value, limit) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return limit ? trimmed.slice(0, limit) : trimmed;
}

function buildDeepLinkUrl(raw) {
  const origin = self.location && self.location.origin ? self.location.origin : "https://localhost";
  let url = new URL("/", origin);
  const candidate = cleanString(raw && raw.url);
  if (candidate) {
    try {
      const parsed = new URL(candidate, origin);
      if (parsed.origin === origin) {
        url = parsed;
      }
    } catch {}
  }
  const botId = cleanString(raw && raw.botId, 120);
  const groupId = cleanString(raw && raw.groupId, 120);
  const threadId = cleanString(raw && raw.threadId, 120);
  const notificationId = cleanString(raw && (raw.notificationId || raw.id), 120);
  if (botId && !url.searchParams.has("bot")) url.searchParams.set("bot", botId);
  if (groupId && !url.searchParams.has("group")) url.searchParams.set("group", groupId);
  if (threadId && !url.searchParams.has("thread")) url.searchParams.set("thread", threadId);
  if (notificationId && !url.searchParams.has("notificationId")) url.searchParams.set("notificationId", notificationId);
  return url.toString();
}

function parsePushPayload(event) {
  if (!event || !event.data) return null;
  let raw = null;
  if (typeof event.data.json === "function") {
    try {
      raw = event.data.json();
    } catch {}
  }
  if (!raw && typeof event.data.text === "function") {
    try {
      const text = event.data.text();
      if (text) raw = JSON.parse(text);
    } catch {}
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

async function syncSwBadge(unreadCount) {
  if (typeof unreadCount !== "number" || !Number.isFinite(unreadCount)) return;
  const nav = self.navigator;
  if (!nav) return;
  try {
    if (unreadCount > 0 && typeof nav.setAppBadge === "function") {
      await nav.setAppBadge(Math.max(0, Math.floor(unreadCount)));
    } else if (unreadCount <= 0 && typeof nav.clearAppBadge === "function") {
      await nav.clearAppBadge();
    }
  } catch {}
}

function serializePushSubscription(subscription) {
  if (!subscription) return null;
  if (typeof subscription.toJSON === "function") {
    try {
      const json = subscription.toJSON();
      if (json && typeof json.endpoint === "string" && json.keys && json.keys.p256dh && json.keys.auth) {
        return {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
        };
      }
    } catch {}
  }
  return null;
}

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event);
  const kind = cleanString(payload && payload.kind, 40) || "notice";
  const threadId = cleanString(payload && payload.threadId, 120);
  const botId = cleanString(payload && payload.botId, 120);
  const groupId = cleanString(payload && payload.groupId, 120);
  const id = cleanString(payload && payload.id, 120);
  const notificationId = cleanString(payload && (payload.notificationId || payload.id), 120);
  const title = cleanString(payload && payload.title, 160) || DEFAULT_PUSH_TITLE;
  const body = cleanString(payload && payload.body, 140);
  const fallbackTag =
    kind === "activity" && threadId
      ? `${ACTIVITY_TAG_PREFIX}${threadId}`
      : threadId
        ? `omb:${kind}:${threadId}`
        : id
          ? `omb:${kind}:${id}`
          : "omb:fallback";
  const tag = cleanString(payload && payload.tag, 160) || fallbackTag;
  const activity = kind === "activity" || tag.startsWith(ACTIVITY_TAG_PREFIX);
  const url = buildDeepLinkUrl(payload);
  const data = {
    url,
    kind,
    ...(id ? { id } : {}),
    ...(notificationId ? { notificationId } : {}),
    ...(botId ? { botId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(groupId ? { groupId } : {}),
    ...(cleanString(payload && payload.phase, 32) ? { phase: cleanString(payload.phase, 32) } : {}),
  };
  const options = {
    body,
    tag,
    icon: PUSH_ICON_URL,
    badge: PUSH_ICON_URL,
    data,
    renotify: !activity,
  };

  const tasks = [];
  if (self.registration && typeof self.registration.showNotification === "function") {
    tasks.push(self.registration.showNotification(title, options));
  }
  if (payload && typeof payload.unreadCount === "number") {
    tasks.push(syncSwBadge(payload.unreadCount));
  }
  event.waitUntil(Promise.all(tasks));
});

self.addEventListener("notificationclick", (event) => {
  if (event.notification && typeof event.notification.close === "function") {
    event.notification.close();
  }
  const raw = (event.notification && event.notification.data) || {};
  const targetUrl = buildDeepLinkUrl(raw);
  const notificationId = cleanString(raw.notificationId || raw.id, 120);
  const id = cleanString(raw.id, 120);
  const target = {
    ...(cleanString(raw.botId, 120) ? { botId: cleanString(raw.botId, 120) } : {}),
    ...(cleanString(raw.threadId, 120) ? { threadId: cleanString(raw.threadId, 120) } : {}),
    ...(cleanString(raw.groupId, 120) ? { groupId: cleanString(raw.groupId, 120) } : {}),
    ...(notificationId ? { notificationId } : {}),
    ...(id ? { id } : {}),
    ...(cleanString(raw.kind, 40) ? { kind: cleanString(raw.kind, 40) } : {}),
    url: targetUrl,
  };

  event.waitUntil(
    (async () => {
      if (!self.clients || typeof self.clients.matchAll !== "function") return;
      const origin = self.location && self.location.origin ? self.location.origin : "";
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const sameOrigin = all.filter((client) => {
        if (!origin || !client || typeof client.url !== "string") return true;
        try {
          return new URL(client.url).origin === origin;
        } catch {
          return false;
        }
      });
      const chosen =
        sameOrigin.find((client) => client.focused) ||
        sameOrigin.find((client) => client.visibilityState === "visible") ||
        sameOrigin[0];
      if (chosen) {
        if (typeof chosen.focus === "function") {
          await chosen.focus().catch(() => null);
        }
        if (typeof chosen.postMessage === "function") {
          chosen.postMessage({ type: SW_NOTIFICATION_CLICK_TYPE, target });
        }
        return;
      }
      if (typeof self.clients.openWindow === "function") {
        await self.clients.openWindow(targetUrl).catch(() => null);
      }
    })(),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      let nextSub = event && event.newSubscription ? event.newSubscription : null;
      if (
        !nextSub &&
        self.registration &&
        self.registration.pushManager &&
        typeof self.registration.pushManager.subscribe === "function"
      ) {
        const oldOptions = event && event.oldSubscription && event.oldSubscription.options;
        if (oldOptions && oldOptions.applicationServerKey) {
          try {
            nextSub = await self.registration.pushManager.subscribe({
              userVisibleOnly: oldOptions.userVisibleOnly !== false,
              applicationServerKey: oldOptions.applicationServerKey,
            });
          } catch {}
        }
      }
      const serialized = serializePushSubscription(nextSub);
      if (!self.clients || typeof self.clients.matchAll !== "function") return;
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if (typeof client.postMessage === "function") {
          client.postMessage({
            type: SW_PUSH_SUBSCRIPTION_CHANGE_TYPE,
            subscription: serialized,
          });
        }
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event && event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === SW_SET_BADGE_TYPE) {
    const task = syncSwBadge(data.unreadCount);
    if (typeof event.waitUntil === "function") {
      event.waitUntil(task);
    }
  }
});
