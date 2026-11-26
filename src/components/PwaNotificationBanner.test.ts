// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import { publishLiveFrame } from "@/lib/live-events";
import { initialState, StoreContext, type Action, type AppState, type Bot } from "@/state/store";
import type { NotificationLogEntry } from "../../shared/notification";
import { enqueueBannerItem, PwaNotificationBanner, shouldSuppressBanner } from "./PwaNotificationBanner";

const scout: Bot = {
  id: "scout",
  threadId: "t-main",
  name: "Scout",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "fake", model: "m" },
  messages: [],
  tasks: [
    { threadId: "t-main", title: "Main", createdAt: 1 },
    { threadId: "t-other", title: "Other", createdAt: 2 },
  ],
};

function makeNotification(overrides: Partial<NotificationLogEntry> = {}): NotificationLogEntry {
  return {
    id: "n-1",
    at: 1000,
    read: false,
    kind: "done",
    botId: "scout",
    botName: "Scout",
    threadId: "t-other",
    title: "Scout finished",
    body: "Report ready",
    ...overrides,
  };
}

let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PwaNotificationBanner helpers", () => {
  it("suppresses banners only when the exact active thread is visible and drawer is closed (except spend)", () => {
    expect(
      shouldSuppressBanner({
        notification: makeNotification({ threadId: "t-main", kind: "done" }),
        activeView: "chat",
        activeThreadId: "t-main",
        drawerOpen: false,
        visibilityState: "visible",
      }),
    ).toBe(true);

    expect(
      shouldSuppressBanner({
        notification: makeNotification({ threadId: "t-main", kind: "done" }),
        activeView: "chat",
        activeThreadId: "t-main",
        drawerOpen: true,
        visibilityState: "visible",
      }),
    ).toBe(false);

    expect(
      shouldSuppressBanner({
        notification: makeNotification({ threadId: "t-main", kind: "spend" }),
        activeView: "chat",
        activeThreadId: "t-main",
        drawerOpen: false,
        visibilityState: "visible",
      }),
    ).toBe(false);
  });

  it("preempts active P1 banner when a P0 notification arrives", () => {
    const p1 = { notification: makeNotification({ id: "n-p1", kind: "done" }), priority: "p1" as const, receivedAt: 1 };
    const p0 = { notification: makeNotification({ id: "n-p0", kind: "approval" }), priority: "p0" as const, receivedAt: 2 };
    const result = enqueueBannerItem(p1, [], p0);
    expect(result.current).toBe(p0);
    expect(result.queue).toEqual([p1]);
  });
});

describe("PwaNotificationBanner component", () => {
  it("preempts P1 with P0, jumps to thread on click, and marks notification read", async () => {
    const dispatch = vi.fn<(action: Action) => void>();
    const onJump = vi.fn();
    const state: AppState = {
      ...initialState,
      bots: [scout],
      selectedId: "scout",
      notifications: [{ ...makeNotification({ id: "n-p0", kind: "approval", threadId: "t-other" }), read: false }],
    };

    await act(async () => {
      root!.render(
        createElement(
          StoreContext.Provider,
          { value: { state, dispatch } as never },
          createElement(PwaNotificationBanner, {
            activeView: "chat",
            activeThreadId: "t-main",
            drawerOpen: false,
            onJump,
          }),
        ),
      );
    });

    await act(async () => {
      publishLiveFrame({
        kind: "notify",
        notification: makeNotification({ id: "n-suppressed", kind: "done", threadId: "t-main", body: "Should suppress" }),
      });
    });
    expect(document.body.textContent).not.toContain("Should suppress");

    await act(async () => {
      publishLiveFrame({
        kind: "notify",
        notification: makeNotification({ id: "n-p1", kind: "done", threadId: "t-other", body: "P1 body" }),
      });
    });
    expect(document.body.textContent).toContain("P1 body");

    await act(async () => {
      publishLiveFrame({
        kind: "notify",
        notification: makeNotification({ id: "n-p0", kind: "approval", threadId: "t-other", body: "Needs approval" }),
      });
    });
    expect(document.body.textContent).toContain("Needs approval");
    expect(document.body.textContent).toContain("+1 more");

    const banner = document.querySelector<HTMLElement>('[data-pwa-banner="p0"]')!;
    expect(banner.getAttribute("role")).toBe("alert");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    await act(async () => {
      banner.click();
    });
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "t-other" });
    expect(dispatch).toHaveBeenCalledWith({ type: "notificationRead", id: "n-p0" });
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});
