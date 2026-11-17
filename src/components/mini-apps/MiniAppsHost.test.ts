// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ api: vi.fn(), id: 0, botMounts: [] as string[] }));
vi.mock("@/state/store", () => ({ api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));
vi.mock("./MiniAppsPanel", async () => {
  const { HongguoView } = await import("./HongguoView");
  return { MiniAppsPanel: () => {
    const app = { id: `host-fixture-${fixture.id}`, slug: "hongguo", title: "Synthetic drama", description: "Fixture", status: "active" as const,
      revision: 1, templateVersion: 1, publisherBotIds: [], nativeIdentity: "hongguo" as const,
      nativeKind: "hongguo" as const, createdAt: 1, updatedAt: 1 };
    return createElement(HongguoView, { document: { app, html: "", bindings: [], versions: [] },
      state: { appId: app.id, revision: 1, templateVersion: 1, status: "active", data: [] },
      storageKey: "host-fixture", refreshKey: 0, onRevoked: vi.fn(), onChanged: vi.fn() });
  } };
});

import { MiniAppsHost, MiniAppsSlot } from "./MiniAppsHost";

let host: HTMLDivElement;
let root: Root;
function BotPanel({ botId, showApps }: { botId: string; showApps: boolean }) {
  useEffect(() => { fixture.botMounts.push(botId); }, [botId]);
  return createElement("section", { "data-bot": botId }, showApps ? createElement(MiniAppsSlot) : null);
}
const render = (botId: string, enabled = true, showApps = true) => act(async () => {
  root.render(createElement(MiniAppsHost, { enabled, children: createElement(BotPanel, { key: botId, botId, showApps }) }));
});
const reads = () => fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback")).length;
const openPlayer = async () => {
  await render("first");
  await vi.waitFor(() => expect(host.textContent).toContain("Synthetic drama"));
  await act(async () => {
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.startsWith("Synthetic drama"))!.click();
  });
  await vi.waitFor(() => expect(host.querySelector("video")).not.toBeNull());
  const video = host.querySelector("video")!;
  video.currentTime = 31;
  vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
  return video;
};

beforeEach(() => {
  fixture.id++;
  fixture.botMounts = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { ownPage: true, blocksOpaqueFrameNavigation: true } });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  setLocale("en");
  const card = { id: "series", title: "Synthetic drama", coverUrl: null, summary: null, episodeCount: 1 };
  fixture.api.mockReset().mockImplementation(async (path: string) => {
    const scope = { appId: `host-fixture-${fixture.id}`, revision: 1 };
    if (path.endsWith("/history")) return { ...scope, entries: [], autoplayNext: false };
    if (path.endsWith("/catalog")) return { ...scope, items: [card], categories: [], nextCursor: null };
    if (path.endsWith("/series")) return { ...scope, series: { ...card,
      episodes: [{ id: "episode", number: 1, title: "Episode", availability: "available", imageUrl: null }] } };
    if (path.endsWith("/playback")) return { ...scope, status: "ready", durationSeconds: 100,
      mediaUrl: `/api/mini-apps/${scope.appId}/hongguo/media/synthetic?expectedRevision=1` };
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps the actual Hongguo player while the keyed Bot panel is replaced", async () => {
  const video = await openPlayer();
  expect(reads()).toBe(1);
  await render("second");
  expect(fixture.botMounts).toEqual(["first", "second"]);
  expect(host.querySelector('[data-bot="first"]')).toBeNull();
  expect(host.querySelector('[data-bot="second"] video')).toBe(video);
  expect(video.currentTime).toBe(31);
  expect(reads()).toBe(1);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
});

it("keeps playback through another Bot's non-app tab and stops when the panel closes", async () => {
  const video = await openPlayer();
  await render("second", true, false);
  expect(host.querySelector("video")).toBe(video);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  await render("second");
  expect(host.querySelector('[data-bot="second"] video')).toBe(video);
  expect(video.currentTime).toBe(31);
  expect(reads()).toBe(1);
  await render("second", false);
  expect(host.querySelector("video")).toBeNull();
  expect(video.isConnected).toBe(false);
});
