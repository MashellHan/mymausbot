import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AppWindow, Clock3, Loader2, RotateCw } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { randomUuid } from "@/lib/random-uuid";
import { useShowThreads } from "@/lib/thread-preferences";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, ApiError, openBot, useStore } from "@/state/store";
import type { MiniAppDocument, MiniAppMutationResult, MiniAppRollback, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { BookkeepingInstall } from "./BookkeepingInstall";
import { MiniAppFrame } from "./MiniAppFrame";
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
  return !left || left.revision !== right.revision || left.templateVersion !== right.templateVersion || left.status !== right.status
    || left.data.length !== right.data.length || right.data.some((entry, index) => entry.datasetId !== left.data[index]?.datasetId || entry.revision !== left.data[index]?.revision);
}

export function MiniAppsPanel() {
  const { state: store, dispatch } = useStore();
  const showThreads = useShowThreads();
  const owner = useOwnerOrAdmin();
  const nativeGuard = miniAppNativeFrameGuard();
  const visible = usePageVisible();
  const [apps, setApps] = useState<MiniAppSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [document, setDocument] = useState<MiniAppDocument | null>(null);
  const [appState, setAppState] = useState<MiniAppState | null>(null);
  const [installing, setInstalling] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [rollbackVersion, setRollbackVersion] = useState<number | null>(null);
  const documentRef = useRef(document);
  const stateRef = useRef(appState);
  const selectedRef = useRef(selectedId);
  const restored = useRef(false);
  documentRef.current = document;
  stateRef.current = appState;
  selectedRef.current = selectedId;
  const selected = apps?.find((app) => app.id === selectedId) ?? null;
  const publisher = store.bots.find((bot) => selected?.publisherBotIds.includes(bot.id));

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
    const saved = savedApp(storageKey);
    if (saved && apps.some((app) => app.id === saved)) setSelectedId(saved);
  }, [storageKey, apps]);

  useEffect(() => {
    if (!visible || installing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const sync = async () => {
      setChecking(true);
      if (!apps) setLoading(true);
      try {
        const inventory = await api<Inventory>("/api/mini-apps", { background: true, signal: controller.signal, timeoutMs: 10_000 });
        if (!active || !Array.isArray(inventory.apps)) return;
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
        if (changedState(stateRef.current, nextState)) {
          const currentDocument = documentRef.current;
          if (!currentDocument || currentDocument.app.id !== target || currentDocument.app.revision !== nextState.revision || currentDocument.app.templateVersion !== nextState.templateVersion) {
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
  }, [selectedId, refreshKey, visible, installing]);

  const choose = (id: string) => {
    rememberApp(storageKey, id);
    setSelectedId(id);
    setDocument(null);
    setAppState(null);
    setError("");
    setStale(false);
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

  return (
    <div className="@container/mini-apps flex min-h-0 min-w-0 flex-1 flex-col" data-testid="mini-apps-panel">
      <header className="shrink-0 border-b border-hairline/50 px-4 pb-3 pt-2">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink">{t("computer.miniApps.heading")}</h2>
          <div className="flex items-center gap-1.5">
            {owner === true && nativeGuard && <button type="button" className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setInstalling(true)}>{t("computer.miniApps.installExample")}</button>}
            <button type="button" disabled={checking || installing} aria-label={t("computer.miniApps.refresh")} title={t("computer.miniApps.refresh")} onClick={() => setRefreshKey((current) => current + 1)} className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><RotateCw size={15} aria-hidden="true" /></button>
          </div>
        </div>
        {!installing && !!apps?.length && <div role="tablist" aria-label={t("computer.miniApps.chooseApp")} onKeyDown={onNavKey} className="mt-3 flex min-w-0 gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {apps.map((app) => <button key={app.id} id={`mini-app-tab-${app.id}`} data-app-id={app.id} type="button" role="tab" aria-selected={app.id === selectedId} aria-controls="mini-app-content" tabIndex={app.id === selectedId ? 0 : -1} onClick={() => choose(app.id)} className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${app.id === selectedId ? "bg-control text-ink" : "text-ink-secondary hover:bg-inset hover:text-ink"}`}>{app.title}</button>)}
        </div>}
        {!installing && selected && <div className="mt-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
          <p className="min-w-0 [overflow-wrap:anywhere]">{selected.description}</p>
          <p className="shrink-0 tabular-nums">{t("computer.miniApps.published", { time: stamp(selected.updatedAt) })}</p>
        </div>}
      </header>
      {installing ? <BookkeepingInstall onCancel={() => setInstalling(false)} onInstalled={(id) => { rememberApp(storageKey, id); setInstalling(false); setSelectedId(id); setRefreshKey((current) => current + 1); }} /> : <>
        {stale && <p role="status" className="mx-4 mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.miniApps.stale")}</p>}
        {error && <p role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
        {loading && apps === null && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.loading")}</p>}
        {apps?.length === 0 && !error && <div className="mx-4 mt-4 flex flex-col items-start gap-2 rounded-xl bg-card p-4 text-[13px] text-ink-secondary"><AppWindow size={21} aria-hidden="true" /><p>{t("computer.miniApps.empty")}</p>{!nativeGuard && <p>{t("computer.miniApps.desktopRequired")}</p>}</div>}
        {selected && <div id="mini-app-content" role="tabpanel" aria-labelledby={`mini-app-tab-${selected.id}`} tabIndex={0} className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent">
          {document && appState ? <>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-2 text-[12px] text-ink-secondary">
              <span className="inline-flex items-center gap-1.5"><Clock3 size={13} aria-hidden="true" />{checking ? t("computer.miniApps.checking") : appState.status === "archived" ? t("computer.miniApps.archived") : t("computer.miniApps.current")}</span>
              <div className="flex items-center gap-3">
                {publisher && <button type="button" onClick={() => openBot(dispatch, publisher, showThreads)} className="text-accent-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent">{t("computer.miniApps.openChat")}</button>}
                {document.versions.length > 1 && <details className="relative"><summary className="cursor-pointer text-accent-text underline-offset-2 hover:underline">{t("computer.miniApps.history")}</summary>
                  <div className="absolute right-0 top-full z-20 mt-1 max-h-60 min-w-44 overflow-y-auto rounded-xl border border-hairline bg-menu p-1.5 shadow-xl">
                    {document.versions.map((version) => <button key={version.version} type="button" disabled={rollbackVersion !== null || version.version === document.app.templateVersion} onClick={() => void rollback(version.version)} className="block w-full rounded-lg px-2 py-1.5 text-left text-[12px] text-ink hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">{t("computer.miniApps.version", { number: version.version })} · {stamp(version.createdAt)}</button>)}
                  </div>
                </details>}
              </div>
            </div>
            {appState.status === "active" && nativeGuard ? <MiniAppFrame document={document} state={appState} onRevoked={() => { setDocument(null); setAppState(null); setError(t("computer.miniApps.accessEnded")); }} />
              : appState.status === "active" ? <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>
              : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.archivedContent")}</p>}
          </> : !error && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.opening")}</p>}
        </div>}
      </>}
    </div>
  );
}
