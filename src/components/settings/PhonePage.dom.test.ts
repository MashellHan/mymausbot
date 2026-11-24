// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  funnel: {
    checking: false,
    state: { status: "ready" as const, origin: "https://mac.tail123.ts.net" },
    refresh: vi.fn(),
  },
  companionState: {
    enabled: true,
    keepAwake: false,
    port: 8810,
    devices: [
      {
        id: "comp-1",
        name: "Ada's Native App",
        createdAt: 1,
        lastSeenAt: Date.now() - 30_000,
        cloudDesktopAccess: false,
        routes: "any" as const,
      },
    ],
    pairing: null,
    routes: {
      wifi: { on: true, since: Date.now() - 86_400_000 },
      relay: { on: false, since: null },
      tailscale: { on: false, since: null },
      https: { on: false, since: null },
    },
    notices: [],
  },
}));

vi.mock("@/state/store", () => ({
  api: (...args: unknown[]) => mocks.api(...args),
  useStore: () => ({
    state: {
      bots: [{ id: "b1", name: "Accounting Bot" }],
      config: {},
      appSettingsPhonePairing: 0,
    },
    dispatch: () => {},
  }),
}));

vi.mock("@/lib/tailscale-funnel", () => ({
  useTailscaleFunnel: () => mocks.funnel,
}));

vi.mock("@/lib/session", async (original) => ({
  ...(await original<typeof import("@/lib/session")>()),
  readSessionState: async () => ({ kind: "loopback" }),
}));

vi.mock("../PhoneSetupFlow", () => ({
  companionBridge: () => ({}),
  companionAccountBridge: () => null,
  usePhoneSetupController: () => ({
    state: mocks.companionState,
    busy: false,
    accountBusy: false,
    account: null,
    accountAct: () => undefined,
    act: vi.fn(),
    accountError: null,
    error: null,
    useLocal: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    refreshTailscale: vi.fn(),
  }),
  PhoneSetupFlowView: () => null,
  companionAccountActionError: () => null,
  loadCompanionBridgeState: () => null,
  shouldHydrateCompanionEmail: () => false,
}));

vi.mock("../PhonesList", () => ({ PhonesList: () => null }));
vi.mock("../TailnetComputers", () => ({ TailnetComputers: () => null }));
vi.mock("../SidebarProfileMenu", () => ({
  useCloudPhoneDestination: () => ({ cloud: "none", bridge: null }),
}));
vi.mock("./settings-context", () => ({
  useOtherPlaces: () => [],
}));
vi.mock("./settings-shell", () => ({
  useSettingsShell: () => ({
    ctx: {
      desktop: true,
      here: true,
      home: true,
      cloud: false,
      team: false,
      client: false,
      admin: true,
      places: false,
      plan: false,
      organization: false,
      environments: false,
      installations: false,
      skills: false,
      advanced: false,
    },
    place: { name: "This computer" },
  }),
}));

const { PhonePage } = await import("./pages/PhonePage");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  mocks.api.mockReset().mockImplementation(async (path: string) => {
    if (path === "/api/auth/sessions") {
      return {
        sessions: [
          {
            id: "sess-pwa-1",
            label: "Safari on iPhone",
            scopes: ["client"],
            lastSeenAt: Date.now() - 60_000,
            expiresAt: Date.now() + 86_400_000,
            pwa: true,
          },
          {
            id: "sess-native-2",
            label: "Funnel iPhone",
            scopes: ["client"],
            lastSeenAt: Date.now() - 120_000,
            expiresAt: Date.now() + 86_400_000,
          },
        ],
        current: null,
      };
    }
    if (path === "/api/config") return {};
    if (path === "/api/pwa-bridge") {
      return {
        config: {
          enabled: true,
          relayUrl: "https://relay.mxhan.com",
          hostId: "mac-mini",
          hasBridgeSecret: true,
          pwaOrigin: "https://mausbot.mxhan.com",
          defaultBotId: null,
        },
        status: { state: "connected", lastConnectedAt: Date.now(), lastError: null, activeStreams: 0 },
      };
    }
    throw new Error(`unexpected api call: ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("PhonePage unified Paired and PWA settings", () => {
  it("merges Companion and Server paired devices into one Paired card with Native/PWA tags and removes the standalone relay toggle", async () => {
    await act(async () => {
      root.render(createElement(PhonePage));
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-paired-device="sess-pwa-1"]')).not.toBeNull();
      expect(host.querySelector('[data-settings-block="pwa-bridge"]')).not.toBeNull();
    });

    const pairedSections = host.querySelectorAll('[data-settings-block="paired"]');
    expect(pairedSections).toHaveLength(1);

    const pairedBlock = pairedSections[0]!;
    const nativeRow = pairedBlock.querySelector('[data-phone-row="comp-1"]')!;
    const pwaRow = pairedBlock.querySelector('[data-paired-device="sess-pwa-1"]')!;
    const serverNativeRow = pairedBlock.querySelector('[data-paired-device="sess-native-2"]')!;
    expect(nativeRow.querySelector("[data-settings-tag]")?.textContent).toBe("Native");
    expect(pwaRow.querySelector("[data-settings-tag]")?.textContent).toBe("PWA");
    expect(serverNativeRow.querySelector("[data-settings-tag]")?.textContent).toBe("Native");

    expect(host.textContent).not.toContain("Fast mobile PWA relay");
    expect(host.querySelector("[data-pwa-bridge-switch]")).toBeNull();
  });
});
