import { createHash } from "node:crypto";
import type { MiniAppDataBinding, MiniAppNamedPage } from "../../shared/mini-app-data.ts";

export const MINI_APP_QUERY_CACHE_MAX_BYTES = 32 * 1024 * 1024;
export const MINI_APP_QUERY_CACHE_MAX_ENTRIES = 512;
export const MINI_APP_QUERY_CACHE_MAX_ENTRY_BYTES = 256 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

interface CacheEntry {
  datasetId: string;
  dataRevision: number;
  bytes: number;
  page: MiniAppNamedPage;
}

export class MiniAppQueryCache {
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly maxEntryBytes: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<MiniAppNamedPage>>();
  private totalBytes = 0;

  constructor(options: { maxBytes?: number; maxEntries?: number; maxEntryBytes?: number } = {}) {
    this.maxBytes = options.maxBytes ?? MINI_APP_QUERY_CACHE_MAX_BYTES;
    this.maxEntries = options.maxEntries ?? MINI_APP_QUERY_CACHE_MAX_ENTRIES;
    this.maxEntryBytes = options.maxEntryBytes ?? MINI_APP_QUERY_CACHE_MAX_ENTRY_BYTES;
  }

  key(input: {
    datasetId: string;
    dataRevision: number;
    binding: MiniAppDataBinding;
    queryId: string;
    parameters: Record<string, string | string[]>;
    cursor?: string;
  }): string {
    const queryDef = input.binding.queries[input.queryId];
    const payload = canonical({
      datasetId: input.datasetId,
      dataRevision: input.dataRevision,
      queryId: input.queryId,
      queryDef,
      parameters: input.parameters,
      cursor: input.cursor ?? "",
    });
    return createHash("sha256").update(payload).digest("hex");
  }

  get(key: string): MiniAppNamedPage | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.page);
  }

  set(key: string, datasetId: string, page: MiniAppNamedPage): void {
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return;
    this.delete(key);
    while ((this.totalBytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    this.entries.set(key, { datasetId, dataRevision: page.revision, bytes, page: structuredClone(page) });
    this.totalBytes += bytes;
  }

  async getOrLoad(key: string, datasetId: string, load: () => Promise<MiniAppNamedPage>): Promise<MiniAppNamedPage> {
    const cached = this.get(key);
    if (cached) return cached;
    const pending = this.inFlight.get(key);
    if (pending) return structuredClone(await pending);
    const promise = load()
      .then((page) => {
        this.set(key, datasetId, page);
        return page;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return structuredClone(await promise);
  }

  evictDataset(datasetId: string, belowRevision?: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.datasetId !== datasetId) continue;
      if (belowRevision !== undefined && entry.dataRevision >= belowRevision) continue;
      this.delete(key);
      removed += 1;
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - existing.bytes);
  }
}
