import type { ServerResponse } from "node:http";
import { z } from "zod";
import { allowsTool } from "../../shared/tool-scope.ts";
import { createReportTemplate } from "../../shared/report-mini-app-template.ts";
import type { MiniAppDataset, MiniAppSources } from "../../shared/mini-apps.ts";
import type { DataEngine } from "../data/types.ts";
import { DataFailure } from "../data/types.ts";
import { quoteIdentifier } from "../data/sql-identifiers.ts";
import { createChatApps } from "../chat-apps.ts";
import { appDocRefs } from "../message-db.ts";
import type { json as sendJson } from "../harness/http.ts";
import { MINI_APP_TOOL_ROUTES } from "../drivers/agents-mini-app-tools.ts";
import { MiniApps, MINI_APPS_OWNER, miniAppDocRefs, type MiniAppActor } from "../mini-apps/registry.ts";
import { appFailure, parsePublish } from "../mini-apps/validation.ts";
import { MINI_APP_AUTHOR_GUIDE } from "../mini-apps/author-guide.ts";
import { ReportStore } from "../mini-apps/report-store.ts";
import { parseReportTool, reportKindSchema } from "../mini-apps/report-schema.ts";
import { localDashboardProviders, type LocalDashboardProviders } from "./local-dashboard.ts";
import type { RoutineManager } from "../routines.ts";
import { PASS, type RouteHandler } from "./table.ts";

const ROOT = "/api/mini-apps";
const REPORT_SOURCE = `${ROOT}/report-source`;
const APP_PATH = /^\/api\/mini-apps\/([0-9a-f-]{36})(?:\/(state|query|dashboard|publish|rollback|archive))?$/;
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
}

export function createMiniAppRouteHandlers(input: Omit<MiniAppRouteDeps, "apps" | "reports"> & {
  store: Parameters<typeof createChatApps>[0]["store"];
  dataDir: string;
  validPublisher(id: string): boolean;
  dashboardProviders?: LocalDashboardProviders;
}) {
  const { store, dataDir, validPublisher, dashboardProviders, ...shared } = input;
  const chatApps = createChatApps({ store, dataDir,
    references: () => [...appDocRefs(), ...miniAppDocRefs()] });
  const deps = { ...shared, apps: new MiniApps({ docs: chatApps.docs, data: shared.data, validPublisher,
    dashboardProviders: dashboardProviders ?? localDashboardProviders }),
    reports: new ReportStore(shared.data, createReportTemplate) };
  return { chatApps, owner: createMiniAppRoutes(deps), internal: createMiniAppsInternalRoutes(deps) };
}

export function miniAppError(error: unknown): { status: number; error: string; code?: string } {
  if (error instanceof DataFailure) {
    const status = error.error.code === "spec_invalid" || error.error.code === "invalid_input" ? 400
      : error.error.code === "table_not_found" || error.error.code === "write_refused" || error.error.code === "cancelled" ? 409
      : error.error.code === "output_too_large" ? 413 : 503;
    return { status, error: error.message, code: error.error.code };
  }
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
  return { status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500,
    error: error instanceof Error ? error.message : "Mini Apps are unavailable." };
}

async function datasetInfo(data: DataEngine, datasetId: string): Promise<MiniAppDataset> {
  const entry = (await data.listDatasets(MINI_APPS_OWNER)).find((candidate) => candidate.datasetId === datasetId);
  if (!entry) throw appFailure(404, "Data source not found.");
  const database = await data.forDataset(datasetId, MINI_APPS_OWNER);
  return { datasetId, revision: entry.revision, tables: await database.listSourceTables() };
}

export function createMiniAppRoutes(deps: MiniAppRouteDeps): RouteHandler {
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
      if (url.search) throw appFailure(400, "Query parameters are not supported.");
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
      if (method !== "POST") throw appFailure(405, "Method not allowed.");
      if (action === "dashboard") return json(res, 200, await deps.apps.dashboardRead(owner, id, await readBody(req, 4096)));
      const body: unknown = await readBody(req, action === "publish" ? 900_000 : 20_000);
      if (action === "query") return json(res, 200, await deps.apps.query(owner, id, body));
      if (action === "publish") return json(res, 200, await deps.apps.publish(owner, body, id));
      if (action === "rollback") return json(res, 200, await deps.apps.rollback(owner, id, body));
      if (action === "archive") return json(res, 200, deps.apps.archive(owner, id, body));
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
