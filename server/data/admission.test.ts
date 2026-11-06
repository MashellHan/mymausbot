import { describe, expect, it } from "vitest";

import { DataAdmission, DataStoreLane } from "./admission.ts";

describe("Data safety barrier", () => {
  it("fails before capture when a statement does not drain, then permits recovery", async () => {
    const admission = new DataAdmission();
    let release!: () => void;
    const running = admission.enter(() => new Promise<void>((resolve) => { release = resolve; }));
    let captured = false;
    await expect(admission.barrier(async () => { captured = true; }, 20)).rejects.toMatchObject({ error: { code: "timeout" } });
    expect(captured).toBe(false);
    release();
    await running;
    await admission.barrier(async () => { captured = true; }, 20);
    expect(captured).toBe(true);
  });

  it("keeps later barriers behind a capture when an intermediate waiter times out", async () => {
    const admission = new DataAdmission();
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const started = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const first = admission.barrier(async () => {
      enteredFirst();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await started;
    let secondEntered = false;
    await expect(admission.barrier(async () => { secondEntered = true; }, 20)).rejects.toMatchObject({ error: { code: "timeout" } });
    expect(secondEntered).toBe(false);
    let thirdEntered = false;
    const third = admission.barrier(async () => { thirdEntered = true; });
    let wrote = false;
    const writer = admission.enter(async () => { wrote = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdEntered).toBe(false);
    expect(wrote).toBe(false);
    releaseFirst();
    await first;
    await third;
    await writer;
    expect(thirdEntered).toBe(true);
    expect(wrote).toBe(true);
  });

  it("keeps reads concurrent and gives a queued writer exclusive access", async () => {
    const lane = new DataStoreLane();
    let releaseRead!: () => void;
    const read = lane.run(true, () => new Promise<void>((resolve) => { releaseRead = resolve; }));
    let secondRead = false;
    await lane.run(true, async () => { secondRead = true; });
    expect(secondRead).toBe(true);
    let wrote = false, laterRead = false;
    const order: string[] = [];
    const write = lane.run(false, async () => { wrote = true; order.push("write"); });
    const queuedRead = lane.run(true, async () => { laterRead = true; order.push("read"); });
    await Promise.resolve();
    expect([wrote, laterRead]).toEqual([false, false]);
    releaseRead();
    await Promise.all([read, write, queuedRead]);
    expect([wrote, laterRead]).toEqual([true, true]);
    expect(order).toEqual(["write", "read"]);
  });
});
