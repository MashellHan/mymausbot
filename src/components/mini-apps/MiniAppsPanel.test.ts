// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocale, setLocale } from "@/lib/i18n";
import type { LocalUsageResponse } from "../../../shared/local-dashboard";
import { withMergedUsageFixture } from "../../../scripts/testing/merged-usage-fixture";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  apps: [] as MiniAppSummary[],
  defaultApps: null as MiniAppSummary[] | null,
  defaultCalls: [] as Array<{ restore?: string; bookkeepingHtml: string }>,
  defaultIssues: [] as Array<{ kind: string; error: string }>,
  stateRevision: 3,
  dataRevision: 7,
  failState: false,
  failDocument: false,
  denied: false,
  dispatch: vi.fn(),
  frameMounts: 0,
  dashboardReads: [] as string[],
  bots: [] as Array<{ id: string }>,
  owner: true as boolean,
  visible: true,
  usageValue: 1,
  usageDeferred: null as Promise<LocalUsageResponse> | null,
}));

vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
  useStore: () => ({ state: { bots: fixture.bots }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => fixture.visible }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("./MiniAppFrame", () => ({ MiniAppFrame: ({ document, state }: { document: MiniAppDocument; state: MiniAppState }) => {
  fixture.frameMounts += 1;
  return createElement("div", { "data-testid": "fixture-frame", "data-id": document.app.id, "data-data-revision": state.data[0]?.revision });
} }));

import { MiniAppsPanel } from "./MiniAppsPanel";

const dashboard = { kind: "agent-team", renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: ["teams", "activity"] } as const;
const usageDashboard = { kind: "usage", renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: ["usage"] } as const;
const teams = { status: "ready", updatedAt: 1_000, teamCount: 1, teams: [
  { id: "w1", name: "Synthetic team", agentCount: 1, activeAgentCount: 1, agents: [
    { id: "w1:p1", name: "Pine", kind: "codex", role: "Developer", model: "model-a", reasoningEffort: "high",
      contextUsed: 100, contextWindow: 1_000, state: "working", taskHint: "Synthetic task" },
  ] },
] };
const usageFor = (value: number): LocalUsageResponse => {
  const blank = { prs: 0, knownPrs: 0, commits: 0 };
  const comparison = { startDay: "2026-10-31", endDay: "2026-11-06", missingDays: [], unavailableTokenDays: [],
    prs: null, commits: null, totalTokens: null,
    categories: { work: { prs: null, commits: null }, personal: { prs: null, commits: null }, unclassified: { prs: null, commits: null } } };
  const window = (days: 1 | 7 | 30) => ({ days, startDay: days === 1 ? "2026-11-07" : days === 7 ? "2026-11-01" : "2026-10-09",
    endDay: "2026-11-07", asOf: Date.UTC(2026, 10, 7, 8), coverage: "ready" as const, tokenCoverage: "ready" as const,
    missingDays: [], unavailableTokenDays: [], prs: value * days, knownPrs: value * days, commits: value * days,
    newTokens: value * days, cacheRead: 0, totalTokens: value * days, comparison,
    categories: { work: { prs: value * days, knownPrs: value * days, commits: value * days }, personal: blank, unclassified: blank },
    repositories: { sharedCommits: 0, coverage: "ready" as const, unattributedPrs: 0, unattributedCommits: 0, rows: [] } });
  return withMergedUsageFixture({ status: "ready", asOf: Date.UTC(2026, 10, 7, 8), timeZone: "Asia/Shanghai",
    sourceCoverage: { total: 1, ready: 1, partial: 0, stale: 0, missing: 0 },
    prSourceCoverage: { total: 1, ready: 1, stale: 0, unavailable: 0, missing: 0 },
    prCoverage: { work: "ready", personal: "ready", unclassified: "ready" },
    windows: { "1": window(1), "7": window(7), "30": window(30) }, trend: [] });
};

const app = (id: string, title: string): MiniAppSummary => ({
  id, slug: id, title, description: `${title} description`, status: "active", revision: 3, templateVersion: 2,
  publisherBotIds: [], createdAt: 1_000, updatedAt: 2_000,
});
const shippedDefaults = (): MiniAppSummary[] => [
  { ...app("bookkeeping", "记账管家"), slug: "bookkeeping", shippedTemplateKind: "bookkeeping" },
  { ...app("x_digest", "Daily X AI digest"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" },
  { ...app("github", "GitHub activity"), slug: "github-activity", shippedTemplateKind: "github_activity" },
  { ...app("team", "Agent Team"), slug: "agent-team", dashboardIdentity: "agent-team", dashboard },
  { ...app("usage", "Usage"), slug: "usage", dashboardIdentity: "usage", dashboard: usageDashboard },
];

let root: Root;
let host: HTMLDivElement;
let stored: Map<string, string>;
const frame = () => host.querySelector<HTMLElement>('[data-testid="fixture-frame"]');
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const refresh = () => host.querySelector<HTMLButtonElement>('[aria-label="Check for updates"], [aria-label="检查更新"]')!;
const selected = () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
const settle = async () => { await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-apps-panel"]')).not.toBeNull()); };
const render = async () => {
  await act(async () => { root.render(createElement(MiniAppsPanel)); });
  await settle();
};

beforeEach(() => {
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  stored = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
  fixture.apps = [app("app_a", "First report"), app("app_b", "Second report")];
  fixture.defaultApps = null;
  fixture.defaultCalls = [];
  fixture.defaultIssues = [];
  fixture.stateRevision = 3;
  fixture.dataRevision = 7;
  fixture.failState = false;
  fixture.failDocument = false;
  fixture.denied = false;
  fixture.frameMounts = 0;
  fixture.dashboardReads = [];
  fixture.bots = [];
  fixture.owner = true;
  fixture.visible = true;
  fixture.usageValue = 1;
  fixture.usageDeferred = null;
  fixture.dispatch.mockReset();
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/.well-known/openmausbot/environment") return { environmentId: "fixture-environment" };
    if (path === "/api/mini-apps/defaults" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { restore?: string; bookkeepingHtml: string };
      fixture.defaultCalls.push(body);
      if (!body.restore && fixture.defaultApps) for (const candidate of fixture.defaultApps) {
        if (!fixture.apps.some((entry) => entry.dashboardIdentity === candidate.dashboardIdentity && candidate.dashboardIdentity
          || entry.shippedTemplateKind === candidate.shippedTemplateKind && candidate.shippedTemplateKind)) fixture.apps.push(candidate);
      }
      if (body.restore) fixture.apps = fixture.apps.map((entry) => entry.dashboardIdentity === body.restore || entry.shippedTemplateKind === body.restore
        ? { ...entry, status: "active", revision: entry.revision + 1,
          dashboard: entry.dashboardIdentity === "agent-team" ? dashboard : entry.dashboardIdentity === "usage" ? usageDashboard : entry.dashboard }
        : entry);
      return { apps: fixture.apps, issues: fixture.defaultIssues };
    }
    if (path === "/api/mini-apps" && (!init?.method || init.method === "GET")) return { apps: fixture.apps };
    if (path.endsWith("/archive") && init?.method === "POST") {
      const id = path.split("/")[3]!;
      fixture.apps = fixture.apps.map((entry) => entry.id === id ? { ...entry, status: "archived", revision: entry.revision + 1, dashboard: null } : entry);
      return { app: fixture.apps.find((entry) => entry.id === id), replayed: false };
    }
    if (path.endsWith("/state")) {
      if (fixture.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
      if (fixture.failState) throw new Error("Fixture offline");
      const summary = fixture.apps.find((entry) => entry.id === path.split("/")[3]);
      return { appId: path.split("/")[3], revision: summary?.revision ?? fixture.stateRevision, templateVersion: summary?.templateVersion ?? 2, status: summary?.status ?? "active",
        data: summary?.dashboardIdentity ? [] : [{ datasetId: "dataset_demo", revision: fixture.dataRevision }] };
    }
    if (path.endsWith("/dashboard") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { resource: string };
      fixture.dashboardReads.push(body.resource);
      const summary = fixture.apps.find((entry) => entry.id === path.split("/")[3]);
      return { appId: path.split("/")[3], revision: summary?.revision ?? fixture.stateRevision, resource: body.resource,
        snapshot: body.resource === "teams" ? teams : body.resource === "usage"
          ? fixture.usageDeferred ? await fixture.usageDeferred : usageFor(fixture.usageValue)
          : { agentId: "w1:p1", status: "ready", updatedAt: 1_000,
          truncated: false, events: [{ id: "e1", kind: "assistant", at: null, tool: null, text: "Synthetic recent reply" }] } };
    }
    if (path.endsWith("/rollback") && init?.method === "POST") {
      fixture.stateRevision += 1;
      fixture.apps = fixture.apps.map((entry) => ({ ...entry, revision: fixture.stateRevision }));
      return { app: fixture.apps[0], replayed: false };
    }
    if (path.startsWith("/api/mini-apps/")) {
      if (fixture.failDocument) throw new Error("Fixture document offline");
      const id = path.split("/")[3]!;
      const summary = fixture.apps.find((entry) => entry.id === id)!;
      return { app: summary, html: "<p>Fixture</p>", bindings: [], versions: [{ version: 1, title: "Older", createdAt: 1_000 }, { version: 2, title: "Current", createdAt: 2_000 }] };
    }
    throw new Error(`Unexpected API path: ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { root.unmount(); host.remove(); vi.unstubAllGlobals(); setLocale("en"); });

describe("Mini Apps panel", () => {
  it("restores the selected app for this local environment and keeps keyboard navigation inside the app strip", async () => {
    stored.set("omb-mini-app:fixture-environment", "app_b");
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
    expect(selected()?.textContent).toBe("Second report");
    const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true });
    await act(async () => { selected()!.dispatchEvent(event); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    expect(document.activeElement?.textContent).toBe("First report");
    expect(stored.get("omb-mini-app:fixture-environment")).toBe("app_a");
  });

  it("removes the version status row while stale data remains marked and refreshable", async () => {
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("7"));
    expect(host.querySelector('[data-testid="mini-app-freshness"]')).toBeNull();
    expect(host.textContent).not.toContain("Current app version");
    expect(host.textContent).toContain("App updated");
    fixture.dataRevision = 8;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("8"));
    fixture.failState = true;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.textContent).toContain("Showing the last loaded version"));
    expect(frame()?.dataset.dataRevision).toBe("8");
    fixture.failState = false;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.textContent).not.toContain("Showing the last loaded version"));
    expect(frame()?.dataset.dataRevision).toBe("8");
  });

  it("shows version history and sends a generic rollback with the installed revision", async () => {
    await render();
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.startsWith("Version 1"))!.click(); });
    const call = fixture.api.mock.calls.find(([path]) => path === "/api/mini-apps/app_a/rollback");
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toMatchObject({ expectedRevision: 3, templateVersion: 1 });
  });

  it("registers five persisted defaults on opening without another install click", async () => {
    fixture.apps = [];
    fixture.defaultApps = shippedDefaults();
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(5));
    expect(fixture.defaultCalls).toHaveLength(1);
    expect(fixture.defaultCalls[0]?.restore).toBeUndefined();
    expect(fixture.defaultCalls[0]?.bookkeepingHtml.length).toBeGreaterThan(100);
    expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [data-mini-app-icon]')).toHaveLength(5);
    expect(host.textContent).toContain("Work Tracker");
    expect(host.textContent).not.toContain("Explore included apps");
    expect(host.textContent).not.toContain("0 installed");
    expect(host.textContent).not.toContain("The original Agent Team and Usage Computer tabs remain available.");
    expect(fixture.api.mock.calls.some(([path, init]) => path === "/api/mini-apps" && init?.method === "POST")).toBe(false);
  });

  it("keeps a removed default archived on reopen and adds the same app id only after a click", async () => {
    fixture.apps = shippedDefaults();
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(5));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-remove="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(4));
    expect(fixture.apps.find((entry) => entry.id === "team")?.status).toBe("archived");
    expect(fixture.defaultCalls).toHaveLength(1);
    await act(async () => { root.render(null); });
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(4));
    expect(fixture.apps.find((entry) => entry.id === "team")?.status).toBe("archived");
    await act(async () => { button("Add Mini App").click(); });
    expect(host.querySelector('[data-mini-app-catalog="agent-team"]')?.getAttribute("data-mini-app-state")).toBe("removed");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(5));
    expect(selected()?.dataset.appId).toBe("team");
    expect(fixture.defaultCalls.at(-1)?.restore).toBe("agent-team");
    expect(fixture.apps.find((entry) => entry.id === "team")?.status).toBe("active");
  });

  it("uses explicit Add to repair a revoked native grant on the same id without an HTML frame", async () => {
    fixture.apps = [{ ...app("old_team", "Agent Team"), slug: "agent-team",
      dashboardIdentity: "agent-team", dashboard: null }];
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-recovery"]')).not.toBeNull());
    expect(frame()).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    expect(host.querySelector('[data-mini-app-catalog="agent-team"]')?.getAttribute("data-mini-app-state")).toBe("needs-access");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-team-house]')).not.toBeNull());
    expect(selected()?.dataset.appId).toBe("old_team");
    expect(fixture.defaultCalls.at(-1)?.restore).toBe("agent-team");
    expect(fixture.frameMounts).toBe(0);
  });

  it("keeps Remove available after native read revocation and restores only after Add", async () => {
    fixture.apps = [{ ...app("revoked_team", "Agent Team"), slug: "agent-team",
      dashboardIdentity: "agent-team", dashboard: null }];
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-recovery"]')).not.toBeNull());
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    expect(host.querySelector('[data-mini-app-catalog="agent-team"]')?.getAttribute("data-mini-app-state")).toBe("needs-access");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-remove="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(fixture.apps[0]?.status).toBe("archived"));
    expect(host.querySelector('[data-mini-app-catalog="agent-team"]')?.getAttribute("data-mini-app-state")).toBe("removed");
    expect(fixture.defaultCalls).toHaveLength(1);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(fixture.apps[0]?.dashboard?.kind).toBe("agent-team"));
    expect(fixture.apps[0]?.id).toBe("revoked_team");
    expect(fixture.defaultCalls.at(-1)?.restore).toBe("agent-team");
    expect(fixture.frameMounts).toBe(0);
  });

  it("keeps a custom slug occupant separate from the included app identity", async () => {
    fixture.apps = [{ ...app("custom", "My own report"), slug: "x-ai-digest", shippedTemplateKind: null },
      { ...app("included", "Daily X AI digest"), slug: "x-ai-digest-included-1", shippedTemplateKind: "x_ai_digest" }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("custom"));
    expect(selected()?.querySelector('[data-mini-app-icon="custom"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    expect(host.querySelector('[data-mini-app-catalog="x_ai_digest"]')?.getAttribute("data-mini-app-state")).toBe("active");
    expect(host.querySelector('[data-mini-app-custom="custom"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="x_ai_digest"]')!.click(); });
    await vi.waitFor(() => expect(selected()?.dataset.appId).toBe("included"));
  });

  it("keeps a provenance-marked report recognizable after its HTML is edited", async () => {
    fixture.apps = [{ ...app("edited_report", "My edited digest"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("edited_report"));
    expect(selected()?.querySelector('[data-mini-app-icon="x_ai_digest"]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    expect(host.querySelector('[data-mini-app-catalog="x_ai_digest"]')?.getAttribute("data-mini-app-state")).toBe("active");
  });

  it("anchors a nonmodal icon grid to All apps and returns focus on Escape", async () => {
    await render();
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    const trigger = host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!;
    expect(host.querySelector('[role="tablist"]')?.contains(trigger)).toBe(false);
    trigger.focus();
    await act(async () => { trigger.click(); });
    const popover = host.querySelector<HTMLElement>('[data-mini-app-popover]')!;
    expect(popover).not.toBeNull();
    expect(trigger.parentElement?.contains(popover)).toBe(true);
    expect(popover.getAttribute("aria-modal")).toBe("false");
    expect(popover.querySelectorAll('[data-mini-app-catalog]')).toHaveLength(5);
    expect(document.activeElement?.getAttribute("data-mini-app-grid-item")).toBe("bookkeeping");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(host.querySelector('[data-mini-app-popover]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("reveals the selected chip on keyboard choice and panel resize", async () => {
    let resize!: ResizeObserverCallback;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    await render();
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    const row = host.querySelector<HTMLDivElement>('[role="tablist"]')!;
    const tabs = [...row.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    let selectedRight = 220;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 0, right: 100 } as DOMRect);
    vi.spyOn(tabs[1]!, "getBoundingClientRect").mockImplementation(() => ({ left: 120, right: selectedRight }) as DOMRect);
    await act(async () => { tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); });
    expect(selected()?.dataset.appId).toBe("app_b");
    expect(document.activeElement).toBe(tabs[1]);
    expect(row.scrollLeft).toBe(120);
    row.scrollLeft = 0;
    selectedRight = 250;
    await act(async () => resize([], {} as ResizeObserver));
    expect(row.scrollLeft).toBe(150);
  });

  it("shows the anchored grid without automatic registration or add actions when owner access is denied", async () => {
    fixture.apps = [];
    fixture.owner = false;
    await render();
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[data-mini-app-all]')).not.toBeNull());
    expect(fixture.defaultCalls).toHaveLength(0);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    const popover = host.querySelector<HTMLElement>('[data-mini-app-popover]')!;
    expect(popover.querySelectorAll('[data-mini-app-catalog]')).toHaveLength(5);
    expect([...popover.querySelectorAll<HTMLButtonElement>('[data-mini-app-grid-item]')].every((item) => item.disabled)).toBe(true);
    expect(fixture.api.mock.calls.some(([path, init]) => path === "/api/mini-apps" && init?.method === "POST")).toBe(false);
  });

  it("shows a real default-binding issue in the grid without claiming data was installed", async () => {
    fixture.apps = shippedDefaults();
    fixture.defaultIssues = [{ kind: "bookkeeping", error: "More than one existing ledger matches." }];
    await render();
    await vi.waitFor(() => expect(selected()).not.toBeNull());
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    const tile = host.querySelector<HTMLElement>('[data-mini-app-catalog="bookkeeping"]')!;
    expect(tile.textContent).toContain("More than one existing ledger matches.");
    expect(fixture.defaultCalls).toHaveLength(1);
    expect(fixture.defaultCalls[0]?.restore).toBeUndefined();
  });

  it("labels the native Usage Mini App Work Tracker in English and Chinese while keeping its id", async () => {
    fixture.apps = [{ ...app("usage", "Usage"), slug: "usage", description: "Your work, contributions and agent activity.",
      dashboardIdentity: "usage", dashboard: usageDashboard }];
    await render();
    await vi.waitFor(() => expect(selected()?.dataset.appId).toBe("usage"));
    expect(selected()?.textContent).toBe("Work Tracker");
    await loadLocale("zh");
    setLocale("zh");
    await act(async () => { root.render(createElement(MiniAppsPanel)); });
    expect(selected()?.textContent).toBe("工作追踪");
    expect(selected()?.dataset.appId).toBe("usage");
    expect(host.textContent).toContain("查看你的工作、产出和 Agent 活动。");
    fixture.apps = [{ ...fixture.apps[0]!, description: "Owner-edited description" }];
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.textContent).toContain("Owner-edited description"));
  });

  it("replaces a same-revision revoked dashboard with explicit same-id repair and no fallback frame", async () => {
    const installedApp = { ...app("app_team", "Agent Team"), slug: "agent-team", dashboardIdentity: "agent-team" as const,
      dashboard, publisherBotIds: ["editor"] };
    fixture.apps = [installedApp];
    fixture.bots = [{ id: "editor" }];
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll("[data-team-house]")).toHaveLength(1));
    expect(frame()).toBeNull();
    expect(host.textContent).not.toContain("Open publisher chat");
    const selectedTab = selected();
    fixture.apps = [{ ...installedApp, dashboard: null }];
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-recovery"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Synthetic team");
    expect(frame()).toBeNull();
    expect(selected()).toBe(selectedTab);

    await act(async () => button("Reauthorize app").click());
    await vi.waitFor(() => expect(host.querySelectorAll("[data-team-house]")).toHaveLength(1));
    expect(fixture.defaultCalls.at(-1)?.restore).toBe("agent-team");
    expect(fixture.api.mock.calls.some(([path, init]) => String(path).endsWith("/publish") && init?.method === "POST")).toBe(false);
    expect(selected()?.dataset.appId).toBe("app_team");
    expect(document.activeElement).toBe(selected());
  });

  it("keeps a revoked built-in out of the HTML frame while a newer state or document fails to load", async () => {
    const restored = { ...app("app_team", "Agent Team"), slug: "agent-team", dashboardIdentity: "agent-team" as const, dashboard: null };
    fixture.apps = [restored];
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-recovery"]')).not.toBeNull());
    expect(fixture.frameMounts).toBe(0);

    fixture.apps = [{ ...restored, revision: 4 }];
    fixture.stateRevision = 4;
    fixture.failState = true;
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.textContent).toContain("Fixture offline"));
    expect(fixture.frameMounts).toBe(0);
    expect(frame()).toBeNull();

    fixture.failState = false;
    fixture.failDocument = true;
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.textContent).toContain("Fixture document offline"));
    expect(fixture.frameMounts).toBe(0);
    expect(frame()).toBeNull();

    fixture.failDocument = false;
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-recovery"]')).not.toBeNull());
    expect(fixture.frameMounts).toBe(0);
  });

  it("refreshes a same-revision Usage snapshot immediately, cancelling the old read and staying quiet while hidden", async () => {
    fixture.apps = [{ ...app("app_usage", "Usage"), slug: "usage", dashboardIdentity: "usage", dashboard: usageDashboard }];
    await render();
    const value = () => host.querySelector('[data-testid="local-usage-panel"] section dd > span')?.textContent;
    await vi.waitFor(() => expect(value()).toBe("1"));
    let finish!: (snapshot: LocalUsageResponse) => void;
    fixture.usageDeferred = new Promise((resolve) => { finish = resolve; });
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(fixture.dashboardReads).toEqual(["usage", "usage"]));
    const pending = fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/dashboard")).at(-1)![1].signal as AbortSignal;
    fixture.usageDeferred = null;
    fixture.usageValue = 2;
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(value()).toBe("2"));
    expect(pending.aborted).toBe(true);
    await act(async () => finish(usageFor(99)));
    expect(value()).toBe("2");

    const reads = fixture.dashboardReads.length;
    fixture.visible = false;
    await act(async () => root.render(createElement(MiniAppsPanel)));
    await act(async () => refresh().click());
    expect(fixture.dashboardReads).toHaveLength(reads);
  });

  it("keeps archived apps out of the active navigation", async () => {
    fixture.apps = [app("app_a", "First report"), { ...app("app_b", "Old report"), status: "archived" }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    expect([...host.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual(["First report"]);
  });

  it("keeps owner inventory visible in a browser without mounting a frame or offering Data access", async () => {
    vi.stubGlobal("ogb", undefined);
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("First report"));
    expect(host.textContent).toContain("Open the desktop app to view or install Mini Apps.");
    expect(frame()).toBeNull();
    expect(host.textContent).not.toContain("Add Mini App");
    expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/query"))).toBe(false);
  });
});
