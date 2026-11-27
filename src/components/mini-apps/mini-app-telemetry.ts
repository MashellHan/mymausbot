export type MiniAppDocSource = "pool-warm" | "client-cache" | "http-304" | "http-200";

export interface MiniAppPerfTransition {
  appId: string;
  revision: number;
  templateVersion: number;
  t0SelectMs: number;
  t1DocReadyMs?: number;
  t2IframeInitMs?: number;
  t3FirstQueryMs?: number;
  t4ReadyMs?: number;
  docSource?: MiniAppDocSource;
  cacheHits: number;
  totalQueries: number;
}

export const MINI_APP_PERF_MAX_ENTRIES = 50;

export class MiniAppPerfRingBuffer {
  private readonly maxEntries: number;
  private readonly entries: MiniAppPerfTransition[] = [];
  private readonly activeByApp = new Map<string, MiniAppPerfTransition>();

  constructor(maxEntries = MINI_APP_PERF_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  startSelect(input: { appId: string; revision: number; templateVersion: number; nowMs?: number }): MiniAppPerfTransition {
    const entry: MiniAppPerfTransition = {
      appId: input.appId,
      revision: input.revision,
      templateVersion: input.templateVersion,
      t0SelectMs: input.nowMs ?? nowMs(),
      cacheHits: 0,
      totalQueries: 0,
    };
    this.activeByApp.set(input.appId, entry);
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    return entry;
  }

  markDocReady(appId: string, docSource: MiniAppDocSource, ts = nowMs()): void {
    const entry = this.activeByApp.get(appId);
    if (!entry || entry.t1DocReadyMs !== undefined) return;
    entry.t1DocReadyMs = Math.max(0, ts - entry.t0SelectMs);
    entry.docSource = docSource;
  }

  markIframeInit(appId: string, ts = nowMs()): void {
    const entry = this.activeByApp.get(appId);
    if (!entry || entry.t2IframeInitMs !== undefined) return;
    entry.t2IframeInitMs = Math.max(0, ts - entry.t0SelectMs);
  }

  recordQuery(appId: string, cacheHit: boolean, ts = nowMs()): void {
    const entry = this.activeByApp.get(appId);
    if (!entry) return;
    entry.totalQueries += 1;
    if (cacheHit) entry.cacheHits += 1;
    if (entry.t3FirstQueryMs === undefined) {
      entry.t3FirstQueryMs = Math.max(0, ts - entry.t0SelectMs);
    }
  }

  markReady(appId: string, ts = nowMs()): void {
    const entry = this.activeByApp.get(appId);
    if (!entry || entry.t4ReadyMs !== undefined) return;
    entry.t4ReadyMs = Math.max(0, ts - entry.t0SelectMs);
  }

  snapshot(): MiniAppPerfTransition[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  summary(): {
    count: number;
    p95ReadyMs: number | null;
    cacheHitRate: number | null;
  } {
    const readyDurations = this.entries
      .map((entry) => entry.t4ReadyMs)
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    const totalQ = this.entries.reduce((acc, item) => acc + item.totalQueries, 0);
    const totalHits = this.entries.reduce((acc, item) => acc + item.cacheHits, 0);
    const p95Index = readyDurations.length > 0 ? Math.min(readyDurations.length - 1, Math.floor(readyDurations.length * 0.95)) : -1;
    return {
      count: this.entries.length,
      p95ReadyMs: p95Index >= 0 ? readyDurations[p95Index]! : null,
      cacheHitRate: totalQ > 0 ? totalHits / totalQ : null,
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.activeByApp.clear();
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

let sharedTelemetry: MiniAppPerfRingBuffer | null = null;

export function miniAppPerfTelemetry(): MiniAppPerfRingBuffer {
  if (!sharedTelemetry) {
    sharedTelemetry = new MiniAppPerfRingBuffer();
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>).__ombMiniAppPerf = sharedTelemetry;
    }
  }
  return sharedTelemetry;
}
