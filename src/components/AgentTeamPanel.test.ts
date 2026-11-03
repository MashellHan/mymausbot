// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAgentTeamsResponse } from "../../shared/local-dashboard";
import { setLocale } from "@/lib/i18n";

const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: calls.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

const { AgentTeamPanel, AgentTeamView } = await import("./AgentTeamPanel");
const { ApiError } = await import("@/state/store");

const ready: LocalAgentTeamsResponse = {
  status: "ready", updatedAt: Date.UTC(2026, 10, 3, 8), teamCount: 2,
  teams: [
    { id: "w1", name: "Atlas Studio", agentCount: 3, agents: [
      { id: "p1", name: "A very long synthetic agent name that must wrap inside the panel", kind: "codex", role: "Lead", model: "a-very-long-synthetic-model-identifier-that-must-wrap-in-a-narrow-panel", state: "working", taskHint: "Draft a synthetic release plan with enough detail to occupy more than two lines in a narrow panel without showing any private terminal text." },
      { id: "p2", name: "Mira", kind: "codex", role: null, model: null, state: "blocked", taskHint: null },
      { id: "p3", name: "Pine", kind: "codex", role: "Reviewer", model: "model-b", state: "idle", taskHint: "Review sample cards" },
    ] },
    { id: "w2", name: "Maple Ops", agentCount: 2, agents: [
      { id: "p4", name: "Lark", kind: "codex", role: "Developer", model: "model-c", state: "done", taskHint: "Prepare sample data" },
      { id: "p5", name: "Sage", kind: "codex", role: "Designer", model: "model-d", state: "unknown", taskHint: null },
    ] },
  ],
};

let host: HTMLDivElement;
let root: Root;
const render = async (view: "content" | "panel", snapshot: LocalAgentTeamsResponse = ready) => {
  await act(async () => root.render(view === "content"
    ? createElement(AgentTeamView, { snapshot }) : createElement(AgentTeamPanel)));
};
const headers = () => [...host.querySelectorAll<HTMLButtonElement>("section h3 button")];
const text = () => host.textContent ?? "";

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  setLocale("en");
  calls.api.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("Agent Team panel", () => {
  it("keeps independent groups collapsed, then preserves expansion, focus and scroll through a stale update", async () => {
    await render("content");
    expect(text()).toContain("Local Herdr · 2 teams");
    expect(headers()).toHaveLength(2);
    expect(headers().map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(headers().map((button) => document.getElementById(button.getAttribute("aria-controls")!)?.hidden)).toEqual([true, true]);
    expect(text()).toContain("3 agents");
    expect(text()).toContain("2 agents");

    const first = headers()[0]!;
    first.focus();
    await act(async () => first.click());
    expect(headers().map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    expect(text()).toContain("Working");
    expect(text()).toContain("Model · a-very-long-synthetic-model-identifier");
    expect(text()).toContain("Needs input");
    expect(text()).toContain("Idle");
    expect(text()).toContain("Model unavailable");
    expect(text()).toContain("Latest task unavailable");
    expect(host.querySelector(".line-clamp-2")).not.toBeNull();

    const scroller = host.querySelector<HTMLElement>('[data-testid="agent-team-panel"]')!;
    scroller.scrollTop = 42;
    await render("content", { ...ready, status: "stale", teams: ready.teams.map((team) => team.id === "w1"
      ? { ...team, agents: team.agents.map((agent) => agent.id === "p1" ? { ...agent, state: "blocked" } : agent) }
      : team) });
    expect(headers()[0]).toBe(first);
    expect(document.activeElement).toBe(first);
    expect(scroller.scrollTop).toBe(42);
    expect(headers().map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
    expect(text()).toContain("Showing the last known teams");
    expect(text()).toContain("Last observed · Needs input");
    expect(host.querySelector<HTMLElement>("section li .bg-ink-secondary\\/30")).not.toBeNull();
    expect(text()).toContain("Local Herdr · 2 teams");

    await act(async () => headers()[1]!.click());
    expect(headers().map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
    expect(text()).toContain("Response ready");
    expect(text()).toContain("Unknown");
    expect(text()).not.toContain("Task completed");
  });

  it("distinguishes no snapshot from a real empty team list", async () => {
    await render("content", { status: "unavailable", updatedAt: null, teamCount: null, teams: [] });
    expect(text()).toContain("Local Herdr · — teams");
    expect(text()).toContain("teams are unavailable");
    expect(text()).not.toContain("0 teams");

    await render("content", { status: "ready", updatedAt: ready.updatedAt, teamCount: 0, teams: [] });
    expect(text()).toContain("Local Herdr · 0 teams");
    expect(text()).toContain("No local Herdr teams found");
  });

  it("uses singular copy for one team and one agent in English and Chinese", async () => {
    const single = { ...ready, teamCount: 1, teams: [{ ...ready.teams[0]!, agentCount: 1, agents: [ready.teams[0]!.agents[0]!] }] };
    await render("content", single);
    expect(text()).toContain("Local Herdr · 1 team");
    expect(text()).toContain("1 agent");
    expect(text()).not.toContain("1 teams");
    expect(text()).not.toContain("1 agents");

    setLocale("zh");
    await render("content", single);
    expect(text()).toContain("本机 Herdr · 1 个团队");
    expect(text()).toContain("1 个成员");
  });

  it("reads only the local dashboard route and retains its last snapshot on a transport failure", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error("offline"));
    await render("panel");
    expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/agents", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));
    expect(text()).toContain("Local Herdr · 2 teams");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toContain("Showing the last known teams");
    expect(text()).toContain("Local Herdr · 2 teams");
  });

  it.each([401, 403])("clears old local data on HTTP %i", async (status) => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(ready).mockRejectedValueOnce(new ApiError("forbidden", status));
    await render("panel");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toContain("Local Herdr · — teams");
    expect(text()).toContain("teams are unavailable");
    expect(text()).not.toContain("Atlas Studio");
  });

  it("keeps a valid empty snapshot and its zero count when the next read fails", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce({ status: "ready", updatedAt: ready.updatedAt, teamCount: 0, teams: [] })
      .mockRejectedValueOnce(new Error("offline"));
    await render("panel");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(text()).toContain("Local Herdr · 0 teams");
    expect(text()).toContain("Showing the last known teams");
    expect(text()).toContain("No local Herdr teams found");
    expect(text()).not.toContain("No successful read yet");
  });
});
