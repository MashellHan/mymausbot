// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadLocale, setLocale } from "@/lib/i18n";
import type { LocalUsageResponse } from "../../../shared/local-dashboard";
import { withGithubUsageFixture, withMergedUsageFixture } from "../../../scripts/testing/merged-usage-fixture";
import type { MiniAppDocument, MiniAppRollback, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { MINI_APP_RUNTIME_READY_TIMEOUT_MS, type MiniAppUpdateInfo, type MiniAppUpdateRequest } from "./mini-app-update";

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
  frameLifecycleMounts: [] as string[],
  dashboardReads: [] as string[],
  bots: [] as Array<{ id: string }>,
  owner: true as boolean,
  visible: true,
  usageValue: 1,
  usageDeferred: null as Promise<LocalUsageResponse> | null,
  mojoHtml: null as string | null,
  htmlByApp: {} as Record<string, string>,
  hongguoCatalogCard: false,
  hongguoCatalogTitle: "Cached drama",
  hongguoCatalogHold: null as Promise<void> | null,
  environmentId: "fixture-environment",
  environmentHold: null as Promise<void> | null,
  inventoryDenied: false,
  updateByApp: {} as Record<string, MiniAppUpdateInfo>,
  failUpdateCheck: false as boolean | Error,
  failUpdateApply: null as Error | null,
  updateDeferred: null as Promise<void> | null,
  updateRequests: [] as Array<{ appId: string; body: MiniAppUpdateRequest }>,
  onUpdateApply: null as ((appId: string, body: MiniAppUpdateRequest) => void) | null,
  suppressRuntimeReady: false,
  lastRuntimeReadyCallback: null as ((info: { appId: string; revision: number; templateVersion: number }) => void) | null,
  rollbackRequests: [] as Array<{ appId: string; body: MiniAppRollback }>,
  failRollback: null as Error | null,
  onRollback: null as ((appId: string, body: MiniAppRollback) => void) | null,
}));

vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
  useStore: () => ({ state: { bots: fixture.bots }, dispatch: fixture.dispatch }),
}));
vi.mock("@/state/api", () => ({ api: fixture.api }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => fixture.visible }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("./MiniAppFrame", () => ({ MiniAppFrame: ({ document, state, onRuntimeReady }: {
  document: MiniAppDocument;
  state: MiniAppState;
  onRuntimeReady?(info: { appId: string; revision: number; templateVersion: number }): void;
}) => {
  fixture.frameMounts += 1;
  fixture.lastRuntimeReadyCallback = onRuntimeReady ?? null;
  useLayoutEffect(() => {
    fixture.frameLifecycleMounts.push(`${document.app.id}@${document.app.templateVersion}:${document.html}`);
    if (!fixture.suppressRuntimeReady && (document.app as { release?: unknown }).release
      && document.app.status === "active" && state.status === "active") {
      onRuntimeReady?.({
        appId: document.app.id,
        revision: document.app.revision,
        templateVersion: document.app.templateVersion,
      });
    }
  }, [document.app.id, document.app.revision, document.app.templateVersion, document.html]);
  return createElement("div", { "data-testid": "fixture-frame", "data-id": document.app.id,
    "data-template-version": document.app.templateVersion, "data-html": document.html,
    "data-data-revision": state.data[0]?.revision });
} }));

import { ApiError } from "@/state/store";
import { MiniAppsPanel } from "./MiniAppsPanel";
import { MiniAppsHost, MiniAppsSlot } from "./MiniAppsHost";
import { HongguoView, forgetHongguoHome } from "./HongguoView";
import { DAILY_X_APP_ID } from "./daily-x-host";
import { GITHUB_ACTIVITY_APP_ID } from "./github-activity-host";

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
  const snapshot = withGithubUsageFixture({ status: "ready", asOf: Date.UTC(2026, 10, 7, 8), timeZone: "Asia/Shanghai",
    sourceCoverage: { total: 1, ready: 1, partial: 0, stale: 0, missing: 0 },
    prSourceCoverage: { total: 1, ready: 1, stale: 0, unavailable: 0, missing: 0 },
    prCoverage: { work: "ready", personal: "ready", unclassified: "ready" },
    windows: { "1": window(1), "7": window(7), "30": window(30) }, trend: [] });
  return { ...snapshot, contributions: { ...withMergedUsageFixture(snapshot).merged!, metricDefinition: "contributions-v2",
    timeZone: "Asia/Shanghai", dateBasis: { github: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" },
      ado: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" }, tokens: "Asia/Shanghai" },
    cutoffAt: snapshot.asOf, capturedAt: snapshot.asOf, currentDayPartial: true, accounts: [], sourceDays: null } };
};

const app = (id: string, title: string): MiniAppSummary => ({
  id, slug: id, title, description: `${title} description`, status: "active", revision: 3, templateVersion: 2,
  publisherBotIds: [], createdAt: 1_000, updatedAt: 2_000,
});
const MOJO_ID = "01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7";
const MOJO_MARKER = '<meta name="openmausbot:mojo-view" content="quotes-v1">';
const shippedDefaults = (): MiniAppSummary[] => [
  { ...app("bookkeeping", "记账管家"), slug: "bookkeeping", shippedTemplateKind: "bookkeeping" },
  { ...app("x_digest", "Daily X AI digest"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" },
  { ...app("github", "GitHub activity"), slug: "github-activity", shippedTemplateKind: "github_activity" },
  { ...app("team", "Agent Team"), slug: "agent-team", dashboardIdentity: "agent-team", dashboard },
  { ...app("usage", "Usage"), slug: "usage", dashboardIdentity: "usage", dashboard: usageDashboard },
  { ...app("hongguo", "红果短剧"), slug: "hongguo", nativeIdentity: "hongguo", nativeKind: "hongguo" },
];

let root: Root;
let host: HTMLDivElement;
let stored: Map<string, string>;
const frame = () => host.querySelector<HTMLElement>('[data-testid="fixture-frame"]');
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const refresh = () => host.querySelector<HTMLButtonElement>('[aria-label="Check for updates"], [aria-label="检查更新"]')!;
const selected = () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
const settle = async () => { await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-apps-panel"]')).not.toBeNull()); };
const render = async (requestedApp?: { id: string; nonce: number }) => {
  await act(async () => { root.render(createElement<NonNullable<Parameters<typeof MiniAppsPanel>[0]>>(MiniAppsPanel, { requestedApp })); });
  await settle();
};

beforeEach(() => {
  forgetHongguoHome("omb-mini-app:fixture-environment");
  setLocale("en");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
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
  fixture.frameLifecycleMounts = [];
  fixture.dashboardReads = [];
  fixture.bots = [];
  fixture.owner = true;
  fixture.visible = true;
  fixture.usageValue = 1;
  fixture.usageDeferred = null;
  fixture.mojoHtml = null;
  fixture.htmlByApp = {};
  fixture.hongguoCatalogCard = false;
  fixture.hongguoCatalogTitle = "Cached drama";
  fixture.hongguoCatalogHold = null;
  fixture.environmentId = "fixture-environment";
  fixture.environmentHold = null;
  fixture.inventoryDenied = false;
  fixture.updateByApp = {};
  fixture.failUpdateCheck = false;
  fixture.failUpdateApply = null;
  fixture.updateDeferred = null;
  fixture.updateRequests = [];
  fixture.onUpdateApply = null;
  fixture.suppressRuntimeReady = false;
  fixture.lastRuntimeReadyCallback = null;
  fixture.rollbackRequests = [];
  fixture.failRollback = null;
  fixture.onRollback = null;
  fixture.dispatch.mockReset();
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith("/api/published-apps/framing?")) return { framing: "allowed" };
    if (path === "/.well-known/openmausbot/environment") {
      await fixture.environmentHold;
      return { environmentId: fixture.environmentId };
    }
    if (path === "/api/mini-apps/defaults" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { restore?: string; bookkeepingHtml: string };
      fixture.defaultCalls.push(body);
      if (!body.restore && fixture.defaultApps) for (const candidate of fixture.defaultApps) {
        if (!fixture.apps.some((entry) => entry.dashboardIdentity === candidate.dashboardIdentity && candidate.dashboardIdentity
          || entry.nativeIdentity === candidate.nativeIdentity && candidate.nativeIdentity
          || entry.shippedTemplateKind === candidate.shippedTemplateKind && candidate.shippedTemplateKind)) fixture.apps.push(candidate);
      }
      if (body.restore) fixture.apps = fixture.apps.map((entry) => entry.dashboardIdentity === body.restore || entry.nativeIdentity === body.restore || entry.shippedTemplateKind === body.restore
        ? { ...entry, status: "active", revision: entry.revision + 1,
          dashboard: entry.dashboardIdentity === "agent-team" ? dashboard : entry.dashboardIdentity === "usage" ? usageDashboard : entry.dashboard,
          nativeKind: entry.nativeIdentity === "hongguo" ? "hongguo" : entry.nativeKind }
        : entry);
      return { apps: fixture.apps, issues: fixture.defaultIssues };
    }
    if (path === "/api/mini-apps" && (!init?.method || init.method === "GET")) {
      if (fixture.inventoryDenied) throw new ApiError("Forbidden", 403);
      return { apps: fixture.apps };
    }
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
        data: summary?.dashboardIdentity || summary?.id === MOJO_ID ? [] : [{ datasetId: "dataset_demo", revision: fixture.dataRevision }] };
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
      const id = path.split("/")[3]!;
      const body = JSON.parse(String(init.body)) as MiniAppRollback;
      fixture.rollbackRequests.push({ appId: id, body });
      if (fixture.failRollback) throw fixture.failRollback;
      if (fixture.onRollback) {
        fixture.onRollback(id, body);
      } else {
        fixture.apps = fixture.apps.map((entry) => entry.id === id
          ? { ...entry, revision: entry.revision + 1, templateVersion: body.templateVersion }
          : entry);
      }
      return { app: fixture.apps.find((entry) => entry.id === id) ?? fixture.apps[0], replayed: false };
    }
    if (path.includes("/hongguo/")) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(String(init?.body)) as { mode?: string };
      if (path.endsWith("/catalog") && body.mode === "popular") await fixture.hongguoCatalogHold;
      return { appId: id, revision: fixture.apps.find((entry) => entry.id === id)?.revision ?? 3,
        entries: [], autoplayNext: true,
        items: fixture.hongguoCatalogCard && body.mode === "popular"
          ? [{ id: "cached-drama", title: fixture.hongguoCatalogTitle, coverUrl: null, summary: null, episodeCount: 1 }] : [],
        categories: [], nextCursor: null };
    }
    if (path.endsWith("/update") && (!init?.method || init.method === "GET")) {
      if (fixture.failUpdateCheck) {
        throw fixture.failUpdateCheck instanceof Error ? fixture.failUpdateCheck : new Error("Update check offline");
      }
      const id = path.split("/")[3]!;
      return fixture.updateByApp[id] ?? { installedVersion: null, status: "current", available: null };
    }
    if (path.endsWith("/update") && init?.method === "POST") {
      const id = path.split("/")[3]!;
      const body = JSON.parse(String(init.body)) as MiniAppUpdateRequest;
      fixture.updateRequests.push({ appId: id, body });
      await fixture.updateDeferred;
      if (fixture.failUpdateApply) throw fixture.failUpdateApply;
      if (fixture.onUpdateApply) {
        fixture.onUpdateApply(id, body);
      } else {
        fixture.apps = fixture.apps.map((entry) => entry.id === id
          ? {
              ...entry,
              revision: entry.revision + 1,
              templateVersion: entry.templateVersion + 1,
              updatedAt: entry.updatedAt + 1_000,
              release: {
                packageId: `mashellhan.${entry.slug}`,
                appVersion: body.appVersion,
                sourceCommit: body.sourceCommit,
                tag: `mini-app/${entry.slug}/v${body.appVersion}`,
                requires: [],
                htmlSha256: "0".repeat(64),
                htmlBytes: 12,
                queriesSha256: "1".repeat(64),
                queriesBytes: 2,
              },
            }
          : entry);
        fixture.updateByApp[id] = { installedVersion: body.appVersion, status: "current", available: null };
      }
      return { app: fixture.apps.find((entry) => entry.id === id)!, replayed: false };
    }
    if (path.startsWith("/api/mini-apps/")) {
      if (fixture.failDocument) throw new Error("Fixture document offline");
      const id = path.split("/")[3]!;
      const summary = fixture.apps.find((entry) => entry.id === id)!;
      return { app: summary, html: fixture.htmlByApp[id] ?? fixture.mojoHtml ?? "<p>Fixture</p>", bindings: [], versions: [{ version: 1, title: "Older", createdAt: 1_000 }, { version: 2, title: "Current", createdAt: 2_000 }] };
    }
    throw new Error(`Unexpected API path: ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setLocale("en"); });

describe("Mini Apps panel", () => {
  it("refreshes the same installed Agent Team frame after vB, rollback and revocation without a host restart", async () => {
    const htmlDashboard = { kind: "agent-team", renderer: "html", htmlRole: "primary", editableFields: ["title", "description"],
      resources: ["teams", "activity", "configuration", "team-rules", "skill"] } as const;
    const first = { ...app("app_team", "Agent Team"), slug: "agent-team", dashboardIdentity: "agent-team" as const,
      dashboard: htmlDashboard };
    fixture.apps = [first];
    fixture.mojoHtml = "<p>Reviewed vA</p>";
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.html).toBe("<p>Reviewed vA</p>"));
    expect(frame()?.dataset.id).toBe("app_team");
    fixture.apps = [{ ...first, revision: 4, templateVersion: 3 }];
    fixture.mojoHtml = "<p>Published vB</p>";
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(frame()?.dataset.html).toBe("<p>Published vB</p>"));
    expect(frame()?.dataset.templateVersion).toBe("3");
    fixture.apps = [{ ...first, revision: 5, templateVersion: 2 }];
    fixture.mojoHtml = "<p>Reviewed vA</p>";
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(frame()?.dataset.html).toBe("<p>Reviewed vA</p>"));
    fixture.apps = [{ ...first, revision: 6, dashboard: null }];
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-recovery"]')).not.toBeNull());
    expect(frame()).toBeNull();
    fixture.apps = [{ ...first, revision: 7, templateVersion: 1, dashboard }];
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="selected-agent-team"]')).not.toBeNull());
    expect(frame()).toBeNull();
  });
  it("opens the exact current Mojo quote document in the host and retires it on archive", async () => {
    fixture.apps = [app(MOJO_ID, "Mojo")];
    fixture.mojoHtml = `<html><head>${MOJO_MARKER}</head><body>Quotes</body></html>`;
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mojo-whole-page"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="fixture-frame"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="poetry-frame"]')).toBeNull();
    fixture.apps = [{ ...fixture.apps[0]!, status: "archived", revision: 4 }];
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mojo-whole-page"]')).toBeNull());
  });

  it("shows the existing Daily X website only while its local report head is current", async () => {
    fixture.apps = [{ ...app(DAILY_X_APP_ID, "Daily X"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" }];
    await render();
    await vi.waitFor(() => expect(host.querySelector<HTMLIFrameElement>("[data-daily-x-frame]")?.src).toBe("https://mxhan.com/x/"));
    expect(frame()).toBeNull();
    fixture.failState = true;
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector("[data-daily-x-frame]")).toBeNull());
    expect(frame()?.dataset.id).toBe(DAILY_X_APP_ID);
    fixture.failState = false;
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector("[data-daily-x-frame]")).not.toBeNull());
    fixture.apps = [{ ...fixture.apps[0]!, status: "archived", revision: 4 }];
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector("[data-daily-x-frame]")).toBeNull());
  });

  it("keeps copied and remote Daily X reports on the ordinary guarded document path", async () => {
    fixture.apps = [{ ...app("copied-daily-x", "Copied"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("copied-daily-x"));
    expect(host.querySelector("[data-daily-x-frame]")).toBeNull();
    await act(async () => root.render(null));
    fixture.apps = [{ ...app(DAILY_X_APP_ID, "Daily X"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" }];
    vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true },
      remoteClient: { active: true } });
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe(DAILY_X_APP_ID));
    expect(host.querySelector("[data-daily-x-frame]")).toBeNull();
    await act(async () => root.render(null));
    vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: false, blocksOpaqueFrameNavigation: true } });
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe(DAILY_X_APP_ID));
    expect(host.querySelector("[data-daily-x-frame]")).toBeNull();
  });

  it("keeps copied or missing markers on the ordinary Mini App path", async () => {
    fixture.apps = [app("copied-mojo", "Copied")];
    fixture.mojoHtml = `<html><head>${MOJO_MARKER}</head><body>Copied</body></html>`;
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("copied-mojo"));
    expect(host.querySelector('[data-testid="mojo-whole-page"]')).toBeNull();
    await act(async () => root.render(null));
    fixture.apps = [app(MOJO_ID, "Mojo")];
    fixture.mojoHtml = "<html><head></head><body>Old quote document</body></html>";
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe(MOJO_ID));
    expect(host.querySelector('[data-testid="mojo-whole-page"]')).toBeNull();
  });

  it.each([
    ["quotes", "inventory"], ["quotes", "state"], ["poetry", "inventory"], ["poetry", "state"],
  ] as const)("retires Mojo %s on a failed %s refresh and restores it after recovery", async (view, failure) => {
    fixture.apps = [app(MOJO_ID, "Mojo")];
    fixture.mojoHtml = `<html><head>${MOJO_MARKER}</head><body>Quotes</body></html>`;
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mojo-whole-page"]')).not.toBeNull());
    if (view === "poetry") {
      await act(async () => host.querySelector<HTMLButtonElement>('[data-mojo-tab="poetry"]')!.click());
      expect(host.querySelector<HTMLIFrameElement>('[data-app-preview-frame]')?.src).toBe("https://mao.hexly.ai/#poem=03");
    }
    if (failure === "inventory") fixture.api.mockRejectedValueOnce(new Error("Fixture inventory offline"));
    else fixture.failState = true;
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.textContent).toContain("Showing the last loaded version"));
    expect(host.querySelector('[data-testid="mojo-whole-page"]')).toBeNull();
    expect(host.querySelector('[data-mojo-tab="poetry"]')).toBeNull();
    expect(host.querySelector('[data-app-preview-frame]')).toBeNull();
    expect(frame()?.dataset.id).toBe(MOJO_ID);
    fixture.failState = false;
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mojo-whole-page"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Showing the last loaded version");
    expect(host.querySelector('[data-app-preview-frame]')).toBeNull();
    expect(frame()?.dataset.id).toBe(MOJO_ID);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-mojo-tab="poetry"]')!.click());
    expect(host.querySelector<HTMLIFrameElement>('[data-app-preview-frame]')?.src).toBe("https://mao.hexly.ai/#poem=03");
  });

  it("does not open the remote sibling for a paired desktop's owner-like UI state", async () => {
    fixture.apps = [app(MOJO_ID, "Mojo")];
    fixture.mojoHtml = `<html><head>${MOJO_MARKER}</head><body>Quotes</body></html>`;
    vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true },
      remoteClient: { active: true } });
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe(MOJO_ID));
    expect(host.querySelector('[data-testid="mojo-whole-page"]')).toBeNull();
  });

  it("keeps Mojo in the custom library with a centered selected title and a separate info target", async () => {
    const mojo = { ...app("01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7", "Mojo"), slug: "mojo" };
    fixture.apps = [mojo, app("other", "A deliberately long title")];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe(mojo.id));
    expect(selected()?.querySelector('[data-mini-app-icon="mojo"]')).not.toBeNull();
    expect(selected()?.querySelector(".line-clamp-2")?.classList.contains("pr-6")).toBe(false);
    const hint = host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!;
    expect(hint.classList.contains("top-1")).toBe(true);
    await act(async () => hint.click());
    expect(document.querySelector('[data-info-hint-content]')).not.toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-app-id="other"]')!.click(); });
    expect(selected()?.querySelector(".line-clamp-2")?.classList.contains("pr-6")).toBe(false);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    expect(host.querySelector('[data-mini-app-custom="01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7"] [data-mini-app-icon="mojo"]')).not.toBeNull();
    expect(host.querySelector('[data-mini-app-catalog="mojo"]')).not.toBeNull();
    expect(host.querySelector('[data-mini-app-custom="other"] [data-mini-app-icon="custom"]')).not.toBeNull();
  });

  it("keeps the current app visible when its icon is selected again", async () => {
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    const currentFrame = frame();
    const stateReads = fixture.api.mock.calls.filter(([path]) => path === "/api/mini-apps/app_a/state").length;
    await act(async () => { selected()!.click(); });
    expect(frame()).toBe(currentFrame);
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/mini-apps/app_a/state")).toHaveLength(stateReads);
  });

  it("opens a suggested installed app over the saved app without locking later choices", async () => {
    stored.set("omb-mini-app:fixture-environment", "app_a");
    await render({ id: "app_b", nonce: 1 });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
    expect(stored.get("omb-mini-app:fixture-environment")).toBe("app_b");
    await act(async () => { button("First report").click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(selected()?.dataset.appId).toBe("app_a"));
  });

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

  it("expands the horizontal app bar by default, collapses it with a compact current-app summary, and remembers the last state", async () => {
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    const toggle = () => host.querySelector<HTMLButtonElement>('[data-mini-app-bar-toggle]')!;
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe("Collapse app bar");
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(host.querySelector('[data-mini-app-collapsed-current]')).toBeNull();

    await act(async () => { toggle().click(); });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Expand app bar");
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('[data-mini-app-collapsed-current]')?.textContent).toBe("First report");
    expect(host.querySelector('[data-mini-app-all]')).not.toBeNull();
    expect(stored.get("omb-mini-apps-bar-collapsed")).toBe("1");
    expect(stored.get("omb-mini-app:fixture-environment:bar-collapsed")).toBe("1");

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="app_b"]')!.click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
    expect(host.querySelector('[data-mini-app-collapsed-current]')?.textContent).toBe("Second report");

    await act(async () => { root.render(null); });
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    expect(host.querySelector('[data-mini-app-collapsed-current]')?.textContent).toBe("Second report");

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-collapsed-current]')!.click(); });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="tablist"]')).not.toBeNull();
    expect(stored.get("omb-mini-apps-bar-collapsed")).toBe("0");
    expect(stored.get("omb-mini-app:fixture-environment:bar-collapsed")).toBe("0");
  });

  it("removes the version status row while stale data remains marked and refreshable", async () => {
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("7"));
    expect(host.querySelector('[data-testid="mini-app-freshness"]')).toBeNull();
    expect(host.textContent).not.toContain("Current app version");
    expect(host.textContent).not.toContain("App updated");
    expect(host.textContent).not.toContain("First report description");
    const info = host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!;
    expect(selected()?.contains(info)).toBe(false);
    await act(async () => info.click());
    expect(document.querySelector('[data-info-hint-content]')?.textContent).toContain("First report description");
    expect(document.querySelector('[data-info-hint-content]')?.textContent).toContain("App updated");
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
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

  it("ends the menu after app cards for a publisher-owned multi-version app", async () => {
    fixture.apps[0] = { ...fixture.apps[0]!, publisherBotIds: ["editor"] };
    fixture.bots = [{ id: "editor" }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click());
    const menu = host.querySelector<HTMLElement>('[data-mini-app-popover]')!;
    expect(menu.children).toHaveLength(1);
    expect(menu.firstElementChild?.hasAttribute("data-mini-app-library")).toBe(true);
    expect(menu.textContent).toContain("Other apps");
    expect(menu.querySelector('[data-mini-app-custom="app_a"]')).not.toBeNull();
    expect(menu.querySelector('[data-mini-app-custom="app_b"]')).not.toBeNull();
    expect(menu.textContent).not.toContain("Open publisher chat");
    expect(menu.textContent).not.toContain("Version history");
    expect(menu.querySelector("details, summary")).toBeNull();
    await act(async () => { menu.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="app_b"]')!.click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click());
    const switchedMenu = host.querySelector<HTMLElement>('[data-mini-app-popover]')!;
    expect(switchedMenu.children).toHaveLength(1);
    await act(async () => { switchedMenu.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="app_a"]')!.click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    expect(fixture.apps[0]?.publisherBotIds).toEqual(["editor"]);
    expect(fixture.apps[0]?.revision).toBe(3);
    expect(fixture.apps[0]?.templateVersion).toBe(2);
    expect(fixture.api.mock.calls.some(([path]) => path === "/api/mini-apps/app_a/rollback")).toBe(false);
  });

  it("registers six persisted defaults on opening without another install click", async () => {
    fixture.apps = [];
    fixture.defaultApps = shippedDefaults();
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(6));
    expect(fixture.defaultCalls).toHaveLength(1);
    expect(fixture.defaultCalls[0]?.restore).toBeUndefined();
    expect(fixture.defaultCalls[0]?.bookkeepingHtml.length).toBeGreaterThan(100);
    expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [data-mini-app-icon]')).toHaveLength(6);
    expect(host.textContent).toContain("Activities");
    expect(host.textContent).not.toContain("Explore included apps");
    expect(host.textContent).not.toContain("0 installed");
    expect(host.textContent).not.toContain("The original Agent Team and Usage Computer tabs remain available.");
    expect(fixture.api.mock.calls.some(([path, init]) => path === "/api/mini-apps" && init?.method === "POST")).toBe(false);
  });

  it("opens Hongguo only with its native grant and restores that grant on the same app", async () => {
    fixture.apps = [shippedDefaults().at(-1)!];
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-view"]')).not.toBeNull());
    expect(fixture.frameMounts).toBe(0);
    fixture.apps = fixture.apps.map((entry) => ({ ...entry, nativeKind: null }));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-recovery"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="hongguo-view"]')).toBeNull();
    expect(fixture.frameMounts).toBe(0);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="hongguo-recovery"] button')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-view"]')).not.toBeNull());
    expect(fixture.defaultCalls.at(-1)?.restore).toBe("hongguo");
    expect(fixture.apps[0]?.id).toBe("hongguo");
    expect(fixture.frameMounts).toBe(0);
  });

  it("drops Hongguo home cards after same-revision native grant loss before restored data arrives", async () => {
    fixture.apps = [shippedDefaults().at(-1)!];
    fixture.hongguoCatalogCard = true;
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("Cached drama"));
    fixture.apps = fixture.apps.map((entry) => ({ ...entry, nativeKind: null }));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-recovery"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Cached drama");
    let release!: () => void;
    fixture.hongguoCatalogHold = new Promise<void>((resolve) => { release = resolve; });
    fixture.hongguoCatalogTitle = "Restored drama";
    fixture.apps = fixture.apps.map((entry) => ({ ...entry, nativeKind: "hongguo" }));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-view"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Cached drama");
    expect(host.textContent).not.toContain("Restored drama");
    await act(async () => { release(); });
    await vi.waitFor(() => expect(host.textContent).toContain("Restored drama"));
  });

  it("discards cached Hongguo cards after parent inventory denial", async () => {
    fixture.apps = [shippedDefaults().at(-1)!];
    fixture.hongguoCatalogCard = true;
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("Cached drama"));
    fixture.inventoryDenied = true;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-view"]')).toBeNull());
    fixture.inventoryDenied = false;
    fixture.hongguoCatalogTitle = "Restored drama";
    let release!: () => void;
    fixture.hongguoCatalogHold = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-view"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Cached drama");
    await act(async () => { release(); });
    await vi.waitFor(() => expect(host.textContent).toContain("Restored drama"));
  });

  it("evicts the resolved environment cache on an automatic grant-loss poll even when state fails", async () => {
    const polls: Array<() => Promise<void>> = [];
    const actualSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) => {
      if (timeout === 15_000 && typeof handler === "function") {
        polls.push(async () => { await handler(...args); });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return actualSetTimeout(handler, timeout, ...args);
    });
    let releaseEnvironment!: () => void;
    fixture.environmentHold = new Promise<void>((resolve) => { releaseEnvironment = resolve; });
    fixture.apps = [shippedDefaults().at(-1)!];
    fixture.hongguoCatalogCard = true;
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("Cached drama"));
    await act(async () => { releaseEnvironment(); });
    const popularCalls = () => fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/hongguo/catalog")
      && JSON.parse(String(init?.body)).mode === "popular").length;
    await vi.waitFor(() => expect(popularCalls()).toBe(2));
    const probeHost = document.createElement("div");
    document.body.append(probeHost);
    const probe = createRoot(probeHost);
    try {
      await act(async () => { probe.render(createElement(HongguoView, {
        document: { app: fixture.apps[0]!, html: "", bindings: [], versions: [] },
        state: { appId: "hongguo", revision: 3, templateVersion: 2, status: "active", data: [] },
        storageKey: "omb-mini-app:fixture-environment", refreshKey: 0, onRevoked: vi.fn(), onChanged: vi.fn(),
      })); });
      expect(probeHost.textContent).toContain("Cached drama");
    } finally { await act(async () => { probe.unmount(); }); probeHost.remove(); }
    fixture.apps = fixture.apps.map((entry) => ({ ...entry, nativeKind: null }));
    fixture.failState = true;
    await act(async () => { await polls.at(-1)!(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-view"]')).toBeNull());
    fixture.apps = fixture.apps.map((entry) => ({ ...entry, nativeKind: "hongguo" }));
    fixture.failState = false;
    fixture.hongguoCatalogTitle = "Restored drama";
    let releaseCatalog!: () => void;
    fixture.hongguoCatalogHold = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    await act(async () => { await polls.at(-1)!(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="hongguo-view"]')).not.toBeNull());
    expect(host.textContent).not.toContain("Cached drama");
    await act(async () => { releaseCatalog(); });
    await vi.waitFor(() => expect(host.textContent).toContain("Restored drama"));
  });

  it("keeps a removed default archived on reopen and adds the same app id only after a click", async () => {
    fixture.apps = shippedDefaults();
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(6));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-remove="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(5));
    expect(fixture.apps.find((entry) => entry.id === "team")?.status).toBe("archived");
    expect(fixture.defaultCalls).toHaveLength(1);
    await act(async () => { root.render(null); });
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(5));
    expect(fixture.apps.find((entry) => entry.id === "team")?.status).toBe("archived");
    await act(async () => { button("Add Mini App").click(); });
    expect(host.querySelector('[data-mini-app-catalog="agent-team"]')?.getAttribute("data-mini-app-state")).toBe("removed");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-grid-item="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="mini-apps-panel"] [role="tab"]')).toHaveLength(6));
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
    expect(popover.querySelectorAll('[data-mini-app-catalog]')).toHaveLength(7);
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
    expect(popover.querySelectorAll('[data-mini-app-catalog]')).toHaveLength(7);
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

  it.each(["Usage", "用量", "Work Tracker", "工作追踪", "Activities"])("labels the default %s Mini App Activities in both locales while keeping its id", async (title) => {
    fixture.apps = [{ ...app("usage", title), slug: "usage", description: "Your work, contributions and agent activity.",
      dashboardIdentity: "usage", dashboard: usageDashboard }];
    await render();
    await vi.waitFor(() => expect(selected()?.dataset.appId).toBe("usage"));
    expect(selected()?.textContent).toBe("Activities");
    await loadLocale("zh");
    setLocale("zh");
    await act(async () => { root.render(createElement(MiniAppsPanel)); });
    expect(selected()?.textContent).toBe("Activities");
    expect(selected()?.dataset.appId).toBe("usage");
    expect(host.textContent).not.toContain("查看你的工作、产出和 Agent 活动。");
    await act(async () => host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!.click());
    expect(document.querySelector('[data-info-hint-content]')?.textContent).toContain("查看你的工作、产出和 Agent 活动。");
    fixture.apps = [{ ...fixture.apps[0]!, description: "Owner-edited description" }];
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-info-hint-content]')?.textContent).toContain("Owner-edited description"));
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

  it("mounts managed Activities in an owner frame and keeps the native fallback and grant recovery", async () => {
    const usage = { ...app("app_usage", "Activities"), slug: "usage", dashboardIdentity: "usage" as const };
    const managedUsage = { ...usageDashboard, renderer: "html" as const, htmlRole: "primary" as const };
    fixture.apps = [{ ...usage, dashboard: managedUsage }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_usage"));
    expect(host.querySelector('[data-testid="local-usage-panel"]')).toBeNull();
    expect(fixture.dashboardReads).toEqual([]);

    fixture.apps = [{ ...usage, dashboard: null, revision: 4 }];
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-recovery"]')).not.toBeNull());
    expect(frame()).toBeNull();

    fixture.apps = [{ ...usage, dashboard: usageDashboard, revision: 5 }];
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => refresh().click());
    await vi.waitFor(() => expect(host.querySelector('[data-testid="local-usage-panel"] section dd > span')?.textContent).toBe("1"));
    expect(frame()).toBeNull();
    expect(fixture.dashboardReads).toEqual(["usage"]);
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


it("opens first requests from different Bot panels and preserves manual selection on reattach", async () => {
  const first = { id: "app_a", nonce: 1 };
  const second = { id: "app_b", nonce: 1 };
  const mount = async (bot: string, requestedApp: typeof first, attached = true) => {
    await act(async () => root.render(createElement(MiniAppsHost, { enabled: true,
      children: attached ? createElement(MiniAppsSlot, { key: bot, requestedApp }) : null })));
    await settle();
  };
  await mount("first", first);
  await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
  await mount("second", second);
  await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
  await act(async () => { button("First report").click(); });
  await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
  await mount("second", second, false);
  await mount("second", second);
  expect(frame()?.dataset.id).toBe("app_a");
});


it("restores the manual app choice after closing instead of replaying an old launch request", async () => {
  const mount = async (enabled: boolean, requestedApp?: { id: string; nonce: number }) => {
    await act(async () => root.render(createElement(MiniAppsHost, { enabled,
      children: enabled ? createElement(MiniAppsSlot, { requestedApp }) : null })));
  };
  await mount(true, { id: "app_a", nonce: 1 });
  await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
  await act(async () => { button("Second report").click(); });
  await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
  await mount(false);
  expect(frame()).toBeNull();
  await mount(true);
  await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
});

it("mounts GitHubActivityWholePage only when the current local github-activity app is eligible", async () => {
  fixture.apps = [{
    id: GITHUB_ACTIVITY_APP_ID,
    slug: "github-activity",
    title: "Github Rending",
    description: "",
    status: "active",
    revision: 3,
    templateVersion: 1,
    shippedTemplateKind: "github_activity",
    publisherBotIds: [],
    createdAt: 1,
    updatedAt: 1,
  }];
  await render();
  await vi.waitFor(() => expect(host.querySelector('[data-testid="github-activity-whole-page"]')).not.toBeNull());
  expect(host.querySelector('[data-testid="daily-x-whole-page"]')).toBeNull();
});

describe("Mini App independent release updates", () => {
  const CANDIDATE = { appVersion: "1.2.0", sourceCommit: "abcdef1234567890" };

  it("announces a compatible update at most once per (profile, appId, appVersion) without stealing focus and keeps it in the library menu after dismiss", async () => {
    fixture.updateByApp = {
      app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
    };
    let releaseEnvironment!: () => void;
    fixture.environmentHold = new Promise<void>((resolve) => { releaseEnvironment = resolve; });
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    // Toast waits for environment profile key before announcing.
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();
    const focusedBefore = selected()!;
    focusedBefore.focus();
    await act(async () => { releaseEnvironment(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
    const toast = host.querySelector<HTMLElement>('[data-testid="mini-app-update-toast"]')!;
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.getAttribute("aria-live")).toBe("polite");
    expect(toast.textContent).toContain("First report 1.2.0 is ready.");
    expect(document.activeElement).toBe(focusedBefore);

    // Dismissing restores focus to selected tab and suppresses repeat toast for same profile+app+version.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-dismiss]')!.click(); });
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();
    expect(document.activeElement).toBe(selected());

    // Manual refresh for the same version does not re-toast.
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => { refresh().click(); });
    await settle();
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();

    // Update remains discoverable inside the selected app's library menu.
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    const libUpdate = host.querySelector<HTMLButtonElement>('[data-mini-app-update="app_a"]');
    expect(libUpdate).not.toBeNull();
    expect(libUpdate?.getAttribute("aria-label")).toContain("1.2.0");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });

    // Re-mounting under the same profile keeps suppression; switching profile or bumping version announces once.
    await act(async () => { root.render(null); });
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();

    fixture.environmentId = "second-profile";
    await act(async () => { root.render(null); });
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-dismiss]')!.click(); });

    fixture.updateByApp.app_a = {
      installedVersion: "1.1.0",
      status: "available",
      available: { appVersion: "1.3.0", sourceCommit: "9999999abcdef000" },
    };
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')?.textContent).toContain("1.3.0"));
  });

  it("does not trigger or reset toast suppression when data revisions change on report editions", async () => {
    fixture.updateByApp = {
      app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
    };
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-dismiss]')!.click(); });
    expect(fixture.frameLifecycleMounts).toEqual(["app_a@2:<p>Fixture</p>"]);

    // Simulate a new report edition arriving via state poll (dataRevision 7 -> 8, templateVersion unchanged).
    fixture.dataRevision = 8;
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(frame()?.getAttribute("data-data-revision")).toBe("8"));
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();
    // Frame was updated in place without remounting.
    expect(fixture.frameLifecycleMounts).toEqual(["app_a@2:<p>Fixture</p>"]);
  });

  it("reloads only the target frame to vB, updates InfoHint version/commit, and preserves other apps", async () => {
    fixture.htmlByApp = { app_a: "<p>vA</p>", app_b: "<p>appB-stable</p>" };
    fixture.updateByApp = {
      app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
      app_b: { installedVersion: "2.0.0", status: "current", available: null },
    };
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
    expect(fixture.frameLifecycleMounts).toEqual(["app_a@2:<p>vA</p>"]);

    let releaseUpdate!: () => void;
    fixture.updateDeferred = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    fixture.onUpdateApply = (appId, body) => {
      fixture.htmlByApp[appId] = `<p>vB:${body.appVersion}</p>`;
      fixture.apps = fixture.apps.map((entry) => entry.id === appId
        ? {
            ...entry,
            revision: entry.revision + 1,
            templateVersion: entry.templateVersion + 1,
            updatedAt: entry.updatedAt + 1_000,
            release: {
              packageId: `mashellhan.${entry.slug}`,
              appVersion: body.appVersion,
              sourceCommit: body.sourceCommit,
              tag: `mini-app/${entry.slug}/v${body.appVersion}`,
              requires: [],
              htmlSha256: "0".repeat(64),
              htmlBytes: 12,
              queriesSha256: "1".repeat(64),
              queriesBytes: 2,
            },
          }
        : entry);
      fixture.updateByApp[appId] = { installedVersion: body.appVersion, status: "current", available: null };
    };

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
    expect(host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')?.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-mini-app-update-dismiss]')?.disabled).toBe(true);

    await act(async () => { releaseUpdate(); });
    await vi.waitFor(() => expect(frame()?.getAttribute("data-html")).toBe("<p>vB:1.2.0</p>"));
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();
    expect(fixture.updateRequests).toHaveLength(1);
    expect(fixture.updateRequests[0]).toMatchObject({
      appId: "app_a",
      body: { appVersion: "1.2.0", sourceCommit: "abcdef1234567890", expectedRevision: 3 },
    });
    expect(fixture.updateRequests[0]!.body.requestKey.length).toBeGreaterThan(8);
    expect(fixture.frameLifecycleMounts).toEqual(["app_a@2:<p>vA</p>", "app_a@3:<p>vB:1.2.0</p>"]);

    // InfoHint surfaces applied version and short source commit with full commit in title.
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!.click(); });
    const hint = document.querySelector('[data-info-hint-content]')!;
    expect(hint.querySelector('[data-mini-app-release-version]')?.textContent).toContain("1.2.0");
    const commitEl = hint.querySelector('[data-mini-app-source-commit]');
    expect(commitEl?.textContent).toContain("abcdef1");
    expect(commitEl?.getAttribute("title")).toBe("abcdef1234567890");

    // Other app remains on its untouched revision/templateVersion.
    await act(async () => { button("Second report").click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
    expect(frame()?.getAttribute("data-template-version")).toBe("2");
    expect(frame()?.getAttribute("data-html")).toBe("<p>appB-stable</p>");

    // Rollback on app_a updates InfoHint provenance from the current app rather than a stale cache.
    await act(async () => { button("First report").click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    fixture.apps = fixture.apps.map((entry) => entry.id === "app_a"
      ? {
          ...entry,
          revision: entry.revision + 1,
          templateVersion: 2,
          release: {
            packageId: "mashellhan.app-a",
            appVersion: "1.1.0",
            sourceCommit: "11111112222223333",
            tag: "mini-app/app-a/v1.1.0",
            requires: [],
            htmlSha256: "2".repeat(64),
            htmlBytes: 12,
            queriesSha256: "3".repeat(64),
            queriesBytes: 2,
          },
        }
      : entry);
    fixture.updateByApp.app_a = { installedVersion: "1.1.0", status: "available", available: CANDIDATE };
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(frame()?.getAttribute("data-template-version")).toBe("2"));
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!.click(); });
    const rolledBackHint = document.querySelector('[data-info-hint-content]')!;
    expect(rolledBackHint.querySelector('[data-mini-app-release-version]')?.textContent).toContain("1.1.0");
    expect(rolledBackHint.querySelector('[data-mini-app-source-commit]')?.textContent).toContain("1111111");
  });

  it("supports updating from the library popover after dismiss and closes the popover on success", async () => {
    fixture.htmlByApp = { app_a: "<p>vA</p>" };
    fixture.updateByApp = {
      app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
    };
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-dismiss]')!.click(); });

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    const updateBtn = host.querySelector<HTMLButtonElement>('[data-mini-app-update="app_a"]')!;
    fixture.htmlByApp.app_a = "<p>vB-from-library</p>";
    await act(async () => { updateBtn.click(); });
    await vi.waitFor(() => expect(frame()?.getAttribute("data-html")).toBe("<p>vB-from-library</p>"));
    expect(host.querySelector('[data-mini-app-popover]')).toBeNull();
    expect(document.activeElement).toBe(selected());
  });

  it("preserves vA interactive state, retains focus, reuses requestKey on retry, and refuses stale 409 overwrites", async () => {
    const { ApiError } = await import("@/state/store");
    fixture.htmlByApp = { app_a: "<p>vA-interactive</p>" };
    fixture.updateByApp = {
      app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
    };
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());

    fixture.failUpdateApply = new Error("Network offline");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-mini-app-update-error]')?.textContent).toBe("Network offline"));
    expect(frame()?.getAttribute("data-html")).toBe("<p>vA-interactive</p>");
    expect(fixture.frameLifecycleMounts).toEqual(["app_a@2:<p>vA-interactive</p>"]);
    expect(document.activeElement).toBe(host.querySelector('[data-mini-app-update-action]'));

    // Retrying after transient failure reuses the same idempotent requestKey.
    fixture.failUpdateApply = null;
    fixture.htmlByApp.app_a = "<p>vB-retried</p>";
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
    await vi.waitFor(() => expect(frame()?.getAttribute("data-html")).toBe("<p>vB-retried</p>"));
    expect(fixture.updateRequests).toHaveLength(2);
    expect(fixture.updateRequests[0]!.body.requestKey).toBe(fixture.updateRequests[1]!.body.requestKey);

    // 409 stale revision: another actor advanced revision to 5; UI does not overwrite and fetches newer state.
    fixture.apps = fixture.apps.map((entry) => entry.id === "app_a" ? { ...entry, revision: 5 } : entry);
    fixture.updateByApp.app_a = {
      installedVersion: "1.2.0",
      status: "available",
      available: { appVersion: "1.4.0", sourceCommit: "fedcba9876543210" },
    };
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());

    // Simulate external revision bump to 6 right before POST returns 409.
    fixture.apps = fixture.apps.map((entry) => entry.id === "app_a" ? { ...entry, revision: 6 } : entry);
    fixture.htmlByApp.app_a = "<p>external-rev6</p>";
    fixture.failUpdateApply = new ApiError("Conflict", 409);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
    await vi.waitFor(() => expect(frame()?.getAttribute("data-html")).toBe("<p>external-rev6</p>"));
    expect(host.querySelector('[data-mini-app-update-error]')?.textContent).toBe("Conflict");

    fixture.failUpdateApply = null;
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
    await vi.waitFor(() => expect(fixture.updateRequests.at(-1)?.body.expectedRevision).toBe(6));
    expect(fixture.updateRequests.at(-1)?.body.requestKey).not.toBe(fixture.updateRequests.at(-2)?.body.requestKey);
  });

  it("surfaces update-check errors only on manual check and renders incompatible/custom status in InfoHint without toasts", async () => {
    fixture.failUpdateCheck = true;
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    // Automatic initial check failure stays quiet and keeps vA interactive.
    expect(host.querySelector('[data-mini-app-update-check-error]')).toBeNull();
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();

    // Manual refresh surfaces inline error without breaking the frame.
    await vi.waitFor(() => expect(refresh().disabled).toBe(false));
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-mini-app-update-check-error]')?.textContent).toContain("Update check offline"));
    expect(frame()?.dataset.id).toBe("app_a");

    // Unavailable status shows inline notice only on manual refresh.
    fixture.failUpdateCheck = false;
    fixture.updateByApp = { app_a: { installedVersion: "1.1.0", status: "unavailable", available: null } };
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-mini-app-update-check-error]')?.textContent).toContain("Updates are temporarily unavailable."));
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();

    // Incompatible & custom statuses never show toast or library update button, and appear in InfoHint.
    // Incompatible supports both omitted/null available and candidate metadata returned by the backend.
    fixture.updateByApp = {
      app_a: { installedVersion: "1.1.0", status: "incompatible", available: CANDIDATE },
      app_b: { installedVersion: null, status: "custom", available: null },
    };
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-mini-app-update-check-error]')).toBeNull());
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    expect(host.querySelector('[data-mini-app-update="app_a"]')).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!.click(); });
    expect(document.querySelector('[data-info-hint-content]')?.textContent).toContain("requires a newer version");

    fixture.updateByApp.app_a = { installedVersion: "1.1.0", status: "incompatible", available: null };
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-mini-app-update-check-error]')).toBeNull());
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();

    await act(async () => { button("Second report").click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
    expect(host.querySelector('[data-testid="mini-app-update-toast"]')).toBeNull();
    await act(async () => { host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!.click(); });
    expect(document.querySelector('[data-info-hint-content]')?.textContent).toContain("Custom app");
  });

  it("renders Chinese locale update toast and RTL/narrow-friendly popover attributes", async () => {
    await loadLocale("zh");
    setLocale("zh");
    fixture.updateByApp = {
      app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
    };
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
    const toast = host.querySelector<HTMLElement>('[data-testid="mini-app-update-toast"]')!;
    expect(toast.textContent).toContain("First report 1.2.0 已就绪。");
    expect(toast.textContent).toContain("更新并重新加载");
    expect(toast.textContent).toContain("关闭");

    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    const popover = host.querySelector<HTMLElement>('[data-mini-app-popover]')!;
    expect(host.querySelector<HTMLElement>('[data-testid="mini-apps-panel"]')?.className).toContain("@container/mini-apps");
    expect(popover.className).toContain("end-0");
    expect(popover.className).toContain("max-h-[min(70vh,560px)]");
  });

  it("restores the selected Mini App's recorded previous version through the page action", async () => {
    fixture.apps = [{ ...app("app_a", "First report"), release: {
      packageId: "mashellhan.app-a", appVersion: "1.2.0", sourceCommit: CANDIDATE.sourceCommit, tag: "mini-app/app-a/v1.2.0",
      requires: [], htmlSha256: "b".repeat(64), htmlBytes: 12, queriesSha256: "c".repeat(64), queriesBytes: 2, previousTemplateVersion: 1,
    } }, app("app_b", "Second report")];
    fixture.htmlByApp = { app_a: "<p>New release</p>", app_b: "<p>Other app</p>" };
    fixture.onRollback = (id, body) => {
      fixture.apps = fixture.apps.map((entry) => entry.id === id
        ? { ...entry, revision: entry.revision + 1, templateVersion: body.templateVersion, release: null } : entry);
      fixture.htmlByApp[id] = "<p>Prior template</p>";
    };
    await render();
    const selector = "[data-mini-app-restore-version]";
    await vi.waitFor(() => expect(host.querySelector(selector)?.getAttribute("aria-label")).toBe("Restore previous version"));
    const installed = fixture.apps[0]!;
    await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
    await vi.waitFor(() => expect(fixture.rollbackRequests).toEqual([{ appId: installed.id, body: {
      expectedRevision: installed.revision, templateVersion: 1, requestKey: expect.any(String),
    } }]));
    expect(host.querySelector(selector)).toBeNull();
    expect(host.querySelector('[data-mini-app-update-rolled-back]')?.textContent).toBe("Restored the previous version.");
    expect(fixture.htmlByApp.app_b).toBe("<p>Other app</p>");
  });

  it("rolls back a candidate that times out without runtime-ready, restores InfoHint, and ignores mismatched readiness", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fixture.suppressRuntimeReady = true;
      fixture.apps = [
        {
          ...app("app_a", "First report"),
          release: {
            packageId: "mashellhan.app-a",
            appVersion: "1.1.0",
            sourceCommit: "11111112222223333",
            tag: "mini-app/app-a/v1.1.0",
            requires: [],
            htmlSha256: "2".repeat(64),
            htmlBytes: 12,
            queriesSha256: "3".repeat(64),
            queriesBytes: 2,
          },
        } as MiniAppSummary,
        app("app_b", "Second report"),
      ];
      fixture.htmlByApp = { app_a: "<p>vA</p>", app_b: "<p>vB-stable</p>" };
      fixture.updateByApp = {
        app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
      };
      fixture.onUpdateApply = (appId, body) => {
        fixture.htmlByApp[appId] = `<p>vB:${body.appVersion}</p>`;
        fixture.apps = fixture.apps.map((entry) => entry.id === appId
          ? {
              ...entry,
              revision: 4,
              templateVersion: 3,
              release: {
                packageId: `mashellhan.${entry.slug}`,
                appVersion: body.appVersion,
                sourceCommit: body.sourceCommit,
                tag: `mini-app/${entry.slug}/v${body.appVersion}`,
                requires: [],
                htmlSha256: "0".repeat(64),
                htmlBytes: 12,
                queriesSha256: "1".repeat(64),
                queriesBytes: 2,
              },
            }
          : entry);
        fixture.updateByApp[appId] = { installedVersion: body.appVersion, status: "current", available: null };
      };
      fixture.onRollback = (appId, body) => {
        fixture.htmlByApp[appId] = "<p>vA</p>";
        fixture.apps = fixture.apps.map((entry) => entry.id === appId
          ? {
              ...entry,
              revision: 5,
              templateVersion: body.templateVersion,
              release: {
                packageId: "mashellhan.app-a",
                appVersion: "1.1.0",
                sourceCommit: "11111112222223333",
                tag: "mini-app/app-a/v1.1.0",
                requires: [],
                htmlSha256: "2".repeat(64),
                htmlBytes: 12,
                queriesSha256: "3".repeat(64),
                queriesBytes: 2,
              },
            }
          : entry);
        fixture.updateByApp[appId] = { installedVersion: "1.1.0", status: "available", available: CANDIDATE };
      };

      await render();
      await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
      await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
      await vi.waitFor(() => expect(frame()?.getAttribute("data-html")).toBe("<p>vB:1.2.0</p>"));
      expect(fixture.rollbackRequests).toHaveLength(0);

      // Mismatched revision/templateVersion readiness does not clear bounded recovery.
      act(() => {
        fixture.lastRuntimeReadyCallback?.({ appId: "app_a", revision: 3, templateVersion: 3 });
        fixture.lastRuntimeReadyCallback?.({ appId: "app_a", revision: 4, templateVersion: 2 });
      });

      await act(async () => { await vi.advanceTimersByTimeAsync(MINI_APP_RUNTIME_READY_TIMEOUT_MS + 10); });
      await vi.waitFor(() => expect(fixture.rollbackRequests).toHaveLength(1));
      expect(fixture.rollbackRequests[0]).toMatchObject({
        appId: "app_a",
        body: { expectedRevision: 4, templateVersion: 2 },
      });
      await vi.waitFor(() => expect(frame()?.getAttribute("data-html")).toBe("<p>vA</p>"));
      expect(host.querySelector('[data-mini-app-update-rolled-back]')?.textContent).toContain("restored the previous version");

      await act(async () => { host.querySelector<HTMLButtonElement>('[role="tablist"] [data-info-hint]')!.click(); });
      const hint = document.querySelector('[data-info-hint-content]')!;
      expect(hint.querySelector('[data-mini-app-release-version]')?.textContent).toContain("1.1.0");
      expect(hint.querySelector('[data-mini-app-source-commit]')?.textContent).toContain("1111111");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves later writes when rollback receives 409 and avoids abandoning recovery across tab switches or close/reopen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      fixture.suppressRuntimeReady = true;
      fixture.htmlByApp = { app_a: "<p>vA</p>", app_b: "<p>appB</p>" };
      fixture.updateByApp = {
        app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
      };

      // 1. Switching away from app_a before timeout still executes rollback for app_a.
      await render();
      await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
      await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
      await vi.waitFor(() => expect(fixture.apps[0]?.revision).toBe(4));
      await act(async () => { button("Second report").click(); });
      await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_b"));
      await act(async () => { await vi.advanceTimersByTimeAsync(MINI_APP_RUNTIME_READY_TIMEOUT_MS + 10); });
      await vi.waitFor(() => expect(fixture.rollbackRequests).toHaveLength(1));
      expect(fixture.rollbackRequests[0]).toMatchObject({
        appId: "app_a",
        body: { expectedRevision: 4, templateVersion: 2 },
      });

      // 2. Closing and reopening resumes pending recovery and preserves later writes on 409.
      fixture.apps = [app("app_a", "First report"), app("app_b", "Second report")];
      fixture.updateRequests = [];
      fixture.rollbackRequests = [];
      fixture.updateByApp = {
        app_a: { installedVersion: "1.1.0", status: "available", available: { appVersion: "1.3.0", sourceCommit: "9999999abcdef000" } },
      };
      await act(async () => { button("First report").click(); });
      await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
      await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
      await vi.waitFor(() => expect(fixture.apps[0]?.revision).toBe(4));

      // Unmount (close) panel before readiness arrives, advance past deadline, then reopen.
      await act(async () => { root.render(null); });
      vi.advanceTimersByTime(MINI_APP_RUNTIME_READY_TIMEOUT_MS + 10);

      // Simulate another actor writing revision 5 while closed; server refuses rollback with 409.
      fixture.failRollback = new ApiError("Conflict", 409);
      await render();
      await vi.waitFor(() => expect(fixture.rollbackRequests).toHaveLength(1));
      expect(fixture.rollbackRequests[0]!.body.expectedRevision).toBe(4);
      await vi.waitFor(() => expect(stored.get("omb-mini-app-pending-update:omb-mini-app:fixture-environment:app_a") ?? "").toBe(""));
      expect(host.querySelector('[data-mini-app-update-rolled-back]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists recovery when closed while POST /update is in flight and rolls back conditionally on reopen", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const pendingKey = "omb-mini-app-pending-update:omb-mini-app:fixture-environment:app_a";
      fixture.suppressRuntimeReady = true;
      fixture.htmlByApp = { app_a: "<p>vA</p>", app_b: "<p>appB</p>" };
      fixture.updateByApp = {
        app_a: { installedVersion: "1.1.0", status: "available", available: CANDIDATE },
      };

      // 1. Close panel while POST /update is in flight, then resolve update; reopen after deadline with matching candidate rolls back.
      let resolveUpdate!: () => void;
      fixture.updateDeferred = new Promise<void>((resolve) => { resolveUpdate = resolve; });
      await render();
      await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
      await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
      await vi.waitFor(() => expect(fixture.updateRequests).toHaveLength(1));

      await act(async () => { root.render(null); });
      await act(async () => {
        resolveUpdate();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(stored.get(pendingKey) ?? "").not.toBe(""));
      expect(fixture.apps[0]?.revision).toBe(4);
      expect(fixture.apps[0]?.templateVersion).toBe(3);

      vi.advanceTimersByTime(MINI_APP_RUNTIME_READY_TIMEOUT_MS + 10);
      fixture.htmlByApp.app_a = "<p>vA</p>";
      await render();
      await vi.waitFor(() => expect(fixture.rollbackRequests).toHaveLength(1));
      expect(fixture.rollbackRequests[0]).toMatchObject({
        appId: "app_a",
        body: { expectedRevision: 4, templateVersion: 2 },
      });
      await vi.waitFor(() => expect(stored.get(pendingKey) ?? "").toBe(""));
      expect(host.querySelector('[data-mini-app-update-rolled-back]')?.textContent).toContain("restored the previous version");

      // 2. Close panel while POST /update is in flight, then another actor advances revision before reopen; reopen clears without rollback.
      await act(async () => { root.render(null); });
      stored.clear();
      fixture.apps = [app("app_a", "First report"), app("app_b", "Second report")];
      fixture.htmlByApp = { app_a: "<p>vA</p>", app_b: "<p>appB</p>" };
      fixture.updateRequests = [];
      fixture.rollbackRequests = [];
      fixture.updateByApp = {
        app_a: { installedVersion: "1.1.0", status: "available", available: { appVersion: "1.3.0", sourceCommit: "9999999abcdef000" } },
      };
      fixture.updateDeferred = new Promise<void>((resolve) => { resolveUpdate = resolve; });
      await render();
      await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-update-toast"]')).not.toBeNull());
      await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-update-action]')!.click(); });
      await vi.waitFor(() => expect(fixture.updateRequests).toHaveLength(1));

      await act(async () => { root.render(null); });
      await act(async () => {
        resolveUpdate();
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(stored.get(pendingKey) ?? "").not.toBe(""));

      // Another actor writes revision 5 while panel is closed.
      fixture.apps = fixture.apps.map((entry) => entry.id === "app_a" ? { ...entry, revision: 5 } : entry);
      vi.advanceTimersByTime(MINI_APP_RUNTIME_READY_TIMEOUT_MS + 10);
      await render();
      await vi.waitFor(() => expect(stored.get(pendingKey) ?? "").toBe(""));
      expect(fixture.rollbackRequests).toHaveLength(0);
      expect(host.querySelector('[data-mini-app-update-rolled-back]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
