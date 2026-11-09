import { useEffect, useLayoutEffect, useRef } from "react";
import { appVersion } from "@/lib/app-links";
import { activeLocale } from "@/lib/i18n";
import { api, ApiError } from "@/state/store";
import { utf8Bytes } from "../../../shared/app";
import type { MiniAppDataBinding, MiniAppNamedQuery } from "../../../shared/mini-app-data";
import type { MiniAppDocument, MiniAppQuery, MiniAppQueryOptions, MiniAppQueryResult, MiniAppState } from "../../../shared/mini-apps";
import { mountAppFrame, type AppFrameHost } from "../app/app-frame-host";
import { appHostContext, appMaxHeight, appThemeContext } from "../app/app-host-context";
import { miniAppFrameDocument } from "./mini-app-document";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1_000_000;
const MAX_READS_PER_MINUTE = 240;

type FrameQuery = { mausMiniApp: 1; type: "query"; id: string; queryId: string; parameters: Record<string, string | string[]>; options?: MiniAppQueryOptions };

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

export interface MiniAppFrameMount {
  readonly iframe: HTMLIFrameElement;
  update(state: MiniAppState): void;
  contextChanged(width: number): void;
  retire(): void;
}

export function mountMiniAppFrame(options: {
  container: HTMLElement;
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
}): MiniAppFrameMount {
  if (!miniAppNativeFrameGuard()) throw new Error("This Mini App requires the guarded desktop window.");
  const { container, document } = options;
  let state = options.state;
  let active = true;
  let host: AppFrameHost | null = null;
  const frameDocument = miniAppFrameDocument(document);
  const controllers = new Map<AbortController, string>();
  let recentReads: number[] = [];
  const reply = (id: string, result?: MiniAppQueryResult, error?: string) => {
    if (!active) return;
    host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "query-result", id, ...(error ? { error } : { result }) }, "*");
  };
  const handle = (event: MessageEvent) => {
    if (!active || !host || event.source !== host.iframe.contentWindow) return;
    const parsed = parseFrameQuery(event.data, document.bindings);
    if (!parsed) {
      if (record(event.data) && event.data.mausMiniApp === 1 && event.data.type === "query" && typeof event.data.id === "string") {
        reply(event.data.id, undefined, "This query or its parameters are unavailable.");
      }
      return;
    }
    const { request, binding } = parsed;
    if (!miniAppNativeFrameGuard()) return reply(request.id, undefined, "This Mini App requires the guarded desktop window.");
    if (state.status !== "active") return reply(request.id, undefined, "This app is archived and cannot read data.");
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
      host?.iframe.contentWindow?.postMessage({ mausMiniApp: 1, type: "data-changed" }, "*");
    },
    contextChanged(width) {
      host?.contextChanged({ ...appThemeContext(), locale: activeLocale(), containerDimensions: { width, maxHeight: appMaxHeight() } });
    },
    retire() {
      if (!active) return;
      for (const [controller, id] of controllers) { controller.abort(); reply(id, undefined, "This app was closed."); }
      active = false;
      window.removeEventListener("message", handle);
      host?.retire();
    },
  };
}

export function MiniAppFrame({ document, state, onRevoked }: { document: MiniAppDocument; state: MiniAppState; onRevoked(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const mount = useRef<MiniAppFrameMount | null>(null);
  const revoked = useRef(onRevoked);
  revoked.current = onRevoked;
  const bindings = JSON.stringify(document.bindings);
  const nativeGuard = miniAppNativeFrameGuard();

  useLayoutEffect(() => {
    if (!nativeGuard || !box.current) return;
    const current = mountMiniAppFrame({ container: box.current, document, state, onRevoked: () => revoked.current() });
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
  return nativeGuard ? <div ref={box} className="min-h-0 min-w-0 flex-1" data-testid="mini-app-frame" /> : null;
}
