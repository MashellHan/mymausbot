import { describe, expect, it, vi } from "vitest";
import { createSessionConfigHandoff } from "./session-config-handoff.ts";

describe("App-run config handoff", () => {
  it("confirms only the matching parent reply", async () => {
    let message: any;
    const handoff = createSessionConfigHandoff((sent) => { message = sent; });
    const ready = handoff.publish({ openai: { key: "synthetic" } });
    expect(handoff.receive({ type: "unrelated" })).toBe(false);
    handoff.receive({ type: "openmausbot:session-config-result", requestId: "another", ok: true });
    handoff.receive({ type: "openmausbot:session-config-result", requestId: message.requestId, ok: true });
    await expect(ready).resolves.toBeUndefined();
  });

  it("refuses a failed post, parent denial or timeout", async () => {
    await expect(createSessionConfigHandoff(() => { throw new Error("disconnected"); }).publish({})).rejects.toThrow("did not retain");
    let message: any;
    const denied = createSessionConfigHandoff((sent) => { message = sent; });
    const receipt = denied.publish({});
    denied.receive({ type: "openmausbot:session-config-result", requestId: message.requestId, ok: false });
    await expect(receipt).rejects.toThrow("did not retain");
    vi.useFakeTimers();
    try {
      const timeout = createSessionConfigHandoff(() => {}, 10).publish({});
      const rejection = expect(timeout).rejects.toThrow("did not retain");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally { vi.useRealTimers(); }
  });
});
