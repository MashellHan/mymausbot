import { describe, expect, it } from "vitest";
import {
  MOBILE_DRAWER_TRIGGER_CLASS,
  MOBILE_HEADER_BUTTON_CLASS,
  resolvePwaHeaderStatus,
} from "./pwa-header-status";

describe("pwa-header-status & mobile header touch ergonomics", () => {
  it("returns no status cue outside Remote PWA mode", () => {
    expect(
      resolvePwaHeaderStatus({
        remotePwa: false,
        connected: false,
        cachedHydrated: true,
        busy: true,
        waitingOnYou: true,
      }),
    ).toEqual({ tone: "none", dotClass: "" });
  });

  it("prioritizes offline-cached > waiting-on-you > streaming on Remote PWA", () => {
    expect(
      resolvePwaHeaderStatus({
        remotePwa: true,
        connected: false,
        cachedHydrated: true,
        busy: true,
        waitingOnYou: true,
      }),
    ).toMatchObject({ tone: "offline-cached", dotClass: "bg-ink-tertiary" });

    expect(
      resolvePwaHeaderStatus({
        remotePwa: true,
        connected: true,
        cachedHydrated: false,
        busy: true,
        waitingOnYou: true,
      }),
    ).toMatchObject({ tone: "waiting", dotClass: "bg-warning" });

    expect(
      resolvePwaHeaderStatus({
        remotePwa: true,
        connected: true,
        cachedHydrated: false,
        busy: true,
        waitingOnYou: false,
      }),
    ).toMatchObject({ tone: "streaming" });
  });

  it("enforces 44px coarse-pointer touch targets and safe-area top positioning", () => {
    expect(MOBILE_HEADER_BUTTON_CLASS).toContain("touch:size-11");
    expect(MOBILE_DRAWER_TRIGGER_CLASS).toContain("env(safe-area-inset-top");
    expect(MOBILE_DRAWER_TRIGGER_CLASS).toContain("touch:size-11");
  });
});
