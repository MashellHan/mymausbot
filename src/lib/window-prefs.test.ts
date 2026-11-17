import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOLLOW_UP_KEY, readFollowUpDefault, subscribeFollowUpDefault } from "./follow-up";
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

  it("applies only valid follow-up frames and reports the in-session choice when storage is blocked", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "general.followUp", value: "queue" });
    expect(values.get(FOLLOW_UP_KEY)).toBe("queue");
    applyWindowPref({ kind: "window-pref", id: "general.followUp", value: "restart" });
    expect(readFollowUpDefault()).toBe("queue");
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["general.followUp"]).toBe("queue");

    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    applyWindowPref({ kind: "window-pref", id: "general.followUp", value: "steer" });
    expect(readFollowUpDefault()).toBe("steer");
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[1] as unknown as [string, RequestInit])[1].body)).values["general.followUp"]).toBe("steer");
  });

  it("keeps follow-up reports fresh after the last Settings UI subscriber unmounts", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === "storage") storageListener = listener; },
      removeEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === "storage" && storageListener === listener) storageListener = undefined; },
    });
    const unsubscribeUi = subscribeFollowUpDefault(() => undefined);
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    applyWindowPref({ kind: "window-pref", id: "general.followUp", value: "queue" });
    expect(readFollowUpDefault()).toBe("queue");
    await vi.advanceTimersByTimeAsync(250);
    unsubscribeUi();
    fetched.mockClear();
    values.set(FOLLOW_UP_KEY, "steer");
    storageListener?.({ key: FOLLOW_UP_KEY, storageArea: null } as StorageEvent);
    expect(readFollowUpDefault()).toBe("steer");
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["general.followUp"]).toBe("steer");
    const unsubscribeRemountedUi = subscribeFollowUpDefault(() => undefined);
    expect(readFollowUpDefault()).toBe("steer");
    unsubscribeRemountedUi();
    fetched.mockClear();
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["general.followUp"]).toBe("steer");
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
