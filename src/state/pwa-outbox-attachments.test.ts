// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AttachError,
  IMAGE_MAX_BYTES,
  attachmentImageUrl,
  composeMessage,
  splitTranscriptAttachments,
} from "@/lib/composer-attachments";
import { compressImageForOutbox } from "@/lib/pwa-image-compress";
import { OMB_PWA_OUTBOX_THREAD_INDEX, makePwaOwnerKey } from "@/lib/pwa-config";
import { setActivePwaAuth } from "@/lib/pwa-transport";
import { ApiError } from "./api";
import { createOutboxManager } from "./pwa-outbox";
import { clearOutboxPreviewCacheForTests, mergeOutboxUserAttachments } from "./pwa-outbox-attachments";
import { AttachmentGallery } from "@/components/AttachmentGallery";

const OWNER = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-1");
const THREAD = "t-receipts";

function clonePreservingBlobs<T>(value: T): T {
  if (value instanceof Blob) return value;
  if (Array.isArray(value)) return value.map((item) => clonePreservingBlobs(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clonePreservingBlobs(v);
    return out as T;
  }
  return value;
}

function createFakeIdb() {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string | undefined>();
  const ensureStore = (name: string) => {
    let map = stores.get(name);
    if (!map) {
      map = new Map();
      stores.set(name, map);
    }
    return map;
  };
  const factory = {
    open(_name: string) {
      const openReq: {
        result?: IDBDatabase;
        error: DOMException | null;
        onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
        onsuccess: ((ev: Event) => void) | null;
        onerror: ((ev: Event) => void) | null;
      } = { error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      const db = {
        objectStoreNames: { contains: (name: string) => stores.has(name) },
        createObjectStore: (name: string, opts?: { keyPath?: string }) => {
          ensureStore(name);
          keyPaths.set(name, opts?.keyPath);
          return { createIndex: () => ({}) } as unknown as IDBObjectStore;
        },
        close: () => {},
        transaction: () => {
          let completed = false;
          let pendingOps = 0;
          let commitScheduled = false;
          const maybeCommit = () => {
            if (commitScheduled || completed || pendingOps > 0) return;
            commitScheduled = true;
            Promise.resolve()
              .then(() => Promise.resolve())
              .then(() => Promise.resolve())
              .then(() => {
                commitScheduled = false;
                if (!completed && pendingOps === 0) {
                  completed = true;
                  tx.oncomplete?.(new Event("complete"));
                }
              });
          };
          const tx: {
            oncomplete: ((ev: Event) => void) | null;
            onerror: ((ev: Event) => void) | null;
            onabort: ((ev: Event) => void) | null;
            abort: () => void;
            objectStore: (name: string) => IDBObjectStore;
          } = {
            oncomplete: null,
            onerror: null,
            onabort: null,
            abort: () => queueMicrotask(() => tx.onabort?.(new Event("abort"))),
            objectStore: (name: string) => {
              const store = ensureStore(name);
              const kp = keyPaths.get(name);
              const schedule = <T>(fn: () => T) => {
                pendingOps += 1;
                const req: {
                  result?: T;
                  error: DOMException | null;
                  onsuccess: ((ev: Event) => void) | null;
                  onerror: ((ev: Event) => void) | null;
                } = { error: null, onsuccess: null, onerror: null };
                queueMicrotask(() => {
                  req.result = fn();
                  req.onsuccess?.(new Event("success"));
                  pendingOps -= 1;
                  maybeCommit();
                });
                return req as unknown as IDBRequest<T>;
              };
              maybeCommit();
              return {
                indexNames: { contains: (idx: string) => idx === OMB_PWA_OUTBOX_THREAD_INDEX },
                index: () => ({
                  getAll: (range?: IDBKeyRange) =>
                    schedule(() => {
                      const values = [...store.values()] as Array<Record<string, unknown>>;
                      const filtered =
                        range && Array.isArray(range.lower)
                          ? values.filter(
                              (v) => v.ownerKey === range.lower[0] && v.threadId === range.lower[1],
                            )
                          : values;
                      return filtered.map((v) => clonePreservingBlobs(v));
                    }),
                }),
                get: (key: string) =>
                  schedule(() => (store.has(key) ? clonePreservingBlobs(store.get(key)) : undefined)),
                getAll: () => schedule(() => [...store.values()].map((v) => clonePreservingBlobs(v))),
                put: (value: Record<string, unknown>, explicitKey?: string) =>
                  schedule(() => {
                    const k = explicitKey ?? (kp ? String(value[kp]) : "");
                    store.set(k, clonePreservingBlobs(value));
                    return k;
                  }),
                delete: (key: string) =>
                  schedule(() => {
                    store.delete(key);
                    return undefined;
                  }),
              } as unknown as IDBObjectStore;
            },
          };
          return tx as unknown as IDBTransaction;
        },
      } as unknown as IDBDatabase;
      queueMicrotask(() => {
        openReq.result = db;
        openReq.onupgradeneeded?.({ target: openReq } as unknown as IDBVersionChangeEvent);
        openReq.onsuccess?.(new Event("success"));
      });
      return openReq as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return { factory };
}

describe("Stage 7 compressImageForOutbox and outbox attachment durability", () => {
  beforeEach(() => {
    setActivePwaAuth({
      relayUrl: "https://relay.mxhan.com",
      sessionId: "ses-1",
      deviceId: "dev-1",
      token: "tok",
      environmentId: "env-1",
      ownerKey: OWNER,
      serverName: "Mac mini",
      scopes: ["admin"],
      pairedAt: 100,
    });
  });

  afterEach(() => {
    clearOutboxPreviewCacheForTests();
    setActivePwaAuth(null);
    vi.restoreAllMocks();
  });

  it("resizes oversized images to <=1280px at 0.82 quality and falls back when original is smaller", async () => {
    const bigInput = new Blob([new Uint8Array(50_000)], { type: "image/png" });
    Object.assign(bigInput, { name: "IMG_1024.PNG" });
    const drawSizes: Array<{ w: number; h: number }> = [];
    const compressed = await compressImageForOutbox(bigInput, {
      decode: async () => ({ width: 2560, height: 1920, source: {} }),
      createCanvas: (width, height) => ({
        width,
        height,
        draw: (_s, w, h) => {
          drawSizes.push({ w, h });
        },
        toBlob: async (mime, quality) => {
          expect(quality).toBe(0.82);
          return mime === "image/webp" ? new Blob([new Uint8Array(12_000)], { type: "image/webp" }) : null;
        },
      }),
    });
    expect(drawSizes).toEqual([{ w: 1280, h: 960 }]);
    expect(compressed.mime).toBe("image/webp");
    expect(compressed.name).toBe("IMG_1024.webp");
    expect(compressed.size).toBe(12_000);

    const smallInput = new Blob([new Uint8Array(500)], { type: "image/jpeg" });
    Object.assign(smallInput, { name: "small.jpg" });
    const keptOriginal = await compressImageForOutbox(smallInput, {
      decode: async () => ({ width: 800, height: 600, source: {} }),
      createCanvas: (width, height) => ({
        width,
        height,
        draw: () => {},
        toBlob: async () => new Blob([new Uint8Array(2_000)], { type: "image/webp" }),
      }),
    });
    expect(keptOriginal.blob).toBe(smallInput);
    expect(keptOriginal.mime).toBe("image/jpeg");
    expect(keptOriginal.name).toBe("small.jpg");

    const huge = new Blob([new Uint8Array(100)], { type: "image/gif" });
    Object.defineProperty(huge, "size", { value: IMAGE_MAX_BYTES + 1 });
    await expect(compressImageForOutbox(huge)).rejects.toBeInstanceOf(AttachError);
  });

  it("reuses uploadId on upload failure, freezes composedText before message POST, and avoids re-uploading on message retry", async () => {
    const idb = createFakeIdb();
    const receiptBlob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" });
    const requests: Array<{ path: string; method?: string; timeoutMs?: number; body?: unknown; contentType?: string | null }> = [];
    let attachmentAttempts = 0;
    let messageAttempts = 0;
    const dispatched: unknown[] = [];

    const apiRequest = vi.fn(async (path: string, init?: RequestInit & { timeoutMs?: number }) => {
      const headers = new Headers(init?.headers);
      requests.push({
        path,
        method: init?.method,
        timeoutMs: init?.timeoutMs,
        body: init?.body,
        contentType: headers.get("content-type"),
      });
      if (path.startsWith("/api/attachments")) {
        attachmentAttempts += 1;
        if (attachmentAttempts === 1) {
          throw new ApiError("Mac mini offline", 503, { code: "mac_offline" });
        }
        return { path: "/data/attachments/att-upload-1.webp", mime: "image/webp", bytes: 4 };
      }
      if (path.startsWith("/api/bots/accounting/messages")) {
        messageAttempts += 1;
        if (messageAttempts === 1) {
          throw new ApiError("Mac mini offline", 503, { code: "mac_offline" });
        }
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        return {
          threadId: THREAD,
          message: {
            id: "msg-server-1",
            role: "user",
            kind: "text",
            text: parsed.text,
            sendId: parsed.sendId,
            at: 2000,
          },
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const mgr = createOutboxManager({
      idbFactory: idb.factory,
      locks: null,
      createBroadcastChannel: () => null,
      getOwnerKey: () => OWNER,
      isOnline: () => true,
      apiRequest: apiRequest as unknown as NonNullable<Parameters<typeof createOutboxManager>[0]>["apiRequest"],
      dispatch: (action) => dispatched.push(action),
    });

    await mgr.enqueue({
      ownerKey: OWNER,
      sendId: "send-receipt-1",
      threadId: THREAD,
      targetKind: "bot",
      targetId: "accounting",
      text: "Check receipt total",
      rawText: "Check receipt total",
      attachments: [
        {
          uploadId: "11111111-1111-4111-8111-111111111111",
          name: "receipt.webp",
          mime: "image/webp",
          compressedBlob: receiptBlob,
        },
      ],
    });

    await mgr.drainThread(OWNER, THREAD);
    let record = mgr.getRecord("send-receipt-1");
    expect(record?.status).toBe("failed");
    expect(record?.attachments?.[0]?.uploadId).toBe("11111111-1111-4111-8111-111111111111");
    expect(record?.attachments?.[0]?.uploadedPath).toBeUndefined();
    expect(record?.attachments?.[0]?.compressedBlob).toBeInstanceOf(Blob);
    expect(record?.composedText).toBeUndefined();
    expect(messageAttempts).toBe(0);

    await mgr.drainThread(OWNER, THREAD, { retryFailed: true });
    expect(attachmentAttempts).toBe(2);
    expect(messageAttempts).toBe(1);
    expect(requests[0]!.path).toBe("/api/attachments?uploadId=11111111-1111-4111-8111-111111111111");
    expect(requests[1]!.path).toBe("/api/attachments?uploadId=11111111-1111-4111-8111-111111111111");
    expect(requests[1]!.timeoutMs).toBe(30_000);

    await mgr.reloadFromDb(OWNER);
    record = mgr.getRecord("send-receipt-1");
    const expectedComposed = composeMessage("Check receipt total", [
      {
        kind: "image",
        id: "11111111-1111-4111-8111-111111111111",
        path: "/data/attachments/att-upload-1.webp",
        name: "receipt.webp",
        size: 4,
        mime: "image/webp",
      },
    ]);
    expect(record?.status).toBe("failed");
    expect(record?.attachments?.[0]?.uploadedPath).toBe("/data/attachments/att-upload-1.webp");
    expect(record?.attachments?.[0]?.compressedBlob).toBeInstanceOf(Blob);
    expect(record?.composedText).toBe(expectedComposed);

    await mgr.drainThread(OWNER, THREAD, { retryFailed: true });
    expect(attachmentAttempts).toBe(2);
    expect(messageAttempts).toBe(2);
    const secondPost = requests.filter((r) => r.path === "/api/bots/accounting/messages")[1]!;
    expect(JSON.parse(String(secondPost.body))).toMatchObject({
      sendId: "send-receipt-1",
      text: expectedComposed,
      threadId: THREAD,
    });
    expect(mgr.getRecord("send-receipt-1")).toBeUndefined();
    expect(dispatched).toContainEqual(
      expect.objectContaining({ type: "messageAdded", threadId: THREAD }),
    );
    expect(attachmentImageUrl("/data/attachments/att-upload-1.webp")).toBe("/api/attachments/att-upload-1.webp");
  });

  it("renders local blob: thumbnail previews for queued and failed receipt bubbles offline", async () => {
    const idb = createFakeIdb();
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://mausbot.mxhan.com/receipt-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const mgr = createOutboxManager({
      idbFactory: idb.factory,
      locks: null,
      createBroadcastChannel: () => null,
      getOwnerKey: () => OWNER,
      isOnline: () => false,
    });
    const record = await mgr.enqueue({
      ownerKey: OWNER,
      sendId: "send-offline-thumb",
      threadId: THREAD,
      targetKind: "bot",
      targetId: "accounting",
      text: "Offline receipt",
      rawText: "Offline receipt",
      attachments: [
        {
          uploadId: "22222222-2222-4222-8222-222222222222",
          name: "receipt.webp",
          mime: "image/webp",
          compressedBlob: new Blob([new Uint8Array([9, 8, 7])], { type: "image/webp" }),
        },
      ],
    });

    const merged = mergeOutboxUserAttachments(splitTranscriptAttachments(record.text), record);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(merged.images).toEqual([
      {
        path: "blob:https://mausbot.mxhan.com/receipt-preview",
        name: "receipt.webp",
        private: true,
        previewUrl: "blob:https://mausbot.mxhan.com/receipt-preview",
      },
    ]);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => {
      root.render(
        createElement(AttachmentGallery, {
          images: merged.images,
          files: merged.files,
          message: { threadId: THREAD, messageId: "optimistic-send-offline-thumb" },
        }),
      );
    });
    const img = host.querySelector("img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("blob:https://mausbot.mxhan.com/receipt-preview");
    flushSync(() => root.unmount());
    host.remove();
  });
});
