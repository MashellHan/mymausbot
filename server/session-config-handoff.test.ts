import { describe, expect, it, vi } from "vitest";
import { createSessionConfigMemory } from "../electron/session-config.mjs";
import { createSessionConfigHandoff } from "./session-config-handoff.ts";

describe("App-run config handoff", () => {
  it("confirms only the matching parent reply", async () => {
    const sent: any[] = [];
    const handoff = createSessionConfigHandoff((message) => { sent.push(message); });
    const ready = handoff.publish({ openai: { key: "synthetic" } });
    expect(handoff.receive({ type: "unrelated" })).toBe(false);
    handoff.receive({ type: "openmausbot:session-config-result", requestId: "another", ok: true });
    handoff.receive({ type: "openmausbot:session-config-result", requestId: sent[0].requestId, phase: "prepared", ok: true });
    expect(sent[1]).toEqual({ type: "openmausbot:session-config-commit", requestId: sent[0].requestId });
    handoff.receive({ type: "openmausbot:session-config-result", requestId: sent[0].requestId, phase: "committed", ok: true });
    expect(sent[2]).toEqual({ type: "openmausbot:session-config-finish", requestId: sent[0].requestId });
    await expect(ready).resolves.toBeUndefined();
  });

  it("refuses a failed post, parent denial or timeout", async () => {
    await expect(createSessionConfigHandoff(() => { throw new Error("disconnected"); }).publish({})).rejects.toThrow("did not retain");
    let message: any;
    const denied = createSessionConfigHandoff((sent) => { message = sent; });
    const receipt = denied.publish({});
    denied.receive({ type: "openmausbot:session-config-result", requestId: message.requestId, phase: "prepared", ok: false });
    await expect(receipt).rejects.toThrow("did not retain");
    vi.useFakeTimers();
    try {
      const timeout = createSessionConfigHandoff(() => {}, 10).publish({});
      const rejection = expect(timeout).rejects.toThrow("did not retain");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally { vi.useRealTimers(); }
  });

  it("cancels a committed snapshot when its final acknowledgement is lost", async () => {
    vi.useFakeTimers();
    try {
      const sent: any[] = [];
      const handoff = createSessionConfigHandoff((message) => { sent.push(message); }, 10);
      const receipt = handoff.publish({ xai: { key: "synthetic" } });
      const rejected = expect(receipt).rejects.toThrow("did not retain");
      handoff.receive({ type: "openmausbot:session-config-result", requestId: sent[0].requestId, phase: "prepared", ok: true });
      expect(sent[1].type).toBe("openmausbot:session-config-commit");
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      expect(sent[2]).toEqual({ type: "openmausbot:session-config-cancel", requestId: sent[0].requestId });
      handoff.receive({ type: "openmausbot:session-config-result", requestId: sent[0].requestId, phase: "committed", ok: true });
      expect(sent).toHaveLength(3);
    } finally { vi.useRealTimers(); }
  });

  it("keeps recovery on the accepted key after a parent-stored commit loses its acknowledgement", async () => {
    const memory = createSessionConfigMemory();
    const dataDir = "synthetic-workspace";
    let dropCommitted = false;
    let lateRequestId = "";
    let handoff: ReturnType<typeof createSessionConfigHandoff>;
    handoff = createSessionConfigHandoff((raw) => {
      const message = raw as { type: string; requestId: string; config?: object };
      if (message.type === "openmausbot:session-config-cancel") { memory.cancel(dataDir, message.requestId); return; }
      if (message.type === "openmausbot:session-config-finish") { memory.finish(dataDir, message.requestId, "child"); return; }
      const phase = message.type === "openmausbot:session-config" ? "prepared" : "committed";
      const ok = phase === "prepared"
        ? memory.receive(dataDir, message, "child")
        : memory.commit(dataDir, message.requestId, "child");
      if (phase === "committed" && dropCommitted) { lateRequestId = message.requestId; return; }
      queueMicrotask(() => handoff.receive({ type: "openmausbot:session-config-result", requestId: message.requestId, phase, ok }));
    }, 20);
    await handoff.publish({ openai: { key: "accepted" } });
    dropCommitted = true;
    await expect(handoff.publish({ openai: { key: "rejected" } })).rejects.toThrow("did not retain");
    handoff.receive({ type: "openmausbot:session-config-result", requestId: lateRequestId, phase: "committed", ok: true });
    expect(JSON.parse(memory.childEnvironment(dataDir).OMB_SESSION_CONFIG_JSON).openai.key).toBe("accepted");
  });
});
