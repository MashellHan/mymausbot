import { describe, expect, it } from "vitest";

import { activeChatTurn, observeAutomation, publicChatStatus } from "./chat-live-status.ts";
import type { RuntimeEvent } from "./contracts.ts";

describe("host live chat status", () => {
  it("emits only a scoped start/finish enum for an accepted automation update", async () => {
    let active: string | undefined = "turn-a";
    const frames: RuntimeEvent[] = [];
    const observe = observeAutomation("thread", () => active, (frame) => frames.push(frame.event));
    expect(observe("trigger", () => 1)).toBe(1);
    expect(frames).toEqual([]);
    let finish!: (value: string) => void;
    const update = observe("update", () => new Promise<string>((resolve) => { finish = resolve; }));
    expect(frames).toEqual([expect.objectContaining({ type: "turn.progress", activity: "tool", threadId: "thread",
      turnId: "turn-a", automation: { action: "update", phase: "started" }, itemId: expect.any(String) })]);
    finish("private operation result");
    await expect(update).resolves.toBe("private operation result");
    expect(frames[1]).toMatchObject({ turnId: "turn-a", itemId: frames[0]!.itemId, automation: { action: "update", phase: "finished" } });
    expect(JSON.stringify(frames)).not.toContain("private operation result");

    const stale = observe("update", () => new Promise<string>((resolve) => { finish = resolve; }));
    active = "turn-b";
    finish("settled");
    await stale;
    expect(frames).toHaveLength(3);
    active = undefined;
    expect(observe("update", () => 2)).toBe(2);
    expect(frames).toHaveLength(3);
  });

  it("reports each validated operation without carrying the result into the runtime frames", () => {
    const frames: RuntimeEvent[] = [];
    const observe = observeAutomation("thread", () => "turn-a", (frame) => frames.push(frame.event));
    for (const action of ["view", "create", "update", "pause", "resume", "run_now", "delete"]) {
      expect(observe(action, () => "private operation result")).toBe("private operation result");
      expect(frames.splice(0)).toEqual([
        expect.objectContaining({ type: "turn.progress", automation: { action, phase: "started" } }),
        expect.objectContaining({ type: "turn.progress", automation: { action, phase: "finished" } }),
      ]);
    }
  });

  it("only identifies the accepted source for the live generation", () => {
    const event: RuntimeEvent = { type: "turn.started", eventId: "1", threadId: "thread", turnId: "turn-a",
      provider: "harness", createdAt: "2026-11-20T12:00:00Z" };
    const owner = { generation: "current", messageId: "person-message" };
    expect(publicChatStatus(event, owner, "former")).toBe(event);
    expect(publicChatStatus(event, { ...owner, stopped: true }, "current")).toBe(event);
    expect(publicChatStatus(event, owner, "current")).toMatchObject({ requestMessageId: "person-message" });
    expect(publicChatStatus({ ...event, requestMessageId: "provider-source" }, undefined, "current")).toMatchObject({ requestMessageId: undefined });
    expect(publicChatStatus({ ...event, type: "turn.progress", activity: "tool", automation: { action: "update", phase: "started" } },
      owner, "current")).toMatchObject({ automation: undefined });
  });

  it("only emits for an owner bound to the active chat turn and generation", () => {
    const owner = { generation: "current", turnId: "turn-a" };
    expect(activeChatTurn("turn-a", owner, "former")).toBeUndefined();
    expect(activeChatTurn("turn-b", owner, "current")).toBeUndefined();
    expect(activeChatTurn("turn-a", { ...owner, stopped: true }, "current")).toBeUndefined();
    expect(activeChatTurn("turn-a", owner, "current")).toBe("turn-a");
  });
});
