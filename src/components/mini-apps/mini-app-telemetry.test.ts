import { describe, expect, it } from "vitest";
import { MINI_APP_PERF_MAX_ENTRIES, MiniAppPerfRingBuffer } from "./mini-app-telemetry.ts";

describe("MiniAppPerfRingBuffer", () => {
  it("tracks lifecycle milestones (t0..t4), doc source, query cache hit rate, and p95 summary", () => {
    const perf = new MiniAppPerfRingBuffer(10);
    perf.startSelect({ appId: "app-1", revision: 2, templateVersion: 1, nowMs: 100 });
    perf.markDocReady("app-1", "client-cache", 104);
    perf.markIframeInit("app-1", 118);
    perf.recordQuery("app-1", true, 122);
    perf.recordQuery("app-1", false, 140);
    perf.markReady("app-1", 145);

    const [entry] = perf.snapshot();
    expect(entry).toMatchObject({
      appId: "app-1",
      t1DocReadyMs: 4,
      t2IframeInitMs: 18,
      t3FirstQueryMs: 22,
      t4ReadyMs: 45,
      docSource: "client-cache",
      cacheHits: 1,
      totalQueries: 2,
    });
    expect(perf.summary()).toEqual({
      count: 1,
      p95ReadyMs: 45,
      cacheHitRate: 0.5,
    });
  });

  it("caps stored entries to a fixed ring buffer ceiling", () => {
    const perf = new MiniAppPerfRingBuffer();
    for (let i = 0; i < MINI_APP_PERF_MAX_ENTRIES + 15; i += 1) {
      perf.startSelect({ appId: `app-${i}`, revision: 1, templateVersion: 1, nowMs: i * 10 });
    }
    const snap = perf.snapshot();
    expect(snap).toHaveLength(MINI_APP_PERF_MAX_ENTRIES);
    expect(snap[0]!.appId).toBe("app-15");
    expect(snap[snap.length - 1]!.appId).toBe(`app-${MINI_APP_PERF_MAX_ENTRIES + 14}`);
  });
});
