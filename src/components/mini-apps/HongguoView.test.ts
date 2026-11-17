// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import type { HongguoHistoryEntry, HongguoPlaybackResponse, HongguoSeriesCard } from "../../../shared/hongguo-mini-app";

const fixture = vi.hoisted(() => ({ api: vi.fn(), visible: true, fullscreen: null as Element | null }));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  ApiError: class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } },
}));
vi.mock("@/lib/page-visible", () => ({ usePageVisible: () => fixture.visible }));

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
let playbackHold: Promise<void> | null;
let paginationHold: Promise<void> | null;
let pageable: boolean;
let failMore: boolean;
let episodes: Array<typeof episode | typeof laterEpisode>;
let historyActions: string[];
let catalogCard: HongguoSeriesCard;
let refreshKey = 0;
let fixtureId = 0;
let storageKey = "fixture-environment";
let catalogHold: Promise<void> | null;
let failPopular: boolean;
let metrics: { heat?: number | null; playCount?: number | null };

const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
const seriesButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim().startsWith("Drama A"))!;
const render = async (strict = false) => {
  const view = createElement(HongguoView, { document: miniAppDocument, state, storageKey, refreshKey, onRevoked: vi.fn(), onChanged: vi.fn() });
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
  app.id = `hongguo_fixture_${++fixtureId}`;
  state.appId = app.id;
  storageKey = "fixture-environment";
  refreshKey++;
  fixture.visible = true;
  fixture.fullscreen = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fixture.fullscreen });
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
  playbackHold = null;
  paginationHold = null;
  pageable = false;
  failMore = false;
  episodes = [episode];
  historyActions = [];
  catalogCard = card;
  catalogHold = null;
  failPopular = false;
  metrics = {};
  fixture.api.mockReset().mockImplementation(async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
    expect(path).toBe(`/api/mini-apps/${app.id}/hongguo/${path.split("/").at(-1)}`);
    const body = JSON.parse(String(init?.body)) as { mode?: string; cursor?: string; action?: string; entry?: HongguoHistoryEntry; seriesId?: string };
    const scope = { appId: app.id, revision: 3 };
    if (path.endsWith("/catalog")) {
      if (body.mode === "popular" && !body.cursor) {
        await catalogHold;
        if (failPopular) throw new Error("Synthetic catalog unavailable");
      }
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
    if (path.endsWith("/series")) { await seriesHold; return { ...scope, series: { ...card, episodes, ...metrics } }; }
    if (path.endsWith("/playback")) { await playbackHold; return playback; }
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

afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); Reflect.deleteProperty(document, "fullscreenElement"); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setLocale("en"); });

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

const popularCalls = () => fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/catalog")
  && JSON.parse(String(init.body)).mode === "popular" && !JSON.parse(String(init.body)).cursor).length;

it("keeps a nearly five-minute revisit cached when the parent refresh counter resets", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  await render();
  expect(seriesButton()).toBeTruthy();
  const before = popularCalls();
  await act(async () => { root.render(null); });
  vi.setSystemTime(1_000_000 + 5 * 60_000 - 1);
  refreshKey = 0;
  await render();
  expect(seriesButton()).toBeTruthy();
  expect(popularCalls()).toBe(before);
  expect(host.querySelector('[aria-labelledby="hongguo-catalog-title"]')?.getAttribute("aria-busy")).toBe("false");
});

it("shows expired rows immediately and replaces them after background refresh", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  await render();
  await act(async () => { root.render(null); });
  vi.setSystemTime(1_000_000 + 5 * 60_000);
  let release!: () => void;
  catalogHold = new Promise<void>((resolve) => { release = resolve; });
  catalogCard = { ...card, id: "fresh", title: "Fresh catalog" };
  await render();
  expect(seriesButton()).toBeTruthy();
  expect(host.querySelector('[aria-labelledby="hongguo-catalog-title"]')?.getAttribute("aria-busy")).toBe("true");
  expect(popularCalls()).toBe(2);
  await act(async () => { release(); });
  expect(host.textContent).toContain("Fresh catalog");
  expect(seriesButton()).toBeUndefined();
});

it("retains cached rows on a failed refresh and retries through the existing refresh control", async () => {
  await render();
  failPopular = true;
  refreshKey++;
  await render();
  expect(seriesButton()).toBeTruthy();
  expect(host.textContent).toContain("Synthetic catalog unavailable");
  expect(popularCalls()).toBe(2);
  let release!: () => void;
  catalogHold = new Promise<void>((resolve) => { release = resolve; });
  failPopular = false;
  metrics = {};
  refreshKey++;
  await render();
  expect(seriesButton()).toBeTruthy();
  expect(popularCalls()).toBe(3);
  await act(async () => { release(); });
  expect(host.textContent).not.toContain("Synthetic catalog unavailable");
});

