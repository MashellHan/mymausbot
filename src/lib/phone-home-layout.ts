import { useSyncExternalStore } from "react";

export const PHONE_HOME_LAYOUTS = ["list", "cards", "compact"] as const;
export type PhoneHomeLayout = (typeof PHONE_HOME_LAYOUTS)[number];
export const PHONE_HOME_LAYOUT_KEY = "omb.phone.homeLayout.v1";

let sessionChoice: PhoneHomeLayout | undefined;
const listeners = new Set<() => void>();

export function parsePhoneHomeLayout(value: string | null | undefined): PhoneHomeLayout {
  return value === "cards" || value === "compact" ? value : "list";
}

export function readPhoneHomeLayout(storage?: Pick<Storage, "getItem"> | null): PhoneHomeLayout {
  if (storage === undefined && sessionChoice !== undefined) return sessionChoice;
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    return parsePhoneHomeLayout(target?.getItem(PHONE_HOME_LAYOUT_KEY));
  } catch { return "list"; }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== PHONE_HOME_LAYOUT_KEY && event.key !== null) return;
  try { if (event.storageArea && event.storageArea !== globalThis.localStorage) return; } catch { return; }
  sessionChoice = undefined;
  notify();
}

export function subscribePhoneHomeLayout(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined" && typeof window.addEventListener === "function") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined" && typeof window.removeEventListener === "function") window.removeEventListener("storage", onStorage);
  };
}

export function setPhoneHomeLayout(layout: PhoneHomeLayout, storage?: Pick<Storage, "setItem"> | null): void {
  const next = parsePhoneHomeLayout(layout);
  sessionChoice = next;
  try {
    const target = storage === undefined ? (globalThis.localStorage ?? null) : storage;
    target?.setItem(PHONE_HOME_LAYOUT_KEY, next);
  } catch { /* storage may be blocked */ }
  notify();
}

export function usePhoneHomeLayout(): PhoneHomeLayout {
  return useSyncExternalStore(subscribePhoneHomeLayout, () => readPhoneHomeLayout(), () => "list");
}

export function resetPhoneHomeLayoutForTests(): void { sessionChoice = undefined; }
