import { describe, expect, it } from "vitest";
import type { MiniAppState } from "../../../shared/mini-apps";
import { applyMiniAppDataChanged, MINI_APP_UPDATE_CHECK_TTL_MS, shouldCheckMiniAppUpdate } from "./mini-app-live-sync";

describe("mini-app live sync helpers", () => {
  it("applies mini-app.data-changed in-place only when a bound dataset revision advances", () => {
    const state: MiniAppState = {
      appId: "app-1",
      revision: 3,
      templateVersion: 2,
      status: "active",
      data: [{ datasetId: "ds-1", revision: 5 }],
    };
    expect(applyMiniAppDataChanged(state, "ds-other", 6)).toBeNull();
    expect(applyMiniAppDataChanged(state, "ds-1", 5)).toBeNull();
    expect(applyMiniAppDataChanged(state, "ds-1", 4)).toBeNull();
    expect(applyMiniAppDataChanged(state, "ds-1", 6)).toEqual({
      ...state,
      data: [{ datasetId: "ds-1", revision: 6 }],
    });
  });

  it("gates background release update checks on a 30-minute TTL unless manual", () => {
    const now = 1_700_000_000_000;
    expect(shouldCheckMiniAppUpdate(undefined, now, false)).toBe(true);
    expect(shouldCheckMiniAppUpdate(now - 60_000, now, false)).toBe(false);
    expect(shouldCheckMiniAppUpdate(now - 60_000, now, true)).toBe(true);
    expect(shouldCheckMiniAppUpdate(now - MINI_APP_UPDATE_CHECK_TTL_MS, now, false)).toBe(true);
  });
});
