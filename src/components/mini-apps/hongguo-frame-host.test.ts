// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Window as HappyWindow } from "happy-dom";
import type { HongguoFrameReply } from "../../../shared/hongguo-frame";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { isManagedHongguoDocument, mountManagedHongguoFrame } from "./hongguo-frame-host";
import { HONGGUO_FRAME_SDK_SOURCE } from "./hongguo-frame-sdk";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/api", async (original) => ({ ...await original<object>(), api: mocks.api }));

const release = { packageId: "mashellhan.hongguo", requires: ["hongguo-v1"], appVersion: "0.1.0", sourceCommit: "a".repeat(40),
  tag: "mini-app/hongguo/v0.1.0", htmlSha256: "b".repeat(64), htmlBytes: 16, queriesSha256: "c".repeat(64), queriesBytes: 173 };
const app = { id: "11111111-1111-4111-8111-111111111111", slug: "hongguo", title: "Synthetic Hongguo", description: "Fixture",
  revision: 3, templateVersion: 4, status: "active" as const, nativeKind: "hongguo" as const, nativeIdentity: "hongguo" as const,
  publisherBotIds: [], createdAt: 1, updatedAt: 1, release };
const miniApp: MiniAppDocument = { app, html: "<p>Synthetic</p>", bindings: [], versions: [] };
const identity = { appId: app.id, revision: app.revision };
const root = `/api/mini-apps/${app.id}/hongguo/`;
const coverUrl = "https://p3-reading-sign.fqnovelpic.com/synthetic.jpg";
const card = { id: "series", title: "Synthetic series", coverUrl, summary: null, episodeCount: 1 };
const series = { ...card, episodes: [{ id: "episode", number: 1, title: "Synthetic episode", availability: "available", imageUrl: null }] };
const bounds = { x: -40, y: 80, width: 400, height: 300 };
let fixture: ReturnType<typeof mount> | undefined;

function mount(document: MiniAppDocument = miniApp) {
  const container = window.document.createElement("div");
  container.style.position = "static";
  const iframe = window.document.createElement("iframe");
  iframe.srcdoc = document.html;
  Object.defineProperties(iframe, { clientWidth: { value: 320 }, clientHeight: { value: 360 } });
  container.append(iframe);
  window.document.body.append(container);
  const frame = iframe.contentWindow!;
  const posted = vi.spyOn(frame, "postMessage").mockImplementation(() => {});
  const onRefused = vi.fn();
  let isInitialized = true;
  let state: MiniAppState = { ...identity, templateVersion: app.templateVersion, status: "active", data: [] };
  const host = mountManagedHongguoFrame({ container, iframe, document, getState: () => state, onRefused,
    isInitialized: () => isInitialized, visible: true, refreshKey: 0 });
  let next = 0;
  const send = (operation: string, input: unknown, { source = frame, origin = "null" } = {}) => {
    const id = `hongguo:${++next}`;
    window.dispatchEvent(new MessageEvent("message", { source, origin, data: { mausMiniApp: 1, type: "hongguo-request", id, operation, input } }));
    return id;
  };
  const reply = (id: string) => posted.mock.calls.map(([value]) => value as HongguoFrameReply).find(message => message.id === id);
  const wait = async (id: string) => {
    await vi.waitFor(() => expect(reply(id)).toBeDefined(), { timeout: 500, interval: 5 });
    return reply(id)!;
  };
  const video = () => container.querySelector("video");
  return { host, container, iframe, frame, send, wait, reply, video, posted, onRefused,
    initialize(value: boolean) { isInitialized = value; }, state(next: MiniAppState) { state = next; } };
}

