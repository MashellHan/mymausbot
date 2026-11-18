import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSidebarToolsLayout, SIDEBAR_TOOLS_LAYOUT_KEY, loadPinnedCircles, PINNED_CIRCLES_KEY, subscribePinnedCircles } from "./sidebar-preferences";
import { applyWindowPref, reportWindowPrefs, windowPrefValues } from "./window-prefs";
import { setShowRunCard } from "./run-card-preferences";
import { setShowThreads } from "./thread-preferences";
import { setColorUserBubbles } from "./user-bubble-preference";

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

  it("applies only valid sidebar tools frames and reports the in-session choice when storage is blocked", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "appearance.toolsLayout", value: "toolbar" });
    expect(values.get(SIDEBAR_TOOLS_LAYOUT_KEY)).toBe("toolbar");
    applyWindowPref({ kind: "window-pref", id: "appearance.toolsLayout", value: "icons" });
    expect(readSidebarToolsLayout()).toBe("toolbar");
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.toolsLayout"]).toBe("toolbar");

    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    applyWindowPref({ kind: "window-pref", id: "appearance.toolsLayout", value: "rows" });
    expect(readSidebarToolsLayout()).toBe("rows");
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[1] as unknown as [string, RequestInit])[1].body)).values["appearance.toolsLayout"]).toBe("rows");
  });

  it("keeps bridge reports fresh after another window changes tools layout without a layout UI subscriber", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    let storageListener: ((event: StorageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: StorageEvent) => void) => { if (type === "storage") storageListener = listener; },
      removeEventListener: () => undefined,
    });
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    applyWindowPref({ kind: "window-pref", id: "appearance.toolsLayout", value: "toolbar" });
    expect(readSidebarToolsLayout()).toBe("toolbar");
    await vi.advanceTimersByTimeAsync(250);
    fetched.mockClear();
    values.set(SIDEBAR_TOOLS_LAYOUT_KEY, "rows");
    storageListener?.({ key: SIDEBAR_TOOLS_LAYOUT_KEY, storageArea: null } as StorageEvent);
    expect(readSidebarToolsLayout()).toBe("rows");
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.toolsLayout"]).toBe("rows");
    fetched.mockClear();
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.toolsLayout"]).toBe("rows");
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
    setShowRunCard(false);
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values).toMatchObject({ "general.sendKey": "shift-enter", "appearance.runCard": false });
    applyWindowPref({ kind: "window-pref", id: "appearance.runCard", value: true });
    applyWindowPref({ kind: "window-pref", id: "appearance.runCard", value: "false" });
    expect(windowPrefValues()["appearance.runCard"]).toBe(true);
  });

  it("applies and reports the stored thread choice, rejecting a non-boolean frame", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "appearance.showThreads", value: false });
    expect(values.get("omb-show-threads")).toBe("0");
    applyWindowPref({ kind: "window-pref", id: "appearance.showThreads", value: "true" });
    expect(windowPrefValues()["appearance.showThreads"]).toBe(false);
    setShowThreads(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values["appearance.showThreads"]).toBe(true);
  });

  it("applies and reports message bubble colour, rejecting a non-boolean frame", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "appearance.userBubbles", value: false });
    expect(values.get("omb-color-user-bubbles")).toBe("0");
    applyWindowPref({ kind: "window-pref", id: "appearance.userBubbles", value: "true" });
    expect(windowPrefValues()["appearance.userBubbles"]).toBe(false);
    setColorUserBubbles(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values["appearance.userBubbles"]).toBe(true);
  });

  it("applies and reports the notification feed choice, rejecting a non-boolean frame", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    expect(windowPrefValues()["general.notificationFeed"]).toBe(false);
    applyWindowPref({ kind: "window-pref", id: "general.notificationFeed", value: true });
    expect(values.get("omb-notification-feed")).toBe("1");
    applyWindowPref({ kind: "window-pref", id: "general.notificationFeed", value: "false" });
    expect(windowPrefValues()["general.notificationFeed"]).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values["general.notificationFeed"]).toBe(true);
  });
});
