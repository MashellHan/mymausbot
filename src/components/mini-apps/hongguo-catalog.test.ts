import { afterEach, describe, expect, it, vi } from "vitest";
import { hongguoMetric, type HongguoCatalogResponse, type HongguoSeriesCard } from "../../../shared/hongguo-mini-app";
import { hydrateHongguoMetrics, mergeHongguoMetrics, orderedHongguoCards } from "./hongguo-catalog";

afterEach(() => { vi.useRealTimers(); });

const card = (id: string, heat?: number | null, playCount?: number | null): HongguoSeriesCard => ({
  id, title: id, coverUrl: null, summary: null, episodeCount: null, heat, playCount,
});

describe("Hongguo current-list ordering", () => {
  it("sorts numerically descending with stable ties, known zero before missing and no source mutation", () => {
    const items = [card("missing"), card("two", 2, 20), card("ten", 10, 4), card("tie", 10, 20), card("zero", 0, 0), card("null", null, null)];
    expect(orderedHongguoCards(items, "heat").map(({ id }) => id)).toEqual(["ten", "tie", "two", "zero", "missing", "null"]);
    expect(orderedHongguoCards(items, "playCount").map(({ id }) => id)).toEqual(["two", "tie", "ten", "zero", "missing", "null"]);
    expect(orderedHongguoCards(items, "default")).toBe(items);
    expect(items[0]!.id).toBe("missing");
  });

  it("incorporates appended pages while retaining arrival order for equal metrics", () => {
    const first = [card("first", 8), card("tie-first", 8), card("missing")];
    const more = [card("largest", 100), card("tie-later", 8), card("unknown", null)];
    expect(orderedHongguoCards([...first, ...more], "heat").map(({ id }) => id))
      .toEqual(["largest", "first", "tie-first", "tie-later", "missing", "unknown"]);
  });

  it.each([undefined, null, "378万热度", "159.7万人预约", "0", NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])("never converts unknown display/reservation values into a numeric metric: %s", (value) => {
    expect(hongguoMetric(value)).toBeNull();
  });

  it("merges only matching unknown metrics while retaining feed values and arrival order", () => {
    expect(mergeHongguoMetrics([card("first", 0), card("second")], [
      { id: "first", heat: 999, playCount: 2 }, { id: "second", heat: 10, playCount: -1 }, { id: "other", heat: 90, playCount: 90 },
    ])).toEqual([card("first", 0, 2), card("second", 10, null)]);
  });

  it("follows actual pending-batch completion beyond 3.3 seconds and cancels stale or aborted work", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const update = vi.fn(), failed = vi.fn();
    const read = vi.fn(async (): Promise<HongguoCatalogResponse> => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { appId: "app", revision: 1, items: [], categories: [], nextCursor: null,
        metricUpdates: [{ id: "1", heat: 10, playCount: 20 }], pendingMetricIds: [] };
    });
    const task = hydrateHongguoMetrics({ ids: ["1"], signal: controller.signal, current: () => !controller.signal.aborted, read, update, failed });
    await vi.advanceTimersByTimeAsync(10_000);
    await task;
    expect(read).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith([{ id: "1", heat: 10, playCount: 20 }], [], ["1"]);
    expect(failed).not.toHaveBeenCalled();
    const aborted = hydrateHongguoMetrics({ ids: ["1"], signal: controller.signal, current: () => true, read, update, failed });
    controller.abort();
    await aborted;
    expect(read).toHaveBeenCalledTimes(1);
    let release!: (response: HongguoCatalogResponse) => void;
    let current = true;
    const delayedRead = vi.fn(() => new Promise<HongguoCatalogResponse>((resolve) => { release = resolve; }));
    update.mockClear();
    const stale = hydrateHongguoMetrics({ ids: ["1"], signal: new AbortController().signal,
      current: () => current, read: delayedRead, update, failed });
    await vi.advanceTimersByTimeAsync(300);
    current = false;
    release({ appId: "app", revision: 1, items: [], categories: [], nextCursor: null,
      metricUpdates: [{ id: "1", heat: 10, playCount: 20 }] });
    await stale;
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps valid sourced zero and safe numeric metrics", () => {
    expect(hongguoMetric(0)).toBe(0);
    expect(hongguoMetric(34_000_000)).toBe(34_000_000);
  });
});
