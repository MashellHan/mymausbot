import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { randomUuid } from "@/lib/random-uuid";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, ApiError } from "@/state/store";
import { LEGACY_MINI_APP_IDS } from "../../../shared/mini-app-release-packages";
import type { DefaultMiniAppKind, MiniAppArchive, MiniAppDefaultsResult, MiniAppDocument,
  MiniAppMutationResult, MiniAppRollback, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import bookkeepingHtml from "../../../examples/mini-apps/bookkeeping/index.html?raw";
import agentTeamHtml from "../../../examples/mini-apps/agent-team/index.html?raw";
import { revealSelectedTab } from "../computer-panel-tabs";
import { ensureMiniAppDefaults } from "./MiniAppDefaultsBootstrap";
import { iconKindForApp } from "./MiniAppIcon";
import { MiniAppLibraryPopover } from "./MiniAppLibraryPopover";
import { MiniAppContent, MiniAppsHeader } from "./MiniAppsPanelViews";
import { MiniAppUpdateToast } from "./MiniAppUpdateToast";
import { forgetHongguoHome } from "./HongguoView";
import { miniAppDisplayName } from "./mini-app-display";
import {
  MINI_APP_RUNTIME_READY_TIMEOUT_MS, clearPendingUpdateRecovery, hasAnnouncedUpdateVersion,
  isPendingUpdateApplied, matchesAppliedUpdateIntent, parseMiniAppUpdateInfo, readAppPackageId,
  readPendingUpdate, reconcilePendingUpdateWithSummary, rememberAnnouncedUpdateVersion, writePendingUpdate,
  type MiniAppUpdateCandidate, type MiniAppUpdateInfo, type MiniAppUpdateRequest,
  type PendingMiniAppUpdate, type PendingMiniAppUpdateIntent, type PendingMiniAppUpdateRecovery,
} from "./mini-app-update";
import { miniAppNativeFrameGuard } from "./native-frame-guard";
import { applyMiniAppOrder } from "./mini-app-reorder";
import { applyMiniAppDataChanged, MINI_APP_FALLBACK_POLL_MS, shouldCheckMiniAppUpdate, useMiniAppLiveSync } from "./mini-app-live-sync";
import { clearMiniAppClientCache, MiniAppClientCache } from "./mini-app-client-cache";

const REFRESH_MS = MINI_APP_FALLBACK_POLL_MS;
const RELEASE_REQUEST_TIMEOUT_MS = 30_000;
const ROLLBACK_RETRY_MS = 5_000;
const DEFAULT_BAR_COLLAPSED_KEY = "omb-mini-apps-bar-collapsed";
type Inventory = { apps: MiniAppSummary[] };

function savedApp(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function rememberApp(key: string | null, id: string): void { if (!key) return; try { localStorage.setItem(key, id); } catch {} }
function barKey(storageKey: string | null): string { return storageKey ? `${storageKey}:bar-collapsed` : DEFAULT_BAR_COLLAPSED_KEY; }

function savedBarCollapsed(storageKey: string | null): boolean {
  try { const raw = (storageKey ? localStorage.getItem(barKey(storageKey)) : null) ?? localStorage.getItem(DEFAULT_BAR_COLLAPSED_KEY); return raw === "1" || raw === "true"; } catch { return false; }
}
function rememberBarCollapsed(storageKey: string | null, collapsed: boolean): void {
  const value = collapsed ? "1" : "0";
  try { localStorage.setItem(DEFAULT_BAR_COLLAPSED_KEY, value); if (storageKey) localStorage.setItem(barKey(storageKey), value); } catch {}
}

function changedState(left: MiniAppState | null, right: MiniAppState): boolean {
  return !left || left.appId !== right.appId || left.revision !== right.revision || left.templateVersion !== right.templateVersion || left.status !== right.status
    || left.data.length !== right.data.length || right.data.some((entry, index) => entry.datasetId !== left.data[index]?.datasetId || entry.revision !== left.data[index]?.revision);
}

export function MiniAppsPanel({ requestedApp }: { requestedApp?: { id: string; nonce: number } } = {}) {
  const owner = useOwnerOrAdmin();
  const nativeGuard = miniAppNativeFrameGuard();
  const visible = usePageVisible();
  const [apps, setApps] = useState<MiniAppSummary[] | null>(null);
  const [inventory, setInventory] = useState<MiniAppSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [environmentResolved, setEnvironmentResolved] = useState(false);
  const [barCollapsed, setBarCollapsed] = useState(() => savedBarCollapsed(null));
  const [document, setDocument] = useState<MiniAppDocument | null>(null);
  const [appState, setAppState] = useState<MiniAppState | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryFocus, setLibraryFocus] = useState<DefaultMiniAppKind | null>(null);
  const [defaultIssues, setDefaultIssues] = useState<MiniAppDefaultsResult["issues"]>([]);
  const [defaultsReady, setDefaultsReady] = useState(false);
  const [defaultsError, setDefaultsError] = useState("");
  const [busyKind, setBusyKind] = useState<DefaultMiniAppKind | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [updateByApp, setUpdateByApp] = useState<Record<string, MiniAppUpdateInfo>>({});
  const [toast, setToast] = useState<{ appId: string; appVersion: string; sourceCommit: string } | null>(null);
  const [updatingAppId, setUpdatingAppId] = useState<string | null>(null);
  const [updateSource, setUpdateSource] = useState<"toast" | "library" | null>(null);
  const [updateError, setUpdateError] = useState("");
  const [updateCheckError, setUpdateCheckError] = useState("");
  const [rollbackNotice, setRollbackNotice] = useState<{ appId: string; message: string } | null>(null);
  const [frameEpochByApp, setFrameEpochByApp] = useState<Record<string, number>>({});
  const documentRef = useRef(document);
  const stateRef = useRef(appState);
  const inventoryRef = useRef(inventory);
  const selectedRef = useRef(selectedId);
  const storageKeyRef = useRef(storageKey);
  const environmentResolvedRef = useRef(environmentResolved);
  const ownerRef = useRef(owner);
  const updatingAppIdRef = useRef(updatingAppId);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const defaultsStarted = useRef(false);
  const restored = useRef(false);
  const openedRequest = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const manualRefreshRef = useRef(false);
  const updateCheckSeqRef = useRef(0);
  const updateCheckedAtRef = useRef<Record<string, { at: number; revision: number }>>({});
  const mutationEpochRef = useRef(0);
  const pendingUpdatesRef = useRef<Record<string, PendingMiniAppUpdate>>({});
  const recoveryAuthBlockedRef = useRef(false);
  const recoveryTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const rollingBackAppsRef = useRef(new Set<string>());
  const runtimeReadySeenRef = useRef<Record<string, { revision: number; templateVersion: number }>>({});
  const panelDocCacheRef = useRef<MiniAppClientCache | null>(null);
  if (!panelDocCacheRef.current) panelDocCacheRef.current = new MiniAppClientCache();
  documentRef.current = document;
  stateRef.current = appState;
  inventoryRef.current = inventory;
  selectedRef.current = selectedId;
  storageKeyRef.current = storageKey;
  environmentResolvedRef.current = environmentResolved;
  ownerRef.current = owner;
  updatingAppIdRef.current = updatingAppId;
  const selected = apps?.find((app) => app.id === selectedId) ?? null;
  const selectedUpdate = selected ? (updateByApp[selected.id] ?? null) : null;
  const currentHead = !!document && !!appState && !!selected && document.app.status === "active" && appState.status === "active"
    && appState.appId === document.app.id && appState.revision === document.app.revision
    && selected.id === document.app.id && selected.revision === document.app.revision
    && selected.templateVersion === document.app.templateVersion && appState.templateVersion === document.app.templateVersion;
  const previousReleaseTemplate = currentHead && !stale && owner === true && nativeGuard
    && window.ogb?.app?.ownPage === true && window.ogb?.remoteClient?.active !== true
    ? document.app.release?.previousTemplateVersion : undefined;
  const legacyMojoActive = apps?.some((app) => app.id === LEGACY_MINI_APP_IDS.mojo && iconKindForApp(app) === "mojo");
  const archived = owner === true && nativeGuard ? inventory?.find((app) => {
    const kind = iconKindForApp(app);
    return app.status === "archived" && kind !== null && !(legacyMojoActive && kind === "mojo");
  }) : undefined;
  const archivedKind = archived ? iconKindForApp(archived) : null;

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    if (target === "selected" && barCollapsed) {
      focusAfter.current = null;
      return;
    }
    const element = target === "selected"
      ? [...panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []].find((tab) => tab.dataset.appId === selectedId)
      : target === "add" ? panelRef.current?.querySelector<HTMLButtonElement>('[data-mini-app-add]') : null;
    if (!element) return;
    element.focus();
    if (target === "selected" && tabListRef.current) revealSelectedTab(tabListRef.current);
    else element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    focusAfter.current = null;
  }, [apps, selectedId, libraryOpen, barCollapsed]);

  useLayoutEffect(() => {
    if (barCollapsed) return;
    const row = tabListRef.current;
    if (!row) return;
    revealSelectedTab(row);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => revealSelectedTab(row));
    observer.observe(row);
    return () => observer.disconnect();
  }, [selectedId, apps?.length, barCollapsed]);

  const clearRecoveryTimer = (appId: string) => {
    const timer = recoveryTimersRef.current[appId];
    if (timer !== undefined) {
      clearTimeout(timer);
      delete recoveryTimersRef.current[appId];
    }
  };

  const finishPendingRecovery = (appId: string) => {
    clearRecoveryTimer(appId);
    delete pendingUpdatesRef.current[appId];
    clearPendingUpdateRecovery(storageKeyRef.current, appId);
  };

  const pauseRecovery = () => {
    if (!recoveryAuthBlockedRef.current) mutationEpochRef.current += 1;
    recoveryAuthBlockedRef.current = true;
    for (const appId of Object.keys(recoveryTimersRef.current)) clearRecoveryTimer(appId);
  };

  const scheduleRecoveryTimer = (recovery: PendingMiniAppUpdateRecovery, delayMs: number) => {
    if (recoveryAuthBlockedRef.current) return;
    clearRecoveryTimer(recovery.appId);
    recoveryTimersRef.current[recovery.appId] = setTimeout(() => {
      delete recoveryTimersRef.current[recovery.appId];
      void rollbackRecovery(recovery);
    }, Math.max(0, delayMs));
  };

  const updateInventoryEntry = (nextApp: MiniAppSummary) => {
    inventoryRef.current = inventoryRef.current?.map((entry) => entry.id === nextApp.id ? nextApp : entry) ?? null;
    setInventory((current) => current?.map((entry) => entry.id === nextApp.id ? nextApp : entry) ?? null);
    setApps((current) => {
      if (!current) return null;
      const mapped = current.map((entry) => entry.id === nextApp.id ? nextApp : entry);
      return mapped.filter((entry) => entry.status === "active");
    });
  };

  const rollbackRecovery = async (recovery: PendingMiniAppUpdateRecovery, manual = false) => {
    if (!mountedRef.current || ownerRef.current !== true || !nativeGuard || (!manual && recoveryAuthBlockedRef.current)) return;
    if (rollingBackAppsRef.current.has(recovery.appId)) return;
    rollingBackAppsRef.current.add(recovery.appId);
    clearRecoveryTimer(recovery.appId);
    try {
      const body: MiniAppRollback = {
        requestKey: recovery.rollbackRequestKey,
        expectedRevision: recovery.candidateRevision,
        templateVersion: recovery.previousTemplateVersion,
      };
      const result = await api<MiniAppMutationResult>(`/api/mini-apps/${encodeURIComponent(recovery.appId)}/rollback`, {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 20_000,
      });
      if (!mountedRef.current) return;
      if (result.app.id !== recovery.appId) throw new Error(t("computer.miniApps.changedDuringRead"));
      mutationEpochRef.current += 1;
      finishPendingRecovery(recovery.appId);
      updateCheckSeqRef.current += 1;
      updateInventoryEntry(result.app);
      setRollbackNotice({ appId: recovery.appId, message: t(manual ? "computer.miniApps.update.restored" : "computer.miniApps.update.rolledBack") });
      if (selectedRef.current === recovery.appId) {
        if (manual) focusAfter.current = "selected";
        try {
          const nextState = await api<MiniAppState>(`/api/mini-apps/${encodeURIComponent(recovery.appId)}/state`, { timeoutMs: 10_000 });
          if (!mountedRef.current) return;
          const nextDocument = await api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(recovery.appId)}`, { timeoutMs: 10_000 });
          if (!mountedRef.current) return;
          if (selectedRef.current === recovery.appId
            && nextDocument.app.id === recovery.appId
            && nextDocument.app.revision === nextState.revision
            && nextDocument.app.templateVersion === nextState.templateVersion) {
            updateInventoryEntry(nextDocument.app);
            setFrameEpochByApp((prev) => ({ ...prev, [recovery.appId]: (prev[recovery.appId] ?? 0) + 1 }));
            documentRef.current = nextDocument;
            setDocument(nextDocument);
            stateRef.current = nextState;
            setAppState(nextState);
            setStale(false);
            setError("");
          }
        } catch {
          // Next refresh cycle will synchronize the rolled-back state and document.
        }
      }
      if (mountedRef.current) setRefreshKey((current) => current + 1);
    } catch (cause) {
      if (!mountedRef.current) return;
      if (manual) setError(cause instanceof Error ? cause.message : t("computer.miniApps.loadFailed"));
      if (cause instanceof ApiError && cause.status === 401) pauseRecovery();
      else if (cause instanceof ApiError && (cause.status === 409 || cause.status === 400 || cause.status === 403 || cause.status === 404)) {
        if (!manual || pendingUpdatesRef.current[recovery.appId]?.rollbackRequestKey === recovery.rollbackRequestKey) finishPendingRecovery(recovery.appId);
        setRefreshKey((current) => current + 1);
      } else {
        const currentPending = pendingUpdatesRef.current[recovery.appId];
        if (isPendingUpdateApplied(currentPending) && currentPending.rollbackRequestKey === recovery.rollbackRequestKey) {
          scheduleRecoveryTimer(recovery, ROLLBACK_RETRY_MS);
        }
      }
    } finally {
      rollingBackAppsRef.current.delete(recovery.appId);
    }
  };

  const restorePreviousRelease = async () => {
    if (!selected || !previousReleaseTemplate || updatingAppId !== null || busyKind !== null) return;
    const pending = pendingUpdatesRef.current[selected.id];
    const requestKey = isPendingUpdateApplied(pending) && pending.candidateRevision === selected.revision
      && pending.previousTemplateVersion === previousReleaseTemplate ? pending.rollbackRequestKey : randomUuid();
    setUpdatingAppId(selected.id);
    setUpdateSource(null);
    setError("");
    setRollbackNotice(null);
    try {
      await rollbackRecovery({ appId: selected.id, candidateRevision: selected.revision, candidateTemplateVersion: selected.templateVersion,
        previousTemplateVersion: previousReleaseTemplate, rollbackRequestKey: requestKey, deadlineAt: Date.now() }, true);
    } finally { if (mountedRef.current) setUpdatingAppId(null); }
  };

  const applyPromotedUiState = (promotedApps: Map<string, string>) => {
    if (promotedApps.size === 0) return;
    setUpdateByApp((prev) => {
      const next = { ...prev };
      for (const [appId, appVersion] of promotedApps) {
        next[appId] = { installedVersion: appVersion, status: "current", available: null };
      }
      return next;
    });
    setToast((prev) => prev && promotedApps.has(prev.appId) ? null : prev);
    if (selectedRef.current && promotedApps.has(selectedRef.current)) {
      setUpdateError("");
    }
  };

  const reconcileInventory = (inventoryApps: MiniAppSummary[]): {
    staleAppIds: Set<string>;
    promotedApps: Map<string, string>;
  } => {
    const staleAppIds = new Set<string>();
    const promotedApps = new Map<string, string>();
    if (!environmentResolvedRef.current || ownerRef.current !== true || !nativeGuard) {
      return { staleAppIds, promotedApps };
    }
    const activeStorageKey = storageKeyRef.current;
    const now = Date.now();
    const seenIds = new Set<string>();

    for (const entry of inventoryApps) {
      seenIds.add(entry.id);
      const currentInMemory = pendingUpdatesRef.current[entry.id];
      const pending = currentInMemory ?? readPendingUpdate(activeStorageKey, entry.id);
      if (!pending) continue;

      const outcome = reconcilePendingUpdateWithSummary(
        pending,
        entry,
        now,
        updatingAppIdRef.current === entry.id,
      );

      if (outcome.action === "clear") {
        finishPendingRecovery(entry.id);
        continue;
      }

      if (outcome.action === "promote") {
        const applied = outcome.record;
        const seen = runtimeReadySeenRef.current[entry.id];
        if (seen && seen.revision === applied.candidateRevision && seen.templateVersion === applied.candidateTemplateVersion) {
          finishPendingRecovery(entry.id);
        } else {
          pendingUpdatesRef.current[entry.id] = applied;
          writePendingUpdate(activeStorageKey, applied);
          scheduleRecoveryTimer(applied, applied.deadlineAt - now);
        }
        if (pending.phase === "intent") {
          promotedApps.set(entry.id, pending.appVersion);
        }
        continue;
      }

      if (outcome.olderRead) {
        staleAppIds.add(entry.id);
        if (!currentInMemory && isPendingUpdateApplied(outcome.record)) {
          pendingUpdatesRef.current[entry.id] = outcome.record;
          const remaining = outcome.record.deadlineAt - now;
          if (remaining <= 0) {
            if (!rollingBackAppsRef.current.has(entry.id)) void rollbackRecovery(outcome.record);
          } else if (recoveryTimersRef.current[entry.id] === undefined && !rollingBackAppsRef.current.has(entry.id)) {
            scheduleRecoveryTimer(outcome.record, remaining);
          }
        }
        continue;
      }

      if (!isPendingUpdateApplied(outcome.record)) {
        pendingUpdatesRef.current[entry.id] = outcome.record;
        continue;
      }

      const applied = outcome.record;
      const seen = runtimeReadySeenRef.current[entry.id];
      if (seen && seen.revision === applied.candidateRevision && seen.templateVersion === applied.candidateTemplateVersion) {
        finishPendingRecovery(entry.id);
        continue;
      }
      if (!currentInMemory || currentInMemory.phase === "intent") {
        pendingUpdatesRef.current[entry.id] = applied;
      }
      const remaining = applied.deadlineAt - now;
      if (remaining <= 0) {
        if (!rollingBackAppsRef.current.has(entry.id)) {
          void rollbackRecovery(applied);
        }
      } else if (recoveryTimersRef.current[entry.id] === undefined && !rollingBackAppsRef.current.has(entry.id)) {
        scheduleRecoveryTimer(applied, remaining);
      }
    }

    for (const id of Object.keys(pendingUpdatesRef.current)) {
      if (seenIds.has(id)) continue;
      const pending = pendingUpdatesRef.current[id]!;
      const outcome = reconcilePendingUpdateWithSummary(pending, undefined, now, updatingAppIdRef.current === id);
      if (outcome.action === "clear") {
        finishPendingRecovery(id);
      }
    }

    return { staleAppIds, promotedApps };
  };

  const handleRuntimeReady = (info: { appId: string; revision: number; templateVersion: number }) => {
    runtimeReadySeenRef.current[info.appId] = {
      revision: info.revision,
      templateVersion: info.templateVersion,
    };
    const pending = pendingUpdatesRef.current[info.appId];
    if (!isPendingUpdateApplied(pending)) return;
    if (info.revision === pending.candidateRevision && info.templateVersion === pending.candidateTemplateVersion) {
      finishPendingRecovery(info.appId);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      Object.values(recoveryTimersRef.current).forEach((timer) => clearTimeout(timer));
      recoveryTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    let active = true;
    void api<{ environmentId?: string }>("/.well-known/openmausbot/environment", { timeoutMs: 5_000 }).then((environment) => {
      if (active && typeof environment.environmentId === "string" && environment.environmentId) {
        const nextKey = `omb-mini-app:${environment.environmentId}`;
        setStorageKey(nextKey);
        setBarCollapsed(savedBarCollapsed(nextKey));
      }
    }).catch(() => {}).finally(() => {
      if (active) setEnvironmentResolved(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!environmentResolved || owner !== true || !nativeGuard || !inventory) return;
    const { promotedApps } = reconcileInventory(inventory);
    applyPromotedUiState(promotedApps);
  }, [environmentResolved, storageKey, owner, nativeGuard, inventory]);

  useEffect(() => {
    if (!storageKey || !apps || restored.current) return;
    restored.current = true;
    if (requestedApp && apps.some((app) => app.id === requestedApp.id)) {
      rememberApp(storageKey, requestedApp.id);
      return;
    }
    const saved = savedApp(storageKey);
    if (saved && apps.some((app) => app.id === saved)) setSelectedId(saved);
  }, [storageKey, apps, requestedApp]);

  useEffect(() => {
    if (!requestedApp || !apps?.some((app) => app.id === requestedApp.id) || openedRequest.current === requestedApp.nonce) return;
    openedRequest.current = requestedApp.nonce;
    focusAfter.current = "selected";
    rememberApp(storageKey, requestedApp.id);
    if (requestedApp.id === selectedRef.current) return;
    setSelectedId(requestedApp.id);
    setDocument(null);
    setAppState(null);
    setError("");
    setStale(false);
  }, [requestedApp, apps, storageKey]);

  useEffect(() => {
    if (!visible || !nativeGuard || owner !== true || defaultsStarted.current) return;
    defaultsStarted.current = true;
    let settled = false;
    let active = true;
    setLoading(true);
    void ensureMiniAppDefaults().then((result) => {
      if (!active) return;
      setDefaultIssues(result.issues);
      setDefaultsError("");
      setDefaultsReady(true);
    }).catch((cause: unknown) => {
      if (!active) return;
      setDefaultsError(cause instanceof Error ? cause.message : t("computer.miniApps.loadFailed"));
      setDefaultsReady(true);
    }).finally(() => { settled = true; if (active) setLoading(false); });
    return () => { active = false; if (!settled) defaultsStarted.current = false; };
  }, [visible, nativeGuard, owner]);

  useEffect(() => {
    if (!visible || owner === null || (owner === true && nativeGuard && !defaultsReady)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const sync = async () => {
      const isManualCheck = manualRefreshRef.current;
      const startMutationEpoch = mutationEpochRef.current;
      let readingInventory = true;
      setChecking(true);
      if (!apps) setLoading(true);
      try {
        const inventory = await api<Inventory>("/api/mini-apps", { background: true, signal: controller.signal, timeoutMs: 10_000 });
        if (!active || !Array.isArray(inventory.apps)) return;
        readingInventory = false;
        if (startMutationEpoch !== mutationEpochRef.current) return;
        if (ownerRef.current === true) recoveryAuthBlockedRef.current = false;
        const { staleAppIds, promotedApps } = reconcileInventory(inventory.apps);
        applyPromotedUiState(promotedApps);
        const mergedInventory = staleAppIds.size === 0 || !inventoryRef.current
          ? inventory.apps
          : inventory.apps.map((entry) => {
              if (!staleAppIds.has(entry.id)) return entry;
              const existing = inventoryRef.current?.find((item) => item.id === entry.id);
              return existing && existing.revision > entry.revision ? existing : entry;
            });
        inventoryRef.current = mergedInventory;
        setInventory(mergedInventory);
        const activeApps = mergedInventory.filter((app) => app.status === "active");
        setApps(activeApps);
        const target = selectedRef.current && activeApps.some((app) => app.id === selectedRef.current) ? selectedRef.current
          : activeApps[0]?.id ?? null;
        if (target !== selectedRef.current) {
          if (selectedRef.current) forgetHongguoHome(storageKey, selectedRef.current);
          setSelectedId(target);
          setDocument(null);
          setAppState(null);
          setError("");
          setUpdateCheckError("");
          return;
        }
        if (!target) {
          setDocument(null);
          setAppState(null);
          setStale(false);
          setError("");
          setUpdateCheckError("");
          return;
        }
        if (staleAppIds.has(target)) return;
        const currentDocument = documentRef.current;
        const listed = activeApps.find((app) => app.id === target)!;
        const lostHongguoGrant = currentDocument?.app.nativeIdentity === "hongguo"
          && (listed.nativeIdentity !== "hongguo" || listed.nativeKind !== "hongguo");
        if (lostHongguoGrant) forgetHongguoHome(storageKey, target);
        const grantChanged = (currentDocument?.app.dashboard?.kind ?? null) !== (listed.dashboard?.kind ?? null)
          || (currentDocument?.app.dashboard?.renderer ?? null) !== (listed.dashboard?.renderer ?? null)
          || (currentDocument?.app.dashboardIdentity ?? null) !== (listed.dashboardIdentity ?? null)
          || (currentDocument?.app.nativeKind ?? null) !== (listed.nativeKind ?? null)
          || (currentDocument?.app.nativeIdentity ?? null) !== (listed.nativeIdentity ?? null);
        const clientCache = panelDocCacheRef.current!;
        const cachedDoc = grantChanged ? null : clientCache.getDocument(target, listed.revision, listed.templateVersion);
        const needDocFetch = !cachedDoc && (!currentDocument || currentDocument.app.id !== target
          || currentDocument.app.revision !== listed.revision || currentDocument.app.templateVersion !== listed.templateVersion || grantChanged);
        const statePromise = api<MiniAppState>(`/api/mini-apps/${encodeURIComponent(target)}/state`, { background: true, signal: controller.signal, timeoutMs: 10_000 });
        const docPromise = needDocFetch
          ? api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(target)}`, { background: true, signal: controller.signal, timeoutMs: 10_000 })
          : null;
        const [nextState, fetchedDoc] = await Promise.all([statePromise, docPromise ?? Promise.resolve<MiniAppDocument | null>(null)]);
        if (!active || target !== selectedRef.current || startMutationEpoch !== mutationEpochRef.current) return;
        const pendingForTarget = pendingUpdatesRef.current[target];
        if (isPendingUpdateApplied(pendingForTarget) && nextState.status === "active"
          && nextState.revision < pendingForTarget.candidateRevision) {
          return;
        }
        if (changedState(stateRef.current, nextState) || grantChanged) {
          if (!currentDocument || currentDocument.app.id !== target || currentDocument.app.revision !== nextState.revision
            || currentDocument.app.templateVersion !== nextState.templateVersion || grantChanged) {
            let nextDocument = fetchedDoc && fetchedDoc.app.revision === nextState.revision && fetchedDoc.app.templateVersion === nextState.templateVersion
              ? fetchedDoc
              : cachedDoc && cachedDoc.app.revision === nextState.revision && cachedDoc.app.templateVersion === nextState.templateVersion
                ? cachedDoc
                : null;
            if (!nextDocument) {
              nextDocument = await api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(target)}`, { background: true, signal: controller.signal, timeoutMs: 10_000 });
            }
            if (!active || target !== selectedRef.current || startMutationEpoch !== mutationEpochRef.current) return;
            if (nextDocument.app.revision !== nextState.revision || nextDocument.app.templateVersion !== nextState.templateVersion) throw new Error(t("computer.miniApps.changedDuringRead"));
            clientCache.setDocument(nextDocument);
            const latestPending = pendingUpdatesRef.current[target];
            let promotedDuringDocRead = false;
            if (latestPending) {
              const docOutcome = reconcilePendingUpdateWithSummary(latestPending, nextDocument.app, Date.now(), updatingAppIdRef.current === target);
              if (docOutcome.action === "keep" && docOutcome.olderRead) return;
              if (docOutcome.action === "clear") {
                finishPendingRecovery(target);
              } else if (docOutcome.action === "promote") {
                const applied = docOutcome.record;
                const seen = runtimeReadySeenRef.current[target];
                if (seen && seen.revision === applied.candidateRevision && seen.templateVersion === applied.candidateTemplateVersion) {
                  finishPendingRecovery(target);
                } else {
                  pendingUpdatesRef.current[target] = applied;
                  writePendingUpdate(storageKeyRef.current, applied);
                  scheduleRecoveryTimer(applied, applied.deadlineAt - Date.now());
                }
                if (latestPending.phase === "intent") {
                  promotedDuringDocRead = true;
                  applyPromotedUiState(new Map([[target, latestPending.appVersion]]));
                }
              }
            }
            if (lostHongguoGrant || currentDocument?.app.nativeIdentity === "hongguo"
              && (nextDocument.app.nativeIdentity !== "hongguo" || nextDocument.app.nativeKind !== "hongguo")) forgetHongguoHome(storageKey, target);
            if (promotedApps.has(target) || promotedDuringDocRead) {
              setFrameEpochByApp((prev) => ({ ...prev, [target]: (prev[target] ?? 0) + 1 }));
            }
            documentRef.current = nextDocument;
            setDocument(nextDocument);
          }
          stateRef.current = nextState;
          setAppState(nextState);
        }
        setStale(false);
        setError("");
        const prevCheck = updateCheckedAtRef.current[target];
        const checkDue = shouldCheckMiniAppUpdate(prevCheck?.revision === listed.revision ? prevCheck.at : undefined, Date.now(), isManualCheck);
        if (owner === true && nativeGuard && listed.status === "active" && checkDue) {
          const checkSeq = ++updateCheckSeqRef.current;
          try {
            const rawUpdate = await api<unknown>(`/api/mini-apps/${encodeURIComponent(target)}/update`, {
              background: true, signal: controller.signal, timeoutMs: RELEASE_REQUEST_TIMEOUT_MS,
            });
            if (!active || controller.signal.aborted || target !== selectedRef.current || checkSeq !== updateCheckSeqRef.current) return;
            const parsed = parseMiniAppUpdateInfo(rawUpdate);
            if (!parsed) throw new Error(t("computer.miniApps.update.checkFailed"));
            updateCheckedAtRef.current[target] = { at: Date.now(), revision: listed.revision };
            setUpdateByApp((prev) => ({ ...prev, [target]: parsed }));
            if (parsed.status !== "available") {
              setToast((prev) => prev?.appId === target ? null : prev);
              setUpdateError("");
            }
            if (parsed.status === "unavailable") {
              setUpdateCheckError(isManualCheck ? t("computer.miniApps.update.unavailable") : "");
            } else {
              setUpdateCheckError("");
            }
          } catch (updateCause) {
            if (!active || controller.signal.aborted || target !== selectedRef.current) return;
            if (isManualCheck) {
              setUpdateCheckError(updateCause instanceof Error && updateCause.message
                ? updateCause.message
                : t("computer.miniApps.update.checkFailed"));
            }
          }
        }
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
          panelDocCacheRef.current?.clear();
          clearMiniAppClientCache(storageKey);
          pauseRecovery();
          forgetHongguoHome(storageKey, readingInventory ? undefined : selectedRef.current ?? undefined);
          documentRef.current = null;
          stateRef.current = null;
          setDocument(null);
          setAppState(null);
          setToast(null);
          setError(t("computer.miniApps.accessEnded"));
        } else {
          setStale(Boolean(documentRef.current));
          setError(cause instanceof Error ? cause.message : t("computer.miniApps.loadFailed"));
        }
      } finally {
        if (!controller.signal.aborted) manualRefreshRef.current = false;
        if (active) {
          setChecking(false);
          setLoading(false);
          timer = setTimeout(sync, REFRESH_MS);
        }
      }
    };
    void sync();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [selectedId, refreshKey, visible, owner, nativeGuard, defaultsReady, storageKey]);

  useMiniAppLiveSync({
    enabled: Boolean(visible && owner === true && nativeGuard && defaultsReady),
    onAppChanged: (event) => { delete updateCheckedAtRef.current[event.appId]; setRefreshKey((current) => current + 1); },
    onDataChanged: (event) => {
      const next = applyMiniAppDataChanged(stateRef.current, event.datasetId, event.revision);
      if (!next) return;
      stateRef.current = next;
      setAppState(next);
    },
    onMissed: () => { setRefreshKey((current) => current + 1); },
  });

  useEffect(() => {
    if (!environmentResolved || owner !== true || !nativeGuard || !selected || selected.status !== "active"
      || document?.app.id !== selected.id) {
      setToast(null);
      return;
    }
    const info = updateByApp[selected.id];
    if (!info || info.status !== "available" || !info.available) {
      setToast((prev) => prev?.appId === selected.id ? null : prev);
      return;
    }
    const candidate = info.available;
    if (!hasAnnouncedUpdateVersion(storageKey, selected.id, candidate.appVersion)) {
      rememberAnnouncedUpdateVersion(storageKey, selected.id, candidate.appVersion);
      setUpdateError("");
      setToast({ appId: selected.id, appVersion: candidate.appVersion, sourceCommit: candidate.sourceCommit });
      return;
    }
    setToast((prev) => prev && (prev.appId !== selected.id || prev.appVersion !== candidate.appVersion) ? null : prev);
  }, [environmentResolved, storageKey, owner, nativeGuard, selected?.id, selected?.status, document?.app.id, updateByApp]);

  const choose = (id: string) => {
    rememberApp(storageKey, id);
    if (id === selectedRef.current) return;
    delete updateCheckedAtRef.current[id];
    setSelectedId(id);
    setDocument(null);
    setAppState(null);
    setError("");
    setStale(false);
    setUpdateError("");
    setUpdateCheckError("");
    setToast(null);
  };

  const addDefault = async (kind: DefaultMiniAppKind) => {
    if (owner !== true || !nativeGuard || busyKind) return;
    setBusyKind(kind);
    setError("");
    try {
      const result = await api<MiniAppDefaultsResult>("/api/mini-apps/defaults", {
        method: "POST", body: JSON.stringify({ bookkeepingHtml, agentTeamHtml, restore: kind }), timeoutMs: 30_000,
      });
      mutationEpochRef.current += 1;
      setDefaultIssues(result.issues);
      setInventory(result.apps);
      setApps(result.apps.filter((app) => app.status === "active"));
      const issue = result.issues.find((entry) => entry.kind === kind);
      const target = result.apps.find((app) => iconKindForApp(app) === kind && app.status === "active");
      if (issue) setError(issue.error);
      else if (target && (kind === "hongguo" ? target.nativeKind === "hongguo"
        : kind !== "agent-team" && kind !== "usage" || target.dashboard?.kind === kind)) {
        setLibraryOpen(false);
        focusAfter.current = "selected";
        choose(target.id);
      } else setError(t("computer.miniApps.loadFailed"));
      setRefreshKey((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("computer.miniApps.loadFailed"));
    } finally { setBusyKind(null); }
  };

  const removeDefault = async (app: MiniAppSummary) => {
    const kind = iconKindForApp(app);
    if (!kind || owner !== true || !nativeGuard || busyKind || updatingAppId !== null || app.status !== "active") return;
    setBusyKind(kind);
    setError("");
    try {
      const body: MiniAppArchive = { requestKey: randomUuid(), expectedRevision: app.revision };
      const result = await api<MiniAppMutationResult>(`/api/mini-apps/${encodeURIComponent(app.id)}/archive`, {
        method: "POST", body: JSON.stringify(body), timeoutMs: 20_000,
      });
      if (result.app.id !== app.id || result.app.status !== "archived") throw new Error(t("computer.miniApps.changedDuringRead"));
      mutationEpochRef.current += 1;
      if (kind === "hongguo") forgetHongguoHome(storageKey, app.id);
      finishPendingRecovery(app.id);
      setRollbackNotice((prev) => prev?.appId === app.id ? null : prev);
      setToast((prev) => prev?.appId === app.id ? null : prev);
      setInventory((current) => current?.map((entry) => entry.id === app.id ? result.app : entry) ?? null);
      setApps((current) => current?.filter((entry) => entry.id !== app.id) ?? null);
      if (selectedRef.current === app.id) {
        setSelectedId(null);
        setDocument(null);
        setAppState(null);
      }
      setRefreshKey((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("computer.miniApps.loadFailed"));
    } finally { setBusyKind(null); }
  };

  const performUpdate = async (targetApp: MiniAppSummary, candidate: MiniAppUpdateCandidate, source: "toast" | "library") => {
    if (owner !== true || !nativeGuard || updatingAppId !== null || busyKind !== null || targetApp.status !== "active") return;
    if (isPendingUpdateApplied(pendingUpdatesRef.current[targetApp.id])) return;
    const previousTemplateVersion = targetApp.templateVersion;
    const capturedStorageKey = storageKeyRef.current;
    const targetPackageId = readAppPackageId(targetApp);
    setUpdateSource(source);
    setUpdateError("");
    setUpdateCheckError("");
    setRollbackNotice((prev) => prev?.appId === targetApp.id ? null : prev);

    const existingPending = pendingUpdatesRef.current[targetApp.id]
      ?? (environmentResolvedRef.current ? readPendingUpdate(capturedStorageKey, targetApp.id) : null);
    const matchingIntent = existingPending?.phase === "intent"
      && existingPending.expectedRevision === targetApp.revision
      && existingPending.previousTemplateVersion === previousTemplateVersion
      && existingPending.appVersion === candidate.appVersion
      && existingPending.sourceCommit === candidate.sourceCommit
      && existingPending.packageId === targetPackageId
      ? existingPending
      : null;

    const intent: PendingMiniAppUpdateIntent = matchingIntent ?? {
      phase: "intent",
      appId: targetApp.id,
      expectedRevision: targetApp.revision,
      previousTemplateVersion,
      packageId: targetPackageId,
      appVersion: candidate.appVersion,
      sourceCommit: candidate.sourceCommit,
      requestKey: randomUuid(),
      rollbackRequestKey: randomUuid(),
      createdAt: Date.now(),
    };
    if (!capturedStorageKey || (existingPending && !matchingIntent) || !writePendingUpdate(capturedStorageKey, intent)) {
      setUpdateError(t("computer.miniApps.update.recoveryUnavailable"));
      return;
    }
    setUpdatingAppId(targetApp.id);
    updatingAppIdRef.current = targetApp.id;
    delete runtimeReadySeenRef.current[targetApp.id];
    pendingUpdatesRef.current[targetApp.id] = intent;

    const body: MiniAppUpdateRequest = {
      appVersion: candidate.appVersion,
      sourceCommit: candidate.sourceCommit,
      expectedRevision: targetApp.revision,
      requestKey: intent.requestKey,
    };
    try {
      const result = await api<MiniAppMutationResult>(`/api/mini-apps/${encodeURIComponent(targetApp.id)}/update`, {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: RELEASE_REQUEST_TIMEOUT_MS,
      });
      if (!result?.app || !matchesAppliedUpdateIntent(result.app, intent)
        || !Number.isSafeInteger(result.app.templateVersion)) {
        throw new Error(t("computer.miniApps.changedDuringRead"));
      }
      const existingApplied = pendingUpdatesRef.current[targetApp.id];
      const alreadyReady = runtimeReadySeenRef.current[targetApp.id];
      const recovery: PendingMiniAppUpdateRecovery | null = result.app.status === "active"
        && result.app.templateVersion !== previousTemplateVersion
        && Boolean((result.app as { release?: unknown }).release)
        && !(alreadyReady && alreadyReady.revision === result.app.revision && alreadyReady.templateVersion === result.app.templateVersion)
        ? (isPendingUpdateApplied(existingApplied)
          && existingApplied.candidateRevision === result.app.revision
          && existingApplied.candidateTemplateVersion === result.app.templateVersion
          ? existingApplied
          : {
              phase: "applied",
              appId: targetApp.id,
              previousTemplateVersion,
              candidateRevision: result.app.revision,
              candidateTemplateVersion: result.app.templateVersion,
              rollbackRequestKey: intent.rollbackRequestKey,
              deadlineAt: Date.now() + MINI_APP_RUNTIME_READY_TIMEOUT_MS,
            })
        : null;
      if (recovery) writePendingUpdate(capturedStorageKey, recovery);
      else clearPendingUpdateRecovery(capturedStorageKey, targetApp.id);
      if (!mountedRef.current) return;
      mutationEpochRef.current += 1;
      updateCheckSeqRef.current += 1;
      if (recovery) {
        pendingUpdatesRef.current[recovery.appId] = recovery;
        scheduleRecoveryTimer(recovery, recovery.deadlineAt - Date.now());
      } else {
        finishPendingRecovery(targetApp.id);
      }
      setUpdateByApp((prev) => ({
        ...prev,
        [targetApp.id]: { installedVersion: candidate.appVersion, status: "current", available: null },
      }));
      setToast((prev) => prev?.appId === targetApp.id ? null : prev);
      setUpdateError("");
      updateInventoryEntry(result.app);
      if (source === "library") {
        setLibraryOpen(false);
        focusAfter.current = "selected";
      }
      if (selectedRef.current === targetApp.id) {
        try {
          const nextState = await api<MiniAppState>(`/api/mini-apps/${encodeURIComponent(targetApp.id)}/state`, { timeoutMs: 10_000 });
          if (!mountedRef.current || selectedRef.current !== targetApp.id) return;
          const nextDocument = await api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(targetApp.id)}`, { timeoutMs: 10_000 });
          if (!mountedRef.current || selectedRef.current !== targetApp.id) return;
          if (nextDocument.app.id !== targetApp.id || nextDocument.app.revision !== nextState.revision
            || nextDocument.app.templateVersion !== nextState.templateVersion) {
            throw new Error(t("computer.miniApps.changedDuringRead"));
          }
          if (recovery && (nextDocument.app.revision !== recovery.candidateRevision
            || nextDocument.app.templateVersion !== recovery.candidateTemplateVersion)) {
            finishPendingRecovery(targetApp.id);
          }
          updateInventoryEntry(nextDocument.app);
          setFrameEpochByApp((prev) => ({ ...prev, [targetApp.id]: (prev[targetApp.id] ?? 0) + 1 }));
          documentRef.current = nextDocument;
          setDocument(nextDocument);
          stateRef.current = nextState;
          setAppState(nextState);
          setStale(false);
          setError("");
        } catch (reloadCause) {
          if (!mountedRef.current || selectedRef.current !== targetApp.id) return;
          setStale(Boolean(documentRef.current));
          setError(reloadCause instanceof Error ? reloadCause.message : t("computer.miniApps.loadFailed"));
          setRefreshKey((current) => current + 1);
        }
      }
    } catch (cause) {
      if (!mountedRef.current) return;
      setUpdateError(cause instanceof Error && cause.message ? cause.message : t("computer.miniApps.update.failed"));
      if (cause instanceof ApiError && cause.status === 401) pauseRecovery();
      if (cause instanceof ApiError && (cause.status === 400 || cause.status === 403 || cause.status === 404
        || cause.status === 409 || cause.status === 413 || cause.status === 422)) {
        finishPendingRecovery(targetApp.id);
        if (cause.status === 409) {
          setRefreshKey((current) => current + 1);
        }
      }
    } finally {
      if (mountedRef.current) {
        updatingAppIdRef.current = null;
        setUpdatingAppId(null);
      }
    }
  };

  const dismissToast = () => {
    setToast(null);
    setUpdateError("");
    const tab = [...panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []]
      .find((entry) => entry.dataset.appId === selectedRef.current);
    const fallback = panelRef.current?.querySelector<HTMLButtonElement>("[data-mini-app-collapsed-current], [data-mini-app-all]");
    (tab ?? fallback)?.focus();
  };

  const installed = (id: string) => {
    focusAfter.current = "selected";
    choose(id);
    setLibraryOpen(false);
    setRefreshKey((current) => current + 1);
  };


  const revoked = () => {
    panelDocCacheRef.current?.clear(); clearMiniAppClientCache(storageKey);
    documentRef.current = null; stateRef.current = null; setDocument(null); setAppState(null);
    setError(t("computer.miniApps.accessEnded"));
  };
  const changed = () => {
    documentRef.current = null; stateRef.current = null; setDocument(null); setAppState(null);
    setRefreshKey((current) => current + 1);
  };

  const toggleBar = () => { setBarCollapsed((current) => { const next = !current; rememberBarCollapsed(storageKey, next); return next; }); };

  const reorderApps = (orderedIds: string[]) => {
    if (!apps || owner !== true) return;
    setApps((c) => (c ? applyMiniAppOrder(c, orderedIds) : c));
    setInventory((c) => (inventoryRef.current = c ? applyMiniAppOrder(c, orderedIds) : c));
    void api<Inventory>("/api/mini-apps/order", { method: "PUT", body: JSON.stringify({ appIds: orderedIds }), timeoutMs: 10_000 })
      .then((res) => { if (!mountedRef.current || !Array.isArray(res?.apps)) return; inventoryRef.current = res.apps; setInventory(res.apps); setApps(res.apps.filter((e) => e.status === "active")); })
      .catch(() => { if (mountedRef.current) setRefreshKey((c) => c + 1); });
  };

  const libraryPopover = (
    <MiniAppLibraryPopover open={libraryOpen} inventory={inventory ?? []} issues={defaultIssues} busyKind={busyKind}
      focusKind={libraryFocus} owner={owner} nativeGuard={nativeGuard}
      selectedId={selectedId} selectedUpdate={selectedUpdate} updatingAppId={updatingAppId} updateError={updateError}
      restoreFocusOnError={updateSource === "library"}
      onToggle={() => { setLibraryFocus(null); setLibraryOpen((current) => !current); }} onClose={() => setLibraryOpen(false)}
      onOpen={installed} onAdd={(kind) => void addDefault(kind)} onRemove={(app) => void removeDefault(app)}
      onUpdate={(app, candidate) => void performUpdate(app, candidate, "library")} />
  );

  return (
    <div ref={panelRef} className="@container/mini-apps flex min-h-0 min-w-0 flex-1 flex-col" data-testid="mini-apps-panel">
      <MiniAppsHeader apps={apps} selected={selected} selectedId={selectedId} selectedUpdate={selectedUpdate} barCollapsed={barCollapsed}
        archivedKind={archivedKind} actionsBusy={busyKind !== null || updatingAppId !== null} checking={checking} canRestore={Boolean(previousReleaseTemplate)}
        canReorder={owner === true} libraryPopover={libraryPopover} tabListRef={tabListRef} choose={choose} toggleBar={toggleBar} onReorder={reorderApps}
        onAddArchived={() => { setLibraryFocus(archivedKind); setLibraryOpen(true); }} onRestorePrevious={() => void restorePreviousRelease()}
        onRefresh={() => { manualRefreshRef.current = true; setRollbackNotice(null); setRefreshKey((current) => current + 1); }} />
      <>
        {defaultsError && <p role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{defaultsError}</p>}
        {stale && <p role="status" className="mx-4 mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.miniApps.stale")}</p>}
        {error && <p role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
        {updateCheckError && <p role="alert" data-mini-app-update-check-error className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{updateCheckError}</p>}
        {rollbackNotice && selected?.id === rollbackNotice.appId && <p role="alert" data-mini-app-update-rolled-back className="mx-4 mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{rollbackNotice.message}</p>}
        {toast && selected && toast.appId === selected.id && selectedUpdate?.status === "available" && selectedUpdate.available && (
          <MiniAppUpdateToast appName={miniAppDisplayName(selected)} version={toast.appVersion} updating={updatingAppId === selected.id}
            error={updateError} restoreFocusOnError={updateSource === "toast"}
            onUpdate={() => void performUpdate(selected, selectedUpdate.available!, "toast")} onDismiss={dismissToast} />
        )}
        {loading && apps === null && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.loading")}</p>}
        {selected && <MiniAppContent selected={selected} document={document} appState={appState} owner={owner} nativeGuard={nativeGuard}
          currentHead={currentHead} stale={stale} storageKey={storageKey} frameEpoch={document ? frameEpochByApp[document.app.id] ?? 0 : 0}
          refreshKey={refreshKey} error={error} addDefault={addDefault} revoked={revoked} changed={changed} handleRuntimeReady={handleRuntimeReady} />}
      </>
    </div>
  );
}
