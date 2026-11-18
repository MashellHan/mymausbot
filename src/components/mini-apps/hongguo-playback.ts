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
    || url.pathname.length === prefix.length || url.searchParams.getAll("expectedRevision").length !== 1
    || url.searchParams.get("expectedRevision") !== String(revision) || url.hash) {
    throw new Error(t("computer.miniApps.hongguo.playbackFailed"));
  }
  return url.pathname + url.search;
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
