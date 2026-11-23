import { useSyncExternalStore } from "react";
import { isMacOffline, subscribeMacOffline } from "./pwa-transport";

export function useMacOffline(): boolean {
  return useSyncExternalStore(subscribeMacOffline, isMacOffline, isMacOffline);
}
