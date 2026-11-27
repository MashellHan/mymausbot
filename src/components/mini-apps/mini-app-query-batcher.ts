import { utf8Bytes } from "../../../shared/app";
import type { MiniAppQueryBatchItem, MiniAppQueryBatchRequest, MiniAppQueryBatchResult, MiniAppQueryResult } from "../../../shared/mini-apps";

export const MINI_APP_QUERY_BATCH_MAX = 16;

export interface QueuedFrameQuery {
  requestId: string;
  queryId: string;
  parameters: Record<string, string | string[]>;
  cursor?: string;
  datasetId: string;
  dataRevision: number;
  reply: (result?: MiniAppQueryResult, error?: string) => void;
}

export function createMicrotaskQueryBatcher(options: {
  maxResultBytes: number;
  maxBatchSize?: number;
  sendSingle: (item: QueuedFrameQuery, revision: number, signal: AbortSignal) => Promise<MiniAppQueryResult>;
  sendBatch: (body: MiniAppQueryBatchRequest, signal: AbortSignal) => Promise<MiniAppQueryBatchResult>;
  isStillValid: (revision: number, datasetId: string, dataRevision: number) => boolean;
  onError: (error: unknown) => void;
  trackController: (controller: AbortController, ids: string[]) => () => void;
}) {
  const maxBatchSize = options.maxBatchSize ?? MINI_APP_QUERY_BATCH_MAX;
  let pending: Array<{ revision: number; item: QueuedFrameQuery }> = [];
  let scheduled = false;

  const validateResult = (result: MiniAppQueryResult, dataRevision: number): string | null => {
    if (!Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length > 100 || result.revision !== dataRevision
      || utf8Bytes(JSON.stringify(result)) > options.maxResultBytes) {
      return "This result is too large. Narrow the query or use the next page.";
    }
    return null;
  };

  const flush = () => {
    scheduled = false;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    const byRevision = new Map<number, QueuedFrameQuery[]>();
    for (const entry of batch) {
      const list = byRevision.get(entry.revision) ?? [];
      list.push(entry.item);
      byRevision.set(entry.revision, list);
    }
    for (const [revision, items] of byRevision) {
      for (let start = 0; start < items.length; start += maxBatchSize) {
        const slice = items.slice(start, start + maxBatchSize);
        if (slice.length === 1) {
          const single = slice[0]!;
          const controller = new AbortController();
          const untrack = options.trackController(controller, [single.requestId]);
          void options.sendSingle(single, revision, controller.signal)
            .then((result) => {
              if (controller.signal.aborted || !options.isStillValid(revision, single.datasetId, single.dataRevision)) return;
              const err = validateResult(result, single.dataRevision);
              if (err) single.reply(undefined, err);
              else single.reply(result);
            })
            .catch((error: unknown) => {
              if (controller.signal.aborted) return;
              options.onError(error);
              single.reply(undefined, error instanceof Error ? error.message : "The data read failed. Try again.");
            })
            .finally(untrack);
          continue;
        }
        const controller = new AbortController();
        const untrack = options.trackController(controller, slice.map((item) => item.requestId));
        const queries: MiniAppQueryBatchItem[] = slice.map((item) => ({
          queryId: item.queryId,
          parameters: item.parameters,
          expectedDataRevision: item.dataRevision,
          ...(item.cursor ? { cursor: item.cursor } : {}),
        }));
        void options.sendBatch({ expectedRevision: revision, queries }, controller.signal)
          .then((response) => {
            if (controller.signal.aborted) return;
            slice.forEach((item, index) => {
              if (!options.isStillValid(revision, item.datasetId, item.dataRevision)) return;
              const entry = response.results[index];
              if (!entry) return item.reply(undefined, "The data read failed. Try again.");
              if (!entry.ok) return item.reply(undefined, entry.error);
              const err = validateResult(entry.result, item.dataRevision);
              if (err) item.reply(undefined, err);
              else item.reply(entry.result);
            });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            options.onError(error);
            const message = error instanceof Error ? error.message : "The data read failed. Try again.";
            for (const item of slice) item.reply(undefined, message);
          })
          .finally(untrack);
      }
    }
  };

  return {
    enqueue(revision: number, item: QueuedFrameQuery): void {
      pending.push({ revision, item });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    clear(): void {
      pending = [];
      scheduled = false;
    },
  };
}
