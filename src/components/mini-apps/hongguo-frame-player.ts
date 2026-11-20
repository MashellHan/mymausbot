import { ApiError } from "@/state/api";
import type { HongguoPlayerBounds, HongguoPlayerEvent, HongguoPlayerPosition } from "../../../shared/hongguo-frame";
import { hongguoText as t } from "./hongguo-copy";
import { createMediaCompletionObservation, observeMediaCompletion } from "./hongguo-playback";
import { createPlaybackRestoration, needsFinalSeekability, playbackEndIsComplete, type PlaybackRestore } from "./hongguo-resume";

type PositionEvent = Exclude<HongguoPlayerEvent["type"], "error">;

export function mountHongguoPlayer({ container, iframe, playbackId, appId, revision, source, duration, bounds, restore, isCurrent, onEvent }: {
  container: HTMLElement; iframe: HTMLIFrameElement; playbackId: string; appId: string; revision: number;
  source: string; duration: number | null; bounds: HongguoPlayerBounds; restore: PlaybackRestore | null;
  isCurrent(): boolean; onEvent(event: HongguoPlayerEvent): void;
}) {
  const doc = container.ownerDocument;
  const layer = doc.createElement("div");
  const video = doc.createElement("video");
  const lifetime = new AbortController();
  const restoration = createPlaybackRestoration();
  const completion = createMediaCompletionObservation();
  const completedSource = `${source}&completed=1`;
  let slot = bounds;
  let metadataReady = false;
  let announcedReady = false;
  let fullyRead = false;
  let announcedComplete = false;
  const current = () => !lifetime.signal.aborted && isCurrent();

  layer.dataset.hongguoNativePlayer = "";
  Object.assign(layer.style, { position: "absolute", overflow: "hidden", pointerEvents: "none", zIndex: "1" });
  Object.assign(video.style, { position: "absolute", display: "block", objectFit: "contain", borderRadius: "12px", background: "#181818", pointerEvents: "auto" });
  video.lang = "zh-CN";
  video.setAttribute("aria-label", t("computer.miniApps.hongguo.title"));
  video.controls = true;
  video.playsInline = true;
  video.autoplay = !restore?.paused;
  video.preload = "auto";
  restoration.prepare(video, restore);

  const position = (): HongguoPlayerPosition | null => {
    if (!metadataReady) return null;
    const pending = restoration.pending(video);
    const positionSeconds = pending?.position ?? video.currentTime;
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) return null;
    return { positionSeconds, durationSeconds: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration,
      paused: pending?.paused ?? video.paused };
  };
  const emit = (type: PositionEvent) => {
    if (!current() || !restoration.canRecord(video)) return;
    const snapshot = position();
    if (snapshot) onEvent({ playbackId, type, ...snapshot });
  };
  const emitState = () => {
    if (!metadataReady || !restoration.canRecord(video)) return;
    if (!announcedReady) { announcedReady = true; emit("ready"); }
    if (fullyRead && !announcedComplete) { announcedComplete = true; emit("complete"); }
  };
  const observedError = (cause?: unknown) => {
    if (!current()) return;
    if (cause instanceof DOMException && cause.name === "AbortError") return;
    const status = cause instanceof ApiError ? cause.status : undefined;
    onEvent({ type: "error", playbackId, ...(status === undefined ? {} : { status }) });
  };
  const observeCompletion = () => {
    const original = () => current() && video.getAttribute("src") === source;
    const failed = (cause: unknown) => {
      if (cause instanceof ApiError || needsFinalSeekability(video, duration)) observedError(cause);
    };
    completion.observe(video, playbackId, (signal) => observeMediaCompletion(source, appId, revision, signal), original, () => {
      fullyRead = true;
      if (!needsFinalSeekability(video, duration) || video.ended && playbackEndIsComplete(video, duration)) { emitState(); return; }
      try {
        void restoration.reopen(video, duration, current, () => {
          metadataReady = false;
          video.setAttribute("src", completedSource);
        })?.catch(failed);
      } catch (cause) { failed(cause); }
    }, failed);
  };
  const on = (name: keyof HTMLMediaElementEventMap, handler: () => void) => video.addEventListener(name, () => {
    if (current()) handler();
  }, { signal: lifetime.signal });
  on("loadedmetadata", () => { metadataReady = true; restoration.metadata(video, restore); emitState(); observeCompletion(); });
  const advanceRestore = () => { restoration.duration(video); emitState(); };
  on("durationchange", advanceRestore);
  on("canplay", advanceRestore);
  on("play", () => restoration.intent(video));
  on("playing", () => { restoration.intent(video); advanceRestore(); emit("playing"); });
  on("pause", () => { restoration.intent(video); emit("paused"); });
  on("seeking", () => restoration.userSeek(video));
  on("seeked", () => emit("seeked"));
  on("timeupdate", () => emit("time"));
  on("ended", () => { if (playbackEndIsComplete(video, duration)) { advanceRestore(); emit("ended"); } });
  on("error", () => observedError());

  const resize = () => {
    const width = iframe.clientWidth, height = iframe.clientHeight;
    Object.assign(layer.style, { left: `${iframe.offsetLeft}px`, top: `${iframe.offsetTop}px`, width: `${width}px`, height: `${height}px` });
    Object.assign(video.style, { left: `${slot.x}px`, top: `${slot.y}px`, width: `${slot.width}px`, height: `${slot.height}px` });
    layer.hidden = width <= 0 || height <= 0 || slot.x >= width || slot.y >= height || slot.x + slot.width <= 0 || slot.y + slot.height <= 0;
  };
  const fullscreen = () => video.requestFullscreen();
  layer.append(video);
  container.append(layer);
  resize();
  video.setAttribute("src", source);

  return {
    position,
    resize,
    setBounds(next: HongguoPlayerBounds) { slot = next; resize(); },
    fullscreen,
    retire() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      completion.cancel();
      if (doc.fullscreenElement === video) void doc.exitFullscreen().catch(() => {});
      video.pause();
      video.removeAttribute("src");
      video.load();
      layer.remove();
    },
  };
}
