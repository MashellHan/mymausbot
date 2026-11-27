import { describe, expect, it, vi } from "vitest";
import type { MiniAppDataBinding, MiniAppNamedPage } from "../../shared/mini-app-data.ts";
import { MiniAppQueryCache } from "./query-cache.ts";

const binding: MiniAppDataBinding = {
  id: "b-1",
  datasetId: "ds-1",
  source: { schema: "main", table: "events" },
  fields: { v: { column: "v", sourceType: "BIGINT", as: "decimal", scale: 0 } },
  queries: {
    summary: {
      kind: "rows",
      columns: ["v"],
      parameters: {},
      filters: [],
      orderBy: [],
      pageSize: 50,
    },
  },
};

const page = (revision: number, value: number): MiniAppNamedPage => ({
  columns: [{ name: "v", type: "decimal" }],
  rows: [[value]],
  revision,
});

describe("MiniAppQueryCache", () => {
  it("caches revision-keyed pages, deduplicates concurrent loads, and evicts on dataset revision bump", async () => {
    const cache = new MiniAppQueryCache({ maxBytes: 10_000, maxEntries: 10 });
    const k1 = cache.key({ datasetId: "ds-1", dataRevision: 1, binding, queryId: "summary", parameters: {} });
    let resolveLoad!: (p: MiniAppNamedPage) => void;
    const loader = vi.fn(() => new Promise<MiniAppNamedPage>((resolve) => { resolveLoad = resolve; }));

    const p1 = cache.getOrLoad(k1, "ds-1", loader);
    const p2 = cache.getOrLoad(k1, "ds-1", loader);
    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoad(page(1, 42));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.rows).toEqual([[42]]);
    expect(r2.rows).toEqual([[42]]);
    // Returning clones prevents callers from mutating cached state.
    r1.rows[0]![0] = 999;
    const r3 = await cache.getOrLoad(k1, "ds-1", loader);
    expect(r3.rows).toEqual([[42]]);
    expect(loader).toHaveBeenCalledTimes(1);

    // Evicting older revisions drops revision 1 cleanly.
    expect(cache.evictDataset("ds-1", 2)).toBe(1);
    expect(cache.size).toBe(0);
    expect(cache.get(k1)).toBeNull();
  });

  it("evicts least-recently-used entries when maxEntries is exceeded", () => {
    const cache = new MiniAppQueryCache({ maxBytes: 100_000, maxEntries: 2 });
    const k1 = cache.key({ datasetId: "ds-1", dataRevision: 1, binding, queryId: "summary", parameters: { p: "1" } });
    const k2 = cache.key({ datasetId: "ds-1", dataRevision: 1, binding, queryId: "summary", parameters: { p: "2" } });
    const k3 = cache.key({ datasetId: "ds-1", dataRevision: 1, binding, queryId: "summary", parameters: { p: "3" } });
    cache.set(k1, "ds-1", page(1, 1));
    cache.set(k2, "ds-1", page(1, 2));
    // Touch k1 so k2 is evicted when k3 arrives.
    expect(cache.get(k1)?.rows).toEqual([[1]]);
    cache.set(k3, "ds-1", page(1, 3));
    expect(cache.get(k2)).toBeNull();
    expect(cache.get(k1)?.rows).toEqual([[1]]);
    expect(cache.get(k3)?.rows).toEqual([[3]]);
  });
});
