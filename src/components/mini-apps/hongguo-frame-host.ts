import { api, ApiError } from "@/state/api";
import { utf8Bytes } from "../../../shared/app";
import { type HongguoFrameContext, type HongguoFrameNotice, type HongguoFramePlayback,
  type HongguoFrameReply, type HongguoPlayerBounds, type HongguoPlayerPosition, type HongguoPlayerRestore } from "../../../shared/hongguo-frame";
import { matchesMiniAppReleasePackage } from "../../../shared/mini-app-release-packages";
import type { HongguoCatalogResponse, HongguoHistoryEntry, HongguoHistoryResponse, HongguoPlaybackResponse,
  HongguoSeries, HongguoSeriesResponse } from "../../../shared/hongguo-mini-app";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { mountHongguoPlayer } from "./hongguo-frame-player";
import { scopedMediaUrl } from "./hongguo-playback";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

const MAX_COVER_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1_000_000;
const MAX_REQUEST_BYTES = 16_384;
const MAX_DATA_READS_PER_MINUTE = 240;
const MAX_PENDING_NETWORK_REQUESTS = 32;
const MAX_FRAME_PX = 16_384;
const MAX_SECONDS = 1_000_000_000;
const HANDLE = /^[\da-f-]{36}$/;
const JSON_OPERATIONS = new Set(["catalog", "series", "playback", "history", "preferences"]);
const PLAYER_OPERATIONS = new Set(["player.attach", "player.setBounds", "player.detach", "player.fullscreen"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function parseBounds(value: unknown): HongguoPlayerBounds | null {
  if (!record(value) || Object.keys(value).length !== 4) return null;
  const { x, y, width, height } = value;
  return bounded(x, -MAX_FRAME_PX, MAX_FRAME_PX) && bounded(y, -MAX_FRAME_PX, MAX_FRAME_PX)
    && bounded(width, 1, MAX_FRAME_PX) && bounded(height, 1, MAX_FRAME_PX) ? { x, y, width, height } : null;
}
function parseRestore(value: unknown): HongguoPlayerRestore | null {
  if (!record(value) || !bounded(value.positionSeconds, 0, MAX_SECONDS)) return null;
  if (value.kind === "history" && Object.keys(value).length === 2) return { kind: "history", positionSeconds: value.positionSeconds };
  if (value.kind === "quality" && Object.keys(value).length === 4 && typeof value.fromPlaybackId === "string"
      && HANDLE.test(value.fromPlaybackId) && typeof value.paused === "boolean") {
    return { kind: "quality", fromPlaybackId: value.fromPlaybackId, positionSeconds: value.positionSeconds, paused: value.paused };
  }
  return null;
}
function fail(status: number): never { throw new ApiError("Hongguo request unavailable.", status); }

export function isManagedHongguoDocument(document: MiniAppDocument | null): boolean {
  if (!document || document.app.status !== "active" || document.app.nativeIdentity !== "hongguo"
    || document.app.nativeKind !== "hongguo" || document.bindings.length !== 0) return false;
  return matchesMiniAppReleasePackage("hongguo", document.app.release);
}

type ReadyPlayback = { source: string; durationSeconds: number | null; entry: Omit<HongguoHistoryEntry, "updatedAt" | "positionSeconds" | "durationSeconds"> };
type PlaybackPosition = HongguoPlayerPosition & { playbackId: string; playback: ReadyPlayback };
type Scope = { visible: boolean; refreshKey: number };

export function mountManagedHongguoFrame({ container, iframe, document, getState, onRefused, isInitialized, visible, refreshKey }: {
  container: HTMLElement; iframe: HTMLIFrameElement; document: MiniAppDocument; getState(): MiniAppState;
  onRefused(status: number): void; isInitialized(): boolean; visible: boolean; refreshKey: number;
}) {
  const { app } = document;
  const doc = iframe.ownerDocument;
  const win = doc.defaultView!;
  const frame = iframe.contentWindow;
  const srcdoc = iframe.srcdoc;
  const endpoint = `/api/mini-apps/${encodeURIComponent(app.id)}/hongguo/`;
  const eligible = isManagedHongguoDocument(document);
  const covers = new Map<string, string>();
  const seriesById = new Map<string, HongguoSeries>();
  const handles = new Map<string, ReadyPlayback>();
  const pending = new Map<string, { controller: AbortController; saveProgress: boolean }>();
  const observations = new Map<string, PlaybackPosition>();
  let recentReads: number[] = [];
  let scope: Scope = { visible, refreshKey };
  let visibleBefore = false;
  let active = true;
  let deniedStatus: number | null = null;
  let player: { playbackId: string; playback: ReadyPlayback; native: ReturnType<typeof mountHongguoPlayer> } | null = null;
  let lastRetired: { playbackId: string; playback: ReadyPlayback } | null = null;
  let wasFullscreen = false;
  let enteringFullscreen = false;
  let fullscreenGuardSent = false;
  let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let sawExitHidden = false;
  const clearExitGrace = () => {
    if (exitGraceTimer !== null) { clearTimeout(exitGraceTimer); exitGraceTimer = null; }
    sawExitHidden = false;
  };
  const previousPosition = container.style.position;
  const anchored = win.getComputedStyle(container).position === "static";
  if (anchored) container.style.position = "relative";

  const available = () => {
    const state = getState();
    return active && eligible && deniedStatus === null && iframe.parentNode === container && iframe.srcdoc === srcdoc
      && frame !== null && iframe.contentWindow === frame && miniAppNativeFrameGuard() && win.ogb?.app?.ownPage === true
      && win.ogb?.remoteClient?.active !== true && state.appId === app.id && state.revision === app.revision
      && state.templateVersion === app.templateVersion && state.status === "active";
  };
  const fullscreenPreserved = () => Boolean(player?.native.isFullscreen() || enteringFullscreen || exitGraceTimer !== null);
  const showing = () => available() && scope.visible && (doc.visibilityState !== "hidden" || fullscreenPreserved())
    && iframe.clientWidth > 0 && iframe.clientHeight > 0;
  const context = (): HongguoFrameContext => ({ appId: app.id, revision: app.revision, visible: showing(), refreshKey: scope.refreshKey });
  const post = (message: HongguoFrameReply | HongguoFrameNotice) => {
    if (active && iframe.contentWindow === frame && iframe.parentNode === container && iframe.srcdoc === srcdoc) frame?.postMessage(message, "*");
  };
  const syncFullscreenNotice = () => {
    const guard = active && fullscreenPreserved();
    if (guard === fullscreenGuardSent) return;
    fullscreenGuardSent = guard;
    if (isInitialized()) post({ mausMiniApp: 1, type: "hongguo-fullscreen", active: guard });
  };
  const sendError = (id: string, status: number) => post({ mausMiniApp: 1, type: "hongguo-result", id, error: { status } });
  const cancel = (status?: number) => {
    for (const [id, request] of pending) {
      if (status === undefined && request.saveProgress) continue;
      request.controller.abort(); pending.delete(id);
      if (status === undefined) post({ mausMiniApp: 1, type: "hongguo-result", id, error: { aborted: true } });
      else sendError(id, status);
    }
  };
  const positionKey = (entry: { seriesId: string; episodeId: string }) => JSON.stringify([entry.seriesId, entry.episodeId]);
  const rememberPosition = (playbackId: string, playback: ReadyPlayback, position: HongguoPlayerPosition) => {
    const key = positionKey(playback.entry);
    observations.delete(key);
    observations.set(key, { playbackId, playback, ...position });
    while (observations.size > 4) observations.delete(observations.keys().next().value!);
  };
  const retirePlayer = () => {
    clearExitGrace();
    wasFullscreen = false;
    enteringFullscreen = false;
    syncFullscreenNotice();
    const attached = player;
    if (!attached) return;
    player = null;
    lastRetired = { playbackId: attached.playbackId, playback: attached.playback };
    handles.delete(attached.playbackId);
    const position = attached.native.position();
    if (position) rememberPosition(attached.playbackId, attached.playback, position);
    attached.native.retire();
  };
  const invalidate = (status: number) => {
    if (deniedStatus !== null) return;
    deniedStatus = status;
    cancel(status); retirePlayer(); lastRetired = null; handles.clear(); observations.clear(); covers.clear(); seriesById.clear();
  };
  const syncScope = (force = false) => {
    if (!active) return;
    if (!available()) { invalidate(409); return; }
    syncFullscreenNotice();
    const next = showing();
    if (next !== visibleBefore || force) {
      if (!next || force) { cancel(); retirePlayer(); lastRetired = null; handles.clear(); }
      visibleBefore = next;
      if (isInitialized()) post({ mausMiniApp: 1, type: "hongguo-context", context: context() });
    }
    if (next) player?.native.resize();
  };
  visibleBefore = showing();
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => syncScope()) : null;
  resizeObserver?.observe(iframe);
  const onVisibility = () => {
    if (exitGraceTimer !== null) {
      if (doc.visibilityState === "hidden") sawExitHidden = true;
      else if (sawExitHidden && doc.visibilityState === "visible") clearExitGrace();
    }
    syncScope();
  };
  const onFullscreenChange = () => {
    const nowFs = Boolean(player?.native.isFullscreen());
    enteringFullscreen = false;
    if (wasFullscreen && !nowFs) {
      clearExitGrace();
      // macOS Space transition briefly hides the window after fullscreenchange already cleared fullscreenElement.
      exitGraceTimer = setTimeout(() => {
        exitGraceTimer = null;
        sawExitHidden = false;
        syncScope();
      }, 1_500);
    } else if (nowFs) {
      clearExitGrace();
    }
    wasFullscreen = nowFs;
    syncScope();
  };
  const onResize = () => syncScope();
  doc.addEventListener("visibilitychange", onVisibility);
  doc.addEventListener("fullscreenchange", onFullscreenChange);
  win.addEventListener("resize", onResize);

  const rememberCover = (seriesId: string, coverUrl: string | null) => {
    if (!coverUrl) return;
    covers.delete(seriesId); covers.set(seriesId, coverUrl);
    while (covers.size > 1_024) covers.delete(covers.keys().next().value!);
  };
  const runJson = async (operation: string, input: Record<string, unknown>, signal: AbortSignal) => {
    let body = input;
    if (operation === "history" && input.action === "save") {
      const entry = input.entry;
      if (Object.keys(input).length !== 2 || !record(entry) || typeof entry.seriesId !== "string" || typeof entry.episodeId !== "string") return fail(400);
      const key = positionKey({ seriesId: entry.seriesId, episodeId: entry.episodeId });
      const observed = observations.get(key);
      if (!observed || !bounded(entry.positionSeconds, 0, MAX_SECONDS)) return fail(400);
      body = { action: "save", entry: { ...observed.playback.entry,
        positionSeconds: observed.positionSeconds, durationSeconds: observed.durationSeconds } };
    }
    if (operation === "history" && (input.action === "delete" || input.action === "clear") && win.navigator.userActivation?.isActive !== true) return fail(412);
    const series = operation === "playback" && typeof input.seriesId === "string" ? seriesById.get(input.seriesId) : undefined;
    const episode = series?.episodes.find((item) => item.id === input.episodeId);
    if (operation === "playback" && (!series || !episode || episode.availability === "unavailable")) return fail(400);
    const result = await api<Record<string, unknown>>(`${endpoint}${operation}`, {
      method: "POST", body: JSON.stringify({ ...body, expectedRevision: app.revision }), signal, redirect: "error",
      timeoutMs: operation === "playback" ? 120_000 : 10_000,
    });
    signal.throwIfAborted();
    if (!available() || result.appId !== app.id || result.revision !== app.revision) return fail(409);
    if (utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) return fail(413);
    if (operation === "catalog") {
      for (const card of (result as unknown as HongguoCatalogResponse).items) rememberCover(card.id, card.coverUrl);
    } else if (operation === "series") {
      const current = (result as unknown as HongguoSeriesResponse).series;
      if (current.id !== input.seriesId) return fail(409);
      rememberCover(current.id, current.coverUrl);
      seriesById.delete(current.id); seriesById.set(current.id, current);
      while (seriesById.size > 4) seriesById.delete(seriesById.keys().next().value!);
    } else if (operation === "history") {
      if (input.action === "clear") observations.clear();
      if (input.action === "delete") {
        for (const [key, observed] of observations) {
          if (observed.playback.entry.seriesId === input.seriesId) observations.delete(key);
        }
      }
      for (const entry of (result as unknown as HongguoHistoryResponse).entries) rememberCover(entry.seriesId, entry.coverUrl);
    } else if (operation === "playback") {
      const playback = result as unknown as HongguoPlaybackResponse;
      if (playback.status === "unavailable") {
        return { appId: playback.appId, revision: playback.revision, status: playback.status, reason: playback.reason } satisfies HongguoFramePlayback;
      }
      if (playback.status !== "ready" || !series || !episode) return fail(503);
      const source = scopedMediaUrl(playback.mediaUrl, app.id, app.revision);
      const playbackId = win.crypto.randomUUID();
      handles.set(playbackId, { source, durationSeconds: playback.durationSeconds, entry: { seriesId: series.id,
        seriesTitle: series.title, coverUrl: series.coverUrl, episodeId: episode.id, episodeTitle: episode.title, episodeNumber: episode.number } });
      for (const key of handles.keys()) {
        if (handles.size <= 8) break;
        if (key !== player?.playbackId) handles.delete(key);
      }
      return { appId: playback.appId, revision: playback.revision, status: playback.status, playbackId,
        durationSeconds: playback.durationSeconds, selectedQualityId: playback.selectedQualityId,
        availableQualityIds: playback.availableQualityIds } satisfies HongguoFramePlayback;
    }
    return result;
  };
  const readCover = async (input: Record<string, unknown>, signal: AbortSignal) => {
    const { seriesId, coverUrl } = input;
    if (Object.keys(input).length !== 2 || typeof seriesId !== "string" || typeof coverUrl !== "string" || covers.get(seriesId) !== coverUrl) return fail(400);
    const response = await fetch(`${endpoint}cover?${new URLSearchParams({ expectedRevision: String(app.revision), url: coverUrl })}`, {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) return fail(response.status);
    const mimeType = response.headers.get("content-type");
    const length = Number(response.headers.get("content-length"));
    if (mimeType !== "image/jpeg" || !Number.isSafeInteger(length) || length < 4 || length > MAX_COVER_BYTES) {
      await response.body?.cancel(); return fail(413);
    }
    const reader = response.body?.getReader();
    if (!reader) return fail(503);
    const bytes = new Uint8Array(length);
    let offset = 0;
    try {
      for (;;) {
        const packet = await reader.read();
        if (packet.done) break;
        if (offset + packet.value.length > length) return fail(413);
        bytes.set(packet.value, offset); offset += packet.value.length;
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (offset !== length || bytes[0] !== 0xff || bytes[1] !== 0xd8) return fail(503);
    return { mimeType, bytes: bytes.buffer };
  };
  const runPlayer = (operation: string, input: Record<string, unknown>) => {
    const { playbackId } = input;
    if (typeof playbackId !== "string" || !HANDLE.test(playbackId)) return fail(400);
    if (operation === "player.detach") {
      if (Object.keys(input).length !== 1) return fail(400);
      handles.delete(playbackId);
      if (player?.playbackId === playbackId) retirePlayer();
      return;
    }
    if (operation === "player.fullscreen") {
      if (Object.keys(input).length !== 1) return fail(400);
      if (player?.playbackId !== playbackId) return fail(412);
      enteringFullscreen = true;
      syncFullscreenNotice();
      return Promise.resolve(player.native.fullscreen()).catch((cause) => {
        enteringFullscreen = false;
        syncFullscreenNotice();
        throw cause;
      });
    }
    const bounds = parseBounds(input.bounds);
    if (!bounds) return fail(400);
    if (operation === "player.setBounds") {
      if (Object.keys(input).length !== 2) return fail(400);
      if (player?.playbackId !== playbackId) return fail(412);
      player.native.setBounds(bounds);
      return;
    }
    const restore = input.restore === undefined ? null : parseRestore(input.restore);
    if (Object.keys(input).length !== (restore ? 3 : 2) || input.restore !== undefined && !restore) return fail(400);
    const playback = handles.get(playbackId);
    if (!playback || player?.playbackId === playbackId) return fail(412);
    const { durationSeconds: expectedDuration, entry } = playback;
    const previous = player ?? lastRetired;
    if (restore?.kind === "quality" && (previous?.playbackId !== restore.fromPlaybackId
      || positionKey(previous.playback.entry) !== positionKey(entry))) return fail(412);
    retirePlayer();
    const prior = observations.get(positionKey(entry));
    const exact = restore?.kind === "quality" && prior?.playbackId === restore.fromPlaybackId ? prior : null;
    const request = restore ? { position: exact?.positionSeconds ?? restore.positionSeconds,
      kind: restore.kind, paused: restore.kind === "quality" ? exact?.paused ?? restore.paused : undefined, expectedDuration } : null;
    const native = mountHongguoPlayer({ container, iframe, playbackId, appId: app.id, revision: app.revision, source: playback.source,
      duration: expectedDuration, bounds, restore: request,
      isCurrent: () => player?.playbackId === playbackId && showing(),
      onEvent: (event) => {
        if (event.type !== "error") rememberPosition(playbackId, playback, event);
        else if (event.status === 401 || event.status === 403 || event.status === 409) {
          post({ mausMiniApp: 1, type: "hongguo-player-event", event });
          invalidate(event.status); onRefused(event.status); return;
        }
        post({ mausMiniApp: 1, type: "hongguo-player-event", event });
      },
    });
    player = { playbackId, playback, native };
  };
  const handle = (event: MessageEvent) => {
    if (!active || frame === null || event.source !== frame || event.origin !== "null"
      || !isInitialized() || !record(event.data) || event.data.mausMiniApp !== 1) return;
    const { type, id, operation, input } = event.data;
    if (typeof id !== "string" || !/^hongguo:\d{1,12}$/.test(id)) return;
    if (type === "hongguo-cancel" && Object.keys(event.data).length === 3) {
      pending.get(id)?.controller.abort(); pending.delete(id); return;
    }
    if (type !== "hongguo-request") return;
    if (!available()) { sendError(id, deniedStatus ?? 409); return; }
    if (Object.keys(event.data).length !== 5 || typeof operation !== "string" || !record(input)
        || "expectedRevision" in input || "appId" in input || "revision" in input) { sendError(id, 400); return; }
    const success = (result: unknown) => post({ mausMiniApp: 1, type: "hongguo-result", id, result });
    if (operation === "context" && !Object.keys(input).length) { success(context()); return; }
    const saveProgress = operation === "history" && input.action === "save";
    if (!showing() && !saveProgress) {
      post({ mausMiniApp: 1, type: "hongguo-result", id, error: { aborted: true } }); return;
    }
    const failed = (cause: unknown) => {
      const status = cause instanceof ApiError ? cause.status : 503;
      sendError(id, status);
      if (status === 401 || status === 403 || status === 404 || status === 409) { invalidate(status); onRefused(status); }
    };
    if (PLAYER_OPERATIONS.has(operation)) {
      try { void Promise.resolve(runPlayer(operation, input)).then(() => { if (available()) success(null); }, failed); }
      catch (cause) { failed(cause); }
      return;
    }
    if (!JSON_OPERATIONS.has(operation) && operation !== "cover") { sendError(id, 400); return; }
    if (pending.has(id)) return;
    try { if (utf8Bytes(JSON.stringify(input)) > MAX_REQUEST_BYTES) { sendError(id, 413); return; } }
    catch { sendError(id, 400); return; }
    const now = Date.now();
    recentReads = recentReads.filter(at => now - at < 60_000);
    if (recentReads.length >= MAX_DATA_READS_PER_MINUTE || pending.size >= MAX_PENDING_NETWORK_REQUESTS) { sendError(id, 429); return; }
    recentReads.push(now);
    const controller = new AbortController();
    pending.set(id, { controller, saveProgress });
    const execute = operation === "cover" ? readCover(input, controller.signal) : runJson(operation, input, controller.signal);
    void execute.then(result => {
      if (controller.signal.aborted) return;
      if (!available()) sendError(id, 409);
      else if (showing() || saveProgress) success(result);
      else post({ mausMiniApp: 1, type: "hongguo-result", id, error: { aborted: true } });
    }).catch(cause => {
      if (!controller.signal.aborted) failed(cause);
    }).finally(() => { if (pending.get(id)?.controller === controller) pending.delete(id); });
  };
  win.addEventListener("message", handle);
  return {
    update(next: Scope) {
      const refreshed = scope.refreshKey !== next.refreshKey;
      scope = next; syncScope(refreshed);
    },
    retire() {
      if (!active) return;
      invalidate(409);
      active = false;
      resizeObserver?.disconnect();
      doc.removeEventListener("visibilitychange", onVisibility);
      doc.removeEventListener("fullscreenchange", onFullscreenChange);
      win.removeEventListener("resize", onResize);
      win.removeEventListener("message", handle);
      if (anchored) container.style.position = previousPosition;
    },
  };
}
