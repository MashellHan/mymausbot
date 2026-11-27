import { afterEach, describe, expect, it, vi } from "vitest";
import { preloadScreens, shouldPreloadBackgroundScreens } from "./lazy-screens";

describe("shouldPreloadBackgroundScreens & preloadScreens mobile/PWA guard", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("skips background screen preloads on localhost, Remote PWA, Save-Data, slow cellular, and coarse pointers", () => {
    expect(shouldPreloadBackgroundScreens({ hostname: "127.0.0.1", remotePwa: false })).toBe(false);
    expect(shouldPreloadBackgroundScreens({ hostname: "localhost", remotePwa: false })).toBe(false);
    expect(shouldPreloadBackgroundScreens({ hostname: "mausbot.mxhan.com", remotePwa: true })).toBe(false);
    expect(shouldPreloadBackgroundScreens({ hostname: "cloud.openmausbot.com", remotePwa: false, saveData: true })).toBe(false);
    expect(shouldPreloadBackgroundScreens({ hostname: "cloud.openmausbot.com", remotePwa: false, effectiveType: "3g" })).toBe(false);
    expect(shouldPreloadBackgroundScreens({ hostname: "cloud.openmausbot.com", remotePwa: false, effectiveType: "2g" })).toBe(false);
    expect(shouldPreloadBackgroundScreens({ hostname: "cloud.openmausbot.com", remotePwa: false, coarsePointer: true })).toBe(false);
  });

  it("allows background screen preloads on desktop Cloud over 4g/Wi-Fi", () => {
    expect(
      shouldPreloadBackgroundScreens({
        hostname: "cloud.openmausbot.com",
        remotePwa: false,
        saveData: false,
        effectiveType: "4g",
        coarsePointer: false,
      }),
    ).toBe(true);
  });

  it("schedules zero timers when gated off", () => {
    vi.useFakeTimers();
    const stop = preloadScreens("127.0.0.1");
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});
