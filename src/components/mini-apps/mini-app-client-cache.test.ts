import { describe, expect, it } from "vitest";
import type { MiniAppDocument, MiniAppQueryResult } from "../../../shared/mini-apps";
import { MiniAppClientCache } from "./mini-app-client-cache";

const doc = (id: string, revision: number, templateVersion: number, html = "<p>ok</p>"): MiniAppDocument => ({
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
  html,
  bindings: [],
  versions: [],
});

const page = (revision: number, value: number): MiniAppQueryResult => ({
  columns: [{ name: "v", type: "decimal" }],
  rows: [[value]],
  revision,
});

describe("MiniAppClientCache", () => {
  it("caches documents by (appId, revision, templateVersion) with LRU eviction", () => {
    const cache = new MiniAppClientCache({ maxDocs: 2 });
    cache.setDocument(doc("a", 1, 1));
    cache.setDocument(doc("b", 1, 1));
    expect(cache.getDocument("a", 1, 1)?.app.id).toBe("a");
    cache.setDocument(doc("c", 1, 1));
    expect(cache.getDocument("b", 1, 1)).toBeNull();
    expect(cache.getDocument("a", 1, 1)?.app.id).toBe("a");
    expect(cache.getDocument("c", 1, 1)?.app.id).toBe("c");
    expect(cache.getDocument("a", 2, 1)).toBeNull();
  });

  it("caches revision-keyed query results, clones on read, and invalidates by dataset or clear", () => {
    const cache = new MiniAppClientCache({ maxQueryBytes: 10_000 });
    const key = cache.queryKey({
      appId: "a",
      appRevision: 3,
      datasetId: "ds-1",
      dataRevision: 5,
      queryId: "summary",
      parameters: { b: "2", a: "1" },
    });
    const sameKey = cache.queryKey({
      appId: "a",
      appRevision: 3,
      datasetId: "ds-1",
      dataRevision: 5,
      queryId: "summary",
      parameters: { a: "1", b: "2" },
    });
    expect(key).toBe(sameKey);
    cache.setQuery(key, { appId: "a", datasetId: "ds-1", dataRevision: 5 }, page(5, 42));
    const hit = cache.getQuery(key);
    expect(hit?.rows).toEqual([[42]]);
    hit!.rows[0]![0] = 0;
    expect(cache.getQuery(key)?.rows).toEqual([[42]]);

    cache.invalidateDataset("ds-1", 6);
    expect(cache.getQuery(key)).toBeNull();
  });
});
