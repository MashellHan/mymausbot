// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalAgentActivityResponse } from "../../shared/local-dashboard";
import { setLocale } from "@/lib/i18n";

const calls = vi.hoisted(() => ({ api: vi.fn(), visible: true }));
vi.mock("@/state/store", () => ({
  api: calls.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => calls.visible }));

const { AgentActivityDetails } = await import("./AgentActivityDetails");
const { ApiError } = await import("@/state/store");
const agentId = "w6:p3";
const ready: LocalAgentActivityResponse = { agentId, status: "ready", updatedAt: Date.UTC(2026, 10, 5, 2), truncated: true, events: [
  { id: "e1", at: Date.UTC(2026, 10, 5, 1), kind: "user", tool: null, text: "Check the release" },
  { id: "e2", at: Date.UTC(2026, 10, 5, 1, 1), kind: "assistant", tool: null, text: "I checked it." },
  { id: "e3", at: null, kind: "tool-call", tool: "functions.exec", text: "[path]" },
  { id: "e4", at: null, kind: "tool-result", tool: "functions.exec", text: null },
] };

let host: HTMLDivElement;
let root: Root;
const render = async (id = agentId, active = true, readActivity?: (id: string, signal: AbortSignal) => Promise<LocalAgentActivityResponse>) => {
  await act(async () => root.render(createElement(AgentActivityDetails, { key: id, agentId: id, active, readActivity })));
};
const button = () => host.querySelector<HTMLButtonElement>("button")!;
const list = () => host.querySelector<HTMLOListElement>('ol[role="region"]');

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  host.style.width = "360px";
  host.dataset.skin = "midnight";
  document.body.append(host);
  root = createRoot(host);
  calls.api.mockReset();
  calls.visible = true;
  setLocale("en");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("AgentActivityDetails", () => {
  it("uses an injected scoped reader without calling the native owner route", async () => {
    const readActivity = vi.fn(async (_id: string, _signal: AbortSignal) => ready);
    await render(agentId, true, readActivity);
    await act(async () => button().click());
    expect(readActivity).toHaveBeenCalledWith(agentId, expect.any(AbortSignal));
    expect(calls.api).not.toHaveBeenCalled();
    expect(list()?.children).toHaveLength(2);
    const signal = readActivity.mock.calls[0]![1];
    await render(agentId, false, readActivity);
    expect(signal.aborted).toBe(true);
  });

  it("starts folded, keeps keyboard focus, and shows readable chat rows in either skin", async () => {
    calls.api.mockResolvedValue(ready);
    await render();
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(button().getAttribute("aria-controls")!)?.hidden).toBe(true);
    expect(calls.api).not.toHaveBeenCalled();
    button().focus();
    await act(async () => button().click());
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/agents/w6%3Ap3/activity", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));
    expect(list()?.children).toHaveLength(2);
    expect(list()?.getAttribute("tabindex")).toBe("0");
    expect(list()?.className).toContain("max-h-56");
    expect(host.textContent).toMatch(/Input.*Reply/s);
    expect(host.textContent).not.toMatch(/Tool call|Tool result|functions\.exec|\[path\]/);
    const [input, reply] = [...list()!.children] as HTMLElement[];
    expect(input.className).toContain("bg-accent/5");
    expect(input.querySelector("span")?.className).toContain("text-accent-text");
    expect(reply.className).toContain("bg-card");
    expect(input.querySelector("p")?.className).toContain("text-[13px] leading-[18px]");
    expect(reply.querySelector("p")?.className).toContain("text-[13px] leading-[18px]");
    expect(host.textContent).toContain("Showing a bounded recent excerpt");
    host.dataset.skin = "atelier";
    setLocale("zh");
    await render();
    expect(host.textContent).toContain("输入");
    expect(host.textContent).toContain("回复");
    expect(host.textContent).toContain("最近消息");
    expect(host.textContent).not.toContain("工具调用");
  });

  it("shows the message empty state when an older response contains only tool rows", async () => {
    calls.api.mockResolvedValue({ ...ready, truncated: false, events: ready.events.filter((event) => event.kind === "tool-call" || event.kind === "tool-result") });
    await render();
    await act(async () => button().click());
    expect(list()).toBeNull();
    expect(host.textContent).toContain("No recent messages.");
    expect(host.textContent).not.toMatch(/functions\.exec|Tool call|Tool result/);
  });

  it("opens at the latest reply", async () => {
    calls.api.mockResolvedValue(ready);
    const prototype = Object.getPrototypeOf(document.createElement("ol")) as object;
    const original = Object.getOwnPropertyDescriptor(prototype, "scrollHeight");
    Object.defineProperty(prototype, "scrollHeight", { configurable: true, get: () => 480 });
    try {
      await render();
      await act(async () => button().click());
      expect(list()?.scrollTop).toBe(480);
      expect(list()?.lastElementChild?.textContent).toContain("I checked it.");
    } finally {
      if (original) Object.defineProperty(prototype, "scrollHeight", original);
      else Reflect.deleteProperty(prototype, "scrollHeight");
    }
  });

  it("polls without overlap and stops an in-flight read when folded or switched", async () => {
    let finish!: (value: LocalAgentActivityResponse) => void;
    calls.api.mockResolvedValueOnce(ready).mockImplementationOnce(() => new Promise<LocalAgentActivityResponse>((resolve) => { finish = resolve; }));
    await render();
    await act(async () => button().click());
    expect(calls.api).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(calls.api).toHaveBeenCalledTimes(2);
    const pendingSignal = calls.api.mock.calls[1]?.[1]?.signal as AbortSignal;
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(calls.api).toHaveBeenCalledTimes(2);
    await act(async () => button().click());
    expect(pendingSignal.aborted).toBe(true);
    expect(list()).toBeNull();
    await act(async () => finish(ready));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(calls.api).toHaveBeenCalledTimes(2);
    await render("w7:p2");
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps expanded history while inactive without polling and resumes on return", async () => {
    calls.api.mockResolvedValue(ready);
    await render();
    await act(async () => button().click());
    const history = list();
    const signal = calls.api.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(history?.textContent).toContain("Check the release");

    await render(agentId, false);
    expect(signal.aborted).toBe(true);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(list()).toBe(history);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(calls.api).toHaveBeenCalledTimes(1);

    await render(agentId, true);
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(list()?.textContent).toContain("Check the release");
    expect(calls.api).toHaveBeenCalledTimes(2);
  });

  it("clears rows and stops after authorization loss; hidden details cancel their request", async () => {
    calls.api.mockResolvedValueOnce(ready).mockRejectedValueOnce(new ApiError("unauthorized", 401));
    await render();
    await act(async () => button().click());
    expect(list()?.children).toHaveLength(2);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(list()).toBeNull();
    expect(host.textContent).toContain("unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(calls.api).toHaveBeenCalledTimes(2);
    await act(async () => button().click());
    let finish!: (value: LocalAgentActivityResponse) => void;
    calls.api.mockImplementationOnce(() => new Promise<LocalAgentActivityResponse>((resolve) => { finish = resolve; }));
    await act(async () => button().click());
    const signal = calls.api.mock.calls.at(-1)?.[1]?.signal as AbortSignal;
    calls.visible = false;
    await render();
    expect(signal.aborted).toBe(true);
    await act(async () => finish(ready));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(calls.api).toHaveBeenCalledTimes(3);
  });

  it.each(["stale", "unavailable", "unsupported"] as const)("shows %s truthfully", async (status) => {
    calls.api.mockResolvedValue({ ...ready, status, events: status === "stale" ? ready.events : [], updatedAt: status === "stale" ? ready.updatedAt : null });
    await render();
    await act(async () => button().click());
    expect(host.textContent?.toLowerCase()).toContain(status === "stale" ? "last observed" : status === "unsupported" ? "not supported" : status);
    expect(list()?.children.length ?? 0).toBe(status === "stale" ? 2 : 0);
  });

  it("keeps changing as-of times outside the live status region", async () => {
    calls.api.mockResolvedValueOnce({ ...ready, updatedAt: 1000 }).mockResolvedValueOnce({ ...ready, updatedAt: 3000 });
    await render();
    await act(async () => button().click());
    const status = host.querySelector<HTMLElement>('[role="status"]')!;
    const asOf = host.querySelector<HTMLElement>('[data-testid="agent-activity-as-of"]')!;
    const firstTime = asOf.textContent;
    expect(status.textContent).toBe("Codex session");
    expect(status.contains(asOf)).toBe(false);
    expect(asOf.getAttribute("aria-live")).toBe("off");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(status.textContent).toBe("Codex session");
    expect(asOf.textContent).not.toBe(firstTime);
  });

  it("preserves reading position away from the bottom while new events arrive", async () => {
    calls.api.mockResolvedValueOnce(ready).mockResolvedValueOnce({ ...ready, events: [...ready.events, { id: "e5", at: null, kind: "assistant", tool: null, text: "More detail" }] });
    await render();
    await act(async () => button().click());
    const history = list()!;
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 100 });
    history.scrollTop = 100;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(list()?.scrollTop).toBe(100);
  });
});
