// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { PwaBridgeSettingsResponse } from "../../../shared/pwa-bridge";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  copyText: vi.fn(async (_text: string) => "copied" as const),
  bots: [
    { id: "acct-bot", name: "Accounting Bot" },
    { id: "helper", name: "Helper" },
  ],
  config: {} as Record<string, unknown>,
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
}));

vi.mock("@/state/store", () => ({
  api: (...args: unknown[]) => mocks.api(...args),
  useStore: () => ({
    state: {
      bots: mocks.bots,
      config: mocks.config,
      appSettingsPhonePairing: 0,
    },
    dispatch: () => {},
  }),
}));

vi.mock("@/lib/copy-text", () => ({
  copyText: (text: string) => mocks.copyText(text),
  useCopyFeedback: () => ["idle", async () => "copied"],
}));

vi.mock("@/lib/tailscale-funnel", () => ({
  useTailscaleFunnel: () => null,
}));

vi.mock("../PhoneDevicesSection", () => ({
  PhoneDevicesSection: () => createElement("div", { "data-mock-phone-devices": "" }),
}));

vi.mock("../ServerPairingCard", () => ({
  ServerPairingCard: () => createElement("div", { "data-mock-server-pairing": "" }),
}));

vi.mock("../SidebarProfileMenu", () => ({
  useCloudPhoneDestination: () => ({ cloud: "none", bridge: null }),
}));

vi.mock("./settings-context", () => ({
  useOtherPlaces: () => [],
}));

vi.mock("./settings-shell", () => ({
  useSettingsShell: () => ({
    ctx: mocks.ctx,
    place: { name: "This computer" },
  }),
}));

const { PwaBridgeCard } = await import("./PwaBridgeCard");
const { PhonePage } = await import("./pages/PhonePage");

