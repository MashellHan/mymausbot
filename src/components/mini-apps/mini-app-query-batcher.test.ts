import { describe, expect, it, vi } from "vitest";
import type { MiniAppQueryResult } from "../../../shared/mini-apps";
import { createMicrotaskQueryBatcher } from "./mini-app-query-batcher";

const page = (revision: number, value: number): MiniAppQueryResult => ({
  columns: [{ name: "v", type: "decimal" }],
  rows: [[value]],
  revision,
});

describe("createMicrotaskQueryBatcher", () => {
  it("coalesces multiple synchronous queries into one query-batch call and isolates per-item errors", async () => {
    const sendSingle = vi.fn();
    const sendBatch = vi.fn(async () => ({
      appId: "app-1",
      revision: 3,
      results: [
        { ok: true as const, result: page(7, 10) },
        { ok: false as const, status: 400, error: "Undeclared query" },
        { ok: true as const, result: page(7, 30) },
      ],
    }));
    const replies: Array<{ id: string; result?: MiniAppQueryResult; error?: string }> = [];
    const batcher = createMicrotaskQueryBatcher({
      maxResultBytes: 1_000_000,
      sendSingle,
      sendBatch,
      isStillValid: () => true,
      onError: vi.fn(),
      trackController: () => () => {},
    });

    for (const [requestId, queryId] of [["r1", "q1"], ["r2", "bad"], ["r3", "q3"]] as const) {
      batcher.enqueue(3, {
        requestId,
        queryId,
        parameters: {},
        datasetId: "ds-1",
        dataRevision: 7,
        reply: (result, error) => replies.push({ id: requestId, result, error }),
      });
    }

    await vi.waitFor(() => expect(replies).toHaveLength(3));
    expect(sendSingle).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(replies).toEqual([
      { id: "r1", result: page(7, 10), error: undefined },
      { id: "r2", result: undefined, error: "Undeclared query" },
      { id: "r3", result: page(7, 30), error: undefined },
    ]);
  });

  it("uses single /query path when only one query is queued in a microtask", async () => {
    const sendSingle = vi.fn(async () => page(7, 99));
    const sendBatch = vi.fn();
    const replies: Array<{ id: string; result?: MiniAppQueryResult; error?: string }> = [];
    const batcher = createMicrotaskQueryBatcher({
      maxResultBytes: 1_000_000,
      sendSingle,
      sendBatch,
      isStillValid: () => true,
      onError: vi.fn(),
      trackController: () => () => {},
    });

    batcher.enqueue(3, {
      requestId: "r1",
      queryId: "q1",
      parameters: {},
      datasetId: "ds-1",
      dataRevision: 7,
      reply: (result, error) => replies.push({ id: "r1", result, error }),
    });

    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(sendSingle).toHaveBeenCalledTimes(1);
    expect(sendBatch).not.toHaveBeenCalled();
    expect(replies[0]?.result?.rows).toEqual([[99]]);
  });
});
