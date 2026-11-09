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
    { id: "w1", name: "Atlas Studio", agentCount: 3, activeAgentCount: 1,
      tokenUsage24h: { coverage: "ready", knownTokens: 123_456 }, tokenUsage7d: { coverage: "ready", knownTokens: 1_234_567 }, agents: [
      { id: "p1", name: "A very long synthetic agent name that must wrap inside the panel", kind: "codex", role: "Lead", model: "a-very-long-synthetic-model-identifier-that-must-wrap-in-a-narrow-panel", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "working", taskHint: "Draft a synthetic release plan with enough detail to occupy more than two lines in a narrow panel without showing any private terminal text." },
      { id: "p2", name: "Mira", kind: "codex", role: null, model: null, reasoningEffort: null, contextUsed: null, contextWindow: null, state: "blocked", taskHint: null },
      { id: "p3", name: "Pine", kind: "codex", role: "Reviewer", model: "model-b", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "idle", taskHint: "Review sample cards" },
    ] },
    { id: "w2", name: "Maple Ops", agentCount: 2, activeAgentCount: 0,
      tokenUsage24h: { coverage: "unavailable", knownTokens: null }, tokenUsage7d: { coverage: "unavailable", knownTokens: null }, agents: [
      { id: "p4", name: "Lark", kind: "codex", role: "Developer", model: "model-c", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "done", taskHint: "Prepare sample data" },
      { id: "p5", name: "Sage", kind: "codex", role: "Designer", model: "model-d", reasoningEffort: "high", contextUsed: 48_000, contextWindow: 256_000, state: "unknown", taskHint: null },
    ] },
  ],
};