beforeEach(() => {
  vi.stubGlobal("ogb", { app: { ownPage: true, blocksOpaqueFrameNavigation: true } });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  mocks.api.mockReset().mockImplementation(async (path: string) => {
    if (path === `${root}series`) return { ...identity, series };
    if (path === `${root}catalog`) return { ...identity, items: [card], categories: [], nextCursor: null };
    if (path === `${root}playback`) return { ...identity, status: "ready", mediaUrl: `${root}media/token?expectedRevision=3`,
      durationSeconds: 100, selectedQualityId: "1080p", availableQualityIds: ["1080p", "720p"] };
    return { ...identity, entries: [], autoplayNext: true };
  });
});
afterEach(() => { fixture?.host.retire(); fixture?.container.remove(); fixture = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function readyId(message: HongguoFrameReply): string {
  expect(message).toMatchObject({ result: { status: "ready", playbackId: expect.any(String) } });
  expect(JSON.stringify(message)).not.toContain("mediaUrl");
  expect(JSON.stringify(message)).not.toContain("/media/token");
  return (message as { result: { playbackId: string } }).result.playbackId;
}

it("binds requests to the initialized opaque frame, managed identity and current revision", async () => {
  expect(isManagedHongguoDocument(miniApp)).toBe(true);
  expect(isManagedHongguoDocument({ ...miniApp, app: { ...app, nativeKind: null } })).toBe(false);
  fixture = mount();
  fixture.initialize(false);
  const early = fixture.send("catalog", { mode: "popular" });
  fixture.initialize(true);
  const wrongOrigin = fixture.send("catalog", { mode: "popular" }, { origin: "https://fixture.invalid" });
  const wrongSender = fixture.send("catalog", { mode: "popular" }, { source: window });
  expect([fixture.reply(early), fixture.reply(wrongOrigin), fixture.reply(wrongSender)]).toEqual([undefined, undefined, undefined]);
  expect(mocks.api).not.toHaveBeenCalled();
  await expect(fixture.wait(fixture.send("other", {}))).resolves.toMatchObject({ error: { status: 400 } });
  await expect(fixture.wait(fixture.send("catalog", { mode: "popular", expectedRevision: 7 }))).resolves.toMatchObject({ error: { status: 400 } });
  await expect(fixture.wait(fixture.send("catalog", { mode: "popular", query: "a".repeat(16_384) }))).resolves.toMatchObject({ error: { status: 413 } });
  await expect(fixture.wait(fixture.send("catalog", { mode: "popular" }))).resolves.toMatchObject({ result: { items: [card] } });
  expect(mocks.api).toHaveBeenLastCalledWith(`${root}catalog`, expect.objectContaining({ body: JSON.stringify({ mode: "popular", expectedRevision: 3 }) }));
  fixture.state({ ...identity, revision: 4, templateVersion: 5, status: "active", data: [] });
  fixture.host.update({ visible: true, refreshKey: 0 });
  await expect(fixture.wait(fixture.send("catalog", { mode: "popular" }))).resolves.toMatchObject({ error: { status: 409 } });
  expect(mocks.api).toHaveBeenCalledTimes(1);
});

it("admits only remembered cover addresses and aborts their bounded reads on hide", async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  fixture = mount();
  await expect(fixture.wait(fixture.send("cover", { seriesId: "series", coverUrl }))).resolves.toMatchObject({ error: { status: 400 } });
  expect(fetcher).not.toHaveBeenCalled();
  await fixture.wait(fixture.send("catalog", { mode: "popular" }));
  fetcher.mockResolvedValueOnce(new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg", "content-length": "4" } }));
  await expect(fixture.wait(fixture.send("cover", { seriesId: "series", coverUrl }))).resolves.toMatchObject({ result: { mimeType: "image/jpeg", bytes: expect.any(ArrayBuffer) } });
  expect(fetcher).toHaveBeenLastCalledWith(`${root}cover?${new URLSearchParams({ expectedRevision: "3", url: coverUrl })}`,
    expect.objectContaining({ redirect: "error", credentials: "same-origin" }));
  fetcher.mockResolvedValueOnce(new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { "content-type": "image/jpeg", "content-length": "1048577" } }));
  await expect(fixture.wait(fixture.send("cover", { seriesId: "series", coverUrl }))).resolves.toMatchObject({ error: { status: 413 } });
  fetcher.mockResolvedValueOnce(new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0]), { headers: { "content-type": "image/jpeg", "content-length": "4" } }));
  await expect(fixture.wait(fixture.send("cover", { seriesId: "series", coverUrl }))).resolves.toMatchObject({ error: { status: 413 } });
  fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason))));
  const pending = fixture.send("cover", { seriesId: "series", coverUrl });
  fixture.host.update({ visible: false, refreshKey: 0 });
  await expect(fixture.wait(pending)).resolves.toMatchObject({ error: { aborted: true } });
  expect(fetcher.mock.lastCall?.[1]?.signal?.aborted).toBe(true);
  await expect(fixture.wait(fixture.send("context", {}))).resolves.toMatchObject({ result: { ...identity, visible: false, refreshKey: 0 } });
});

