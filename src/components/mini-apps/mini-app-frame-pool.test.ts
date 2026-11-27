import { describe, expect, it, vi } from "vitest";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { MiniAppFramePoolState } from "./mini-app-frame-pool";
import { parameterlessInitialQueries } from "./mini-app-prefetch";

const makeDoc = (id: string, templateVersion = 1, revision = 1): MiniAppDocument => ({
  app: {
    id,
    slug: id,
    title: id,
    description: "",
    status: "active",
    revision,
    templateVersion,
    publisherBotIds: [],
    createdAt: 1,
    updatedAt: 1,
  },
  html: `<p>${id}</p>`,
  bindings: [{
    id: "main",
    datasetId: `ds-${id}`,
    source: { schema: "main", table: "items" },
    fields: { name: { column: "name", sourceType: "VARCHAR", as: "text" } },
    queries: {
      overview: { kind: "rows", columns: ["name"], parameters: {}, filters: [], orderBy: [], pageSize: 20 },
      by_name: { kind: "rows", columns: ["name"], parameters: { q: { type: "text" } }, filters: [], orderBy: [], pageSize: 20 },
    },
  }],
  versions: [],
});

const makeState = (id: string, revision = 1, dataRev = 1): MiniAppState => ({
  appId: id,
  revision,
  templateVersion: 1,
  status: "active",
  data: [{ datasetId: `ds-${id}`, revision: dataRev }],
});

describe("MiniAppFramePoolState", () => {
  it("keeps top-4 warm slots in LRU order, evicts 5th, and coalesces background data-changed flags", () => {
    const pool = new MiniAppFramePoolState(4);
    for (const id of ["a", "b", "c", "d"]) {
      expect(pool.activate({ appId: id, document: makeDoc(id), state: makeState(id), frameEpoch: 0 }).evicted).toEqual([]);
    }
    // Touch 'a' so 'b' becomes LRU.
    expect(pool.activate({ appId: "a", document: makeDoc("a"), state: makeState("a"), frameEpoch: 0 }).evicted).toEqual([]);
    // Dataset for parked 'c' updates twice -> dirtied once, flushed when re-activated.
    expect(pool.markDatasetDirty("a", "ds-c", 2)).toEqual(["c"]);
    expect(pool.get("c")?.pendingDataChanged).toBe(true);
    expect(pool.activate({ appId: "e", document: makeDoc("e"), state: makeState("e"), frameEpoch: 0 }).evicted).toEqual(["b"]);
    expect(pool.get("b")).toBeUndefined();
    const reactivated = pool.activate({ appId: "c", document: makeDoc("c"), state: makeState("c", 1, 2), frameEpoch: 0 });
    expect(reactivated.flushedPendingData).toBe(true);
    expect(pool.get("c")?.pendingDataChanged).toBe(false);
  });

  it("extracts only parameterless initial queries for hover/idle prefetching", () => {
    const queries = parameterlessInitialQueries(makeDoc("a"), makeState("a", 1, 5));
    expect(queries).toEqual([{ queryId: "overview", parameters: {}, expectedDataRevision: 5 }]);
    vi.useFakeTimers();
    vi.useRealTimers();
  });
});
