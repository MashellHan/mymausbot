import * as githubMediaModule from "../github-activity/media.ts";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import { HongguoCovers } from "../hongguo/cover.ts";
import { appFailure } from "../mini-apps/validation.ts";
import { createMiniAppRoutes, createMiniAppsInternalRoutes } from "./mini-apps.ts";

it("rejects local Mini App writes before reading a write-disallowed turn", async () => {
  const deps = {
    localEnabled: () => true,
    bots: () => [{ id: "producer", name: "Producer" }],
  } as unknown as Parameters<typeof createMiniAppsInternalRoutes>[0];
  const route = createMiniAppsInternalRoutes(deps);
  const response = {} as ServerResponse;
  const json = vi.fn();
  const readBody = vi.fn(async () => ({}));
  const requireActive = vi.fn();
  const writeAllowed = vi.fn(() => false);

  for (const path of ["/api/internal/mini-apps/publish", "/api/internal/mini-apps/report"]) {
    json.mockClear();
    await route({ method: "POST", path, res: response, json, botId: "producer", threadId: "turn",
      readBody, requireActive, writeAllowed });
    expect(json).toHaveBeenCalledWith(response, 403, { error: "This turn may only read Mini Apps." });
  }
  expect(requireActive).toHaveBeenCalledTimes(2);
  expect(writeAllowed).toHaveBeenCalledTimes(2);
  expect(readBody).not.toHaveBeenCalled();
});

it("publishes a metadata-only app without promoting the bot's Data", async () => {
  const publish = vi.fn(async () => ({ app: { id: "installed" }, replayed: false }));
  const promoteForBot = vi.fn(async () => { throw new Error("unrelated Data is unavailable"); });
  const deps = { localEnabled: () => true, bots: () => [{ id: "producer", name: "Producer" }],
    apps: { publish }, data: { promoteForBot } } as unknown as Parameters<typeof createMiniAppsInternalRoutes>[0];
  const route = createMiniAppsInternalRoutes(deps);
  const response = {} as ServerResponse;
  const json = vi.fn();
  const publication = { requestKey: "metadata", expectedRevision: 0, slug: "dashboard", title: "Dashboard",
    description: "Synthetic", html: "<p>Fallback</p>", bindings: [] };
  await route({ method: "POST", path: "/api/internal/mini-apps/publish", res: response, json,
    botId: "producer", threadId: "turn", readBody: async () => ({ publication }), requireActive: () => undefined,
    writeAllowed: () => true });
  expect(json).toHaveBeenCalledWith(response, 200, { app: { id: "installed" }, replayed: false });
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ botId: "producer" }), publication, undefined);
  expect(promoteForBot).not.toHaveBeenCalled();
  await route({ method: "POST", path: "/api/internal/mini-apps/publish", res: response, json,
    botId: "producer", threadId: "turn", readBody: async () => ({ publication: { ...publication,
      requestKey: "bot-label", shippedTemplateKind: "bookkeeping" } }), requireActive: () => undefined, writeAllowed: () => true });
  expect(json).toHaveBeenLastCalledWith(response, 403, { error: "Only the workspace owner can identify a shipped template." });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(promoteForBot).not.toHaveBeenCalled();
});

