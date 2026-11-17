import { describe, expect, it, vi } from "vitest";
import { join, relative } from "node:path";
import type { Playback, Transport } from "openhongguo";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";
import { createHongguoProvider } from "./provider.ts";
import { parseHongguoCatalog, parseHongguoCatalogResult, parseHongguoSeriesResult } from "../mini-apps/hongguo-validation.ts";

const sdkCreate = vi.hoisted(() => vi.fn());
vi.mock("openhongguo", () => ({ createClient: sdkCreate }));

function fixture() {
    const series = { id: "10", title: "A\u0000series", episode_count: 2, cover_url: "https://p.fqnovelpic.com/cover.jpg" };
  const client = {
    search: vi.fn(async () => ({ items: [series, { id: "bad/id", title: "Invalid" }], has_more: true, cursor: "next" })),
    shortRank: vi.fn(async () => ({ items: [{ series_id: "10", title: "A series" }], has_more: false, contents: [], content: "all", board: "1" })),
    shortFilterPanel: vi.fn(async () => [{ key: "category_dim_theme", name: "Theme", options: [{ name: "Family", value: "cate_5001" }] }]),
    shortFilter: vi.fn(async () => ({ items: [series], has_more: false })),
    newReleases: vi.fn(async () => ({ items: [{ series_id: "10", title: "Online", online: true },
      { series_id: "11", title: "Not released", online: false }], has_more: false, dates: [], date: "20261116" })),
    getSeriesBatch: vi.fn(async () => [{ series, episodes: [
      { id: "101", series_id: "10", number: 1, title: "Episode 1", playable: true },
      { id: "102", series_id: "10", number: 2, title: "Episode 2", playable: false },
      { id: "201", series_id: "20", number: 1, playable: true },
    ] }]),
    resolvePlayback: vi.fn(async (_episodeId: string): Promise<{ playback: Playback }> => ({
      playback: { episode_id: "101", protected: false, streams: [], duration_seconds: 90 } })),
  };
  const media = { prepare: vi.fn(async () => "media-token"), serve: vi.fn(async () => new Response(null)) };
  const load = vi.fn(async () => client);
  const log = vi.fn();
  const provider = createHongguoProvider({ dataDir: "/unused", client: load, media, log });
  return { provider, client, media, load, log };
}

