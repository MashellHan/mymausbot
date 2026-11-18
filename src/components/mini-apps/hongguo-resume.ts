export type PlaybackRestore = { position: number; kind: "quality" | "history"; paused?: boolean; expectedDuration: number | null };
type Video = Pick<HTMLVideoElement, "duration" | "currentTime" | "pause" | "networkState" | "NETWORK_IDLE">;
type RestoreState = { request: PlaybackRestore | null; done: boolean; metadata: boolean; attemptedDuration?: number };

export function createPlaybackRestoration() {
  const states = new WeakMap<Video, RestoreState>();
  const apply = (video: Video) => {
    const state = states.get(video);
    if (!state || state.done) return state?.done ?? false;
    if (!state.metadata) return false;
    const request = state.request!;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    const expectedKnown = request.expectedDuration !== null && Number.isFinite(request.expectedDuration) && request.expectedDuration > 0;
    const completeDuration = expectedKnown ? duration >= request.expectedDuration! - 0.5 : video.networkState === video.NETWORK_IDLE;
    if (!completeDuration && request.position >= duration - 1) return false;
    if (state.attemptedDuration === duration) return false;
    state.attemptedDuration = duration;
    state.done = true;
    try {
      if (request.kind === "quality" || request.position < duration - 1) video.currentTime = Math.min(request.position, duration);
    } catch { state.done = false; return false; }
    if (request.paused) video.pause();
    return true;
  };
  const prepare = (video: Video, request: PlaybackRestore | null) => {
    if (!states.has(video)) {
      const valid = request && Number.isFinite(request.position) && request.position > 0 ? request : null;
      states.set(video, { request: valid, done: valid === null, metadata: false });
    }
  };
  return {
    prepare,
    metadata(video: Video, request: PlaybackRestore | null) {
      prepare(video, request);
      const state = states.get(video)!;
      if (!state.metadata && state.request?.paused) video.pause();
      state.metadata = true;
      return apply(video);
    },
    duration: apply,
    userSeek(video: Video) {
      const state = states.get(video);
      if (state) state.done = true;
      else states.set(video, { request: null, done: true, metadata: false });
    },
    pending(video: Video) { const state = states.get(video); return state && !state.done ? state.request : null; },
    canRecord(video: Video) { return states.get(video)?.done === true; },
  };
}
