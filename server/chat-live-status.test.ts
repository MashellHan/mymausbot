import { describe, expect, it } from "vitest";

import { activeChatTurn, automationStatus, publicChatStatus } from "./chat-live-status.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { workOrigin } from "./peer-provenance.ts";

describe("host live chat status", () => {
  it("emits only a scoped start/finish enum for an accepted automation update", () => {
    let active: string | undefined = "turn-a";
    const frames: RuntimeEvent[] = [];
    const start = automationStatus("thread", () => active, (frame) => frames.push(frame.event));
    expect(start("trigger")).toBeUndefined();
    expect(frames).toEqual([]);
    const finish = start("update")!;
    expect(frames).toEqual([expect.objectContaining({ type: "turn.progress", activity: "tool", threadId: "thread",
      turnId: "turn-a", automation: { action: "update", phase: "started" }, itemId: expect.any(String) })]);
    finish();
    expect(frames[1]).toMatchObject({ turnId: "turn-a", itemId: frames[0]!.itemId, automation: { action: "update", phase: "finished" } });
    const stale = start("update")!;
    active = "turn-b";
    stale();
    expect(frames).toHaveLength(3);
    active = undefined;
    expect(start("update")).toBeUndefined();
    expect(frames).toHaveLength(3);
  });

  it("reports each validated operation without carrying the result into the runtime frames", () => {
    const frames: RuntimeEvent[] = [];
    const start = automationStatus("thread", () => "turn-a", (frame) => frames.push(frame.event));
    for (const action of ["view", "create", "update", "pause", "resume", "run_now", "delete"]) {
      start(action)!();
      expect(frames.splice(0)).toEqual([
        expect.objectContaining({ type: "turn.progress", automation: { action, phase: "started" } }),
        expect.objectContaining({ type: "turn.progress", automation: { action, phase: "finished" } }),
      ]);
    }
  });

  it("only identifies the accepted source for the live generation", () => {
    const event: RuntimeEvent = { type: "turn.started", eventId: "1", threadId: "thread", turnId: "turn-a",
      provider: "harness", createdAt: "2026-11-20T12:00:00Z" };
    const person = { role: "user", kind: "text", text: "Update automation." } as const;
    const owner = { generation: "current", messageId: "person-message", personLine: true as const, origin: workOrigin(person) };
    expect(publicChatStatus(event, owner, "former")).toBe(event);
    expect(publicChatStatus(event, { ...owner, stopped: true }, "current")).toBe(event);
    expect(publicChatStatus(event, owner, "current")).toMatchObject({ requestMessageId: "person-message" });
    expect(publicChatStatus(event, { ...owner, origin: workOrigin({ ...person, relayed: true }) }, "current")).toBe(event);
    expect(publicChatStatus(event, { generation: "current", messageId: "routine-line", automation: "routine" }, "current")).toBe(event);
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
