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
      wifi: { on: true, since: Date.now() - 86_400_000 as number | null },
      relay: { on: false, since: null as number | null },
      tailscale: { on: false, since: null as number | null, name: null as string | null, computers: false },
      https: { on: false, since: null as number | null },
    },
    notices: [],
    tailnetShare: { on: true, origin: "http://mac.tail123.ts.net:8799", https: false, problem: null },
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
          {
            id: "sess-computer-3",
            label: "MacBook Pro",
            scopes: ["admin", "client"],
            lastSeenAt: Date.now() - 180_000,
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
  it("orders Paired -> Phone -> Computer -> collapsed Advanced, merges phones & computers, and drops verbose Tailscale copy", async () => {
    mocks.companionState.routes = {
      wifi: { on: true, since: Date.now() - 86_400_000 },
      relay: { on: false, since: null },
      tailscale: { on: true, since: Date.now() - 86_400_000, name: "mac.tail123.ts.net", computers: true },
      https: { on: false, since: null },
    };

    await act(async () => {
      root.render(createElement(PhonePage));
    });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-paired-device="sess-pwa-1"]')).not.toBeNull();
      expect(host.querySelector('[data-settings-block="pwa-bridge"]')).not.toBeNull();
      expect(host.querySelector('[data-settings-block="computers-pair"]')).not.toBeNull();
    });

    const pairedSections = host.querySelectorAll('[data-settings-block="paired"]');
    expect(pairedSections).toHaveLength(1);

    const pairedBlock = pairedSections[0]!;
    expect(pairedBlock.querySelector('[data-phone-row="comp-1"] [data-settings-tag]')?.textContent).toBe("Native");
    expect(pairedBlock.querySelector('[data-paired-device="sess-pwa-1"] [data-settings-tag]')?.textContent).toBe("PWA");
    expect(pairedBlock.querySelector('[data-paired-device="sess-native-2"] [data-settings-tag]')?.textContent).toBe("Native");
    expect(pairedBlock.querySelector('[data-paired-device="sess-computer-3"] [data-settings-tag]')?.textContent).toBe("Computer");

    const pwaBlock = host.querySelector('[data-settings-block="pwa-bridge"]')!;
    expect(pwaBlock.querySelector("h3")?.textContent).toBe("Mobile web app via relay");
    expect(host.textContent).not.toContain("Fast mobile PWA relay");
    expect(host.querySelector("[data-pwa-bridge-switch]")).toBeNull();

    // Order: Paired -> Phone (pair / funnel / pwa) -> Computer -> Advanced (collapsed by default).
    const pairBlock = host.querySelector('[data-settings-block="pair"]')!;
    const funnelBlock = host.querySelector('[data-settings-block="funnel"]')!;
    const computersBlock = host.querySelector('[data-settings-block="computers-pair"]')!;
    const advancedBlock = host.querySelector('[data-settings-block="advanced"]')!;
    expect(pairedBlock.compareDocumentPosition(pairBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pairBlock.compareDocumentPosition(funnelBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(funnelBlock.compareDocumentPosition(pwaBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pwaBlock.compareDocumentPosition(computersBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(computersBlock.compareDocumentPosition(advancedBlock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Verbose WireGuard / HTTPS Certificates copy is hidden from the main Computer card.
    expect(host.textContent).not.toContain("HTTPS Certificates in Tailscale");
    expect(host.textContent).not.toContain("Same Wi-Fi");

    const advToggle = advancedBlock.querySelector<HTMLButtonElement>('[data-settings-disclosure="phone-advanced"] button')!;
    expect(advToggle.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      advToggle.click();
    });
    expect(advToggle.getAttribute("aria-expanded")).toBe("true");
    expect(advancedBlock.textContent).toContain("Same Wi-Fi");
  });
});