it("keeps media sources in the Host, clips bounds, restores quality and only saves native observations", async () => {
  const fetcher = vi.fn(async () => new Response(Uint8Array.from([1]), { status: 206,
    headers: { "content-length": "1", "content-range": "bytes 9-9/10", "accept-ranges": "bytes" } }));
  vi.stubGlobal("fetch", fetcher);
  fixture = mount();
  const request = { seriesId: "series", episodeId: "episode" };
  await expect(fixture.wait(fixture.send("playback", request))).resolves.toMatchObject({ error: { status: 400 } });
  await fixture.wait(fixture.send("series", { seriesId: "series" }));
  const playbackId = readyId(await fixture.wait(fixture.send("playback", request)));
  await expect(fixture.wait(fixture.send("player.attach", { playbackId, bounds: { ...bounds, width: Infinity } }))).resolves.toMatchObject({ error: { status: 400 } });
  await fixture.wait(fixture.send("player.attach", { playbackId, bounds }));
  const first = fixture.video()!;
  expect(first.getAttribute("src")).toBe(`${root}media/token?expectedRevision=3`);
  expect(first.parentElement?.style.overflow).toBe("hidden");
  expect(first.parentElement?.style.width).toBe("320px");
  expect(first.style.left).toBe("-40px");
  await fixture.wait(fixture.send("player.setBounds", { playbackId, bounds: { ...bounds, y: 115 } }));
  expect(first.style.top).toBe("115px");
  const snapshot = { positionSeconds: 28, durationSeconds: 100, paused: true };
  Object.defineProperties(first, { duration: { value: 100 }, currentTime: { value: 28 }, paused: { value: true }, seekable: { value: { length: 1, start: () => 0, end: () => 100 } } });
  first.dispatchEvent(new Event("loadedmetadata"));
  first.dispatchEvent(new Event("seeked"));
  await vi.waitFor(() => expect(fixture!.posted).toHaveBeenCalledWith(expect.objectContaining({ event: { type: "complete", playbackId, ...snapshot } }), "*"));
  expect(fetcher).toHaveBeenCalledWith(`${root}media/token?expectedRevision=3`, expect.objectContaining({ headers: { Range: "bytes=-1" } }));
  await fixture.wait(fixture.send("history", { action: "save", entry: { ...request, seriesTitle: "Forged", positionSeconds: 80 } }));
  expect(JSON.parse(mocks.api.mock.lastCall?.[1].body)).toEqual({ expectedRevision: 3, action: "save", entry: { ...request,
    coverUrl, seriesTitle: series.title, episodeNumber: 1, episodeTitle: series.episodes[0]!.title, positionSeconds: 28, durationSeconds: 100 } });
  const replacementId = readyId(await fixture.wait(fixture.send("playback", { ...request, qualityId: "720p" })));
  await fixture.wait(fixture.send("player.detach", { playbackId }));
  expect(first.isConnected).toBe(false);
  await fixture.wait(fixture.send("player.attach", { playbackId: replacementId, bounds,
    restore: { kind: "quality", fromPlaybackId: playbackId, positionSeconds: 26, paused: false } }));
  const current = fixture.video()!;
  expect(current.autoplay).toBe(false);
  Object.defineProperties(current, { duration: { value: 100 }, currentTime: { writable: true, value: 0 }, seekable: { value: { length: 1, start: () => 0, end: () => 100 } } });
  current.dispatchEvent(new Event("loadedmetadata"));
  expect(current.currentTime).toBe(28);
  await expect(fixture.wait(fixture.send("player.setBounds", { playbackId, bounds }))).resolves.toMatchObject({ error: { status: 412 } });
  fixture.host.update({ visible: false, refreshKey: 0 });
  expect(fixture.video()).toBe(null);
  expect(current.getAttribute("src")).toBe(null);
  fixture.host.update({ visible: true, refreshKey: 0 });
  await expect(fixture.wait(fixture.send("player.attach", { playbackId: replacementId, bounds }))).resolves.toMatchObject({ error: { status: 412 } });
});

