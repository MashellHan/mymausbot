import type { MiniAppDocument, MiniAppQueryBatchItem, MiniAppQueryBatchRequest, MiniAppQueryBatchResult, MiniAppState } from "../../../shared/mini-apps";
import type { MiniAppClientCache } from "./mini-app-client-cache";

export const MINI_APP_HOVER_PREFETCH_DWELL_MS = 80;

export function parameterlessInitialQueries(document: MiniAppDocument, state: MiniAppState): MiniAppQueryBatchItem[] {
  const revisions = new Map(state.data.map((entry) => [entry.datasetId, entry.revision]));
  const items: MiniAppQueryBatchItem[] = [];
  for (const binding of document.bindings) {
    const dataRevision = revisions.get(binding.datasetId);
    if (dataRevision === undefined) continue;
    for (const [queryId, query] of Object.entries(binding.queries)) {
      const hasRequiredParam = Object.values(query.parameters).some((param) => !param.optional);
      if (hasRequiredParam) continue;
      items.push({ queryId, parameters: {}, expectedDataRevision: dataRevision });
      if (items.length >= 8) return items;
    }
  }
  return items;
}

export function createMiniAppPrefetcher(options: {
  dwellMs?: number;
  cache: () => MiniAppClientCache;
  fetchState: (appId: string, signal: AbortSignal) => Promise<MiniAppState>;
  fetchDocument: (appId: string, signal: AbortSignal) => Promise<MiniAppDocument>;
  fetchBatch?: (appId: string, body: MiniAppQueryBatchRequest, signal: AbortSignal) => Promise<MiniAppQueryBatchResult>;
}) {
  const dwellMs = options.dwellMs ?? MINI_APP_HOVER_PREFETCH_DWELL_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Map<string, AbortController>();

  const prefetchNow = async (appId: string, revision: number, templateVersion: number): Promise<void> => {
    if (inflight.has(appId)) return;
    const cache = options.cache();
    const controller = new AbortController();
    inflight.set(appId, controller);
    try {
      const existingDoc = cache.getDocument(appId, revision, templateVersion);
      const [state, doc] = await Promise.all([
        options.fetchState(appId, controller.signal),
        existingDoc ? Promise.resolve(existingDoc) : options.fetchDocument(appId, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      if (doc.app.revision === state.revision && doc.app.templateVersion === state.templateVersion) {
        cache.setDocument(doc);
        if (options.fetchBatch && doc.bindings.length > 0 && state.status === "active") {
          const queries = parameterlessInitialQueries(doc, state);
          if (queries.length > 0) {
            const batchResult = await options.fetchBatch(appId, { expectedRevision: state.revision, queries }, controller.signal);
            if (controller.signal.aborted) return;
            const byQueryId = new Map(doc.bindings.flatMap((b) => Object.keys(b.queries).map((q) => [q, b.datasetId] as const)));
            queries.forEach((item, idx) => {
              const entry = batchResult.results[idx];
              const datasetId = byQueryId.get(item.queryId);
              if (!entry || !entry.ok || !datasetId || item.expectedDataRevision === undefined) return;
              const key = cache.queryKey({
                appId,
                appRevision: state.revision,
                datasetId,
                dataRevision: item.expectedDataRevision,
                queryId: item.queryId,
                parameters: item.parameters,
              });
              cache.setQuery(key, { appId, datasetId, dataRevision: item.expectedDataRevision }, entry.result);
            });
          }
        }
      }
    } catch {
      // Prefetch is strictly best-effort and silent.
    } finally {
      inflight.delete(appId);
    }
  };

  return {
    scheduleHover(appId: string, revision: number, templateVersion: number): void {
      if (timers.has(appId) || inflight.has(appId)) return;
      const timer = setTimeout(() => {
        timers.delete(appId);
        void prefetchNow(appId, revision, templateVersion);
      }, dwellMs);
      timers.set(appId, timer);
    },
    cancelHover(appId: string): void {
      const timer = timers.get(appId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(appId);
      }
    },
    prefetchIdle(appId: string, revision: number, templateVersion: number): void {
      void prefetchNow(appId, revision, templateVersion);
    },
    dispose(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
    },
  };
}
