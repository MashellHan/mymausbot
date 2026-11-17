import { hongguoMetric, type HongguoSeriesCard } from "../../shared/hongguo-mini-app.ts";

type Metrics = { heat: number | null; playCount: number | null };
type SeriesMetrics = { series: { id: string; heat?: number; play_count?: number } };
const FRESH_MS = 5 * 60_000;

export function createHongguoCatalogMetrics(read: (ids: string[]) => Promise<SeriesMetrics[]>, now = Date.now) {
  const cache = new Map<string, Metrics & { expiresAt: number }>();
  const pending = new Map<string, Promise<void>>();
  const cached = (id: string) => {
    const value = cache.get(id);
    if (value && value.expiresAt > now()) return value;
    cache.delete(id);
    return undefined;
  };
  const project = async (cards: HongguoSeriesCard[], waitMs = 300): Promise<HongguoSeriesCard[]> => {
    const inFlight = new Set([...pending.keys()].flatMap((key) => key.split(",")));
    const ids = [...new Set(cards.filter((card) => hongguoMetric(card.heat) === null || hongguoMetric(card.playCount) === null)
      .map((card) => card.id))].filter((id) => /^\d{1,32}$/.test(id) && !cached(id) && !inFlight.has(id)).slice(0, 24);
    if (ids.length) {
      const key = [...ids].sort().join(",");
      let work = pending.get(key);
      if (!work && pending.size < 4) {
        work = (async () => {
          await Promise.resolve();
          let rows: SeriesMetrics[] = [];
          try { const result = await read(ids); rows = Array.isArray(result) ? result : []; } catch {}
          const expiresAt = now() + FRESH_MS;
          for (const id of ids) {
            const matches = rows.filter((row) => row?.series?.id === id);
            const series = matches.length === 1 ? matches[0]!.series : undefined;
            cache.delete(id);
            cache.set(id, { heat: hongguoMetric(series?.heat), playCount: hongguoMetric(series?.play_count), expiresAt });
          }
          while (cache.size > 256) cache.delete(cache.keys().next().value!);
        })().finally(() => { pending.delete(key); });
        pending.set(key, work);
      }
      if (work && waitMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.min(300, waitMs)); })])
          .finally(() => clearTimeout(timer));
      }
    }
    return cards.map((card) => ({ ...card, heat: hongguoMetric(card.heat) ?? cached(card.id)?.heat ?? null,
      playCount: hongguoMetric(card.playCount) ?? cached(card.id)?.playCount ?? null }));
  };
  const readCached = (ids: string[]) => {
    const selected = [...new Set(ids)].filter((id) => /^\d{1,32}$/.test(id)).slice(0, 100);
    const inFlight = new Set([...pending.keys()].flatMap((key) => key.split(",")));
    return { metricUpdates: selected.flatMap((id) => {
      const value = cached(id);
      return value ? [{ id, heat: value.heat, playCount: value.playCount }] : [];
    }), pendingMetricIds: selected.filter((id) => inFlight.has(id) && !cached(id)) };
  };
  return Object.assign(project, { read: readCached,
    async wait(ids: string[]) {
      const selected = new Set(ids.slice(0, 100));
      const work = [...pending].filter(([key]) => key.split(",").some((id) => selected.has(id))).map(([, value]) => value);
      if (work.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.allSettled(work), new Promise<void>((resolve) => { timer = setTimeout(resolve, 8000); })])
          .finally(() => clearTimeout(timer));
      }
      return readCached(ids);
    },
  });
}
