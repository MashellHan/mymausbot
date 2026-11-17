import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Clapperboard, History, Loader2, Maximize, Search, Trash2 } from "lucide-react";
import { ConfirmDialog } from "../ConfirmDialog";
import { Select } from "../Select";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import type { HongguoCatalogRequest, HongguoCatalogResponse, HongguoCategory, HongguoEpisode,
  HongguoHistoryEntry, HongguoHistoryResponse, HongguoPlaybackResponse, HongguoPreferencesResponse,
  HongguoSeries, HongguoSeriesCard, HongguoSeriesResponse } from "../../../shared/hongguo-mini-app";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

type Page = "home" | "history" | "watch";
type BrowseMode = "popular" | "new" | "search" | "category";
type HistoryChoice = { action: "delete"; entry: HongguoHistoryEntry } | { action: "clear" };
const historyMutationTailByApp = new Map<string, Promise<void>>();
const HOME_FRESH_MS = 5 * 60_000;
type HomeSnapshot = { mode: BrowseMode; query: string; categoryId: string;
  items: HongguoSeriesCard[]; nextCursor: string | null; categories: HongguoCategory[];
  categoriesLoaded: boolean; expiresAt: number; categoriesExpiresAt: number };
const homeSnapshots = new Map<string, HomeSnapshot>();

function recentHome(key: string | null): HomeSnapshot | null {
  return key ? homeSnapshots.get(key) ?? null : null;
}

function rememberHome(key: string | null, saved: HomeSnapshot): void {
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

function appendUniqueCards(existing: HongguoSeriesCard[], incoming: HongguoSeriesCard[]): HongguoSeriesCard[] {
  const seen = new Set(existing.map((card) => card.id));
  return [...existing, ...incoming.filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  })];
}

function enqueueHistoryMutation<T>(appId: string, operation: () => Promise<T>): Promise<T> {
  const result = (historyMutationTailByApp.get(appId) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => {}, () => {});
  historyMutationTailByApp.set(appId, tail);
  void tail.then(() => { if (historyMutationTailByApp.get(appId) === tail) historyMutationTailByApp.delete(appId); });
  return result;
}

