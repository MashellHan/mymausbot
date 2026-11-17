import type { HongguoCatalogMode, HongguoCategory, HongguoSeriesCard } from "../../../shared/hongguo-mini-app";
import type { HongguoCatalogSort } from "./hongguo-catalog";

export const HOME_FRESH_MS = 5 * 60_000;
type HomeSnapshot = { mode: Exclude<HongguoCatalogMode, "categories" | "metrics">; sort?: HongguoCatalogSort; query: string; categoryId: string;
  items: HongguoSeriesCard[]; nextCursor: string | null; categories: HongguoCategory[]; pendingMetricIds?: string[];
  categoriesLoaded: boolean; expiresAt: number; categoriesExpiresAt: number };
const homeSnapshots = new Map<string, HomeSnapshot>();

export function recentHome(key: string | null): HomeSnapshot | null {
  return key ? homeSnapshots.get(key) ?? null : null;
}

export function rememberHome(key: string | null, saved: HomeSnapshot): void {
  if (!key) return;
  homeSnapshots.delete(key);
  homeSnapshots.set(key, saved);
  while (homeSnapshots.size > 8) homeSnapshots.delete(homeSnapshots.keys().next().value!);
}

export function forgetHongguoHome(storageKey: string | null, appId?: string): void {
  if (!storageKey) return;
  for (const key of homeSnapshots.keys()) {
    const [environment, app] = JSON.parse(key) as [string, string, number];
    if (environment === storageKey && (!appId || app === appId)) homeSnapshots.delete(key);
  }
}
