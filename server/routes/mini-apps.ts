import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { allowsTool } from "../../shared/tool-scope.ts";
import { createReportTemplate } from "../../shared/report-mini-app-template.ts";
import type { MiniAppDataset, MiniAppSources, MiniAppUpdateCheckResult } from "../../shared/mini-apps.ts";
import type { DataEngine } from "../data/types.ts";
import { DataFailure } from "../data/types.ts";
import { quoteIdentifier } from "../data/sql-identifiers.ts";
import { createChatApps } from "../chat-apps.ts";
import { appDocRefs } from "../message-db.ts";
import type { json as sendJson } from "../harness/http.ts";
import { MINI_APP_TOOL_ROUTES } from "../drivers/agents-mini-app-tools.ts";
import { MiniApps, MINI_APPS_OWNER, miniAppDocRefs, type MiniAppActor } from "../mini-apps/registry.ts";
import type { MiniAppReleaseSource } from "../mini-apps/release-source.ts";
import { appFailure, parsePublish } from "../mini-apps/validation.ts";
import { MINI_APP_AUTHOR_GUIDE } from "../mini-apps/author-guide.ts";
import { ReportStore } from "../mini-apps/report-store.ts";
import { DefaultMiniApps } from "../mini-apps/defaults.ts";
import { parseHongguoCatalog, parseHongguoCatalogResult, parseHongguoPlayback, parseHongguoPreparedPlayback,
  parseHongguoSeries, parseHongguoSeriesResult } from "../mini-apps/hongguo-validation.ts";
import { fetchGithubActivityMedia } from "../github-activity/media.ts";
import { HongguoCovers } from "../hongguo/cover.ts";
import type { HongguoProvider } from "../hongguo/provider.ts";
import { MiniAppSuggestions } from "../mini-apps/suggestions.ts";
import type { SideJobText } from "../side-jobs.ts";
import type { Store } from "../store.ts";
import { reportAppsForBot } from "../mini-apps/report-apps.ts";
import { parseReportTool, reportKindSchema } from "../mini-apps/report-schema.ts";
import { localDashboardProviders, type LocalDashboardProviders } from "./local-dashboard.ts";
import type { RoutineManager } from "../routines.ts";
import { PASS, type RouteHandler } from "./table.ts";

const ROOT = "/api/mini-apps";
const REPORT_SOURCE = `${ROOT}/report-source`;
const APP_PATH = /^\/api\/mini-apps\/([0-9a-f-]{36})(?:\/(state|query|dashboard|publish|rollback|archive|update))?$/;
const HONGGUO_ACTION = /^\/api\/mini-apps\/([0-9a-f-]{36})\/hongguo\/(catalog|series|playback|history|preferences)$/;
const HONGGUO_MEDIA = /^\/api\/mini-apps\/([0-9a-f-]{36})\/hongguo\/media\/([A-Za-z0-9_-]{1,256})$/;
const HONGGUO_COVER = /^\/api\/mini-apps\/([0-9a-f-]{36})\/hongguo\/cover$/;
const GITHUB_ACTIVITY_MEDIA = /^\/api\/mini-apps\/([0-9a-f-]{36})\/github-activity\/media$/;
const SOURCE = z.object({ botId: z.string().regex(/^[\w-]{1,128}$/) }).strict();
const INTERNAL_ID = z.object({ app_id: z.uuid() }).strict();
const CONNECT = z.object({}).strict();
const SOURCE_PAGE = /^\/api\/mini-apps\/sources\/([0-9a-f-]{36})\/page$/;
const SOURCE_PAGE_BODY = z.object({ schema: z.string().min(1).max(200), table: z.string().min(1).max(200),
  offset: z.number().int().min(0).max(10_000), limit: z.number().int().min(1).max(100) }).strict();

interface MiniAppRouteDeps {
  apps: MiniApps;
  data: DataEngine;
  reports: ReportStore;
  routines(): Pick<RoutineManager, "listRoutines" | "runForThread" | "isActiveThread"> | null;
  localEnabled(): boolean;
  bots(): Array<{ id: string; name: string; toolScope?: unknown }>;
  suggestions?: MiniAppSuggestions;
  hongguoProvider?: HongguoProvider;
}

