import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapPwaPerf,
  createPwaPerfRegistry,
  getPwaPerfSnapshot,
  MAX_PWA_PERF_EVENTS,
  pwaPerf,
} from "./pwa-perf";

describe("pwa-perf telemetry ring buffer", () => {
  afterEach(() => {
    pwaPerf.reset();
    vi.unstubAllGlobals();
  });

  it("computes monotonic cold-start, cached-hydration, and live-sync deltas", () => {
    let clock = 10;
    const registry = createPwaPerfRegistry(() => clock);

    registry.mark("html_shell_start", undefined, 0);
    clock = 45;
    registry.mark("main_entry");
    clock = 120;
    registry.mark("idb_cache_ready");
    registry.setBootPath("cached");
    clock = 180;
    registry.mark("root_render_called");
    clock = 210;
    registry.mark("first_cached_paint");
    clock = 610;
    registry.mark("first_live_sse_connected");

    const snap = registry.snapshot();
    expect(snap.bootPath).toBe("cached");
    expect(snap.coldStartMs).toBe(180);
    expect(snap.cachedHydrationMs).toBe(210);
    expect(snap.liveConnectMs).toBe(610);
    expect(snap.liveSyncDeltaMs).toBe(400);
    expect(snap.droppedEvents).toBe(0);
  });

  it("evicts oldest events FIFO past MAX_PWA_PERF_EVENTS while preserving first milestones", () => {
    let clock = 0;
    const registry = createPwaPerfRegistry(() => {
      clock += 5;
      return clock;
    });

    registry.mark("main_entry", "boot");
    for (let i = 0; i < MAX_PWA_PERF_EVENTS + 12; i++) {
      registry.mark("idb_snapshot_write", `w-${i}`);
    }

    const snap = registry.snapshot();
    expect(snap.events).toHaveLength(MAX_PWA_PERF_EVENTS);
    expect(snap.droppedEvents).toBe(13);
    expect(snap.milestones.main_entry).toBe(5);
    expect(snap.events.at(-1)?.detail).toBe(`w-${MAX_PWA_PERF_EVENTS + 11}`);
  });

  it("tracks snapshot write counters, max, p95, and approximate bytes", () => {
    let clock = 100;
    const registry = createPwaPerfRegistry(() => {
      clock += 10;
      return clock;
    });

    const durations = [2, 3, 4, 5, 6, 8, 9, 10, 12, 42];
    for (const d of durations) {
      registry.recordSnapshotWrite(d, 4096);
    }

    const snap = registry.snapshot();
    expect(snap.snapshotWrites).toBe(10);
    expect(snap.lastWriteDurationMs).toBe(42);
    expect(snap.maxWriteDurationMs).toBe(42);
    expect(snap.p95WriteDurationMs).toBe(42);
    expect(snap.lastWriteBytesApprox).toBe(4096);
  });

  it("handles missing window or throwing performance.mark safely", () => {
    vi.stubGlobal("performance", {
      now: () => 50,
      mark: () => {
        throw new Error("blocked");
      },
    });
    expect(() => bootstrapPwaPerf()).not.toThrow();
    expect(getPwaPerfSnapshot().milestones.main_entry).toBe(50);
  });

  it("publishes snapshot onto window.__ombPwaPerf when window exists", () => {
    const fakeWindow: { __ombBootTs?: number; __ombPwaPerf?: unknown } = { __ombBootTs: 12.5 };
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("performance", { now: () => 40, mark: () => {} });

    bootstrapPwaPerf();
    expect(fakeWindow.__ombPwaPerf).toMatchObject({
      milestones: {
        html_shell_start: 12.5,
        main_entry: 40,
      },
    });
  });
});