it("keeps app-scoped dashboard reads behind the existing local owner gate", async () => {
  const dashboardRead = vi.fn(async () => ({ appId: "fixture", revision: 1, resource: "teams", snapshot: {} }));
  const deps = { localEnabled: () => true, apps: { dashboardRead } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const route = createMiniAppRoutes(deps);
  const json = vi.fn();
  const path = "/api/mini-apps/11111111-1111-4111-8111-111111111111/dashboard";
  const readBody = vi.fn(async () => ({ resource: "teams", expectedRevision: 1 }));
  const call = (auth: RequestAuth, peer = "127.0.0.1") => {
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = path;
    Object.defineProperty(req.socket, "remoteAddress", { value: peer, configurable: true });
    return route({ method: "POST", path, url: new URL(`http://127.0.0.1${path}`),
      req, res: new ServerResponse(req), auth, json, readBody });
  };
  const denied: Array<[RequestAuth, string]> = [
    [{ kind: "session", via: "bearer", scopes: ["admin"], session: { id: "fixture", tokenHash: "0".repeat(64),
      label: "Fixture phone", scopes: ["admin"], createdAt: 1, lastSeenAt: 1, expiresAt: 2 } }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"], trust: "service" }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"], companionDevice: "phone" }, "127.0.0.1"],
    [{ kind: "loopback", scopes: ["admin"] }, "203.0.113.8"],
  ];
  for (const [auth, peer] of denied) await call(auth, peer);
  expect(json).toHaveBeenCalledTimes(4);
  expect(json.mock.calls.every(([, status]) => status === 403)).toBe(true);
  expect(readBody).not.toHaveBeenCalled();
  expect(dashboardRead).not.toHaveBeenCalled();
  await call({ kind: "loopback", scopes: ["admin"] });
  expect(dashboardRead).toHaveBeenCalledWith(expect.objectContaining({ writeAllowed: true }),
    "11111111-1111-4111-8111-111111111111", { resource: "teams", expectedRevision: 1 });
});

it("keeps Agent MD writes bound to the local owner and current granted app revision", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `/api/mini-apps/${id}/agent-md`;
  const selection = { agentId: "w6:p1", occupantId: "o1234567890abcdef", expectedRevision: 3 };
  const draft = { ...selection, documentId: "a".repeat(64), expectedHash: "b".repeat(64), text: "# Next rules" };
  const doc = { text: "# Original", hash: draft.expectedHash, documentId: draft.documentId };
  let revision = 3;
  let resources = ["configuration"];
  const document = () => ({ app: { revision, status: "active", dashboardIdentity: "agent-team",
    release: { packageId: "mashellhan.agent-team" },
    dashboard: { kind: "agent-team", renderer: "html", resources } } });
  const getRoleDocument = vi.fn(async () => doc);
  const saveRoleDocument = vi.fn(async (_input, guard: () => void) => {
    guard();
    return { status: "conflict", doc };
  });
  const route = createMiniAppRoutes({ localEnabled: () => true, apps: { document },
    roleConfiguration: { getRoleDocument, saveRoleDocument } } as unknown as Parameters<typeof createMiniAppRoutes>[0]);
  const json = vi.fn();
  const owner: RequestAuth = { kind: "loopback", scopes: ["admin"] };
  const call = (method: string, body: unknown, auth = owner) => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1" });
    return route({ path, method, url: new URL(`http://127.0.0.1${path}`), req, res: new ServerResponse(req),
      auth, json, readBody: async () => body });
  };
  await call("PUT", draft, { ...owner, trust: "service" });
  expect(json.mock.lastCall?.[1]).toBe(403);
  await call("PUT", { ...draft, path: "/tmp/private.md" });
  expect(json.mock.lastCall?.[1]).toBe(400);
  resources = ["teams", "activity"];
  await call("PUT", draft);
  expect(json.mock.lastCall?.[1]).toBe(403);
  resources = ["configuration"];
  revision = 4;
  await call("PUT", draft);
  expect(json.mock.lastCall?.[1]).toBe(409);
  expect(saveRoleDocument).not.toHaveBeenCalled();
  revision = 3;
  await call("POST", selection);
  expect(json.mock.lastCall?.slice(1)).toEqual([200, doc]);
  await call("PUT", draft);
  expect(json.mock.lastCall?.slice(1)).toEqual([409, expect.objectContaining({ code: "conflict", current: doc.text, currentHash: doc.hash })]);
  saveRoleDocument.mockImplementationOnce(async (_input, guard) => {
    revision++;
    guard();
    throw new Error("A stale app reached a write");
  });
  await call("PUT", draft);
  expect(json.mock.lastCall?.slice(1)).toEqual([409, { error: "This Mini App changed. Reopen Agent MD." }]);
});

