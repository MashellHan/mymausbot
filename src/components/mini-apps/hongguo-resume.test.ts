import { describe, expect, it, vi } from "vitest";
import { createPlaybackRestoration, type PlaybackRestore } from "./hongguo-resume";

function video() {
  let position = 0;
  const seeks: number[] = [];
  return { duration: Infinity, networkState: 2, NETWORK_IDLE: 1 as const, pause: vi.fn(), seeks,
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

  it("records normal media without a resume request and never calls play", () => {
    const restore = createPlaybackRestoration(), media = video();
    expect(restore.metadata(media, null)).toBe(true);
    expect(restore.canRecord(media)).toBe(true);
    expect(media.seeks).toEqual([]);
    expect(media.pause).not.toHaveBeenCalled();
  });
});
