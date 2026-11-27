import { describe, expect, it } from "vitest";
import {
  BANNER_MAX_PULL_DOWN_PX,
  computeBannerSwipeState,
  resolveMobileTopChromeMode,
} from "./pwa-top-chrome";

describe("pwa-top-chrome coordination & banner swipe physics", () => {
  it("hides redundant working activity bar when offline/disconnected unless a waiting item exists", () => {
    expect(
      resolveMobileTopChromeMode({
        connected: false,
        cachedHydrated: true,
        online: false,
        macOffline: false,
        hasWaitingActivity: false,
      }),
    ).toEqual({
      suppressWorkingActivity: true,
      compactActivityBar: true,
      hideActivityBar: true,
    });

    expect(
      resolveMobileTopChromeMode({
        connected: false,
        cachedHydrated: false,
        online: true,
        macOffline: true,
        hasWaitingActivity: true,
      }),
    ).toEqual({
      suppressWorkingActivity: true,
      compactActivityBar: true,
      hideActivityBar: false,
    });

    expect(
      resolveMobileTopChromeMode({
        connected: true,
        cachedHydrated: false,
        online: true,
        macOffline: false,
        hasWaitingActivity: false,
      }),
    ).toEqual({
      suppressWorkingActivity: false,
      compactActivityBar: false,
      hideActivityBar: false,
    });
  });

  it("commits upward flick or drag past threshold and damps downward pull", () => {
    expect(computeBannerSwipeState(-40, -0.1)).toMatchObject({ decision: "dismiss", offsetY: -40 });
    expect(computeBannerSwipeState(-18, -0.5)).toMatchObject({ decision: "dismiss" });
    expect(computeBannerSwipeState(-12, 0)).toMatchObject({ decision: "snap-back", offsetY: -12 });
    expect(computeBannerSwipeState(100, 0)).toEqual({
      offsetY: BANNER_MAX_PULL_DOWN_PX,
      opacity: 1,
      decision: "snap-back",
    });
  });
});
