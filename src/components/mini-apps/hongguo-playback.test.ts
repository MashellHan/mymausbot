// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HongguoEpisode, HongguoPlaybackResponse } from "../../../shared/hongguo-mini-app";
import { createMediaCompletionObservation, createNextEpisodePreparation, observeMediaCompletion, playbackRequest, type PlaybackKey, type PlaybackLoader } from "./hongguo-playback";

const current: PlaybackKey = { environment: "fixture", appId: "app", revision: 1, seriesId: "series", episodeId: "one" };
const episodes: HongguoEpisode[] = ["one", "two", "three"].map((id, index) => ({ id, number: index + 1,
  title: id, availability: "available", imageUrl: null }));
const ready: HongguoPlaybackResponse = { appId: "app", revision: 1, status: "ready", mediaUrl: "/synthetic",
  durationSeconds: 100, selectedQualityId: "720p", availableQualityIds: ["720p"] };

async function tick() { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const mediaUrl = "/api/mini-apps/app/hongguo/media/same-token?expectedRevision=1";
const completionHeaders = { "content-length": "1", "content-range": "bytes 9-9/10", "accept-ranges": "bytes" };

describe("one bounded same-token completion response", () => {
  it("uses normal same-origin authentication and requires one206 byte then EOF", async () => {
    const response = new Response(new Uint8Array([9]), { status: 206, headers: completionHeaders });
    const request = vi.fn(async () => response);
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    await observeMediaCompletion(mediaUrl, "app", 1, controller.signal);
    expect(request).toHaveBeenCalledExactlyOnceWith(mediaUrl, expect.objectContaining({ method: "GET", headers: { Range: "bytes=-1" },
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal }));
    expect(response.body!.locked).toBe(false);
  });

  it("cancels an unexpected whole200 without reading any body", async () => {
    const cancel = vi.fn(async () => {}), getReader = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, headers: new Headers(completionHeaders), body: { cancel, getReader } })));
    await expect(observeMediaCompletion(mediaUrl, "app", 1, new AbortController().signal)).rejects.toThrow();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["bytes 0-0/*", "bytes 8-8/10", "bytes 8-9/10", "bytes 9/10", "bytes 9007199254740992-9007199254740992/9007199254740993"])(
    "rejects non-final or unbounded Content-Range %s before reading", async (range) => {
      const cancel = vi.fn(async () => {}), getReader = vi.fn();
      vi.stubGlobal("fetch", vi.fn(async () => ({ status: 206, headers: new Headers({ ...completionHeaders, "content-range": range }), body: { cancel, getReader } })));
      await expect(observeMediaCompletion(mediaUrl, "app", 1, new AbortController().signal)).rejects.toThrow();
      expect(getReader).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
    });

  it.each([0, 1, 2])("bounds actual206 body shape %s and releases its reader", async (kind) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      if (kind === 0) controller.close();
      else if (kind === 1) controller.enqueue(new Uint8Array([1, 2]));
      else { controller.enqueue(new Uint8Array([1])); controller.enqueue(new Uint8Array([2])); }
    }, cancel });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 206, headers: completionHeaders })));
    await expect(observeMediaCompletion(mediaUrl, "app", 1, new AbortController().signal)).rejects.toThrow();
    expect(body.locked).toBe(false);
    if (kind) expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending body read and does not request another URL", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = vi.fn(async () => new Response(body, { status: 206, headers: completionHeaders }));
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    const pending = observeMediaCompletion(mediaUrl, "app", 1, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1); expect(body.locked).toBe(false); expect(request).toHaveBeenCalledTimes(1);
  });

  it("never forwards another app/revision or cross-origin media URL", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    for (const url of [mediaUrl, "https://other.invalid" + mediaUrl]) {
      await expect(observeMediaCompletion(url, "other-app", 2, new AbortController().signal)).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
});

describe("one observation per current native media", () => {
  it("waits for one completion, invokes at most one reopen and releases the scope", async () => {
    const observation = createMediaCompletionObservation(), video = {};
    let release!: () => void;
    const read = vi.fn((_signal: AbortSignal) => new Promise<void>((resolve) => { release = resolve; }));
    const complete = vi.fn(), failed = vi.fn();
    observation.observe(video, "scope", read, () => true, complete, failed);
    observation.observe(video, "scope", read, () => true, complete, failed);
    await tick(); expect(read).toHaveBeenCalledTimes(1); expect(complete).not.toHaveBeenCalled();
    release(); await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    observation.observe(video, "scope", read, () => true, complete, failed);
    await tick(); expect(read).toHaveBeenCalledTimes(1); expect(failed).not.toHaveBeenCalled();
    expect(read.mock.calls[0]![0].aborted).toBe(true);
  });

  it("ignores late old-quality/scope completion and does not retry cancellation", async () => {
    const observation = createMediaCompletionObservation(), video = {};
    let current = true, release!: () => void;
    const read = vi.fn((_signal: AbortSignal) => new Promise<void>((resolve) => { release = resolve; }));
    const complete = vi.fn(), failed = vi.fn();
    observation.observe(video, "old-quality", read, () => current, complete, failed);
    await tick(); current = false; observation.cancel(); release(); await tick();
    expect(read.mock.calls[0]![0].aborted).toBe(true); expect(complete).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    current = true; observation.observe(video, "old-quality", read, () => current, complete, failed);
    await tick(); expect(read).toHaveBeenCalledTimes(1);
  });

  it("reports one bounded failure without polling or a second load", async () => {
    vi.useFakeTimers();
    const observation = createMediaCompletionObservation(), video = {}, complete = vi.fn(), failed = vi.fn();
    const read = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    observation.observe(video, "scope", read, () => true, complete, failed);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(failed).toHaveBeenCalledTimes(1); expect(complete).not.toHaveBeenCalled();
    observation.observe(video, "scope", read, () => true, complete, failed);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
});

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