it("requires a current user gesture for deleting private history and invalidates on denial", async () => {
  fixture = mount();
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: false } });
  try {
    await expect(fixture.wait(fixture.send("history", { action: "clear" }))).resolves.toMatchObject({ error: { status: 412 } });
    expect(mocks.api).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
    await expect(fixture.wait(fixture.send("history", { action: "clear" }))).resolves.toMatchObject({ result: { entries: [] } });
    mocks.api.mockResolvedValueOnce({ ...identity, revision: 4 });
    await expect(fixture.wait(fixture.send("history", { action: "list" }))).resolves.toMatchObject({ error: { status: 409 } });
    expect(fixture.onRefused).toHaveBeenCalledExactlyOnceWith(409);
  } finally { Reflect.deleteProperty(navigator, "userActivation"); }
});

it("exposes named SDK requests and cancels them on a local abort or host teardown", async () => {
  const child = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const parent = {};
  try {
    Object.defineProperty(child, "parent", { value: parent });
    child.eval(`var base = { markReady: function () {} }, ready = Promise.resolve(), sent = [], post = (value) => sent.push(value); ${HONGGUO_FRAME_SDK_SOURCE}`);
    const { sent, base } = child as unknown as { sent: Array<Record<string, unknown>>; base: { getContext(): Promise<unknown>;
      hongguo: { catalog(input: object, options?: { signal: AbortSignal }): Promise<unknown> } } };
    const reply = (data: unknown) => child.dispatchEvent(new child.MessageEvent("message", { source: parent as HappyWindow, data }));
    const context = base.getContext();
    await vi.waitFor(() => expect(sent[0]).toMatchObject({ operation: "context" }));
    reply({ mausMiniApp: 1, type: "hongguo-result", id: sent[0]!.id, result: { ...identity, visible: true, refreshKey: 0 } });
    await expect(context).resolves.toMatchObject({ ...identity, visible: true });
    const controller = new AbortController();
    const read = base.hongguo.catalog({ mode: "popular" }, { signal: controller.signal });
    await vi.waitFor(() => expect(sent[1]).toMatchObject({ operation: "catalog", input: { mode: "popular" } }));
    controller.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    expect(sent[2]).toEqual({ mausMiniApp: 1, type: "hongguo-cancel", id: sent[1]!.id });
    const outstanding = base.hongguo.catalog({ mode: "popular" });
    await vi.waitFor(() => expect(sent[3]).toBeDefined());
    reply({ jsonrpc: "2.0", method: "ui/resource-teardown" });
    await expect(outstanding).rejects.toMatchObject({ name: "AbortError" });
  } finally { await child.happyDOM.close(); }
});

