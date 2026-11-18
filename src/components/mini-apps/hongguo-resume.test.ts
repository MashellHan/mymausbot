import { describe, expect, it, vi } from "vitest";
import { createPlaybackRestoration, needsFinalSeekability, playbackEndIsComplete, type PlaybackRestore } from "./hongguo-resume";

function video() {
  let position = 0, duration = Infinity, paused = true, ready = 4;
  let ranges: [number, number][] | null = null;
  const seeks: number[] = [];
  return { networkState: 2, NETWORK_IDLE: 1 as const, ended: false, autoplay: true, seeks,
    get duration() { return duration; }, set duration(value: number) { duration = value; },
    get readyState() { return ready; }, set readyState(value: number) { ready = value; },
    get paused() { return paused; }, set paused(value: boolean) { paused = value; },
    get seekable() { const selected = ranges ?? (Number.isFinite(duration) ? [[0, duration]] : []);
      return { length: selected.length, start: (index: number) => selected[index]![0]!, end: (index: number) => selected[index]![1]! }; },
    ranges(value: [number, number][] | null) { ranges = value; },
    pause: vi.fn(() => { paused = true; }), play: vi.fn(async () => { paused = false; }),
    load: vi.fn(() => { position = 0; duration = NaN; ready = 0; paused = true; }),
    get currentTime() { return position; }, set currentTime(value: number) { position = value; seeks.push(value); } };
}
const request: PlaybackRestore = { position: 31, kind: "quality", paused: true, expectedDuration: 100 };

