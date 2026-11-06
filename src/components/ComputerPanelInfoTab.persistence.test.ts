// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalAgentActivityResponse, LocalAgentTeamsResponse } from "../../shared/local-dashboard";
import type { Bot } from "@/state/store";
import { setLocale } from "@/lib/i18n";

const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: calls.api,
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));
vi.mock("./LocalUsagePanel", () => ({ LocalUsagePanel: () => "Usage" }));
vi.mock("./mini-apps/MiniAppsPanel", () => ({ MiniAppsPanel: () => "Mini Apps" }));

await import("./AgentTeamPanel");
const { ComputerPanelInfoTab } = await import("./ComputerPanelInfoTab");
const { ApiError } = await import("@/state/store");

const teams: LocalAgentTeamsResponse = {
  status: "ready", updatedAt: 1, teamCount: 1,
  teams: [{ id: "office", name: "Fixture Studio", agentCount: 1, activeAgentCount: 1, agents: [{
    id: "office:p1", name: "Fixture Lead", kind: "codex", role: "Lead", model: "fixture-model",
    reasoningEffort: "high", contextUsed: 20, contextWindow: 100, state: "working", taskHint: "Review fixture",
  }] }],
};
const activity: LocalAgentActivityResponse = {
  agentId: "office:p1", status: "ready", updatedAt: 1, truncated: false,
  events: [{ id: "event", at: null, kind: "user", tool: null, text: "Synthetic history" }],
};
const bot = { id: "scout", threadId: "thread" } as Bot;
let host: HTMLDivElement;
let root: Root;

const render = async (view: "agent-team" | "usage" | "mini-apps") => {
  await act(async () => root.render(createElement(ComputerPanelInfoTab, { view, bot })));
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  calls.api.mockReset();
  calls.api.mockImplementation(async (path: string) => path === "/api/local-dashboard/agents" ? teams : activity);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("keeps the selected office and open history across Usage without hidden reads", async () => {
  await render("agent-team");
  const office = host.querySelector<HTMLButtonElement>('[data-team-house="office"]')!;
  expect(office).not.toBeNull();
  expect(host.querySelector('[data-testid="selected-agent-team"]')).toBeNull();

  await act(async () => office.click());
  const disclosure = host.querySelector<HTMLButtonElement>('[data-testid="agent-activity-office:p1"] button')!;
  await act(async () => disclosure.click());
  expect(host.textContent).toContain("Synthetic history");
  const callsBeforeHide = calls.api.mock.calls.length;
  const requests = calls.api.mock.calls.map(([, options]) => options?.signal as AbortSignal);

  await render("usage");
  const team = host.querySelector<HTMLElement>('[data-testid="agent-team-panel"]')!;
  expect(team.parentElement?.hidden).toBe(true);
  expect(team.parentElement?.classList.contains("hidden")).toBe(true);
  expect(host.querySelector('[role="tabpanel"]')?.id).toBe("computer-panel-tabs-panel-usage");
  expect(office.getAttribute("aria-pressed")).toBe("true");
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Synthetic history");
  expect(requests.every((signal) => signal.aborted)).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(calls.api).toHaveBeenCalledTimes(callsBeforeHide);

  await render("agent-team");
  expect(team.parentElement?.hidden).toBe(false);
  expect(host.querySelector('[role="tabpanel"]')?.id).toBe("computer-panel-tabs-panel-agent-team");
  expect(host.querySelector('[data-team-house="office"]')).toBe(office);
  expect(office.getAttribute("aria-pressed")).toBe("true");
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Synthetic history");
  expect(calls.api.mock.calls.length).toBeGreaterThan(callsBeforeHide);

  const callsBeforeMiniApps = calls.api.mock.calls.length;
  await render("mini-apps");
  expect(host.textContent).toContain("Mini Apps");
  expect(team.parentElement?.hidden).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(calls.api).toHaveBeenCalledTimes(callsBeforeMiniApps);

  await render("agent-team");
  expect(host.querySelector('[data-team-house="office"]')).toBe(office);
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
});

it("clears retained office and history when authorization is denied on return", async () => {
  let teamReads = 0;
  calls.api.mockImplementation(async (path: string) => {
    if (path !== "/api/local-dashboard/agents") return activity;
    return ++teamReads === 1 ? teams : Promise.reject(new ApiError("Forbidden", 403));
  });
  await render("agent-team");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-team-house="office"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agent-activity-office:p1"] button')!.click());
  expect(host.textContent).toContain("Synthetic history");

  await render("usage");
  await render("agent-team");
  expect(host.textContent).toContain("Local Herdr · — teams");
  expect(host.querySelector('[data-testid="selected-agent-team"]')).toBeNull();
  expect(host.textContent).not.toContain("Synthetic history");
});
