// @vitest-environment happy-dom
import { createElement, useReducer, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "./state/store";
import { setAdvancedMode } from "./lib/interface-mode";
import { closeRoomPanel } from "./lib/room-panel";

let initial: AppState;
let current: AppState;
vi.mock("./state/store", async (original) => {
  const store = await original<typeof import("./state/store")>();
  return {
    ...store,
    StoreProvider: ({ children }: { children: ReactNode }) => {
      const [state, dispatch] = useReducer(store.reducer, initial);
      current = state;
      return createElement(store.BotEditorStore, { value: {
        state, dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
      }, children });
    },
  };
});
vi.mock("./lib/analytics", () => ({ initAnalytics: () => {}, track: () => {}, emailGateDone: () => true }));
vi.mock("./components/mini-apps/MiniAppsPanel", () => ({
  MiniAppsPanel: () => createElement("div", { "data-testid": "mini-apps-panel" }, "Shared installed Mini Apps"),
}));

const { initialState } = await import("./state/store");
const { default: App } = await import("./App");

const bot: Bot = {
  id: "pepper", threadId: "private-thread", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, modelSelection: { instanceId: "test", model: "m" },
  messages: [{ id: "private", role: "user", kind: "text", text: "Private conversation", at: 1 }],
};
const group: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: [bot.id], description: "",
  bulletin: "", unread: false, createdAt: 1, setupCompletedAt: 1,
  messages: [{ id: "group-message", role: "user", kind: "text", text: "Keep the group conversation visible", at: 1 }],
};
let root: Root;
let host: HTMLDivElement;
const opener = () => host.querySelector<HTMLButtonElement>('[data-roomhead-controls] [data-tour="computer"]')!;
const panel = () => host.querySelector<HTMLElement>("[data-computer-panel]");
const click = (element: HTMLElement) => flushSync(() => element.click());
const draw = () => flushSync(() => root.render(createElement(App)));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  setAdvancedMode(false);
  initial = { ...initialState, connected: true, hydrated: true, bots: [bot], groups: [group], selectedId: group.id };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  closeRoomPanel();
  setAdvancedMode(false);
  vi.unstubAllGlobals();
});

it.each([false, true])("opens Mini Apps from a group and returns focus on close (advanced: %s)", async (advanced) => {
  setAdvancedMode(advanced);
  draw();
  const button = opener();
  expect(button).not.toBeNull();
  expect(button.getAttribute("aria-label")).toBe("Computer");
  button.focus();
  click(button);
  await vi.waitFor(() => expect(panel()?.querySelector('[data-testid="mini-apps-panel"]')).toBeTruthy());
  expect(panel()?.textContent).toContain("Shared installed Mini Apps");
  expect(panel()?.getAttribute("aria-label")).toBe("Computer");
  expect(current.selectedId).toBe(group.id);
  expect(current.groups[0]?.threadId).toBe(group.threadId);
  expect(host.textContent).toContain("Keep the group conversation visible");
  expect(host.querySelector('[role="log"]')?.textContent).not.toContain("Private conversation");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  const tab = panel()!.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!;
  await vi.waitFor(() => expect(document.activeElement).toBe(tab));
  expect(tab.textContent).toContain("Mini Apps");
  const close = panel()!.querySelector<HTMLElement>("[data-computer-panel-close]")!;
  close.focus();
  click(close);
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(button);
  expect(current.selectedId).toBe(group.id);
  expect(button.getAttribute("aria-pressed")).toBe("false");
});

it("keeps Computer and room settings mutually exclusive", async () => {
  draw();
  const name = host.querySelector<HTMLElement>("[data-room-name]")!;
  click(name);
  await vi.waitFor(() => expect(host.querySelector("[data-room-panel]")).not.toBeNull());
  click(opener());
  await vi.waitFor(() => expect(panel()).not.toBeNull());
  expect(host.querySelector("[data-room-panel]")).toBeNull();
  click(name);
  expect(panel()).toBeNull();
  expect(host.querySelector("[data-room-panel]")).not.toBeNull();
  expect(current.selectedId).toBe(group.id);
});

it("opens the shared app library even when the group has no members", async () => {
  initial = { ...initial, bots: [], groups: [{ ...group, memberIds: [] }] };
  draw();
  click(opener());
  await vi.waitFor(() => expect(panel()?.textContent).toContain("Shared installed Mini Apps"));
  expect(current.selectedId).toBe(group.id);
  expect(current.bots).toEqual([]);
});

it("does not expose a desktop Computer panel on remote clients", () => {
  vi.stubGlobal("ogb", { remoteClient: { active: true } });
  initial = { ...initial, computerOpen: true };
  draw();
  expect(opener()).toBeNull();
  expect(panel()).toBeNull();
});
