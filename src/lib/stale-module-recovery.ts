const STALE_MODULE_RELOAD_KEY = "omb-stale-module-reload-at";
const STALE_MODULE_RELOAD_COOLDOWN_MS = 15_000;

const CHUNK_LOAD_ERROR_PATTERNS = [
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Loading chunk [\w-]+ failed/i,
  /Unable to preload CSS/i,
];

export function isStaleModuleError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
  return CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export async function clearPwaShellCaches(): Promise<void> {
  if (typeof caches === "undefined" || typeof caches.keys !== "function") return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("omb-pwa-shell-"))
        .map((key) => caches.delete(key).catch(() => false)),
    );
  } catch {
    // Best-effort only; never block reload.
  }
}

export function attemptStaleModuleAutoReload(
  error: unknown,
  options: {
    now?: number;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
    reload?: () => void;
    clearCaches?: () => Promise<void>;
  } = {},
): boolean {
  if (!isStaleModuleError(error)) return false;
  const now = options.now ?? Date.now();
  const storage = options.storage === undefined
    ? (typeof sessionStorage !== "undefined" ? sessionStorage : null)
    : options.storage;
  try {
    const last = Number(storage?.getItem(STALE_MODULE_RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < STALE_MODULE_RELOAD_COOLDOWN_MS) {
      return false;
    }
    storage?.setItem(STALE_MODULE_RELOAD_KEY, String(now));
  } catch {
    // Private browsing or unavailable storage: allow a single reload attempt anyway.
  }
  const doReload = options.reload ?? (() => {
    if (typeof window !== "undefined") window.location.reload();
  });
  const cleaner = options.clearCaches ?? clearPwaShellCaches;
  void cleaner().finally(() => {
    doReload();
  });
  return true;
}

export function installStaleModuleRecovery(): () => void {
  if (typeof window === "undefined") return () => {};
  const onPreloadError = (event: Event) => {
    const payload = (event as CustomEvent<unknown>).detail ?? (event as { payload?: unknown }).payload ?? new Error("Importing a module script failed.");
    if (attemptStaleModuleAutoReload(payload)) {
      event.preventDefault();
    }
  };
  const onSwMessage = (event: MessageEvent) => {
    if (event.data && typeof event.data === "object" && (event.data as { type?: unknown }).type === "omb:stale-asset-reload") {
      attemptStaleModuleAutoReload(new Error("Importing a module script failed."));
    }
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  }
  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator && navigator.serviceWorker) {
      navigator.serviceWorker.removeEventListener("message", onSwMessage);
    }
  };
}
