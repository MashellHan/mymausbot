import { describe, expect, it } from "vitest";
import { composerActionSizeClass, composerDockClass } from "./pwa-composer-dock";
import { computeViewportMetrics, KEYBOARD_INSET_THRESHOLD_PX } from "./pwa-viewport";

describe("pwa-viewport keyboard tracking & composer dock ergonomics", () => {
  it("distinguishes Safari URL bar collapse from an open virtual keyboard on iPhone", () => {
    // URL bar change (~54px) must not flag keyboardOpen
    expect(
      computeViewportMetrics({ layoutHeight: 852, visualHeight: 798, offsetTop: 0 }),
    ).toEqual({
      visualHeight: 798,
      keyboardInset: 54,
      keyboardOpen: false,
      offsetTop: 0,
    });

    // Virtual keyboard open (~336px)
    expect(
      computeViewportMetrics({ layoutHeight: 852, visualHeight: 516, offsetTop: 0 }),
    ).toEqual({
      visualHeight: 516,
      keyboardInset: 336,
      keyboardOpen: true,
      offsetTop: 0,
    });
  });

  it("accounts for Safari visualViewport.offsetTop and Android resizes-content", () => {
    expect(
      computeViewportMetrics({ layoutHeight: 852, visualHeight: 500, offsetTop: 24 }),
    ).toEqual({
      visualHeight: 500,
      keyboardInset: 328,
      keyboardOpen: true,
      offsetTop: 24,
    });

    // Android interactive-widget=resizes-content resizes layoutHeight alongside visualHeight
    expect(
      computeViewportMetrics({ layoutHeight: 516, visualHeight: 516, offsetTop: 0 }),
    ).toEqual({
      visualHeight: 516,
      keyboardInset: 0,
      keyboardOpen: false,
      offsetTop: 0,
    });
    expect(KEYBOARD_INSET_THRESHOLD_PX).toBe(96);
  });

  it("provides touch-sized composer action classes and safe-area dock classes", () => {
    expect(composerDockClass({ simpleDock: true })).toContain("pwa-composer-dock");
    expect(composerDockClass({ simpleDock: false })).toContain("pb-3");
    expect(composerActionSizeClass(true)).toContain("touch:size-10");
    expect(composerActionSizeClass(false)).toContain("touch:size-10");
  });
});