it("routes only the canonical completed Hongguo media query to the scoped token", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const path = `/api/mini-apps/${id}/hongguo/media/token`;
  const requireHongguo = vi.fn(() => ({ revision: 3, nativeKind: "hongguo", nativeIdentity: "hongguo" }));
  const serveMedia = vi.fn(async () => new Response(null, { status: 404 }));
  const route = createMiniAppRoutes({ localEnabled: () => true, apps: { requireHongguo },
    hongguoProvider: { serveMedia } } as unknown as Parameters<typeof createMiniAppRoutes>[0]);
  const json = vi.fn();
  const call = async (query: string, scopes = ["admin"]) => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
    req.headers.range = "bytes=0-1";
    const res = new ServerResponse(req);
    await route({ method: "GET", path, url: new URL(`http://127.0.0.1${path}?${query}`), req, res,
      auth: { kind: "loopback", scopes } as RequestAuth, json, readBody: async () => null });
    return res;
  };
  const complete = "expectedRevision=3&completed=1";
  for (const query of [
    "completed=1", "completed=1&expectedRevision=3", "expectedRevision=3&completed=0",
    `${complete}&completed=1`, `${complete}&expectedRevision=3`, `${complete}&extra=1`, `${complete}&`,
    "expectedRevision=3&%63ompleted=1", "expectedRevision=3&completed=%31",
    "expectedRevision=%33&completed=1", "expectedRevision=9007199254740992&completed=1",
  ]) {
    await call(query);
    expect(json.mock.lastCall?.[1], query).toBe(400);
  }
  await call(complete, []);
  expect(json.mock.lastCall?.[1]).toBe(403);
  expect(requireHongguo).not.toHaveBeenCalled();
  expect(serveMedia).not.toHaveBeenCalled();

  await call(complete);
  expect(json.mock.lastCall?.[1]).toBe(404);
  expect(serveMedia).toHaveBeenLastCalledWith("token", "bytes=0-1", expect.any(AbortSignal), { appId: id, revision: 3 }, true);
  expect(requireHongguo.mock.calls).toEqual([[expect.anything(), id, 3], [expect.anything(), id, 3]]);

  serveMedia.mockResolvedValueOnce(new Response(null, { status: 206, headers: {
    "content-length": "2", "content-range": "bytes 0-1/10", "accept-ranges": "bytes",
  } }));
  const response = await call(complete);
  expect(response.statusCode).toBe(206);
  expect(response.getHeader("content-length")).toBe("2");
  expect(response.getHeader("content-range")).toBe("bytes 0-1/10");
  expect(response.getHeader("cache-control")).toBe("private, no-store");
});

