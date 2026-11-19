import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSidebarToolsLayout, SIDEBAR_TOOLS_LAYOUT_KEY, loadPinnedCircles, PINNED_CIRCLES_KEY, subscribePinnedCircles, loadUniversalPins, UNIVERSAL_PINS_KEY } from "./sidebar-preferences";
import { FOLLOW_UP_KEY, readFollowUpDefault, subscribeFollowUpDefault } from "./follow-up";
import { applyWindowPref, reportWindowPrefs, windowPrefValues } from "./window-prefs";
import { setShowRunCard } from "./run-card-preferences";
import { setShowThreads } from "./thread-preferences";
import { setColorUserBubbles } from "./user-bubble-preference";

const values = new Map<string, string>();
const browser = new EventTarget();

function dispatchStorageChange(key: string) {
  browser.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea: null }));
}

beforeEach(() => {
  values.clear();
  vi.stubGlobal("window", browser);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window preferences", () => {
  it("keeps Raw, Simple and Advanced distinct when a bot changes the window mode", async () => {
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: "raw" });
    expect((await windowPrefValues())["appearance.mode"]).toBe("raw");
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: "advanced" });
    expect((await windowPrefValues())["appearance.mode"]).toBe("advanced");
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: false });
    expect((await windowPrefValues())["appearance.mode"]).toBe("advanced");
    applyWindowPref({ kind: "window-pref", id: "appearance.mode", value: "simple" });
    expect((await windowPrefValues())["appearance.mode"]).toBe("simple");
  });

  it("applies a frame with the preference's setter and ignores a value the schema refuses", async () => {
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "mod-enter" });
    expect(values.get("omb-send-key")).toBe("mod-enter");
    applyWindowPref({ kind: "window-pref", id: "general.sendKey", value: "space" });
    expect(values.get("omb-send-key")).toBe("mod-enter");
    applyWindowPref({ kind: "window-pref", id: "general.notificationSounds", value: false });
    expect(await windowPrefValues()).toMatchObject({ "general.sendKey": "mod-enter", "general.notificationSounds": false });
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
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    applyWindowPref({ kind: "window-pref", id: "appearance.toolsLayout", value: "toolbar" });
    expect(readSidebarToolsLayout()).toBe("toolbar");
    await vi.advanceTimersByTimeAsync(250);
    fetched.mockClear();
    values.set(SIDEBAR_TOOLS_LAYOUT_KEY, "rows");
    dispatchStorageChange(SIDEBAR_TOOLS_LAYOUT_KEY);
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
    const unsubscribeUi = subscribePinnedCircles(() => undefined);
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    applyWindowPref({ kind: "window-pref", id: "appearance.pinnedCircles", value: true });
    expect(loadPinnedCircles()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    unsubscribeUi();
    fetched.mockClear();
    values.set(PINNED_CIRCLES_KEY, "false");
    dispatchStorageChange(PINNED_CIRCLES_KEY);
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

  it("applies only valid universal-pin frames and reports the in-session choice when storage is blocked", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "appearance.universalPins", value: true });
    expect(values.get(UNIVERSAL_PINS_KEY)).toBe("true");
    applyWindowPref({ kind: "window-pref", id: "appearance.universalPins", value: "yes" });
    expect(loadUniversalPins()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.universalPins"]).toBe(true);

    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    applyWindowPref({ kind: "window-pref", id: "appearance.universalPins", value: false });
    expect(loadUniversalPins()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[1] as unknown as [string, RequestInit])[1].body)).values["appearance.universalPins"]).toBe(false);
  });

  it("keeps bridge reports fresh after another window changes universal pins without a sidebar UI subscriber", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    applyWindowPref({ kind: "window-pref", id: "appearance.universalPins", value: true });
    expect(loadUniversalPins()).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    fetched.mockClear();
    values.set(UNIVERSAL_PINS_KEY, "false");
    dispatchStorageChange(UNIVERSAL_PINS_KEY);
    expect(loadUniversalPins()).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.universalPins"]).toBe(false);
    fetched.mockClear();
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(JSON.parse(String((fetched.mock.calls[0] as unknown as [string, RequestInit])[1].body)).values["appearance.universalPins"]).toBe(false);
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
    const unsubscribeUi = subscribeFollowUpDefault(() => undefined);
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    applyWindowPref({ kind: "window-pref", id: "general.followUp", value: "queue" });
    expect(readFollowUpDefault()).toBe("queue");
    await vi.advanceTimersByTimeAsync(250);
    unsubscribeUi();
    fetched.mockClear();
    values.set(FOLLOW_UP_KEY, "steer");
    dispatchStorageChange(FOLLOW_UP_KEY);
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
    setShowRunCard(false);
    reportWindowPrefs();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values).toMatchObject({ "general.sendKey": "shift-enter", "appearance.runCard": false });
    applyWindowPref({ kind: "window-pref", id: "appearance.runCard", value: true });
    applyWindowPref({ kind: "window-pref", id: "appearance.runCard", value: "false" });
    expect((await windowPrefValues())["appearance.runCard"]).toBe(true);
  });

  it("applies and reports the stored thread choice, rejecting a non-boolean frame", async () => {
    vi.useFakeTimers();
    const fetched = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetched);
    applyWindowPref({ kind: "window-pref", id: "appearance.showThreads", value: false });
    expect(values.get("omb-show-threads")).toBe("0");
    applyWindowPref({ kind: "window-pref", id: "appearance.showThreads", value: "true" });
    expect((await windowPrefValues())["appearance.showThreads"]).toBe(false);
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
    expect((await windowPrefValues())["appearance.userBubbles"]).toBe(false);
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
    expect((await windowPrefValues())["general.notificationFeed"]).toBe(false);
    applyWindowPref({ kind: "window-pref", id: "general.notificationFeed", value: true });
    expect(values.get("omb-notification-feed")).toBe("1");
    applyWindowPref({ kind: "window-pref", id: "general.notificationFeed", value: "false" });
    expect((await windowPrefValues())["general.notificationFeed"]).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/window-prefs");
    expect(JSON.parse(String(init.body)).values["general.notificationFeed"]).toBe(true);
  });

  it("leaves out a preference whose desktop bridge this window lacks, so the server refuses it here", async () => {
    const values = await windowPrefValues();
    expect(values).not.toHaveProperty("remote.relay");
    expect(values).not.toHaveProperty("general.openAtLogin");
  });

  it("reads and switches a remote route through the companion bridge on this computer's page", async () => {
    const routes = { wifi: { on: false, since: null }, relay: { on: true, since: 1 } };
    const setRoute = vi.fn(async (route: "wifi" | "relay", on: boolean) => { routes[route].on = on; return { routes } as never; });
    const ogb = { companion: { state: async () => ({ routes, keepAwake: false }), setRoute } };
    vi.stubGlobal("window", { ogb });
    vi.stubGlobal("ogb", ogb);
    expect(await windowPrefValues()).toMatchObject({ "remote.wifi": false, "remote.relay": true, "remote.keepAwake": false });
    applyWindowPref({ kind: "window-pref", id: "remote.wifi", value: true });
    expect(setRoute).toHaveBeenCalledWith("wifi", true);
  });
});
