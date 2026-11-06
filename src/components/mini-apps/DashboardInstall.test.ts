// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiniAppSummary } from "../../../shared/mini-apps";
import { setLocale } from "@/lib/i18n";

const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: calls.api }));

import { DashboardInstall } from "./DashboardInstall";

const app = (status: MiniAppSummary["status"], dashboard: MiniAppSummary["dashboard"] = null,
  dashboardIdentity: MiniAppSummary["dashboardIdentity"] = dashboard?.kind ?? null): MiniAppSummary => ({
  id: "00000000-0000-4000-8000-000000000001", slug: "agent-team", title: "Agent Team", description: "Local teams",
  status, dashboard, dashboardIdentity, revision: 4, templateVersion: 2, publisherBotIds: [], createdAt: 1, updatedAt: 2,
});
let host: HTMLDivElement;
let root: Root;
const installed = vi.fn();
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)!;
const render = async (kind: "agent-team" | "usage") => {
  await act(async () => root.render(createElement(DashboardInstall, { key: kind, kind, onCancel: vi.fn(), onInstalled: installed })));
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { app: { blocksOpaqueFrameNavigation: true } });
  setLocale("en");
  calls.api.mockReset();
  installed.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("built-in dashboard installation", () => {
  it("discloses the owner resources and publishes a real empty-binding app without a bot grant", async () => {
    calls.api.mockImplementation(async (path: string) => path === "/api/mini-apps" && calls.api.mock.calls.length === 1
      ? { apps: [] } : { app: app("active"), replayed: false });
    await render("agent-team");
    await vi.waitFor(() => expect(button("Install app")).toBeTruthy());
    expect(host.textContent).toContain("Recent input and reply excerpts load only when you expand a member");
    expect(host.textContent).toContain("cannot control agents");
    expect(document.activeElement?.id).toBe("dashboard-install-title");
    await act(async () => button("Install app").click());
    const [path, options] = calls.api.mock.calls.find(([, options]) => options?.method === "POST")!;
    const body = JSON.parse(options.body);
    expect(path).toBe("/api/mini-apps");
    expect(body).toMatchObject({ expectedRevision: 0, slug: "agent-team", dashboardKind: "agent-team", bindings: [], publisherBotIds: [] });
    expect(body.html).toContain("Open this app in the OpenMausBot desktop app.");
    expect(installed).toHaveBeenCalledWith(app("active").id);
  });

  it("reinstalls an archived app by its id and current revision without claiming success early", async () => {
    const archived = app("archived", null, "agent-team");
    let finish!: (value: unknown) => void;
    calls.api.mockImplementation((path: string, options?: { method?: string }) => path === "/api/mini-apps" ? Promise.resolve({ apps: [archived] })
      : options?.method === "POST" ? new Promise((resolve) => { finish = resolve; })
        : Promise.resolve({ app: archived, html: "<p>Existing fallback</p>", bindings: [], versions: [] }));
    await render("agent-team");
    await vi.waitFor(() => expect(button("Reinstall app")).toBeTruthy());
    await act(async () => button("Reinstall app").click());
    await vi.waitFor(() => expect(calls.api.mock.calls.some(([, options]) => options?.method === "POST")).toBe(true));
    const [path, options] = calls.api.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(path).toBe(`/api/mini-apps/${archived.id}/publish`);
    expect(JSON.parse(options.body)).toMatchObject({ expectedRevision: 4, dashboardKind: "agent-team", bindings: [], publisherBotIds: [] });
    expect(JSON.parse(options.body).html).toBe("<p>Existing fallback</p>");
    expect(installed).not.toHaveBeenCalled();
    await act(async () => finish({ app: { ...archived, status: "active", revision: 5 }, replayed: false }));
    expect(installed).toHaveBeenCalledWith(archived.id);
  });

  it("reauthorizes an active restored app explicitly using its immutable identity and preserves its current fallback", async () => {
    const restored = { ...app("active", null, "agent-team"), publisherBotIds: ["editor"] };
    calls.api.mockImplementation((path: string, options?: { method?: string }) => path === "/api/mini-apps" ? Promise.resolve({ apps: [restored] })
      : options?.method === "POST" ? Promise.resolve({ app: { ...restored, revision: 5 }, replayed: false })
        : Promise.resolve({ app: restored, html: "<p>Owner fallback</p>", bindings: [], versions: [] }));
    await render("agent-team");
    await vi.waitFor(() => expect(button("Reauthorize app")).toBeTruthy());
    await act(async () => button("Reauthorize app").click());
    const [path, options] = calls.api.mock.calls.find(([, options]) => options?.method === "POST")!;
    expect(path).toBe(`/api/mini-apps/${restored.id}/publish`);
    expect(JSON.parse(options.body)).toMatchObject({ expectedRevision: 4, dashboardKind: "agent-team", slug: "agent-team",
      html: "<p>Owner fallback</p>", bindings: [], publisherBotIds: ["editor"] });
    expect(installed).toHaveBeenCalledWith(restored.id);
  });

  it("opens an already granted dashboard without republishing", async () => {
    const dashboard = { kind: "agent-team", renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: ["teams", "activity"] } as const;
    calls.api.mockResolvedValue({ apps: [app("active", dashboard)] });
    await render("agent-team");
    await vi.waitFor(() => expect(button("Open app")).toBeTruthy());
    await act(async () => button("Open app").click());
    expect(installed).toHaveBeenCalledWith(app("active").id);
    expect(calls.api.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
  });

  it("treats a same-slug custom app without dashboard identity as a hard conflict", async () => {
    calls.api.mockResolvedValue({ apps: [{ ...app("active"), slug: "usage" }] });
    await render("usage");
    await vi.waitFor(() => expect(host.textContent).toContain("An installed app already uses this name."));
    expect(button("Install app").disabled).toBe(true);
    expect(calls.api.mock.calls.every(([, options]) => options?.method !== "POST")).toBe(true);
  });
});