let host: HTMLDivElement;
let root: Root;
const render = async (view: "content" | "panel", snapshot: LocalAgentTeamsResponse | null = ready) => {
  await act(async () => root.render(view === "content"
    ? createElement(AgentTeamView, { snapshot }) : createElement(AgentTeamPanel)));
};
const offices = () => [...host.querySelectorAll<HTMLButtonElement>("[data-team-house]")];
const members = () => host.querySelector<HTMLElement>('[data-testid="selected-agent-team"]');
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
  it("keeps the count, read time and Pause beside Agent Offices without a separate page header", async () => {
    await render("content");
    const header = host.querySelector<HTMLElement>('[data-testid="agent-offices-header"]')!;
    const summary = header.querySelector<HTMLElement>('[data-testid="agent-town-summary"]')!;
    const pause = header.querySelector<HTMLButtonElement>("button")!;
    expect(header.querySelector("h2")?.textContent).toBe("Agent Offices");
    expect(summary.textContent).toContain("2 teams · Last read");
    expect(host.querySelector('[data-testid="agent-team-panel"] > header')).toBeNull();
    expect(text()).not.toContain("Local Herdr ·");
    expect(pause.getAttribute("aria-label")).toBe("Pause town animation");
    expect(pause.getAttribute("aria-pressed")).toBe("false");
    await act(async () => pause.click());
    expect(pause.getAttribute("aria-label")).toBe("Play town animation");
    expect(pause.getAttribute("aria-pressed")).toBe("true");
    expect(members()?.querySelector("h3")?.textContent).toBe("Atlas Studio");
  });

  it("keeps verified team tokens beside its name and state while labeling partial, stale and missing coverage", async () => {
    await render("content");
    const header = members()!.querySelector("header")!;
    const usage = header.querySelector<HTMLElement>('[data-testid="team-token-24h"]')!;
    const week = header.querySelector<HTMLElement>('[data-testid="team-token-7d"]')!;
    expect(header.textContent).toContain("Atlas Studio");
    expect(header.textContent).toContain("Working");
    expect(usage.textContent).toBe("24h tokens 123.5K");
    expect(usage.getAttribute("aria-label")).toBe("Current verified team sessions only · 24h tokens 123,456");
    expect(week.textContent).toBe("7d tokens 1.2M");
    expect(week.getAttribute("aria-label")).toBe("Current verified team sessions only · 7d tokens 1,234,567");

    const partial = { ...ready, teams: ready.teams.map((team) => team.id === "w1"
      ? { ...team, tokenUsage24h: { coverage: "partial" as const, knownTokens: 42 },
        tokenUsage7d: { coverage: "partial" as const, knownTokens: 420 } } : team) };
    await render("content", partial);
    expect(usage.textContent).toBe("24h tokens ≥42 · partial");
    expect(week.textContent).toBe("7d tokens ≥420 · partial");
    await render("content", { ...partial, status: "stale" });
    expect(usage.textContent).toBe("Last observed · 24h tokens ≥42 · partial");
    expect(week.textContent).toBe("Last observed · 7d tokens ≥420 · partial");
    await render("content", { ...partial, teams: partial.teams.map((team) => team.id === "w1"
      ? { ...team, tokenUsage24h: { coverage: "partial" as const, knownTokens: null },
        tokenUsage7d: { coverage: "partial" as const, knownTokens: null } } : team) });
    expect(usage.textContent).toBe("24h tokens · partial");
    expect(week.textContent).toBe("7d tokens · partial");
    setLocale("zh");
    await render("content", { ...ready, teams: ready.teams.map((team) => team.id === "w1"
      ? { ...team, tokenUsage24h: { coverage: "unavailable" as const, knownTokens: null },
        tokenUsage7d: { coverage: "unavailable" as const, knownTokens: null } } : team) });
    expect(usage.textContent).toBe("近 24 小时 Token 不可用");
    expect(week.textContent).toBe("近 7 天 Token 不可用");
  });

  it("shows exact partial lower bounds across compact unit boundaries", async () => {
    for (const knownTokens of [999, 1_000, 123_456, 999_999, 1_000_000]) {
      const partial = { ...ready, teams: ready.teams.map((team) => team.id === "w1"
        ? { ...team, tokenUsage24h: { coverage: "partial" as const, knownTokens },
          tokenUsage7d: { coverage: "partial" as const, knownTokens } } : team) };
      await render("content", partial);
      const exact = knownTokens.toLocaleString("en");
      expect(members()!.querySelector('[data-testid="team-token-24h"]')?.textContent).toBe(`24h tokens ≥${exact} · partial`);
      expect(members()!.querySelector('[data-testid="team-token-7d"]')?.textContent).toBe(`7d tokens ≥${exact} · partial`);
    }
  });

  it("waits for a snapshot, selects the most recently active team and retains a manual collapse", async () => {
    await render("content", { status: "unavailable", updatedAt: null, teamCount: null, teams: [] });
    const recent = { ...ready, teams: ready.teams.map((team, index) => ({ ...team, activeAgentCount: 0,
      lastActivityAt: 1_000 + index, agents: team.agents.map((agent) => ({ ...agent, state: "done" as const })) })) };
    await render("content", recent);
    expect(members()?.querySelector("h3")?.textContent).toBe("Maple Ops");
    await act(async () => offices()[1]!.click());
    await render("content", ready);
    expect(members()).toBeNull();
  });

  it("prioritizes working teams over newer idle sessions", async () => {
    await render("content", { ...ready, teams: ready.teams.map((team, index) => ({ ...team, lastActivityAt: 1_000 + index })) });
    expect(members()?.querySelector("h3")?.textContent).toBe("Atlas Studio");
    await act(async () => offices()[1]!.click());
    await render("content", ready);
    expect(members()?.querySelector("h3")?.textContent).toBe("Maple Ops");
  });

  it("leaves idle teams collapsed when their activity time is unknown", async () => {
    await render("content", { ...ready, teams: [ready.teams[1]!] });
    expect(members()).toBeNull();
  });

  it("mounts recent activity only for the selected office and clears it on a team switch", async () => {
    const selected = { ...ready, teams: ready.teams.map((team) => team.id === "w1"
      ? { ...team, agents: team.agents.map((member, index) => index === 0 ? { ...member, id: "w1:p1" } : member) }
      : team) };
    const detail = { agentId: "w1:p1", status: "ready", updatedAt: 1000, truncated: false,
      events: [{ id: "e1", at: null, kind: "user", tool: null, text: "Synthetic activity line" }] };
    calls.api.mockImplementation(async (path: string) => path === "/api/local-dashboard/agents" ? selected : detail);
    await render("panel");
    expect(members()).not.toBeNull();
    const activity = members()!.querySelector<HTMLButtonElement>('[data-testid="agent-activity-w1:p1"] button')!;
    expect(activity.getAttribute("aria-expanded")).toBe("false");
    expect(calls.api).toHaveBeenCalledTimes(1);
    activity.focus();
    await act(async () => activity.click());
    expect(document.activeElement).toBe(activity);
    expect(members()?.textContent).toContain("Synthetic activity line");
    const signal = calls.api.mock.calls.at(-1)?.[1]?.signal as AbortSignal;
    await act(async () => offices()[1]!.click());
    expect(signal.aborted).toBe(true);
    expect(members()?.textContent).not.toContain("Synthetic activity line");
    expect(members()?.querySelector('[data-testid="agent-activity-w1:p1"]')).toBeNull();
  });

  it("shows one selected office at a time and preserves selection, focus and scroll through a stale update", async () => {
    await render("content");
    expect(text()).toContain("2 teams");
    expect(text()).toContain("Agent Offices");
    expect(text()).not.toContain("Updates every 2 seconds");
    expect(offices()).toHaveLength(2);
    expect(offices().map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(offices()[0]!.textContent).toContain("3 agents");
    expect(offices()[0]!.textContent).toContain("1 active");
    expect(offices()[1]!.textContent).toContain("2 agents");
    expect(members()).not.toBeNull();
    const first = offices()[0]!;
    first.focus();
    expect(offices().map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(first.getAttribute("aria-controls")).toBe(members()?.id);
    expect(members()?.querySelector("h3")?.textContent).toBe("Atlas Studio");
    expect(members()?.querySelectorAll("li")).toHaveLength(3);
    expect(text()).toContain("Working");
    expect(text()).toContain("Model · a-very-long-synthetic-model-identifier");
    expect(text()).toContain("Needs input");
    expect(text()).toContain("Idle");
    expect(text()).toContain("Model unavailable");
    expect(text()).toContain("No instruction available");
    expect(host.querySelector(".line-clamp-2")).not.toBeNull();

    const scroller = host.querySelector<HTMLElement>('[data-testid="agent-team-panel"]')!;
    const selector = host.querySelector<HTMLElement>(".agent-town-offices")!;
    scroller.scrollTop = 42;
    selector.scrollTop = 25;
    await render("content", { ...ready, status: "stale", teams: ready.teams.map((team) => team.id === "w1"
      ? { ...team, agents: team.agents.map((agent) => agent.id === "p1" ? { ...agent, state: "blocked" } : agent) }
      : team) });
    expect(offices()[0]).toBe(first);
    expect(document.activeElement).toBe(first);
    expect(scroller.scrollTop).toBe(42);
    expect(selector.scrollTop).toBe(25);
    expect(offices().map((button) => button.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(text()).toContain("Showing the last known teams");
    expect(text()).toContain("Last observed · Needs input");
    expect(offices()[0]!.textContent).toContain("1 last active");
    expect(members()?.querySelector<HTMLElement>("li .bg-ink-secondary\\/30")).not.toBeNull();
    expect(text()).toContain("2 teams");

    await act(async () => offices()[1]!.click());
    expect(offices().map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true"]);
    expect(members()?.querySelector("h3")?.textContent).toBe("Maple Ops");
    expect(members()?.querySelectorAll("li")).toHaveLength(2);
    expect(members()?.textContent).not.toContain("Mira");
    expect(members()?.textContent).toContain("2 agents");
    expect(members()?.textContent).toContain("0 last active");
    expect(text()).toContain("Response ready");
    expect(text()).toContain("Unknown");
    expect(text()).not.toContain("Task completed");
    await act(async () => offices()[1]!.click());
    expect(members()).toBeNull();
  });

  it("distinguishes no snapshot from a real empty team list", async () => {
    await render("content", null);
    expect(text()).toContain("— teams");
    expect(text()).toContain("No successful read yet");
    expect(text()).toContain("Loading local teams");
    expect(host.querySelector('[data-testid="agent-offices-header"] h2')?.textContent).toBe("Agent Offices");
    expect(host.querySelector('.agent-town-offices')).toBeNull();

    await render("content", { status: "unavailable", updatedAt: null, teamCount: null, teams: [] });
    expect(text()).toContain("— teams");
    expect(text()).toContain("teams are unavailable");
    expect(text()).not.toContain("0 teams");
    expect(host.querySelector('[data-testid="agent-offices-header"] button')).toBeNull();
    expect(members()).toBeNull();

    await render("content", { status: "ready", updatedAt: ready.updatedAt, teamCount: 0, teams: [] });
    expect(text()).toContain("0 teams");
    expect(text()).toContain("No local Herdr teams found");
    expect(host.querySelector('.agent-town-offices')).toBeNull();
    expect(members()).toBeNull();
  });

  it("uses singular copy for one team and one agent in English and Chinese", async () => {
    const single = { ...ready, teamCount: 1, teams: [{ ...ready.teams[0]!, agentCount: 1, activeAgentCount: 1, agents: [ready.teams[0]!.agents[0]!] }] };
    await render("content", single);
    expect(text()).toContain("1 team");
    expect(text()).toContain("1 agent");
    expect(text()).not.toContain("1 teams");
    expect(text()).not.toContain("1 agents");
    expect(members()).not.toBeNull();

    setLocale("zh");
    await render("content", single);
    expect(text()).toContain("1 个团队");
    expect(text()).toContain("1 个成员");
  });

  it("reads only the local dashboard route and retains its last snapshot on a transport failure", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error("offline"));
    await render("panel");
    expect(calls.api).toHaveBeenCalledWith("/api/local-dashboard/agents", expect.objectContaining({ background: true, signal: expect.any(AbortSignal) }));
    expect(text()).toContain("2 teams");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(text()).toContain("Showing the last known teams");
    expect(text()).toContain("2 teams");
  });

  it("replaces selected office details every two seconds without moving focus or scroll", async () => {
    vi.useFakeTimers();
    const updated = { ...ready, teams: ready.teams.map((team) => team.id === "w1" ? { ...team, activeAgentCount: 0,
      agents: team.agents.map((agent) => agent.id === "p1" ? { ...agent, state: "done" as const, taskHint: "Only the newest instruction", reasoningEffort: "max", contextUsed: 64_000 } : agent) } : team) };
    calls.api.mockResolvedValueOnce(ready).mockResolvedValueOnce(updated);
    await render("panel");
    const first = offices()[0]!;
    first.focus();
    const scroller = host.querySelector<HTMLElement>('[data-testid="agent-team-panel"]')!;
    const selector = host.querySelector<HTMLElement>(".agent-town-offices")!;
    scroller.scrollTop = 90;
    selector.scrollTop = 20;
    expect(first.textContent).toContain("1 active");
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(calls.api).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.api).toHaveBeenCalledTimes(2);
    expect(offices()[0]).toBe(first);
    expect(document.activeElement).toBe(first);
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(first.textContent).toContain("0 active");
    expect(scroller.scrollTop).toBe(90);
    expect(selector.scrollTop).toBe(20);
    expect(members()?.textContent).toContain("Only the newest instruction");
    expect(members()?.textContent).toContain("64,000 / 256,000 · 25%");
    expect(members()?.textContent).not.toContain("Draft a synthetic release plan");
    expect(host.querySelector('[data-team-house="w1"]')?.getAttribute("data-activity")).toBe("blocked");
  });

  it("clears a departed office and returns focus to the selector", async () => {
    await render("content");
    const first = offices()[0]!;
    first.focus();
    expect(members()?.textContent).toContain("Mira");
    await render("content", { ...ready, teamCount: 1, teams: [ready.teams[1]!] });
    expect(members()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".agent-town-offices"));
    expect(offices()[0]?.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps focus on an unrelated input when the selected office disappears", async () => {
    await render("content");
    await act(async () => offices()[1]!.click());
    const external = document.createElement("input");
    document.body.append(external);
    try {
      external.focus();
      await render("content", { ...ready, teamCount: 1, teams: [ready.teams[0]!] });
      expect(members()).toBeNull();
      expect(document.activeElement).toBe(external);
    } finally {
      external.remove();
    }
  });

  it("returns focus from removed member content to the surviving selector", async () => {
    await render("content");
    const selected = members()!;
    selected.tabIndex = -1;
    selected.focus();
    await render("content", { ...ready, teamCount: 1, teams: [ready.teams[1]!] });
    expect(members()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector(".agent-town-offices"));
  });

  it.each([401, 403])("clears old local data on HTTP %i", async (status) => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce(ready).mockRejectedValueOnce(new ApiError("forbidden", status));
    await render("panel");
    const first = offices()[0]!;
    first.focus();
    expect(members()?.textContent).toContain("Mira");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(text()).toContain("— teams");
    expect(text()).toContain("teams are unavailable");
    expect(text()).not.toContain("Atlas Studio");
    expect(members()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-testid="agent-team-panel"]'));
  });

  it("keeps a valid empty snapshot and its zero count when the next read fails", async () => {
    vi.useFakeTimers();
    calls.api.mockResolvedValueOnce({ status: "ready", updatedAt: ready.updatedAt, teamCount: 0, teams: [] })
      .mockRejectedValueOnce(new Error("offline"));
    await render("panel");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(text()).toContain("0 teams");
    expect(text()).toContain("Showing the last known teams");
    expect(text()).toContain("No local Herdr teams found");
    expect(text()).not.toContain("No successful read yet");
  });
});
