export type PlaybackRestore = { position: number; kind: "quality" | "history" | "completion"; paused?: boolean; expectedDuration: number | null };
type Video = Pick<HTMLVideoElement, "duration" | "currentTime" | "paused" | "ended" | "pause" | "networkState" | "NETWORK_IDLE" | "seekable" | "readyState">;
type ReloadVideo = Video & Pick<HTMLVideoElement, "autoplay" | "play">;
type RestoreState = { request: PlaybackRestore | null; done: boolean; metadata: boolean; attempted?: string;
  reopening?: boolean; resetting?: boolean; pausedIntent?: boolean };
const known = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

function seekWindow(video: Video, target: number): [number, number] | null {
  try {
    for (let index = 0; index < video.seekable.length; index++) {
      const start = video.seekable.start(index), end = video.seekable.end(index);
      if (end > start && target >= start && target <= end) return [start, end];
    }
  } catch {}
  return null;
}

export function playbackEndIsComplete(video: Video, expected: number | null): boolean {
  return !known(expected) || Number.isFinite(video.duration) && video.duration >= expected - 0.5;
}

export function needsFinalSeekability(video: Video, expected: number | null): boolean {
  const duration = known(expected) ? expected : video.duration;
  if (!known(duration) || !playbackEndIsComplete(video, expected)) return true;
  const range = seekWindow(video, Math.max(0, duration - 0.1));
  return !range || range[0] > 0.1 || range[1] < duration - 0.5;
}

export function createPlaybackRestoration() {
  const states = new WeakMap<Video, RestoreState>();
  const apply = (video: Video) => {
    const state = states.get(video);
    if (!state || state.done) return state?.done ?? false;
    if (!state.metadata) return false;
    const request = state.request!;
    const duration = video.duration;
    if (!known(duration)) return false;
    const completeDuration = known(request.expectedDuration) ? duration >= request.expectedDuration - 0.5 : video.networkState === video.NETWORK_IDLE;
    if (!completeDuration && request.position >= duration - 1) return false;
    const target = Math.min(request.position, duration);
    const skipFinishedHistory = request.kind === "history" && request.position >= duration - 1;
    const range = skipFinishedHistory ? [0, duration] : seekWindow(video, target);
    if (!range) return false;
    const attempt = JSON.stringify([duration, target, ...range, video.readyState]);
    if (state.attempted === attempt) return false;
    state.attempted = attempt;
    state.done = true;
    try {
      if (!skipFinishedHistory && Math.abs(video.currentTime - target) > 0.05) video.currentTime = target;
    } catch { state.done = false; return false; }
    state.reopening = false;
    if (request.paused) video.pause();
    return true;
  };
  const prepare = (video: Video, request: PlaybackRestore | null) => {
    if (!states.has(video)) {
      const valid = request && Number.isFinite(request.position) && request.position >= 0
        && (request.position > 0 || request.kind === "completion") ? request : null;
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
    intent(video: Video) {
      const state = states.get(video);
      if (!state || state.resetting || video.ended) return;
      state.pausedIntent = video.paused;
      if (!state.done && state.request) state.request.paused = video.paused;
    },
    userSeek(video: Video) {
      const state = states.get(video);
      if (state?.resetting) return;
      const position = video.currentTime;
      const done = Number.isFinite(position) && position >= 0 && (position === 0 || !!seekWindow(video, position));
      const request: PlaybackRestore | null = done ? null : { position: Number.isFinite(position) && position >= 0 ? position : 0,
        kind: "completion", paused: video.paused, expectedDuration: state?.request?.expectedDuration ?? null };
      states.set(video, { ...state, request, done, metadata: state?.metadata ?? false, attempted: undefined, pausedIntent: video.paused });
    },
    reopen(video: ReloadVideo, expectedDuration: number | null, current: () => boolean, replaceSource: () => void): Promise<void> | undefined {
      if (!current()) return undefined;
      const previous = states.get(video);
      const pending = previous && !previous.done ? previous.request : null;
      const request: PlaybackRestore = { position: pending?.position ?? (Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0),
        kind: "completion", expectedDuration: expectedDuration ?? pending?.expectedDuration ?? null,
        paused: video.ended ? previous?.pausedIntent ?? video.paused : video.paused };
      const state: RestoreState = { request, done: false, metadata: false, reopening: true, resetting: true, pausedIntent: request.paused };
      states.set(video, state);
      video.autoplay = false;
      try { replaceSource(); } finally { state.resetting = false; }
      if (current() && !state.request?.paused) return video.play();
      return undefined;
    },
    reopening(video: Video) { const state = states.get(video); return !!state?.reopening && !state.done; },
    pending(video: Video) { const state = states.get(video); return state && !state.done ? state.request : null; },
    canRecord(video: Video) { return states.get(video)?.done === true; },
  };
}

export type PlaybackRestoration = ReturnType<typeof createPlaybackRestoration>;
