// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Routine } from "../../../shared/routines";
import { reportPublicationDraft } from "../../../shared/report-mini-app";

const fixture = vi.hoisted(() => ({ api: vi.fn(), dispatch: vi.fn(), routines: [] as Routine[], bots: [{ id: "bot_a", name: "Research bot" }], installed: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: { routines: fixture.routines, bots: fixture.bots, routinesLoadState: "ready" }, dispatch: fixture.dispatch }) }));
import { ReportInstall } from "./ReportInstall";

const routine = (id: string, patch: Partial<Routine> = {}): Routine => ({
  id, name: `Routine ${id}`, prompt: "Synthetic prompt", target: "bot", botId: "bot_a", runOn: "maus", enabled: true,
  schedule: { type: "cron", expression: "0 9 * * *", timeZone: "Asia/Shanghai" }, durationMinutes: 10,
  nextRunAt: null, createdAt: 1, updatedAt: 1, ...patch,
});

let host: HTMLDivElement;
let root: Root;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label)!;
const render = async () => { await act(async () => { root.render(createElement(ReportInstall, { kind: "x_ai_digest", onCancel: vi.fn(), onInstalled: fixture.installed })); }); };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  fixture.api.mockReset(); fixture.dispatch.mockReset(); fixture.installed.mockReset();
  fixture.routines = [routine("eligible"), routine("cloud", { runOn: "cloud" }), routine("paused", { enabled: false }), routine("room", { target: "room-goal" })];
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { root.unmount(); host.remove(); vi.unstubAllGlobals(); });

it("bootstraps only an existing local routine and grants the server-resolved producer on publication", async () => {
  const publication = reportPublicationDraft("x_ai_digest", "dataset_a", "<main>Shipped report</main>");
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/mini-apps" && init?.method !== "POST") return { apps: [] };
    if (path === "/api/mini-apps/report-source") return { kind: "x_ai_digest", slug: "x-ai-digest", routineId: "eligible", producerBotId: "resolved_bot", dataset: { datasetId: "dataset_a", revision: 1, tables: [] }, publication };
    if (path === "/api/mini-apps" && init?.method === "POST") return { app: { id: "installed_app" }, replayed: false };
    throw new Error(`Unexpected ${path}`);
  });
  await render();
  expect(host.textContent).toContain("Research bot");
  expect(host.textContent).toContain("China time");
  expect(host.textContent).toContain("Data will be prepared");
  expect(host.querySelectorAll("select option")).toHaveLength(1);
  await act(async () => { button("Install report").click(); });
  const source = fixture.api.mock.calls.find(([path]) => path === "/api/mini-apps/report-source")!;
  expect(JSON.parse(String(source[1].body))).toEqual({ kind: "x_ai_digest", routineId: "eligible" });
  const published = fixture.api.mock.calls.find(([path, init]) => path === "/api/mini-apps" && init?.method === "POST")!;
  expect(JSON.parse(String(published[1].body))).toEqual({ ...publication, publisherBotIds: ["resolved_bot"] });
  expect(fixture.installed).toHaveBeenCalledWith("installed_app");
});

it("opens an already installed stable slug without bootstrapping Data or publishing again", async () => {
  fixture.api.mockResolvedValue({ apps: [{ id: "existing_app", slug: "x-ai-digest", status: "active" }] });
  await render();
  await act(async () => { button("Install report").click(); });
  expect(fixture.installed).toHaveBeenCalledWith("existing_app");
  expect(fixture.api).toHaveBeenCalledTimes(1);
});

it("does not duplicate an archived stable slug", async () => {
  fixture.api.mockResolvedValue({ apps: [{ id: "archived_app", slug: "x-ai-digest", status: "archived" }] });
  await render();
  await act(async () => { button("Install report").click(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("archived");
  expect(fixture.installed).not.toHaveBeenCalled();
  expect(fixture.api).toHaveBeenCalledTimes(1);
});

it("points to existing Automations when no eligible routine exists", async () => {
  fixture.routines = [routine("paused", { enabled: false })];
  await render();
  expect(button("Install report")).toBeUndefined();
  await act(async () => { button("Open Automations").click(); });
  expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showRoutines" });
  expect(fixture.api).not.toHaveBeenCalled();
});

it("refuses a mismatched bootstrap response before any publication", async () => {
  fixture.api.mockImplementation(async (path: string) => path === "/api/mini-apps" ? { apps: [] }
    : { kind: "github_activity", slug: "github-activity", routineId: "eligible", producerBotId: "bot_a", publication: { slug: "github-activity", expectedRevision: 0 } });
  await render();
  await act(async () => { button("Install report").click(); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("did not match");
  expect(fixture.api).toHaveBeenCalledTimes(2);
});