function makeState(overrides: Partial<PwaBridgeSettingsResponse> = {}): PwaBridgeSettingsResponse {
  return {
    config: {
      enabled: true,
      relayUrl: "https://relay.mxhan.com",
      hostId: "mac-mini",
      hasBridgeSecret: true,
      pwaOrigin: "https://mausbot.mxhan.com",
      defaultBotId: "acct-bot",
      ...overrides.config,
    },
    status: {
      state: "connected",
      lastConnectedAt: 1_700_000_000_000,
      lastError: null,
      activeStreams: 0,
      ...overrides.status,
    },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  mocks.api.mockReset();
  mocks.copyText.mockClear();
  mocks.config = {};
  mocks.ctx = {
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
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function renderCard() {
  await act(async () => {
    root.render(createElement(PwaBridgeCard));
  });
  await vi.waitFor(() => expect(host.querySelector('[data-settings-block="pwa-bridge"]')).not.toBeNull());
}

describe("PwaBridgeCard", () => {
  it("masks the stored bridge secret and reveals a rotated secret once until hidden", async () => {
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/pwa-bridge" && (!init?.method || init.method === "GET")) {
        return makeState();
      }
      if (path === "/api/pwa-bridge/rotate-secret" && init?.method === "POST") {
        return {
          ...makeState(),
          bridgeSecret: "omb_bridge_once_secret_value",
          bridgeSecretSha256: "a".repeat(64),
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    await renderCard();

    expect(host.textContent).toContain("Connected to relay");
    expect(host.textContent).not.toContain("omb_bridge_");

    // Open the settings fold and verify the masked secret status.
    const foldToggle = host.querySelector<HTMLButtonElement>('[data-settings-disclosure="pwa-bridge-settings"] button')!;
    await act(async () => {
      foldToggle.click();
    });

    expect(host.querySelector("[data-pwa-secret-status]")?.textContent).toBe("Saved on this computer (hidden).");
    expect(host.querySelector("[data-pwa-secret-revealed]")).toBeNull();

    const rotateBtn = host.querySelector<HTMLButtonElement>("[data-pwa-rotate-secret]")!;
    await act(async () => {
      rotateBtn.click();
    });

    expect(host.querySelector("[data-pwa-secret-hash]")?.textContent).toBe("a".repeat(64));
    expect(host.querySelector("[data-pwa-secret-value]")?.textContent).toBe("omb_bridge_once_secret_value");

    const hideBtn = Array.from(host.querySelectorAll("button")).find((btn) => btn.textContent === "Hide")!;
    await act(async () => {
      hideBtn.click();
    });
    expect(host.querySelector("[data-pwa-secret-revealed]")).toBeNull();
    expect(host.textContent).not.toContain("omb_bridge_once_secret_value");
  });

  it("saves relayUrl and defaultBotId, toggles bridge state, and opens the #pair= QR modal", async () => {
    let current = makeState({
      config: {
        enabled: false,
        relayUrl: "https://relay.mxhan.com",
        hostId: "mac-mini",
        hasBridgeSecret: true,
        pwaOrigin: "https://mausbot.mxhan.com",
        defaultBotId: null,
      },
      status: { state: "off", lastConnectedAt: null, lastError: null, activeStreams: 0 },
    });

    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/pwa-bridge" && (!init?.method || init.method === "GET")) {
        return current;
      }
      if (path === "/api/pwa-bridge" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        current = {
          config: { ...current.config, ...body },
          status: {
            state: body.enabled === false ? "off" : (body.enabled ?? current.config.enabled) ? "connected" : "off",
            lastConnectedAt: 1_700_000_000_000,
            lastError: null,
            activeStreams: 0,
          },
        };
        return current;
      }
      if (path === "/api/pwa-bridge/invite" && init?.method === "POST") {
        return {
          id: "pair_1",
          inviteUrl: "https://mausbot.mxhan.com/#pair=eyJyZWxheVVybCI6Imh0dHBzOi8vcmVsYXkubXhoYW4uY29tIiwiY3JlZGVudGlhbCI6Im9tYl9wYWlyX3h5eiJ9",
          expiresAt: Date.now() + 600_000,
          relayUrl: current.config.relayUrl,
          defaultBotId: current.config.defaultBotId,
        };
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    await renderCard();

    const pairBtn = host.querySelector<HTMLButtonElement>("[data-pwa-pair-action]")!;
    expect(pairBtn.disabled).toBe(true);

    // Enable the relay via switch.
    const toggle = host.querySelector<HTMLButtonElement>("[data-pwa-bridge-switch]")!;
    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(pairBtn.disabled).toBe(false);

    // Open settings fold, change relayUrl and defaultBotId, and save.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-settings-disclosure="pwa-bridge-settings"] button')!.click();
    });

    const relayInput = host.querySelector<HTMLInputElement>("#pwa-bridge-relay-url")!;
    const botSelect = host.querySelector<HTMLSelectElement>("#pwa-bridge-default-bot")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(relayInput, "https://sg-relay.mxhan.com");
      relayInput.dispatchEvent(new Event("input", { bubbles: true }));
      relayInput.dispatchEvent(new Event("change", { bubbles: true }));
      botSelect.value = "acct-bot";
      botSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-pwa-bridge-save]")!.click();
    });
    expect(current.config.relayUrl).toBe("https://sg-relay.mxhan.com");
    expect(current.config.defaultBotId).toBe("acct-bot");

    // Generate pairing link and verify QR + #pair= URL + copy button.
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-pwa-pair-action]")!.click();
    });

    const dialog = document.body.querySelector("[data-pwa-pair-dialog]");
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector("[data-pwa-pair-qr] svg")).not.toBeNull();
    expect(dialog!.querySelector("[data-pwa-pair-url]")?.textContent).toContain("https://mausbot.mxhan.com/#pair=");

    await act(async () => {
      dialog!.querySelector<HTMLButtonElement>("[data-pwa-pair-copy]")!.click();
    });
    expect(mocks.copyText).toHaveBeenCalledWith(
      "https://mausbot.mxhan.com/#pair=eyJyZWxheVVybCI6Imh0dHBzOi8vcmVsYXkubXhoYW4uY29tIiwiY3JlZGVudGlhbCI6Im9tYl9wYWlyX3h5eiJ9",
    );
  });

  it("hides cleanly when the server refuses the bridge route (403)", async () => {
    mocks.api.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 403 }));
    await act(async () => {
      root.render(createElement(PwaBridgeCard));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector('[data-settings-block="pwa-bridge"]')).toBeNull();
  });

  it("renders on PhonePage for this computer and stays hidden on MausBot Cloud", async () => {
    mocks.api.mockResolvedValue(makeState());
    await act(async () => {
      root.render(createElement(PhonePage));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-settings-block="pwa-bridge"]')).not.toBeNull());

    mocks.ctx.cloud = true;
    mocks.ctx.here = false;
    await act(async () => {
      root.render(createElement(PhonePage));
    });
    expect(host.querySelector('[data-settings-block="pwa-bridge"]')).toBeNull();
  });
});
