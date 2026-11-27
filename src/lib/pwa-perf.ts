export const MAX_PWA_PERF_EVENTS = 64;
export const MAX_SNAPSHOT_WRITE_SAMPLES = 32;

export type PwaPerfPhase =
  | "html_shell_start"
  | "main_entry"
  | "pwa_config_ready"
  | "idb_cache_ready"
  | "locale_ready"
  | "root_render_called"
  | "first_cached_paint"
  | "first_live_sse_connected"
  | "idb_snapshot_write";

export type PwaBootPath = "unknown" | "cached" | "network" | "pair";

export interface PwaPerfEvent {
  phase: PwaPerfPhase;
  atMs: number;
  detail?: string;
}

export interface PwaPerfSnapshot {
  bootPath: PwaBootPath;
  milestones: Partial<Record<PwaPerfPhase, number>>;
  events: readonly PwaPerfEvent[];
  droppedEvents: number;
  snapshotWrites: number;
  lastWriteDurationMs: number | null;
  maxWriteDurationMs: number;
  p95WriteDurationMs: number | null;
  lastWriteBytesApprox: number | null;
  coldStartMs: number | null;
  cachedHydrationMs: number | null;
  liveConnectMs: number | null;
  liveSyncDeltaMs: number | null;
}

export interface PwaPerfRegistry {
  mark(phase: PwaPerfPhase, detail?: string, atMs?: number): number;
  setBootPath(path: PwaBootPath): void;
  recordSnapshotWrite(durationMs: number, bytesApprox?: number): void;
  snapshot(): PwaPerfSnapshot;
  reset(): void;
}

declare global {
  interface Window {
    __ombBootTs?: number;
    __ombPwaPerf?: PwaPerfSnapshot;
  }
}

function defaultNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function safePerfMark(phase: PwaPerfPhase): void {
  try {
    if (typeof performance !== "undefined" && typeof performance.mark === "function") {
      performance.mark(`omb:pwa:${phase}`);
    }
  } catch {
  }
}

function computeP95(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[index] ?? null;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createPwaPerfRegistry(
  nowFn: () => number = defaultNow,
  onChange?: (snapshot: PwaPerfSnapshot) => void,
): PwaPerfRegistry {
  let bootPath: PwaBootPath = "unknown";
  let milestones: Partial<Record<PwaPerfPhase, number>> = {};
  let events: PwaPerfEvent[] = [];
  let droppedEvents = 0;
  let snapshotWrites = 0;
  let lastWriteDurationMs: number | null = null;
  let maxWriteDurationMs = 0;
  let lastWriteBytesApprox: number | null = null;
  let writeSamples: number[] = [];

  function buildSnapshot(): PwaPerfSnapshot {
    const startMs = milestones.html_shell_start ?? milestones.main_entry;
    const renderMs = milestones.root_render_called;
    const cachedMs = milestones.first_cached_paint ?? milestones.idb_cache_ready;
    const liveMs = milestones.first_live_sse_connected;

    const coldStartMs =
      startMs !== undefined && renderMs !== undefined && renderMs >= startMs
        ? roundMs(renderMs - startMs)
        : null;
    const cachedHydrationMs =
      startMs !== undefined && cachedMs !== undefined && cachedMs >= startMs
        ? roundMs(cachedMs - startMs)
        : null;
    const liveConnectMs =
      startMs !== undefined && liveMs !== undefined && liveMs >= startMs
        ? roundMs(liveMs - startMs)
        : null;
    const liveSyncDeltaMs =
      cachedMs !== undefined && liveMs !== undefined && liveMs >= cachedMs
        ? roundMs(liveMs - cachedMs)
        : null;

    return {
      bootPath,
      milestones: { ...milestones },
      events: [...events],
      droppedEvents,
      snapshotWrites,
      lastWriteDurationMs,
      maxWriteDurationMs,
      p95WriteDurationMs: computeP95(writeSamples),
      lastWriteBytesApprox,
      coldStartMs,
      cachedHydrationMs,
      liveConnectMs,
      liveSyncDeltaMs,
    };
  }

  function publish(): void {
    if (onChange) onChange(buildSnapshot());
  }

  function pushEvent(event: PwaPerfEvent): void {
    if (events.length >= MAX_PWA_PERF_EVENTS) {
      events.shift();
      droppedEvents += 1;
    }
    events.push(event);
  }

  return {
    mark(phase, detail, atMs) {
      const ts = roundMs(atMs ?? nowFn());
      if (milestones[phase] === undefined) {
        milestones[phase] = ts;
      }
      pushEvent(detail ? { phase, atMs: ts, detail } : { phase, atMs: ts });
      safePerfMark(phase);
      publish();
      return ts;
    },
    setBootPath(path) {
      bootPath = path;
      publish();
    },
    recordSnapshotWrite(durationMs, bytesApprox) {
      const safeDuration = roundMs(Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
      snapshotWrites += 1;
      lastWriteDurationMs = safeDuration;
      if (safeDuration > maxWriteDurationMs) maxWriteDurationMs = safeDuration;
      if (typeof bytesApprox === "number" && Number.isFinite(bytesApprox) && bytesApprox >= 0) {
        lastWriteBytesApprox = Math.round(bytesApprox);
      }
      if (writeSamples.length >= MAX_SNAPSHOT_WRITE_SAMPLES) {
        writeSamples.shift();
      }
      writeSamples.push(safeDuration);
      pushEvent({
        phase: "idb_snapshot_write",
        atMs: roundMs(nowFn()),
        detail: `${safeDuration}ms`,
      });
      publish();
    },
    snapshot: buildSnapshot,
    reset() {
      bootPath = "unknown";
      milestones = {};
      events = [];
      droppedEvents = 0;
      snapshotWrites = 0;
      lastWriteDurationMs = null;
      maxWriteDurationMs = 0;
      lastWriteBytesApprox = null;
      writeSamples = [];
      publish();
    },
  };
}

function publishToWindow(snapshot: PwaPerfSnapshot): void {
  try {
    if (typeof window !== "undefined") {
      window.__ombPwaPerf = snapshot;
    }
  } catch {
  }
}

export const pwaPerf = createPwaPerfRegistry(defaultNow, publishToWindow);

export function bootstrapPwaPerf(): void {
  try {
    if (typeof window !== "undefined" && typeof window.__ombBootTs === "number" && Number.isFinite(window.__ombBootTs)) {
      pwaPerf.mark("html_shell_start", undefined, window.__ombBootTs);
    }
  } catch {
  }
  pwaPerf.mark("main_entry");
}

export function getPwaPerfSnapshot(): PwaPerfSnapshot {
  return pwaPerf.snapshot();
}
