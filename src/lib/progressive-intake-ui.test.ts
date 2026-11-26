import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { t, setLocale } from "@/lib/i18n";
import {
  concurrentWorkerAnchorId,
  createOptimisticIntake,
  deriveMessageIntake,
  groupThreadRepliesByAnchor,
  hasConcurrentWorkerReplyFor,
  intakeStatusView,
  isConcurrentWorkerMessage,
  mergeMessageIntake,
} from "./progressive-intake-ui";

afterEach(() => setLocale("en"));

const user = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "user",
  kind: "text",
  text: `Question ${id}`,
  at: 100,
  ...extra,
});

const bot = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  role: "bot",
  kind: "text",
  text: `Reply ${id}`,
  at: 200,
  ...extra,
});

describe("progressive-intake-ui state machine", () => {
  it("creates optimistic intake only when the thread is busy", () => {
    expect(createOptimisticIntake({ busy: false })).toBeUndefined();
    expect(createOptimisticIntake({ busy: true, at: 10 })).toEqual({
      mode: "progressive-continue",
      state: "received",
      updatedAt: 10,
    });
    expect(createOptimisticIntake({ busy: true, followUp: "steer", at: 20 })).toEqual({
      mode: "live-steer",
      state: "received",
      updatedAt: 20,
    });
    expect(createOptimisticIntake({ busy: true, followUp: "restart", at: 30 })).toEqual({
      mode: "soft-redirect",
      state: "received",
      updatedAt: 30,
    });
  });

  it("merges intake patches monotonically and resists stale out-of-order updates", () => {
    const received = { mode: "progressive-continue" as const, state: "received" as const, updatedAt: 10 };
    const folding = { mode: "progressive-continue" as const, state: "folding" as const, targetTurnId: "t1", updatedAt: 20 };
    const processing = { mode: "live-steer" as const, state: "processing" as const, targetTurnId: "t1", updatedAt: 30 };
    const answered = { mode: "live-steer" as const, state: "answered" as const, targetTurnId: "t1", updatedAt: 40 };

    expect(mergeMessageIntake(undefined, received)).toEqual(received);
    expect(mergeMessageIntake(received, undefined)).toEqual(received);
    expect(mergeMessageIntake(received, folding)).toEqual(folding);
    expect(mergeMessageIntake(folding, processing)).toEqual(processing);
    expect(mergeMessageIntake(processing, received)).toEqual(processing);
    expect(mergeMessageIntake(processing, answered)).toEqual(answered);
    expect(mergeMessageIntake(answered, folding)).toEqual(answered);
  });

  it("derives optimistic intake while busy and promotes to answered once a settled anchored reply arrives", () => {
    const optimistic = user("optimistic-s1", { at: 100 });
    expect(deriveMessageIntake(optimistic, [], { busy: false })).toBeUndefined();
    expect(deriveMessageIntake(optimistic, [], { busy: true })).toEqual({
      mode: "progressive-continue",
      state: "received",
      updatedAt: 100,
    });

    const settledUser = user("u2", {
      at: 100,
      intake: { mode: "readonly-concurrent", state: "processing", workerTurnId: "w-1", updatedAt: 120 },
    });
    const streamingReply = bot("live:w-item", {
      at: 150,
      replyToId: "u2",
      concurrentWorker: { workerId: "cw-1", readOnly: true, parentTurnId: "t1" },
    });
    expect(deriveMessageIntake(settledUser, [settledUser, streamingReply])?.state).toBe("processing");

    const settledReply = bot("m-w1", {
      at: 250,
      replyToId: "u2",
      turnId: "w-1",
      concurrentWorker: { workerId: "cw-1", readOnly: true, parentTurnId: "t1" },
    });
    expect(deriveMessageIntake(settledUser, [settledUser, settledReply])).toEqual({
      mode: "readonly-concurrent",
      state: "answered",
      workerTurnId: "w-1",
      updatedAt: 250,
    });
  });

  it("maps intake states to calm localized status keys", () => {
    const states = [
      [{ mode: "progressive-continue", state: "received", updatedAt: 1 }, false, "Received"],
      [{ mode: "live-steer", state: "folding", updatedAt: 2 }, false, "Folding in…"],
      [{ mode: "progressive-continue", state: "processing", updatedAt: 3 }, false, "Working on it…"],
      [{ mode: "progressive-continue", state: "answered", updatedAt: 4 }, false, "Replied"],
      [{ mode: "readonly-concurrent", state: "answered", updatedAt: 5 }, true, "Replied directly"],
      [{ mode: "soft-redirect", state: "superseded", updatedAt: 6 }, false, "Replaced by newer message"],
    ] as const;

    for (const [intake, hasWorker, expected] of states) {
      const view = intakeStatusView(intake, { hasConcurrentWorkerReply: hasWorker });
      expect(t(view.labelKey)).toBe(expected);
    }
  });
});

describe("concurrent worker and replyToId anchor helpers", () => {
  it("groups concurrent read-only and primary replies under their triggering user messages", () => {
    const u1 = user("u1");
    const u2 = user("u2");
    const wReply = bot("live:w1", {
      replyToId: "u2",
      turnId: "wt1",
      concurrentWorker: { workerId: "cw-1", readOnly: true, parentTurnId: "t1" },
    });
    const pReply = bot("m1", { replyToId: "u1", turnId: "t1" });
    const orphan = bot("m0", { turnId: "t0" });
    const transcript = [orphan, u1, u2, wReply, pReply];

    expect(isConcurrentWorkerMessage(wReply)).toBe(true);
    expect(isConcurrentWorkerMessage(pReply)).toBe(false);
    expect(concurrentWorkerAnchorId(wReply)).toBe("u2");
    expect(hasConcurrentWorkerReplyFor("u2", transcript)).toBe(true);
    expect(hasConcurrentWorkerReplyFor("u1", transcript)).toBe(false);

    const grouped = groupThreadRepliesByAnchor(transcript);
    expect(grouped.unanchoredBotReplies).toEqual([orphan]);
    expect(grouped.byAnchor.get("u1")?.primaryReplies).toEqual([pReply]);
    expect(grouped.byAnchor.get("u1")?.hasActiveLiveReply).toBe(false);
    expect(grouped.byAnchor.get("u2")?.concurrentReplies).toEqual([wReply]);
    expect(grouped.byAnchor.get("u2")?.hasActiveLiveReply).toBe(true);
  });
});
