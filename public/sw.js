const CACHE_PREFIX = "omb-pwa-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v2`;
const APP_SHELL_URLS = [
  "/",
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
        const networkUpdate = fetch(networkTarget)
          .then(async (response) => {
            if (response && response.ok && response.type === "basic") {
              const clean = await cleanResponse(response);
              void cache.put("/", clean.clone());
              return clean;
            }
            return cleanResponse(response);
          })
          .catch(() => null);
        if (cached) {
          event.waitUntil(networkUpdate);
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
        if (cached) return cached;
        const response = await fetch(request);
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
          if (response && response.ok && response.type === "basic" && !response.redirected) {
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
