// @vitest-environment happy-dom
import { StrictMode, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";
import { setLocale, t } from "@/lib/i18n";
import { rememberComputerPanelOpen } from "@/lib/computer-panel-focus";
import { requestComputerPanelView } from "@/lib/computer-panel-view";

const fixture = { advanced: true };

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
vi.mock("./AndroidDevicePanel", () => ({ AndroidDevicePanel: () => null, useAndroidUsbDevices: () => ({ devices: [] }) }));
vi.mock("./BrowserPanel", () => ({ BrowserPanel: () => null }));
vi.mock("./CloudBackendPicker", () => ({ CloudBackendPicker: () => null }));
vi.mock("./bot-settings/RoutinesSection", () => ({ RoutinesSection: () => null }));
vi.mock("./mini-apps/MiniAppsPanel", () => ({ MiniAppsPanel: () => createElement("div", { "data-testid": "mini-apps-panel" }) }));
vi.mock("./data/DataPanel", () => ({ DataPanel: () => createElement("div", { "data-testid": "data-panel" }) }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: async (path: string) => {
    if (path.startsWith("/api/bots/scout/computer/control")) return { held: false, helpReason: null };
    if (path.startsWith("/api/bots/scout/computer?")) return { surface: "cloud", backend: "box", configured: true, box: { boxId: "bx_23456789", state: "ready" } };
    if (path.startsWith("/api/bots/scout/memory/file?")) return { path: "MEMORY.md", text: "", hash: "", exists: false };
    return {};
  },
}));

const { ComputerPanel } = await import("./ComputerPanel");
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
const dispatch = vi.fn();
let frames: Array<{ id: number; run: FrameRequestCallback }> = [];
let nextFrame = 1;

const value = (): Parameters<typeof BotEditorStore>[0]["value"] => ({
  state: { ...initialState, instances: [engine("claude")], config: { box: { configured: true } } as AppState["config"] } as AppState,
  dispatch,
  flushBotPatches: async () => null,
  refreshInstances: async () => {},
  refreshModels: async () => {},
});
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const open = async (bot: Bot, strict = false) => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const panel = createElement(ComputerPanel, { bot, key: bot.id });
  flushSync(() => root!.render(createElement(BotEditorStore, { value: value(), children: strict ? createElement(StrictMode, null, panel) : panel })));
  await settle();
};
const runFrames = () => {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame.run(0);
};
const activeTab = () => document.querySelector<HTMLElement>('[data-testid="computer-tabs"] [role="tab"][aria-selected="true"]');
const tabByLabel = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="computer-tabs"] [role="tab"]')].find((candidate) => candidate.textContent?.trim() === label)!;
const panelClose = () => document.querySelector<HTMLElement>("[data-computer-panel-close]");
const panelGear = () => document.querySelector<HTMLElement>(`[title=${JSON.stringify(t("computer.botSettings"))}]`)!;
const chatButton = () => {
  const button = document.createElement("button");
  button.dataset.tour = "computer";
  button.textContent = "Computer";
  document.body.append(button);
  return button;
};

beforeAll(() => {
  vi.stubGlobal("ogb", undefined);
});
beforeEach(() => {
  dispatch.mockClear();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  });
  frames = [];
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.push({ id, run: callback });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames = frames.filter((frame) => frame.id !== id);
  });
  fixture.advanced = true;
});
afterEach(() => {
  root?.unmount();
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  setLocale("en");
});

