// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  apps: [] as MiniAppSummary[],
  stateRevision: 3,
  dataRevision: 7,
  failState: false,
  denied: false,
  dispatch: vi.fn(),
  frameMounts: 0,
}));

vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
  useStore: () => ({ state: { bots: [] }, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => false }));
vi.mock("./MiniAppFrame", () => ({ MiniAppFrame: ({ document, state }: { document: MiniAppDocument; state: MiniAppState }) => {
  fixture.frameMounts += 1;
  return createElement("div", { "data-testid": "fixture-frame", "data-id": document.app.id, "data-data-revision": state.data[0]?.revision });
} }));
vi.mock("./BookkeepingInstall", () => ({ BookkeepingInstall: ({ onInstalled }: { onInstalled(id: string): void }) => createElement("button", { onClick: () => onInstalled("app_new"), "data-testid": "fixture-install" }, "Finish install") }));

import { MiniAppsPanel } from "./MiniAppsPanel";

const app = (id: string, title: string): MiniAppSummary => ({
  id, slug: id, title, description: `${title} description`, status: "active", revision: 3, templateVersion: 2,
  publisherBotIds: [], createdAt: 1_000, updatedAt: 2_000,
});

let root: Root;
let host: HTMLDivElement;
let stored: Map<string, string>;
const frame = () => host.querySelector<HTMLElement>('[data-testid="fixture-frame"]');
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
  fixture.denied = false;
  fixture.frameMounts = 0;
  fixture.dispatch.mockReset();
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/.well-known/openmausbot/environment") return { environmentId: "fixture-environment" };
    if (path === "/api/mini-apps") return { apps: fixture.apps };
    if (path.endsWith("/state")) {
      if (fixture.denied) throw Object.assign(new Error("Forbidden"), { status: 403 });
      if (fixture.failState) throw new Error("Fixture offline");
      return { appId: path.split("/")[3], revision: fixture.stateRevision, templateVersion: 2, status: "active",
        data: [{ datasetId: "dataset_demo", revision: fixture.dataRevision }] };
    }
    if (path.endsWith("/rollback") && init?.method === "POST") {
      fixture.stateRevision += 1;
      fixture.apps = fixture.apps.map((entry) => ({ ...entry, revision: fixture.stateRevision }));
      return { app: fixture.apps[0], replayed: false };
    }
    if (path.startsWith("/api/mini-apps/")) {
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

  it("updates a mounted app's Data revision and retains it through a later offline check", async () => {
    await render();
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("7"));
    fixture.dataRevision = 8;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(frame()?.dataset.dataRevision).toBe("8"));
    fixture.failState = true;
    await act(async () => { refresh().click(); });
    await vi.waitFor(() => expect(host.textContent).toContain("Showing the last loaded version"));
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
    await vi.waitFor(() => expect(host.textContent).toContain("Installed Mini Apps appear here"));
    await act(async () => { button("Install bookkeeping").click(); });
    expect(host.querySelector('[data-testid="fixture-install"]')).not.toBeNull();
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
    expect(host.querySelector('[aria-label="Install bookkeeping"]')).toBeNull();
    expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/query"))).toBe(false);
  });
});
