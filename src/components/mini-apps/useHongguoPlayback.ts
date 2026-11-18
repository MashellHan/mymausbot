import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ApiError } from "@/state/store";
import type { HongguoEpisode, HongguoPlaybackResponse, HongguoSeries } from "../../../shared/hongguo-mini-app";
import { hongguoText as t } from "./hongguo-copy";
import { createNextEpisodePreparation, playbackRequest, scopedMediaUrl, type PlaybackKey } from "./hongguo-playback";

type Resume = { position: number; paused: boolean };

export function useHongguoPlayback(options: {
  active: boolean; environment: string | null; appId: string; revision: number; seriesId: string | null;
  series: HongguoSeries | null; episode: HongguoEpisode | null; videoRef: RefObject<HTMLVideoElement | null>;
  request(body: unknown, signal: AbortSignal): Promise<HongguoPlaybackResponse>;
  showError(cause: unknown, setError: (message: string) => void): void;
  qualitySnapshot(video: HTMLVideoElement): Resume;
}) {
  const { active, environment, appId, revision, seriesId, series, episode, videoRef, request } = options;
  const callbacks = useRef(options);
  callbacks.current = options;
  const [next] = useState(createNextEpisodePreparation);
  const requestedQuality = useRef<string | undefined>(undefined);
  const foreground = useRef<AbortController | null>(null);
  const qualityController = useRef<AbortController | null>(null);
  const qualityResume = useRef<Resume | null>(null);
  const [prepared, setPrepared] = useState<{ owner: string; value: HongguoPlaybackResponse } | null>(null);
  const [playbackError, setPlaybackError] = useState("");
  const [pendingQuality, setPendingQuality] = useState<string | null>(null);
  const ownerFor = useCallback((owner: string, id: string) => JSON.stringify([environment, appId, revision, owner, id]), [environment, appId, revision]);
  const playback = active && series && episode && prepared?.owner === ownerFor(series.id, episode.id) ? prepared.value : null;
  const keyFor = useCallback((owner: string, id: string): PlaybackKey => ({ environment, appId, revision,
    seriesId: owner, episodeId: id, qualityId: requestedQuality.current }), [environment, appId, revision]);
  const load = useCallback(async (key: PlaybackKey, signal: AbortSignal, intent?: "prefetch") => {
    try {
      const result = await request(playbackRequest(key, intent), signal);
      if (result.status === "ready") scopedMediaUrl(result.mediaUrl, key.appId, key.revision);
      return result;
    } catch (cause) {
      if (intent && !signal.aborted && cause instanceof ApiError && [401, 403, 404, 409].includes(cause.status)) {
        callbacks.current.showError(cause, () => {});
      }
      throw cause;
    }
  }, [request]);

  useEffect(() => { next.reset(); requestedQuality.current = undefined; }, [next, environment, appId, revision, seriesId, active]);
  useEffect(() => () => next.reset(), [next]);
  useEffect(() => {
    qualityController.current?.abort();
    qualityResume.current = null;
    setPendingQuality(null);
    if (!active || !series || !episode) { next.reset(); setPrepared(null); return; }
    const controller = new AbortController();
    const owner = ownerFor(series.id, episode.id);
    foreground.current = controller;
    setPrepared(null); setPlaybackError("");
    if (episode.availability === "unavailable") {
      next.cancel();
      setPrepared({ owner, value: { appId, revision, status: "unavailable", reason: "episode-unavailable" } });
    } else {
      void next.claim(keyFor(series.id, episode.id), controller.signal, load).then((result) => {
        if (!controller.signal.aborted) setPrepared({ owner, value: result });
      }).catch((cause: unknown) => { if (!controller.signal.aborted) callbacks.current.showError(cause, setPlaybackError); });
    }
    return () => {
      controller.abort(); qualityController.current?.abort();
      if (foreground.current === controller) foreground.current = null;
    };
  }, [active, series, episode, appId, revision, next, keyFor, ownerFor, load]);

  const abortCurrent = useCallback(() => { foreground.current?.abort(); qualityController.current?.abort(); }, []);
  const changeQuality = async (qualityId: string) => {
    if (!series || !episode || playback?.status !== "ready" || !playback.availableQualityIds?.includes(qualityId)) return;
    qualityController.current?.abort();
    setPendingQuality(null);
    next.cancel();
    if (qualityId === playback.selectedQualityId) { requestedQuality.current = qualityId; foreground.current = null; return; }
    foreground.current?.abort();
    const controller = new AbortController();
    qualityController.current = controller;
    setPendingQuality(qualityId); setPlaybackError("");
    try {
      const result = await load({ ...keyFor(series.id, episode.id), qualityId }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status !== "ready") { setPlaybackError(t("computer.miniApps.hongguo.qualityUnavailable")); return; }
      const video = videoRef.current;
      if (video) qualityResume.current = callbacks.current.qualitySnapshot(video);
      requestedQuality.current = qualityId;
      foreground.current = controller;
      setPrepared({ owner: ownerFor(series.id, episode.id), value: result });
    } catch (cause) { if (!controller.signal.aborted) callbacks.current.showError(cause, setPlaybackError); }
    finally { if (qualityController.current === controller) { qualityController.current = null; if (!controller.signal.aborted) setPendingQuality(null); } }
  };
  const onPlaying = () => {
    if (active && series?.id === seriesId && episode && playback?.status === "ready" && !pendingQuality
      && !foreground.current?.signal.aborted) next.playing(keyFor(series.id, episode.id), series.episodes, load);
  };
  return { playback, playbackError, setPlaybackError, pendingQuality, qualityResume, changeQuality, onPlaying,
    abortCurrent, resetSpeculation: next.reset };
}