function Poster({ card, appId, revision, priority = false, className = "" }: {
  card: HongguoSeriesCard; appId: string; revision: number; priority?: boolean; className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = card.coverUrl && `/api/mini-apps/${encodeURIComponent(appId)}/hongguo/cover?expectedRevision=${revision}&url=${encodeURIComponent(card.coverUrl)}`;
  return <div className={`relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-inset text-ink-secondary ${className}`}>
    <Clapperboard size={25} strokeWidth={1.4} aria-hidden="true" />
    {url && failedUrl !== card.coverUrl && <img src={url} alt="" loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"} decoding="async" onError={() => setFailedUrl(card.coverUrl)}
      className="absolute inset-0 h-full w-full object-cover" />}
  </div>;
}

function time(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function scopedMediaUrl(value: string, appId: string, revision: number): string {
  const url = new URL(value, window.location.origin);
  const prefix = `/api/mini-apps/${encodeURIComponent(appId)}/hongguo/media/`;
  if (url.origin !== window.location.origin || url.username || url.password || !url.pathname.startsWith(prefix)
    || url.pathname.length === prefix.length || url.searchParams.getAll("expectedRevision").length !== 1
    || url.searchParams.get("expectedRevision") !== String(revision) || url.hash) {
    throw new Error(t("computer.miniApps.hongguo.playbackFailed"));
  }
  return url.pathname + url.search;
}

export function HongguoView({ document, state, storageKey, refreshKey, onRevoked, onChanged }: {
  document: MiniAppDocument; state: MiniAppState; storageKey: string | null; refreshKey: number; onRevoked(): void; onChanged(): void;
}) {
  const appId = document.app.id;
  const revision = document.app.revision;
  const visible = usePageVisible();
  const valid = miniAppNativeFrameGuard() && document.app.status === "active" && state.status === "active"
    && state.appId === appId && state.revision === revision && document.app.nativeIdentity === "hongguo"
    && document.app.nativeKind === "hongguo";
  const homeKey = storageKey ? JSON.stringify([storageKey, appId, revision]) : null;
  const initialHome = useRef(valid ? recentHome(homeKey) : null).current;
  const lastRefreshKey = useRef(refreshKey);
  const callbacks = useRef({ onRevoked, onChanged });
  callbacks.current = { onRevoked, onChanged };
  const mounted = useRef(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progress = useRef<Omit<HongguoHistoryEntry, "updatedAt"> | null>(null);
  const lastQueuedPosition = useRef(-Infinity);
  const catalogController = useRef<AbortController | null>(null);
  const catalogGeneration = useRef(0);
  const homeScroll = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<Page>("home");
  const [mode, setMode] = useState<BrowseMode>(initialHome?.mode ?? "popular");
  const [queryInput, setQueryInput] = useState(initialHome?.query ?? "");
  const [query, setQuery] = useState(initialHome?.query ?? "");
  const [categoryId, setCategoryId] = useState(initialHome?.categoryId ?? "");
  const [categories, setCategories] = useState<HongguoCategory[]>(initialHome?.categories ?? []);
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const categoriesLoaded = useRef(initialHome?.categoriesLoaded ?? false);
  const categoriesExpiresAt = useRef(initialHome?.categoriesExpiresAt ?? 0);
  const [items, setItems] = useState<HongguoSeriesCard[]>(initialHome?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initialHome?.nextCursor ?? null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [moreLoading, setMoreLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [history, setHistory] = useState<HongguoHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [historyRetry, setHistoryRetry] = useState(0);
  const [autoplayNext, setAutoplayNext] = useState(true);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [choice, setChoice] = useState<HistoryChoice | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [requestedEpisodeId, setRequestedEpisodeId] = useState<string | null>(null);
  const [series, setSeries] = useState<HongguoSeries | null>(null);
  const [seriesError, setSeriesError] = useState("");
  const [episodeId, setEpisodeId] = useState<string | null>(null);
  const [episodeGroup, setEpisodeGroup] = useState(0);
  const [playback, setPlayback] = useState<HongguoPlaybackResponse | null>(null);
  const [playbackError, setPlaybackError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [pendingQuality, setPendingQuality] = useState<string | null>(null);
  const qualityController = useRef<AbortController | null>(null);
  const qualityResume = useRef<{ position: number; paused: boolean } | null>(null);
  const episodes = series?.episodes ?? [];
  const episode = episodes.find((entry) => entry.id === episodeId) ?? null;

  const post = useCallback(async <T extends { appId: string; revision: number }>(route: string, body: unknown, signal?: AbortSignal): Promise<T> => {
    if (!miniAppNativeFrameGuard()) throw new ApiError(t("computer.miniApps.accessEnded"), 403);
    const result = await api<T>(`/api/mini-apps/${encodeURIComponent(appId)}/hongguo/${route}`, {
      method: "POST", body: JSON.stringify(body), signal, timeoutMs: route === "playback" ? 120_000 : 10_000,
    });
    if (result.appId !== appId || result.revision !== revision) throw new ApiError(t("computer.miniApps.changedDuringRead"), 409);
    return result;
  }, [appId, revision]);

  const showError = useCallback((cause: unknown, setError: (message: string) => void) => {
    if (!mounted.current || cause instanceof DOMException && cause.name === "AbortError") return;
    if (!miniAppNativeFrameGuard() || cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      forgetHongguoHome(storageKey, appId);
      callbacks.current.onRevoked(); return;
    }
    if (cause instanceof ApiError && cause.status === 409) { forgetHongguoHome(storageKey, appId); callbacks.current.onChanged(); return; }
    setError(cause instanceof Error ? cause.message : t("computer.miniApps.loadFailed"));
  }, [storageKey, appId]);

  useEffect(() => {
    if (!valid) forgetHongguoHome(storageKey, appId);
    else if (lastRefreshKey.current !== refreshKey) {
      const saved = recentHome(homeKey);
      if (saved) rememberHome(homeKey, { ...saved, expiresAt: 0, categoriesLoaded: false, categoriesExpiresAt: 0 });
    }
    lastRefreshKey.current = refreshKey;
  }, [valid, homeKey, storageKey, appId, refreshKey]);

  const savePosition = useCallback(() => {
    const entry = progress.current;
    if (!entry || !miniAppNativeFrameGuard()) return;
    void enqueueHistoryMutation(appId, async () => {
      const result = await post<HongguoHistoryResponse>("history", { expectedRevision: revision, action: "save", entry });
      if (mounted.current) { setHistory(result.entries); setSaveError(""); }
    }).catch((cause: unknown) => { if (mounted.current) showError(cause, setSaveError); });
  }, [appId, post, revision, showError]);

  const pauseAndSave = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      if (progress.current && Number.isFinite(video.currentTime)) {
        progress.current = { ...progress.current, positionSeconds: Math.max(0, video.currentTime) };
      }
    }
    savePosition();
  }, [savePosition]);

  useEffect(() => {
    mounted.current = true;
    return () => { pauseAndSave(); mounted.current = false; };
  }, [pauseAndSave]);
  useEffect(() => { if (!visible && !window.document.fullscreenElement) pauseAndSave(); }, [visible, pauseAndSave]);

  useEffect(() => {
    if (!valid || !visible) return;
    const controller = new AbortController();
    setHistory(null);
    setHistoryError("");
    void (async () => {
      await historyMutationTailByApp.get(appId);
      if (controller.signal.aborted) return;
      const result = await post<HongguoHistoryResponse>("history", { expectedRevision: revision, action: "list" }, controller.signal);
      if (!controller.signal.aborted) { setHistory(result.entries); setAutoplayNext(result.autoplayNext); setHistoryError(""); }
    })()
      .catch((cause: unknown) => { if (!controller.signal.aborted) showError(cause, setHistoryError); });
    return () => controller.abort();
  }, [appId, valid, visible, refreshKey, historyRetry, post, revision, showError]);

  useEffect(() => {
    if (!valid || !visible || page !== "home") return;
    const saved = recentHome(homeKey);
    if (saved?.categoriesLoaded && saved.categoriesExpiresAt > Date.now()) { setCategories(saved.categories); categoriesLoaded.current = true; categoriesExpiresAt.current = saved.categoriesExpiresAt; return; }
    categoriesLoaded.current = false;
    const controller = new AbortController();
    void post<HongguoCatalogResponse>("catalog", { expectedRevision: revision, mode: "categories" }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) {
        setCategories(result.categories); categoriesRef.current = result.categories; categoriesLoaded.current = true;
        categoriesExpiresAt.current = Date.now() + HOME_FRESH_MS;
        const current = recentHome(homeKey);
        if (current) rememberHome(homeKey, { ...current, categories: result.categories, categoriesLoaded: true, categoriesExpiresAt: categoriesExpiresAt.current });
      } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) showError(cause, setCatalogError); });
    return () => controller.abort();
  }, [valid, visible, page, mode, refreshKey, catalogRefresh, homeKey, post, revision, showError]);

  useEffect(() => {
    if (!valid || !visible || page !== "home" || mode === "category" && !categoryId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshAfter = (delay: number) => {
      timer = setTimeout(() => setCatalogRefresh((current) => current + 1), Math.max(1, delay));
    };
    const cleanup = () => {
      clearTimeout(timer); controller.abort();
      if (catalogController.current === controller) catalogController.current = null;
    };
    const generation = ++catalogGeneration.current;
    catalogController.current = controller;
    const saved = recentHome(homeKey);
    if (saved && saved.mode === mode && saved.query === query && saved.categoryId === categoryId) {
      setItems(saved.items); setNextCursor(saved.nextCursor); setCatalogLoading(false); setMoreLoading(false); setCatalogError("");
      if (saved.expiresAt > Date.now()) {
        refreshAfter(saved.expiresAt - Date.now());
        return cleanup;
      }
    } else {
      setItems([]); setNextCursor(null);
    }
    const body: HongguoCatalogRequest = { expectedRevision: revision, mode,
      ...(mode === "search" ? { query } : mode === "category" ? { categoryId } : {}) };
    setCatalogLoading(true);
    setMoreLoading(false);
    setCatalogError("");
    const active = () => !controller.signal.aborted && generation === catalogGeneration.current;
    void (async () => {
      try {
        const first = await post<HongguoCatalogResponse>("catalog", body, controller.signal);
        if (!active()) return;
        const firstItems = appendUniqueCards([], first.items);
        setItems(firstItems); setNextCursor(first.nextCursor); setCatalogLoading(false);
        const expiresAt = Date.now() + HOME_FRESH_MS;
        rememberHome(homeKey, { mode, query, categoryId, items: firstItems, nextCursor: first.nextCursor,
          categories: categoriesRef.current, categoriesLoaded: categoriesLoaded.current, categoriesExpiresAt: categoriesExpiresAt.current, expiresAt });
        if (!first.nextCursor) return;
        setMoreLoading(true);
        try {
          const second = await post<HongguoCatalogResponse>("catalog", { ...body, cursor: first.nextCursor }, controller.signal);
          if (!active()) return;
          const updated = appendUniqueCards(firstItems, second.items);
          setItems(updated); setNextCursor(second.nextCursor);
          rememberHome(homeKey, { mode, query, categoryId, items: updated, nextCursor: second.nextCursor,
            categories: categoriesRef.current, categoriesLoaded: categoriesLoaded.current, categoriesExpiresAt: categoriesExpiresAt.current, expiresAt });
        } catch (cause) { if (active()) showError(cause, setCatalogError); }
        finally { if (active()) setMoreLoading(false); }
      } catch (cause) { if (active()) showError(cause, setCatalogError); }
      finally { if (active()) { setCatalogLoading(false); refreshAfter(HOME_FRESH_MS); } }
    })();
    return cleanup;
  }, [valid, visible, page, refreshKey, catalogRefresh, mode, query, categoryId, homeKey, post, revision, showError]);

  const loadMore = async () => {
    const signal = catalogController.current?.signal;
    if (!nextCursor || catalogLoading || moreLoading || !signal || signal.aborted) return;
    const generation = catalogGeneration.current;
    const body: HongguoCatalogRequest = { expectedRevision: revision, mode, cursor: nextCursor,
      ...(mode === "search" ? { query } : mode === "category" ? { categoryId } : {}) };
    setMoreLoading(true);
    try {
      const result = await post<HongguoCatalogResponse>("catalog", body, signal);
      if (!signal.aborted && generation === catalogGeneration.current) {
        const updated = appendUniqueCards(items, result.items);
        setItems(updated); setNextCursor(result.nextCursor); setCatalogError("");
        rememberHome(homeKey, { mode, query, categoryId, items: updated, nextCursor: result.nextCursor,
          categories: categoriesRef.current, categoriesLoaded: categoriesLoaded.current, categoriesExpiresAt: categoriesExpiresAt.current,
          expiresAt: recentHome(homeKey)?.expiresAt ?? Date.now() + HOME_FRESH_MS });
      }
    } catch (cause) { if (!signal.aborted && generation === catalogGeneration.current) showError(cause, setCatalogError); }
    finally { if (!signal.aborted && generation === catalogGeneration.current) setMoreLoading(false); }
  };

  useEffect(() => {
    if (!valid || !seriesId) return;
    const controller = new AbortController();
    setSeries(null); setSeriesError(""); setPlayback(null); setEpisodeId(null);
    void post<HongguoSeriesResponse>("series", { expectedRevision: revision, seriesId }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setSeries(result.series);
      }).catch((cause: unknown) => { if (!controller.signal.aborted) showError(cause, setSeriesError); });
    return () => controller.abort();
  }, [valid, refreshKey, seriesId, requestedEpisodeId, post, revision, showError]);

  useEffect(() => {
    if (!series || series.id !== seriesId || history === null || episodeId !== null) return;
    const wanted = requestedEpisodeId ?? history.find((entry) => entry.seriesId === seriesId)?.episodeId;
    const selected = series.episodes.find((entry) => entry.id === wanted) ?? series.episodes[0];
    setEpisodeId(selected?.id ?? null);
    setEpisodeGroup(selected ? Math.floor(series.episodes.indexOf(selected) / 30) : 0);
  }, [series, seriesId, history, requestedEpisodeId, episodeId]);

  useEffect(() => {
    qualityController.current?.abort();
    qualityResume.current = null;
    setPendingQuality(null);
    if (!valid || page !== "watch" || !series || !episode) return;
    const controller = new AbortController();
    setPlayback(null); setPlaybackError("");
    if (episode.availability === "unavailable") {
      setPlayback({ appId, revision, status: "unavailable", reason: "episode-unavailable" });
      return () => controller.abort();
    }
    void post<HongguoPlaybackResponse>("playback", { expectedRevision: revision, seriesId: series.id, episodeId: episode.id }, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.status === "ready") scopedMediaUrl(result.mediaUrl, appId, revision);
        setPlayback(result);
      }).catch((cause: unknown) => { if (!controller.signal.aborted) showError(cause, setPlaybackError); });
    return () => { controller.abort(); qualityController.current?.abort(); };
  }, [valid, page, series, episode, appId, revision, post, showError]);

  const changeQuality = async (qualityId: string) => {
    if (!series || !episode || playback?.status !== "ready" || !playback.availableQualityIds?.includes(qualityId)) return;
    qualityController.current?.abort();
    setPendingQuality(null);
    if (qualityId === playback.selectedQualityId) return;
    const controller = new AbortController();
    qualityController.current = controller;
    setPendingQuality(qualityId);
    setPlaybackError("");
    try {
      const result = await post<HongguoPlaybackResponse>("playback", {
        expectedRevision: revision, seriesId: series.id, episodeId: episode.id, qualityId,
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status !== "ready") { setPlaybackError(t("computer.miniApps.hongguo.qualityUnavailable")); return; }
      scopedMediaUrl(result.mediaUrl, appId, revision);
      const video = videoRef.current;
      if (video) qualityResume.current = { position: Number.isFinite(video.currentTime) ? video.currentTime : 0, paused: video.paused };
      setPlayback(result);
    } catch (cause) { if (!controller.signal.aborted) showError(cause, setPlaybackError); }
    finally { if (qualityController.current === controller) { qualityController.current = null; if (!controller.signal.aborted) setPendingQuality(null); } }
  };

  const openSeries = (id: string, resumeEpisodeId: string | null = null) => {
    pauseAndSave(); progress.current = null; lastQueuedPosition.current = -Infinity;
    setRequestedEpisodeId(resumeEpisodeId); setSeriesId(id); setPage("watch");
  };
  const leaveWatch = (to: Page) => { pauseAndSave(); setPage(to); };
  const chooseEpisode = (next: HongguoEpisode) => {
    if (history === null || next.id === episodeId) return;
    pauseAndSave(); progress.current = null; lastQueuedPosition.current = -Infinity;
    setEpisodeId(next.id); setEpisodeGroup(Math.floor(episodes.indexOf(next) / 30));
  };
  const recordPosition = (video: HTMLVideoElement) => {
    if (!series || !episode || !Number.isFinite(video.currentTime)) return;
    progress.current = { seriesId: series.id, seriesTitle: series.title, coverUrl: series.coverUrl,
      episodeId: episode.id, episodeNumber: episode.number, episodeTitle: episode.title,
      positionSeconds: Math.max(0, video.currentTime), durationSeconds: Number.isFinite(video.duration) ? video.duration : null };
  };
  const updatePosition = (video: HTMLVideoElement) => {
    recordPosition(video);
    if (progress.current && Math.abs(progress.current.positionSeconds - lastQueuedPosition.current) >= 5) {
      lastQueuedPosition.current = progress.current.positionSeconds;
      savePosition();
    }
  };
  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    const value = queryInput.trim();
    setQuery(value); setMode(value ? "search" : "popular");
  };
  const changeAutoplay = async () => {
    if (preferenceBusy) return;
    setPreferenceBusy(true);
    try {
      const result = await post<HongguoPreferencesResponse>("preferences", { expectedRevision: revision, autoplayNext: !autoplayNext });
      if (mounted.current) setAutoplayNext(result.autoplayNext);
    } catch (cause) { showError(cause, setHistoryError); }
    finally { if (mounted.current) setPreferenceBusy(false); }
  };
  const confirmHistory = async () => {
    if (!choice || historyBusy) return;
    setHistoryBusy(true);
    const savedProgress = progress.current;
    const removedProgress = savedProgress && (choice.action === "clear" || savedProgress.seriesId === choice.entry.seriesId);
    if (removedProgress) { progress.current = null; lastQueuedPosition.current = -Infinity; }
    try {
      const result = await enqueueHistoryMutation(appId, () => post<HongguoHistoryResponse>("history", {
        expectedRevision: revision, action: choice.action,
        ...(choice.action === "delete" ? { seriesId: choice.entry.seriesId } : {}) }));
      if (progress.current && (choice.action === "clear" || progress.current.seriesId === choice.entry.seriesId)) {
        progress.current = null;
        lastQueuedPosition.current = -Infinity;
      }
      if (mounted.current) { setHistory(result.entries); setChoice(null); setHistoryError(""); }
    } catch (cause) {
      if (removedProgress && mounted.current && progress.current === null) progress.current = savedProgress;
      showError(cause, setHistoryError);
    }
    finally { if (mounted.current) setHistoryBusy(false); }
  };

  if (!valid) return null;
  return <div className="@container/hongguo flex min-h-0 min-w-0 flex-1 flex-col bg-panel text-ink" data-testid="hongguo-view">
    <div ref={homeScroll} className={page === "home" ? "min-h-0 flex-1 overflow-y-auto px-4 pb-8 @min-[760px]/hongguo:px-7" : "hidden"}>
      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <div className="flex items-center gap-2.5"><Clapperboard size={21} strokeWidth={1.7} aria-hidden="true" />
          <h2 className="text-[18px] font-semibold">{t("computer.miniApps.hongguo.title")}</h2></div>
        <div className="flex flex-wrap items-center gap-2">
          <form onSubmit={onSearch} role="search" className="flex items-center rounded-lg bg-inset px-2.5 focus-within:outline-2 focus-within:outline-accent">
            <Search size={15} className="text-ink-secondary" aria-hidden="true" />
            <input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} aria-label={t("computer.miniApps.hongguo.search")}
              placeholder={t("computer.miniApps.hongguo.search")} className="w-36 bg-transparent px-2 py-2 text-[13px] outline-none @min-[520px]/hongguo:w-52" />
            <button type="submit" className="sr-only">{t("computer.miniApps.hongguo.searchButton")}</button>
          </form>
          <button type="button" onClick={() => setPage("history")} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[13px] hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent">
            <History size={15} aria-hidden="true" />{t("computer.miniApps.hongguo.history")}</button>
        </div>
      </header>
      {saveError && <p role="alert" className="mb-4 rounded-lg bg-danger/10 p-3 text-[12px] text-danger">{saveError}</p>}
      {!!history?.length && <section aria-labelledby="hongguo-continue-title" className="mb-8">
        <h3 id="hongguo-continue-title" className="mb-3 text-[15px] font-semibold">{t("computer.miniApps.hongguo.continue")}</h3>
        <div className="grid gap-3 @min-[600px]/hongguo:grid-cols-2">
          {history.slice(0, 2).map((entry) => <button key={entry.seriesId} type="button" onClick={() => openSeries(entry.seriesId, entry.episodeId)}
            className="flex min-w-0 items-center gap-3 rounded-xl bg-inset p-3 text-left hover:bg-control focus-visible:outline-2 focus-visible:outline-accent">
            <Poster key={refreshKey} card={{ id: entry.seriesId, title: entry.seriesTitle, coverUrl: entry.coverUrl, summary: null, episodeCount: null }}
              appId={appId} revision={revision} priority className="w-14 shrink-0" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold">{entry.seriesTitle}</span>
              <span className="mt-1 block text-[12px] text-ink-secondary">{t("computer.miniApps.hongguo.episodeNumber", { number: entry.episodeNumber ?? "?" })} · {time(entry.positionSeconds)}</span>
              {entry.durationSeconds && <span className="mt-2 block h-1 rounded-full bg-control"><span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, 100 * entry.positionSeconds / entry.durationSeconds)}%` }} /></span>}
              <span className="mt-1.5 block text-[11px] font-medium">{t("computer.miniApps.hongguo.resume")}</span></span>
          </button>)}
        </div>
      </section>}
      <section aria-labelledby="hongguo-catalog-title" aria-busy={catalogLoading}>
        <div className="flex items-center gap-5 border-b border-hairline/60">
          <h3 id="hongguo-catalog-title" className="sr-only">{t("computer.miniApps.hongguo.catalog")}</h3>
          {(["popular", "new"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value}
            onClick={() => setMode(value)} className={`border-b-2 pb-2.5 text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-accent ${mode === value ? "border-ink text-ink" : "border-transparent text-ink-secondary hover:text-ink"}`}>
            {t(value === "popular" ? "computer.miniApps.hongguo.popular" : "computer.miniApps.hongguo.new")}</button>)}
          {mode === "search" && <span className="pb-2.5 text-[13px] text-ink-secondary">{t("computer.miniApps.hongguo.results", { query })}</span>}
          {catalogLoading && items.length > 0 && <Loader2 size={14} className="mb-2.5 animate-spin text-ink-secondary" role="status" aria-label={t("computer.miniApps.hongguo.loading")} />}
        </div>
        <div className="my-3 flex flex-wrap gap-1.5" aria-label={t("computer.miniApps.hongguo.categories")}>
          <button type="button" aria-pressed={mode !== "category"} onClick={() => setMode("popular")}
            className={`rounded-lg px-2.5 py-1.5 text-[12px] focus-visible:outline-2 focus-visible:outline-accent ${mode !== "category" ? "bg-ink text-panel" : "text-ink-secondary hover:bg-inset"}`}>
            {t("computer.miniApps.hongguo.all")}</button>
          {categories.map((category) => <button key={category.id} type="button" aria-pressed={mode === "category" && categoryId === category.id}
            onClick={() => { setCategoryId(category.id); setMode("category"); }}
            className={`rounded-lg px-2.5 py-1.5 text-[12px] focus-visible:outline-2 focus-visible:outline-accent ${mode === "category" && categoryId === category.id ? "bg-ink text-panel" : "text-ink-secondary hover:bg-inset"}`}>
            {category.title}</button>)}
        </div>
        {catalogError && <p role="alert" className="rounded-lg bg-danger/10 p-3 text-[13px] text-danger">{catalogError}</p>}
        {catalogLoading && !items.length ? <p role="status" className="flex items-center gap-2 py-8 text-[13px] text-ink-secondary"><Loader2 size={16} className="animate-spin" />{t("computer.miniApps.hongguo.loading")}</p>
          : items.length ? <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,210px),1fr))] gap-x-4 gap-y-5">
            {items.map((card, index) => <button key={card.id} type="button" onClick={() => openSeries(card.id)} className="min-w-0 text-left focus-visible:outline-2 focus-visible:outline-accent">
              <Poster key={refreshKey} card={card} appId={appId} revision={revision} priority={index < 4} /><span className="mt-1.5 block truncate text-[12px] font-semibold">{card.title}</span>
              {card.episodeCount !== null && <span className="block text-[11px] text-ink-secondary">{t("computer.miniApps.hongguo.totalEpisodes", { count: card.episodeCount })}</span>}
            </button>)}</div>
            : !catalogError && <p role="status" className="py-8 text-[13px] text-ink-secondary">{t("computer.miniApps.hongguo.emptyCatalog")}</p>}
        {nextCursor && <button type="button" disabled={catalogLoading || moreLoading} onClick={() => void loadMore()}
          className="mt-6 rounded-lg bg-control px-3 py-2 text-[12px] font-medium hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
          {moreLoading ? t("computer.miniApps.hongguo.loading") : t("computer.miniApps.hongguo.more")}</button>}
      </section>
    </div>

    {page === "history" && <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 @min-[760px]/hongguo:px-7" aria-labelledby="hongguo-history-title">
      <header className="flex items-center justify-between gap-3 py-5"><div className="flex items-center gap-3">
        <button type="button" onClick={() => setPage("home")} aria-label={t("computer.miniApps.hongguo.back")}
          className="rounded-lg p-2 hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent"><ArrowLeft size={17} /></button>
        <h2 id="hongguo-history-title" className="text-[17px] font-semibold">{t("computer.miniApps.hongguo.history")}</h2></div>
        {!!history?.length && <button type="button" onClick={() => setChoice({ action: "clear" })} className="rounded-lg px-2.5 py-2 text-[12px] text-danger hover:bg-danger/10 focus-visible:outline-2 focus-visible:outline-accent">
          {t("computer.miniApps.hongguo.clear")}</button>}
      </header>
      {historyError && <p role="alert" className="mb-3 rounded-lg bg-danger/10 p-3 text-[12px] text-danger">{historyError}</p>}
      {history === null ? <p role="status" className="text-[13px] text-ink-secondary">{t("computer.miniApps.hongguo.loading")}</p>
        : history.length ? <ul className="space-y-2">{history.map((entry) => <li key={entry.seriesId} className="flex items-center gap-3 rounded-xl bg-inset p-3">
          <button type="button" onClick={() => openSeries(entry.seriesId, entry.episodeId)} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-2 focus-visible:outline-accent">
            <Poster key={refreshKey} card={{ id: entry.seriesId, title: entry.seriesTitle, coverUrl: entry.coverUrl, summary: null, episodeCount: null }}
              appId={appId} revision={revision} className="w-14 shrink-0" />
            <span className="min-w-0"><span className="block truncate text-[13px] font-semibold">{entry.seriesTitle}</span>
              <span className="block text-[12px] text-ink-secondary">{t("computer.miniApps.hongguo.episodeNumber", { number: entry.episodeNumber ?? "?" })} · {time(entry.positionSeconds)}</span>
              <span className="block text-[11px] text-ink-secondary">{new Date(entry.updatedAt).toLocaleString(activeLocale())}</span></span>
          </button>
          <button type="button" onClick={() => setChoice({ action: "delete", entry })} aria-label={t("computer.miniApps.hongguo.deleteNamed", { name: entry.seriesTitle })}
            className="rounded-lg p-2 text-ink-secondary hover:bg-danger/10 hover:text-danger focus-visible:outline-2 focus-visible:outline-accent"><Trash2 size={16} /></button>
        </li>)}</ul> : <p role="status" className="py-8 text-[13px] text-ink-secondary">{t("computer.miniApps.hongguo.emptyHistory")}</p>}
    </section>}

    {page === "watch" && <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 @min-[760px]/hongguo:px-7" aria-labelledby="hongguo-watch-title">
      <header className="flex items-center gap-3 py-5">
        <button type="button" onClick={() => leaveWatch("home")} aria-label={t("computer.miniApps.hongguo.back")}
          className="rounded-lg p-2 hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent"><ArrowLeft size={17} /></button>
        <div className="min-w-0"><h2 id="hongguo-watch-title" className="truncate text-[17px] font-semibold">{series?.title ?? t("computer.miniApps.hongguo.loading")}</h2>
          {series && <p className="text-[12px] text-ink-secondary">{episode && t("computer.miniApps.hongguo.episodeNumber", { number: episode.number })}{series.episodeCount !== null && ` · ${t("computer.miniApps.hongguo.totalEpisodes", { count: series.episodeCount })}`}</p>}</div>
      </header>
      {seriesError && <p role="alert" className="rounded-lg bg-danger/10 p-3 text-[13px] text-danger">{seriesError}</p>}
      {!series && !seriesError && <p role="status" className="text-[13px] text-ink-secondary">{t("computer.miniApps.hongguo.loading")}</p>}
      {series && <div className="grid gap-6">
        <div className="min-w-0">
          <div className="flex min-h-[260px] aspect-video w-full items-center justify-center overflow-hidden rounded-xl bg-[#181818] text-center text-white">
            {playback?.status === "ready" ? <video key={`${episodeId}:${playback.mediaUrl}`} ref={videoRef} controls autoPlay={!qualityResume.current?.paused && (visible || !!window.document.fullscreenElement)} playsInline
              src={scopedMediaUrl(playback.mediaUrl, appId, revision)} className="h-full min-w-0 w-full object-contain"
              onLoadedMetadata={(event) => { const video = event.currentTarget; const saved = history?.find((entry) => entry.seriesId === series.id && entry.episodeId === episodeId);
                if (qualityResume.current && Number.isFinite(video.duration)) video.currentTime = Math.min(Math.max(0, qualityResume.current.position), video.duration);
                else if (saved && Number.isFinite(video.duration) && saved.positionSeconds < video.duration - 1) video.currentTime = saved.positionSeconds;
                if (qualityResume.current?.paused) video.pause();
                recordPosition(video); }}
              onTimeUpdate={(event) => updatePosition(event.currentTarget)}
              onPause={(event) => { recordPosition(event.currentTarget); savePosition(); }}
              onSeeked={(event) => { recordPosition(event.currentTarget); savePosition(); }}
              onEnded={(event) => { recordPosition(event.currentTarget); savePosition();
                const next = episodes[episodes.findIndex((entry) => entry.id === episodeId) + 1];
                if (autoplayNext && next) chooseEpisode(next); }}
              onError={() => setPlaybackError(t("computer.miniApps.hongguo.playbackFailed"))} />
              : <div className="max-w-xs px-6 py-10"><Clapperboard size={30} className="mx-auto mb-3 opacity-70" aria-hidden="true" />
                {history === null && historyError ? <div role="alert" className="text-[13px]">
                  <p>{historyError}</p><button type="button" onClick={() => setHistoryRetry((current) => current + 1)}
                    className="mt-2 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent">{t("computer.miniApps.preview.retry")}</button>
                </div> : <p role="status" className="text-[13px]">{playback?.status === "unavailable"
                  ? t(playback.reason === "anonymous-limited" ? "computer.miniApps.hongguo.anonymousLimited"
                    : playback.reason === "episode-unavailable" ? "computer.miniApps.hongguo.episodeUnavailable" : "computer.miniApps.hongguo.providerUnavailable")
                  : playbackError || (history === null || episode ? t("computer.miniApps.hongguo.loading") : t("computer.miniApps.hongguo.noEpisodes"))}</p>}
              </div>}
          </div>
          {playback?.status === "ready" && <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
            <span>{episode && t("computer.miniApps.hongguo.playing", { number: episode.number })}</span>
            <div className="flex min-w-0 items-center gap-2">
              {!!playback.availableQualityIds?.length && <Select size="sm" variant="quiet" aria-label={t("computer.miniApps.hongguo.quality")}
                value={pendingQuality ?? playback.selectedQualityId ?? ""} onChange={(event) => void changeQuality(event.target.value)}>
                {playback.availableQualityIds.map((id) => <option key={id} value={id}>{id}</option>)}
              </Select>}
              {pendingQuality && <span role="status" aria-label={t("computer.miniApps.hongguo.changingQuality")}><Loader2 size={13} className="animate-spin" aria-hidden="true" /></span>}
            <button type="button" onClick={() => void videoRef.current?.requestFullscreen().catch(() => setPlaybackError(t("computer.miniApps.hongguo.fullscreenFailed")))}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent"><Maximize size={13} />{t("computer.miniApps.hongguo.fullscreen")}</button>
            </div>
          </div>}
          {playbackError && playback?.status === "ready" && <p role="alert" className="mt-2 text-[12px] text-danger">{playbackError}</p>}
        </div>
        <aside className="min-w-0" aria-label={t("computer.miniApps.hongguo.episodes")}>
          <div className="flex items-center justify-between gap-2"><h3 className="text-[14px] font-semibold">{t("computer.miniApps.hongguo.episodes")}</h3>
            <label className="flex items-center gap-2 text-[11px] text-ink-secondary"><span>{t("computer.miniApps.hongguo.autoplay")}</span>
              <input type="checkbox" checked={autoplayNext} disabled={preferenceBusy} onChange={() => void changeAutoplay()} className="accent-ink" /></label></div>
          {episodes.length ? <>
            <div className="mt-3 flex flex-wrap gap-1 border-b border-hairline/60 pb-2">
              {Array.from({ length: Math.ceil(episodes.length / 30) }, (_, index) => <button key={index} type="button" aria-pressed={episodeGroup === index}
                onClick={() => setEpisodeGroup(index)} className={`rounded px-1.5 py-1 text-[11px] focus-visible:outline-2 focus-visible:outline-accent ${episodeGroup === index ? "font-semibold text-ink" : "text-ink-secondary hover:bg-inset"}`}>
                {episodes[index * 30]!.number}–{episodes[Math.min(episodes.length, (index + 1) * 30) - 1]!.number}</button>)}
            </div>
            <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(38px,1fr))] gap-1.5">
              {episodes.slice(episodeGroup * 30, (episodeGroup + 1) * 30).map((item) => <button key={item.id} type="button" disabled={history === null} onClick={() => chooseEpisode(item)}
                aria-label={t("computer.miniApps.hongguo.episodeNumber", { number: item.number })} aria-current={item.id === episodeId ? "true" : undefined}
                className={`min-h-9 rounded-lg border px-1 text-[12px] focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${item.id === episodeId ? "border-ink bg-ink font-semibold text-panel" : item.availability === "unavailable" ? "border-dashed border-hairline text-ink-secondary hover:bg-inset" : "border-transparent bg-inset hover:bg-control"}`}
                title={item.title}>{item.number}</button>)}
            </div>
            {episode?.availability === "unavailable" && <p className="mt-2 text-[11px] text-ink-secondary">{t("computer.miniApps.hongguo.episodeUnavailable")}</p>}
          </> : <p className="mt-3 text-[12px] text-ink-secondary">{t("computer.miniApps.hongguo.noEpisodes")}</p>}
          {series.summary && <div className="mt-5 border-t border-hairline/60 pt-4"><h3 className="text-[12px] font-semibold">{t("computer.miniApps.hongguo.synopsis")}</h3>
            <p className="mt-1 text-[12px] leading-5 text-ink-secondary">{series.summary}</p></div>}
        </aside>
      </div>}
    </section>}
    <ConfirmDialog open={choice !== null} pending={historyBusy} title={choice?.action === "delete" ? t("computer.miniApps.hongguo.deleteTitle") : t("computer.miniApps.hongguo.clearTitle")}
      body={choice?.action === "delete" ? t("computer.miniApps.hongguo.deleteBody", { name: choice.entry.seriesTitle }) : t("computer.miniApps.hongguo.clearBody")}
      confirmLabel={choice?.action === "delete" ? t("computer.miniApps.hongguo.delete") : t("computer.miniApps.hongguo.clear")}
      onCancel={() => setChoice(null)} onConfirm={() => void confirmHistory()} />
  </div>;
}