export function createMiniAppRouteHandlers(input: Omit<MiniAppRouteDeps, "apps" | "reports"> & {
  store: Parameters<typeof createChatApps>[0]["store"] & Pick<Store, "bot" | "taskByThread">;
  dataDir: string;
  validPublisher(id: string): boolean;
  dashboardProviders?: LocalDashboardProviders;
  hongguoProvider?: HongguoProvider;
  releaseSource?: MiniAppReleaseSource;
  suggestionWriter?(botId: string): SideJobText | null;
} & Pick<Parameters<typeof createChatApps>[0], "liveRows" | "liveRoots" | "paused">) {
  const { store, dataDir, validPublisher, dashboardProviders, releaseSource, suggestionWriter, liveRows, liveRoots, paused, ...shared } = input;
  const chatApps = createChatApps({ store, dataDir,
    references: () => [...appDocRefs(), ...miniAppDocRefs()], liveRows, liveRoots, paused });
  const apps = new MiniApps({ docs: chatApps.docs, data: shared.data, validPublisher,
    dashboardProviders: dashboardProviders ?? localDashboardProviders, releaseSource });
  apps.initialize();
  const deps = { ...shared, apps, suggestions: new MiniAppSuggestions({ apps, store,
    writer: suggestionWriter ?? (() => null) }), reports: new ReportStore(shared.data, createReportTemplate) };
  return { chatApps, owner: createMiniAppRoutes(deps), internal: createMiniAppsInternalRoutes(deps),
    reportAppsForBot: (botId: string) => reportAppsForBot(deps, botId) };
}

export function miniAppError(error: unknown): { status: number; error: string; code?: string } {
  if (error instanceof DataFailure) {
    const status = error.error.code === "spec_invalid" || error.error.code === "invalid_input" ? 400
      : error.error.code === "table_not_found" || error.error.code === "write_refused" || error.error.code === "cancelled" ? 409
      : error.error.code === "output_too_large" ? 413 : 503;
    return { status, error: error.message, code: error.error.code };
  }
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
  const code = error && typeof error === "object" && "status" in error && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
  return { status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    error: error instanceof Error ? error.message : "Mini Apps are unavailable.", ...(code ? { code } : {}) };
}

async function datasetInfo(data: DataEngine, datasetId: string): Promise<MiniAppDataset> {
  const entry = (await data.listDatasets(MINI_APPS_OWNER)).find((candidate) => candidate.datasetId === datasetId);
  if (!entry) throw appFailure(404, "Data source not found.");
  const database = await data.forDataset(datasetId, MINI_APPS_OWNER);
  return { datasetId, revision: entry.revision, tables: await database.listSourceTables() };
}

async function hongguoProviderResult<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch { throw appFailure(503, "Hongguo provider is unavailable."); }
}

