// @vitest-environment happy-dom
import { createElement, useReducer, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Action, AppState, Bot } from "./state/store";

let initial: AppState;
let current: AppState;
let send: ((action: Action) => void) | undefined;
vi.mock("./state/store", async (original) => {
  const store = await original<typeof import("./state/store")>();
  return {
    ...store,
    StoreProvider: ({ children }: { children: ReactNode }) => {
      const [state, dispatch] = useReducer(store.reducer, initial);
      current = state;
      send = dispatch;
      return createElement(store.BotEditorStore, {
        value: {
          state,
          dispatch,
          flushBotPatches: async () => null,
          refreshInstances: async () => {},
          refreshModels: async () => {},
        },
        children,
      });
    },
  };
});
vi.mock("./lib/analytics", () => ({ initAnalytics: () => {}, track: () => {}, emailGateDone: () => true }));
vi.mock("./components/WebPanelPage", () => ({
  WebPanelPage: () => createElement("div", { "data-testid": "web-panel-page" }, "Web panel"),
}));

const { initialState } = await import("./state/store");
const { default: App } = await import("./App");

const bot: Bot = {
  id: "scout",
  threadId: "scout-thread",
  name: "Scout",
  title: "",
  description: "",
  color: "green",
  notifications: true,
  unread: false,
  busy: false,
  modelSelection: { instanceId: "test", model: "m" },
  messages: [],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  initial = { ...initialState, connected: true, hydrated: true, bots: [bot], selectedId: bot.id };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("clicking Back on Automations returns to chat rather than Team Map when opened from Team Map", async () => {
  initial = { ...initial, activeView: "team-map" };
  flushSync(() => root.render(createElement(App)));
  expect(current.activeView).toBe("team-map");

  flushSync(() => send!({ type: "showRoutines", view: "list" }));
  expect(current.activeView).toBe("routines");

  const back = await vi.waitFor(() => {
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
    expect(button).not.toBeNull();
    return button!;
  });

  flushSync(() => back.click());
  expect(current.activeView).toBe("chat");
  expect(current.selectedId).toBe(bot.id);
});

it("clicking Back on Automations returns to web-panel when opened from a web panel", async () => {
  initial = { ...initial, activeView: "web-panel", webPanelId: "panel-1" };
  flushSync(() => root.render(createElement(App)));
  expect(current.activeView).toBe("web-panel");

  flushSync(() => send!({ type: "showRoutines", view: "list" }));
  expect(current.activeView).toBe("routines");

  const back = await vi.waitFor(() => {
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="Back"]');
    expect(button).not.toBeNull();
    return button!;
  });

  flushSync(() => back.click());
  expect(current.activeView).toBe("web-panel");
  expect(current.webPanelId).toBe("panel-1");
});
