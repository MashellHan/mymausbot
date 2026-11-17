import { afterEach, describe, expect, it, vi } from "vitest";
import type { HongguoSeriesCard } from "../../shared/hongguo-mini-app.ts";
import { createHongguoCatalogMetrics } from "./catalog-metrics.ts";

const card = (id: string, metrics: Partial<HongguoSeriesCard> = {}): HongguoSeriesCard => ({
  id, title: `Series ${id}`, coverUrl: null, summary: null, episodeCount: 1, ...metrics,
});
afterEach(() => { vi.useRealTimers(); });

describe("bounded optional Hongguo catalog metrics", () => {
  it("uses valid supplied feed metrics, including zero, without a detail request", async () => {
    const read = vi.fn(async () => []);
    expect(await createHongguoCatalogMetrics(read)([card("1", { heat: 0, playCount: 0 }), card("2", { heat: 24, playCount: 40 })]))
      .toEqual([card("1", { heat: 0, playCount: 0 }), card("2", { heat: 24, playCount: 40 })]);
    expect(read).not.toHaveBeenCalled();
  });

  it("enriches at most 24 unique IDs in one batch, never per card, and keeps extra rows unknown", async () => {
    const cards = Array.from({ length: 40 }, (_, index) => card(String(index + 1)));
    const read = vi.fn(async (ids: string[]) => ids.map((id) => ({ series: { id, heat: Number(id), play_count: Number(id) * 10 } })));
    const result = await createHongguoCatalogMetrics(read)([...cards, cards[0]!]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toEqual(cards.slice(0, 24).map(({ id }) => id));
    expect(result[23]).toMatchObject({ heat: 24, playCount: 240 });
    expect(result[24]).toMatchObject({ heat: null, playCount: null });
    expect(result.at(-1)).toMatchObject({ id: "1", heat: 1, playCount: 10 });
  });

  it("preserves feed values and rejects mismatched, duplicate, negative and nonfinite batch metrics", async () => {
    const read = vi.fn(async () => [
      { series: { id: "1", heat: 90, play_count: 70 } },
      { series: { id: "2", heat: 4, play_count: 5 } }, { series: { id: "2", heat: 6, play_count: 7 } },
      { series: { id: "3", heat: -1, play_count: Infinity } }, { series: { id: "99", heat: 999, play_count: 999 } },
    ]);
    const result = await createHongguoCatalogMetrics(read)([card("1", { heat: 0 }), card("2"), card("3"), card("4")]);
    expect(result.map(({ heat, playCount }) => [heat, playCount])).toEqual([[0, 70], [null, null], [null, null], [null, null]]);
  });

  it("reuses IDs across overlapping batches so late failure cannot overwrite another batch's valid cache", async () => {
    type Row = { series: { id: string; heat: number; play_count: number } };
    let rejectOlder!: (error: Error) => void, resolveNewer!: (rows: Row[]) => void;
    const read = vi.fn((ids: string[]) => new Promise<Row[]>((resolve, reject) => {
      if (ids.includes("2")) rejectOlder = reject;
      else resolveNewer = resolve;
    }));
    const project = createHongguoCatalogMetrics(read);
    await project([card("1"), card("2")], 0);
    await project([card("1"), card("3")], 0);
    expect(read.mock.calls.map(([ids]) => ids)).toEqual([["1", "2"], ["3"]]);
    resolveNewer([{ series: { id: "3", heat: 30, play_count: 300 } },
      { series: { id: "1", heat: 999, play_count: 999 } }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(project.read(["1", "3"])).toEqual({ metricUpdates: [{ id: "3", heat: 30, playCount: 300 }], pendingMetricIds: ["1"] });
    rejectOlder(new Error("Synthetic older batch failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(await project([card("1"), card("3")])).toEqual([card("1", { heat: null, playCount: null }), card("3", { heat: 30, playCount: 300 })]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls.flatMap(([ids]) => ids).filter((id) => id === "1")).toHaveLength(1);
  });

  it("retains five-minute results and a failed optional read as unknown without retries", async () => {
    let now = 1000;
    const read = vi.fn(async () => { throw new Error("Synthetic optional metrics failure"); });
    const project = createHongguoCatalogMetrics(read, () => now);
    expect(await project([card("1")])).toEqual([card("1", { heat: null, playCount: null })]);
    now += 5 * 60_000 - 1;
    await project([card("1")]);
    expect(read).toHaveBeenCalledTimes(1);
    now++;
    await project([card("1")]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns valid cards within the optional wait budget, shares pending work and admits late genuine counts", async () => {
    vi.useFakeTimers();
    let release!: (rows: Array<{ series: { id: string; heat: number; play_count: number } }>) => void;
    const read = vi.fn(() => new Promise<Array<{ series: { id: string; heat: number; play_count: number } }>>((resolve) => { release = resolve; }));
    const project = createHongguoCatalogMetrics(read);
    const first = project([card("1")]);
    const concurrent = project([card("1")]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await first).toEqual([card("1", { heat: null, playCount: null })]);
    expect(await concurrent).toEqual(await first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(project.read(["1"])).toEqual({ metricUpdates: [], pendingMetricIds: ["1"] });
    expect(read).toHaveBeenCalledTimes(1);
    release([{ series: { id: "1", heat: 12, play_count: 34 } }]);
    await Promise.resolve();
    expect(project.read(["1", "99"])).toEqual({ metricUpdates: [{ id: "1", heat: 12, playCount: 34 }], pendingMetricIds: [] });
    expect(await project([card("1")])).toEqual([card("1", { heat: 12, playCount: 34 })]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("waits for completion of the same five-second SDK batch without starting or renewing provider work", async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return [{ series: { id: "1", heat: 12, play_count: 34 } }];
    });
    const project = createHongguoCatalogMetrics(read);
    expect(await project([card("1")], 0)).toEqual([card("1", { heat: null, playCount: null })]);
    const completion = project.wait(["1"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await completion).toEqual({ metricUpdates: [{ id: "1", heat: 12, playCount: 34 }], pendingMetricIds: [] });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not wait when the catalog has spent its existing response budget", async () => {
    const read = vi.fn(() => new Promise<never>(() => {}));
    expect(await createHongguoCatalogMetrics(read)([card("1")], 0)).toEqual([card("1", { heat: null, playCount: null })]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
