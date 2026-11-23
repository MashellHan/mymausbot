import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PWA_BRIDGE_WAKE_BLOCKER,
  createPwaBridgeWakeHold,
  pwaBridgeWakeDecision,
  watchPwaBridgeConfig,
} from "./pwa-bridge-wake.mjs";

function createFakeBlocker() {
  let nextId = 1;
  const started = new Set();
  const calls = [];
  return {
    started,
    calls,
    blocker: {
      start(type) {
        const id = nextId++;
        started.add(id);
        calls.push(["start", type, id]);
        return id;
      },
      stop(id) {
        started.delete(id);
        calls.push(["stop", id]);
      },
      isStarted: (id) => started.has(id),
    },
  };
}

test("pwaBridgeWakeDecision holds only when the utility server is ready and the bridge is enabled", () => {
  assert.deepEqual(pwaBridgeWakeDecision({ serverReady: false, status: { config: { enabled: true } } }), {
    hold: false,
    reason: "server-unavailable",
  });
  assert.deepEqual(pwaBridgeWakeDecision({ serverReady: true, status: null }), {
    hold: false,
    reason: "off",
  });
  assert.deepEqual(pwaBridgeWakeDecision({ serverReady: true, status: { config: { enabled: false } } }), {
    hold: false,
    reason: "off",
  });
  assert.deepEqual(
    pwaBridgeWakeDecision({
      serverReady: true,
      status: { config: { enabled: true }, status: { state: "connected" } },
    }),
    { hold: true, reason: "connected" },
  );
  assert.deepEqual(
    pwaBridgeWakeDecision({
      serverReady: true,
      status: { config: { enabled: true }, status: { state: "connecting" } },
    }),
    { hold: true, reason: "connecting" },
  );
});

test("createPwaBridgeWakeHold acquires once, releases on disable or stop, and ignores stale polls after stop", async () => {
  const { blocker, calls } = createFakeBlocker();
  let serverReady = true;
  let enabled = true;
  let state = "connected";
  let watchCallback = null;
  let unwatched = false;

  const hold = createPwaBridgeWakeHold({
    isServerReady: () => serverReady,
    fetchStatus: async () => ({ config: { enabled }, status: { state } }),
    blocker,
    watch: (cb) => {
      watchCallback = cb;
      return () => {
        unwatched = true;
      };
    },
    log() {},
    pollMs: 60_000,
  });

  assert.deepEqual(await hold.poll(), { hold: true, reason: "connected", serverReady: true });
  assert.equal(hold.holding(), true);
  await hold.poll();
  assert.deepEqual(calls, [["start", PWA_BRIDGE_WAKE_BLOCKER, 1]]);

  enabled = false;
  assert.deepEqual(await hold.poll(), { hold: false, reason: "off", serverReady: true });
  assert.equal(hold.holding(), false);

  enabled = true;
  state = "connecting";
  await hold.poll();
  assert.equal(hold.holding(), true);

  serverReady = false;
  assert.deepEqual(await hold.poll(), { hold: false, reason: "server-unavailable", serverReady: false });
  assert.equal(hold.holding(), false);

  serverReady = true;
  hold.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hold.holding(), true);
  assert.ok(watchCallback);

  enabled = false;
  watchCallback();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hold.holding(), false);

  enabled = true;
  await hold.poll();
  assert.equal(hold.holding(), true);
  hold.stop();
  assert.equal(hold.holding(), false);
  assert.equal(unwatched, true);
});

test("in-flight poll resolving after stop does not re-acquire the power save blocker", async () => {
  const { blocker } = createFakeBlocker();
  let resolveFetch;
  const hold = createPwaBridgeWakeHold({
    isServerReady: () => true,
    fetchStatus: () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    blocker,
    log() {},
  });

  const pending = hold.poll();
  await Promise.resolve();
  hold.stop();
  resolveFetch({ config: { enabled: true }, status: { state: "connected" } });
  await pending;
  assert.equal(hold.holding(), false);
});

test("watchPwaBridgeConfig triggers on pwa-bridge.json changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-pwa-wake-"));
  try {
    let hits = 0;
    const stopWatch = watchPwaBridgeConfig(dir, () => {
      hits += 1;
    });
    writeFileSync(join(dir, "pwa-bridge.json"), JSON.stringify({ version: 1, enabled: true }), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));
    stopWatch();
    assert.ok(hits >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main.mjs decouples PWA bridge keep-awake from companion stops and clears it on server loss or quit", async () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

  const stopCompanionSlice = main.slice(
    main.indexOf("async function stopDesktopCompanion"),
    main.indexOf("const tailnetShare ="),
  );
  assert.match(stopCompanionSlice, /syncCompanionKeepAwake\(false, false\)/);
  assert.doesNotMatch(stopCompanionSlice, /pwaBridgeWake/);

  const crashCompanionSlice = main.slice(
    main.indexOf("setCompanionLifecycleListener("),
    main.indexOf("async function stopManagedCompanionEndpointLocally"),
  );
  assert.match(crashCompanionSlice, /syncCompanionKeepAwake\(false, false\)/);
  assert.doesNotMatch(crashCompanionSlice, /pwaBridgeWake/);

  const supervisorSlice = main.slice(
    main.indexOf("const serverSupervisor = createServerSupervisor("),
    main.indexOf("function desktopDataDir()"),
  );
  assert.match(supervisorSlice, /pwaBridgeWake\.start\(\)/);
  assert.match(supervisorSlice, /pwaBridgeWake\.stop\(\)/);

  const quitSlice = main.slice(main.indexOf('app.on("before-quit"'));
  assert.match(quitSlice, /pwaBridgeWake\.stop\(\)/);

  // Exercise both blockers side-by-side with the real helper and syncCompanionKeepAwake logic.
  const { blocker } = createFakeBlocker();
  let companionPowerBlocker = null;
  function syncCompanionKeepAwake(companionEnabled, keepAwake) {
    const shouldBlock = companionEnabled && keepAwake;
    if (shouldBlock && companionPowerBlocker === null) {
      companionPowerBlocker = blocker.start("prevent-app-suspension");
    } else if (!shouldBlock && companionPowerBlocker !== null) {
      if (blocker.isStarted(companionPowerBlocker)) blocker.stop(companionPowerBlocker);
      companionPowerBlocker = null;
    }
  }

  let serverReady = true;
  let bridgeEnabled = true;
  const pwaBridgeWake = createPwaBridgeWakeHold({
    isServerReady: () => serverReady,
    fetchStatus: async () => ({ config: { enabled: bridgeEnabled }, status: { state: "connected" } }),
    blocker,
    log() {},
  });

  syncCompanionKeepAwake(true, true);
  await pwaBridgeWake.poll();
  assert.notEqual(companionPowerBlocker, null);
  assert.equal(pwaBridgeWake.holding(), true);

  // Stopping companion drops companionPowerBlocker without dropping pwaBridgeWake.
  syncCompanionKeepAwake(false, false);
  assert.equal(companionPowerBlocker, null);
  assert.equal(pwaBridgeWake.holding(), true);

  // Disabling the PWA bridge or quitting releases pwaBridgeWake.
  bridgeEnabled = false;
  await pwaBridgeWake.poll();
  assert.equal(pwaBridgeWake.holding(), false);

  bridgeEnabled = true;
  await pwaBridgeWake.poll();
  assert.equal(pwaBridgeWake.holding(), true);
  pwaBridgeWake.stop();
  assert.equal(pwaBridgeWake.holding(), false);
});
