import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { appVersion } from "@/lib/app-links";
import { activeLocale } from "@/lib/i18n";
import { api, ApiError } from "@/state/store";
import { utf8Bytes } from "../../../shared/app";
import { LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR } from "../../../shared/local-dashboard";
import type { MiniAppDataBinding, MiniAppNamedQuery } from "../../../shared/mini-app-data";
import type { MiniAppDashboardReadResult, MiniAppDashboardRequest, MiniAppDashboardResource, MiniAppDocument, MiniAppQuery, MiniAppQueryBatchRequest, MiniAppQueryBatchResult, MiniAppQueryOptions,
  MiniAppQueryResult, MiniAppState } from "../../../shared/mini-apps";
import { mountAppFrame, type AppFrameHost } from "../app/app-frame-host";
import { appHostContext, appMaxHeight, appThemeContext } from "../app/app-host-context";
import { githubMediaUrlAllowed, isEligibleGithubActivityDocument, parseGithubSelection,
  type GithubActivitySelection } from "./github-activity-host";
import { isManagedHongguoDocument, mountManagedHongguoFrame } from "./hongguo-frame-host";
import { AgentRoleEditor, type AgentRoleEditorSelection } from "./AgentRoleEditor";
import { MiniAppSiteOverlay } from "./MiniAppSiteOverlay";
import { isCustomLocalMiniApp, miniAppFrameDocument } from "./mini-app-document";
import { createMiniAppSitePresentation, managedMiniAppSite, type MiniAppSite, type MiniAppSiteView } from "./mini-app-site";
import { miniAppNativeFrameGuard } from "./native-frame-guard";
import { miniAppPerfTelemetry } from "./mini-app-telemetry";

const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1_000_000;
const MAX_READS_PER_MINUTE = 240;
const ALLOWED_GITHUB_MEDIA_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "video/mp4", "video/webm",
]);

