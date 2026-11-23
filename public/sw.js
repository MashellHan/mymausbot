const CACHE_PREFIX = "omb-pwa-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const APP_SHELL_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/app-icon.svg",
  "/app-icon-192.png",
  "/app-icon-512.png",
  "/apple-touch-icon.png",
];

function isApiOrDynamicPath(pathname) {
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
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
        const cached = (await cache.match("/index.html")) || (await cache.match("/"));
        const networkUpdate = fetch(request)
          .then((response) => {
            if (response && response.ok && response.type === "basic") {
              void cache.put("/index.html", response.clone());
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
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response && response.ok && response.type === "basic") {
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
          if (response && response.ok && response.type === "basic") {
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
