import { useEffect, useRef } from "react";
import type { AppState, Bot, ConfigStatus, Group } from "./store";
import { getPwaAuth, isRemotePwaMode } from "@/lib/pwa-config";
import {
  consumeBootPwaCache,
  getActivePwaPrefs,
  patchPwaPrefs,
  readQueryBotFromLocation,
  resolvePwaLaunchSelection,
  writePwaSnapshot,
} from "@/lib/pwa-cache";

export type HydrateFromCacheAction = {
  type: "hydrateFromCache";
  bots: Bot[];
  groups: Group[];
  sections?: string[];
  config?: ConfigStatus | null;
  selectedId?: string;
  threadId?: string;
};

export function reduceHydrateFromCache(state: AppState, action: HydrateFromCacheAction): AppState {
  const known = (id: string) => action.bots.some((b) => b.id === id) || action.groups.some((g) => g.id === id);
  const selectedId =
    action.selectedId && known(action.selectedId)
      ? action.selectedId
      : (action.bots.find((b) => !b.hidden)?.id ?? action.bots[0]?.id ?? action.groups[0]?.id ?? "");
  const bots = action.bots.map((bot) => {
    if (
      bot.id === selectedId &&
      action.threadId &&
      action.threadId !== bot.threadId &&
      bot.tasks?.some((t) => t.threadId === action.threadId)
    ) {
      return { ...bot, threadId: action.threadId };
    }
    return bot;
  });
  return {
    ...state,
    bots,
    groups: action.groups,
    sections: action.sections ?? [],
    ...(action.config !== undefined ? { config: action.config } : {}),
    selectedId,
    hydrated: true as const,
    cachedHydrated: true,
    connected: false,
  };
}

export function initialStoreStateFromPwaCache(base: AppState): AppState {
  const cache = consumeBootPwaCache();
  if (!cache) return base;
  const selection = resolvePwaLaunchSelection({
    queryBotId: cache.queryBotId,
    prefs: cache.prefs,
    defaultBotId: cache.defaultBotId,
    bots: cache.snapshot.bots,
    groups: cache.snapshot.groups,
  });
  return reduceHydrateFromCache(base, {
    type: "hydrateFromCache",
    bots: cache.snapshot.bots,
    groups: cache.snapshot.groups,
    sections: cache.snapshot.sections,
    config: cache.snapshot.config,
    selectedId: selection.selectedId,
    threadId: selection.threadId,
  });
}

export function resolveLiveResumeId(
  bots: readonly Bot[],
  groups: readonly Group[],
  fallbackId?: string,
): string | undefined {
  if (isRemotePwaMode()) {
    const auth = getPwaAuth();
    const picked = resolvePwaLaunchSelection({
      queryBotId: readQueryBotFromLocation(),
      prefs: getActivePwaPrefs(),
      defaultBotId: auth?.defaultBotId,
      bots,
      groups,
    });
    if (picked.selectedId) return picked.selectedId;
  }
  return fallbackId;
}

export function usePwaCacheSync(state: AppState): void {
  const auth = getPwaAuth();
  const ownerKey = auth?.ownerKey ?? "";
  const latestRef = useRef(state);
  latestRef.current = state;

  const selectedOwner =
    state.bots.find((b) => b.id === state.selectedId) ??
    state.groups.find((g) => g.id === state.selectedId);
  const selectedId = state.selectedId;
  const selectedThreadId = selectedOwner?.threadId;

  useEffect(() => {
    if (!ownerKey || !state.hydrated || !selectedId) return;
    void patchPwaPrefs(ownerKey, {
      lastBotId: selectedId,
      ...(selectedThreadId ? { lastThreadId: selectedThreadId } : {}),
    }).catch(() => {});
  }, [ownerKey, state.hydrated, selectedId, selectedThreadId]);

  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFirstLive = useRef(false);
  useEffect(() => {
    if (!ownerKey || !state.hydrated || state.cachedHydrated) return;
    const persist = () => {
      const current = latestRef.current;
      if (!current.hydrated || current.cachedHydrated) return;
      void writePwaSnapshot({
        ownerKey,
        bots: current.bots,
        groups: current.groups,
        sections: current.sections ?? [],
        config: current.config,
      }).catch(() => {});
    };
    if (!savedFirstLive.current) {
      savedFirstLive.current = true;
      persist();
      return;
    }
    if (snapshotTimer.current) clearTimeout(snapshotTimer.current);
    snapshotTimer.current = setTimeout(() => {
      snapshotTimer.current = null;
      persist();
    }, 300);
    return () => {
      if (snapshotTimer.current) {
        clearTimeout(snapshotTimer.current);
        snapshotTimer.current = null;
      }
    };
  }, [ownerKey, state.hydrated, state.cachedHydrated, state.bots, state.groups, state.sections, state.config]);
}