type FrameQuery = { mausMiniApp: 1; type: "query"; id: string; queryId: string; parameters: Record<string, string | string[]>; options?: MiniAppQueryOptions };
type FrameDashboard = { mausMiniApp: 1; type: "dashboard-read"; id: string; selection: MiniAppDashboardRequest };
type FrameMediaRead = { mausMiniApp: 1; type: "media-read"; id: string; url: string; sha256: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function declaredQuery(bindings: MiniAppDataBinding[], queryId: string): { binding: MiniAppDataBinding; query: MiniAppNamedQuery } | null {
  const found = bindings.flatMap((binding) => Object.hasOwn(binding.queries, queryId) ? [{ binding, query: binding.queries[queryId]! }] : []);
  return found.length === 1 ? found[0]! : null;
}

function parseFrameQuery(value: unknown, bindings: MiniAppDataBinding[]): { request: FrameQuery; binding: MiniAppDataBinding } | null {
  if (!record(value) || value.mausMiniApp !== 1 || value.type !== "query" || typeof value.id !== "string" || value.id.length > 100
    || !value.id || typeof value.queryId !== "string" || !record(value.parameters)) return null;
  const declared = declaredQuery(bindings, value.queryId);
  if (!declared) return null;
  for (const [key, parameter] of Object.entries(value.parameters)) {
    if (!Object.hasOwn(declared.query.parameters, key)) return null;
    if (typeof parameter !== "string" && (!Array.isArray(parameter) || !parameter.every((item) => typeof item === "string"))) return null;
  }
  const options = value.options;
  if (options !== undefined && (!record(options) || Object.keys(options).some((key) => key !== "cursor" && key !== "expectedDataRevision")
    || (options.cursor !== undefined && (typeof options.cursor !== "string" || options.cursor.length > 4_096))
    || (options.expectedDataRevision !== undefined && (!Number.isSafeInteger(options.expectedDataRevision) || Number(options.expectedDataRevision) < 0)))) return null;
  try {
    if (utf8Bytes(JSON.stringify({ queryId: value.queryId, parameters: value.parameters, options })) > MAX_ARGUMENT_BYTES) return null;
  } catch { return null; }
  return { request: value as FrameQuery, binding: declared.binding };
}

function parseFrameDashboard(value: unknown): FrameDashboard | null {
  if (!record(value) || value.mausMiniApp !== 1 || value.type !== "dashboard-read" || typeof value.id !== "string"
    || !value.id || value.id.length > 100 || !record(value.selection)) return null;
  const selection = value.selection;
  const activityFields = ["resource", "agentId", "occupantId"];
  if (selection.resource === "activity" && selection.history === 1) {
    activityFields.push("history");
    if (selection.before !== undefined) {
      if (typeof selection.before !== "string" || !LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR.test(selection.before)) return null;
      activityFields.push("before");
    }
  }
  const fields: Record<string, string[]> = {
    teams: ["resource"], usage: ["resource"], activity: activityFields,
    configuration: ["resource", "agentId", "occupantId"], "team-rules": ["resource", "teamId"],
    skill: ["resource", "agentId", "occupantId", "skillId"],
  };
  if (typeof selection.resource !== "string" || !Object.hasOwn(fields, selection.resource)
    || Object.keys(selection).length !== fields[selection.resource]!.length
    || Object.keys(selection).some((key) => !fields[String(selection.resource)]!.includes(key))) return null;
  if ((selection.resource === "activity" && (typeof selection.agentId !== "string" || !/^w\d+:p[0-9A-Za-z]+$/.test(selection.agentId))
      || (selection.resource === "configuration" || selection.resource === "skill")
        && (typeof selection.agentId !== "string" || !/^w\d+:p[0-9A-Za-z]+$/.test(selection.agentId)))
    || (selection.resource === "activity" || selection.resource === "configuration" || selection.resource === "skill")
      && (typeof selection.occupantId !== "string" || !/^o[0-9a-f]{16}$/.test(selection.occupantId))
    || selection.resource === "team-rules" && (typeof selection.teamId !== "string" || !/^w\d+$/.test(selection.teamId))
    || selection.resource === "skill" && (typeof selection.skillId !== "string" || !/^s[0-9a-f]{16}$/.test(selection.skillId))) return null;
  try { if (utf8Bytes(JSON.stringify(selection)) > 512) return null; } catch { return null; }
  return value as FrameDashboard;
}

function parseFrameMediaRead(value: unknown): FrameMediaRead | null {
  if (!record(value) || value.mausMiniApp !== 1 || value.type !== "media-read"
    || typeof value.id !== "string" || !value.id || value.id.length > 100
    || typeof value.url !== "string" || !githubMediaUrlAllowed(value.url)
    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    return null;
  }
  return value as FrameMediaRead;
}

function isAgentRoleEditorApp(app: MiniAppDocument["app"]): boolean {
  return app.dashboardIdentity === "agent-team" && app.release?.packageId === "mashellhan.agent-team"
    && app.dashboard?.kind === "agent-team" && app.dashboard.renderer === "html"
    && (app.dashboard.resources as readonly string[]).includes("configuration");
}

export interface MiniAppFrameMount {
  readonly iframe: HTMLIFrameElement;
  update(state: MiniAppState, document?: MiniAppDocument): void;
  setGithubSelection(selection: GithubActivitySelection | null): void;
  contextChanged(width: number): void;
  refresh(refreshKey: number): void;
  agentRoleChanged(): void;
  retire(): void;
}

export function mountMiniAppFrame(options: {
  container: HTMLElement;
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
  onChanged?(): void;
  onRuntimeReady?(info: { appId: string; revision: number; templateVersion: number }): void;
  onAgentRoleEdit?(selection: AgentRoleEditorSelection): void;
  site?: MiniAppSite;
  onSiteView?(view: MiniAppSiteView): void;
  hongguo?: boolean;
  refreshKey?: number;
  githubSelection?: GithubActivitySelection | null;
  onGithubSelectionChange?(selection: GithubActivitySelection): void;
}): MiniAppFrameMount {
  if (!miniAppNativeFrameGuard()) throw new Error("This Mini App requires the guarded desktop window.");
  const { container } = options;
  let document = options.document;
  let state = options.state;
  let currentGithubSelection = options.githubSelection ?? null;
  let frameInitialized = false;
  let runtimeReadyNotified = false;
  let active = true;
  let host: AppFrameHost | null = null;
  const installed = document.app;
  const localWindow = () => miniAppNativeFrameGuard() && window.ogb?.app?.ownPage === true && window.ogb?.remoteClient?.active !== true;
  const site = localWindow() && options.site === managedMiniAppSite(document) ? options.site : undefined;
  const hongguo = localWindow() && options.hongguo === true && isManagedHongguoDocument(document);
  const roleEditor = localWindow() && window.ogb?.platform === "darwin" && !!options.onAgentRoleEdit && isAgentRoleEditorApp(installed);
  const frameDocument = miniAppFrameDocument(document, typeof window.ogb?.openExternal === "function", { site, hongguo, roleEditor });
  let hongguoMount: ReturnType<typeof mountManagedHongguoFrame> | undefined;
  let refreshKey = options.refreshKey ?? 0;
  const scopeCurrent = () => active && localWindow() && !!host && host.iframe.parentNode === container && host.iframe.srcdoc === frameDocument.srcdoc
    && state.status === "active" && state.appId === installed.id && state.revision === installed.revision && state.templateVersion === installed.templateVersion
    && document.app.id === installed.id && document.app.revision === installed.revision && document.app.templateVersion === installed.templateVersion
    && managedMiniAppSite(document) === site;
  const controllers = new Map<AbortController, string[]>();
  const dashboardControllers = new Map<AbortController, string>();
  const mediaControllers = new Map<AbortController, string>();
  const usageFrame = document.app.dashboard?.kind === "usage" && document.app.dashboard.renderer === "html";
  const usageFrameVisible = () => container.ownerDocument.visibilityState === "visible"
    && container.clientWidth > 0 && container.clientHeight > 0;
  let recentReads: number[] = [];
  const postHostSelection = (selection: GithubActivitySelection | null) => {
    if (!active || !frameInitialized || !selection || !isEligibleGithubActivityDocument(document) || !miniAppNativeFrameGuard()) return;
    host?.iframe.contentWindow?.postMessage({
      mausMiniApp: 1,
      type: "host-selection",
      editionKey: selection.editionKey,
      repo: selection.repo,
    }, "*");
  };
  const sitePresentation = site ? createMiniAppSitePresentation({ site, isCurrent: scopeCurrent,
    onView: (view) => options.onSiteView?.(view),
    onGithubSelection(selection) {
      currentGithubSelection = selection;
      postHostSelection(selection);
      options.onGithubSelectionChange?.(selection);
    },
  }) : undefined;
  const retireScoped = () => { sitePresentation?.retire(); hongguoMount?.retire(); };
  const reply = (id: string, result?: MiniAppQueryResult, error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "query-result", id, ...(error ? { error } : { result }) }, "*");
  };
  const replyBatch = (id: string, result?: MiniAppQueryResult[], error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "query-batch-result", id, ...(error ? { error } : { result }) }, "*");
  };
  const acceptsDashboardRequest = (resource: MiniAppDashboardResource) => {
    const { app, bindings } = document;
    const dashboard = app.dashboard;
    return miniAppNativeFrameGuard() && state.appId === app.id && state.status === "active"
      && app.status === "active" && state.revision === app.revision && state.templateVersion === app.templateVersion
      && dashboard?.renderer === "html" && dashboard.kind === app.dashboardIdentity
      && (dashboard.resources as readonly MiniAppDashboardResource[]).includes(resource)
      && (resource !== "usage" || frameInitialized && usageFrameVisible() && bindings.length === 0 && state.data.length === 0
        && window.ogb?.app?.ownPage === true && window.ogb?.remoteClient?.active !== true);
  };
  const replyDashboard = (id: string, result?: MiniAppDashboardReadResult, error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "dashboard-result", id, ...(error ? { error } : { result }) }, "*");
  };
  const cancelDashboardReads = (error: string) => {
    for (const [controller, id] of dashboardControllers) {
      dashboardControllers.delete(controller);
      controller.abort();
      replyDashboard(id, undefined, error);
    }
  };
  const cancelHiddenUsageReads = () => {
    if (!usageFrameVisible()) cancelDashboardReads("This Activities frame is hidden.");
  };
  const usageFrameSize = usageFrame && typeof ResizeObserver !== "undefined" ? new ResizeObserver(cancelHiddenUsageReads) : null;
  if (usageFrame) {
    usageFrameSize?.observe(container);
    container.ownerDocument.addEventListener("visibilitychange", cancelHiddenUsageReads);
  }
  const replyMedia = (id: string, payload?: { mimeType: string; bytes: ArrayBuffer; sha256: string }, error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "media-result", id, ...(error ? { error } : payload) }, "*");
  };
  const handle = (event: MessageEvent) => {
    if (!active || !host || !host.iframe.contentWindow || event.source !== host.iframe.contentWindow) return;
    if (sitePresentation?.receive(event, host.iframe, frameInitialized)) return;
    if (record(event.data) && event.data.jsonrpc === "2.0" && event.data.method === "ui/notifications/initialized") {
      frameInitialized = true;
      miniAppPerfTelemetry().markIframeInit(document.app.id);
      postHostSelection(currentGithubSelection);
      return;
    }
    if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "agent-md-edit") {
      const { id, selection } = event.data;
      if (typeof id !== "string" || !id || id.length > 100) return;
      if (!roleEditor || !scopeCurrent() || !frameInitialized || !usageFrameVisible() || event.origin !== "null"
          || Object.keys(event.data).length !== 4 || !record(selection) || Object.keys(selection).length !== 2
          || typeof selection.agentId !== "string" || selection.agentId.length > 64 || !/^w\d+:p[0-9A-Za-z]+$/.test(selection.agentId)
          || typeof selection.occupantId !== "string" || !/^o[0-9a-f]{16}$/.test(selection.occupantId)) {
        return replyDashboard(id, undefined, "Agent MD editing is unavailable.");
      }
      options.onAgentRoleEdit?.({ agentId: selection.agentId, occupantId: selection.occupantId, appId: installed.id, revision: installed.revision });
      return replyDashboard(id);
    }
    if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "runtime-ready") {
      if (event.origin !== "null" || Object.keys(event.data).length !== 2) return;
      if (runtimeReadyNotified || !miniAppNativeFrameGuard() || !frameInitialized
        || state.status !== "active" || document.app.status !== "active"
        || state.appId !== document.app.id || state.revision !== document.app.revision
        || state.templateVersion !== document.app.templateVersion
        || !(document.app as { release?: unknown }).release) {
        return;
      }
      runtimeReadyNotified = true;
      miniAppPerfTelemetry().markReady(document.app.id);
      options.onRuntimeReady?.({
        appId: document.app.id,
        revision: document.app.revision,
        templateVersion: document.app.templateVersion,
      });
      return;
    }
    if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "selection") {
      if (!miniAppNativeFrameGuard() || !isEligibleGithubActivityDocument(document) || state.status !== "active"
        || state.appId !== document.app.id || state.revision !== document.app.revision) return;
      if (sitePresentation && (event.origin !== "null" || !scopeCurrent() || !usageFrameVisible())) return;
      const parsedSelection = parseGithubSelection(event.data);
      if (parsedSelection && (!sitePresentation || sitePresentation.setGithubSelection(parsedSelection))) {
        currentGithubSelection = parsedSelection;
        options.onGithubSelectionChange?.(parsedSelection);
      }
      return;
    }
    if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "media-read") {
      const request = parseFrameMediaRead(event.data);
      if (!request) {
        if (typeof event.data.id === "string") replyMedia(event.data.id, undefined, "This media request is unavailable.");
        return;
      }
      if (!miniAppNativeFrameGuard() || !isEligibleGithubActivityDocument(document) || state.status !== "active"
        || state.appId !== document.app.id || state.revision !== document.app.revision
        || (sitePresentation && (!scopeCurrent() || !usageFrameVisible() || event.origin !== "null"))) {
        return replyMedia(request.id, undefined, "GitHub Activity media is unavailable.");
      }
      const now = Date.now();
      recentReads = recentReads.filter((at) => now - at < 60_000);
      if (recentReads.length >= MAX_READS_PER_MINUTE) return replyMedia(request.id, undefined, "Too many reads. Wait a minute and try again.");
      recentReads.push(now);
      const controller = new AbortController();
      mediaControllers.set(controller, request.id);
      const revision = state.revision;
      const mediaEndpoint = `/api/mini-apps/${encodeURIComponent(document.app.id)}/github-activity/media?expectedRevision=${revision}&url=${encodeURIComponent(request.url)}&sha256=${encodeURIComponent(request.sha256)}`;
      const timeoutSignal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(20_000) : undefined;
      const signal = timeoutSignal && typeof AbortSignal.any === "function"
        ? AbortSignal.any([controller.signal, timeoutSignal]) : controller.signal;
      void fetch(mediaEndpoint, { method: "GET", signal }).then(async (response) => {
        if (!response.ok) {
          const rawBody: unknown = await response.json().catch(() => null);
          const errorBody = record(rawBody) ? rawBody : undefined;
          const message = typeof errorBody?.error === "string" ? errorBody.error : `${response.status} ${response.statusText}`;
          throw new ApiError(message, response.status, errorBody);
        }
        const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
        if (!ALLOWED_GITHUB_MEDIA_MIME.has(mimeType)) throw new Error("Unsupported media content type.");
        const bytes = await response.arrayBuffer();
        if (!active || state.revision !== revision || controller.signal.aborted) return;
        if (!miniAppNativeFrameGuard()) return replyMedia(request.id, undefined, "This Mini App requires the guarded desktop window.");
        if (sitePresentation && (!scopeCurrent() || !usageFrameVisible())) return replyMedia(request.id, undefined, "GitHub Activity media is unavailable.");
        replyMedia(request.id, { mimeType, bytes, sha256: request.sha256 });
      }).catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        const policyDenied = error instanceof ApiError && error.status === 403
          && error.body?.code === "github_media_policy_denied";
        if (error instanceof ApiError && (error.status === 401 || (error.status === 403 && !policyDenied))) {
          options.onRevoked();
        }
        replyMedia(request.id, undefined, error instanceof Error ? error.message : "The media read failed. Try again.");
      }).finally(() => mediaControllers.delete(controller));
      return;
    }
    if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "dashboard-read") {
      const request = parseFrameDashboard(event.data);
      if (!request) {
        if (typeof event.data.id === "string") replyDashboard(event.data.id, undefined, "This dashboard resource or its parameters are unavailable.");
        return;
      }
      if (!acceptsDashboardRequest(request.selection.resource)) {
        return replyDashboard(request.id, undefined, "This dashboard is unavailable. Refresh and try again.");
      }
      const now = Date.now();
      recentReads = recentReads.filter((at) => now - at < 60_000);
      if (recentReads.length >= MAX_READS_PER_MINUTE) return replyDashboard(request.id, undefined, "Too many reads. Wait a minute and try again.");
      recentReads.push(now);
      const controller = new AbortController();
      dashboardControllers.set(controller, request.id);
      const revision = state.revision;
      void api<MiniAppDashboardReadResult>(`/api/mini-apps/${encodeURIComponent(document.app.id)}/dashboard`, {
        method: "POST", body: JSON.stringify({ ...request.selection, expectedRevision: revision }), signal: controller.signal, timeoutMs: 15_000,
      }).then((result) => {
        if (!active || state.revision !== revision || controller.signal.aborted) return;
        if (!acceptsDashboardRequest(request.selection.resource) || result.appId !== document.app.id || result.revision !== revision
          || result.resource !== request.selection.resource || utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) {
          return replyDashboard(request.id, undefined, "This dashboard changed while its data was being read.");
        }
        replyDashboard(request.id, result);
      }).catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof ApiError) {
          if (error.status === 401 || error.status === 403 || (usageFrame && error.status === 404)) options.onRevoked();
          else if (usageFrame && error.status === 409) options.onChanged?.();
        }
        replyDashboard(request.id, undefined, error instanceof Error ? error.message : "The dashboard read failed. Try again.");
      }).finally(() => dashboardControllers.delete(controller));
      return;
    }
    if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "query-batch") {
      const reqId = typeof event.data.id === "string" && event.data.id && event.data.id.length <= 100 ? event.data.id : null;
      if (!reqId) return;
      if (!Array.isArray(event.data.queries) || event.data.queries.length < 1 || event.data.queries.length > 16) {
        return replyBatch(reqId, undefined, "This query batch is invalid.");
      }
      if (!miniAppNativeFrameGuard()) return replyBatch(reqId, undefined, "This Mini App requires the guarded desktop window.");
      if (state.appId !== document.app.id || state.status !== "active" || document.app.status !== "active") {
        return replyBatch(reqId, undefined, "This app is archived and cannot read data.");
      }
      if (state.revision !== document.app.revision) return replyBatch(reqId, undefined, "Data changed while this report was being read. Refresh and try again.");
      const items: Array<{ queryId: string; parameters: Record<string, string | string[]>; cursor?: string; expectedDataRevision: number; datasetId: string }> = [];
      for (const rawItem of event.data.queries) {
        const parsedItem = parseFrameQuery({ mausMiniApp: 1, type: "query", id: reqId, ...(record(rawItem) ? rawItem : {}) }, document.bindings);
        if (!parsedItem) return replyBatch(reqId, undefined, "This query or its parameters are unavailable.");
        const itemDataRev = state.data.find((entry) => entry.datasetId === parsedItem.binding.datasetId)?.revision;
        if (itemDataRev === undefined) return replyBatch(reqId, undefined, "This app's data is unavailable. Refresh and try again.");
        if (parsedItem.request.options?.expectedDataRevision !== undefined && parsedItem.request.options.expectedDataRevision !== itemDataRev) {
          return replyBatch(reqId, undefined, "Data changed while this report was being read. Refresh and try again.");
        }
        items.push({
          queryId: parsedItem.request.queryId,
          parameters: parsedItem.request.parameters,
          ...(parsedItem.request.options?.cursor ? { cursor: parsedItem.request.options.cursor } : {}),
          expectedDataRevision: itemDataRev,
          datasetId: parsedItem.binding.datasetId,
        });
      }
      const now = Date.now();
      recentReads = recentReads.filter((at) => now - at < 60_000);
      if (recentReads.length >= MAX_READS_PER_MINUTE) return replyBatch(reqId, undefined, "Too many reads. Wait a minute and try again.");
      recentReads.push(now);
      const controller = new AbortController();
      controllers.set(controller, [reqId]);
      const revision = state.revision;
      const body: MiniAppQueryBatchRequest = {
        expectedRevision: revision,
        queries: items.map(({ datasetId: _datasetId, ...rest }) => rest),
      };
      void api<MiniAppQueryBatchResult>(`/api/mini-apps/${encodeURIComponent(document.app.id)}/query-batch`, {
        method: "POST", body: JSON.stringify(body), signal: controller.signal, timeoutMs: 15_000,
      }).then((response) => {
        if (!active || state.revision !== revision || controller.signal.aborted) return;
        if (!miniAppNativeFrameGuard()) return replyBatch(reqId, undefined, "This Mini App requires the guarded desktop window.");
        const pages: MiniAppQueryResult[] = [];
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]!;
          if (state.data.find((entry) => entry.datasetId === item.datasetId)?.revision !== item.expectedDataRevision) {
            return replyBatch(reqId, undefined, "Data changed while this report was being read. Refresh and try again.");
          }
          const entry = response.results[i];
          if (!entry || !entry.ok) return replyBatch(reqId, undefined, entry && !entry.ok ? entry.error : "The data read failed. Try again.");
          if (!Array.isArray(entry.result.columns) || !Array.isArray(entry.result.rows) || entry.result.rows.length > 100
            || entry.result.revision !== item.expectedDataRevision || utf8Bytes(JSON.stringify(entry.result)) > MAX_RESULT_BYTES) {
            return replyBatch(reqId, undefined, "This result is too large. Narrow the query or use the next page.");
          }
          pages.push(entry.result);
        }
        replyBatch(reqId, pages);
      }).catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) options.onRevoked();
        replyBatch(reqId, undefined, error instanceof Error ? error.message : "The data read failed. Try again.");
      }).finally(() => controllers.delete(controller));
      return;
    }
    const parsed = parseFrameQuery(event.data, document.bindings);
    if (!parsed) {
      if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "query" && typeof event.data.id === "string") {
        reply(event.data.id, undefined, "This query or its parameters are unavailable.");
      }
      return;
    }
    const { request, binding } = parsed;
    if (!miniAppNativeFrameGuard()) return reply(request.id, undefined, "This Mini App requires the guarded desktop window.");
    if (state.appId !== document.app.id || state.status !== "active" || document.app.status !== "active") {
      return reply(request.id, undefined, "This app is archived and cannot read data.");
    }
    if (state.revision !== document.app.revision) return reply(request.id, undefined, "Data changed while this report was being read. Refresh and try again.");
    const dataRevision = state.data.find((entry) => entry.datasetId === binding.datasetId)?.revision;
    if (dataRevision === undefined) return reply(request.id, undefined, "This app's data is unavailable. Refresh and try again.");
    if (request.options?.expectedDataRevision !== undefined && request.options.expectedDataRevision !== dataRevision) {
      return reply(request.id, undefined, "Data changed while this report was being read. Refresh and try again.");
    }
    const now = Date.now();
    recentReads = recentReads.filter((at) => now - at < 60_000);
    if (recentReads.length >= MAX_READS_PER_MINUTE) return reply(request.id, undefined, "Too many reads. Wait a minute and try again.");
    recentReads.push(now);
    const controller = new AbortController();
    controllers.set(controller, [request.id]);
    const revision = state.revision;
    const body: MiniAppQuery = {
      queryId: request.queryId,
      parameters: request.parameters,
      expectedRevision: revision,
      expectedDataRevision: dataRevision,
      ...(request.options?.cursor ? { cursor: request.options.cursor } : {}),
    };
    void api<MiniAppQueryResult>(`/api/mini-apps/${encodeURIComponent(document.app.id)}/query`, {
      method: "POST", body: JSON.stringify(body), signal: controller.signal, timeoutMs: 15_000,
    }).then((result) => {
      if (!active || state.revision !== revision || state.data.find((entry) => entry.datasetId === binding.datasetId)?.revision !== dataRevision) return;
      if (!miniAppNativeFrameGuard()) return reply(request.id, undefined, "This Mini App requires the guarded desktop window.");
      if (!Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length > 100 || result.revision !== dataRevision
        || utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) return reply(request.id, undefined, "This result is too large. Narrow the query or use the next page.");
      reply(request.id, result);
    }).catch((error: unknown) => {
      if (!active || controller.signal.aborted) return;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) options.onRevoked();
      reply(request.id, undefined, error instanceof Error ? error.message : "The data read failed. Try again.");
    }).finally(() => controllers.delete(controller));
  };
  window.addEventListener("message", handle);
  host = mountAppFrame({
    container, doc: frameDocument, title: document.app.title, height: 160, fill: true,
    hostContext: appHostContext({ width: container.clientWidth || 400, maxHeight: appMaxHeight() }), hostVersion: appVersion(),
    adapter: {
      callRpc: async () => { throw new Error("Generic app tools are unavailable."); },
      sendMessage: async () => { throw new Error("Chat is unavailable from a Mini App."); },
      openLink: async (url) => {
        if (!active || !frameDocument.can.openLinks || state.status !== "active" || !miniAppNativeFrameGuard() || !window.ogb?.openExternal)
          throw new Error("Links are unavailable from this Mini App.");
        if (isCustomLocalMiniApp(document.app)) {
          let parsed: URL;
          try { parsed = new URL(url); } catch { throw new Error("Only HTTPS links can be opened from this Mini App."); }
          if (parsed.protocol !== "https:") throw new Error("Only HTTPS links can be opened from this Mini App.");
        }
        if (!await window.ogb.openExternal(url)) throw new Error("The source link could not be opened.");
      },
      setContext: async () => { throw new Error("Model context is unavailable from a Mini App."); },
      resize: () => {},
      teardownRequested: () => { retireScoped(); host?.retire(); },
    },
  });
  if (hongguo) hongguoMount = mountManagedHongguoFrame({ container, iframe: host.iframe, document, getState: () => state,
    isInitialized: () => frameInitialized, visible: true, refreshKey,
    onRefused: (status) => status === 401 || status === 403 ? options.onRevoked() : options.onChanged?.(),
  });
  return {
    iframe: host.iframe,
    update(next, nextDocument) {
      const nextDoc = nextDocument && nextDocument.app.id === document.app.id ? nextDocument : undefined;
      const docChanged = !!nextDoc && (
        nextDoc.app.revision !== document.app.revision
        || nextDoc.app.templateVersion !== document.app.templateVersion
        || nextDoc.app.status !== document.app.status
      );
      const stateChanged = next.appId !== state.appId || next.templateVersion !== state.templateVersion || next.revision !== state.revision || next.status !== state.status || next.data.length !== state.data.length
        || next.data.some((entry, index) => entry.datasetId !== state.data[index]?.datasetId || entry.revision !== state.data[index]?.revision);
      if (!active || (!docChanged && !stateChanged)) return;
      state = next;
      if (nextDoc) document = nextDoc;
      sitePresentation?.checkCurrent();
      hongguoMount?.update({ visible: true, refreshKey });
      if (!stateChanged) return;
      for (const [controller, ids] of controllers) { controller.abort(); for (const id of ids) { reply(id, undefined, "Data changed while this report was being read. Refresh and try again."); replyBatch(id, undefined, "Data changed while this report was being read. Refresh and try again."); } }
      cancelDashboardReads("This dashboard changed. Refresh and try again.");
      for (const [controller, id] of mediaControllers) { controller.abort(); replyMedia(id, undefined, "Data changed while this media was being read. Refresh and try again."); }
      host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "data-changed" }, "*");
    },
    setGithubSelection(selection) {
      currentGithubSelection = selection;
      postHostSelection(selection);
    },
    contextChanged(width) {
      host?.contextChanged({ ...appThemeContext(), locale: activeLocale(), containerDimensions: { width, maxHeight: appMaxHeight() } });
    },
    refresh(next) {
      refreshKey = next;
      hongguoMount?.update({ visible: true, refreshKey });
    },
    agentRoleChanged() {
      if (roleEditor && scopeCurrent()) host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "data-changed" }, "*");
    },
    retire() {
      if (!active) return;
      retireScoped();
      for (const [controller, ids] of controllers) { controller.abort(); for (const id of ids) { reply(id, undefined, "This app was closed."); replyBatch(id, undefined, "This app was closed."); } }
      cancelDashboardReads("This app was closed.");
      usageFrameSize?.disconnect();
      if (usageFrame) container.ownerDocument.removeEventListener("visibilitychange", cancelHiddenUsageReads);
      for (const [controller, id] of mediaControllers) { controller.abort(); replyMedia(id, undefined, "This app was closed."); }
      active = false;
      window.removeEventListener("message", handle);
      host?.retire();
    },
  };
}

