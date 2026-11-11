// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ advanced: true, android: false, browser: false, page: undefined as unknown }));

vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useCaptionChrome: () => ({ padClass: undefined }),
  useDesktopCapabilities: () => ({
    ready: true,
    capabilities: {
      host: { platform: "darwin", label: "Host", session: "unknown", packaged: true, homeDir: "/Users/me" },
      windowChrome: "native",
      screenPreview: { available: false, interaction: "none" },
      dictation: { available: false, engine: "none", onDevice: false },
      localComputer: { available: false, support: "unsupported", enabled: false, status: "unavailable" },
    },
  }),
}));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./CloudScreenPreview", () => ({ CloudScreenPreview: () => null }));
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: fixture.android ? [{ serial: "p1" }] : [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: ({ page }: { page?: unknown }) => { fixture.page = page; return null; } }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("./mini-apps/MiniAppsPanel", () => ({ MiniAppsPanel: () => createElement("div", { "data-testid": "mini-apps-panel" }) }));
vi.mock("./data/DataPanel", () => ({ DataPanel: () => createElement("div", { "data-testid": "data-panel" }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string) => {
    if (path.startsWith("/api/bots/scout/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/scout/computer?")) return { surface: "cloud", backend: "box", configured: true, box: { boxId: "bx_23456789", state: "ready" } };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
const { requestPanelPage } = await import("@/lib/page-open");
const { BotEditorStore, initialState } = await import("@/state/store");

const engine = (instanceId: string) => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, access: "subscription",
  snapshot: { state: "available", version: "1", authenticated: true },
  models: { default: "m", options: [{ id: "m", label: "M" }] },
  capabilities: { computerMcp: true, browserMcp: true },
}) as InstanceInfo;
const makeBot = (patch: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "thread", name: "Scout", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, computer: "cloud", messages: [],
  modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "thread", title: "Thread", createdAt: 1, approvalMode: "ask" }],
  ...patch,
}) as unknown as Bot;

let root: Root | null = null;
const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, instances: [engine("claude"), engine("codex")], config: { box: { configured: true },
    ...(fixture.browser ? { features: { browser: true }, browserEngine: { kind: "engine" } } : {}) } as AppState["config"] } as AppState,
  dispatch: vi.fn(),
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot) => {
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: createElement(ComputerPanel, { bot }) })));
  await settle();
};
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="computer-tabs"] [role="tab"]')];
const tab = (label: string) => tabs().find((candidate) => candidate.textContent?.trim() === label)!;
const tabLabels = () => tabs().map((candidate) => candidate.textContent?.trim());
const selected = () => tabs().find((candidate) => candidate.getAttribute("aria-selected") === "true")?.textContent?.trim();
const tabStops = () => tabs().filter((candidate) => candidate.getAttribute("tabindex") === "0").map((candidate) => candidate.textContent?.trim());
const tabListName = () => document.querySelector('[data-testid="computer-tabs"]')?.getAttribute("aria-label");
const press = (label: string, key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  flushSync(() => tab(label).dispatchEvent(event));
  return event;
};