describe("Hongguo provider", () => {
  it("keeps the actual SDK profile in destination-owned authentication storage without device resets", async () => {
    sdkCreate.mockResolvedValueOnce(fixture().client);
    const dataDir = join(process.cwd(), "synthetic-hongguo-data");
    const provider = createHongguoProvider({ dataDir });
    await provider.catalog({ expectedRevision: 1, mode: "popular" });
    const options = sdkCreate.mock.calls[0]![0];
    expect(options).toMatchObject({ profile: join(dataDir, "providers", "hongguo", "anonymous.json"), retryAttempts: 1, deviceResets: 0 });
    expect(excludedWorkspaceAuthPath(relative(dataDir, options.profile).replaceAll("\\", "/"))).toBe(true);
  });

  it("loads lazily and uses real catalog modes, safe cards and cursors", async () => {
    const { provider, client, load } = fixture();
    expect(load).not.toHaveBeenCalled();
    const page = await provider.catalog({ expectedRevision: 1, mode: "search", query: "family" });
    expect(page.items.map((item) => item.id)).toEqual(["10"]);
    expect(page.items[0]?.title).toBe("A series");
    expect(page.nextCursor).toBe("next");
    expect(client.search).toHaveBeenCalledWith("family", { cursor: undefined, pageSize: 24 });
    expect((await provider.catalog({ expectedRevision: 1, mode: "new" })).items.map((item) => item.id)).toEqual(["10"]);
    expect((await provider.catalog({ expectedRevision: 1, mode: "popular" })).items[0]?.id).toBe("10");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps numeric feed counts and original provider order without detail fanout", async () => {
    const { provider, client } = fixture();
    const rows = [{ series_id: "10", title: "First", heat: 0, plays: 40 },
      { series_id: "20", title: "Second", heat: 100, plays: 2 }];
    client.shortRank.mockResolvedValue({ items: rows, has_more: true, cursor: "rank-next", contents: [], content: "all", board: "1" });
    const page = await provider.catalog({ expectedRevision: 1, mode: "popular" });
    expect(parseHongguoCatalogResult(page).items.map(({ id, heat, playCount }) => [id, heat, playCount]))
      .toEqual([["10", 0, 40], ["20", 100, 2]]);
    expect(page.nextCursor).toBe("rank-next");
    expect(client.shortRank).toHaveBeenCalledWith({ cursor: undefined });
    expect(client.getSeriesBatch).not.toHaveBeenCalled();
  });

  it("uses one cached matching batch for missing metrics and never treats offline reservations as heat", async () => {
    const { provider, client } = fixture();
    const detail = (await client.getSeriesBatch())[0]!;
    const sourced = { ...detail, series: { ...detail.series, heat: 123, play_count: 456 } };
    client.getSeriesBatch.mockResolvedValue([sourced]).mockClear();
    const online = { series_id: "10", title: "Online", online: true, heat: "378万热度" };
    const offline = { series_id: "11", title: "Not released", online: false, heat: "159.7万人预约" };
    client.newReleases.mockResolvedValue({ items: [online, offline], has_more: false, dates: [], date: "20261116" });
    const latest = await provider.catalog({ expectedRevision: 1, mode: "new" });
    expect(latest.items.map(({ id, heat, playCount }) => [id, heat, playCount])).toEqual([["10", 123, 456]]);
    expect(client.getSeriesBatch).toHaveBeenCalledExactlyOnceWith(["10"]);
    const search = await provider.catalog({ expectedRevision: 1, mode: "search", query: "family" });
    expect(search.items[0]).toMatchObject({ heat: 123, playCount: 456 });
    expect(search.nextCursor).toBe("next");
    expect(client.search).toHaveBeenCalledWith("family", { cursor: undefined, pageSize: 24 });
    expect(client.getSeriesBatch).toHaveBeenCalledTimes(1);
  });

  it("allows bounded cache-only metric readback without initializing the SDK or accepting an unrelated cursor", async () => {
    const { provider, load, client } = fixture();
    const request = parseHongguoCatalog({ expectedRevision: 1, mode: "metrics", seriesIds: ["10"] });
    expect(parseHongguoCatalogResult(await provider.catalog(request))).toEqual({ items: [], categories: [], nextCursor: null,
      metricUpdates: [], pendingMetricIds: [] });
    expect(load).not.toHaveBeenCalled();
    expect(client.getSeriesBatch).not.toHaveBeenCalled();
    for (const raw of [
      { ...request, seriesIds: Array.from({ length: 101 }, (_, index) => String(index)) },
      { ...request, seriesIds: ["10", "10"] }, { ...request, cursor: "other-feed" },
      { expectedRevision: 1, mode: "popular", seriesIds: ["10"] },
    ]) expect(() => parseHongguoCatalog(raw)).toThrow();
  });

  it("returns valid catalog cards when optional metrics are too slow", async () => {
    vi.useFakeTimers();
    try {
      const { provider, client } = fixture();
      let release!: () => void;
      client.getSeriesBatch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
      const page = provider.catalog({ expectedRevision: 1, mode: "search", query: "family" });
      await vi.advanceTimersByTimeAsync(300);
      expect((await page).items).toEqual([expect.objectContaining({ id: "10", heat: null, playCount: null })]);
      expect(client.getSeriesBatch).toHaveBeenCalledTimes(1);
      release();
      await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });

  it("accepts only categories returned by the provider", async () => {
    const { provider, client } = fixture();
    expect((await provider.catalog({ expectedRevision: 1, mode: "categories" })).categories)
      .toEqual([{ id: "cate_5001", title: "Family" }]);
    await provider.catalog({ expectedRevision: 1, mode: "category", categoryId: "cate_5001" });
    expect(client.shortFilter).toHaveBeenCalledWith({ selections: { category_dim_theme: ["cate_5001"] }, cursor: undefined });
    await expect(provider.catalog({ expectedRevision: 1, mode: "category", categoryId: "injected" })).rejects.toThrow();
    expect(client.shortFilter).toHaveBeenCalledTimes(1);
  });

  it("binds episodes to their series, blocks disabled episodes and scopes ready media", async () => {
    const { provider, client, media } = fixture();
    const scope = { appId: "app", revision: 3 };
    expect((await provider.series("10")).episodes.map((item) => item.id)).toEqual(["101", "102"]);
    for (const id of ["102", "201"]) expect(await provider.preparePlayback("10", id, scope))
      .toEqual({ status: "unavailable", reason: "episode-unavailable" });
    expect(client.resolvePlayback).not.toHaveBeenCalled();
    expect(await provider.preparePlayback("10", "101", scope))
      .toEqual({ status: "ready", token: "media-token", durationSeconds: 90,
        selectedQualityId: null, availableQualityIds: [] });
    expect(media.prepare).toHaveBeenCalledWith(expect.objectContaining({ episode_id: "101" }), undefined, scope, undefined);
    expect(client.getSeriesBatch).toHaveBeenCalledTimes(1);
  });

  it("rejects an absent requested quality before media work and returns only sourced choices", async () => {
    const { provider, client, media } = fixture();
    const streams = [[360, 640], [720, 1280], [1080, 1920]].map(([width, height]) => ({
      url: `https://v.douyinvod.com/${width}.mp4`, definition: `${width}p`,
      width, height, codec: "h264", protected: false }));
    client.resolvePlayback.mockResolvedValue({ playback: { episode_id: "101", protected: false, streams, duration_seconds: 90 } });
    const scope = { appId: "a", revision: 1 };
    expect(await provider.preparePlayback("10", "101", scope, "480p"))
      .toEqual({ status: "unavailable", reason: "quality-unavailable" });
    expect(media.prepare).not.toHaveBeenCalled();
    expect(await provider.preparePlayback("10", "101", scope))
      .toEqual({ status: "ready", token: "media-token", durationSeconds: 90,
        selectedQualityId: "1080p", availableQualityIds: ["1080p", "720p", "360p"] });
    expect(media.prepare).toHaveBeenLastCalledWith(expect.anything(), undefined, scope, "1080p");
    expect(await provider.preparePlayback("10", "101", scope, "720p"))
      .toMatchObject({ status: "ready", selectedQualityId: "720p" });
    expect(media.prepare).toHaveBeenLastCalledWith(expect.anything(), undefined, scope, "720p");
  });

  it("does not retry or disguise anonymous denial, mismatched media or transport failures", async () => {
    const { provider, client, media } = fixture();
    client.resolvePlayback.mockRejectedValueOnce({ code: "ANONYMOUS_LIMITED", retryable: false });
    expect(await provider.preparePlayback("10", "101", { appId: "a", revision: 1 }))
      .toEqual({ status: "unavailable", reason: "anonymous-limited" });
    expect(client.resolvePlayback).toHaveBeenCalledTimes(1);
    client.resolvePlayback.mockResolvedValueOnce({ playback: { episode_id: "other", protected: false, streams: [], duration_seconds: 10 } });
    expect((await provider.preparePlayback("10", "101", { appId: "a", revision: 1 })).status).toBe("unavailable");
    expect(media.prepare).not.toHaveBeenCalled();
    client.resolvePlayback.mockRejectedValueOnce(new Error("private provider detail"));
    expect(await provider.preparePlayback("10", "101", { appId: "a", revision: 1 }))
      .toEqual({ status: "unavailable", reason: "provider-unavailable" });
  });

  it("reports only the reached series, resolve or media stage and allowlisted SDK error", async () => {
    const secret = "private-series-episode-error-text";
    const { provider, client, media, log } = fixture();
    client.getSeriesBatch.mockRejectedValueOnce({ code: "ANONYMOUS_LIMITED", retryable: false, message: secret });
    expect(await provider.preparePlayback("10", "101", { appId: secret, revision: 1 }))
      .toEqual({ status: "unavailable", reason: "anonymous-limited" });
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ stage: "series", reason: "anonymous-limited",
      errorCode: "ANONYMOUS_LIMITED", retryable: false, responses: [] });
    client.resolvePlayback.mockRejectedValueOnce({ code: "ANONYMOUS_LIMITED", retryable: false, message: secret });
    expect(await provider.preparePlayback("10", "101", { appId: secret, revision: 1 }))
      .toEqual({ status: "unavailable", reason: "anonymous-limited" });
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ stage: "resolve", reason: "anonymous-limited",
      errorCode: "ANONYMOUS_LIMITED", retryable: false, responses: [] });
    media.prepare.mockRejectedValueOnce(new Error(secret));
    expect(await provider.preparePlayback("10", "101", { appId: secret, revision: 1 }))
      .toEqual({ status: "unavailable", reason: "provider-unavailable" });
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ stage: "media", reason: "provider-unavailable",
      errorCode: null, retryable: null, responses: [] });
    expect(log.mock.calls.map(([line]) => line).join("\n")).not.toContain(secret);
  });

  it("captures only bounded response facts for an isolated playback failure", async () => {
    const secret = "private-url-query-header-profile-episode-message";
    const { client, media } = fixture();
    const log = vi.fn();
    const body = Buffer.from(JSON.stringify({ status_code: 0, data: { video_model: null, url: secret }, message: secret }));
    const response = { status: 200, headers: { "content-encoding": "identity", "x-private": secret },
      cookies: { token: secret }, body };
    const http = vi.fn(async () => response);
    let wrapped: Transport | undefined;
    client.resolvePlayback.mockImplementationOnce(async () => {
      expect(await wrapped!({ method: "POST", url: `https://api.fqnovel.com/${secret}?${secret}`,
        headers: { authorization: secret }, body: Buffer.from(secret) })).toBe(response);
      throw { code: "ANONYMOUS_LIMITED", retryable: false, message: secret };
    });
    const provider = createHongguoProvider({ dataDir: "/unused", client: async (transport) => {
      wrapped = transport; return client;
    }, transport: http, media, log });
    expect(await provider.preparePlayback("10", "101", { appId: secret, revision: 1 }))
      .toEqual({ status: "unavailable", reason: "anonymous-limited" });
    const record = JSON.parse(log.mock.calls[0]![0]);
    expect(record).toMatchObject({ kind: "hongguo-playback", stage: "resolve", errorCode: "ANONYMOUS_LIMITED",
      correlation: "isolated", responses: [{ stage: "resolve", status: 200, encodedBytes: body.length,
        decodedBytes: body.length, encoding: "identity",
        shape: { json: "object", businessStatus: "zero", data: "object", videoModel: "null" } }] });
    expect(log.mock.calls[0]![0]).not.toContain(secret);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("does not assign a concurrent catalog response to a playback failure", async () => {
    const { client, media } = fixture();
    const log = vi.fn();
    let wrapped: Transport | undefined;
    let finishSearch: ((value: { items: never[]; has_more: boolean; cursor: string }) => void) | undefined;
    client.search.mockImplementationOnce(() => new Promise((resolve) => { finishSearch = resolve; }));
    client.resolvePlayback.mockImplementationOnce(async () => {
      await wrapped!({ method: "POST", url: "https://api.fqnovel.com/synthetic", headers: {}, body: new Uint8Array() });
      throw { code: "ANONYMOUS_LIMITED", retryable: false };
    });
    const provider = createHongguoProvider({ dataDir: "/unused", client: async (transport) => {
      wrapped = transport; return client;
    }, transport: async () => ({ status: 200, headers: {}, body: Buffer.from("{}") }), media, log });
    await provider.series("10");
    const catalog = provider.catalog({ expectedRevision: 1, mode: "search", query: "synthetic" });
    await vi.waitFor(() => expect(client.search).toHaveBeenCalledTimes(1));
    expect(await provider.preparePlayback("10", "101", { appId: "a", revision: 1 }))
      .toEqual({ status: "unavailable", reason: "anonymous-limited" });
    finishSearch!({ items: [], has_more: false, cursor: "" });
    await catalog;
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ correlation: "ambiguous", responses: [] });
  });

  it("does not attach a catalog response while playback waits for media", async () => {
    const { client, media } = fixture();
    const log = vi.fn();
    let wrapped: Transport | undefined;
    let failMedia: (() => void) | undefined;
    media.prepare.mockImplementationOnce(() => new Promise<string>((_resolve, reject) => {
      failMedia = () => reject(new Error("private media detail"));
    }));
    client.search.mockImplementationOnce(async () => {
      await wrapped!({ method: "GET", url: "https://api.fqnovel.com/private-catalog", headers: {}, body: new Uint8Array() });
      return { items: [], has_more: true, cursor: "next" };
    });
    const provider = createHongguoProvider({ dataDir: "/unused", client: async (transport) => {
      wrapped = transport; return client;
    }, transport: async () => ({ status: 200, headers: {}, body: Buffer.from("{}") }), media, log });
    await provider.series("10");
    const playback = provider.preparePlayback("10", "101", { appId: "a", revision: 1 });
    await vi.waitFor(() => expect(media.prepare).toHaveBeenCalledTimes(1));
    await provider.catalog({ expectedRevision: 1, mode: "search", query: "synthetic" });
    failMedia!();
    expect(await playback).toEqual({ status: "unavailable", reason: "provider-unavailable" });
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ stage: "media", correlation: "isolated", responses: [] });
  });
});

it.each([
  [1_234_567, 9_876_543, 1_234_567, 9_876_543],
  [0, 0, 0, 0],
  [undefined, undefined, null, null],
  [NaN, Infinity, null, null],
  [-1, Number.MAX_SAFE_INTEGER + 1, null, null],
])("preserves only bounded provider metrics %s / %s", async (heat, play_count, expectedHeat, expectedPlays) => {
  const { provider, client } = fixture();
  const detail = (await client.getSeriesBatch())[0]!;
  Object.assign(detail.series, { heat, play_count });
  client.getSeriesBatch.mockResolvedValueOnce([detail]);
  const result = await provider.series("10");
  expect(parseHongguoSeriesResult(result)).toMatchObject({ heat: expectedHeat, playCount: expectedPlays });
  expect(() => parseHongguoSeriesResult({ ...result, heat: -1 })).toThrow();
  expect(() => parseHongguoSeriesResult({ ...result, playCount: Infinity })).toThrow();
  const { heat: _heat, playCount: _plays, ...legacy } = result;
  expect(parseHongguoSeriesResult(legacy)).toEqual(legacy);
});