describe("one pending resume for a growing ordinary video", () => {
  it("waits through nonfinite/partial durations, restores once and preserves paused intent", () => {
    const restore = createPlaybackRestoration(), media = video();
    expect(restore.metadata(media, request)).toBe(false);
    expect(restore.canRecord(media)).toBe(false);
    expect(media.pause).toHaveBeenCalled();
    media.duration = 2;
    expect(restore.duration(media)).toBe(false);
    media.duration = 60;
    expect(restore.duration(media)).toBe(true);
    expect(media.currentTime).toBe(31);
    expect(restore.canRecord(media)).toBe(true);
    media.duration = 100;
    restore.duration(media);
    restore.metadata(media, request);
    expect(media.seeks).toEqual([31]);
  });

  it("does not treat network idle as full duration when the known source is still growing", () => {
    const restore = createPlaybackRestoration(), media = video();
    media.duration = 2;
    media.networkState = media.NETWORK_IDLE;
    expect(restore.metadata(media, { position: 60, kind: "quality", paused: true, expectedDuration: 108 })).toBe(false);
    expect(media.seeks).toEqual([]);
    expect(restore.canRecord(media)).toBe(false);
    media.duration = 108;
    expect(restore.duration(media)).toBe(true);
    expect(media.seeks).toEqual([60]);
    restore.duration(media);
    expect(media.seeks).toEqual([60]);
  });

  it("does not overwrite a user seek while the requested restoration is waiting", () => {
    const restore = createPlaybackRestoration(), media = video();
    restore.metadata(media, request);
    restore.userSeek(media);
    media.currentTime = 17;
    media.duration = 100;
    restore.duration(media);
    restore.metadata(media, request);
    expect(media.seeks).toEqual([17]);
    expect(restore.canRecord(media)).toBe(true);
  });

  it("also honors a user seek made before metadata", () => {
    const restore = createPlaybackRestoration(), media = video();
    restore.userSeek(media);
    media.currentTime = 12;
    media.duration = 100;
    restore.metadata(media, request);
    expect(media.seeks).toEqual([12]);
  });

  it("keeps completed near-end history from restarting and clamps a quality position only when duration is known", () => {
    const restore = createPlaybackRestoration(), media = video();
    media.duration = 100;
    restore.metadata(media, { position: 99.5, kind: "history", expectedDuration: 100 });
    expect(media.seeks).toEqual([]);
    const quality = video();
    quality.duration = 100;
    restore.metadata(quality, { position: 120, kind: "quality", expectedDuration: 100 });
    expect(quality.seeks).toEqual([100]);
  });

  it("waits for a usable seek range even when partial duration covers the saved target", () => {
    const restore = createPlaybackRestoration(), media = video();
    media.duration = 65; media.networkState = media.NETWORK_IDLE; media.ranges([]);
    expect(restore.metadata(media, { position: 60, kind: "quality", paused: true, expectedDuration: 108 })).toBe(false);
    expect(media.seeks).toEqual([]);
    expect(needsFinalSeekability(media, 108)).toBe(true);
    expect(playbackEndIsComplete(media, 108)).toBe(false);
    restore.reopen(media, 108, () => true);
    expect(media.load).toHaveBeenCalledTimes(1);
    expect(restore.canRecord(media)).toBe(false);
    expect(restore.pending(media)?.position).toBe(60);
    media.duration = 108; media.readyState = 4; media.ranges([[0, 108]]);
    restore.metadata(media, null);
    expect(media.seeks).toEqual([60]);
    expect(media.paused).toBe(true);
    expect(media.play).not.toHaveBeenCalled();
    expect(needsFinalSeekability(media, 108)).toBe(false);
    restore.duration(media); restore.metadata(media, null);
    expect(media.seeks).toEqual([60]);
  });

  it("carries a later user seek through reset-to-zero without restoring the older history target", () => {
    const restore = createPlaybackRestoration(), media = video();
    media.duration = 65; media.ranges([]);
    restore.metadata(media, { position: 60, kind: "history", expectedDuration: 108 });
    media.currentTime = 17; restore.userSeek(media);
    expect(restore.canRecord(media)).toBe(false);
    restore.reopen(media, 108, () => true);
    expect(media.currentTime).toBe(0);
    expect(restore.pending(media)?.position).toBe(17);
    media.duration = 108; media.readyState = 4; media.ranges([[0, 108]]);
    restore.metadata(media, null); restore.duration(media);
    expect(media.seeks).toEqual([17, 17]);
    expect(media.currentTime).toBe(17);
  });

  it.each([true, false])("keeps latest pause/play intent after the reopen starts, initially paused=%s", (paused) => {
    const restore = createPlaybackRestoration(), media = video();
    media.duration = 108; media.currentTime = 60; media.ranges([]); media.paused = paused;
    restore.prepare(media, null); restore.intent(media);
    restore.reopen(media, 108, () => true);
    if (paused) void media.play(); else media.pause();
    restore.intent(media);
    media.duration = 108; media.readyState = 4; media.ranges([[0, 108]]);
    restore.metadata(media, null);
    expect(media.currentTime).toBe(60);
    expect(media.paused).toBe(!paused);
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("lets a user seek made during reopen win without a second successful seek", () => {
    const restore = createPlaybackRestoration(), media = video();
    media.duration = 108; media.currentTime = 60; media.ranges([]);
    restore.prepare(media, null); restore.reopen(media, 108, () => true);
    media.currentTime = 23; restore.userSeek(media);
    media.duration = 108; media.readyState = 4; media.ranges([[0, 108]]);
    restore.metadata(media, null); restore.duration(media);
    expect(media.seeks).toEqual([60, 23]);
    expect(media.currentTime).toBe(23);
  });

  it("does not reopen stale scope or mistake an early EOF for full playback", () => {
    const restore = createPlaybackRestoration(), media = video();
    media.duration = 65; media.ended = true; media.paused = false;
    restore.prepare(media, null); media.ended = false; restore.intent(media); media.ended = true;
    expect(playbackEndIsComplete(media, 108)).toBe(false);
    restore.reopen(media, 108, () => false);
    expect(media.load).not.toHaveBeenCalled();
    restore.reopen(media, 108, () => true);
    expect(media.play).toHaveBeenCalledTimes(1);
  });

  it("records normal media without a resume request and never calls play", () => {
    const restore = createPlaybackRestoration(), media = video();
    expect(restore.metadata(media, null)).toBe(true);
    expect(restore.canRecord(media)).toBe(true);
    expect(media.seeks).toEqual([]);
    expect(media.pause).not.toHaveBeenCalled();
  });
});
