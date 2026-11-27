import type { MiniAppDocument, MiniAppQueryResult } from "../../../shared/mini-apps";

export const CLIENT_DOC_CACHE_MAX_ENTRIES = 12;
export const CLIENT_QUERY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const CLIENT_QUERY_CACHE_MAX_ENTRY_BYTES = 512 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class MiniAppClientCache {
  private readonly maxDocs: number;
  private readonly maxQueryBytes: number;
  private readonly docs = new Map<string, MiniAppDocument>();
  private readonly queries = new Map<string, { appId: string; datasetId: string; dataRevision: number; bytes: number; result: MiniAppQueryResult }>();
  private queryBytes = 0;

  constructor(options: { maxDocs?: number; maxQueryBytes?: number } = {}) {
    this.maxDocs = options.maxDocs ?? CLIENT_DOC_CACHE_MAX_ENTRIES;
    this.maxQueryBytes = options.maxQueryBytes ?? CLIENT_QUERY_CACHE_MAX_BYTES;
  }

  private docKey(appId: string, revision: number, templateVersion: number): string {
    return `${appId}:${revision}:${templateVersion}`;
  }

  getDocument(appId: string, revision: number, templateVersion: number): MiniAppDocument | null {
    const key = this.docKey(appId, revision, templateVersion);
    const hit = this.docs.get(key);
    if (!hit) return null;
    this.docs.delete(key);
    this.docs.set(key, hit);
    return hit;
  }

  setDocument(doc: MiniAppDocument): void {
    const key = this.docKey(doc.app.id, doc.app.revision, doc.app.templateVersion);
    this.docs.delete(key);
    while (this.docs.size >= this.maxDocs) {
      const oldest = this.docs.keys().next().value;
      if (oldest === undefined) break;
      this.docs.delete(oldest);
    }
    this.docs.set(key, doc);
  }

  invalidateApp(appId: string): void {
    for (const key of this.docs.keys()) {
      if (key.startsWith(`${appId}:`)) this.docs.delete(key);
    }
    for (const [key, entry] of this.queries.entries()) {
      if (entry.appId === appId) this.deleteQuery(key);
    }
  }

  invalidateDataset(datasetId: string, belowRevision?: number): void {
    for (const [key, entry] of this.queries.entries()) {
      if (entry.datasetId !== datasetId) continue;
      if (belowRevision !== undefined && entry.dataRevision >= belowRevision) continue;
      this.deleteQuery(key);
    }
  }

  queryKey(input: {
    appId: string;
    appRevision: number;
    datasetId: string;
    dataRevision: number;
    queryId: string;
    parameters: Record<string, string | string[]>;
    cursor?: string;
  }): string {
    return `${input.appId}:${input.appRevision}:${input.datasetId}:${input.dataRevision}:${input.queryId}:${canonical(input.parameters)}:${input.cursor ?? ""}`;
  }

  getQuery(key: string): MiniAppQueryResult | null {
    const hit = this.queries.get(key);
    if (!hit) return null;
    this.queries.delete(key);
    this.queries.set(key, hit);
    return structuredClone(hit.result);
  }

  setQuery(key: string, meta: { appId: string; datasetId: string; dataRevision: number }, result: MiniAppQueryResult): void {
    const bytes = JSON.stringify(result).length;
    if (bytes > CLIENT_QUERY_CACHE_MAX_ENTRY_BYTES || bytes > this.maxQueryBytes) return;
    this.deleteQuery(key);
    while (this.queryBytes + bytes > this.maxQueryBytes && this.queries.size > 0) {
      const oldest = this.queries.keys().next().value;
      if (oldest === undefined) break;
      this.deleteQuery(oldest);
    }
    this.queries.set(key, { ...meta, bytes, result: structuredClone(result) });
    this.queryBytes += bytes;
  }

  clear(): void {
    this.docs.clear();
    this.queries.clear();
    this.queryBytes = 0;
  }

  get docCount(): number { return this.docs.size; }
  get queryCount(): number { return this.queries.size; }

  private deleteQuery(key: string): void {
    const existing = this.queries.get(key);
    if (!existing) return;
    this.queries.delete(key);
    this.queryBytes = Math.max(0, this.queryBytes - existing.bytes);
  }
}

const cachesByScope = new Map<string, MiniAppClientCache>();

export function miniAppClientCache(scopeKey: string | null): MiniAppClientCache {
  const key = scopeKey || "__default__";
  let cache = cachesByScope.get(key);
  if (!cache) {
    cache = new MiniAppClientCache();
    cachesByScope.set(key, cache);
  }
  return cache;
}

export function clearMiniAppClientCache(scopeKey?: string | null): void {
  if (scopeKey === undefined) {
    for (const cache of cachesByScope.values()) cache.clear();
    cachesByScope.clear();
    return;
  }
  const key = scopeKey || "__default__";
  cachesByScope.get(key)?.clear();
  cachesByScope.delete(key);
}
