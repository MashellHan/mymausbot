import { useSyncExternalStore } from "react";

import { useAdvancedMode } from "./interface-mode";
import { windowPrefChanged } from "./window-pref-changes";

export const SHOW_THREADS_KEY = "omb-show-threads";

let sessionChoice: boolean | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readShowThreadsChoice(): boolean {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return storage()?.getItem(SHOW_THREADS_KEY) !== "0";
  } catch {
    return true;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== SHOW_THREADS_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
  windowPrefChanged();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

export function setShowThreads(enabled: boolean): void {
  sessionChoice = enabled;
  try {
    storage()?.setItem(SHOW_THREADS_KEY, enabled ? "1" : "0");
  } catch {
  }
  notify();
  windowPrefChanged();
}

export function useShowThreadsChoice(): boolean {
  return useSyncExternalStore(subscribe, readShowThreadsChoice, () => true);
}

export function useShowThreads(): boolean {
  const chosen = useShowThreadsChoice();
  return useAdvancedMode() && chosen;
}