it("keeps Hongguo provider and scoped media behind the owner and revision gates", async () => {
  const requireHongguo = vi.fn(() => ({ revision: 3, nativeKind: "hongguo", nativeIdentity: "hongguo" }));
  const catalog = vi.fn(async () => ({ items: [], categories: [], nextCursor: null }));
  const preparePlayback = vi.fn(async (): Promise<unknown> => ({ status: "unavailable", reason: "anonymous-limited" }));
  const serveMedia = vi.fn(async () => new Response(null, { status: 416 }));
  const deps = { localEnabled: () => true, apps: { requireHongguo },
    hongguoProvider: { catalog, preparePlayback, serveMedia } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const route = createMiniAppRoutes(deps);
  const json = vi.fn();
  const id = "11111111-1111-4111-8111-111111111111";
  const call = (method: string, suffix: string, auth: RequestAuth, body?: unknown) => {
    const path = `/api/mini-apps/${id}/hongguo/${suffix.split("?")[0]}`;
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
    req.method = method;
    req.url = `/api/mini-apps/${id}/hongguo/${suffix}`;
    const res = new ServerResponse(req);
    return route({ method, path, url: new URL(`http://127.0.0.1${req.url}`),
      req, res, auth, json, readBody: async () => body }).then(() => res);
  };
  const ownerAuth: RequestAuth = { kind: "loopback", scopes: ["admin"] };
  await call("POST", "catalog", { kind: "loopback", scopes: [] }, { expectedRevision: 3, mode: "popular" });
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 403, expect.objectContaining({ error: expect.any(String) }));
  expect(requireHongguo).not.toHaveBeenCalled();
  await call("POST", "catalog", ownerAuth, { expectedRevision: 3, mode: "popular" });
  expect(catalog).toHaveBeenCalledWith({ expectedRevision: 3, mode: "popular" }, expect.any(AbortSignal));
  expect(requireHongguo).toHaveBeenCalledTimes(2);
  const prefetchBody = { expectedRevision: 3, seriesId: "series", episodeId: "episode", intent: "prefetch" };
  await call("POST", "playback", { kind: "loopback", scopes: [] }, prefetchBody);
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 403, expect.objectContaining({ error: expect.any(String) }));
  expect(preparePlayback).not.toHaveBeenCalled();
  const gatedBeforePrefetch = requireHongguo.mock.calls.length;
  await call("POST", "playback", ownerAuth, prefetchBody);
  expect(requireHongguo).toHaveBeenCalledTimes(gatedBeforePrefetch + 2);
  expect(preparePlayback).not.toHaveBeenCalled();
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 200,
    { appId: id, revision: 3, status: "unavailable", reason: "provider-unavailable" });
  await call("POST", "playback", ownerAuth, { expectedRevision: 3, seriesId: "series", episodeId: "episode" });
  expect(preparePlayback).toHaveBeenCalledWith("series", "episode", { appId: id, revision: 3 }, undefined);
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 200,
    { appId: id, revision: 3, status: "unavailable", reason: "anonymous-limited" });
  await call("POST", "playback", ownerAuth, { expectedRevision: 3, seriesId: "series", episodeId: "episode",
    qualityId: "https://private.example/key" });
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 400, expect.objectContaining({ error: expect.any(String) }));
  expect(preparePlayback).toHaveBeenCalledTimes(1);
  for (const intent of ["foreground", "PREFETCH", null, 1]) {
    await call("POST", "playback", ownerAuth, { ...prefetchBody, intent });
    expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 400, expect.objectContaining({ error: expect.any(String) }));
  }
  await call("POST", "playback", ownerAuth, { ...prefetchBody, extra: true });
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 400, expect.objectContaining({ error: expect.any(String) }));
  expect(preparePlayback).toHaveBeenCalledTimes(1);
  preparePlayback.mockResolvedValueOnce({ status: "ready", token: "synthetic-token", durationSeconds: 90,
    selectedQualityId: "720p", availableQualityIds: ["1080p", "720p"] });
  await call("POST", "playback", ownerAuth, { expectedRevision: 3, seriesId: "series", episodeId: "episode", qualityId: "720p" });
  expect(preparePlayback).toHaveBeenLastCalledWith("series", "episode", { appId: id, revision: 3 }, "720p");
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 200,
    { appId: id, revision: 3, status: "ready", durationSeconds: 90, selectedQualityId: "720p",
      availableQualityIds: ["1080p", "720p"], mediaUrl: `/api/mini-apps/${id}/hongguo/media/synthetic-token?expectedRevision=3` });
  preparePlayback.mockResolvedValueOnce({ status: "ready", token: "synthetic-token", durationSeconds: 90,
    selectedQualityId: "720p", availableQualityIds: ["720p", "https://private.example/key"] });
  await call("POST", "playback", ownerAuth, { expectedRevision: 3, seriesId: "series", episodeId: "episode" });
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 503, expect.objectContaining({ error: expect.any(String) }));
  expect(JSON.stringify(json.mock.calls.at(-1))).not.toContain("private.example");
  await call("GET", "media/token?expectedRevision=3", ownerAuth);
  expect(serveMedia).toHaveBeenCalledWith("token", undefined, expect.any(AbortSignal), { appId: id, revision: 3 }, false);
  await call("GET", "media/token?expectedRevision=3&extra=1", ownerAuth);
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 400, expect.objectContaining({ error: expect.any(String) }));
  expect(serveMedia).toHaveBeenCalledTimes(1);

  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const getCover = vi.spyOn(HongguoCovers.prototype, "get").mockResolvedValue(image);
  const cover = `cover?expectedRevision=3&url=${encodeURIComponent("https://p.fqnovelpic.com/poster.heic")}`;
  await call("GET", cover, { kind: "loopback", scopes: [] });
  expect(getCover).not.toHaveBeenCalled();
  await call("GET", "cover?expectedRevision=2&url=https%3A%2F%2Fp.fqnovelpic.com%2Fposter.heic&extra=1", ownerAuth);
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 400, expect.objectContaining({ error: expect.any(String) }));
  const response = await call("GET", cover, ownerAuth);
  expect(getCover).toHaveBeenCalledWith("https://p.fqnovelpic.com/poster.heic", expect.any(AbortSignal));
  expect(response.statusCode).toBe(200);
  expect(response.getHeader("content-type")).toBe("image/jpeg");
  expect(response.getHeader("x-content-type-options")).toBe("nosniff");
  expect(response.getHeader("content-length")).toBe(String(image.length));
  expect(requireHongguo).toHaveBeenLastCalledWith(expect.objectContaining({ writeAllowed: true }), id, 3);
  getCover.mockRestore();
});

