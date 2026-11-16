// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import type { HongguoHistoryEntry, HongguoPlaybackResponse } from "../../../shared/hongguo-mini-app";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => true }));

import { HongguoView } from "./HongguoView";

const app = { id: "hongguo_fixture", slug: "hongguo", title: "Synthetic drama", description: "Fixture", status: "active" as const,
  revision: 3, templateVersion: 1, publisherBotIds: [], nativeIdentity: "hongguo" as const,
  nativeKind: "hongguo" as const, createdAt: 1, updatedAt: 2 };
const miniAppDocument: MiniAppDocument = { app, html: "", bindings: [], versions: [] };
const state: MiniAppState = { appId: app.id, revision: 3, templateVersion: 1, status: "active", data: [] };
const card = { id: "series_a", title: "Drama A", coverUrl: null, summary: null, episodeCount: 1 };
const episode = { id: "episode_1", number: 1, title: "Episode one", availability: "available" as const, imageUrl: null };
const entry: HongguoHistoryEntry = { seriesId: card.id, seriesTitle: card.title, coverUrl: null,
  episodeId: episode.id, episodeNumber: 1, episodeTitle: episode.title, positionSeconds: 6, durationSeconds: 100, updatedAt: 1 };

let host: HTMLDivElement;
let root: Root;
let history: HongguoHistoryEntry[];
let playback: HongguoPlaybackResponse;
let failNew: boolean;
let savePositions: number[];
let firstSave: Promise<void> | null;

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const seriesButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim().startsWith("Drama A"))!;
const render = async (strict = false) => {
  const view = createElement(HongguoView, { document: miniAppDocument, state, refreshKey: 0, onRevoked: vi.fn(), onChanged: vi.fn() });
  await act(async () => { root.render(strict ? createElement(StrictMode, null, view) : view); });
};
const openPlayer = async () => {
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  await act(async () => { seriesButton().click(); });
  await vi.waitFor(() => expect(host.querySelector("video")).not.toBeNull());
  const video = host.querySelector("video")!;
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  await act(async () => { video.dispatchEvent(new Event("loadedmetadata", { bubbles: true })); });
  return video;
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  setLocale("en");
  history = [];
  playback = { appId: app.id, revision: 3, status: "unavailable", reason: "anonymous-limited" };
  failNew = false;
  savePositions = [];
  firstSave = null;
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
    expect(path).toBe(`/api/mini-apps/${app.id}/hongguo/${path.split("/").at(-1)}`);
    const body = JSON.parse(String(init?.body)) as { mode?: string; action?: string; entry?: HongguoHistoryEntry; seriesId?: string };
    const scope = { appId: app.id, revision: 3 };
    if (path.endsWith("/catalog")) {
      if (body.mode === "new" && failNew) throw new Error("Synthetic catalog unavailable");
      return { ...scope, items: body.mode === "categories" ? [] : [card], categories: [], nextCursor: null };
    }
    if (path.endsWith("/series")) return { ...scope, series: { ...card, episodes: [episode] } };
    if (path.endsWith("/playback")) return playback;
    if (path.endsWith("/history")) {
      if (body.action === "save") {
        await firstSave;
        savePositions.push(body.entry!.positionSeconds);
        history = [{ ...body.entry!, updatedAt: savePositions.length }, ...history.filter((item) => item.seriesId !== body.entry!.seriesId)];
      } else if (body.action === "delete") history = history.filter((item) => item.seriesId !== body.seriesId);
      else if (body.action === "clear") history = [];
      return { ...scope, entries: history, autoplayNext: true };
    }
    if (path.endsWith("/preferences")) return { ...scope, autoplayNext: false };
    throw new Error(`Unexpected API path: ${path}`);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setLocale("en"); });

it("keeps catalog results and errors visible after Strict Mode effect cleanup and setup", async () => {
  await render(true);
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  failNew = true;
  await act(async () => { button("New").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Synthetic catalog unavailable"));
});

it("keeps anonymous playback unavailable with a finite preparation deadline", async () => {
  await render();
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  await act(async () => { seriesButton().click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Playback is unavailable with anonymous access"));
  expect(host.querySelector("video")).toBeNull();
  const request = fixture.api.mock.calls.find(([path]) => String(path).endsWith("/playback"));
  expect(request?.[1].timeoutMs).toBe(120_000);
  expect(fixture.api.mock.calls.some(([path]) => String(path).includes("/media/"))).toBe(false);
});

it("serializes position writes so an older asynchronous save cannot overwrite the latest position", async () => {
  playback = { appId: app.id, revision: 3, status: "ready",
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  let release!: () => void;
  firstSave = new Promise<void>((resolve) => { release = resolve; });
  await render();
  const video = await openPlayer();
  await act(async () => { video.currentTime = 6; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  await vi.waitFor(() => expect(fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/history")
    && JSON.parse(String(init.body)).action === "save")).toHaveLength(1));
  await act(async () => { video.currentTime = 16; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  expect(fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/history")
    && JSON.parse(String(init.body)).action === "save")).toHaveLength(1);
  firstSave = null;
  release();
  await vi.waitFor(() => expect(savePositions).toEqual([6, 16]));
  expect(history[0]?.positionSeconds).toBe(16);
});

it.each(["delete", "clear"] as const)("does not recreate %s history after leaving", async (action) => {
  history = [entry];
  playback = { appId: app.id, revision: 3, status: "ready",
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  await render();
  const video = await openPlayer();
  await act(async () => { video.currentTime = 12; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Back to browsing"]')!.click(); });
  await act(async () => { button("Viewing history").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Drama A"));
  await act(async () => { if (action === "delete") host.querySelector<HTMLButtonElement>('[aria-label="Delete Drama A from viewing history"]')!.click();
    else button("Clear history").click(); });
  await act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button').item(1)!.click(); });
  await vi.waitFor(() => expect(history).toHaveLength(0));
  const saves = savePositions.length;
  await act(async () => { root.render(null); });
  await Promise.resolve();
  expect(savePositions).toHaveLength(saves);
});