beforeAll(() => {
  vi.stubGlobal("ogb", undefined);
});
beforeEach(() => {
  // The panel remembers each conversation's tab, so one test's click must not choose the next test's tab.
  const saved = new Map<string, string>([["omb-computer-panel-view:scout", "computer"]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  fixture.advanced = true;
  fixture.android = false;
  fixture.browser = false;
  fixture.page = undefined;
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  setLocale("en");
});

describe("Computer panel tab", () => {
  it("opens Bot by default even when the bot uses the browser", async () => {
    localStorage.removeItem("omb-computer-panel-view:scout");
    fixture.browser = true;
    await open(makeBot({ computer: "browser" }));
    expect(selected()).toBe("Bot");
    expect(document.querySelector('[data-testid="bot-overview-intro"]')).not.toBeNull();
    await open(makeBot({ computer: "browser", busy: true }));
    expect(selected()).toBe("Bot");
    flushSync(() => tab("Data").click());
    await open(makeBot({ computer: "browser", busy: false }));
    expect(selected()).toBe("Data");
  });

  it("honors a new Mini Apps open over a previously selected browser", async () => {
    localStorage.setItem("omb-computer-panel-view:scout", "browser");
    fixture.browser = true;
    await open(makeBot({ computer: "browser" }));
    expect(selected()).toBe("Browser");
    root?.unmount();
    root = null;
    localStorage.setItem("omb-computer-panel-view:scout", "mini-apps");
    await open(makeBot({ computer: "browser" }));
    expect(selected()).toBe("Mini Apps");
  });

  it.each(["agent-team", "usage"])("restores the retired %s tab into Mini Apps", async (view) => {
    localStorage.setItem("omb-computer-panel-view:scout", view);
    await open(makeBot());
    expect(selected()).toBe("Mini Apps");
    expect(document.querySelector('[data-testid="mini-apps-panel"]')).not.toBeNull();
    expect(tabLabels()).not.toContain("Agent Team");
    expect(tabLabels()).not.toContain("Usage");
  });

  it("names the tablist from the active catalog", async () => {
    setLocale("de");
    await open(makeBot());
    expect(document.querySelector('[data-testid="computer-tabs"]')?.getAttribute("role")).toBe("tablist");
    expect(tabListName()).toBe(t("computer.tabsAria"));
    expect(tabListName()).not.toBe("Bot panel view");
  });

  it("stays on Data through a model change and follows a conversation change", async () => {
    await open(makeBot());
    expect(selected()).toBe("Bot");
    flushSync(() => tab("Data").click());
    await settle();
    expect(selected()).toBe("Data");
    await vi.waitFor(() => expect(document.querySelector('[data-testid="data-panel"]')).not.toBeNull());

    await open(makeBot({ modelSelection: { instanceId: "codex", model: "m" } }));
    expect(selected()).toBe("Data");
    expect(document.querySelector('[data-testid="data-panel"]')).not.toBeNull();

    await open(makeBot({ threadId: "thread-2", tasks: [{ threadId: "thread-2", title: "Second", createdAt: 2, approvalMode: "ask" }] } as Partial<Bot>));
    expect(selected()).toBe("Bot");
  });

  it("shows the Browser tab with a published page's Open, and hands the page to the browser to open", async () => {
    fixture.browser = true;
    await open(makeBot());
    expect(selected()).toBe("Bot");
    const PAGE = "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/";
    flushSync(() => requestPanelPage("scout", PAGE));
    await settle();
    expect(selected()).toBe("Browser");
    expect(fixture.page).toMatchObject({ botId: "scout", url: PAGE });
    flushSync(() => tab("Data").click());
    flushSync(() => requestPanelPage("another-bot", PAGE));
    await settle();
    expect(selected()).toBe("Data");
  });

  it("marks the selected trigger and only that one", async () => {
    await open(makeBot());
    expect(tabs().map((candidate) => candidate.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false", "false"]);

    flushSync(() => tab("Data").click());
    await settle();
    expect(tabs().map((candidate) => candidate.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true", "false", "false"]);
  });

  it("keeps one Tab stop and moves it with the arrow, Home and End keys", async () => {
    await open(makeBot());
    expect(tabStops()).toEqual(["Bot"]);

    press("Bot", "ArrowRight");
    await settle();
    expect(selected()).toBe("Routines");
    expect(tabStops()).toEqual(["Routines"]);
    expect(document.activeElement).toBe(tab("Routines"));

    press("Routines", "ArrowLeft");
    await settle();
    expect(selected()).toBe("Bot");
    expect(document.activeElement).toBe(tab("Bot"));

    // Wraps around the row's ends.
    press("Bot", "ArrowLeft");
    await settle();
    expect(selected()).toBe("Mini Apps");
    press("Mini Apps", "ArrowRight");
    await settle();
    expect(selected()).toBe("Bot");

    press("Bot", "End");
    await settle();
    expect(selected()).toBe("Mini Apps");
    expect(document.activeElement).toBe(tab("Mini Apps"));
    press("Mini Apps", "Home");
    await settle();
    expect(selected()).toBe("Bot");
    expect(document.activeElement).toBe(tab("Bot"));
  });

  it("leaves the vertical arrows to the page's scrolling", async () => {
    await open(makeBot());
    flushSync(() => tab("Bot").focus());
    expect(press("Bot", "ArrowDown").defaultPrevented).toBe(false);
    expect(press("Bot", "ArrowUp").defaultPrevented).toBe(false);
    await settle();
    expect(selected()).toBe("Bot");
    expect(document.activeElement).toBe(tab("Bot"));
  });

  it("moves over an Android tab that appeared", async () => {
    fixture.android = true;
    await open(makeBot());
    expect(tabLabels()).toEqual(["Bot", "Routines", "Android", "Browser", "Data", "Files", "Mini Apps"]);
    press("Routines", "ArrowRight");
    await settle();
    expect(selected()).toBe("Android");
  });

  it("keeps one selected tab when Android disconnects", async () => {
    fixture.android = true;
    await open(makeBot());
    flushSync(() => tab("Android").click());
    await settle();
    expect(selected()).toBe("Android");

    fixture.android = false;
    await open(makeBot());
    expect(tabLabels()).not.toContain("Android");
    expect(selected()).toBe("Bot");
  });

  it("reaches Files and Mini Apps in Simple mode", async () => {
    fixture.advanced = false;
    await open(makeBot());
    expect(tabLabels()).toEqual(["Bot", "Browser", "Data", "Files", "Mini Apps"]);
    press("Data", "ArrowRight");
    await settle();
    expect(selected()).toBe("Files");
    press("Files", "ArrowRight");
    await settle();
    expect(selected()).toBe("Mini Apps");
    expect(document.activeElement).toBe(tab("Mini Apps"));
    press("Mini Apps", "ArrowRight");
    await settle();
    expect(selected()).toBe("Bot");
    expect(document.activeElement).toBe(tab("Bot"));
    press("Bot", "End");
    await settle();
    expect(selected()).toBe("Mini Apps");
    expect(document.activeElement).toBe(tab("Mini Apps"));
  });

  it("reveals the selected Mini Apps tab when the actual panel narrows", async () => {
    const callbacks = new Map<Element, () => void>();
    const original = globalThis.ResizeObserver;
    class ObservedResize {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) { callbacks.set(target, () => this.callback([], this as unknown as ResizeObserver)); }
      disconnect() { callbacks.clear(); }
    }
    globalThis.ResizeObserver = ObservedResize as unknown as typeof ResizeObserver;
    try {
      await open(makeBot());
      const aside = document.querySelector<HTMLElement>("[data-computer-panel]")!;
      const row = document.querySelector<HTMLElement>('[data-testid="computer-tabs"]')!;
      const mini = tab("Mini Apps");
      let panelWidth = 600;
      let visibleRight = 600;
      Object.defineProperty(aside, "offsetWidth", { configurable: true, get: () => panelWidth });
      vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => ({ left: 0, right: visibleRight }) as DOMRect);
      vi.spyOn(mini, "getBoundingClientRect").mockImplementation(() => ({ left: 300 - row.scrollLeft, right: 410 - row.scrollLeft }) as DOMRect);
      flushSync(() => callbacks.get(aside)!());
      flushSync(() => tab("Files").click());
      press("Files", "ArrowRight");
      await settle();
      expect(selected()).toBe("Mini Apps");
      expect(document.activeElement).toBe(mini);
      expect(row.scrollLeft).toBe(0);

      panelWidth = 400;
      visibleRight = 280;
      flushSync(() => callbacks.get(aside)!());
      expect(mini.getBoundingClientRect().right).toBeLessThanOrEqual(row.getBoundingClientRect().right);
      expect(row.scrollLeft).toBe(130);
      expect(document.activeElement).toBe(mini);
      press("Mini Apps", "ArrowRight");
      await settle();
      expect(selected()).toBe("Bot");
      expect(document.activeElement).toBe(tab("Bot"));
    } finally { globalThis.ResizeObserver = original; }
  });

  it("points every selected trigger at its panel and the panel back", async () => {
    await open(makeBot());
    for (const label of ["Bot", "Routines", "Browser", "Data", "Files", "Mini Apps"]) {
      flushSync(() => tab(label).click());
      await settle();
      const trigger = tab(label);
      const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(trigger.id);
    }
  });

  it("puts every selected panel in the tab sequence", async () => {
    await open(makeBot());
    for (const label of ["Bot", "Routines", "Browser", "Data", "Files", "Mini Apps"]) {
      flushSync(() => tab(label).click());
      await settle();
      const panel = document.getElementById(tab(label).getAttribute("aria-controls")!);
      expect(panel?.getAttribute("tabindex"), label).toBe("0");
    }
  });
});