it.each(["catalog", "series"] as const)("cancels the %s request lifetime on response close without writing after abort", async (action) => {
  const requireHongguo = vi.fn();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const provider = vi.fn(async (_input: unknown, signal?: AbortSignal) => {
    await held;
    signal?.throwIfAborted();
    return { items: [], categories: [], nextCursor: null };
  });
  const deps = { localEnabled: () => true, apps: { requireHongguo }, hongguoProvider: { [action]: provider } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const route = createMiniAppRoutes(deps);
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  const res = new ServerResponse(req), json = vi.fn();
  const path = `/api/mini-apps/11111111-1111-4111-8111-111111111111/hongguo/${action}`;
  const pending = route({ method: "POST", path, url: new URL(`http://127.0.0.1${path}`), req, res,
    auth: { kind: "loopback", scopes: ["admin"] }, json,
    readBody: async () => action === "catalog" ? { expectedRevision: 3, mode: "popular" } : { expectedRevision: 3, seriesId: "10" } });
  await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
  const signal = provider.mock.calls[0]![1]!;
  expect(signal.aborted).toBe(false);
  res.emit("close");
  expect(signal.aborted).toBe(true);
  release();
  await pending;
  expect(json).not.toHaveBeenCalled();
  expect(requireHongguo).toHaveBeenCalledTimes(1);
  expect(res.listenerCount("close")).toBe(0);
});

it("does not start a catalog action for an already closed response", async () => {
  const catalog = vi.fn();
  const deps = { localEnabled: () => true, apps: { requireHongguo: vi.fn() }, hongguoProvider: { catalog } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const req = new IncomingMessage(new Socket());
  Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
  const res = new ServerResponse(req), json = vi.fn();
  Object.defineProperty(res, "destroyed", { value: true });
  const path = "/api/mini-apps/11111111-1111-4111-8111-111111111111/hongguo/catalog";
  await createMiniAppRoutes(deps)({ method: "POST", path, url: new URL(`http://127.0.0.1${path}`), req, res,
    auth: { kind: "loopback", scopes: ["admin"] }, json, readBody: async () => ({ expectedRevision: 3, mode: "popular" }) });
  expect(catalog).not.toHaveBeenCalled();
  expect(json).not.toHaveBeenCalled();
  expect(res.listenerCount("close")).toBe(0);
});

it("keeps suggestions behind the local owner gate and passes only the selected Bot task", async () => {
  const read = vi.fn(() => ({ botId: "bot", threadId: "current", suggestions: [], refreshPending: false, status: "ready" as const }));
  const deps = { localEnabled: () => true, suggestions: { read } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const route = createMiniAppRoutes(deps);
  const json = vi.fn();
  const path = "/api/mini-apps/suggestions";
  const readBody = vi.fn(async () => ({ botId: "bot", threadId: "current" }));
  const call = (auth: RequestAuth) => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
    return route({ method: "POST", path, url: new URL(`http://127.0.0.1${path}`), req, res: new ServerResponse(req),
      auth, json, readBody });
  };
  await call({ kind: "loopback", scopes: [] });
  expect(readBody).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  await call({ kind: "loopback", scopes: ["admin"] });
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ writeAllowed: true }), { botId: "bot", threadId: "current" });
  expect(json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 200,
    { botId: "bot", threadId: "current", suggestions: [], refreshPending: false, status: "ready" });
});

