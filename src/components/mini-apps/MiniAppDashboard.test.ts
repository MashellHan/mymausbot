// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAgentTeamsResponse, LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../../../shared/local-dashboard";
import type { MiniAppDashboardDeclaration, MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { setLocale } from "@/lib/i18n";
import { withMergedUsageFixture } from "../../../scripts/testing/merged-usage-fixture";

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
    { id: "w1:p1", name: "Pine", kind: "codex", role: "Developer", model: "model-a", reasoningEffort: "high",
      contextUsed: 100, contextWindow: 1_000, state: "working", taskHint: "Review a synthetic task" },
  ] },
] };
const emptyCategory = { prs: 0, knownPrs: 0, commits: 0 };
const trend: LocalUsageTrendDay[] = Array.from({ length: 30 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 9, 9 + index)).toISOString().slice(0, 10), coverage: "ready", tokenStatus: "ready",
  prs: 1, knownPrs: 1, commits: 2, newTokens: 80, cacheRead: 20, totalTokens: 100,
  categories: { work: { prs: 1, knownPrs: 1, commits: 2 }, personal: emptyCategory, unclassified: emptyCategory },
  wow: { prs: null, commits: null, newTokens: null, totalTokens: null },
}));
const shiftDay = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const windowFor = (days: 1 | 7 | 30): LocalUsageWindow => ({
  days, startDay: trend[30 - days]!.day, endDay: "2026-11-07", asOf: Date.UTC(2026, 10, 7, 8),
  coverage: "ready", tokenCoverage: "ready", missingDays: [], unavailableTokenDays: [],
  prs: days, knownPrs: days, commits: days * 2, newTokens: days * 80, cacheRead: days * 20, totalTokens: days * 100,
  comparison: { startDay: shiftDay(trend[30 - days]!.day, -days), endDay: shiftDay(trend[30 - days]!.day, -1), missingDays: [], unavailableTokenDays: [],
    prs: null, commits: null, totalTokens: null,
    categories: { work: { prs: null, commits: null }, personal: { prs: null, commits: null }, unclassified: { prs: null, commits: null } } },
  categories: { work: { prs: days, knownPrs: days, commits: days * 2 }, personal: emptyCategory, unclassified: emptyCategory },
  repositories: { sharedCommits: 0, coverage: "ready", unattributedPrs: 0, unattributedCommits: 0, rows: [] },
});
const usage: LocalUsageResponse = {
  status: "ready", asOf: Date.UTC(2026, 10, 7, 8), timeZone: "Asia/Shanghai",
  sourceCoverage: { total: 1, ready: 1, partial: 0, stale: 0, missing: 0 },
  prSourceCoverage: { total: 1, ready: 1, stale: 0, unavailable: 0, missing: 0 },
  prCoverage: { work: "ready", personal: "ready", unclassified: "ready" },
  windows: { "1": windowFor(1), "7": windowFor(7), "30": windowFor(30) }, trend,
};

let host: HTMLDivElement;
let root: Root;
const revoked = vi.fn();
const changed = vi.fn();
const render = async (kind: "agent-team" | "usage", revision = 3) => {
  await act(async () => root.render(createElement(MiniAppDashboard, {
    key: `${kind}:${revision}`, document: documentFor(kind, revision), state: stateFor(revision), refreshKey: 0, onRevoked: revoked, onChanged: changed,
  })));
};

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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("installed native Mini App dashboards", () => {
  it("reads team metadata and folded member activity only through the app-scoped revision", async () => {
    calls.api.mockImplementation(async (_path: string, options: { body: string }) => {
      const body = JSON.parse(options.body);
      return { appId, revision: 3, resource: body.resource, snapshot: body.resource === "teams" ? teams
        : { agentId: "w1:p1", status: "ready", updatedAt: 1_000, truncated: false,
          events: [{ id: "e1", kind: "user", at: null, tool: null, text: "Synthetic recent input" }] } };
    });
    await render("agent-team");
    await vi.waitFor(() => expect(host.querySelectorAll("[data-team-house]")).toHaveLength(1));
    expect(host.querySelector('[data-testid="selected-agent-team"]')).toBeNull();
    expect(calls.api.mock.calls.map(([, options]) => JSON.parse(options.body).resource)).toEqual(["teams"]);
    await act(async () => host.querySelector<HTMLButtonElement>("[data-team-house]")!.click());
    expect(host.textContent).not.toContain("Synthetic recent input");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="agent-activity-w1:p1"] button')!.click());
    await vi.waitFor(() => expect(host.textContent).toContain("Synthetic recent input"));
    expect(calls.api.mock.calls.map(([path]) => path)).toEqual([
      `/api/mini-apps/${appId}/dashboard`, `/api/mini-apps/${appId}/dashboard`,
    ]);
    expect(JSON.parse(calls.api.mock.calls[1]![1].body)).toEqual({ resource: "activity", expectedRevision: 3, agentId: "w1:p1" });
  });

  it("renders the same merged Usage values and weekly separators from an app-scoped snapshot", async () => {
    calls.api.mockResolvedValue({ appId, revision: 3, resource: "usage", snapshot: withMergedUsageFixture(usage) });
    await render("usage");
    await vi.waitFor(() => expect(host.querySelectorAll("[data-usage-trend]")).toHaveLength(3));
    expect(host.textContent).toContain("1-day window");
    expect(host.textContent).toContain("2026-11-07");
    expect(host.querySelector('[data-usage-week-start="2026-11-02"]')).not.toBeNull();
    expect(host.querySelector('[data-usage-weekend-tick]')).toBeNull();
    expect(calls.api.mock.calls[0]![0]).toBe(`/api/mini-apps/${appId}/dashboard`);
    expect(JSON.parse(calls.api.mock.calls[0]![1].body)).toEqual({ resource: "usage", expectedRevision: 3 });
  });

  it("aborts an in-flight read when hidden or when its installed revision changes", async () => {
    let finish!: (value: unknown) => void;
    calls.api.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render("usage");
    const firstSignal = calls.api.mock.calls[0]![1].signal as AbortSignal;
    calls.visible = false;
    await render("usage");
    expect(firstSignal.aborted).toBe(true);
    await act(async () => finish({ appId, revision: 3, resource: "usage", snapshot: withMergedUsageFixture(usage) }));
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
