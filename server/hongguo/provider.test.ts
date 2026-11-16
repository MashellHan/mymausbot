import { describe, expect, it, vi } from "vitest";
import { join, relative } from "node:path";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";
import { createHongguoProvider } from "./provider.ts";

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
    resolvePlayback: vi.fn(async (_episodeId: string) => ({ playback: { episode_id: "101", protected: false, streams: [], duration_seconds: 90 } })),
  };
  const media = { prepare: vi.fn(async () => "media-token"), serve: vi.fn(async () => new Response(null)) };
  const load = vi.fn(async () => client);
  const provider = createHongguoProvider({ dataDir: "/unused", client: load, media });
  return { provider, client, media, load };
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
      .toEqual({ status: "ready", token: "media-token", durationSeconds: 90 });
    expect(media.prepare).toHaveBeenCalledWith(expect.objectContaining({ episode_id: "101" }), undefined, scope);
    expect(client.getSeriesBatch).toHaveBeenCalledTimes(1);
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
});
