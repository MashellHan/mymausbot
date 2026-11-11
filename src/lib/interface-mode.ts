import { useSyncExternalStore } from "react";

import { SIMPLE_ONLY } from "./simple-only";

export const ADVANCED_MODE_KEY = "omb-advanced-mode";
export const INTERFACE_MODE_KEY = "omb-interface-mode";
export type InterfaceMode = "raw" | "simple" | "advanced";

let sessionChoice: InterfaceMode | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readInterfaceMode(): InterfaceMode {
  if (SIMPLE_ONLY) return "simple";
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    const stored = storage()?.getItem(INTERFACE_MODE_KEY);
    return stored === "simple" || stored === "advanced" ? stored : "raw";
  } catch {
    return "raw";
  }
}

export function settleInterfaceModeDefault(): void {
  try {
    const store = storage();
    if (store && store.getItem(INTERFACE_MODE_KEY) == null) {
      store.setItem(INTERFACE_MODE_KEY, "raw");
      store.removeItem(ADVANCED_MODE_KEY);
    }
  } catch {
  }
}

export const settleAdvancedModeDefault = settleInterfaceModeDefault;
export const readAdvancedMode = (): boolean => readInterfaceMode() === "advanced";

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== INTERFACE_MODE_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  notify();
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

export function setInterfaceMode(mode: InterfaceMode): void {
  if (SIMPLE_ONLY) return;
  sessionChoice = mode;
  try {
    storage()?.setItem(INTERFACE_MODE_KEY, mode);
  } catch {
  }
  notify();
}

export const setAdvancedMode = (enabled: boolean): void => setInterfaceMode(enabled ? "advanced" : "simple");

export function useInterfaceMode(): InterfaceMode {
  return useSyncExternalStore(subscribe, readInterfaceMode, () => "raw");
}

export function useAdvancedMode(): boolean {
  return useInterfaceMode() === "advanced";
}