export function MiniAppFrame({ document, state, onRevoked, onChanged, onRuntimeReady, site, hongguo, refreshKey = 0, githubSelection, onGithubSelectionChange }: {
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
  onChanged?(): void;
  onRuntimeReady?(info: { appId: string; revision: number; templateVersion: number }): void;
  site?: MiniAppSite;
  hongguo?: boolean;
  refreshKey?: number;
  githubSelection?: GithubActivitySelection | null;
  onGithubSelectionChange?(selection: GithubActivitySelection): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [siteView, setSiteView] = useState<MiniAppSiteView>();
  const [roleEditor, setRoleEditor] = useState<AgentRoleEditorSelection | null>(null);
  const mount = useRef<MiniAppFrameMount | null>(null);
  const revoked = useRef(onRevoked);
  const dashboardChanged = useRef(onChanged);
  const runtimeReadyRef = useRef(onRuntimeReady);
  const selectionRef = useRef(githubSelection ?? null);
  const selectionChangeRef = useRef(onGithubSelectionChange);
  revoked.current = onRevoked;
  dashboardChanged.current = onChanged;
  runtimeReadyRef.current = onRuntimeReady;
  selectionRef.current = githubSelection ?? null;
  selectionChangeRef.current = onGithubSelectionChange;
  const bindings = JSON.stringify(document.bindings);
  const nativeGuard = miniAppNativeFrameGuard();
  const scopeRevision = site || hongguo || isAgentRoleEditorApp(document.app) ? document.app.revision : null;

  useLayoutEffect(() => {
    setRoleEditor(null);
    if (!nativeGuard || !box.current) return;
    const current = mountMiniAppFrame({
      container: box.current,
      document,
      state,
      onRevoked: () => revoked.current(),
      onChanged: () => dashboardChanged.current?.(),
      onRuntimeReady: (info) => runtimeReadyRef.current?.(info),
      onAgentRoleEdit: (selection) => setRoleEditor((current) => current ?? selection),
      site, onSiteView: setSiteView, hongguo, refreshKey,
      githubSelection: selectionRef.current,
      onGithubSelectionChange: (selection) => selectionChangeRef.current?.(selection),
    });
    mount.current = current;
    const changed = () => current.contextChanged(Math.round(box.current?.clientWidth || 400));
    const skin = typeof MutationObserver === "undefined" ? null : new MutationObserver(changed);
    skin?.observe(window.document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(changed);
    sized?.observe(box.current);
    window.addEventListener("resize", changed);
    return () => { skin?.disconnect(); sized?.disconnect(); window.removeEventListener("resize", changed); current.retire(); if (mount.current === current) mount.current = null; };
  }, [document.app.id, document.app.templateVersion, document.html, bindings, nativeGuard, site, hongguo, scopeRevision]);

  useLayoutEffect(() => { mount.current?.update(state, document); }, [state, document]);
  useEffect(() => { mount.current?.refresh(refreshKey); }, [refreshKey]);
  useEffect(() => { mount.current?.setGithubSelection(githubSelection ?? null); }, [githubSelection?.editionKey, githubSelection?.repo]);
  if (!nativeGuard) return null;
  const contents = <div ref={box} className="min-h-0 min-w-0 flex-1" data-testid="mini-app-frame" />;
  return site ? <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    {contents}
    <MiniAppSiteOverlay frameBox={box} view={siteView} />
  </div> : <>{contents}{roleEditor && roleEditor.appId === document.app.id && roleEditor.revision === document.app.revision
    && state.status === "active" && state.revision === roleEditor.revision
    && <AgentRoleEditor selection={roleEditor} onClose={() => setRoleEditor(null)} onSaved={() => mount.current?.agentRoleChanged()} />}</>;
}
