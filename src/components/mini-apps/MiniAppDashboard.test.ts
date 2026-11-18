// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAgentTeamsResponse, LocalUsageCounts, LocalUsageRepositories, LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../../../shared/local-dashboard";
import type { MiniAppDashboardDeclaration, MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { setLocale } from "@/lib/i18n";
import { withGithubUsageFixture } from "../../../scripts/testing/merged-usage-fixture";
import { primaryUsageFixture } from "../../../scripts/testing/primary-usage-fixture";

const calls = vi.hoisted(() => ({ api: vi.fn(), visible: true }));
vi.mock("@/state/store", () => ({
  api: calls.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => calls.visible }));

import { MiniAppDashboard } from "./MiniAppDashboard";
const { ApiError } = await import("@/state/store");

const appId = "00000000-0000-4000-8000-000000000001";
const declarations = {
  "agent-team": { kind: "agent-team", renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: ["teams", "activity"] },
  usage: { kind: "usage", renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: ["usage"] },
} as const satisfies Record<"agent-team" | "usage", MiniAppDashboardDeclaration>;
const documentFor = (kind: "agent-team" | "usage", revision = 3): MiniAppDocument => ({
  app: { id: appId, slug: kind, title: kind, description: "Synthetic view", status: "active", revision, templateVersion: 1,
    publisherBotIds: [], dashboard: declarations[kind], dashboardIdentity: kind, createdAt: 1, updatedAt: 2 },
  html: "<p>Inert fallback</p>", bindings: [], versions: [],
});
const stateFor = (revision = 3): MiniAppState => ({ appId, revision, templateVersion: 1, status: "active", data: [] });
const teams: LocalAgentTeamsResponse = { status: "ready", updatedAt: 1_000, teamCount: 1, teams: [
  { id: "w1", name: "Synthetic team", agentCount: 1, activeAgentCount: 1, agents: [
    { id: "w1:p1", occupantId: "o1234567890abcdef", name: "Pine", kind: "codex", role: "Developer", model: "model-a", reasoningEffort: "high",
      contextUsed: 100, contextWindow: 1_000, state: "working", taskHint: "Review a synthetic task" },
  ] },
] };
const emptyCategory = { prs: 0, knownPrs: 0, commits: 0 };
const endDay = "2026-11-07";
const shiftDay = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
function repositoryUsage(prs: number, commits: number, asOf = Date.UTC(2026, 10, 7, 8)): LocalUsageResponse {
  const counts = (days: number): LocalUsageCounts => ({ prs: days * prs, knownPrs: days * prs, commits: days * commits });
  const categories = (observed: LocalUsageCounts) => ({ work: observed, personal: emptyCategory, unclassified: emptyCategory });
  const repositories = (observed: LocalUsageCounts): LocalUsageRepositories => ({
    sharedCommits: 0, coverage: "ready", unattributedPrs: 0, unattributedCommits: 0,
    rows: [{ id: "local-repo", name: "fixture/local-repo", category: "work", ...observed, comparison: { prs: null, commits: null } }],
  });
  const trend: LocalUsageTrendDay[] = Array.from({ length: 30 }, (_, index) => ({
    day: shiftDay(endDay, index - 29), coverage: "ready", tokenStatus: "ready",
    ...counts(1), newTokens: 80, cacheRead: 20, totalTokens: 100,
    categories: categories(counts(1)), repositories: repositories(counts(1)),
    wow: { prs: null, commits: null, newTokens: null, totalTokens: null },
  }));
  const windowFor = (days: 1 | 7 | 30): LocalUsageWindow => {
    const startDay = shiftDay(endDay, 1 - days);
    const observed = counts(days);
    return {
      days, startDay, endDay, asOf, coverage: "ready", tokenCoverage: "ready", missingDays: [], unavailableTokenDays: [],
      ...observed, newTokens: days * 80, cacheRead: days * 20, totalTokens: days * 100,
      comparison: { startDay: shiftDay(startDay, -days), endDay: shiftDay(startDay, -1), missingDays: [],
        unavailableTokenDays: days === 30 ? Array.from({ length: days }, (_, index) => shiftDay(startDay, index - days)) : [],
        prs: null, commits: null, totalTokens: null,
        categories: { work: { prs: null, commits: null }, personal: { prs: null, commits: null }, unclassified: { prs: null, commits: null } } },
      categories: categories(observed), repositories: repositories(observed),
    };
  };
  return {
    status: "ready", asOf, timeZone: "Asia/Shanghai",
    sourceCoverage: { total: 1, ready: 1, partial: 0, stale: 0, missing: 0 },
    prSourceCoverage: { total: 1, ready: 1, stale: 0, unavailable: 0, missing: 0 },
    prCoverage: { work: "ready", personal: "ready", unclassified: "ready" },
    windows: { "1": windowFor(1), "7": windowFor(7), "30": windowFor(30) }, trend,
  };
}
const usage = repositoryUsage(1, 2);
const profile = withGithubUsageFixture(repositoryUsage(3, 7)).github!;

let host: HTMLDivElement;
let root: Root;
const revoked = vi.fn();
const changed = vi.fn();
const render = async (kind: "agent-team" | "usage", revision = 3) => {
  await act(async () => root.render(createElement(MiniAppDashboard, {
    key: `${kind}:${revision}`, document: documentFor(kind, revision), state: stateFor(revision), refreshKey: 0, onRevoked: revoked, onChanged: changed,
  })));
};
const activityValues = () => [...host.querySelectorAll("section:first-of-type dd > span:first-child")].slice(0, 3).map(value => value.textContent);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { app: { blocksOpaqueFrameNavigation: true } });
  setLocale("en");
  calls.api.mockReset();
  calls.visible = true;
  revoked.mockReset();
  changed.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("installed native Mini App dashboards", () => {
  it("reads team metadata and folded member activity only through the app-scoped revision", async () => {
    const dashboardPath = `/api/mini-apps/${appId}/dashboard`;
    const rulesPath = "/api/local-dashboard/teams/w1/rules";
    calls.api.mockImplementation(async (path: string, options: { body?: string }) => {
      if (path === rulesPath) {
        expect(options.body).toBeUndefined();
        return { teamId: "w1", status: "missing", markdown: null };
      }
      expect(path).toBe(dashboardPath);
      const body = JSON.parse(options.body!);
      return { appId, revision: 3, resource: body.resource, snapshot: body.resource === "teams" ? teams
        : { agentId: "w1:p1", status: "ready", updatedAt: 1_000, truncated: false,
          events: [{ id: "e1", kind: "user", at: null, tool: null, text: "Synthetic recent input" }] } };
    });
    await render("agent-team");
    await vi.waitFor(() => expect(host.querySelectorAll("[data-team-house]")).toHaveLength(1));
    expect(host.querySelector('[data-testid="selected-agent-team"]')).not.toBeNull();
    expect(calls.api.mock.calls).toEqual([
      [dashboardPath, expect.objectContaining({ method: "POST", body: JSON.stringify({ resource: "teams", expectedRevision: 3 }) })],
      [rulesPath, { background: true, signal: expect.any(AbortSignal), timeoutMs: 10_000 }],
    ]);
    expect(host.textContent).not.toContain("Synthetic recent input");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-select="w1:p1"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agent-activity-w1:p1"] button')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Synthetic recent input"));
    expect(calls.api.mock.calls.map(([path]) => path)).toEqual([
      dashboardPath, rulesPath, dashboardPath,
    ]);
    expect(calls.api.mock.calls[2]![1].method).toBe("POST");
    expect(JSON.parse(calls.api.mock.calls[2]![1].body)).toEqual({ resource: "activity", expectedRevision: 3,
      agentId: "w1:p1", occupantId: "o1234567890abcdef" });
  });

  it.each([false, true])("keeps a three-second native activity read across a two-second poll (occupant replaced: %s)", async (replaced) => {
    vi.useFakeTimers();
    let teamReads = 0;
    let activityReads = 0;
    let activitySignal: AbortSignal | undefined;
    calls.api.mockImplementation((path: string, options: { body?: string; signal?: AbortSignal }) => {
      if (path === "/api/local-dashboard/teams/w1/rules") return Promise.resolve({ teamId: "w1", status: "missing", markdown: null });
      const body = JSON.parse(options.body!);
      if (body.resource === "teams") {
        teamReads++;
        const occupantId = replaced && teamReads > 1 ? "o0000000000000000" : "o1234567890abcdef";
        return Promise.resolve({ appId, revision: 3, resource: "teams", snapshot: { ...teams, updatedAt: 1_000 + teamReads,
          teams: teams.teams.map((team) => ({ ...team, agents: team.agents.map((member) => ({ ...member, occupantId })) })) } });
      }
      if (body.resource === "activity") {
        activityReads++;
        activitySignal = options.signal;
        return new Promise((resolve) => setTimeout(() => resolve({ appId, revision: 3, resource: "activity",
          snapshot: { agentId: "w1:p1", status: "ready", updatedAt: 1_003, truncated: false,
            events: [{ id: "e1", kind: "assistant", at: null, tool: null, text: "Delayed synthetic reply" }] } }), 3_000));
      }
      throw new Error("Unexpected resource");
    });
    await render("agent-team");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-agent-select="w1:p1"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agent-activity-w1:p1"] button')!.click());
    expect(activityReads).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(teamReads).toBe(2);
    expect(activityReads).toBe(1);
    expect(activitySignal?.aborted).toBe(replaced);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(host.textContent?.includes("Delayed synthetic reply")).toBe(!replaced);
  });

  it("shows repository observations throughout the app-scoped Activities snapshot", async () => {
    const contributions = primaryUsageFixture(endDay);
    const snapshot = { ...usage, github: profile, contributions };
    calls.api.mockResolvedValue({ appId, revision: 3, resource: "usage", snapshot });
    await render("usage");
    await vi.waitFor(() => expect(host.querySelectorAll("[data-usage-trend]")).toHaveLength(3));
    expect(host.textContent).toContain("1-day window");
    expect(host.textContent).toContain(endDay);
    expect(host.querySelector('[data-usage-metric-definition], [data-usage-primary-sources]')).toBeNull();
    expect(host.querySelector('[data-usage-latest-update]')?.getAttribute("datetime")).toBe(`${endDay}T08:00:00.000Z`);
    const metricHeaders = [...host.querySelectorAll("section:first-of-type dt")];
    expect(metricHeaders.map(value => value.textContent)).toEqual(["PRs", "Commits", "Tokens"]);
    expect(metricHeaders[0]?.getAttribute("title")).toContain("PR creations from configured GitHub and ADO sources, dated in China time");
    expect(metricHeaders[1]?.getAttribute("title")).toContain("non-merge Git commits across local branches");
    expect(activityValues()).toEqual(["1", "2", "100"]);
    expect(host.querySelector(`[data-usage-trend="prs"] [data-usage-day="${endDay}"]`)?.getAttribute("aria-label")).toMatch(/: PRs 1$/);
    expect(host.querySelector(`[data-usage-trend="commits"] [data-usage-day="${endDay}"]`)?.getAttribute("aria-label")).toMatch(/: Commits 2$/);
    expect([...host.querySelectorAll('[data-usage-daily] tbody tr:first-child > td')].slice(0, 3).map(value => value.textContent)).toEqual(["1", "2", "100"]);
    expect(host.querySelector('[data-usage-repositories] tbody th')?.textContent).toBe("fixture/local-repo");
    expect(host.querySelectorAll("section dd [data-usage-provisional]")).toHaveLength(0);
    expect(host.querySelector('select[aria-label="Activity source"]')).toBeNull();
    expect(host.querySelector('[data-usage-week-start="2026-11-02"]')).not.toBeNull();
    expect(host.querySelector('[data-usage-weekend-tick]')).toBeNull();
    expect(calls.api.mock.calls[0]![0]).toBe(`/api/mini-apps/${appId}/dashboard`);
    expect(JSON.parse(calls.api.mock.calls[0]![1].body)).toEqual({ resource: "usage", expectedRevision: 3 });
  });

  it("refreshes visible repository observations in five seconds without waiting for older tokens or changing its app scope", async () => {
    vi.useFakeTimers();
    const first = { ...usage, github: profile, contributions: primaryUsageFixture(endDay) };
    const next = { ...repositoryUsage(4, 8, Date.UTC(2026, 10, 7, 8, 5)), github: profile,
      contributions: primaryUsageFixture(endDay, false, `${endDay}T08:31:00Z`,
      { github: { prs: 4, commits: 6 }, ado: { prs: 2, commits: 5 } }) };
    calls.api.mockResolvedValueOnce({ appId, revision: 3, resource: "usage", snapshot: first })
      .mockResolvedValue({ appId, revision: 3, resource: "usage", snapshot: next });
    await render("usage");
    expect(activityValues()).toEqual(["1", "2", "100"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(calls.api).toHaveBeenCalledTimes(1);
    expect(activityValues()).toEqual(["1", "2", "100"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(calls.api).toHaveBeenCalledTimes(2);
    expect(activityValues()).toEqual(["4", "8", "100"]);
    expect(host.querySelector('[data-usage-latest-update]')?.getAttribute("datetime")).toBe(`${endDay}T08:05:00.000Z`);
    calls.visible = false;
    await render("usage");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(calls.api).toHaveBeenCalledTimes(2);
    calls.visible = true;
    await render("usage");
    expect(calls.api).toHaveBeenCalledTimes(3);
    expect(calls.api.mock.calls).toEqual(Array.from({ length: 3 }, () => [`/api/mini-apps/${appId}/dashboard`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ resource: "usage", expectedRevision: 3 }) }),
    ]));
  });

  it("aborts an in-flight read when hidden or when its installed revision changes", async () => {
    let finish!: (value: unknown) => void;
    calls.api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render("usage");
    const firstSignal = calls.api.mock.calls[0]![1].signal as AbortSignal;
    calls.visible = false;
    await render("usage");
    expect(firstSignal.aborted).toBe(true);
    await act(async () => finish({ appId, revision: 3, resource: "usage", snapshot: usage }));
    expect(host.querySelector('[data-usage-trend]')).toBeNull();
    calls.visible = true;
    await render("usage", 4);
    const nextSignal = calls.api.mock.calls[1]![1].signal as AbortSignal;
    await act(async () => root.unmount());
    expect(nextSignal.aborted).toBe(true);
    root = createRoot(host);
  });

  it("stops and clears on revocation, and refreshes the host on a revision conflict", async () => {
    calls.api.mockRejectedValueOnce(new ApiError("revoked", 403));
    await render("usage");
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(1));
    calls.api.mockRejectedValueOnce(new ApiError("changed", 409));
    await render("usage", 4);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  });
});