export function createMiniAppRoutes(deps: MiniAppRouteDeps): RouteHandler {
  const defaults = new DefaultMiniApps(deps);
  const covers = new HongguoCovers();
  return async (ctx) => {
    const { req, res, path, method, auth, json, readBody, url } = ctx;
    if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return PASS;
    res.setHeader("cache-control", "private, no-store");
    const assertOwner = () => {
      const peer = req.socket.remoteAddress;
      if (!deps.localEnabled() || auth.kind !== "loopback" || auth.trust === "service" || auth.companionDevice ||
          !auth.scopes.includes("admin") || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "")) throw appFailure(403, "Mini Apps are available only to this local workspace's owner.");
    };
    const owner: MiniAppActor = { writeAllowed: true, assertActive: assertOwner, canBind: () => true };
    try {
      assertOwner();
      const hongguoMedia = HONGGUO_MEDIA.exec(path);
      const hongguoCover = HONGGUO_COVER.exec(path);
      const githubMedia = GITHUB_ACTIVITY_MEDIA.exec(path);
      if (url.search && !hongguoMedia && !hongguoCover && !githubMedia) throw appFailure(400, "Query parameters are not supported.");
      if (githubMedia) {
        if (method !== "GET") throw appFailure(405, "Method not allowed.");
        const rawRevision = url.searchParams.get("expectedRevision");
        const mediaUrl = url.searchParams.get("url");
        const sha256 = url.searchParams.get("sha256");
        if (url.searchParams.size !== 3 || url.searchParams.getAll("expectedRevision").length !== 1
          || url.searchParams.getAll("url").length !== 1 || url.searchParams.getAll("sha256").length !== 1
          || !rawRevision || !/^[1-9]\d*$/.test(rawRevision) || !Number.isSafeInteger(Number(rawRevision))
          || !mediaUrl || !sha256) {
          throw appFailure(400, "Invalid GitHub Activity media request.");
        }
        const id = githubMedia[1]!;
        const revision = Number(rawRevision);
        deps.apps.requireGithubActivity(owner, id, revision);
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        try {
          const media = await fetchGithubActivityMedia(mediaUrl, sha256, abort.signal);
          deps.apps.requireGithubActivity(owner, id, revision);
          if (abort.signal.aborted) return;
          res.statusCode = 200;
          res.setHeader("content-type", media.mimeType);
          res.setHeader("content-length", String(media.bytes.length));
          res.setHeader("x-content-type-options", "nosniff");
          res.setHeader("content-security-policy", "default-src 'none'");
          res.setHeader("x-github-activity-sha256", media.sha256);
          res.end(media.bytes);
          return;
        } finally { res.off("close", onClose); }
      }
      if (hongguoCover) {
        if (method !== "GET") throw appFailure(405, "Method not allowed.");
        const rawRevision = url.searchParams.get("expectedRevision");
        const coverUrl = url.searchParams.get("url");
        if (url.searchParams.size !== 2 || url.searchParams.getAll("expectedRevision").length !== 1
          || url.searchParams.getAll("url").length !== 1 || !rawRevision || !/^[1-9]\d*$/.test(rawRevision)
          || !Number.isSafeInteger(Number(rawRevision)) || !coverUrl) throw appFailure(400, "Invalid Hongguo cover request.");
        const id = hongguoCover[1]!;
        const revision = Number(rawRevision);
        deps.apps.requireHongguo(owner, id, revision);
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        try {
          const bytes = await hongguoProviderResult(() => covers.get(coverUrl, abort.signal));
          deps.apps.requireHongguo(owner, id, revision);
          if (abort.signal.aborted) return;
          res.statusCode = 200;
          res.setHeader("content-type", "image/jpeg");
          res.setHeader("content-length", String(bytes.length));
          res.setHeader("x-content-type-options", "nosniff");
          res.setHeader("content-security-policy", "default-src 'none'");
          res.end(bytes);
          return;
        } finally { res.off("close", onClose); }
      }
      if (hongguoMedia) {
        if (method !== "GET") throw appFailure(405, "Method not allowed.");
        const query = /^\?expectedRevision=([1-9]\d*)(&completed=1)?$/.exec(url.search);
        const revision = Number(query?.[1]);
        if (!Number.isSafeInteger(revision)) throw appFailure(400, "Invalid Hongguo media query.");
        const completedOnly = Boolean(query?.[2]);
        const id = hongguoMedia[1]!, token = hongguoMedia[2]!;
        deps.apps.requireHongguo(owner, id, revision);
        if (!deps.hongguoProvider) throw appFailure(503, "Hongguo is unavailable.");
        const range = req.headers.range;
        if (range !== undefined && (typeof range !== "string" || range.length > 128 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(range))) {
          throw appFailure(400, "Invalid media range.");
        }
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        try {
          const media = await hongguoProviderResult(() =>
            deps.hongguoProvider!.serveMedia(token, range, abort.signal, { appId: id, revision }, completedOnly));
          deps.apps.requireHongguo(owner, id, revision);
          if (media.status === 403 || media.status === 404) throw appFailure(media.status, "Hongguo media is unavailable.");
          if (media.status !== 200 && media.status !== 206 && media.status !== 416) throw appFailure(503, "Hongguo media is unavailable.");
          res.statusCode = media.status;
          res.setHeader("x-content-type-options", "nosniff");
          res.setHeader("content-security-policy", "default-src 'none'");
          for (const header of ["content-type", "content-length", "content-range", "accept-ranges"] as const) {
            const value = media.headers.get(header);
            if (value) res.setHeader(header, value);
          }
          if (!media.body || media.status === 416) { res.end(); return; }
          await pipeline(Readable.fromWeb(media.body as unknown as import("node:stream/web").ReadableStream), res);
          return;
        } catch (error) {
          if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
          throw error;
        } finally { res.off("close", onClose); }
      }
      const hongguoAction = HONGGUO_ACTION.exec(path);
      if (hongguoAction) {
        if (method !== "POST") throw appFailure(405, "Method not allowed.");
        const id = hongguoAction[1]!, action = hongguoAction[2]!;
        const raw: unknown = await readBody(req, 20_000);
        if (action === "history") return json(res, 200, deps.apps.hongguoHistory(owner, id, raw));
        if (action === "preferences") return json(res, 200, deps.apps.hongguoPreferences(owner, id, raw));
        const input = action === "catalog" ? parseHongguoCatalog(raw)
          : action === "series" ? parseHongguoSeries(raw) : parseHongguoPlayback(raw);
        deps.apps.requireHongguo(owner, id, input.expectedRevision);
        const prefetch = action === "playback" && (input as ReturnType<typeof parseHongguoPlayback>).intent === "prefetch";
        if (!prefetch && !deps.hongguoProvider) throw appFailure(503, "Hongguo is unavailable.");
        let result: unknown;
        if (action === "catalog" || action === "series") {
          const abort = new AbortController();
          const onClose = () => abort.abort();
          res.once("close", onClose);
          if (res.destroyed) abort.abort();
          try {
            if (abort.signal.aborted) return;
            if (action === "catalog") result = parseHongguoCatalogResult(await hongguoProviderResult(() =>
              deps.hongguoProvider!.catalog(input as ReturnType<typeof parseHongguoCatalog>, abort.signal)));
            else result = { series: parseHongguoSeriesResult(await hongguoProviderResult(() =>
              deps.hongguoProvider!.series((input as ReturnType<typeof parseHongguoSeries>).seriesId, abort.signal))) };
          } catch (error) { if (abort.signal.aborted) return; throw error; }
          finally { res.off("close", onClose); }
          if (abort.signal.aborted || res.destroyed) return;
        } else if (prefetch) {
          result = { status: "unavailable", reason: "provider-unavailable" };
        } else {
          const playback = input as ReturnType<typeof parseHongguoPlayback>;
          const prepared = parseHongguoPreparedPlayback(await hongguoProviderResult(() => deps.hongguoProvider!.preparePlayback(
            playback.seriesId, playback.episodeId, { appId: id, revision: input.expectedRevision }, playback.qualityId)));
          result = prepared.status === "ready" ? { status: "ready", durationSeconds: prepared.durationSeconds,
            mediaUrl: `${ROOT}/${id}/hongguo/media/${prepared.token}?expectedRevision=${input.expectedRevision}`,
            selectedQualityId: prepared.selectedQualityId, availableQualityIds: prepared.availableQualityIds }
            : prepared;
        }
        deps.apps.requireHongguo(owner, id, input.expectedRevision);
        const response = { appId: id, revision: input.expectedRevision, ...result as object };
        if (Buffer.byteLength(JSON.stringify(response)) > 1_000_000) throw appFailure(413, "Hongguo response is too large.");
        return json(res, 200, response);
      }
      if (path === `${ROOT}/suggestions` && method === "POST") {
        if (!deps.suggestions) throw appFailure(503, "Mini App suggestions are unavailable.");
        return json(res, 200, deps.suggestions.read(owner, await readBody(req, 4096)));
      }
      if (path === `${ROOT}/defaults` && method === "POST") {
        return json(res, 200, await defaults.ensure(owner, await readBody(req, 900_000)));
      }
      if (path === REPORT_SOURCE && method === "POST") {
        const parsed = z.object({ kind: reportKindSchema, routineId: z.string().min(1).max(128) }).strict().safeParse(await readBody(req, 4096));
        if (!parsed.success) throw appFailure(400, "Choose an existing Automation and report kind.");
        const { kind, routineId } = parsed.data;
        const selected = () => deps.routines()?.listRoutines().find((routine) => routine.id === routineId);
        const routine = selected();
        if (!routine || !routine.enabled || routine.target !== "bot" || routine.runOn !== "maus" ||
            !deps.bots().some((bot) => bot.id === routine.botId)) throw appFailure(409, "Choose an enabled local Bot Automation.");
        const prepared = await deps.reports.prepare(routine.botId, kind);
        assertOwner();
        const current = selected();
        if (!current || !current.enabled || current.target !== "bot" || current.runOn !== "maus" ||
            current.botId !== routine.botId || !deps.bots().some((bot) => bot.id === current.botId)) {
          throw appFailure(409, "The selected Automation changed while its report source was prepared.");
        }
        return json(res, 200, { ...prepared, routineId: current.id, producerBotId: current.botId });
      }
      const sourcePage = SOURCE_PAGE.exec(path);
      if (sourcePage && method === "POST") {
        const body = SOURCE_PAGE_BODY.safeParse(await readBody(req, 4096));
        if (!body.success) throw appFailure(400, "Pass a source schema, table, bounded offset and limit.");
        const dataset = await datasetInfo(deps.data, sourcePage[1]!);
        if (!dataset.tables.some((table) => table.schema === body.data.schema && table.name === body.data.table)) throw appFailure(404, "Physical Data table not found.");
        const database = await deps.data.forDataset(dataset.datasetId, MINI_APPS_OWNER);
        const page = await database.page(`${quoteIdentifier(body.data.schema)}.${quoteIdentifier(body.data.table)}`, { offset: body.data.offset, limit: body.data.limit });
        assertOwner();
        return json(res, 200, page);
      }
      if (path === `${ROOT}/sources`) {
        if (method === "GET") {
          const datasets = await deps.data.listDatasets(MINI_APPS_OWNER);
          const sources: MiniAppSources = { bots: deps.bots().map(({ id, name }) => ({ id, name })),
            datasets: await Promise.all(datasets.map((dataset) => datasetInfo(deps.data, dataset.datasetId))) };
          assertOwner();
          return json(res, 200, sources);
        }
        if (method === "POST") {
          const body = SOURCE.safeParse(await readBody(req, 4096));
          if (!body.success) throw appFailure(400, "Choose the bot whose existing Data to connect.");
          if (!deps.bots().some((bot) => bot.id === body.data.botId)) throw appFailure(404, "Source bot not found.");
          const result = await deps.data.promoteForBot(body.data.botId, MINI_APPS_OWNER);
          assertOwner();
          return json(res, 200, { dataset: await datasetInfo(deps.data, result.datasetId) });
        }
      }
      if (path === ROOT) {
        if (method === "GET") return json(res, 200, { apps: deps.apps.list(owner) });
        if (method === "POST") return json(res, 201, await deps.apps.publish(owner, await readBody(req, 900_000)));
      }
      const match = APP_PATH.exec(path);
      if (!match) throw appFailure(404, "Mini App route not found.");
      const id = match[1]!;
      const action = match[2];
      if (method === "GET" && !action) return json(res, 200, deps.apps.document(owner, id));
      if (method === "GET" && action === "state") return json(res, 200, await deps.apps.state(owner, id));
      if (method === "GET" && action === "update") {
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        if (res.destroyed) abort.abort();
        let result: MiniAppUpdateCheckResult;
        try {
          if (abort.signal.aborted) return;
          result = await deps.apps.checkUpdate(owner, id, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) return;
          throw error;
        } finally { res.off("close", onClose); }
        if (abort.signal.aborted || res.destroyed) return;
        return json(res, 200, result);
      }
      if (method !== "POST") throw appFailure(405, "Method not allowed.");
      if (action === "dashboard") return json(res, 200, await deps.apps.dashboardRead(owner, id, await readBody(req, 4096)));
      const body: unknown = await readBody(req, action === "publish" ? 900_000 : 20_000);
      if (action === "query") return json(res, 200, await deps.apps.query(owner, id, body));
      if (action === "publish") return json(res, 200, await deps.apps.publish(owner, body, id));
      if (action === "rollback") return json(res, 200, await deps.apps.rollback(owner, id, body));
      if (action === "archive") return json(res, 200, deps.apps.archive(owner, id, body));
      if (action === "update") {
        const abort = new AbortController();
        const onClose = () => abort.abort();
        res.once("close", onClose);
        if (res.destroyed) abort.abort();
        let result: Awaited<ReturnType<MiniApps["applyUpdate"]>>;
        try {
          if (abort.signal.aborted) return;
          result = await deps.apps.applyUpdate(owner, id, body, abort.signal);
        } catch (error) {
          if (abort.signal.aborted) return;
          throw error;
        } finally { res.off("close", onClose); }
        if (abort.signal.aborted || res.destroyed) return;
        return json(res, 200, result);
      }
      throw appFailure(404, "Mini App action not found.");
    } catch (error) {
      const failure = miniAppError(error);
      return json(res, failure.status, { error: failure.error, ...(failure.code ? { code: failure.code } : {}) });
    }
  };
}

