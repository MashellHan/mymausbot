// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activeLocale, setLocale, t as hostText } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { hongguoText } from "./hongguo-copy";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import type { HongguoEpisode, HongguoHistoryEntry, HongguoPlaybackResponse, HongguoSeriesCard } from "../../../shared/hongguo-mini-app";

const fixture = vi.hoisted(() => ({ api: vi.fn(), completion: vi.fn(), visible: true, fullscreen: null as Element | null }));
vi.mock("@/state/store", async () => ({ api: fixture.api, ApiError: (await import("@/state/api")).ApiError }));
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
let episodes: HongguoEpisode[];
let historyActions: string[];
let catalogCard: HongguoSeriesCard;
let refreshKey = 0;
let fixtureId = 0;
let storageKey = "fixture-environment";
let catalogHold: Promise<void> | null;
let failPopular: boolean;
let metrics: { heat?: number | null; playCount?: number | null };

const controls: Record<string, LocaleKey> = { New: "computer.miniApps.hongguo.new", Popular: "computer.miniApps.hongguo.popular",
  "Load more": "computer.miniApps.hongguo.more", "Loading…": "computer.miniApps.hongguo.loading",
  "Viewing history": "computer.miniApps.hongguo.history", "Clear history": "computer.miniApps.hongguo.clear",
  "Try again": "computer.miniApps.preview.retry" };
