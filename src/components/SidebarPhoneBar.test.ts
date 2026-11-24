import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return {
    items: [] as SidebarMenuItem[],
    dispatch: vi.fn(),
  };
});

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { activeView: "chat", routines: [], webhooks: [], bots: [], routineRuns: [], pluginsOpen: false, config: null },
    dispatch: fixture.dispatch,
  }),
}));
vi.mock("./CloudRoomCard", () => ({ CloudRoomCard: () => null }));
vi.mock("./CloudUsageMeter", () => ({ CloudUsageCard: () => null }));
vi.mock("./SidebarFooterNav", () => ({ useAutomationsNeedYou: () => false }));
vi.mock("./UpdateIndicator", () => ({ UpdateIndicator: () => null }));
vi.mock("@/lib/cloud-files", () => ({ useCloudFilesReady: () => false }));
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
});
