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
let selectChat: ((id: string) => void) | undefined;
vi.mock("./state/store", async (original) => {
  const store = await original<typeof import("./state/store")>();
  return {
    ...store,
    StoreProvider: ({ children }: { children: ReactNode }) => {
      const [state, dispatch] = useReducer(store.reducer, initial);
      current = state;
      selectChat = (id: string) => dispatch({ type: "select", id });
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
  defaultResponder: { kind: "member", botId: bot.id },
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
  await vi.waitFor(() => expect(panel()?.querySelector('[data-testid="mini-apps-panel"]')).toBeTruthy(), { timeout: 5000 });
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

it("defaults the outer panel to 1152px and retains a resized width across group and bot switches", async () => {
  vi.stubGlobal("innerWidth", 2560);
  const secondBot: Bot = {
    ...bot,
    id: "scout",
    threadId: "scout-thread",
    name: "Scout",
    messages: [{ id: "scout-msg", role: "user", kind: "text", text: "Scout conversation", at: 2 }],
  };
  initial = { ...initial, computerOpen: true, bots: [bot, secondBot], groups: [group], selectedId: group.id };
  draw();
  await vi.waitFor(() => expect(panel()).not.toBeNull());
  expect(panel()!.style.width).toBe("1152px");

  const separator = panel()!.querySelector<HTMLElement>('[role="separator"]')!;
  separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await vi.waitFor(() => expect(panel()!.style.width).toBe("1192px"));

  flushSync(() => selectChat!(secondBot.id));
  await vi.waitFor(() => expect(current.selectedId).toBe(secondBot.id));
  await vi.waitFor(() => expect(panel()).not.toBeNull(), { timeout: 5000 });
  expect(panel()!.style.width).toBe("1192px");

  flushSync(() => selectChat!(bot.id));
  await vi.waitFor(() => expect(current.selectedId).toBe(bot.id));
  await vi.waitFor(() => expect(panel()).not.toBeNull(), { timeout: 5000 });
  expect(panel()!.style.width).toBe("1192px");
});

it("scopes multi-bot target selection to group members and isolates group-to-group-to-DM switches", async () => {
  const outsider: Bot = {
    ...bot,
    id: "outsider",
    threadId: "outsider-thread",
    name: "Outsider",
    computer: "cloud",
  };
  const secondMember: Bot = {
    ...bot,
    id: "scout",
    threadId: "scout-thread",
    name: "Scout",
    computer: "off",
  };
  const groupA: Group = {
    ...group,
    id: "room-a",
    threadId: "room-a-thread",
    name: "Room A",
    memberIds: [bot.id, secondMember.id],
    defaultResponder: { kind: "member", botId: bot.id },
  };
  const groupB: Group = {
    ...group,
    id: "room-b",
    threadId: "room-b-thread",
    name: "Room B",
    memberIds: [secondMember.id],
    defaultResponder: { kind: "member", botId: secondMember.id },
  };
  initial = { ...initial, computerOpen: true, bots: [bot, secondMember, outsider], groups: [groupA, groupB], selectedId: groupA.id };
  draw();

  await vi.waitFor(() => expect(panel()?.querySelector('[data-testid="group-computer-target"]')).toBeTruthy());
  const select = panel()!.querySelector<HTMLSelectElement>('[aria-label="Select bot computer"]')!;
  expect(select).not.toBeNull();
  const optionValues = [...select.options].map((option) => option.value);
  expect(optionValues).toEqual([bot.id, secondMember.id]);
  expect(optionValues).not.toContain(outsider.id);
  expect(select.value).toBe(bot.id);

  // Switch target bot to Scout (computer: "off") and open the Screen tab
  select.value = secondMember.id;
  flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
  const screenTab = panel()!.querySelector<HTMLButtonElement>("#computer-panel-tabs-tab-computer")!;
  click(screenTab);
  await vi.waitFor(() => expect(panel()!.textContent).toContain("Scout has no screen"));

  // Switch to Room B (only Scout is a member)
  flushSync(() => selectChat!(groupB.id));
  await vi.waitFor(() => expect(current.selectedId).toBe(groupB.id));
  await vi.waitFor(() => expect(panel()?.querySelector('[data-testid="group-computer-target"]')?.textContent).toContain("Scout"));
  expect(panel()!.querySelector('[aria-label="Select bot computer"]')).toBeNull();
  expect(panel()!.querySelector('[data-testid="group-computer-target"]')?.textContent).not.toContain("Outsider");

  // Switch to Outsider DM: should not show group target selector
  flushSync(() => selectChat!(outsider.id));
  await vi.waitFor(() => expect(current.selectedId).toBe(outsider.id));
  await vi.waitFor(() => expect(panel()).not.toBeNull());
  expect(panel()!.querySelector('[data-testid="group-computer-target"]')).toBeNull();
});
