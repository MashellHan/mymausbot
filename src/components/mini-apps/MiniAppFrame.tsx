import { useEffect, useLayoutEffect, useRef } from "react";
import { appVersion } from "@/lib/app-links";
import { activeLocale } from "@/lib/i18n";
import { api, ApiError } from "@/state/store";
import { utf8Bytes } from "../../../shared/app";
import { LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR } from "../../../shared/local-dashboard";
import type { MiniAppDataBinding, MiniAppNamedQuery } from "../../../shared/mini-app-data";
import type { MiniAppDashboardReadResult, MiniAppDashboardRequest, MiniAppDocument, MiniAppQuery, MiniAppQueryOptions,
  MiniAppQueryResult, MiniAppState } from "../../../shared/mini-apps";
import { mountAppFrame, type AppFrameHost } from "../app/app-frame-host";
import { appHostContext, appMaxHeight, appThemeContext } from "../app/app-host-context";
import { githubMediaUrlAllowed, isEligibleGithubActivityDocument, parseGithubSelection,
  type GithubActivitySelection } from "./github-activity-host";
import { miniAppFrameDocument } from "./mini-app-document";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

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
    teams: ["resource"], activity: activityFields,
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

export interface MiniAppFrameMount {
  readonly iframe: HTMLIFrameElement;
  update(state: MiniAppState): void;
  setGithubSelection(selection: GithubActivitySelection | null): void;
  contextChanged(width: number): void;
  retire(): void;
}

export function mountMiniAppFrame(options: {
  container: HTMLElement;
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
  githubSelection?: GithubActivitySelection | null;
  onGithubSelectionChange?(selection: GithubActivitySelection): void;
}): MiniAppFrameMount {
  if (!miniAppNativeFrameGuard()) throw new Error("This Mini App requires the guarded desktop window.");
  const { container, document } = options;
  let state = options.state;
  let currentGithubSelection = options.githubSelection ?? null;
  let frameInitialized = false;
  let active = true;
  let host: AppFrameHost | null = null;
  const frameDocument = miniAppFrameDocument(document, typeof window.ogb?.openExternal === "function");
  const controllers = new Map<AbortController, string>();
  const dashboardControllers = new Map<AbortController, string>();
  const mediaControllers = new Map<AbortController, string>();
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
  const reply = (id: string, result?: MiniAppQueryResult, error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "query-result", id, ...(error ? { error } : { result }) }, "*");
  };
  const replyDashboard = (id: string, result?: MiniAppDashboardReadResult, error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "dashboard-result", id, ...(error ? { error } : { result }) }, "*");
  };
  const replyMedia = (id: string, payload?: { mimeType: string; bytes: ArrayBuffer; sha256: string }, error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "media-result", id, ...(error ? { error } : payload) }, "*");
  };
  const handle = (event: MessageEvent) => {
    if (!active || !host || event.source !== host.iframe.contentWindow) return;
    if (record(event.data) && event.data.jsonrpc === "2.0" && event.data.method === "ui/notifications/initialized") {
      frameInitialized = true;
      postHostSelection(currentGithubSelection);
      return;
    }
    if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "selection") {
      if (!miniAppNativeFrameGuard() || !isEligibleGithubActivityDocument(document) || state.status !== "active"
        || state.appId !== document.app.id || state.revision !== document.app.revision) return;
      const parsedSelection = parseGithubSelection(event.data);
      if (parsedSelection) {
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
        || state.appId !== document.app.id || state.revision !== document.app.revision) {
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
      if (!miniAppNativeFrameGuard() || state.appId !== document.app.id || state.status !== "active"
        || document.app.status !== "active" || state.revision !== document.app.revision
        || document.app.dashboardIdentity !== "agent-team" || document.app.dashboard?.kind !== "agent-team"
        || document.app.dashboard.renderer !== "html") {
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
        if (!miniAppNativeFrameGuard() || result.appId !== document.app.id || result.revision !== revision
          || result.resource !== request.selection.resource || utf8Bytes(JSON.stringify(result)) > MAX_RESULT_BYTES) {
          return replyDashboard(request.id, undefined, "This dashboard changed while its data was being read.");
        }
        replyDashboard(request.id, result);
      }).catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) options.onRevoked();
        replyDashboard(request.id, undefined, error instanceof Error ? error.message : "The dashboard read failed. Try again.");
      }).finally(() => dashboardControllers.delete(controller));
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
    controllers.set(controller, request.id);
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
        if (!await window.ogb.openExternal(url)) throw new Error("The source link could not be opened.");
      },
      setContext: async () => { throw new Error("Model context is unavailable from a Mini App."); },
      resize: () => {},
      teardownRequested: () => host?.retire(),
    },
  });
  return {
    iframe: host.iframe,
    update(next) {
      if (!active || (next.revision === state.revision && next.status === state.status && next.data.length === state.data.length
        && next.data.every((entry, index) => entry.datasetId === state.data[index]?.datasetId && entry.revision === state.data[index]?.revision))) return;
      state = next;
      for (const [controller, id] of controllers) { controller.abort(); reply(id, undefined, "Data changed while this report was being read. Refresh and try again."); }
      for (const [controller, id] of dashboardControllers) { controller.abort(); replyDashboard(id, undefined, "This dashboard changed. Refresh and try again."); }
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
    retire() {
      if (!active) return;
      for (const [controller, id] of controllers) { controller.abort(); reply(id, undefined, "This app was closed."); }
      for (const [controller, id] of dashboardControllers) { controller.abort(); replyDashboard(id, undefined, "This app was closed."); }
      for (const [controller, id] of mediaControllers) { controller.abort(); replyMedia(id, undefined, "This app was closed."); }
      active = false;
      window.removeEventListener("message", handle);
      host?.retire();
    },
  };
}

export function MiniAppFrame({ document, state, onRevoked, githubSelection, onGithubSelectionChange }: {
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
  githubSelection?: GithubActivitySelection | null;
  onGithubSelectionChange?(selection: GithubActivitySelection): void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mount = useRef<MiniAppFrameMount | null>(null);
  const revoked = useRef(onRevoked);
  const selectionRef = useRef(githubSelection ?? null);
  const selectionChangeRef = useRef(onGithubSelectionChange);
  revoked.current = onRevoked;
  selectionRef.current = githubSelection ?? null;
  selectionChangeRef.current = onGithubSelectionChange;
  const bindings = JSON.stringify(document.bindings);
  const nativeGuard = miniAppNativeFrameGuard();

  useLayoutEffect(() => {
    if (!nativeGuard || !box.current) return;
    const current = mountMiniAppFrame({
      container: box.current,
      document,
      state,
      onRevoked: () => revoked.current(),
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
  }, [document.app.id, document.app.templateVersion, document.html, bindings, nativeGuard]);

  useEffect(() => { mount.current?.update(state); }, [state]);
  useEffect(() => { mount.current?.setGithubSelection(githubSelection ?? null); }, [githubSelection?.editionKey, githubSelection?.repo]);
  return nativeGuard ? <div ref={box} className="min-h-0 min-w-0 flex-1" data-testid="mini-app-frame" /> : null;
}
