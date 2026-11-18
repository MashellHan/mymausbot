import { describe, expect, it, vi } from "vitest";
import type { HongguoEpisode, HongguoPlaybackResponse } from "../../../shared/hongguo-mini-app";
import { createNextEpisodePreparation, playbackRequest, type PlaybackKey, type PlaybackLoader } from "./hongguo-playback";

const current: PlaybackKey = { environment: "fixture", appId: "app", revision: 1, seriesId: "series", episodeId: "one" };
const episodes: HongguoEpisode[] = ["one", "two", "three"].map((id, index) => ({ id, number: index + 1,
  title: id, availability: "available", imageUrl: null }));
const ready: HongguoPlaybackResponse = { appId: "app", revision: 1, status: "ready", mediaUrl: "/synthetic",
  durationSeconds: 100, selectedQualityId: "720p", availableQualityIds: ["720p"] };

async function tick() { await Promise.resolve(); await Promise.resolve(); }

describe("one next-episode speculative consumer", () => {
  it("prepares one immediate next target only once, keeping auto policy absent", async () => {
    const preparation = createNextEpisodePreparation();
    const load = vi.fn<PlaybackLoader>(async () => ready);
    expect(load).not.toHaveBeenCalled();
    preparation.playing(current, episodes, load);
    preparation.playing(current, episodes, load);
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0]![0]).toEqual({ ...current, episodeId: "two" });
    expect(load.mock.calls[0]![2]).toBe("prefetch");
    expect(JSON.parse(JSON.stringify(playbackRequest(load.mock.calls[0]![0], "prefetch"))))
      .toEqual({ expectedRevision: 1, seriesId: "series", episodeId: "two", intent: "prefetch" });
  });

  it.each(["unavailable", "unknown"] as const)("does not speculate across an immediate %s entry", async (availability) => {
    const preparation = createNextEpisodePreparation();
    const load = vi.fn<PlaybackLoader>(async () => ready);
    preparation.playing(current, [episodes[0]!, { ...episodes[1]!, availability }, episodes[2]!], load);
    preparation.playing({ ...current, episodeId: "missing" }, episodes, load);
    await tick();
    expect(load).not.toHaveBeenCalled();
  });

  it("leaves a matching consumer attached until the authoritative foreground join settles", async () => {
    const preparation = createNextEpisodePreparation();
    let release!: (response: HongguoPlaybackResponse) => void;
    const work = new Promise<HongguoPlaybackResponse>((resolve) => { release = resolve; });
    let expensiveJobs = 0;
    const jobs = new Map<string, Promise<HongguoPlaybackResponse>>();
    const load = vi.fn<PlaybackLoader>((key) => {
      if (!jobs.has(key.episodeId)) { jobs.set(key.episodeId, work); expensiveJobs++; }
      return jobs.get(key.episodeId)!;
    });
    preparation.playing({ ...current, qualityId: "720p" }, episodes, load);
    await tick();
    const speculative = load.mock.calls[0]![1];
    const foreground = new AbortController();
    const claimed = preparation.claim({ ...current, episodeId: "two", qualityId: "720p" }, foreground.signal, load);
    expect(load.mock.calls[1]![2]).toBeUndefined();
    expect(speculative.aborted).toBe(false);
    preparation.reset();
    expect(speculative.aborted).toBe(false);
    release(ready);
    expect(await claimed).toBe(ready);
    expect(speculative.aborted).toBe(true);
    expect(expensiveJobs).toBe(1);
    expect(foreground.signal.aborted).toBe(false);
  });

  it("detaches obsolete speculation for a different foreground target and respects foreground abort", async () => {
    const preparation = createNextEpisodePreparation();
    const load = vi.fn<PlaybackLoader>(async () => ready);
    preparation.playing(current, episodes, load);
    await tick();
    const old = load.mock.calls[0]![1];
    await preparation.claim({ ...current, episodeId: "three" }, new AbortController().signal, load);
    expect(old.aborted).toBe(true);
    preparation.reset();
    preparation.playing(current, episodes, load);
    await tick();
    const shared = load.mock.calls.at(-1)![1];
    let finish!: (value: HongguoPlaybackResponse) => void;
    const held: PlaybackLoader = () => new Promise((resolve) => { finish = resolve; });
    const abort = new AbortController();
    const claimed = preparation.claim({ ...current, episodeId: "two" }, abort.signal, held);
    abort.abort();
    expect(shared.aborted).toBe(true);
    const cancelled = expect(claimed).rejects.toMatchObject({ name: "AbortError" });
    finish(ready);
    await cancelled;
  });

  it("treats speculative failure as nonblocking and does not retry repeated playing events", async () => {
    const preparation = createNextEpisodePreparation();
    const load = vi.fn<PlaybackLoader>(async (_key, _signal, intent) => {
      if (intent) throw new Error("Synthetic optional failure");
      return ready;
    });
    preparation.playing(current, episodes, load);
    await tick();
    preparation.playing(current, episodes, load);
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    expect(await preparation.claim({ ...current, episodeId: "two" }, new AbortController().signal, load)).toBe(ready);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
