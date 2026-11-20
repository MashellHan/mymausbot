import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, Loader2, RotateCw } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { randomUuid } from "@/lib/random-uuid";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, ApiError } from "@/state/store";
import type { DefaultMiniAppKind, MiniAppArchive, MiniAppDefaultsResult, MiniAppDocument,
  MiniAppMutationResult, MiniAppRollback, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import bookkeepingHtml from "../../../examples/mini-apps/bookkeeping/index.html?raw";
import agentTeamHtml from "../../../examples/mini-apps/agent-team/index.html?raw";
import { revealSelectedTab, scrollTabsWithWheel } from "../computer-panel-tabs";
import { InfoHint } from "../InfoHint";
import { MiniAppDashboard } from "./MiniAppDashboard";
import { DailyXWholePage } from "./DailyXWholePage";
import { GitHubActivityWholePage } from "./GitHubActivityWholePage";
import { ensureMiniAppDefaults } from "./MiniAppDefaultsBootstrap";
import { MiniAppFrame } from "./MiniAppFrame";
import { MiniAppIcon, iconKindForApp } from "./MiniAppIcon";
import { MiniAppLibraryPopover } from "./MiniAppLibraryPopover";
import { MiniAppUpdateToast } from "./MiniAppUpdateToast";
import { MojoWholePage } from "./MojoWholePage";
import { HongguoView, forgetHongguoHome } from "./HongguoView";
import { miniAppDisplayDescription, miniAppDisplayName } from "./mini-app-display";
import {
  MINI_APP_RUNTIME_READY_TIMEOUT_MS,
  clearPendingUpdateRecovery,
  hasAnnouncedUpdateVersion,
  parseMiniAppUpdateInfo,
  readAppReleaseMeta,
  readPendingUpdateRecovery,
  rememberAnnouncedUpdateVersion,
  shortCommit,
  writePendingUpdateRecovery,
  type MiniAppUpdateCandidate,
  type MiniAppUpdateInfo,
  type MiniAppUpdateRequest,
  type PendingMiniAppUpdateRecovery,
} from "./mini-app-update";
import { hongguoText } from "./hongguo-copy";
import { miniAppNativeFrameGuard } from "./native-frame-guard";
import { mojoHostEligible } from "./mojo-host";
import { dailyXHostEligible } from "./daily-x-host";
import { githubActivityHostEligible } from "./github-activity-host";
import { isManagedHongguoDocument } from "./hongguo-frame-host";
import { managedMiniAppSite } from "./mini-app-site";

const REFRESH_MS = 15_000;
const ROLLBACK_RETRY_MS = 5_000;
const DEFAULT_BAR_COLLAPSED_KEY = "omb-mini-apps-bar-collapsed";
type Inventory = { apps: MiniAppSummary[] };

function savedApp(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function rememberApp(key: string | null, id: string): void {
  if (!key) return;
  try { localStorage.setItem(key, id); } catch {}
}

function barKey(storageKey: string | null): string {
  return storageKey ? `${storageKey}:bar-collapsed` : DEFAULT_BAR_COLLAPSED_KEY;
}

function savedBarCollapsed(storageKey: string | null): boolean {
  try {
    const scoped = storageKey ? localStorage.getItem(barKey(storageKey)) : null;
    const raw = scoped ?? localStorage.getItem(DEFAULT_BAR_COLLAPSED_KEY);
    return raw === "1" || raw === "true";
  } catch {
    return false;
  }
}

function rememberBarCollapsed(storageKey: string | null, collapsed: boolean): void {
  const value = collapsed ? "1" : "0";
  try {
    localStorage.setItem(DEFAULT_BAR_COLLAPSED_KEY, value);
    if (storageKey) localStorage.setItem(barKey(storageKey), value);
  } catch {}
}

function stamp(value: number): string {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(activeLocale()) : t("computer.miniApps.timeUnavailable");
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
  const selectedRef = useRef(selectedId);
  const storageKeyRef = useRef(storageKey);
  const ownerRef = useRef(owner);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const defaultsStarted = useRef(false);
  const restored = useRef(false);
  const openedRequest = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const manualRefreshRef = useRef(false);
  const updateCheckSeqRef = useRef(0);
  const requestKeyRef = useRef<{ signature: string; key: string } | null>(null);
  const pendingRecoveriesRef = useRef<Record<string, PendingMiniAppUpdateRecovery>>({});
  const recoveryTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const rollingBackAppsRef = useRef(new Set<string>());
  const runtimeReadySeenRef = useRef<Record<string, { revision: number; templateVersion: number }>>({});
  documentRef.current = document;
  stateRef.current = appState;
  selectedRef.current = selectedId;
  storageKeyRef.current = storageKey;
  ownerRef.current = owner;
  const selected = apps?.find((app) => app.id === selectedId) ?? null;
  const selectedUpdate = selected ? (updateByApp[selected.id] ?? null) : null;
  const dashboard = document?.app.dashboard;
  const currentHead = !!document && !!appState && !!selected && document.app.status === "active" && appState.status === "active"
    && appState.appId === document.app.id && appState.revision === document.app.revision
    && selected.id === document.app.id && selected.revision === document.app.revision
    && selected.templateVersion === document.app.templateVersion && appState.templateVersion === document.app.templateVersion;
  const dashboardCurrent = currentHead && !!selected && !!dashboard && owner === true && nativeGuard
    && selected.dashboard?.kind === dashboard.kind && dashboard.renderer === "native" && dashboard.htmlRole === "fallback-only";
  const teamHtmlCurrent = currentHead && owner === true && nativeGuard && selected?.dashboard?.kind === "agent-team"
    && selected.dashboard.renderer === "html" && document?.app.dashboard?.kind === "agent-team"
    && document.app.dashboard.renderer === "html" && document.app.dashboardIdentity === "agent-team";
  const usageHtmlCurrent = currentHead && owner === true && nativeGuard && window.ogb?.app?.ownPage === true
    && window.ogb?.remoteClient?.active !== true && selected?.dashboardIdentity === "usage"
    && selected.dashboard?.kind === "usage" && selected.dashboard.renderer === "html"
    && document?.app.dashboardIdentity === "usage" && dashboard?.kind === "usage" && dashboard.renderer === "html"
    && document.bindings.length === 0 && appState.data.length === 0;
  const recoveryKind = currentHead && selected && document && !dashboard && !selected.dashboard && selected.dashboardIdentity
    && document.app.dashboardIdentity === selected.dashboardIdentity ? selected.dashboardIdentity : null;
  const dashboardInstalled = !!(selected?.dashboardIdentity || document?.app.dashboardIdentity || selected?.dashboard || dashboard);
  const nativeInstalled = !!(selected?.nativeIdentity || document?.app.nativeIdentity || selected?.nativeKind || document?.app.nativeKind);
  const hongguoCurrent = currentHead && owner === true && selected?.nativeIdentity === "hongguo" && document?.app.nativeIdentity === "hongguo"
    && selected?.nativeKind === "hongguo" && document?.app.nativeKind === "hongguo";
  const managedScope = !stale && currentHead && owner === true && nativeGuard && window.ogb?.app?.ownPage === true
    && window.ogb?.remoteClient?.active !== true;
  const managedSite = managedScope ? managedMiniAppSite(document) : undefined;
  const managedHongguo = managedScope && hongguoCurrent && isManagedHongguoDocument(document);
  const hongguoRecovery = currentHead && owner === true && selected?.nativeIdentity === "hongguo" && document?.app.nativeIdentity === "hongguo"
    && !selected?.nativeKind && !document?.app.nativeKind;
  const mojoCurrent = !stale && mojoHostEligible({ selected, document, state: appState,
    localOwner: owner === true && typeof window !== "undefined" && window.ogb?.remoteClient?.active !== true, nativeGuard });
  const dailyXCurrent = !stale && dailyXHostEligible({ selected, document, state: appState,
    localOwner: owner === true && typeof window !== "undefined" && window.ogb?.app?.ownPage === true
      && window.ogb?.remoteClient?.active !== true, nativeGuard });
  const githubActivityCurrent = !stale && githubActivityHostEligible({ selected, document, state: appState,
    localOwner: owner === true && typeof window !== "undefined" && window.ogb?.app?.ownPage === true
      && window.ogb?.remoteClient?.active !== true, nativeGuard });

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
    delete pendingRecoveriesRef.current[appId];
    clearPendingUpdateRecovery(storageKeyRef.current, appId);
    if (storageKeyRef.current !== null) {
      clearPendingUpdateRecovery(null, appId);
    }
  };

  const scheduleRecoveryTimer = (recovery: PendingMiniAppUpdateRecovery, delayMs: number) => {
    clearRecoveryTimer(recovery.appId);
    recoveryTimersRef.current[recovery.appId] = setTimeout(() => {
      delete recoveryTimersRef.current[recovery.appId];
      void rollbackRecovery(recovery);
    }, Math.max(0, delayMs));
  };

  const rollbackRecovery = async (recovery: PendingMiniAppUpdateRecovery) => {
    if (!mountedRef.current || ownerRef.current !== true || !nativeGuard) return;
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
      finishPendingRecovery(recovery.appId);
      updateCheckSeqRef.current += 1;
      setInventory((current) => current?.map((entry) => entry.id === recovery.appId ? result.app : entry) ?? null);
      setApps((current) => {
        if (!current) return null;
        const mapped = current.map((entry) => entry.id === recovery.appId ? result.app : entry);
        return mapped.filter((entry) => entry.status === "active");
      });
      setRollbackNotice({ appId: recovery.appId, message: t("computer.miniApps.update.rolledBack") });
      if (selectedRef.current === recovery.appId) {
        try {
          const nextState = await api<MiniAppState>(`/api/mini-apps/${encodeURIComponent(recovery.appId)}/state`, { timeoutMs: 10_000 });
          if (!mountedRef.current) return;
          const nextDocument = await api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(recovery.appId)}`, { timeoutMs: 10_000 });
          if (!mountedRef.current) return;
          if (selectedRef.current === recovery.appId
            && nextDocument.app.id === recovery.appId
            && nextDocument.app.revision === nextState.revision
            && nextDocument.app.templateVersion === nextState.templateVersion) {
            setInventory((current) => current?.map((entry) => entry.id === recovery.appId ? nextDocument.app : entry) ?? null);
            setApps((current) => {
              if (!current) return null;
              const mapped = current.map((entry) => entry.id === recovery.appId ? nextDocument.app : entry);
              return mapped.filter((entry) => entry.status === "active");
            });
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
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 400 || cause.status === 403 || cause.status === 404)) {
        finishPendingRecovery(recovery.appId);
        setRefreshKey((current) => current + 1);
      } else if (pendingRecoveriesRef.current[recovery.appId]?.rollbackRequestKey === recovery.rollbackRequestKey) {
        scheduleRecoveryTimer(recovery, ROLLBACK_RETRY_MS);
      }
    } finally {
      rollingBackAppsRef.current.delete(recovery.appId);
    }
  };

  const handleRuntimeReady = (info: { appId: string; revision: number; templateVersion: number }) => {
    runtimeReadySeenRef.current[info.appId] = {
      revision: info.revision,
      templateVersion: info.templateVersion,
    };
    const pending = pendingRecoveriesRef.current[info.appId];
    if (!pending) return;
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
    for (const activeRecovery of Object.values(pendingRecoveriesRef.current)) {
      writePendingUpdateRecovery(storageKey, activeRecovery);
    }
    for (const entry of inventory) {
      const recovery = pendingRecoveriesRef.current[entry.id] ?? readPendingUpdateRecovery(storageKey, entry.id);
      if (!recovery) continue;
      if (entry.status !== "active"
        || entry.revision !== recovery.candidateRevision
        || entry.templateVersion !== recovery.candidateTemplateVersion) {
        finishPendingRecovery(entry.id);
        continue;
      }
      const seen = runtimeReadySeenRef.current[entry.id];
      if (seen && seen.revision === recovery.candidateRevision && seen.templateVersion === recovery.candidateTemplateVersion) {
        finishPendingRecovery(entry.id);
        continue;
      }
      if (!pendingRecoveriesRef.current[entry.id]) {
        pendingRecoveriesRef.current[entry.id] = recovery;
        const remaining = recovery.deadlineAt - Date.now();
        if (remaining <= 0) {
          void rollbackRecovery(recovery);
        } else {
          scheduleRecoveryTimer(recovery, remaining);
        }
      }
    }
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
      let readingInventory = true;
      setChecking(true);
      if (!apps) setLoading(true);
      try {
        const inventory = await api<Inventory>("/api/mini-apps", { background: true, signal: controller.signal, timeoutMs: 10_000 });
        if (!active || !Array.isArray(inventory.apps)) return;
        readingInventory = false;
        setInventory(inventory.apps);
        for (const [id, recovery] of Object.entries(pendingRecoveriesRef.current)) {
          const entry = inventory.apps.find((item) => item.id === id);
          if (!entry || entry.status !== "active"
            || entry.revision !== recovery.candidateRevision
            || entry.templateVersion !== recovery.candidateTemplateVersion) {
            finishPendingRecovery(id);
          } else if (Date.now() >= recovery.deadlineAt && !rollingBackAppsRef.current.has(id)) {
            void rollbackRecovery(recovery);
          }
        }
        const activeApps = inventory.apps.filter((app) => app.status === "active");
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
        const currentDocument = documentRef.current;
        const listed = activeApps.find((app) => app.id === target)!;
        const lostHongguoGrant = currentDocument?.app.nativeIdentity === "hongguo"
          && (listed.nativeIdentity !== "hongguo" || listed.nativeKind !== "hongguo");
        if (lostHongguoGrant) forgetHongguoHome(storageKey, target);
        const nextState = await api<MiniAppState>(`/api/mini-apps/${encodeURIComponent(target)}/state`, { background: true, signal: controller.signal, timeoutMs: 10_000 });
        if (!active || target !== selectedRef.current) return;
        const grantChanged = (currentDocument?.app.dashboard?.kind ?? null) !== (listed.dashboard?.kind ?? null)
          || (currentDocument?.app.dashboard?.renderer ?? null) !== (listed.dashboard?.renderer ?? null)
          || (currentDocument?.app.dashboardIdentity ?? null) !== (listed.dashboardIdentity ?? null)
          || (currentDocument?.app.nativeKind ?? null) !== (listed.nativeKind ?? null)
          || (currentDocument?.app.nativeIdentity ?? null) !== (listed.nativeIdentity ?? null);
        if (changedState(stateRef.current, nextState) || grantChanged) {
          if (!currentDocument || currentDocument.app.id !== target || currentDocument.app.revision !== nextState.revision
            || currentDocument.app.templateVersion !== nextState.templateVersion || grantChanged) {
            const nextDocument = await api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(target)}`, { background: true, signal: controller.signal, timeoutMs: 10_000 });
            if (!active || target !== selectedRef.current) return;
            if (nextDocument.app.revision !== nextState.revision || nextDocument.app.templateVersion !== nextState.templateVersion) throw new Error(t("computer.miniApps.changedDuringRead"));
            if (lostHongguoGrant || currentDocument?.app.nativeIdentity === "hongguo"
              && (nextDocument.app.nativeIdentity !== "hongguo" || nextDocument.app.nativeKind !== "hongguo")) forgetHongguoHome(storageKey, target);
            documentRef.current = nextDocument;
            setDocument(nextDocument);
          }
          stateRef.current = nextState;
          setAppState(nextState);
        }
        setStale(false);
        setError("");
        if (owner === true && nativeGuard && listed.status === "active") {
          const checkSeq = ++updateCheckSeqRef.current;
          try {
            const rawUpdate = await api<unknown>(`/api/mini-apps/${encodeURIComponent(target)}/update`, {
              background: true, signal: controller.signal, timeoutMs: 10_000,
            });
            if (!active || controller.signal.aborted || target !== selectedRef.current || checkSeq !== updateCheckSeqRef.current) return;
            const parsed = parseMiniAppUpdateInfo(rawUpdate);
            if (!parsed) throw new Error(t("computer.miniApps.update.checkFailed"));
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
    if (pendingRecoveriesRef.current[targetApp.id]) return;
    const previousTemplateVersion = targetApp.templateVersion;
    const capturedStorageKey = storageKeyRef.current;
    setUpdatingAppId(targetApp.id);
    setUpdateSource(source);
    setUpdateError("");
    setUpdateCheckError("");
    setRollbackNotice((prev) => prev?.appId === targetApp.id ? null : prev);
    const signature = `${targetApp.id}:${candidate.appVersion}:${candidate.sourceCommit}:${targetApp.revision}`;
    if (!requestKeyRef.current || requestKeyRef.current.signature !== signature) {
      requestKeyRef.current = { signature, key: randomUuid() };
    }
    const body: MiniAppUpdateRequest = {
      appVersion: candidate.appVersion,
      sourceCommit: candidate.sourceCommit,
      expectedRevision: targetApp.revision,
      requestKey: requestKeyRef.current.key,
    };
    try {
      const result = await api<MiniAppMutationResult>(`/api/mini-apps/${encodeURIComponent(targetApp.id)}/update`, {
        method: "POST",
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      });
      if (!result?.app || result.app.id !== targetApp.id
        || !Number.isSafeInteger(result.app.revision)
        || !Number.isSafeInteger(result.app.templateVersion)) {
        throw new Error(t("computer.miniApps.changedDuringRead"));
      }
      const recovery: PendingMiniAppUpdateRecovery | null = result.app.status === "active"
        && result.app.templateVersion !== previousTemplateVersion
        && Boolean((result.app as { release?: unknown }).release)
        ? {
            appId: targetApp.id,
            previousTemplateVersion,
            candidateRevision: result.app.revision,
            candidateTemplateVersion: result.app.templateVersion,
            rollbackRequestKey: randomUuid(),
            deadlineAt: Date.now() + MINI_APP_RUNTIME_READY_TIMEOUT_MS,
          }
        : null;
      if (recovery) {
        writePendingUpdateRecovery(capturedStorageKey ?? storageKeyRef.current, recovery);
      }
      if (!mountedRef.current) return;
      requestKeyRef.current = null;
      updateCheckSeqRef.current += 1;
      if (recovery) {
        pendingRecoveriesRef.current[recovery.appId] = recovery;
        if (storageKeyRef.current !== null && capturedStorageKey === null) {
          writePendingUpdateRecovery(storageKeyRef.current, recovery);
        }
        scheduleRecoveryTimer(recovery, recovery.deadlineAt - Date.now());
      }
      setUpdateByApp((prev) => ({
        ...prev,
        [targetApp.id]: { installedVersion: candidate.appVersion, status: "current", available: null },
      }));
      setToast((prev) => prev?.appId === targetApp.id ? null : prev);
      setUpdateError("");
      setInventory((current) => current?.map((entry) => entry.id === targetApp.id ? result.app : entry) ?? null);
      setApps((current) => {
        if (!current) return null;
        const mapped = current.map((entry) => entry.id === targetApp.id ? result.app : entry);
        return mapped.filter((entry) => entry.status === "active");
      });
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
          setInventory((current) => current?.map((entry) => entry.id === targetApp.id ? nextDocument.app : entry) ?? null);
          setApps((current) => {
            if (!current) return null;
            const mapped = current.map((entry) => entry.id === targetApp.id ? nextDocument.app : entry);
            return mapped.filter((entry) => entry.status === "active");
          });
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
      if (cause instanceof ApiError && cause.status === 409) {
        setRefreshKey((current) => current + 1);
      }
    } finally {
      if (mountedRef.current) setUpdatingAppId(null);
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

  const onNavKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !apps?.length) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = buttons.findIndex((button) => button === event.target);
    if (at < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowRight" ? (at + 1) % buttons.length : event.key === "ArrowLeft" ? (at - 1 + buttons.length) % buttons.length : -1;
    if (next < 0) return;
    event.preventDefault();
    const button = buttons[next]!;
    choose(button.dataset.appId!);
    button.focus();
    revealSelectedTab(event.currentTarget);
  };

  const revoked = () => {
    documentRef.current = null;
    stateRef.current = null;
    setDocument(null);
    setAppState(null);
    setError(t("computer.miniApps.accessEnded"));
  };
  const changed = () => {
    documentRef.current = null;
    stateRef.current = null;
    setDocument(null);
    setAppState(null);
    setRefreshKey((current) => current + 1);
  };

  const toggleBar = () => {
    setBarCollapsed((current) => {
      const next = !current;
      rememberBarCollapsed(storageKey, next);
      return next;
    });
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
      <header className={`shrink-0 border-b border-hairline/50 px-4 ${barCollapsed ? "py-2" : "pb-3 pt-2"}`}>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="shrink-0 text-[15px] font-semibold text-ink">{t("computer.miniApps.heading")}</h2>
            {barCollapsed && selected && <button id={`mini-app-tab-${selected.id}`} data-mini-app-collapsed-current data-app-id={selected.id} type="button"
              onClick={toggleBar} title={miniAppDisplayName(selected)}
              className="flex min-w-0 items-center gap-1.5 rounded-lg bg-control px-2 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
              <MiniAppIcon kind={iconKindForApp(selected)} app={selected} />
              <span className="truncate">{miniAppDisplayName(selected)}</span>
            </button>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {owner === true && nativeGuard && inventory?.some((app) => app.status === "archived" && iconKindForApp(app))
              && <button type="button" data-mini-app-add className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => { setLibraryFocus(iconKindForApp(inventory.find((app) => app.status === "archived" && iconKindForApp(app))!)); setLibraryOpen(true); }}>{t("computer.miniApps.add")}</button>}
            {apps && barCollapsed && libraryPopover}
            <button type="button" disabled={checking || busyKind !== null || updatingAppId !== null} aria-label={t("computer.miniApps.refresh")} title={t("computer.miniApps.refresh")} onClick={() => { manualRefreshRef.current = true; setRollbackNotice(null); setRefreshKey((current) => current + 1); }} className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><RotateCw size={15} aria-hidden="true" /></button>
            {apps && <button type="button" data-mini-app-bar-toggle aria-expanded={!barCollapsed} aria-controls="mini-apps-bar"
              aria-label={t(barCollapsed ? "computer.miniApps.expandApps" : "computer.miniApps.collapseApps")}
              title={t(barCollapsed ? "computer.miniApps.expandApps" : "computer.miniApps.collapseApps")}
              onClick={toggleBar}
              className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
              {barCollapsed ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
            </button>}
          </div>
        </div>
        {apps && !barCollapsed && <div id="mini-apps-bar" className="mt-2 flex min-w-0 items-center gap-2">
          {apps.length ? <div ref={tabListRef} role="tablist" aria-label={t("computer.miniApps.chooseApp")} onKeyDown={onNavKey} onWheel={scrollTabsWithWheel} className="flex min-w-0 flex-1 flex-nowrap gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {apps.map((app) => <div key={app.id} className="relative w-[104px] shrink-0">
              <button id={`mini-app-tab-${app.id}`} data-app-id={app.id} type="button" role="tab" aria-selected={app.id === selectedId} aria-controls="mini-app-content" tabIndex={app.id === selectedId ? 0 : -1} onClick={() => choose(app.id)}
              aria-label={miniAppDisplayName(app)} title={miniAppDisplayName(app)}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-1.5 py-2 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${app.id === selectedId ? "bg-control text-ink" : "text-ink-secondary hover:bg-inset hover:text-ink"}`}>
                <MiniAppIcon kind={iconKindForApp(app)} app={app} launcher /><span className="line-clamp-2 min-h-8 w-full text-center leading-4">{miniAppDisplayName(app)}</span>
              </button>
              {app.id === selectedId && (() => {
                const release = readAppReleaseMeta(app, selectedUpdate);
                return <InfoHint className="absolute end-0 top-1" label={`${miniAppDisplayName(app)}: ${t("app.info")}`}>
                  <p>{miniAppDisplayDescription(app)}</p>
                  {release.version && <p data-mini-app-release-version className="tabular-nums text-ink-secondary">{t("computer.miniApps.update.installedVersion", { version: release.version })}</p>}
                  {release.sourceCommit && <p data-mini-app-source-commit title={release.sourceCommit} className="tabular-nums text-ink-secondary">{t("computer.miniApps.update.sourceCommit", { commit: shortCommit(release.sourceCommit) })}</p>}
                  {selectedUpdate?.status === "incompatible" && <p className="text-ink-secondary">{t("computer.miniApps.update.incompatible")}</p>}
                  {selectedUpdate?.status === "custom" && <p className="text-ink-secondary">{t("computer.miniApps.update.custom")}</p>}
                  <p className="tabular-nums text-ink-secondary">{t("computer.miniApps.published", { time: stamp(app.updatedAt) })}</p>
                </InfoHint>;
              })()}
            </div>)}
          </div> : <div className="min-w-0 flex-1" />}
          {libraryPopover}
        </div>}
      </header>
      <>
        {defaultsError && <p role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{defaultsError}</p>}
        {stale && <p role="status" className="mx-4 mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.miniApps.stale")}</p>}
        {error && <p role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
        {updateCheckError && <p role="alert" data-mini-app-update-check-error className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{updateCheckError}</p>}
        {rollbackNotice && selected?.id === rollbackNotice.appId && <p role="alert" data-mini-app-update-rolled-back className="mx-4 mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{rollbackNotice.message}</p>}
        {toast && selected && toast.appId === selected.id && selectedUpdate?.status === "available" && selectedUpdate.available && (
          <MiniAppUpdateToast
            appName={miniAppDisplayName(selected)}
            version={toast.appVersion}
            updating={updatingAppId === selected.id}
            error={updateError}
            restoreFocusOnError={updateSource === "toast"}
            onUpdate={() => void performUpdate(selected, selectedUpdate.available!, "toast")}
            onDismiss={dismissToast}
          />
        )}
        {loading && apps === null && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.loading")}</p>}
        {selected && <div id="mini-app-content" role="tabpanel" aria-labelledby={`mini-app-tab-${selected.id}`} tabIndex={0} className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent">
          {document && appState ? <>
            {managedSite || managedHongguo
              ? <MiniAppFrame key={`${document.app.id}:${frameEpochByApp[document.app.id] ?? 0}`} document={document} state={appState}
                site={managedSite} hongguo={managedHongguo} refreshKey={refreshKey} onRevoked={revoked} onChanged={changed} onRuntimeReady={handleRuntimeReady} />
              : appState.status === "active" && nativeGuard && nativeInstalled ? hongguoCurrent
              ? <HongguoView key={JSON.stringify([storageKey, document.app.id, document.app.revision])} document={document} state={appState}
                storageKey={storageKey} refreshKey={refreshKey} onRevoked={revoked} onChanged={changed} />
              : hongguoRecovery ? <section lang="zh-CN" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary" data-testid="hongguo-recovery">
                <p>{hongguoText("computer.miniApps.dashboard.recovery")}</p>
                <button type="button" onClick={() => void addDefault("hongguo")}
                  className="mt-3 rounded-lg bg-control px-3 py-1.5 font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">{hongguoText("computer.miniApps.dashboard.reauthorize")}</button>
              </section>
              : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t(owner === true ? "computer.miniApps.changedDuringRead" : "computer.miniApps.accessEnded")}</p>
              : appState.status === "active" && nativeGuard && dashboardInstalled ? dashboardCurrent
              ? <MiniAppDashboard key={`${document.app.id}:${document.app.revision}`} document={document} state={appState} refreshKey={refreshKey} onRevoked={revoked} onChanged={changed} />
              : teamHtmlCurrent || usageHtmlCurrent ? <MiniAppFrame key={`${document.app.id}:${frameEpochByApp[document.app.id] ?? 0}`} document={document} state={appState} onRevoked={revoked} onChanged={changed} onRuntimeReady={handleRuntimeReady} />
              : recoveryKind && owner === true ? <section className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary" data-testid="dashboard-recovery">
                <p>{t("computer.miniApps.dashboard.recovery")}</p>
                <button type="button" onClick={() => void addDefault(recoveryKind)} className="mt-3 rounded-lg bg-control px-3 py-1.5 font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">{t("computer.miniApps.dashboard.reauthorize")}</button>
              </section>
              : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t(owner === null ? "computer.miniApps.opening" : owner === true ? "computer.miniApps.changedDuringRead" : "computer.miniApps.accessEnded")}</p>
              : appState.status === "active" && nativeGuard ? mojoCurrent
                ? <MojoWholePage key={`${document.app.id}:${document.app.revision}:${document.app.templateVersion}`}
                  document={document} state={appState} onRevoked={revoked} />
                : dailyXCurrent ? <DailyXWholePage key={`${document.app.id}:${document.app.revision}:${document.app.templateVersion}`}
                  document={document} state={appState} onRevoked={revoked} />
                : githubActivityCurrent ? <GitHubActivityWholePage key={`${document.app.id}:${document.app.revision}:${document.app.templateVersion}`}
                  document={document} state={appState} onRevoked={revoked} />
                : <MiniAppFrame key={`${document.app.id}:${frameEpochByApp[document.app.id] ?? 0}`} document={document} state={appState} onRevoked={revoked} onRuntimeReady={handleRuntimeReady} />
              : appState.status === "active" ? <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>
              : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.archivedContent")}</p>}
          </> : !error && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.opening")}</p>}
        </div>}
      </>
    </div>
  );
}
