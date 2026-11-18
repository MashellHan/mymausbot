import { ApiError } from "@/state/api";
import type { HongguoEpisode, HongguoPlaybackResponse } from "../../../shared/hongguo-mini-app";
import { hongguoText as t } from "./hongguo-copy";

export type PlaybackKey = { environment: string | null; appId: string; revision: number;
  seriesId: string; episodeId: string; qualityId?: string };
export type PlaybackLoader = (key: PlaybackKey, signal: AbortSignal, intent?: "prefetch") => Promise<HongguoPlaybackResponse>;
const keyOf = (key: PlaybackKey) => JSON.stringify([key.environment, key.appId, key.revision, key.seriesId, key.episodeId, key.qualityId ?? null]);

export function playbackRequest(key: PlaybackKey, intent?: "prefetch") {
  return { expectedRevision: key.revision, seriesId: key.seriesId, episodeId: key.episodeId, qualityId: key.qualityId, intent };
}

export function scopedMediaUrl(value: string, appId: string, revision: number): string {
  const url = new URL(value, window.location.origin);
  const prefix = `/api/mini-apps/${encodeURIComponent(appId)}/hongguo/media/`;
  if (url.origin !== window.location.origin || url.username || url.password || !url.pathname.startsWith(prefix)
    || !/^[A-Za-z0-9_-]{1,256}$/.test(url.pathname.slice(prefix.length))
    || url.search !== `?expectedRevision=${revision}` || url.hash) {
    throw new Error(t("computer.miniApps.hongguo.playbackFailed"));
  }
  return url.pathname + url.search;
}

export async function observeMediaCompletion(mediaUrl: string, appId: string, revision: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(scopedMediaUrl(mediaUrl, appId, revision), { method: "GET", headers: { Range: "bytes=-1" },
    credentials: "same-origin", cache: "no-store", redirect: "error", signal });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try { void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {}); } catch {}
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const range = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/.exec(response.headers.get("content-range") ?? "");
    const values = range?.slice(1).map(Number);
    if (response.status !== 206 || response.headers.get("content-length") !== "1"
      || response.headers.get("accept-ranges")?.toLowerCase() !== "bytes" || !values
      || !values.every(Number.isSafeInteger) || values[2]! < 1 || values[0] !== values[2]! - 1 || values[1] !== values[0]) {
      if ([401, 403, 409].includes(response.status)) throw new ApiError(t("computer.miniApps.hongguo.playbackFailed"), response.status);
      throw new Error(t("computer.miniApps.hongguo.playbackFailed"));
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error(t("computer.miniApps.hongguo.playbackFailed"));
    const byte = await reader.read();
    signal.throwIfAborted();
    if (byte.done || byte.value.byteLength !== 1) throw new Error(t("computer.miniApps.hongguo.playbackFailed"));
    const end = await reader.read();
    signal.throwIfAborted();
    if (!end.done) throw new Error(t("computer.miniApps.hongguo.playbackFailed"));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}

export function createMediaCompletionObservation() {
  const attempts = new WeakMap<object, string>();
  let active: AbortController | null = null;
  return {
    cancel() { active?.abort(); active = null; },
    observe(video: object, owner: string, read: (signal: AbortSignal) => Promise<void>, current: () => boolean,
      complete: () => void, failed: (cause: unknown) => void) {
      if (!current() || attempts.get(video) === owner) return;
      active?.abort();
      attempts.set(video, owner);
      const controller = new AbortController();
      active = controller;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
      void Promise.resolve().then(async () => {
        if (controller.signal.aborted || !current()) return;
        await read(controller.signal);
        if (!controller.signal.aborted && current()) complete();
      }).catch((cause: unknown) => {
        if (current() && (!controller.signal.aborted || timedOut)) failed(cause);
      }).finally(() => {
        clearTimeout(timer);
        controller.abort();
        if (active === controller) active = null;
      });
    },
  };
}

export function createNextEpisodePreparation() {
  let slot: { key: string; controller: AbortController } | null = null;
  let attempted: string | null = null;
  const cancel = () => { slot?.controller.abort(); slot = null; };
  return {
    cancel,
    reset() { cancel(); attempted = null; },
    playing(current: PlaybackKey, episodes: HongguoEpisode[], load: PlaybackLoader) {
      const index = episodes.findIndex((episode) => episode.id === current.episodeId);
      const next = index >= 0 ? episodes[index + 1] : undefined;
      if (next?.availability !== "available") return;
      const key = { ...current, episodeId: next.id };
      const identity = keyOf(key);
      if (attempted === identity) return;
      cancel();
      attempted = identity;
      const controller = new AbortController();
      slot = { key: identity, controller };
      void Promise.resolve().then(() => {
        if (!controller.signal.aborted) return load(key, controller.signal, "prefetch");
      }).catch(() => {});
    },
    async claim(key: PlaybackKey, signal: AbortSignal, load: PlaybackLoader): Promise<HongguoPlaybackResponse> {
      const shared = slot?.key === keyOf(key) ? slot : null;
      if (shared) slot = null;
      else cancel();
      const detach = () => shared?.controller.abort();
      if (signal.aborted) { detach(); signal.throwIfAborted(); }
      signal.addEventListener("abort", detach, { once: true });
      try {
        signal.throwIfAborted();
        const result = await load(key, signal);
        signal.throwIfAborted();
        return result;
      } finally { signal.removeEventListener("abort", detach); detach(); }
    },
  };
}