export interface MiniAppsInternalContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  threadId: string;
  readBody(): Promise<unknown>;
  requireActive(): void;
  writeAllowed(): boolean;
}

export function createMiniAppsInternalRoutes(deps: MiniAppRouteDeps) {
  return async (ctx: MiniAppsInternalContext): Promise<typeof PASS | void> => {
    const name = Object.entries(MINI_APP_TOOL_ROUTES).find(([, route]) => ctx.path === `/api/internal/${route}`)?.[0];
    if (!name || ctx.method !== "POST") return PASS;
    const readOnly = name === "mini_app_info";
    const assertActive = () => {
      ctx.requireActive();
      const bot = deps.bots().find((candidate) => candidate.id === ctx.botId);
      if (!deps.localEnabled() || !bot || !allowsTool(bot.toolScope, { kind: "mcp", server: "agents", name })) throw appFailure(403, "This Mini App tool is disabled for this bot.");
      if (!readOnly && !ctx.writeAllowed()) throw appFailure(403, "This turn may only read Mini Apps.");
    };
    let ownDataset: string | undefined;
    const actor: MiniAppActor = { botId: ctx.botId, writeAllowed: !readOnly, assertActive,
      canBind: (id) => id === ownDataset };
    try {
      assertActive();
      const raw = await ctx.readBody();
      assertActive();
      if (name === "mini_app_info") {
        const info = z.object({ app_id: z.uuid().optional(), guide: z.boolean().optional() }).strict().safeParse(raw);
        if (!info.success) throw appFailure(400, "mini_app_info takes an optional app_id and guide.");
        const result = info.data.app_id ? deps.apps.document(actor, info.data.app_id)
          : { apps: deps.apps.list(actor), dashboards: deps.apps.dashboardCatalog(actor) };
        return ctx.json(ctx.res, 200, { ...result, ...(info.data.guide ? { guide: MINI_APP_AUTHOR_GUIDE } : {}) });
      }
      if (name === "mini_app_connect") {
        if (!CONNECT.safeParse(raw).success) throw appFailure(400, "mini_app_connect connects only this bot's Data and takes no arguments.");
        const dataset = await deps.data.promoteForBot(ctx.botId, MINI_APPS_OWNER);
        assertActive();
        return ctx.json(ctx.res, 200, { dataset: await datasetInfo(deps.data, dataset.datasetId) });
      }
      if (name === "mini_app_report") {
        const input = parseReportTool(raw);
        const routines = deps.routines();
        const isRoutine = routines?.isActiveThread(ctx.threadId) ?? false;
        const activeRoutine = isRoutine ? routines!.runForThread(ctx.threadId) : null;
        if (isRoutine && (!activeRoutine || activeRoutine.botId !== ctx.botId || activeRoutine.target !== "bot" || activeRoutine.runOn !== "maus")) {
          throw appFailure(403, "This Automation has no matching producer Bot.");
        }
        const nominalAt = activeRoutine?.scheduledFor ?? null;
        const result = input.action === "prepare"
          ? await deps.reports.prepare(ctx.botId, input.kind, nominalAt)
          : await deps.reports.publish(ctx.botId, input.kind, input.edition, nominalAt, assertActive);
        assertActive();
        return ctx.json(ctx.res, 200, result);
      }
      if (name === "mini_app_publish") {
        const body = z.object({ app_id: z.uuid().optional(), publication: z.unknown() }).strict().safeParse(raw);
        if (!body.success || body.data.publication === undefined) throw appFailure(400, "mini_app_publish takes publication and optionally app_id.");
        const publication = parsePublish(body.data.publication);
        if (publication.shippedTemplateKind !== undefined) throw appFailure(403, "Only the workspace owner can identify a shipped template.");
        if (publication.bindings.length) ownDataset = (await deps.data.promoteForBot(ctx.botId, MINI_APPS_OWNER)).datasetId;
        assertActive();
        return ctx.json(ctx.res, 200, await deps.apps.publish(actor, publication, body.data.app_id));
      }
      const body = INTERNAL_ID.extend({ requestKey: z.string(), expectedRevision: z.number(), ...(name === "mini_app_rollback" ? { templateVersion: z.number() } : {}) }).safeParse(raw);
      if (!body.success) throw appFailure(400, "Pass app_id, requestKey and expectedRevision, and the templateVersion for rollback.");
      const { app_id: id, ...input } = body.data;
      if (name === "mini_app_rollback") {
        ownDataset = (await deps.data.promoteForBot(ctx.botId, MINI_APPS_OWNER)).datasetId;
        assertActive();
      }
      return ctx.json(ctx.res, 200, name === "mini_app_rollback" ? await deps.apps.rollback(actor, id, input) : deps.apps.archive(actor, id, input));
    } catch (error) {
      const failure = miniAppError(error);
      return ctx.json(ctx.res, failure.status, { error: failure.error, ...(failure.code ? { code: failure.code } : {}) });
    }
  };
}
