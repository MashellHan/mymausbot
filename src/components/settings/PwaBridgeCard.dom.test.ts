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

function makeState(overrides: {
  config?: Partial<PwaBridgeSettingsResponse["config"]>;
  status?: Partial<PwaBridgeSettingsResponse["status"]>;
} = {}): PwaBridgeSettingsResponse {
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
  vi.useRealTimers();
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
  it("masks the stored bridge secret and clears a rotated secret on collapse or Hide", async () => {
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

    const foldToggle = host.querySelector<HTMLButtonElement>('[data-settings-disclosure="pwa-bridge-settings"] button')!;
    await act(async () => {
      foldToggle.click();
    });

    expect(host.querySelector("[data-pwa-secret-status]")?.textContent).toBe("Saved on this computer (hidden).");
    expect(host.querySelector("[data-pwa-secret-revealed]")).toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-pwa-rotate-secret]")!.click();
    });

    expect(host.querySelector("[data-pwa-secret-hash]")?.textContent).toBe("a".repeat(64));
    expect(host.querySelector("[data-pwa-secret-value]")?.textContent).toBe("omb_bridge_once_secret_value");

    await act(async () => {
      foldToggle.click();
    });
    await act(async () => {
      foldToggle.click();
    });
    expect(host.querySelector("[data-pwa-secret-revealed]")).toBeNull();
    expect(host.textContent).not.toContain("omb_bridge_once_secret_value");

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-pwa-rotate-secret]")!.click();
    });
    expect(host.querySelector("[data-pwa-secret-value]")?.textContent).toBe("omb_bridge_once_secret_value");

    const hideBtn = Array.from(host.querySelectorAll("button")).find((btn) => btn.textContent === "Hide")!;
    await act(async () => {
      hideBtn.click();
    });
    expect(host.querySelector("[data-pwa-secret-revealed]")).toBeNull();
    expect(host.textContent).not.toContain("omb_bridge_once_secret_value");
  });

  it("places Relay settings above Pair PWA, enables Pair PWA once configured, and handles pairing dialog keyboard and QR quiet zone", async () => {
    let current = makeState({
      config: {
        enabled: true,
        relayUrl: "",
        hostId: "mac-mini",
        hasBridgeSecret: false,
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
            state: current.config.hasBridgeSecret ? "connected" : "off",
            lastConnectedAt: current.config.hasBridgeSecret ? 1_700_000_000_000 : null,
            lastError: null,
            activeStreams: 0,
          },
        };
        return current;
      }
      if (path === "/api/pwa-bridge/rotate-secret" && init?.method === "POST") {
        current = {
          config: { ...current.config, enabled: true, hasBridgeSecret: true },
          status: { state: "connected", lastConnectedAt: 1_700_000_000_000, lastError: null, activeStreams: 0 },
        };
        return {
          ...current,
          bridgeSecret: "omb_bridge_ready_secret",
          bridgeSecretSha256: "c".repeat(64),
        };
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

    expect(host.querySelector("[data-pwa-bridge-switch]")).toBeNull();
    expect(host.textContent).not.toContain("Fast mobile PWA relay");

    const rowsEl = host.querySelector('[data-settings-block="pwa-bridge"] [data-settings-rows]')!;
    const relayDisclosure = rowsEl.querySelector('[data-settings-disclosure="pwa-bridge-settings"]')!;
    const pairBtn = rowsEl.querySelector<HTMLButtonElement>("[data-pwa-pair-action]")!;
    expect(relayDisclosure.compareDocumentPosition(pairBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pairBtn.disabled).toBe(true);

    await act(async () => {
      relayDisclosure.querySelector<HTMLButtonElement>("button")!.click();
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
    expect(pairBtn.disabled).toBe(true);

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-pwa-rotate-secret]")!.click();
    });
    expect(pairBtn.disabled).toBe(false);

    pairBtn.focus();
    await act(async () => {
      pairBtn.click();
    });

    const dialog = document.body.querySelector("[data-settings-dialog]");
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector("[data-pwa-pair-dialog]")).not.toBeNull();
    const svg = dialog!.querySelector<SVGElement>("[data-pwa-pair-qr] svg");
    expect(svg).not.toBeNull();
    expect(svg!.querySelectorAll("path")[1]?.getAttribute("d")).toMatch(/^M4[ ,]4/);
    expect(dialog!.querySelector("[data-pwa-pair-url]")?.textContent).toContain("https://mausbot.mxhan.com/#pair=");

    const copyBtn = dialog!.querySelector<HTMLButtonElement>("[data-pwa-pair-copy]")!;
    expect(document.activeElement).toBe(copyBtn);

    await act(async () => {
      copyBtn.click();
    });
    expect(mocks.copyText).toHaveBeenCalledWith(
      "https://mausbot.mxhan.com/#pair=eyJyZWxheVVybCI6Imh0dHBzOi8vcmVsYXkubXhoYW4uY29tIiwiY3JlZGVudGlhbCI6Im9tYl9wYWlyX3h5eiJ9",
    );

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector("[data-settings-dialog]")).toBeNull();
    expect(document.activeElement).toBe(pairBtn);
  });

  it("does not reopen Relay settings or expose the secret if collapsed while rotate-secret is in flight", async () => {
    let resolveRotate!: (value: unknown) => void;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/pwa-bridge" && (!init?.method || init.method === "GET")) {
        return Promise.resolve(makeState());
      }
      if (path === "/api/pwa-bridge/rotate-secret" && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveRotate = resolve;
        });
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    await renderCard();

    const foldToggle = host.querySelector<HTMLButtonElement>('[data-settings-disclosure="pwa-bridge-settings"] button')!;
    await act(async () => {
      foldToggle.click();
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-pwa-rotate-secret]")!.click();
    });

    await act(async () => {
      foldToggle.click();
    });
    expect(foldToggle.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      resolveRotate({
        ...makeState(),
        bridgeSecret: "omb_bridge_once_secret_value",
        bridgeSecretSha256: "b".repeat(64),
      });
    });

    expect(foldToggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[data-pwa-secret-revealed]")).toBeNull();
    expect(host.textContent).not.toContain("omb_bridge_once_secret_value");
  });

  it("restores focus to Pair PWA after a delayed invite blurs the disabled button", async () => {
    let resolveInvite!: (value: unknown) => void;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/pwa-bridge" && (!init?.method || init.method === "GET")) {
        return Promise.resolve(makeState());
      }
      if (path === "/api/pwa-bridge/invite" && init?.method === "POST") {
        return new Promise((resolve) => {
          resolveInvite = resolve;
        });
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    await renderCard();

    const pairBtn = host.querySelector<HTMLButtonElement>("[data-pwa-pair-action]")!;
    pairBtn.focus();
    await act(async () => {
      pairBtn.click();
    });
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      resolveInvite({
        id: "pair_delayed",
        inviteUrl: "https://mausbot.mxhan.com/#pair=eyJyZWxheVVybCI6Imh0dHBzOi8vcmVsYXkubXhoYW4uY29tIiwiY3JlZGVudGlhbCI6Im9tYl9wYWlyX2RlbGF5ZWQifQ",
        expiresAt: Date.now() + 600_000,
        relayUrl: "https://relay.mxhan.com",
        defaultBotId: "acct-bot",
      });
    });

    expect(document.body.querySelector("[data-settings-dialog]")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector("[data-settings-dialog]")).toBeNull();
    expect(document.activeElement).toBe(pairBtn);
  });

  it("recovers from transient initial load failures, ignores stale GETs and stale 404s, and stops polling on current 403", async () => {
    vi.useFakeTimers();

    let getCall = 0;
    let rejectStale404!: (err: unknown) => void;
    let resolveDuringSaveGet!: (value: PwaBridgeSettingsResponse) => void;
    let resolveSave!: (value: PwaBridgeSettingsResponse) => void;
    const saved = makeState({ config: { relayUrl: "https://sg-relay.mxhan.com" } });

    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/pwa-bridge" && (!init?.method || init.method === "GET")) {
        getCall += 1;
        if (getCall === 1) {
          return new Promise<PwaBridgeSettingsResponse>((_resolve, reject) => {
            rejectStale404 = reject;
          });
        }
        if (getCall === 2) return Promise.resolve(makeState());
        if (getCall === 3) {
          return new Promise<PwaBridgeSettingsResponse>((resolve) => {
            resolveDuringSaveGet = resolve;
          });
        }
        return Promise.resolve(saved);
      }
      if (path === "/api/pwa-bridge" && init?.method === "PUT") {
        return new Promise<PwaBridgeSettingsResponse>((resolve) => {
          resolveSave = resolve;
        });
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    await act(async () => {
      root.render(createElement(PwaBridgeCard));
    });
    expect(host.querySelector('[data-settings-block="pwa-bridge"]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(host.querySelector('[data-settings-block="pwa-bridge"]')).not.toBeNull();

    await act(async () => {
      rejectStale404(Object.assign(new Error("stale 404"), { status: 404 }));
    });
    expect(host.querySelector('[data-settings-block="pwa-bridge"]')).not.toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-settings-disclosure="pwa-bridge-settings"] button')!.click();
    });
    const relayInput = host.querySelector<HTMLInputElement>("#pwa-bridge-relay-url")!;

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(relayInput, "https://sg-relay.mxhan.com");
      relayInput.dispatchEvent(new Event("input", { bubbles: true }));
      host.querySelector<HTMLButtonElement>("[data-pwa-bridge-save]")!.click();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await act(async () => {
      resolveSave(saved);
    });
    expect(relayInput.value).toBe("https://sg-relay.mxhan.com");

    await act(async () => {
      resolveDuringSaveGet(makeState({ config: { relayUrl: "https://relay.mxhan.com" } }));
    });
    expect(relayInput.value).toBe("https://sg-relay.mxhan.com");

    mocks.api.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 403 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(host.querySelector('[data-settings-block="pwa-bridge"]')).toBeNull();

    const countAt403 = mocks.api.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.api.mock.calls.length).toBe(countAt403);
  });

  it("disables Pair PWA under managed policy and localizes relay and validation errors", async () => {
    const current = makeState({
      config: { enabled: true },
      status: {
        state: "error",
        lastConnectedAt: null,
        lastError: "bridge authentication rejected (4401)",
        activeStreams: 0,
      },
    });

    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/pwa-bridge" && (!init?.method || init.method === "GET")) {
        return current;
      }
      if (path === "/api/pwa-bridge" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        if (body.hostId === "bad host") {
          throw Object.assign(
            new Error("hostId must be 1 to 64 characters using letters, numbers, '.', '_' or '-'"),
            { status: 400 },
          );
        }
        return current;
      }
      throw new Error(`unexpected api call: ${path}`);
    });

    await act(async () => {
      root.render(createElement(PwaBridgeCard, { remoteBlocked: "Remote access is turned off by your organization." }));
    });
    await vi.waitFor(() => expect(host.querySelector('[data-settings-block="pwa-bridge"]')).not.toBeNull());

    expect(host.querySelector<HTMLButtonElement>("[data-pwa-pair-action]")!.disabled).toBe(true);

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-settings-disclosure="pwa-bridge-settings"] button')!.click();
    });
    const hostInput = host.querySelector<HTMLInputElement>("#pwa-bridge-host-id")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(hostInput, "bad host");
      hostInput.dispatchEvent(new Event("input", { bubbles: true }));
      host.querySelector<HTMLButtonElement>("[data-pwa-bridge-save]")!.click();
    });

    const alertEl = host.querySelector('[role="alert"]');
    expect(alertEl?.textContent).toBe("Host ID must use 1 to 64 letters, numbers, dots, underscores, or hyphens.");
    expect(alertEl?.textContent).not.toContain("1 to 64 characters");

    act(() => root.unmount());
    root = createRoot(host);
    await renderCard();
    expect(host.textContent).toContain("Relay rejected the relay secret.");
    expect(host.textContent).not.toContain("4401");
  });

  it("aligns Relay settings form fields and secret row inside SettingsRows", async () => {
    mocks.api.mockResolvedValue(makeState());
    await renderCard();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-settings-disclosure="pwa-bridge-settings"] button')!.click();
    });

    const rows = host.querySelector('[data-settings-block="pwa-bridge"] [data-settings-rows]')!;
    const form = rows.querySelector<HTMLFormElement>(":scope > form[data-pwa-bridge-form]")!;
    const secretRow = rows.querySelector<HTMLElement>(":scope > [data-pwa-secret-row]")!;
    expect(form).not.toBeNull();
    expect(secretRow).not.toBeNull();
    expect(form.firstElementChild?.className).toContain("px-4");
    expect(form.querySelector("[data-settings-form-foot]")).not.toBeNull();
    expect(secretRow.className).toContain("px-4");
    expect(secretRow.className).not.toContain("border-t");
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
