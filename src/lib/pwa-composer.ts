import { isRemotePwaMode } from "./pwa-transport";

export function isComposerLocked(input: {
  setupLocked: boolean;
  awaitingThreadSnapshot?: boolean;
  cachedHydrated?: boolean;
}): boolean {
  if (input.setupLocked) return true;
  if (!input.awaitingThreadSnapshot) return false;
  return !(isRemotePwaMode() || Boolean(input.cachedHydrated));
}

export function isPwaOfflineDraftBlocked(input: {
  connected: boolean;
  cachedHydrated?: boolean;
  hasAttachments?: boolean;
}): boolean {
  if (!(isRemotePwaMode() || Boolean(input.cachedHydrated))) return false;
  const navigatorOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!(!input.connected || navigatorOffline)) return false;
  return Boolean(input.hasAttachments);
}
