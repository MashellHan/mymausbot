import { hongguoMetric, type HongguoCatalogResponse, type HongguoMetricUpdate, type HongguoSeriesCard } from "../../../shared/hongguo-mini-app";

export type HongguoCatalogSort = "default" | "heat" | "playCount";

export function appendUniqueCards(existing: HongguoSeriesCard[], incoming: HongguoSeriesCard[]): HongguoSeriesCard[] {
  const seen = new Set(existing.map((card) => card.id));
  return [...existing, ...incoming.filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  })];
}

export function mergeHongguoMetrics(items: HongguoSeriesCard[], updates: HongguoMetricUpdate[]): HongguoSeriesCard[] {
  const values = new Map(updates.map((update) => [update.id, update]));
  return items.map((card) => ({ ...card, heat: hongguoMetric(card.heat) ?? hongguoMetric(values.get(card.id)?.heat),
    playCount: hongguoMetric(card.playCount) ?? hongguoMetric(values.get(card.id)?.playCount) }));
}

function waitForReadback(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(!signal.aborted); };
    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export async function hydrateHongguoMetrics(options: {
  ids: string[]; signal: AbortSignal; current(): boolean;
  read(ids: string[]): Promise<HongguoCatalogResponse>;
  update(updates: HongguoMetricUpdate[], remaining: string[], asked: string[]): void;
  failed(error: unknown): void;
}): Promise<void> {
  let ids = [...new Set(options.ids)].slice(0, 100);
  if (!ids.length || !await waitForReadback(300, options.signal)) return;
  while (ids.length && !options.signal.aborted && options.current()) {
    try {
      const response = await options.read(ids);
      if (options.signal.aborted || !options.current()) return;
      const asked = new Set(ids);
      const remaining = (response.pendingMetricIds ?? []).filter((id) => asked.has(id));
      options.update((response.metricUpdates ?? []).filter(({ id }) => asked.has(id)), remaining, ids);
      ids = remaining;
      if (ids.length && !await waitForReadback(300, options.signal)) return;
    } catch (error) { if (!options.signal.aborted && options.current()) options.failed(error); return; }
  }
}

export function orderedHongguoCards(items: HongguoSeriesCard[], sort: HongguoCatalogSort): HongguoSeriesCard[] {
  if (sort === "default") return items;
  return items.map((card, index) => ({ card, index, value: hongguoMetric(card[sort]) }))
    .sort((a, b) => a.value === null ? b.value === null ? a.index - b.index : 1
      : b.value === null ? -1 : b.value - a.value || a.index - b.index)
    .map(({ card }) => card);
}
