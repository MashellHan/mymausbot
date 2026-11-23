// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "@/lib/i18n";
import { makePwaOwnerKey, remoteFetch } from "@/lib/pwa-config";
import { resetPwaCacheForTests, setBootPwaCache } from "@/lib/pwa-cache";
import { isMacOffline, setActivePwaAuth, setMacOffline } from "@/lib/pwa-transport";
import { LiveConnectionStrip } from "@/components/LiveConnectionStrip";
import { initialStoreStateFromPwaCache } from "./pwa-boot";
import { initialState, reducer, type Bot } from "./store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeBot(id: string, threadId = `t-${id}`): Bot {
  return {
    id,
    threadId,
    name: id,
    title: "",
    description: "",
    notifications: false,
    color: "blue",
    unread: false,
    busy: false,
    modelSelection: { instanceId: "inst-1", model: "gpt-6" },
    messages: [{ id: `m-${id}`, role: "bot", kind: "text", text: `hello from ${id}`, at: 100 }],
    tasks: [{ threadId, title: "Main", createdAt: 100, updatedAt: 100 }],
  };
}

describe("PWA cached fast-boot and connection strip", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    setActivePwaAuth(null);
    setMacOffline(false);
    resetPwaCacheForTests();
    vi.restoreAllMocks();
  });

  it("hydrates from boot cache with hydrated:true, connected:false, then reconciles live hydrate", () => {
    const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-1");
    setActivePwaAuth({
      relayUrl: "https://relay.mxhan.com",
      sessionId: "ses-1",
      deviceId: "dev-1",
      token: "tok",
      environmentId: "env-1",
      ownerKey,
      serverName: "Mac mini",
      scopes: ["admin"],
      defaultBotId: "general",
      pairedAt: 100,
    });

    const acc = makeBot("accounting", "t-acc-main");
    acc.tasks = [
      { threadId: "t-acc-main", title: "Main", createdAt: 100, updatedAt: 100 },
      { threadId: "t-acc-q4", title: "Q4", createdAt: 200, updatedAt: 200 },
    ];
    const gen = makeBot("general");

    setBootPwaCache({
      ownerKey,
      queryBotId: null,
      defaultBotId: "general",
      prefs: {
        ownerKey,
        pinnedBotId: "accounting",
        openPinnedOnLaunch: true,
        lastBotId: "accounting",
        lastThreadId: "t-acc-q4",
        updatedAt: 500,
      },
      snapshot: {
        ownerKey,
        savedAt: 500,
        bots: [gen, acc],
        groups: [],
        sections: ["Finance"],
        config: null,
      },
    });

    const cachedState = initialStoreStateFromPwaCache(initialState);
    expect(cachedState.hydrated).toBe(true);
    expect(cachedState.cachedHydrated).toBe(true);
    expect(cachedState.connected).toBe(false);
    expect(cachedState.selectedId).toBe("accounting");
    expect(cachedState.bots.find((b) => b.id === "accounting")?.threadId).toBe("t-acc-q4");

    const liveAcc = {
      ...makeBot("accounting", "t-acc-main"),
      messages: [{ id: "m-live", role: "bot" as const, kind: "text" as const, text: "live update", at: 900 }],
    };
    const reconciled = reducer(cachedState, {
      type: "hydrate",
      bots: [makeBot("general"), liveAcc],
      groups: [],
      sections: ["Finance"],
      computerControl: {},
      resumeId: "accounting",
    });
    expect(reconciled.hydrated).toBe(true);
    expect(reconciled.cachedHydrated).toBe(false);
    expect(reconciled.selectedId).toBe("accounting");
    expect(reconciled.bots.find((b) => b.id === "accounting")?.messages[0]?.text).toBe("live update");
  });

  it("tracks 503 mac_offline from relay responses and clears on ok responses", async () => {
    const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-2");
    setActivePwaAuth({
      relayUrl: "https://relay.mxhan.com",
      sessionId: "ses-2",
      deviceId: "dev-1",
      token: "tok",
      environmentId: "env-1",
      ownerKey,
      serverName: "Mac mini",
      scopes: ["admin"],
      pairedAt: 100,
    });

    const offlineRes = new Response(JSON.stringify({ error: "Mac host is offline", code: "mac_offline" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    await remoteFetch("/api/bots", undefined, vi.fn().mockResolvedValue(offlineRes) as unknown as typeof fetch);
    await Promise.resolve();
    expect(isMacOffline()).toBe(true);

    const okRes = new Response(JSON.stringify({ bots: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await remoteFetch("/api/bots", undefined, vi.fn().mockResolvedValue(okRes) as unknown as typeof fetch);
    expect(isMacOffline()).toBe(false);
  });

  it("shows non-blocking Connecting…, Mac offline, and Offline in LiveConnectionStrip", () => {
    act(() => root.render(createElement(LiveConnectionStrip, { connected: false, hydrated: true, cachedHydrated: true })));
    expect(container.querySelector('[data-live-connection="connecting"]')?.textContent).toContain(t("liveConnection.connecting"));

    act(() => setMacOffline(true));
    expect(container.querySelector('[data-live-connection="mac-offline"]')?.textContent).toContain(t("liveConnection.macOffline"));

    act(() => { window.dispatchEvent(new Event("offline")); });
    expect(container.querySelector('[data-live-connection="offline"]')?.textContent).toContain(t("liveConnection.offline"));

    act(() => {
      window.dispatchEvent(new Event("online"));
      setMacOffline(false);
    });
    act(() => root.render(createElement(LiveConnectionStrip, { connected: true, hydrated: true, cachedHydrated: false })));
    expect(container.textContent).toBe("");
  });
});
