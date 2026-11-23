// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePwaOwnerKey } from "@/lib/pwa-config";
import { defaultOutboxManager, type OutboxRecord } from "@/state/pwa-outbox";
import type { Message } from "@/state/store";
import { LiveConnectionStrip } from "./LiveConnectionStrip";
import { UserLineNote } from "./RichMessageRow";

const ownerKey = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-1");

function makeOutboxRecord(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    sendId: "send-1",
    ownerKey,
    threadId: "t-1",
    targetKind: "bot",
    targetId: "bot-1",
    seq: 1,
    text: "Hello outbox",
    status: "queued",
    createdAt: 100,
    updatedAt: 100,
    attemptCount: 0,
    ...overrides,
  };
}

const optimisticMessage: Message = {
  id: "optimistic-send-1",
  role: "user",
  kind: "text",
  text: "Hello outbox",
  at: 100,
  sendId: "send-1",
};

describe("Outbox bubble status and LiveConnectionStrip outbox controls", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    defaultOutboxManager.resetForTests({ getOwnerKey: () => ownerKey });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    defaultOutboxManager.resetForTests();
    vi.restoreAllMocks();
  });

  it("renders queued, sending, resending, failed (Retry + Discard), and rejected (Discard) states", () => {
    for (const status of ["queued", "sending", "resending"] as const) {
      defaultOutboxManager.setBootRecords(ownerKey, [makeOutboxRecord({ status })]);
      flushSync(() => root.render(createElement(UserLineNote, { message: optimisticMessage })));
      expect(container.querySelector(`[data-outbox-status="${status}"]`)).not.toBeNull();
    }

    const retrySpy = vi.spyOn(defaultOutboxManager, "retrySend").mockResolvedValue();
    const discardSpy = vi.spyOn(defaultOutboxManager, "discardSend").mockResolvedValue();

    defaultOutboxManager.setBootRecords(ownerKey, [makeOutboxRecord({ status: "failed", lastError: "Offline" })]);
    flushSync(() => root.render(createElement(UserLineNote, { message: optimisticMessage })));
    const retryBtn = container.querySelector('[data-outbox-retry="send-1"]') as HTMLButtonElement | null;
    const discardBtn = container.querySelector('[data-outbox-discard="send-1"]') as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    expect(discardBtn).not.toBeNull();
    retryBtn!.click();
    discardBtn!.click();
    expect(retrySpy).toHaveBeenCalledWith("send-1");
    expect(discardSpy).toHaveBeenCalledWith("send-1");

    defaultOutboxManager.setBootRecords(ownerKey, [
      makeOutboxRecord({ status: "rejected", lastError: "Thread deleted" }),
    ]);
    flushSync(() => root.render(createElement(UserLineNote, { message: optimisticMessage })));
    const rejected = container.querySelector('[data-outbox-status="rejected"]');
    expect(rejected?.textContent).toContain("Thread deleted");
    expect(container.querySelector('[data-outbox-retry="send-1"]')).toBeNull();
    expect(container.querySelector('[data-outbox-discard="send-1"]')).not.toBeNull();
  });

  it("renders Retry all (N) and prior-session Import & resend / Discard in LiveConnectionStrip", () => {
    const oldOwner = makePwaOwnerKey("https://relay.mxhan.com", "env-1", "ses-old");
    defaultOutboxManager.setBootRecords(ownerKey, [
      makeOutboxRecord({ sendId: "s-fail-1", status: "failed" }),
      makeOutboxRecord({ sendId: "s-fail-2", status: "failed" }),
      makeOutboxRecord({ sendId: "s-prior-1", ownerKey: oldOwner, status: "queued" }),
    ]);
    const retryAllSpy = vi.spyOn(defaultOutboxManager, "retryAll").mockResolvedValue();
    const importSpy = vi.spyOn(defaultOutboxManager, "importPriorSession").mockResolvedValue(1);
    const discardPriorSpy = vi.spyOn(defaultOutboxManager, "discardPriorSession").mockResolvedValue(1);

    flushSync(() =>
      root.render(createElement(LiveConnectionStrip, { connected: true, hydrated: true })),
    );

    const retryAllBtn = container.querySelector("[data-outbox-retry-all]") as HTMLButtonElement | null;
    const importBtn = container.querySelector("[data-outbox-import-prior]") as HTMLButtonElement | null;
    const discardPriorBtn = container.querySelector("[data-outbox-discard-prior]") as HTMLButtonElement | null;
    expect(retryAllBtn?.textContent).toContain("2");
    expect(importBtn).not.toBeNull();
    expect(discardPriorBtn).not.toBeNull();

    retryAllBtn!.click();
    importBtn!.click();
    discardPriorBtn!.click();
    expect(retryAllSpy).toHaveBeenCalledTimes(1);
    expect(importSpy).toHaveBeenCalledTimes(1);
    expect(discardPriorSpy).toHaveBeenCalledTimes(1);
  });
});