const requestFailed = hongguoText("computer.miniApps.hongguo.requestFailed");
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")]
  .find((item) => item.textContent?.trim() === (controls[label] ? hongguoText(controls[label]) : label))!;
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
  app.revision = 3;
  state.appId = app.id;
  state.revision = 3;
  storageKey = "fixture-environment";
  refreshKey++;
  fixture.visible = true;
  fixture.fullscreen = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fixture.fullscreen });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ogb", { platform: "darwin", app: { version: "fixture", ownPage: true, blocksOpaqueFrameNavigation: true } });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "seekable", "get").mockImplementation(function (this: HTMLMediaElement) {
    const duration = this.duration;
    return { length: Number.isFinite(duration) && duration > 0 ? 1 : 0, start: () => 0, end: () => duration };
  });
  fixture.completion.mockReset().mockImplementation((_path: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fixture.completion);
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
  await vi.waitFor(() => expect(host.textContent).toContain(requestFailed));
  const catalogCalls = fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/catalog")).length;
  await act(async () => { button("Popular").click(); });
  expect(seriesButton()).toBeTruthy();
  expect(host.textContent).not.toContain(requestFailed);
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
  expect(host.textContent).not.toContain("正在加载…");
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
  expect(host.textContent).toContain(requestFailed);
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
  expect(host.textContent).not.toContain(requestFailed);
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
  await vi.waitFor(() => expect(host.textContent).toContain(requestFailed));
  expect(seriesButton()).toBeTruthy();
  expect(button("Load more").disabled).toBe(false);
  expect(fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/catalog")
    && JSON.parse(String(init.body)).cursor === "old-next")).toHaveLength(1);
  failMore = false;
  await act(async () => { button("Load more").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Old extra"));
  expect(host.textContent).not.toContain(requestFailed);
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
  await vi.waitFor(() => expect(host.textContent).toContain("服务方未返回播放数据。本集未开始播放。"));
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
    expect(watch.querySelector('[role="status"]')?.textContent).toBe("正在加载…");
    expect(watch.textContent).not.toContain("这部短剧尚无剧集列表");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="第 1 集"]')?.disabled).toBe(true);
  }
  expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/playback"))).toBe(false);
  if (order === "history first") await act(async () => { releaseSeries(); });
  else await act(async () => { releaseHistory(); });
  await vi.waitFor(() => expect(host.querySelector("video")).not.toBeNull());
  expect(host.querySelector<HTMLButtonElement>('[aria-label="第 1 集"]')?.disabled).toBe(false);
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
  await vi.waitFor(() => expect(host.textContent).toContain(requestFailed));
  const watch = host.querySelector<HTMLElement>('[aria-labelledby="hongguo-watch-title"]')!;
  expect(watch.querySelector('[role="alert"]')?.textContent).toContain(requestFailed);
  expect(watch.textContent).not.toContain("这部短剧尚无剧集列表");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="第 1 集"]')?.disabled).toBe(true);
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
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="返回浏览"]')!.click(); });
  await act(async () => { button("Viewing history").click(); });
  await vi.waitFor(() => expect(host.textContent).toContain("Drama A"));
  await act(async () => { if (action === "delete") host.querySelector<HTMLButtonElement>('[aria-label="从观看历史中删除Drama A"]')!.click();
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
  await vi.waitFor(() => expect(host.querySelector('[aria-label="从观看历史中删除Drama A"]')).not.toBeNull());
  await act(async () => { if (action === "delete") host.querySelector<HTMLButtonElement>('[aria-label="从观看历史中删除Drama A"]')!.click();
    else button("Clear history").click(); });
  await act(async () => { document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button').item(1)!.click(); });
  await vi.waitFor(() => expect(history).toHaveLength(0));
  expect(historyActions.indexOf(action)).toBeGreaterThan(historyActions.lastIndexOf("save"));
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="返回浏览"]')!.click(); });
  await act(async () => { seriesButton().click(); });
  await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="第 2 集"]')).not.toBeNull());
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="第 2 集"]')!.click(); });
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

it("keeps already-playing Hongguo media running when hidden without reloading playback on return", async () => {
  playback = { appId: app.id, revision: 3, status: "ready", selectedQualityId: null, availableQualityIds: [],
    mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/synthetic?expectedRevision=3`, durationSeconds: 100 };
  await render();
  const video = await openPlayer();
  video.currentTime = 19;
  Object.defineProperty(video, "paused", { configurable: true, value: false });
  const before = fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback")).length;
  vi.mocked(HTMLMediaElement.prototype.pause).mockClear();
  fixture.visible = false;
  await render();
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  expect(video.paused).toBe(false);
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
const qualitySelect = () => host.querySelector<HTMLSelectElement>('[aria-label="清晰度"]')!;
const selectQuality = (id: string) => act(async () => {
  qualitySelect().value = id;
  qualitySelect().dispatchEvent(new Event("change", { bubbles: true }));
});

function completionReply() {
  return new Response(new Uint8Array([9]), { status: 206,
    headers: { "content-length": "1", "content-range": "bytes 9-9/10", "accept-ranges": "bytes" } });
}

function controlledNativeVideo(video: HTMLVideoElement, initiallyPaused: boolean, initialPosition = 31) {
  let duration = 65, position = initialPosition, paused = initiallyPaused, ready = 4, ended = false;
  let ranges: [number, number][] = [];
  const seeks: number[] = [];
  const pause = vi.fn(() => { const changed = !paused; paused = true; if (changed) video.dispatchEvent(new Event("pause")); });
  const play = vi.fn(async () => { paused = false; video.dispatchEvent(new Event("play")); });
  const load = vi.fn();
  const setAttribute = video.setAttribute.bind(video);
  const replaceSource = vi.fn((source: string) => {
    setAttribute("src", source);
    position = 0; duration = NaN; ready = 0; paused = true; ended = false; ranges = [];
    for (const name of ["pause", "timeupdate", "durationchange"]) video.dispatchEvent(new Event(name));
  });
  vi.spyOn(video, "setAttribute").mockImplementation((name, value) => {
    if (name === "src") replaceSource(value);
    else setAttribute(name, value);
  });
  Object.defineProperties(video, {
    duration: { configurable: true, get: () => duration }, paused: { configurable: true, get: () => paused },
    readyState: { configurable: true, get: () => ready }, ended: { configurable: true, get: () => ended },
    networkState: { configurable: true, value: video.NETWORK_IDLE },
    seekable: { configurable: true, get: () => ({ length: ranges.length, start: (index: number) => ranges[index]![0], end: (index: number) => ranges[index]![1] }) },
    currentTime: { configurable: true, get: () => position, set: (value: number) => { position = value; seeks.push(value); video.dispatchEvent(new Event("seeking")); } },
    load: { configurable: true, value: load }, play: { configurable: true, value: play }, pause: { configurable: true, value: pause },
  });
  return { load, replaceSource, play, pause, seeks,
    metadata() { duration = 108; ready = 4; ranges = [[0, 108]]; video.dispatchEvent(new Event("loadedmetadata")); },
    finish() { position = duration; ended = true; paused = true; video.dispatchEvent(new Event("ended")); },
  };
}

it.each([true, false])("completion keeps latest same-video intent when hidden, user paused=%s", async (paused) => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 108 };
  let release!: () => void;
  fixture.completion.mockImplementation(() => new Promise<Response>((resolve) => { release = () => resolve(completionReply()); }));
  await render();
  const video = await openPlayer(), source = video.getAttribute("src");
  const native = controlledNativeVideo(video, false);
  await act(async () => { video.dispatchEvent(new Event("play")); if (paused) video.pause(); });
  const before = fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback")).length;
  fixture.visible = false; await render();
  expect(host.querySelector("video")).toBe(video); expect(video.paused).toBe(paused);
  await act(async () => { release(); });
  await vi.waitFor(() => expect(native.replaceSource).toHaveBeenCalledExactlyOnceWith(`${source}&completed=1`));
  expect(host.querySelector("video")).toBe(video); expect(video.getAttribute("src")).toBe(`${source}&completed=1`);
  expect(native.load).not.toHaveBeenCalled();
  expect(video.paused).toBe(paused); expect(native.play).toHaveBeenCalledTimes(paused ? 0 : 1);
  expect(savePositions).not.toContain(0);
  await act(async () => { native.metadata(); });
  expect(video.currentTime).toBe(31); expect(video.paused).toBe(paused); expect(native.seeks).toEqual([31]);
  await act(async () => { video.dispatchEvent(new Event("loadedmetadata")); video.dispatchEvent(new Event("durationchange")); });
  expect(native.replaceSource).toHaveBeenCalledTimes(1); expect(native.seeks).toEqual([31]);
  await render();
  expect(video.getAttribute("src")).toBe(`${source}&completed=1`);
  expect(native.load).not.toHaveBeenCalled();
  expect(fixture.completion).toHaveBeenCalledTimes(1);
  expect(fixture.completion.mock.calls[0]![0]).toBe(source);
  expect(fixture.completion.mock.calls[0]![1]).toMatchObject({ headers: { Range: "bytes=-1" }, credentials: "same-origin" });
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(before);
  expect(document.fullscreenElement).toBeNull();
});

it.each([null, 23])("completion carries pending108/paused60 across reset with later user target %s", async (target) => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 108 };
  let release!: () => void;
  const raw = fixture.completion.getMockImplementation()!;
  fixture.completion.mockImplementation((path, init) => String(path).includes("/720p?")
    ? new Promise<Response>((resolve) => { release = () => resolve(completionReply()); }) : raw(path, init));
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => path.endsWith("/playback") && JSON.parse(init.body).qualityId
    ? { ...qualityPlayback("720p"), durationSeconds: 108 } : original(path, init));
  await render(); const first = await openPlayer();
  first.currentTime = 60; Object.defineProperty(first, "paused", { configurable: true, value: true });
  await selectQuality("720p");
  const video = host.querySelector("video")!, native = controlledNativeVideo(video, true, 0);
  await act(async () => { video.dispatchEvent(new Event("loadedmetadata")); });
  const source = video.getAttribute("src");
  expect(native.seeks).toEqual([]); expect(native.replaceSource).not.toHaveBeenCalled();
  await act(async () => { release(); });
  await vi.waitFor(() => expect(native.replaceSource).toHaveBeenCalledExactlyOnceWith(`${source}&completed=1`));
  expect(native.load).not.toHaveBeenCalled();
  expect(video.currentTime).toBe(0); expect(savePositions).not.toContain(0); expect(native.play).not.toHaveBeenCalled();
  if (target !== null) await act(async () => { video.currentTime = target; video.dispatchEvent(new Event("seeked")); });
  await act(async () => { native.metadata(); });
  expect(video.currentTime).toBe(target ?? 60); expect(video.paused).toBe(true); expect(native.seeks).toEqual([target ?? 60]);
  await act(async () => { video.dispatchEvent(new Event("durationchange")); video.dispatchEvent(new Event("loadedmetadata")); });
  expect(native.replaceSource).toHaveBeenCalledTimes(1); expect(native.seeks).toEqual([target ?? 60]); expect(savePositions).not.toContain(0);
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(2);
});

it("completion uses the pause selected after the observation and after reopen began", async () => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 108 };
  let release!: () => void;
  fixture.completion.mockImplementation(() => new Promise<Response>((resolve) => { release = () => resolve(completionReply()); }));
  await render(); const video = await openPlayer(), native = controlledNativeVideo(video, false);
  await act(async () => { video.dispatchEvent(new Event("play")); release(); });
  await vi.waitFor(() => expect(native.replaceSource).toHaveBeenCalledTimes(1));
  expect(native.play).toHaveBeenCalledTimes(1);
  await act(async () => { video.pause(); native.metadata(); });
  expect(video.paused).toBe(true); expect(video.currentTime).toBe(31); expect(native.play).toHaveBeenCalledTimes(1);
  expect(savePositions).not.toContain(0);
});

it("completion does not reopen a player already fully seekable", async () => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 100 };
  let release!: () => void;
  fixture.completion.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = () => resolve(completionReply()); }));
  const loads = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  await render(); const video = await openPlayer();
  await vi.waitFor(() => expect(fixture.completion).toHaveBeenCalledTimes(1));
  const source = video.getAttribute("src"), signal = fixture.completion.mock.calls[0]![1].signal as AbortSignal;
  expect(source).toBe(qualityPlayback("1080p").mediaUrl);
  await act(async () => { release(); });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(video.getAttribute("src")).toBe(source);
  expect(loads).not.toHaveBeenCalled(); expect(host.querySelector("video")).toBe(video);
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(1);
});

it("completion ignores an aborted old-quality response without touching the newer player", async () => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 108 };
  let release!: () => void, signal: AbortSignal | undefined;
  fixture.completion.mockImplementationOnce((_path, init) => new Promise<Response>((resolve) => {
    signal = init.signal; release = () => resolve(completionReply());
  }));
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => path.endsWith("/playback") && JSON.parse(init.body).qualityId
    ? { ...qualityPlayback("720p"), durationSeconds: 108 } : original(path, init));
  const loads = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  await render(); const old = await openPlayer(), oldSource = old.getAttribute("src");
  await selectQuality("720p");
  const current = host.querySelector("video")!;
  expect(current).not.toBe(old);
  expect(current.getAttribute("src")).toBe(qualityPlayback("720p").mediaUrl);
  await act(async () => { current.dispatchEvent(new Event("loadedmetadata")); });
  expect(fixture.completion).toHaveBeenCalledTimes(2);
  const currentSignal = fixture.completion.mock.calls[1]![1].signal as AbortSignal;
  expect(signal?.aborted).toBe(true);
  await act(async () => { release(); });
  expect(old.getAttribute("src")).toBe(oldSource);
  expect(host.querySelector("video")).toBe(current);
  expect(current.getAttribute("src")).toBe(qualityPlayback("720p").mediaUrl);
  expect(currentSignal.aborted).toBe(false);
  expect(loads).not.toHaveBeenCalled();
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(2);
});

it("completion does not advance on an early EOF and retains natural next after full duration", async () => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 108 };
  episodes = [episode, laterEpisode];
  let release!: () => void;
  fixture.completion.mockImplementation(() => new Promise<Response>((resolve) => { release = () => resolve(completionReply()); }));
  await render(); const video = await openPlayer(), native = controlledNativeVideo(video, false, 65);
  await act(async () => { video.dispatchEvent(new Event("play")); native.finish(); });
  expect(host.querySelector('[aria-label="第 1 集"]')?.getAttribute("aria-current")).toBe("true");
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(1);
  await act(async () => { release(); });
  await vi.waitFor(() => expect(native.replaceSource).toHaveBeenCalledTimes(1));
  expect(native.play).toHaveBeenCalledTimes(1);
  await act(async () => { native.metadata(); });
  expect(video.currentTime).toBe(65);
  await act(async () => { native.finish(); });
  await vi.waitFor(() => expect(host.querySelector('[aria-label="第 2 集"]')?.getAttribute("aria-current")).toBe("true"));
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(2);
});

it.each(["environment", "revision"])("completion cannot act after the current %s scope changes", async (scope) => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 108 };
  let release!: () => void, signal: AbortSignal | undefined;
  fixture.completion.mockImplementationOnce((_path, init) => new Promise<Response>((resolve) => {
    signal = init.signal; release = () => resolve(completionReply());
  }));
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => {
    const result = await original(path, init);
    return { ...result, revision: app.revision, ...(result.status === "ready"
      ? { mediaUrl: String(result.mediaUrl).replace("expectedRevision=3", `expectedRevision=${app.revision}`) } : {}) };
  });
  const loads = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  await render(); const old = await openPlayer(), oldSource = old.getAttribute("src");
  if (scope === "environment") storageKey = "another-completion-environment";
  else { app.revision = 4; state.revision = 4; }
  await render();
  const current = host.querySelector("video")!, currentSource = current.getAttribute("src");
  expect(current).not.toBe(old);
  expect(currentSource).toBe(`/api/mini-apps/${app.id}/hongguo/media/1080p?expectedRevision=${app.revision}`);
  await act(async () => { current.dispatchEvent(new Event("loadedmetadata")); });
  const playbackCalls = () => fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback")).length;
  const beforeRelease = playbackCalls();
  expect(fixture.completion).toHaveBeenCalledTimes(2);
  const currentSignal = fixture.completion.mock.calls[1]![1].signal as AbortSignal;
  expect(signal?.aborted).toBe(true);
  await act(async () => { release(); });
  expect(old.getAttribute("src")).toBe(oldSource);
  expect(host.querySelector("video")).toBe(current);
  expect(current.getAttribute("src")).toBe(currentSource);
  expect(currentSignal.aborted).toBe(false);
  expect(loads).not.toHaveBeenCalled();
  expect(playbackCalls()).toBe(beforeRelease);
});

it("completion failure releases its body without a load or preparation retry", async () => {
  playback = { ...qualityPlayback("1080p"), durationSeconds: 108 };
  let release!: (value: unknown) => void;
  fixture.completion.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  await render(); const video = await openPlayer(), native = controlledNativeVideo(video, true);
  const cancel = vi.fn(async () => {}), getReader = vi.fn();
  await act(async () => { release({ status: 200, headers: new Headers(), body: { cancel, getReader } }); });
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  await act(async () => { video.dispatchEvent(new Event("loadedmetadata")); });
  expect(getReader).not.toHaveBeenCalled(); expect(native.load).not.toHaveBeenCalled(); expect(native.replaceSource).not.toHaveBeenCalled();
  expect(fixture.completion).toHaveBeenCalledTimes(1);
  expect(fixture.api.mock.calls.filter(([path]) => String(path).endsWith("/playback"))).toHaveLength(1);
  expect(host.textContent).toContain(hongguoText("computer.miniApps.hongguo.playbackFailed"));
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
  expect(host.textContent).toContain("此清晰度暂不可用，继续播放当前视频。");
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
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="第 2 集"]')!.click());
  expect(signal?.aborted).toBe(true);
  const video = host.querySelector("video");
  await act(async () => { release(); });
  expect(host.querySelector("video")).toBe(video);
  expect(video?.src).toContain("/1080p?");
  expect(host.querySelector('[aria-label="第 2 集"]')?.getAttribute("aria-current")).toBe("true");
});

const nextResponse = (id: string, qualityId = "720p"): HongguoPlaybackResponse => ({ appId: app.id, revision: 3,
  status: "ready", mediaUrl: `/api/mini-apps/${app.id}/hongguo/media/${id}-${qualityId}?expectedRevision=3`, durationSeconds: 100,
  selectedQualityId: qualityId, availableQualityIds: ["1080p", "720p", "480p"] });

function sharedNextFixture(holdNext = false) {
  const original = fixture.api.getMockImplementation()!;
  const jobs = new Map<string, Promise<HongguoPlaybackResponse>>();
  let release!: () => void;
  const requests: Array<{ body: { episodeId: string; qualityId?: string; intent?: string }; signal: AbortSignal }> = [];
  fixture.api.mockImplementation(async (path, init) => {
    if (!path.endsWith("/playback")) return original(path, init);
    const body = JSON.parse(init.body);
    requests.push({ body, signal: init.signal });
    const key = `${body.expectedRevision}:${body.seriesId}:${body.episodeId}:${body.qualityId ?? "auto"}`;
    if (!jobs.has(key)) {
      const value = nextResponse(body.episodeId, body.qualityId ?? (body.episodeId === episode.id ? "1080p" : "720p"));
      jobs.set(key, holdNext && body.episodeId === laterEpisode.id
        ? new Promise((resolve) => { release = () => resolve(value); }) : Promise.resolve(value));
    }
    return jobs.get(key)!;
  });
  return { jobs, requests, release: () => release() };
}

it("prepares one next only after actual playing and naturally advances using the completed shared auto-quality work", async () => {
  episodes = [episode, laterEpisode];
  const backend = sharedNextFixture();
  await render();
  const first = await openPlayer();
  first.currentTime = 1;
  await act(async () => { first.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  expect(backend.requests).toHaveLength(1);
  await act(async () => {
    first.dispatchEvent(new Event("playing", { bubbles: true }));
    first.dispatchEvent(new Event("playing", { bubbles: true }));
  });
  expect(backend.requests).toHaveLength(2);
  expect(backend.requests[1]!.body).toMatchObject({ episodeId: laterEpisode.id, intent: "prefetch" });
  expect(backend.requests[1]!.body.qualityId).toBeUndefined();
  expect(host.querySelectorAll("video")).toHaveLength(1);
  await act(async () => { first.currentTime = 100; first.dispatchEvent(new Event("ended", { bubbles: true })); });
  await vi.waitFor(() => expect(host.querySelector("video")?.getAttribute("src")).toContain("episode_2-720p"));
  const next = host.querySelector("video")!;
  expect(next.autoplay).toBe(true);
  expect(host.querySelector('[aria-label="第 2 集"]')?.getAttribute("aria-current")).toBe("true");
  expect(backend.requests[2]!.body).toMatchObject({ episodeId: laterEpisode.id });
  expect(backend.requests[2]!.body.intent).toBeUndefined();
  expect(backend.requests[2]!.body.qualityId).toBeUndefined();
  expect(backend.jobs.size).toBe(2);
  expect(host.querySelectorAll("video")).toHaveLength(1);
});

it("joins an in-flight same-next preparation before detaching its speculative consumer", async () => {
  episodes = [episode, laterEpisode];
  const backend = sharedNextFixture(true);
  await render();
  const first = await openPlayer();
  await act(async () => { first.dispatchEvent(new Event("playing", { bubbles: true })); });
  const speculative = backend.requests[1]!.signal;
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="第 2 集"]')!.click(); });
  expect(backend.requests[2]!.body.intent).toBeUndefined();
  expect(speculative.aborted).toBe(false);
  expect(backend.jobs.size).toBe(2);
  await act(async () => { backend.release(); });
  await vi.waitFor(() => expect(host.querySelector("video")?.getAttribute("src")).toContain("episode_2-720p"));
  expect(speculative.aborted).toBe(true);
});

it("lets an explicit different foreground episode win over a late speculative result", async () => {
  const third = { ...laterEpisode, id: "episode_3", number: 3, title: "Third" };
  episodes = [episode, laterEpisode, third];
  const backend = sharedNextFixture(true);
  await render();
  const first = await openPlayer();
  await act(async () => { first.dispatchEvent(new Event("playing", { bubbles: true })); });
  const speculative = backend.requests[1]!.signal;
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="第 3 集"]')!.click(); });
  await vi.waitFor(() => expect(host.querySelector("video")?.getAttribute("src")).toContain("episode_3-720p"));
  expect(speculative.aborted).toBe(true);
  const foreground = host.querySelector("video");
  await act(async () => { backend.release(); });
  expect(host.querySelector("video")).toBe(foreground);
  expect(host.querySelector('[aria-label="第 3 集"]')?.getAttribute("aria-current")).toBe("true");
});

it("abandons old-quality speculation and carries an explicit quality through the same next episode", async () => {
  episodes = [episode, laterEpisode];
  const backend = sharedNextFixture();
  await render();
  const first = await openPlayer();
  Object.defineProperty(first, "paused", { configurable: true, value: false });
  await act(async () => { first.dispatchEvent(new Event("playing", { bubbles: true })); });
  const old = backend.requests[1]!.signal;
  await selectQuality("720p");
  expect(old.aborted).toBe(true);
  const changed = host.querySelector("video")!;
  Object.defineProperty(changed, "duration", { configurable: true, value: 100 });
  await act(async () => { changed.dispatchEvent(new Event("loadedmetadata", { bubbles: true })); changed.dispatchEvent(new Event("playing", { bubbles: true })); });
  const prefetched = backend.requests.find(({ body }) => body.intent === "prefetch" && body.qualityId === "720p");
  expect(prefetched?.body.episodeId).toBe(laterEpisode.id);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="第 2 集"]')!.click(); });
  await vi.waitFor(() => expect(host.querySelector("video")?.getAttribute("src")).toContain("episode_2-720p"));
  expect(backend.requests.at(-1)!.body).toMatchObject({ episodeId: laterEpisode.id, qualityId: "720p" });
  expect(backend.requests.at(-1)!.body.intent).toBeUndefined();
});

it.each(["unavailable", "unknown"] as const)("does not speculate across the immediate %s episode", async (availability) => {
  episodes = [episode, { ...laterEpisode, availability }, { ...laterEpisode, id: "episode_3", number: 3 }];
  const backend = sharedNextFixture();
  await render();
  const first = await openPlayer();
  await act(async () => { first.dispatchEvent(new Event("playing", { bubbles: true })); });
  expect(backend.requests).toHaveLength(1);
});

it.each(["failure", "unavailable"] as const)("keeps speculative %s nonblocking without retrying buffering or repeated playing events", async (outcome) => {
  episodes = [episode, laterEpisode];
  const original = fixture.api.getMockImplementation()!;
  const requests: string[] = [];
  fixture.api.mockImplementation(async (path, init) => {
    if (!path.endsWith("/playback")) return original(path, init);
    const body = JSON.parse(init.body);
    requests.push(body.intent ?? "foreground");
    if (body.intent) {
      if (outcome === "failure") throw new Error("Synthetic optional preparation failure");
      return { appId: app.id, revision: 3, status: "unavailable", reason: "provider-unavailable" };
    }
    return nextResponse(body.episodeId, "1080p");
  });
  await render();
  const first = await openPlayer();
  await act(async () => { first.dispatchEvent(new Event("playing", { bubbles: true })); });
  await act(async () => { first.dispatchEvent(new Event("playing", { bubbles: true })); });
  expect(requests).toEqual(["foreground", "prefetch"]);
  expect(host.querySelector("video")).toBe(first);
  expect(host.querySelector('[aria-labelledby="hongguo-watch-title"] [role="alert"]')).toBeNull();
});

it("cancels old-revision speculation and rejects its late result after the current app scope changes", async () => {
  episodes = [episode, laterEpisode];
  const backend = sharedNextFixture(true);
  const sharing = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => {
    const body = JSON.parse(init.body);
    const result = await sharing(path, init);
    return { ...result, revision: body.expectedRevision,
      ...(result.status === "ready" ? { mediaUrl: result.mediaUrl.replace("expectedRevision=3", `expectedRevision=${body.expectedRevision}`) } : {}) };
  });
  await render();
  const first = await openPlayer();
  await act(async () => { first.dispatchEvent(new Event("playing", { bubbles: true })); });
  const speculative = backend.requests[1]!.signal;
  app.revision = 4; state.revision = 4;
  await render();
  await vi.waitFor(() => expect(host.querySelector("video")?.getAttribute("src")).toContain("expectedRevision=4"));
  expect(speculative.aborted).toBe(true);
  const current = host.querySelector("video");
  await act(async () => { backend.release(); });
  expect(host.querySelector("video")).toBe(current);
  expect(current?.getAttribute("src")).toContain("episode_1");
});

it("restores a paused quality seek after growing duration becomes known only once and never overwrites a later user seek", async () => {
  playback = qualityPlayback("1080p");
  const original = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation(async (path, init) => path.endsWith("/playback") && JSON.parse(init.body).qualityId
    ? { ...qualityPlayback("720p"), durationSeconds: 108 } : original(path, init));
  await render();
  const first = await openPlayer();
  first.currentTime = 60;
  Object.defineProperty(first, "paused", { configurable: true, value: true });
  await selectQuality("720p");
  const next = host.querySelector("video")!;
  let duration = Infinity, position = 0;
  const seek = vi.fn((value: number) => { position = value; });
  Object.defineProperty(next, "duration", { configurable: true, get: () => duration });
  Object.defineProperty(next, "networkState", { configurable: true, value: next.NETWORK_IDLE });
  Object.defineProperty(next, "currentTime", { configurable: true, get: () => position, set: seek });
  await act(async () => { next.dispatchEvent(new Event("loadedmetadata", { bubbles: true })); });
  expect(next.autoplay).toBe(false);
  expect(seek).not.toHaveBeenCalled();
  duration = 2; position = 2;
  await act(async () => { next.dispatchEvent(new Event("durationchange", { bubbles: true })); next.dispatchEvent(new Event("timeupdate", { bubbles: true })); });
  expect(seek).not.toHaveBeenCalled();
  expect(savePositions).not.toContain(2);
  duration = 108;
  await act(async () => { next.dispatchEvent(new Event("durationchange", { bubbles: true })); });
  expect(seek).toHaveBeenCalledExactlyOnceWith(60);
  position = 45;
  await act(async () => { next.dispatchEvent(new Event("seeking", { bubbles: true })); next.dispatchEvent(new Event("seeked", { bubbles: true })); });
  duration = 120;
  await act(async () => { next.dispatchEvent(new Event("durationchange", { bubbles: true })); next.dispatchEvent(new Event("loadedmetadata", { bubbles: true })); });
  expect(seek).toHaveBeenCalledTimes(1);
  expect(next.currentTime).toBe(45);
});

it.each([
  [{ heat: 1_200_000, playCount: 34_000_000 }, "120万", "3400万"],
  [{ heat: 0, playCount: 0 }, "0", "0"],
  [{}, null, null],
  [{ heat: null, playCount: null }, null, null],
])("shows the same sourced metric hierarchy on home and detail without inventing values: %j", async (values, heatLabel, viewsLabel) => {
  metrics = values;
  catalogCard = { ...card, ...values };
  await render();
  const homeMetrics = seriesButton().querySelector('[data-hongguo-metrics]');
  if (heatLabel !== null) {
    expect(homeMetrics?.querySelector('[data-hongguo-metric="heat"]')?.textContent).toBe(heatLabel);
    expect(homeMetrics?.querySelector('[data-hongguo-metric="playCount"]')?.textContent).toBe(viewsLabel);
    expect(homeMetrics?.querySelector("dt")?.classList.contains("text-ink-secondary")).toBe(true);
    const value = homeMetrics!.querySelector("dd")!;
    for (const token of ["font-semibold", "text-ink", "tabular-nums"]) expect(value.classList.contains(token)).toBe(true);
  } else expect(homeMetrics).toBeNull();
  await act(async () => { seriesButton().click(); });
  const header = host.querySelector('[aria-labelledby="hongguo-watch-title"] header')!;
  expect(header.querySelector('[data-hongguo-metric="heat"]')?.textContent ?? null).toBe(heatLabel);
  expect(header.querySelector('[data-hongguo-metric="playCount"]')?.textContent ?? null).toBe(viewsLabel);
});

it("keeps all owned navigation Chinese inside an English host and retains tab order", async () => {
  await render();
  expect(activeLocale()).toBe("en");
  expect(document.documentElement.lang).toBe("en");
  expect(hostText("engines.cloud")).toBe("Cloud");
  expect(host.querySelector('[data-testid="hongguo-view"]')?.getAttribute("lang")).toBe("zh-CN");
  expect(host.querySelector("h2")?.textContent).toBe("红果");
  const tabs = host.querySelector('[aria-labelledby="hongguo-catalog-title"] > div')!;
  expect([...tabs.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["热门", "最新", "最热", "最多播放"]);
  expect(host.textContent).not.toContain("当前列表");
  await act(async () => { button("最热").click(); });
  expect(host.textContent).toContain("当前列表");
  expect(activeLocale()).toBe("en");
});

it("sorts the matching category and appended pages without new requests or per-card detail fanout", async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const original = fixture.api.getMockImplementation()!;
  const row = (id: string, heat?: number | null, playCount?: number | null) => ({ ...card, id, title: id, heat, playCount });
  fixture.api.mockImplementation(async (path, init) => {
    if (!path.endsWith("/catalog")) return original(path, init);
    const body = JSON.parse(init.body);
    const scope = { appId: app.id, revision: 3, categories: [{ id: "family", title: "家庭" }] };
    if (body.mode === "categories") return { ...scope, items: [], nextCursor: null };
    if (body.mode !== "category") return { ...scope, items: [catalogCard], nextCursor: null };
    expect(body.categoryId).toBe("family");
    if (body.cursor === "third") return { ...scope, items: [row("last", 500, 500)], nextCursor: null };
    if (body.cursor === "second") {
      await hold;
      return { ...scope, items: [row("ten", 999, 999), row("largest", 100, 3), row("tie", 10, 2)], nextCursor: "third" };
    }
    return { ...scope, items: [row("missing"), row("two", 2, 100), row("ten", 10, 2)], nextCursor: "second" };
  });
  const titles = () => [...host.querySelectorAll('[aria-labelledby="hongguo-catalog-title"] .grid > button')]
    .map((item) => item.querySelector("span")?.textContent);
  await render();
  await act(async () => { button("家庭").click(); });
  const calls = fixture.api.mock.calls.length;
  await act(async () => { button("最热").click(); });
  expect(titles()).toEqual(["ten", "two", "missing"]);
  expect(fixture.api.mock.calls).toHaveLength(calls);
  await act(async () => { release(); });
  expect(titles()).toEqual(["largest", "ten", "tie", "two", "missing"]);
  const afterFill = fixture.api.mock.calls.length;
  await act(async () => { button("最多播放").click(); });
  expect(titles()).toEqual(["two", "largest", "ten", "tie", "missing"]);
  expect(fixture.api.mock.calls).toHaveLength(afterFill);
  await act(async () => { button("Load more").click(); });
  expect(titles()).toEqual(["last", "two", "largest", "ten", "tie", "missing"]);
  expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/series"))).toBe(false);
});

it("sorts the current search without dropping its query or issuing another catalog request", async () => {
  await render();
  const input = host.querySelector<HTMLInputElement>('[aria-label="搜索剧名"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "家庭");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  const search = fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/catalog") && JSON.parse(String(init.body)).mode === "search");
  expect(search).toHaveLength(1);
  expect(JSON.parse(String(search[0]![1].body)).query).toBe("家庭");
  const before = fixture.api.mock.calls.length;
  await act(async () => { button("最热").click(); });
  expect(fixture.api.mock.calls).toHaveLength(before);
  expect(input.value).toBe("家庭");
  expect(host.textContent).toContain("“家庭”的搜索结果");
  expect(host.textContent).toContain("当前列表");
});

it.each([500, 5000])("hydrates a %sms late success and appended cards into the current sort without renewing catalog freshness", async (delay) => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const original = fixture.api.getMockImplementation()!;
  const row = (id: string, title: string) => ({ ...card, id, title });
  fixture.api.mockImplementation(async (path, init) => {
    if (!path.endsWith("/catalog")) return original(path, init);
    const body = JSON.parse(init.body);
    const scope = { appId: app.id, revision: 3, categories: [], nextCursor: null };
    if (body.mode === "categories") return { ...scope, items: [] };
    if (body.mode === "metrics") {
      const readyAt = Math.max(...body.seriesIds.map((id: string) => 1_000_000 + delay + (id === "10" ? 0 : 600)));
      if (readyAt > Date.now()) await new Promise((resolve) => setTimeout(resolve, readyAt - Date.now()));
      const available = (id: string) => Date.now() >= 1_000_000 + delay + (id === "10" ? 0 : 600);
      return { ...scope, items: [], metricUpdates: body.seriesIds.filter(available).map((id: string) => ({
        id, heat: id === "10" ? 2 : 10, playCount: id === "10" ? 20 : 100,
      })), pendingMetricIds: body.seriesIds.filter((id: string) => !available(id)) };
    }
    if (body.cursor === "later") {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { ...scope, items: [row("20", "合成乙")], pendingMetricIds: ["20"] };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ...scope, items: [row("10", "合成甲"), row("50", "未知指标")], nextCursor: "later", pendingMetricIds: ["10"] };
  });
  const titles = () => [...host.querySelectorAll('[aria-labelledby="hongguo-catalog-title"] .grid > button')]
    .map((item) => item.querySelector("span")?.textContent);
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(titles()).toEqual(["合成甲", "未知指标"]);
  expect(host.querySelector('[data-hongguo-metrics]')).toBeNull();
  await act(async () => { button("最热").click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(host.querySelector('[data-hongguo-metric="heat"]')?.textContent ?? null).toBe(delay === 500 ? "2" : null);
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(titles()).toEqual(["合成甲", "未知指标", "合成乙"]);
  expect(host.querySelector('[data-hongguo-metric="heat"]')?.textContent ?? null).toBe(delay === 500 ? "2" : null);
  await act(async () => { await vi.advanceTimersByTimeAsync(Math.max(300, delay + 600 - 900)); });
  expect(titles()).toEqual(["合成乙", "合成甲", "未知指标"]);
  const readbacks = fixture.api.mock.calls.filter(([path, init]) => String(path).endsWith("/catalog") && JSON.parse(String(init.body)).mode === "metrics");
  expect(readbacks).toHaveLength(2);
  expect(popularCalls()).toBe(1);
  expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/series"))).toBe(false);
  await act(async () => { root.render(null); });
  vi.setSystemTime(1_000_000 + 300 + 5 * 60_000 - 1);
  await render();
  expect(titles()).toEqual(["合成乙", "合成甲", "未知指标"]);
  expect(popularCalls()).toBe(1);
  await act(async () => { root.render(null); });
  vi.setSystemTime(1_000_000 + 300 + 5 * 60_000);
  await render();
  expect(popularCalls()).toBe(2);
});

it("retains metric sorting in a cached revisit without extending the original five-minute freshness", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  await render();
  vi.setSystemTime(1_000_000 + 4 * 60_000);
  const before = popularCalls();
  await act(async () => { button("最多播放").click(); });
  expect(popularCalls()).toBe(before);
  await act(async () => { root.render(null); });
  await render();
  expect(button("最多播放").getAttribute("aria-pressed")).toBe("true");
  expect(popularCalls()).toBe(before);
  await act(async () => { root.render(null); });
  vi.setSystemTime(1_000_000 + 5 * 60_000);
  await render();
  expect(popularCalls()).toBe(before + 1);
});