describe("computer panel entry focus", () => {
  it("hands the keyboard's open to the active tab, one frame later", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    expect(localStorage.getItem("omb-computer-panel-view:scout")).toBeNull();
    await open(makeBot());
    expect(document.activeElement).toBe(document.body);
    expect(frames.length).toBeGreaterThan(0);

    runFrames();
    expect(document.activeElement).toBe(activeTab());
    expect(document.activeElement?.textContent?.trim()).toBe(t("botPanel.avatar.tabBot"));
  });

  it("leaves a pointer open's focus alone", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: false });
    await open(makeBot());
    expect(document.activeElement).toBe(document.body);
    runFrames();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus meant for another bot", async () => {
    rememberComputerPanelOpen({ botId: "pepper", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the deferred focus when React runs the effect twice", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot(), true);
    expect(frames.length).toBeGreaterThan(0);
    runFrames();
    expect(document.activeElement).toBe(activeTab());
  });

  it("takes the entry focus once per open, not on every mount", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.activeElement).toBe(activeTab());

    root?.unmount();
    document.body.querySelectorAll("div").forEach((node) => node.remove());
    await open(makeBot());
    expect(document.activeElement).toBe(document.body);
    runFrames();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus again when the panel remounts for another bot", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.activeElement).toBe(activeTab());

    const focused = document.activeElement;
    await open(makeBot({ id: "pepper" }));
    runFrames();
    expect(document.activeElement).toBe(focused);
  });

  it("keeps the ring on the tab the panel itself moves to", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    expect(document.activeElement).toBe(activeTab());

    // Auto resolves its surface, or a data result and a sign-in move the tab.
    flushSync(() => tabByLabel("Data").click());
    await settle();
    expect(document.activeElement).toBe(tabByLabel("Data"));
  });

  it.each(["Files", "Browser"])("returns a mounted %s panel to Bot when its header requests the overview", async (view) => {
    await open(makeBot());
    flushSync(() => tabByLabel(view).click());
    expect(activeTab()).toBe(tabByLabel(view));

    flushSync(() => requestComputerPanelView("scout", "computer"));
    await settle();
    expect(activeTab()).toBe(tabByLabel("Bot"));
    expect(localStorage.getItem("omb-computer-panel-view:scout")).toBe("computer");
  });

  it("keeps Files settings below a bounded file list and returns their pages to Files", async () => {
    const messages = Array.from({ length: 20 }, (_, index): Message => ({
      id: `page-${index}`, role: "bot", kind: "text", at: index + 1, text: "",
      publishedPage: { state: "live", title: `Page ${index}`, url: `https://example.test/${index}` },
      digest: { turnId: `turn-${index}`, botId: "scout", threadId: "thread", at: index + 1,
        durationMs: 1, tools: [], memory: [], reply: "", hookCoverage: "full",
        files: { added: [`/workspace/pinned/file-${index}.md`], changed: [], deleted: [] } },
    }));
    await open(makeBot({ cwd: "/workspace/default", messages,
      tasks: [{ threadId: "thread", title: "Main", createdAt: 1, cwd: "/workspace/pinned" }] }));
    flushSync(() => tabByLabel("Files").click());
    await settle();
    expect(document.querySelector('[data-testid="computer-files"]')?.className).toContain("overflow-y-auto");
    expect(document.querySelectorAll('[data-panel-page="folder"]')).toHaveLength(1);
    expect(document.querySelector('[data-panel-page="folder"]')?.textContent).toContain("/workspace/pinned");
    expect(document.querySelector('[data-testid="files-library-links"]')?.textContent).toContain("Page 0");
    expect(document.querySelector('[data-testid="files-library-links"]')?.textContent).toContain("Page 19");
    for (const page of ["memory", "skills", "folder"]) {
      flushSync(() => document.querySelector<HTMLElement>(`[data-panel-page="${page}"]`)!.click());
      expect(document.querySelector(`[data-panel-page-view="${page}"]`)).not.toBeNull();
      flushSync(() => document.querySelector<HTMLElement>("[data-panel-back]")!.click());
      runFrames();
      expect(activeTab()).toBe(tabByLabel("Files"));
    }
    flushSync(() => requestComputerPanelView("scout", "computer"));
    await settle();
    expect(document.querySelector('[data-panel-card="model"]')).not.toBeNull();
    flushSync(() => document.querySelector<HTMLElement>('[aria-controls="bot-overview-works-content"]')!.click());
    expect(document.querySelector('#bot-overview-works-content')?.textContent).toContain("Signed-in sites");
  });

  it("uncovers chat for a generated app on an overlaid 960px Computer panel", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query !== "(min-width: 1536px)", addEventListener: () => {}, removeEventListener: () => {} }));
    const message = { id: "app", role: "bot", kind: "app", at: 1, app: { title: "Report", doc: "# Report" } } as Bot["messages"][number];
    await open(makeBot({ messages: [message] }));
    flushSync(() => tabByLabel("Files").click());
    await settle();
    flushSync(() => document.querySelector<HTMLElement>('[data-panel-row="app"]')!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "focusMessage", threadId: "thread", messageId: "app" });
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleComputer", open: false });
    expect(dispatch).not.toHaveBeenCalledWith({ type: "toggleSettings", open: false });
  });

  it("stops following the selection once focus leaves the tab row", async () => {
    rememberComputerPanelOpen({ botId: "scout", opener: chatButton(), tabs: true });
    await open(makeBot());
    runFrames();
    const content = panelClose()!;
    flushSync(() => content.focus());

    flushSync(() => tabByLabel("Data").click());
    await settle();
    expect(document.activeElement).toBe(content);
  });
});

describe("computer panel close hand-off", () => {
  it("returns focus to the opener from the panel's own X", async () => {
    const opener = chatButton();
    opener.focus();
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    const close = panelClose()!;
    close.focus();

    flushSync(() => close.click());
    expect(document.activeElement).toBe(opener);
  });

  it("returns focus before handing over to bot settings from the gear", async () => {
    const opener = chatButton();
    opener.focus();
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    const gear = panelGear();
    gear.focus();

    flushSync(() => gear.click());
    expect(document.activeElement).toBe(opener);
  });

  it("falls back to the chat button when the opener was unmounted", async () => {
    const chat = chatButton();
    const opener = document.createElement("button");
    document.body.append(opener);
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    opener.remove();
    const close = panelClose()!;
    close.focus();

    flushSync(() => close.click());
    expect(document.activeElement).toBe(chat);
  });

  it("leaves focus where it was when the panel was not focused", async () => {
    const opener = chatButton();
    rememberComputerPanelOpen({ botId: "scout", opener, tabs: true });
    await open(makeBot());
    runFrames();
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();

    flushSync(() => panelClose()!.click());
    expect(document.activeElement).toBe(composer);
  });
});
