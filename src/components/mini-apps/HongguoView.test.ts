// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import type { HongguoHistoryEntry, HongguoPlaybackResponse, HongguoSeriesCard } from "../../../shared/hongguo-mini-app";

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
const laterEpisode = { id: "episode_2", number: 2, title: "Episode two", availability: "available" as const, imageUrl: null };
const entry: HongguoHistoryEntry = { seriesId: card.id, seriesTitle: card.title, coverUrl: null,
  episodeId: episode.id, episodeNumber: 1, episodeTitle: episode.title, positionSeconds: 6, durationSeconds: 100, updatedAt: 1 };
const laterEntry: HongguoHistoryEntry = { ...entry, episodeId: laterEpisode.id, episodeNumber: 2,
  episodeTitle: laterEpisode.title, positionSeconds: 47 };

let host: HTMLDivElement;
let root: Root;
let history: HongguoHistoryEntry[];
let playback: HongguoPlaybackResponse;
let failNew: boolean;
let savePositions: number[];
let firstSave: Promise<void> | null;
let historyListHold: Promise<void> | null;
let historyFailures: number;
let seriesHold: Promise<void> | null;
let paginationHold: Promise<void> | null;
let pageable: boolean;
let failMore: boolean;
let episodes: Array<typeof episode | typeof laterEpisode>;
let historyActions: string[];
let catalogCard: HongguoSeriesCard;
let refreshKey = 0;

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const seriesButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim().startsWith("Drama A"))!;
const render = async (strict = false) => {
  const view = createElement(HongguoView, { document: miniAppDocument, state, refreshKey, onRevoked: vi.fn(), onChanged: vi.fn() });
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
  refreshKey++;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  setLocale("en");
  history = [];
  playback = { appId: app.id, revision: 3, status: "unavailable", reason: "anonymous-limited" };
  failNew = false;
  savePositions = [];
  firstSave = null;
  historyListHold = null;
  historyFailures = 0;
  seriesHold = null;
  paginationHold = null;
  pageable = false;
  failMore = false;
  episodes = [episode];
  historyActions = [];
  catalogCard = card;
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
    expect(path).toBe(`/api/mini-apps/${app.id}/hongguo/${path.split("/").at(-1)}`);
    const body = JSON.parse(String(init?.body)) as { mode?: string; cursor?: string; action?: string; entry?: HongguoHistoryEntry; seriesId?: string };
    const scope = { appId: app.id, revision: 3 };
    if (path.endsWith("/catalog")) {
      if (body.mode === "new" && failNew) throw new Error("Synthetic catalog unavailable");
      if (pageable && body.cursor === "old-next") {
        await paginationHold;
        if (failMore) throw new Error("Synthetic next page unavailable");
        return { ...scope, items: [catalogCard, { ...card, id: "old_extra", title: "Old extra" }],
          categories: [], nextCursor: "old-third" };
      }
      if (pageable && body.cursor === "old-third") return { ...scope,
        items: [{ ...card, id: "old_last", title: "Old last" }], categories: [], nextCursor: null };
      if (pageable && body.cursor === "new-next") return { ...scope,
        items: [{ ...card, id: "new_first", title: "New first" },
          { ...card, id: "new_extra", title: "New extra" }], categories: [], nextCursor: "new-third" };
      if (pageable && body.cursor === "new-third") return { ...scope,
        items: [{ ...card, id: "new_last", title: "New last" }], categories: [], nextCursor: null };
      if (pageable && body.mode === "new") return { ...scope,
        items: [{ ...card, id: "new_first", title: "New first" }], categories: [], nextCursor: "new-next" };
      if (pageable && body.mode === "popular") return { ...scope, items: [catalogCard], categories: [], nextCursor: "old-next" };
      return { ...scope, items: body.mode === "categories" ? [] : [catalogCard], categories: [], nextCursor: null };
    }
    if (path.endsWith("/series")) { await seriesHold; return { ...scope, series: { ...card, episodes } }; }
    if (path.endsWith("/playback")) return playback;
    if (path.endsWith("/history")) {
      historyActions.push(body.action!);
      if (body.action === "list") {
        await historyListHold;
        if (historyFailures > 0) { historyFailures--; throw new Error("Synthetic history unavailable"); }
      }
      if (body.action === "save") {
        savePositions.push(body.entry!.positionSeconds);
        history = [{ ...body.entry!, updatedAt: savePositions.length }, ...history.filter((item) => item.seriesId !== body.entry!.seriesId)];
        await firstSave;
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

it("keeps catalog errors visible and clears them when restoring cached rows after Strict Mode", async () => {
  await render(true);
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  failNew = true;
  await act(async () => { button("New").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Synthetic catalog unavailable"));
  const catalogCalls = fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/catalog")).length;
  await act(async () => { button("Popular").click(); });
  expect(seriesButton()).toBeTruthy();
  expect(host.textContent).not.toContain("Synthetic catalog unavailable");
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/catalog"))).toHaveLength(catalogCalls);
});

it("uses an owner-scoped supported cover URL and removes a failed image over its placeholder", async () => {
  catalogCard = { ...card, coverUrl: "https://p.fqnovelpic.com/poster.heic?x-expires=1800000300&x-signature=synthetic" };
  await render();
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  const image = seriesButton().querySelector("img")!;
  expect(image.getAttribute("src")).toContain(`/api/mini-apps/${app.id}/hongguo/cover?expectedRevision=3&url=`);
  expect(image.getAttribute("loading")).toBe("eager");
  await act(async () => { image.dispatchEvent(new Event("error")); });
  expect(seriesButton().querySelector("img")).toBeNull();
  expect(seriesButton().querySelector("svg")).not.toBeNull();
  expect(seriesButton().textContent).toContain("Drama A");
  refreshKey++;
  await render();
  await vi.waitFor(() => expect(seriesButton().querySelector("img")).not.toBeNull());
});

it("shows a short same-revision revisit from memory without a blank catalog or redundant request", async () => {
  await render();
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  const catalogCalls = () => fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/catalog")).length;
  const before = catalogCalls();
  await act(async () => { root.render(null); });
  await render();
  expect(seriesButton()).toBeTruthy();
  expect(host.textContent).not.toContain("Loading…");
  expect(catalogCalls()).toBe(before);
  refreshKey++;
  await render();
  await vi.waitFor(() => expect(catalogCalls()).toBeGreaterThan(before));
});

it("shows the first page before one automatic fill, dedupes rows, and leaves manual pagination", async () => {
  pageable = true;
  let releaseNext!: () => void;
  paginationHold = new Promise<void>((resolve) => { releaseNext = resolve; });
  await render();
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  await vi.waitFor(() => expect(button("Loading…")).toBeTruthy());
  expect(host.textContent).not.toContain("Old extra");
  const nextCalls = () => fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/catalog")
    && JSON.parse(String(init.body)).cursor === "old-next");
  expect(nextCalls()).toHaveLength(1);
  await act(async () => { releaseNext(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Old extra"));
  expect([...host.querySelectorAll("button")].filter((item) => item.textContent?.startsWith("Drama A"))).toHaveLength(1);
  expect(nextCalls()).toHaveLength(1);
  await act(async () => { button("Load more").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Old last"));
});

it("keeps the first page and a manual retry when background fill fails", async () => {
  pageable = true;
  failMore = true;
  await render();
  await vi.waitFor(() => expect(host.textContent).toContain("Synthetic next page unavailable"));
  expect(seriesButton()).toBeTruthy();
  expect(button("Load more").disabled).toBe(false);
  expect(fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/catalog")
    && JSON.parse(String(init.body)).cursor === "old-next")).toHaveLength(1);
  failMore = false;
  await act(async () => { button("Load more").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Old extra"));
  expect(host.textContent).not.toContain("Synthetic next page unavailable");
});

it("keeps replacement pagination current when an old automatic response arrives late", async () => {
  pageable = true;
  let releaseOld!: () => void;
  paginationHold = new Promise<void>((resolve) => { releaseOld = resolve; });
  await render();
  await vi.waitFor(() => expect(button("Loading…")).toBeTruthy());
  await act(async () => { button("New").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("New extra"));
  expect([...host.querySelectorAll("button")].filter((item) => item.textContent?.startsWith("New first"))).toHaveLength(1);
  expect(button("Load more").disabled).toBe(false);
  await act(async () => { releaseOld(); });
  expect(host.textContent).not.toContain("Old extra");
  await act(async () => { button("Load more").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("New last"));
  expect(host.textContent).not.toContain("Old extra");
});

it("keeps anonymous playback unavailable with a finite preparation deadline", async () => {
  await render();
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  await act(async () => { seriesButton().click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("The provider returned no playback data. This episode was not played."));
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

it.each(["history first", "series first"] as const)("resumes a later episode when %s resolves after opening a catalog card", async (order) => {
  history = [laterEntry];
  episodes = [episode, laterEpisode];
  playback = { appId: app.id, revision: 3, status: "ready",
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  let releaseHistory!: () => void;
  let releaseSeries!: () => void;
  historyListHold = new Promise<void>((resolve) => { releaseHistory = resolve; });
  seriesHold = new Promise<void>((resolve) => { releaseSeries = resolve; });
  await render();
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  await act(async () => { seriesButton().click(); });
  await vi.waitFor(() => expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/series"))).toBe(true));
  if (order === "history first") await act(async () => { releaseHistory(); });
  else {
    await act(async () => { releaseSeries(); });
    const watch = host.querySelector<HTMLElement>('[aria-labelledby="hongguo-watch-title"]')!;
    expect(watch.querySelector('[role="status"]')?.textContent).toBe("Loading…");
    expect(watch.textContent).not.toContain("No episodes are listed");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Episode 1"]')?.disabled).toBe(true);
  }
  expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/playback"))).toBe(false);
  if (order === "history first") await act(async () => { releaseSeries(); });
  else await act(async () => { releaseHistory(); });
  await vi.waitFor(() => expect(host.querySelector("video")).not.toBeNull());
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Episode 1"]')?.disabled).toBe(false);
  const playbackCalls = fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"));
  expect(playbackCalls).toHaveLength(1);
  expect(JSON.parse(String(playbackCalls[0]![1].body)).episodeId).toBe(laterEpisode.id);
  const video = host.querySelector("video")!;
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  await act(async () => { video.dispatchEvent(new Event("loadedmetadata", { bubbles: true })); });
  expect(video.currentTime).toBe(47);
  await act(async () => { video.currentTime = 53; video.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  await vi.waitFor(() => expect(history[0]?.positionSeconds).toBe(53));
  expect(host.querySelector("video")).toBe(video);
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(1);
  expect(fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/history")
    && JSON.parse(String(init.body)).action === "save")
    .every(([, init]) => JSON.parse(String(init.body)).entry.episodeId === laterEpisode.id)).toBe(true);
});

it("keeps episode selection pending after a failed history read and retries the snapshot", async () => {
  history = [laterEntry];
  episodes = [episode, laterEpisode];
  historyFailures = 1;
  await render();
  await vi.waitFor(() => expect(seriesButton()).toBeTruthy());
  await act(async () => { seriesButton().click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Synthetic history unavailable"));
  const watch = host.querySelector<HTMLElement>('[aria-labelledby="hongguo-watch-title"]')!;
  expect(watch.querySelector('[role="alert"]')?.textContent).toContain("Synthetic history unavailable");
  expect(watch.textContent).not.toContain("No episodes are listed");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Episode 1"]')?.disabled).toBe(true);
  expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/playback"))).toBe(false);
  await act(async () => { button("Try again").click(); });
  await vi.waitFor(() => expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/playback"))).toBe(true));
  const call = fixture.api.mock.calls.find(([path]) => String(path).endsWith("/playback"));
  expect(JSON.parse(String(call![1].body)).episodeId).toBe(laterEpisode.id);
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

it.each(["delete", "clear"] as const)("orders old-instance close saves before a new-instance %s and keeps newer progress", async (action) => {
  history = [entry];
  episodes = [episode, laterEpisode];
  playback = { appId: app.id, revision: 3, status: "ready",
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  let releaseOld!: () => void;
  firstSave = new Promise<void>((resolve) => { releaseOld = resolve; });
  await render();
  const oldVideo = await openPlayer();
  await act(async () => { oldVideo.currentTime = 12; oldVideo.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  await vi.waitFor(() => expect(historyActions.filter((item) => item === "save")).toHaveLength(1));
  expect(history[0]?.positionSeconds).toBe(12);
  await act(async () => { root.render(null); });
  await render();
  await act(async () => { button("Viewing history").click(); });
  expect(historyActions.filter((item) => item === "delete" || item === "clear")).toHaveLength(0);
  await act(async () => { firstSave = null; releaseOld(); });
  await vi.waitFor(() => expect(historyActions.filter((item) => item === "save")).toHaveLength(2));
  await vi.waitFor(() => expect(host.querySelector('[aria-label="Delete Drama A from viewing history"]')).not.toBeNull());
  await act(async () => { if (action === "delete") host.querySelector<HTMLButtonElement>('[aria-label="Delete Drama A from viewing history"]')!.click();
    else button("Clear history").click(); });
  await act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button').item(1)!.click(); });
  await vi.waitFor(() => expect(history).toHaveLength(0));
  expect(historyActions.indexOf(action)).toBeGreaterThan(historyActions.lastIndexOf("save"));
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Back to browsing"]')!.click(); });
  await act(async () => { seriesButton().click(); });
  await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="Episode 2"]')).not.toBeNull());
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Episode 2"]')!.click(); });
  await vi.waitFor(() => expect(host.querySelector("video")?.getAttribute("src")).toContain("/media/"));
  const newVideo = host.querySelector("video")!;
  await act(async () => { newVideo.currentTime = 31; newVideo.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  await vi.waitFor(() => expect(history[0]?.episodeId).toBe(laterEpisode.id));
  expect(history[0]?.positionSeconds).toBe(31);
});
