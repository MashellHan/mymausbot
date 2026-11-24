import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return {
    items: [] as SidebarMenuItem[],
    activeView: "chat" as string,
    pluginsOpen: false,
    filesReady: false,
    dispatch: vi.fn(),
  };
});

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: {
      activeView: fixture.activeView,
      routines: [],
      webhooks: [],
      bots: [],
      routineRuns: [],
      pluginsOpen: fixture.pluginsOpen,
      config: null,
    },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("./CloudRoomCard", () => ({ CloudRoomCard: () => null }));
vi.mock("./CloudUsageMeter", () => ({ CloudUsageCard: () => null }));
vi.mock("./SidebarFooterNav", () => ({ useAutomationsNeedYou: () => false }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
vi.mock("@/lib/cloud-files", () => ({ useCloudFilesReady: () => fixture.filesReady }));
vi.mock("./SidebarPopoverMenu", () => ({
  SidebarPopoverMenu: (props: { items: SidebarMenuItem[]; renderTrigger: (s: { open: boolean }) => unknown }) => {
    fixture.items = props.items;
    return props.renderTrigger({ open: false }) as ReturnType<typeof createElement>;
  },
}));

const { SidebarPhoneBar } = await import("./SidebarPhoneBar");
const { setActivePwaAuth } = await import("@/lib/pwa-transport");

afterAll(() => {
  setActivePwaAuth(null);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fixture.items = [];
  fixture.activeView = "chat";
  fixture.pluginsOpen = false;
  fixture.filesReady = false;
  fixture.dispatch.mockReset();
  setActivePwaAuth(null);
});

describe("SidebarPhoneBar", () => {
  it("shows published-apps and apps in normal mode", () => {
    renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {} }));
    expect(fixture.items.map((item) => item.key)).toEqual(["automations", "team-map", "published-apps", "apps"]);
  });

  it("hides published-apps and apps in remote PWA mode while keeping automations and team-map", () => {
    setActivePwaAuth({
      ownerKey: "https://relay.mxhan.com::env::s1",
      relayUrl: "https://relay.mxhan.com",
      token: "omb_sess_1",
      deviceId: "d1",
      environmentId: "env",
      sessionId: "s1",
      serverName: "Mac",
      scopes: ["client"],
      pairedAt: 1,
    });
    renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {} }));
    expect(fixture.items.map((item) => item.key)).toEqual(["automations", "team-map"]);
  });

  it("calls onOpened on every tool selection, including when already on that view", () => {
    fixture.filesReady = true;
    const onOpened = vi.fn();
    renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {}, onOpened }));
    expect(fixture.items.map((item) => item.key)).toEqual(["automations", "team-map", "files", "published-apps", "apps"]);
    for (const item of fixture.items) {
      item.onSelect();
    }
    expect(onOpened).toHaveBeenCalledTimes(5);
    expect(fixture.dispatch).toHaveBeenNthCalledWith(1, { type: "showRoutines", view: "list" });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(2, { type: "showTeamMap" });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(3, { type: "showFiles" });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(4, { type: "showPublishedApps" });
    expect(fixture.dispatch).toHaveBeenNthCalledWith(5, { type: "togglePlugins", open: true });

    onOpened.mockClear();
    fixture.activeView = "routines";
    renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {}, onOpened }));
    fixture.items.find((item) => item.key === "automations")!.onSelect();
    expect(onOpened).toHaveBeenCalledTimes(1);

    onOpened.mockClear();
    fixture.activeView = "team-map";
    renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {}, onOpened }));
    fixture.items.find((item) => item.key === "team-map")!.onSelect();
    expect(onOpened).toHaveBeenCalledTimes(1);

    onOpened.mockClear();
    fixture.pluginsOpen = true;
    renderToStaticMarkup(createElement(SidebarPhoneBar, { query: "", onQuery: () => {}, onOpened }));
    fixture.items.find((item) => item.key === "apps")!.onSelect();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });
});
