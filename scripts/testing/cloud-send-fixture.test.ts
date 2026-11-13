import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { awaitCloudFixtureSetup, cloudPairingRefusalCategory, closeOwnedCloudSendFixture, ownConcurrentCloudSendFixtures, withCloudSendFixtureCleanup } from "./cloud-send-fixture.ts";

import type { ChildProcess } from "node:child_process";

function closingChild() {
  const signals: NodeJS.Signals[] = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) {
      signals.push(signal);
      queueMicrotask(() => { child.signalCode = signal; child.emit("close"); });
      return true;
    },
  });
  return { child: child as ChildProcess, signals };
}

it("reports only an allowlisted pairing refusal category", () => {
  for (const reason of ["invalid_signature", "stale_request", "replayed_request"] as const) {
    expect(cloudPairingRefusalCategory({ error: reason, code: "not-for-output" })).toBe(reason);
  }
  expect(cloudPairingRefusalCategory({ error: "invalid_signature" + "x".repeat(10_000) })).toBe("unknown");
  expect(cloudPairingRefusalCategory({ error: { secret: "not-for-output" } })).toBe("unknown");
  expect(cloudPairingRefusalCategory(null)).toBe("unknown");
});

it("closes its child before removing its own failed fixture root and rethrows the setup failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-cloud-setup-check-"));
  writeFileSync(join(root, "owned"), "fixture");
  const { child, signals } = closingChild();
  const unrelated = closingChild();
  let rootAtClose = false;
  child.on("close", () => { rootAtClose = existsSync(root); });
  const setupError = new Error("setup failed");
  let caught: unknown;
  try {
    await withCloudSendFixtureCleanup(async () => { throw setupError; }, () => closeOwnedCloudSendFixture(root, [child]));
  } catch (error) { caught = error; }
  try {
    expect(caught).toBe(setupError);
    expect(signals).toEqual(["SIGTERM"]);
    expect(unrelated.signals).toEqual([]);
    expect(rootAtClose).toBe(true);
    expect(existsSync(root)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps the root and records child cleanup failure after trying every owned child", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-cloud-setup-check-"));
  const cleanupError = new Error("child listener failed");
  const broken = { exitCode: null, signalCode: null, on: () => { throw cleanupError; }, kill: () => true } as unknown as ChildProcess;
  const other = closingChild();
  let caught: unknown;
  try { await closeOwnedCloudSendFixture(root, [broken, other.child]); } catch (error) { caught = error; }
  try {
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([cleanupError]);
    expect(other.signals).toEqual(["SIGTERM"]);
    expect(existsSync(root)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("retains cleanup failure evidence with the original setup failure", async () => {
  const setupError = new Error("setup failed"), cleanupError = new Error("cleanup failed");
  let caught: unknown;
  try {
    await withCloudSendFixtureCleanup(async () => { throw setupError; }, async () => { throw cleanupError; });
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([setupError, cleanupError]);
});

it("keeps a successful fixture owned by its caller", async () => {
  const fixture = { close: async () => {} };
  let cleaned = false;
  expect(await withCloudSendFixtureCleanup(async () => fixture, async () => { cleaned = true; })).toBe(fixture);
  expect(cleaned).toBe(false);
});

it("waits for and closes a fulfilled companion before rethrowing the first setup failure", async () => {
  const setupError = new Error("first setup failed");
  let finishSecond!: (value: { close(): Promise<void> }) => void;
  const second = new Promise<{ close(): Promise<void> }>((resolve) => { finishSecond = resolve; });
  const result = ownConcurrentCloudSendFixtures(() => Promise.reject(setupError), () => second);
  let closed = false;
  finishSecond({ close: async () => { closed = true; } });
  let caught: unknown;
  try { await result; } catch (error) { caught = error; }
  expect(caught).toBe(setupError);
  expect(closed).toBe(true);
});

it("keeps companion cleanup failure evidence beside the first setup failure", async () => {
  const setupError = new Error("setup failed"), cleanupError = new Error("companion cleanup failed");
  let caught: unknown;
  try {
    await ownConcurrentCloudSendFixtures(() => Promise.reject(setupError), () => Promise.resolve({ close: async () => { throw cleanupError; } }));
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([setupError, cleanupError]);
});

it("keeps a second constructor failure and its cleanup error after the first setup failure", async () => {
  const firstError = new Error("first setup failed");
  const secondError = new AggregateError([new Error("second setup failed"), new Error("second cleanup failed")], "second constructor failed");
  let caught: unknown;
  try {
    await ownConcurrentCloudSendFixtures(() => Promise.reject(firstError), () => Promise.reject(secondError));
  } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([firstError, secondError]);
});

it("aborts a stalled companion and finishes its owned cleanup before returning the original failure", async () => {
  const setupError = new Error("first setup failed");
  const stalled = new Promise<{ close(): Promise<void> }>(() => {});
  let companionSignal: AbortSignal | undefined;
  let cleaned = false;
  let caught: unknown;
  try {
    await ownConcurrentCloudSendFixtures(
      () => Promise.reject(setupError),
      (signal) => {
        companionSignal = signal;
        return withCloudSendFixtureCleanup(() => awaitCloudFixtureSetup(stalled, signal), async () => { cleaned = true; });
      },
    );
  } catch (error) { caught = error; }
  expect(caught).toBe(setupError);
  expect(companionSignal?.aborted).toBe(true);
  expect(cleaned).toBe(true);
});

it("keeps a late operation rejection handled when setup was already cancelled", async () => {
  const controller = new AbortController();
  const cancellation = new Error("setup cancelled");
  let rejectWork!: (reason: Error) => void;
  const work = new Promise<void>((_resolve, reject) => { rejectWork = reject; });
  controller.abort(cancellation);
  await expect(awaitCloudFixtureSetup(work, controller.signal)).rejects.toBe(cancellation);
  rejectWork(new Error("late work failed"));
  await new Promise((resolve) => setImmediate(resolve));
});
