import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, RotateCw } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { randomUuid } from "@/lib/random-uuid";
import { useShowThreads } from "@/lib/thread-preferences";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, ApiError, openBot, useStore } from "@/state/store";
import type { DefaultMiniAppKind, MiniAppArchive, MiniAppDefaultsResult, MiniAppDocument,
  MiniAppMutationResult, MiniAppRollback, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import bookkeepingHtml from "../../../examples/mini-apps/bookkeeping/index.html?raw";
import { revealSelectedTab, scrollTabsWithWheel } from "../computer-panel-tabs";
import { InfoHint } from "../InfoHint";
import { MiniAppDashboard } from "./MiniAppDashboard";
import { ensureMiniAppDefaults } from "./MiniAppDefaultsBootstrap";
import { MiniAppFrame } from "./MiniAppFrame";
import { MiniAppIcon, iconKindForApp } from "./MiniAppIcon";
import { MiniAppLibraryPopover } from "./MiniAppLibraryPopover";
import { miniAppDisplayDescription, miniAppDisplayName } from "./mini-app-display";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

const REFRESH_MS = 15_000;
type Inventory = { apps: MiniAppSummary[] };

function savedApp(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function rememberApp(key: string | null, id: string): void {
  if (!key) return;
  try { localStorage.setItem(key, id); } catch {}
}

function stamp(value: number): string {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(activeLocale()) : t("computer.miniApps.timeUnavailable");
}

function changedState(left: MiniAppState | null, right: MiniAppState): boolean {
  return !left || left.appId !== right.appId || left.revision !== right.revision || left.templateVersion !== right.templateVersion || left.status !== right.status
    || left.data.length !== right.data.length || right.data.some((entry, index) => entry.datasetId !== left.data[index]?.datasetId || entry.revision !== left.data[index]?.revision);
}

export function MiniAppsPanel({ requestedApp }: { requestedApp?: { id: string; nonce: number } } = {}) {
  const { state: store, dispatch } = useStore();
  const showThreads = useShowThreads();
  const owner = useOwnerOrAdmin();
  const nativeGuard = miniAppNativeFrameGuard();
  const visible = usePageVisible();
  const [apps, setApps] = useState<MiniAppSummary[] | null>(null);
  const [inventory, setInventory] = useState<MiniAppSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [storageKey, setStorageKey] = useState<string | null>(null);
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
  const [rollbackVersion, setRollbackVersion] = useState<number | null>(null);
  const documentRef = useRef(document);
  const stateRef = useRef(appState);
  const selectedRef = useRef(selectedId);
  const panelRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const defaultsStarted = useRef(false);
  const restored = useRef(false);
  const openedRequest = useRef<number | null>(null);
  documentRef.current = document;
  stateRef.current = appState;
  selectedRef.current = selectedId;
  const selected = apps?.find((app) => app.id === selectedId) ?? null;
  const publisher = store.bots.find((bot) => selected?.publisherBotIds.includes(bot.id));
  const dashboard = document?.app.dashboard;
  const currentHead = !!document && !!appState && !!selected && document.app.status === "active" && appState.status === "active"
    && appState.appId === document.app.id && appState.revision === document.app.revision
    && selected.id === document.app.id && selected.revision === document.app.revision;
  const dashboardCurrent = currentHead && !!selected && !!dashboard && owner === true && nativeGuard
    && selected.dashboard?.kind === dashboard.kind && dashboard.renderer === "native" && dashboard.htmlRole === "fallback-only";
  const recoveryKind = currentHead && selected && document && !dashboard && !selected.dashboard && selected.dashboardIdentity
    && document.app.dashboardIdentity === selected.dashboardIdentity ? selected.dashboardIdentity : null;
  const dashboardInstalled = !!(selected?.dashboardIdentity || document?.app.dashboardIdentity || selected?.dashboard || dashboard);

  useEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    const element = target === "selected"
      ? [...panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []].find((tab) => tab.dataset.appId === selectedId)
      : target === "add" ? panelRef.current?.querySelector<HTMLButtonElement>('[data-mini-app-add]') : null;
    if (!element) return;
    element.focus();
    if (target === "selected" && tabListRef.current) revealSelectedTab(tabListRef.current);
    else element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    focusAfter.current = null;
  }, [apps, selectedId, libraryOpen]);

  useLayoutEffect(() => {
    const row = tabListRef.current;
    if (!row) return;
    revealSelectedTab(row);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => revealSelectedTab(row));
    observer.observe(row);
    return () => observer.disconnect();
  }, [selectedId, apps?.length]);

  useEffect(() => {
    let active = true;
    void api<{ environmentId?: string }>("/.well-known/openmausbot/environment", { timeoutMs: 5_000 }).then((environment) => {
      if (active && typeof environment.environmentId === "string" && environment.environmentId) setStorageKey(`omb-mini-app:${environment.environmentId}`);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

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
      setChecking(true);
      if (!apps) setLoading(true);
      try {
        const inventory = await api<Inventory>("/api/mini-apps", { background: true, signal: controller.signal, timeoutMs: 10_000 });
        if (!active || !Array.isArray(inventory.apps)) return;
        setInventory(inventory.apps);
        const activeApps = inventory.apps.filter((app) => app.status === "active");
        setApps(activeApps);
        const target = selectedRef.current && activeApps.some((app) => app.id === selectedRef.current) ? selectedRef.current
          : activeApps[0]?.id ?? null;
        if (target !== selectedRef.current) {
          setSelectedId(target);
          setDocument(null);
          setAppState(null);
          setError("");
          return;
        }
        if (!target) { setDocument(null); setAppState(null); setStale(false); setError(""); return; }
        const nextState = await api<MiniAppState>(`/api/mini-apps/${encodeURIComponent(target)}/state`, { background: true, signal: controller.signal, timeoutMs: 10_000 });
        if (!active || target !== selectedRef.current) return;
        const currentDocument = documentRef.current;
        const listed = activeApps.find((app) => app.id === target)!;
        const dashboardChanged = (currentDocument?.app.dashboard?.kind ?? null) !== (listed.dashboard?.kind ?? null)
          || (currentDocument?.app.dashboardIdentity ?? null) !== (listed.dashboardIdentity ?? null);
        if (changedState(stateRef.current, nextState) || dashboardChanged) {
          if (!currentDocument || currentDocument.app.id !== target || currentDocument.app.revision !== nextState.revision
            || currentDocument.app.templateVersion !== nextState.templateVersion || dashboardChanged) {
            const nextDocument = await api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(target)}`, { background: true, signal: controller.signal, timeoutMs: 10_000 });
            if (!active || target !== selectedRef.current) return;
            if (nextDocument.app.revision !== nextState.revision || nextDocument.app.templateVersion !== nextState.templateVersion) throw new Error(t("computer.miniApps.changedDuringRead"));
            documentRef.current = nextDocument;
            setDocument(nextDocument);
          }
          stateRef.current = nextState;
          setAppState(nextState);
        }
        setStale(false);
        setError("");
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
          documentRef.current = null;
          stateRef.current = null;
          setDocument(null);
          setAppState(null);
          setError(t("computer.miniApps.accessEnded"));
        } else {
          setStale(Boolean(documentRef.current));
          setError(cause instanceof Error ? cause.message : t("computer.miniApps.loadFailed"));
        }
      } finally {
        if (active) {
          setChecking(false);
          setLoading(false);
          timer = setTimeout(sync, REFRESH_MS);
        }
      }
    };
    void sync();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [selectedId, refreshKey, visible, owner, nativeGuard, defaultsReady]);

  const choose = (id: string) => {
    rememberApp(storageKey, id);
    setSelectedId(id);
    setDocument(null);
    setAppState(null);
    setError("");
    setStale(false);
  };

  const addDefault = async (kind: DefaultMiniAppKind) => {
    if (owner !== true || !nativeGuard || busyKind) return;
    setBusyKind(kind);
    setError("");
    try {
      const result = await api<MiniAppDefaultsResult>("/api/mini-apps/defaults", {
        method: "POST", body: JSON.stringify({ bookkeepingHtml, restore: kind }), timeoutMs: 30_000,
      });
      setDefaultIssues(result.issues);
      setInventory(result.apps);
      setApps(result.apps.filter((app) => app.status === "active"));
      const issue = result.issues.find((entry) => entry.kind === kind);
      const target = result.apps.find((app) => iconKindForApp(app) === kind && app.status === "active");
      if (issue) setError(issue.error);
      else if (target && (kind !== "agent-team" && kind !== "usage" || target.dashboard?.kind === kind)) {
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
    if (!kind || owner !== true || !nativeGuard || busyKind || app.status !== "active") return;
    setBusyKind(kind);
    setError("");
    try {
      const body: MiniAppArchive = { requestKey: randomUuid(), expectedRevision: app.revision };
      const result = await api<MiniAppMutationResult>(`/api/mini-apps/${encodeURIComponent(app.id)}/archive`, {
        method: "POST", body: JSON.stringify(body), timeoutMs: 20_000,
      });
      if (result.app.id !== app.id || result.app.status !== "archived") throw new Error(t("computer.miniApps.changedDuringRead"));
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

  const rollback = async (version: number) => {
    if (!document || rollbackVersion !== null) return;
    setRollbackVersion(version);
    setError("");
    try {
      const body: MiniAppRollback = { requestKey: randomUuid(), expectedRevision: document.app.revision, templateVersion: version };
      await api<MiniAppMutationResult>(`/api/mini-apps/${encodeURIComponent(document.app.id)}/rollback`, { method: "POST", body: JSON.stringify(body), timeoutMs: 20_000 });
      setRefreshKey((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("computer.miniApps.rollbackFailed"));
    } finally { setRollbackVersion(null); }
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

  return (
    <div ref={panelRef} className="@container/mini-apps flex min-h-0 min-w-0 flex-1 flex-col" data-testid="mini-apps-panel">
      <header className="shrink-0 border-b border-hairline/50 px-4 pb-3 pt-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink">{t("computer.miniApps.heading")}</h2>
          <div className="flex items-center gap-1.5">
            {owner === true && nativeGuard && inventory?.some((app) => app.status === "archived" && iconKindForApp(app))
              && <button type="button" data-mini-app-add className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                onClick={() => { setLibraryFocus(iconKindForApp(inventory.find((app) => app.status === "archived" && iconKindForApp(app))!)); setLibraryOpen(true); }}>{t("computer.miniApps.add")}</button>}
            <button type="button" disabled={checking || busyKind !== null} aria-label={t("computer.miniApps.refresh")} title={t("computer.miniApps.refresh")} onClick={() => setRefreshKey((current) => current + 1)} className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><RotateCw size={15} aria-hidden="true" /></button>
          </div>
        </div>
        {apps && <div className="mt-2 flex min-w-0 items-center gap-2">
          {apps.length ? <div ref={tabListRef} role="tablist" aria-label={t("computer.miniApps.chooseApp")} onKeyDown={onNavKey} onWheel={scrollTabsWithWheel} className="flex min-w-0 flex-1 flex-nowrap gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
            {apps.map((app) => <div key={app.id} className="relative w-[104px] shrink-0">
              <button id={`mini-app-tab-${app.id}`} data-app-id={app.id} type="button" role="tab" aria-selected={app.id === selectedId} aria-controls="mini-app-content" tabIndex={app.id === selectedId ? 0 : -1} onClick={() => choose(app.id)}
              aria-label={miniAppDisplayName(app)} title={miniAppDisplayName(app)}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-1.5 py-2 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${app.id === selectedId ? "bg-control text-ink" : "text-ink-secondary hover:bg-inset hover:text-ink"}`}>
                <MiniAppIcon kind={iconKindForApp(app)} launcher /><span className={`line-clamp-2 min-h-8 w-full text-center leading-4 ${app.id === selectedId ? "pr-6" : ""}`}>{miniAppDisplayName(app)}</span>
              </button>
              {app.id === selectedId && <InfoHint className="absolute bottom-5 right-1" label={`${miniAppDisplayName(app)}: ${t("app.info")}`}>
                <p>{miniAppDisplayDescription(app)}</p>
                <p className="tabular-nums text-ink-secondary">{t("computer.miniApps.published", { time: stamp(app.updatedAt) })}</p>
              </InfoHint>}
            </div>)}
          </div> : <div className="min-w-0 flex-1" />}
          <MiniAppLibraryPopover open={libraryOpen} inventory={inventory ?? []} issues={defaultIssues} busyKind={busyKind}
            focusKind={libraryFocus} owner={owner} nativeGuard={nativeGuard}
            onToggle={() => { setLibraryFocus(null); setLibraryOpen((current) => !current); }} onClose={() => setLibraryOpen(false)}
            onOpen={installed} onAdd={(kind) => void addDefault(kind)} onRemove={(app) => void removeDefault(app)}>
            {selected && document && appState && (document.versions.length > 1 || publisher && !dashboardInstalled) && <div className="mt-3 border-t border-hairline/60 pt-3 text-[12px] text-ink-secondary">
              <p className="mb-2 font-medium text-ink">{miniAppDisplayName(selected)}</p>
              {publisher && !dashboardInstalled && <button type="button" onClick={() => { setLibraryOpen(false); openBot(dispatch, publisher, showThreads); }} className="text-accent-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent">{t("computer.miniApps.openChat")}</button>}
              {document.versions.length > 1 && <details className="mt-2"><summary className="cursor-pointer text-accent-text underline-offset-2 hover:underline">{t("computer.miniApps.history")}</summary>
                <div className="mt-1 max-h-60 overflow-y-auto">
                  {document.versions.map((version) => <button key={version.version} type="button" disabled={rollbackVersion !== null || version.version === document.app.templateVersion} onClick={() => void rollback(version.version)} className="block w-full rounded-lg px-2 py-1.5 text-left text-[12px] text-ink hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">{t("computer.miniApps.version", { number: version.version })} · {stamp(version.createdAt)}</button>)}
                </div>
              </details>}
            </div>}
          </MiniAppLibraryPopover>
        </div>}
      </header>
      <>
        {defaultsError && <p role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{defaultsError}</p>}
        {stale && <p role="status" className="mx-4 mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.miniApps.stale")}</p>}
        {error && <p role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
        {loading && apps === null && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.loading")}</p>}
        {selected && <div id="mini-app-content" role="tabpanel" aria-labelledby={`mini-app-tab-${selected.id}`} tabIndex={0} className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent">
          {document && appState ? <>
            {appState.status === "active" && nativeGuard && dashboardInstalled ? dashboardCurrent
              ? <MiniAppDashboard key={`${document.app.id}:${document.app.revision}`} document={document} state={appState} refreshKey={refreshKey} onRevoked={revoked} onChanged={changed} />
              : recoveryKind && owner === true ? <section className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary" data-testid="dashboard-recovery">
                <p>{t("computer.miniApps.dashboard.recovery")}</p>
                <button type="button" onClick={() => void addDefault(recoveryKind)} className="mt-3 rounded-lg bg-control px-3 py-1.5 font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">{t("computer.miniApps.dashboard.reauthorize")}</button>
              </section>
              : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t(owner === null ? "computer.miniApps.opening" : owner === true ? "computer.miniApps.changedDuringRead" : "computer.miniApps.accessEnded")}</p>
              : appState.status === "active" && nativeGuard ? <MiniAppFrame document={document} state={appState} onRevoked={revoked} />
              : appState.status === "active" ? <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>
              : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.archivedContent")}</p>}
          </> : !error && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.opening")}</p>}
        </div>}
      </>
    </div>
  );
}