it("refreshes at five minutes while on the home page and stops the timer while watching", async () => {
  vi.useFakeTimers();
  await render();
  expect(popularCalls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000 - 1); });
  expect(popularCalls()).toBe(1);
  let release!: () => void;
  catalogHold = new Promise<void>((resolve) => { release = resolve; });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(popularCalls()).toBe(2);
  expect(seriesButton()).toBeTruthy();
  await act(async () => { release(); });
  await act(async () => { seriesButton().click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
  expect(popularCalls()).toBe(2);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-labelledby="hongguo-watch-title"] button')!.click(); });
  expect(popularCalls()).toBe(3);
});

it("does not show another environment's cached catalog for the same app id", async () => {
  await render();
  expect(seriesButton()).toBeTruthy();
  await act(async () => { root.render(null); });
  storageKey = "another-environment";
  let release!: () => void;
  catalogHold = new Promise<void>((resolve) => { release = resolve; });
  catalogCard = { ...card, id: "other", title: "Other environment" };
  await render();
  expect(seriesButton()).toBeUndefined();
  await act(async () => { release(); });
  expect(host.textContent).toContain("Other environment");
  await act(async () => { root.render(null); });
  storageKey = "fixture-environment";
  await render();
  expect(seriesButton()).toBeTruthy();
  expect(host.textContent).not.toContain("Other environment");
});

it("does not renew category freshness when another catalog succeeds", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const categoryCalls = () => fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/catalog")
    && JSON.parse(String(init.body)).mode === "categories").length;
  await render();
  expect(categoryCalls()).toBe(1);
  vi.setSystemTime(1_000_000 + 4 * 60_000);
  await act(async () => { button("New").click(); });
  expect(categoryCalls()).toBe(1);
  await act(async () => { root.render(null); });
  vi.setSystemTime(1_000_000 + 6 * 60_000);
  const before = popularCalls();
  await render();
  expect(categoryCalls()).toBe(2);
  expect(popularCalls()).toBe(before);
});

it("does not extend the first-page freshness when loading additional pages", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  pageable = true;
  await render();
  expect(host.textContent).toContain("Old extra");
  vi.setSystemTime(1_000_000 + 4 * 60_000);
  await act(async () => { button("Load more").click(); });
  expect(host.textContent).toContain("Old last");
  await act(async () => { root.render(null); });
  vi.setSystemTime(1_000_000 + 5 * 60_000);
  await render();
  expect(popularCalls()).toBe(2);
});

