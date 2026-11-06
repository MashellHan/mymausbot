// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalUsageResponse } from "../../../shared/local-dashboard";
import { withMergedUsageFixture } from "../../../scripts/testing/merged-usage-fixture";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import type { Routine } from "../../../shared/routines";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  apps: [] as MiniAppSummary[],
  stateRevision: 3,
  dataRevision: 7,
  failState: false,
  failDocument: false,
  denied: false,
  dispatch: vi.fn(),
  frameMounts: 0,
  dashboardReads: [] as string[],
  bots: [] as Array<{ id: string }>,
  routines: [] as Routine[],
  routinesLoadState: "ready" as "loading" | "ready" | "error",
  owner: true as boolean,
  visible: true,
  usageValue: 1,
  usageDeferred: null as Promise<LocalUsageResponse> | null,
}));

vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
  useStore: () => ({ state: { bots: fixture.bots, routines: fixture.routines, routinesLoadState: fixture.routinesLoadState }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.owner }));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => fixture.visible }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("./MiniAppFrame", () => ({ MiniAppFrame: ({ document, state }: { document: MiniAppDocument; state: MiniAppState }) => {
  fixture.frameMounts += 1;
  return createElement("div", { "data-testid": "fixture-frame", "data-id": document.app.id, "data-data-revision": state.data[0]?.revision });
} }));
vi.mock("./BookkeepingInstall", () => ({ BookkeepingInstall: ({ onInstalled }: { onInstalled(id: string): void }) => createElement("button", { onClick: () => onInstalled("app_new"), "data-testid": "fixture-install" }, "Finish install") }));
vi.mock("./ReportInstall", () => ({ ReportInstall: ({ kind, onCancel }: { kind: string; onCancel(): void }) => createElement("div", { "data-testid": "fixture-report-install", "data-kind": kind }, createElement("button", { onClick: onCancel }, "Cancel")) }));

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

