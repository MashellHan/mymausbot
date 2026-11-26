// Media blob caching and authenticated remote downloads for the PWA client.
import {
  getPwaAuth,
  isRelayMediaPath,
  remoteFetch,
  remoteUrl,
} from "./pwa-transport.ts";

const MAX_CACHED_MEDIA_BLOBS = 128;
const mediaBlobCache = new Map<string, string>();
const mediaInFlight = new Map<string, Promise<string>>();

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