it("preserves the player and SDK visibility across macOS fullscreen visibility transitions", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  let fullscreen: Element | null = null;
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => visibility });
  Object.defineProperty(window.document, "fullscreenElement", { configurable: true, get: () => fullscreen });
  try {
    fixture = mount();
    await fixture.wait(fixture.send("series", { seriesId: "series" }));
    const playbackId = readyId(await fixture.wait(fixture.send("playback", { seriesId: "series", episodeId: "episode" })));
    await fixture.wait(fixture.send("player.attach", { playbackId, bounds: { x: 0, y: 0, width: 320, height: 180 } }));
    const video = fixture.video()!;
    video.requestFullscreen = vi.fn(async () => {
      fullscreen = video;
      window.document.dispatchEvent(new Event("fullscreenchange"));
    });
    await expect(fixture.wait(fixture.send("player.fullscreen", { playbackId }))).resolves.toMatchObject({ result: null });
    expect(fixture.posted).toHaveBeenCalledWith({ mausMiniApp: 1, type: "hongguo-fullscreen", active: true }, "*");
    expect(video.style.borderRadius).toBe("0px");
    visibility = "hidden";
    window.document.dispatchEvent(new Event("visibilitychange"));
    expect(fixture.video()).toBe(video);
    expect(video.parentElement?.hidden).toBe(false);
    visibility = "visible";
    window.document.dispatchEvent(new Event("visibilitychange"));
    fullscreen = null;
    window.document.dispatchEvent(new Event("fullscreenchange"));
    expect(video.style.borderRadius).toBe("12px");
    // Trailing visibility flicker on macOS exit does not retire the player.
    visibility = "hidden";
    window.document.dispatchEvent(new Event("visibilitychange"));
    expect(fixture.video()).toBe(video);
    visibility = "visible";
    window.document.dispatchEvent(new Event("visibilitychange"));
    expect(fixture.posted).toHaveBeenCalledWith({ mausMiniApp: 1, type: "hongguo-fullscreen", active: false }, "*");
    // Genuine hide after transition still retires the player.
    visibility = "hidden";
    window.document.dispatchEvent(new Event("visibilitychange"));
    expect(fixture.video()).toBe(null);
  } finally {
    vi.useRealTimers();
    Reflect.deleteProperty(window.document, "visibilityState");
    Reflect.deleteProperty(window.document, "fullscreenElement");
  }
});

it("keeps child iframe visibilityState visible while host fullscreen guard is active", async () => {
  const child = new HappyWindow({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  const parent = {};
  let rawVis = "visible";
  Object.defineProperty(child.Document.prototype, "visibilityState", { configurable: true, get: () => rawVis });
  Object.defineProperty(child.Document.prototype, "hidden", { configurable: true, get: () => rawVis === "hidden" });
  try {
    Object.defineProperty(child, "parent", { value: parent });
    child.eval(`var base = { markReady: function () {} }, ready = Promise.resolve(), sent = [], post = (value) => sent.push(value); ${HONGGUO_FRAME_SDK_SOURCE}`);
    let seen = 0;
    child.document.addEventListener("visibilitychange", () => { seen++; });
    const { base, sent } = child as unknown as { sent: Array<{ id: string }>; base: { hongguo: { player: { fullscreen(input: unknown): Promise<unknown> } } } };
    const reply = (data: unknown) => child.dispatchEvent(new child.MessageEvent("message", { source: parent as HappyWindow, data }));
    const pending = base.hongguo.player.fullscreen({ playbackId: "p1" });
    rawVis = "hidden";
    child.document.dispatchEvent(new child.Event("visibilitychange"));
    expect(child.document.visibilityState).toBe("visible");
    expect(child.document.hidden).toBe(false);
    expect(seen).toBe(0);
    await vi.waitFor(() => expect(sent[0]).toBeDefined());
    reply({ mausMiniApp: 1, type: "hongguo-result", id: sent[0]!.id, result: null });
    await pending;
    reply({ mausMiniApp: 1, type: "hongguo-fullscreen", active: false });
    expect(child.document.visibilityState).toBe("hidden");
    expect(seen).toBe(1);
  } finally { await child.happyDOM.close(); }
});