let root: Root;
let host: HTMLDivElement;
let stored: Map<string, string>;
const frame = () => host.querySelector<HTMLElement>('[data-testid="fixture-frame"]');
const freshness = () => host.querySelector<HTMLElement>('[data-testid="mini-app-freshness"]')?.textContent ?? "";
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const refresh = () => host.querySelector<HTMLButtonElement>('[aria-label="Check for updates"]')!;
const selected = () => host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
const settle = async () => { await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-apps-panel"]')).not.toBeNull()); };
const render = async () => {
  await act(async () => { root.render(createElement(MiniAppsPanel)); });
  await settle();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  stored = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
  fixture.apps = [app("app_a", "First report"), app("app_b", "Second report")];
  fixture.stateRevision = 3;
  fixture.dataRevision = 7;
  fixture.failState = false;
  fixture.failDocument = false;
  fixture.denied = false;
  fixture.frameMounts = 0;
  fixture.dashboardReads = [];
  fixture.bots = [];
  fixture.routines = [];
  fixture.routinesLoadState = "ready";
  fixture.owner = true;
  fixture.visible = true;
  fixture.usageValue = 1;
  fixture.usageDeferred = null;
  fixture.dispatch.mockReset();
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/.well-known/openmausbot/environment") return { environmentId: "fixture-environment" };
    if (path === "/api/mini-apps" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { dashboardKind: "agent-team" | "usage" };
      const id = `installed_${body.dashboardKind}`;
      const next = { ...app(id, body.dashboardKind), slug: body.dashboardKind, revision: 1, templateVersion: 1,
        dashboardIdentity: body.dashboardKind, dashboard: body.dashboardKind === "agent-team" ? dashboard : usageDashboard };
      fixture.apps.push(next);
      fixture.stateRevision = 1;
      return { app: next, replayed: false };
    }
    if (path === "/api/mini-apps") return { apps: fixture.apps };
    if (path.endsWith("/state")) {
      if (fixture.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
      if (fixture.failState) throw new Error("Fixture offline");
      const summary = fixture.apps.find((entry) => entry.id === path.split("/")[3]);
      return { appId: path.split("/")[3], revision: fixture.stateRevision, templateVersion: summary?.templateVersion ?? 2, status: "active",
        data: summary?.dashboardIdentity ? [] : [{ datasetId: "dataset_demo", revision: fixture.dataRevision }] };
    }
    if (path.endsWith("/dashboard") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { resource: string };
      fixture.dashboardReads.push(body.resource);
      return { appId: path.split("/")[3], revision: fixture.stateRevision, resource: body.resource,
        snapshot: body.resource === "teams" ? teams : body.resource === "usage"
          ? fixture.usageDeferred ? await fixture.usageDeferred : usageFor(fixture.usageValue)
          : { agentId: "w1:p1", status: "ready", updatedAt: 1_000,
          truncated: false, events: [{ id: "e1", kind: "assistant", at: null, tool: null, text: "Synthetic recent reply" }] } };
    }
    if (path.endsWith("/publish") && init?.method === "POST") {
      const id = path.split("/")[3]!;
      fixture.stateRevision += 1;
      fixture.apps = fixture.apps.map((entry) => entry.id === id ? { ...entry, status: "active", revision: fixture.stateRevision, dashboard } : entry);
      return { app: fixture.apps.find((entry) => entry.id === id), replayed: false };
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

afterEach(() => { root.unmount(); host.remove(); vi.unstubAllGlobals(); });

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

  it("labels the app version separately from report editions while freshness becomes stale and recovers", async () => {
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("7"));
    expect(freshness()).toBe("Current app version");
    expect(host.textContent).toContain("App updated");
    fixture.dataRevision = 8;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("8"));
    fixture.failState = true;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(freshness()).toContain("Showing the last loaded version"));
    expect(freshness()).not.toContain("Current app version");
    expect(frame()?.dataset.dataRevision).toBe("8");
    fixture.failState = false;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(freshness()).toBe("Current app version"));
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

  it("opens the generic source picker when no app is installed", async () => {
    fixture.apps = [];
    await render();
    await vi.waitFor(() => expect(host.textContent).toContain("No Mini Apps installed yet"));
    expect(host.querySelectorAll('[data-mini-app-included]')).toHaveLength(5);
    expect(host.querySelectorAll('[data-mini-app-catalog]')).toHaveLength(0);
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(host.textContent).toContain("0 installed");
    await act(async () => { button("Add Mini App").click(); });
    expect(host.querySelector('[data-mini-app-catalog="bookkeeping"]')?.getAttribute("data-mini-app-state")).toBe("data");
    expect(host.querySelector('[data-mini-app-catalog="x_ai_digest"]')?.getAttribute("data-mini-app-state")).toBe("automation");
    expect(host.textContent).toContain("Agent Team");
    expect(host.textContent).toContain("Usage");
    expect(host.textContent).toContain("The original Agent Team and Usage Computer tabs remain available.");
    expect(host.textContent).toContain("Daily X AI digest");
    expect(host.textContent).toContain("GitHub activity & discovery");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-choice="x_ai_digest"]')!.click(); });
    expect(host.querySelector('[data-testid="fixture-report-install"]')?.getAttribute("data-kind")).toBe("x_ai_digest");
    await act(async () => { button("Cancel").click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-choice="bookkeeping"]')!.click(); });
    expect(host.querySelector('[data-testid="fixture-install"]')).not.toBeNull();
  });

  it("installs Agent Team explicitly from the empty library and keeps the count truthful until publication", async () => {
    fixture.apps = [];
    await render();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="mini-app-empty-library"]')).not.toBeNull());
    expect(host.textContent).toContain("0 installed");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-included="agent-team"]')!.click(); });
    const dialog = document.querySelector<HTMLElement>('#mini-app-library-dialog')!;
    expect(document.activeElement).toBe(dialog.querySelector('[data-mini-app-catalog="agent-team"]'));
    expect(dialog.querySelector('[data-mini-app-catalog="bookkeeping"]')?.getAttribute("data-mini-app-state")).toBe("data");
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-mini-app-choice="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-install"]')).not.toBeNull());
    await vi.waitFor(() => expect(button("Install app").disabled).toBe(false));
    await act(async () => { button("Install app").click(); });
    await vi.waitFor(() => expect(selected()?.dataset.appId).toBe("installed_agent-team"));
    await vi.waitFor(() => expect(host.querySelector('[data-team-house]')).not.toBeNull());
    const request = fixture.api.mock.calls.find(([path, init]) => path === "/api/mini-apps" && init?.method === "POST")!;
    expect(JSON.parse(String(request[1].body))).toMatchObject({ dashboardKind: "agent-team", bindings: [], expectedRevision: 0 });
    expect(fixture.apps).toHaveLength(1);
  });

  it("keeps archived native identity in the library for explicit same-id repair", async () => {
    fixture.apps = [{ ...app("old_team", "Agent Team"), slug: "agent-team", status: "archived",
      dashboardIdentity: "agent-team", dashboard: null }];
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-mini-app-included]')).toHaveLength(5));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    const dialog = document.querySelector<HTMLElement>('#mini-app-library-dialog')!;
    expect(dialog.querySelector('[data-mini-app-catalog="agent-team"]')?.getAttribute("data-mini-app-state")).toBe("repair");
    await act(async () => { dialog.querySelector<HTMLButtonElement>('[data-mini-app-choice="agent-team"]')!.click(); });
    await vi.waitFor(() => expect(button("Reinstall app").disabled).toBe(false));
    await act(async () => { button("Reinstall app").click(); });
    await vi.waitFor(() => expect(selected()?.dataset.appId).toBe("old_team"));
    expect(fixture.apps).toHaveLength(1);
    const request = fixture.api.mock.calls.find(([path, init]) => path === "/api/mini-apps/old_team/publish" && init?.method === "POST")!;
    expect(JSON.parse(String(request[1].body))).toMatchObject({ expectedRevision: 3, dashboardKind: "agent-team", bindings: [] });
  });

  it("keeps an unrelated report slug as a custom app and refuses catalog adoption", async () => {
    fixture.apps = [{ ...app("custom", "My own report"), slug: "x-ai-digest", shippedTemplateKind: null }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("custom"));
    expect(selected()?.querySelector('[data-mini-app-icon="custom"]')).not.toBeNull();
    await act(async () => { button("Add Mini App").click(); });
    expect(host.querySelector('[data-mini-app-catalog="x_ai_digest"]')?.getAttribute("data-mini-app-state")).toBe("conflict");
    expect(host.querySelector('[data-mini-app-choice="x_ai_digest"]')).toBeNull();
    expect(host.textContent).toContain("Another app uses this name");
    expect(fixture.api.mock.calls.some(([path, init]) => path === "/api/mini-apps" && init?.method === "POST")).toBe(false);
  });

  it("retains a shipped report identity and icon after its HTML is edited", async () => {
    fixture.apps = [{ ...app("edited_report", "My edited digest"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("edited_report"));
    expect(selected()?.querySelector('[data-mini-app-icon="x_ai_digest"]')).not.toBeNull();
    await act(async () => { button("Add Mini App").click(); });
    expect(host.querySelector('[data-mini-app-catalog="x_ai_digest"]')?.getAttribute("data-mini-app-state")).toBe("installed");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-choice="x_ai_digest"]')!.click(); });
    expect(selected()?.dataset.appId).toBe("edited_report");
  });

  it("opens the full library outside the tablist and returns focus on Escape", async () => {
    await render();
    await vi.waitFor(() => expect(frame()).not.toBeNull());
    const trigger = host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!;
    expect(host.querySelector('[role="tablist"]')?.contains(trigger)).toBe(false);
    trigger.focus();
    await act(async () => { trigger.click(); });
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="mini-app-library-title"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelectorAll('[data-mini-app-catalog]')).toHaveLength(5);
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role="dialog"][aria-labelledby="mini-app-library-title"]')).toBeNull();
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

  it("shows bundled apps without owner install actions when owner access is denied", async () => {
    fixture.apps = [];
    fixture.owner = false;
    await render();
    await vi.waitFor(() => expect(host.querySelectorAll('[data-mini-app-included]')).toHaveLength(5));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-all]')!.click(); });
    const dialog = document.querySelector<HTMLElement>('#mini-app-library-dialog')!;
    expect(dialog.querySelectorAll('[data-mini-app-catalog]')).toHaveLength(5);
    expect(dialog.querySelectorAll('[data-mini-app-choice]')).toHaveLength(0);
    expect(dialog.textContent).toContain("Only the local owner can install this app.");
  });

  it("opens the newly installed document when both apps share the same revisions and Data", async () => {
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    await act(async () => { button("Add Mini App").click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-choice="bookkeeping"]')!.click(); });
    fixture.apps.push(app("app_new", "Installed report"));
    await act(async () => { button("Finish install").click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_new"));
    expect(selected()?.dataset.appId).toBe("app_new");
    const installedFrame = frame();
    fixture.dataRevision += 1;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("8"));
    expect(frame()).toBe(installedFrame);
  });

  it("opens an installed report slug from the chooser without starting another install", async () => {
    fixture.apps = [app("app_a", "First report"), { ...app("report_existing", "Daily X AI digest"), slug: "x-ai-digest", shippedTemplateKind: "x_ai_digest" }];
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("app_a"));
    await act(async () => { button("Add Mini App").click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-mini-app-choice="x_ai_digest"]')!.click(); });
    await vi.waitFor(() => expect(frame()?.dataset.id).toBe("report_existing"));
    expect(host.querySelector('[data-testid="fixture-report-install"]')).toBeNull();
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
    await vi.waitFor(() => expect(host.querySelector('[data-testid="dashboard-install"]')).not.toBeNull());
    await act(async () => button("Reauthorize app").click());
    await vi.waitFor(() => expect(host.querySelectorAll("[data-team-house]")).toHaveLength(1));
    const [path, options] = fixture.api.mock.calls.find(([url, init]) => String(url).endsWith("/publish") && init?.method === "POST")!;
    expect(path).toBe("/api/mini-apps/app_team/publish");
    expect(JSON.parse(options.body)).toMatchObject({ expectedRevision: 3, dashboardKind: "agent-team", bindings: [], publisherBotIds: ["editor"], html: "<p>Fixture</p>" });
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
