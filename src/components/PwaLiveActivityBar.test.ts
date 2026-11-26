// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { initialState, StoreContext, type Action, type AppState, type Bot } from "@/state/store";
import { PwaLiveActivityBar, selectLiveActivityEntries } from "./PwaLiveActivityBar";

const workingBot: Bot = {
  id: "dev",
  threadId: "dev-main",
  name: "DevBot",
  title: "",
  description: "",
  notifications: true,
  color: "blue",
  unread: false,
  busy: true,
  activity: "working",
  modelSelection: { instanceId: "fake", model: "m" },
  messages: [],
  tasks: [{ threadId: "dev-main", title: "Build feature", createdAt: 10, busy: true, activity: "working" }],
};

const waitingBot: Bot = {
  id: "ops",
  threadId: "ops-main",
  name: "OpsBot",
  title: "",
  description: "",
  notifications: true,
  color: "orange",
  unread: true,
  busy: false,
  activity: "waiting-on-you",
  modelSelection: { instanceId: "fake", model: "m" },
  messages: [],
  tasks: [{ threadId: "ops-main", title: "Deploy approval", createdAt: 5, activity: "waiting-on-you" }],
};

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("selectLiveActivityEntries", () => {
  it("ranks waiting-on-you above working and excludes idle bots", () => {
    const entries = selectLiveActivityEntries([workingBot, waitingBot], [], {});
    expect(entries.map((e) => `${e.ownerId}:${e.priority}`)).toEqual(["ops:waiting", "dev:working"]);
  });
});

describe("PwaLiveActivityBar", () => {
  it("renders null when idle, supports multi-task expand/collapse, and jumps on tap", async () => {
    const dispatch = vi.fn<(action: Action) => void>();
    const onJump = vi.fn();
    const idleState: AppState = { ...initialState, bots: [{ ...workingBot, busy: false, activity: undefined, tasks: [] }] };

    await act(async () => {
      root!.render(
        createElement(
          StoreContext.Provider,
          { value: { state: idleState, dispatch } as never },
          createElement(PwaLiveActivityBar, { onJump }),
        ),
      );
    });
    expect(container.querySelector("[data-live-activity-bar]")).toBeNull();

    const activeState: AppState = { ...initialState, bots: [workingBot, waitingBot], selectedId: "dev" };
    await act(async () => {
      root!.render(
        createElement(
          StoreContext.Provider,
          { value: { state: activeState, dispatch } as never },
          createElement(PwaLiveActivityBar, { onJump }),
        ),
      );
    });

    expect(container.textContent).toContain("OpsBot");
    expect(container.textContent).toContain("+1");

    const expandBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Show active tasks"]')!;
    await act(async () => {
      expandBtn.click();
    });
    expect(container.textContent).toContain("Build feature");

    const collapseBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse activity bar"]')!;
    await act(async () => {
      collapseBtn.click();
    });
    expect(container.querySelector('[data-live-activity-bar="collapsed"]')).not.toBeNull();
    expect(container.textContent).toContain("1 waiting for you");

    const restoreBtn = container.querySelector<HTMLButtonElement>('[data-live-activity-bar="collapsed"] button')!;
    await act(async () => {
      restoreBtn.click();
    });
    expect(container.querySelector('[data-live-activity-bar="expanded"]')).not.toBeNull();

    const primaryJump = container.querySelector<HTMLButtonElement>('[data-live-activity-bar="expanded"] button')!;
    await act(async () => {
      primaryJump.click();
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "ops", threadId: "ops-main" });
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});