it("ignores a stale refresh that finishes after choosing a different catalog", async () => {
  pageable = true;
  await render();
  let release!: () => void;
  catalogHold = new Promise<void>((resolve) => { release = resolve; });
  refreshKey++;
  await render();
  expect(seriesButton()).toBeTruthy();
  expect(button("Load more").disabled).toBe(true);
  await act(async () => { button("New").click(); });
  expect(host.textContent).toContain("New first");
  await act(async () => { release(); });
  expect(host.textContent).not.toContain("Drama A");
  expect(host.textContent).not.toContain("Old extra");
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
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
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
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
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
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
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
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
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


it("retains the same player and position across fullscreen visibility changes", async () => {
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  await render();
  const video = await openPlayer();
  video.currentTime = 31;
  const reads = () => fixture.api.mock.calls.filter(([path]) => /\/(series|playback)$/.test(String(path))).length;
  const before = reads();
  fixture.fullscreen = video;
  vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
  fixture.visible = false;
  await render();
  expect(host.querySelector("video")).toBe(video);
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  fixture.fullscreen = null;
  fixture.visible = true;
  await render();
  expect(host.querySelector("video")).toBe(video);
  expect(video.currentTime).toBe(31);
  expect(reads()).toBe(before);
});

it("pauses an ordinary hidden page without reloading playback on return", async () => {
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  await render();
  const video = await openPlayer();
  video.currentTime = 19;
  const before = fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback")).length;
  vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
  fixture.visible = false;
  await render();
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  fixture.visible = true;
  await render();
  expect(host.querySelector("video")).toBe(video);
  expect(video.currentTime).toBe(19);
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(before);
});


it("does not start a pending episode while hidden and keeps the resolved player on return", async () => {
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  let release!: () => void;
  playbackHold = new Promise<void>((resolve) => { release = resolve; });
  const starts = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  await render();
  await act(async () => { seriesButton().click(); });
  const reads = () => fixture.api.mock.calls.filter(([path]) => /\/(series|playback)$/.test(String(path))).length;
  await vi.waitFor(() => expect(reads()).toBe(2));
  fixture.visible = false;
  await render();
  expect(host.querySelector("video")).toBeNull();
  await act(async () => { release(); });
  const video = host.querySelector("video")!;
  expect(video).not.toBeNull();
  expect(video.autoplay).toBe(false);
  expect(starts).not.toHaveBeenCalled();
  fixture.visible = true;
  await render();
  expect(host.querySelector("video")).toBe(video);
  expect(reads()).toBe(2);
});

const qualityPlayback = (id: string) => ({ appId: app.id, revision: 3, status: "ready" as const,
  mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/${id}?expectedRevision=3`, durationSeconds: 100,
  selectedQualityId: id, availableQualityIds: ["1080p", "720p", "480p"] });
const qualitySelect = () => host.querySelector<HTMLSelectElement>('[aria-label="Video quality"]')!;
const selectQuality = (id: string) => act(async () => {
  qualitySelect().value = id;
  qualitySelect().dispatchEvent(new Event("change", { bubbles: true }));
});

it.each([true, false])("keeps the old player during a quality change and restores current position with paused=%s", async (paused) => {
  playback = qualityPlayback("1080p");
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => {
    if (path.endsWith("/playback") && JSON.parse(init.body).qualityId) {
      await hold; return qualityPlayback("720p");
    }
    return original(path, init);
  });
  await render();
  const old = await openPlayer();
  Object.defineProperty(old, "paused", { configurable: true, value: paused });
  expect([...qualitySelect().options].map(option => option.value)).toEqual(["1080p", "720p", "480p"]);
  expect(qualitySelect().value).toBe("1080p");
  old.currentTime = 31;
  await selectQuality("720p");
  expect(host.querySelector("video")).toBe(old);
  old.currentTime = 99.5;
  await act(async () => { release(); });
  const video = host.querySelector("video")!;
  expect(video).not.toBe(old);
  expect(video.src).toContain("/720p?");
  Object.defineProperty(video, "duration", { configurable: true, value: 100 });
  await act(async () => video.dispatchEvent(new Event("loadedmetadata", { bubbles: true })));
  expect(video.currentTime).toBe(99.5);
  expect(video.autoplay).toBe(!paused);
  const calls = fixture.api.mock.calls.filter(([path]) => path.endsWith("/playback"));
  expect(JSON.parse(calls[0]![1].body).qualityId).toBeUndefined();
  expect(JSON.parse(calls[1]![1].body)).toMatchObject({ seriesId: card.id, episodeId: episode.id, qualityId: "720p" });
});

it("keeps current playback and selection when the requested quality is no longer available", async () => {
  playback = qualityPlayback("1080p");
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => path.endsWith("/playback") && JSON.parse(init.body).qualityId
    ? { appId: app.id, revision: 3, status: "unavailable", reason: "quality-unavailable" } : original(path, init));
  await render();
  const video = await openPlayer();
  video.currentTime = 31;
  await selectQuality("720p");
  expect(host.querySelector("video")).toBe(video);
  expect(video.currentTime).toBe(31);
  expect(qualitySelect().value).toBe("1080p");
  expect(host.textContent).toContain("This quality is unavailable. Your current video is unchanged.");
});

it("discards a late quality response after selecting a different episode", async () => {
  playback = qualityPlayback("1080p");
  episodes = [episode, laterEpisode];
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => {
    if (path.endsWith("/playback") && JSON.parse(init.body).qualityId) {
      signal = init.signal; await hold; return qualityPlayback("720p");
    }
    return original(path, init);
  });
  await render(); await openPlayer();
  await selectQuality("720p");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Episode 2"]')!.click());
  expect(signal?.aborted).toBe(true);
  const video = host.querySelector("video");
  await act(async () => { release(); });
  expect(host.querySelector("video")).toBe(video);
  expect(video?.src).toContain("/1080p?");
  expect(host.querySelector('[aria-label="Episode 2"]')?.getAttribute("aria-current")).toBe("true");
});

it.each([
  [{ heat: 1_200_000, playCount: 34_000_000 }, "Hongguo heat 1.2M", "34M views"],
  [{ heat: 0, playCount: 0 }, "Hongguo heat 0", "0 views"],
  [{}, null, null],
  [{ heat: null, playCount: null }, null, null],
])("shows sourced popularity without inventing missing metrics: %j", async (values, heatLabel, viewsLabel) => {
  metrics = values;
  await render();
  await act(async () => { seriesButton().click(); });
  const header = host.querySelector('[aria-labelledby="hongguo-watch-title"] header')!;
  if (heatLabel) expect(header.textContent).toContain(heatLabel);
  else expect(header.textContent).not.toContain("Hongguo heat");
  if (viewsLabel) expect(header.textContent).toContain(viewsLabel);
  else expect(header.textContent).not.toContain("views");
});