it("gates GitHub Activity media behind owner loopback auth, exact app revision, and strict query validation", async () => {
  const id = "0643df6c-24ea-4076-87b6-572d3637a4d9";
  const mediaBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const digest = "a".repeat(64);
  const requireGithubActivity = vi.fn();
  const fetchMedia = vi.spyOn(githubMediaModule, "fetchGithubActivityMedia")
    .mockResolvedValue({ mimeType: "image/png", bytes: mediaBytes, sha256: digest });
  const deps = { localEnabled: () => true, apps: { requireGithubActivity } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const route = createMiniAppRoutes(deps);

  const sendReq = async (rawPath: string, auth: RequestAuth = { kind: "loopback", scopes: ["admin"] }, method = "GET") => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
    const res = new ServerResponse(req);
    const json = vi.fn();
    await route({ method, path: rawPath.split("?", 1)[0]!, url: new URL(`http://127.0.0.1${rawPath}`), req, res, auth, json,
      readBody: async () => ({}) });
    return { res, json };
  };

  const denied = await sendReq(`/api/mini-apps/${id}/github-activity/media?expectedRevision=6&url=https://mxhan.com/github/media/a.png&sha256=${digest}`,
    { kind: "loopback", scopes: ["admin"], companionDevice: { id: "c1" } } as unknown as RequestAuth);
  expect(denied.json).toHaveBeenCalledWith(expect.any(ServerResponse), 403, { error: "Mini Apps are available only to this local workspace's owner." });
  expect(fetchMedia).not.toHaveBeenCalled();

  requireGithubActivity.mockImplementationOnce(() => { throw appFailure(403, "This Mini App has no GitHub Activity media grant."); });
  const revokedApp = await sendReq(`/api/mini-apps/${id}/github-activity/media?expectedRevision=6&url=https://mxhan.com/github/media/a.png&sha256=${digest}`);
  expect(revokedApp.json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 403, { error: "This Mini App has no GitHub Activity media grant." });

  fetchMedia.mockRejectedValueOnce(appFailure(403, "Redirected GitHub Activity media address is not allowed.", githubMediaModule.GITHUB_MEDIA_POLICY_DENIED));
  const policyDenied = await sendReq(`/api/mini-apps/${id}/github-activity/media?expectedRevision=6&url=https://mxhan.com/github/media/a.png&sha256=${digest}`);
  expect(policyDenied.json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 403, {
    error: "Redirected GitHub Activity media address is not allowed.",
    code: githubMediaModule.GITHUB_MEDIA_POLICY_DENIED,
  });
  requireGithubActivity.mockClear();

  const badQuery = await sendReq(`/api/mini-apps/${id}/github-activity/media?expectedRevision=6&url=https://mxhan.com/github/media/a.png`);
  expect(badQuery.json).toHaveBeenCalledWith(expect.any(ServerResponse), 400, expect.any(Object));

  const ok = await sendReq(`/api/mini-apps/${id}/github-activity/media?expectedRevision=6&url=https://mxhan.com/github/media/a.png&sha256=${digest}`);
  expect(requireGithubActivity).toHaveBeenCalledTimes(2);
  expect(requireGithubActivity).toHaveBeenLastCalledWith(expect.objectContaining({ writeAllowed: true }), id, 6);
  expect(ok.res.statusCode).toBe(200);
  expect(ok.res.getHeader("content-type")).toBe("image/png");
  expect(ok.res.getHeader("x-content-type-options")).toBe("nosniff");
  expect(ok.res.getHeader("content-security-policy")).toBe("default-src 'none'");
  expect(ok.res.getHeader("x-github-activity-sha256")).toBe(digest);
  fetchMedia.mockRestore();
});

