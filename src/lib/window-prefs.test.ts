import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadPinnedCircles, PINNED_CIRCLES_KEY, subscribePinnedCircles } from "./sidebar-preferences";
import { applyWindowPref, reportWindowPrefs, windowPrefValues } from "./window-prefs";

const values = new Map<string, string>();
beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window preferences", () => {
  it("keeps Raw, Simple and Advanced distinct when a bot changes the window mode", () => {
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: "raw" });
    expect(windowPrefValues()["appearance.mode"]).toBe("raw");
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: "advanced" });
    expect(windowPrefValues()["appearance.mode"]).toBe("advanced");
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: false });
    expect(windowPrefValues()["appearance.mode"]).toBe("advanced");
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: "simple" });
    expect(windowPrefValues()["appearance.mode"]).toBe("simple");
  });

  it("applies a frame with the preference's setter and ignores a value the schema refuses", () => {
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "mod-enter" });
    expect(values.get("omb-send-key")).toBe("mod-enter");
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "space" });
    expect(values.get("omb-send-key")).toBe("mod-enter");
    applyWindowPref({ kind: "window-pref", id: "general.notificationSounds", value: false });
    expect(windowPrefValues()).toMatchObject({ "general.sendKey": "mod-enter", "general.notificationSounds": false });
  });

  it("applies only valid pinned-circle frames and reports the in-session choice when storage is blocked", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "appearance.pinnedCircles", value: true });
    expect(values.get(PINNED_CIRCLES_KEY)).toBe("true");
    applyWindowPref({ kind: "window-pref", id: "appearance.pinnedCircles", value: "yes" });
    expect(loadPinnedCircles()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.pinnedCircles"]).toBe(true);

    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    applyWindowPref({ kind: "window-pref", id: "appearance.pinnedCircles", value: false });
    expect(loadPinnedCircles()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[1] as unknown as [string, RequestInit])[1].body)).values["appearance.pinnedCircles"]).toBe(false);
  });

  it("keeps pinned-circle bridge reports fresh after the last sidebar UI subscriber unmounts", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === "storage") storageListener = listener; },
      removeEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === "storage" && storageListener === listener) storageListener = undefined; },
    });
    const unsubscribeUi = subscribePinnedCircles(() => undefined);
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    applyWindowPref({ kind: "window-pref", id: "appearance.pinnedCircles", value: true });
    expect(loadPinnedCircles()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    unsubscribeUi();
    fetched.mockClear();
    values.set(PINNED_CIRCLES_KEY, "false");
    storageListener?.({ key: PINNED_CIRCLES_KEY, storageArea: null } as StorageEvent);
    expect(loadPinnedCircles()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.pinnedCircles"]).toBe(false);
    const unsubscribeRemountedUi = subscribePinnedCircles(() => undefined);
    expect(loadPinnedCircles()).toBe(false);
    unsubscribeRemountedUi();
    fetched.mockClear();
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.pinnedCircles"]).toBe(false);
  });

  it("reports the window's values once after a burst of setters", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "shift-enter" });
    reportWindowPrefs();
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values).toMatchObject({ "general.sendKey": "shift-enter" });
  });
});