it("gates Mini App release update check and apply behind local workspace owner auth and forwards AbortSignal", async () => {
  const id = "0643df6c-24ea-4076-87b6-572d3637a4d9";
  const checkUpdate = vi.fn(async () => ({
    installedVersion: null,
    status: "available" as const,
    available: { appVersion: "0.1.1", sourceCommit: "81253883c34a1d4ca829fa907ee0514156b780d7" },
  }));
  const applyUpdate = vi.fn(async () => ({
    app: { id, revision: 2 },
    replayed: false,
  }));
  const deps = { localEnabled: () => true, apps: { checkUpdate, applyUpdate } } as unknown as Parameters<typeof createMiniAppRoutes>[0];
  const route = createMiniAppRoutes(deps);

  const call = async (method: string, auth: RequestAuth, body: unknown = undefined) => {
    const req = new IncomingMessage(new Socket());
    Object.defineProperty(req.socket, "remoteAddress", { value: "127.0.0.1", configurable: true });
    const res = new ServerResponse(req);
    const json = vi.fn();
    const readBody = vi.fn(async () => body ?? {});
    const path = `/api/mini-apps/${id}/update`;
    await route({ method, path, url: new URL(`http://127.0.0.1${path}`), req, res, auth, json, readBody });
    return { res, json, readBody };
  };

  const companion: RequestAuth = { kind: "loopback", scopes: ["admin"], companionDevice: { id: "c1" } } as unknown as RequestAuth;
  const nonAdmin: RequestAuth = { kind: "loopback", scopes: [] };
  const ownerAuth: RequestAuth = { kind: "loopback", scopes: ["admin"] };

  const deniedGet = await call("GET", companion);
  expect(deniedGet.json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 403, { error: "Mini Apps are available only to this local workspace's owner." });
  expect(checkUpdate).not.toHaveBeenCalled();

  const deniedPost = await call("POST", nonAdmin, { appVersion: "0.1.1", sourceCommit: "81253883c34a1d4ca829fa907ee0514156b780d7", expectedRevision: 1, requestKey: "k1" });
  expect(deniedPost.readBody).not.toHaveBeenCalled();
  expect(applyUpdate).not.toHaveBeenCalled();

  const getOk = await call("GET", ownerAuth);
  expect(checkUpdate).toHaveBeenCalledWith(expect.objectContaining({ writeAllowed: true }), id, expect.any(AbortSignal));
  expect(getOk.json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 200, {
    installedVersion: null,
    status: "available",
    available: { appVersion: "0.1.1", sourceCommit: "81253883c34a1d4ca829fa907ee0514156b780d7" },
  });

  const payload = {
    appVersion: "0.1.1",
    sourceCommit: "81253883c34a1d4ca829fa907ee0514156b780d7",
    expectedRevision: 1,
    requestKey: "apply-1",
  };
  const postOk = await call("POST", ownerAuth, payload);
  expect(applyUpdate).toHaveBeenCalledWith(expect.objectContaining({ writeAllowed: true }), id, payload, expect.any(AbortSignal));
  expect(postOk.json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 200, {
    app: { id, revision: 2 },
    replayed: false,
  });

  const putDenied = await call("PUT", ownerAuth);
  expect(putDenied.json).toHaveBeenLastCalledWith(expect.any(ServerResponse), 405, { error: "Method not allowed." });
});
