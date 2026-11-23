import fs from "node:fs";
import path from "node:path";

export const PWA_BRIDGE_WAKE_POLL_MS = 15_000;
export const PWA_BRIDGE_WAKE_BLOCKER = "prevent-app-suspension";
const PWA_BRIDGE_CONFIG_FILE = "pwa-bridge.json";

export function pwaBridgeWakeDecision({ serverReady, status }) {
  if (!serverReady) return { hold: false, reason: "server-unavailable" };
  if (!status || status.config?.enabled !== true) return { hold: false, reason: "off" };
  const state = typeof status.status?.state === "string" ? status.status.state : "enabled";
  return { hold: true, reason: state };
}

export function watchPwaBridgeConfig(dataDir, onChange) {
  let watcher = null;
  let timer = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 50);
    timer.unref?.();
  };
  try {
    watcher = fs.watch(dataDir, { persistent: false }, (_eventType, filename) => {
      if (!filename || path.basename(String(filename)) === PWA_BRIDGE_CONFIG_FILE) trigger();
    });
    watcher.on("error", () => {});
  } catch {
    watcher = null;
  }
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    try { watcher?.close(); } catch {}
    watcher = null;
  };
}

/**
 * Keeps the host awake while the local utility server is ready and the PWA bridge is enabled,
 * using its own `powerSaveBlocker` hold decoupled from companion lifecycle stops.
 */
export function createPwaBridgeWakeHold(deps) {
  let blockerId = null;
  let timer = null;
  let unwatch = null;
  let stopped = false;
  let generation = 0;
  let pollSeq = 0;
  let last = { hold: false, reason: "off" };

  const apply = (decision) => {
    if (decision.hold && blockerId === null) {
      blockerId = deps.blocker.start(PWA_BRIDGE_WAKE_BLOCKER);
      deps.log?.(`pwa bridge wake: holding this computer awake (${decision.reason})`);
    } else if (!decision.hold && blockerId !== null) {
      if (deps.blocker.isStarted(blockerId)) deps.blocker.stop(blockerId);
      blockerId = null;
      deps.log?.(`pwa bridge wake: released (${decision.reason})`);
    }
    last = decision;
  };

  const state = () => ({ ...last, serverReady: Boolean(deps.isServerReady()) });

  const poll = async () => {
    const gen = generation;
    const seq = ++pollSeq;
    if (stopped || !deps.isServerReady()) {
      apply({ hold: false, reason: stopped ? "stopped" : "server-unavailable" });
      return state();
    }
    const status = await Promise.resolve()
      .then(() => deps.fetchStatus())
      .catch(() => null);
    if (stopped || gen !== generation || seq !== pollSeq) return state();
    apply(pwaBridgeWakeDecision({ serverReady: deps.isServerReady(), status }));
    return state();
  };

  return {
    start() {
      if (!stopped && timer) return;
      stopped = false;
      generation += 1;
      unwatch = deps.watch?.(() => void poll()) ?? null;
      void poll();
      timer = setInterval(() => void poll(), deps.pollMs ?? PWA_BRIDGE_WAKE_POLL_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      generation += 1;
      if (timer) clearInterval(timer);
      timer = null;
      try { unwatch?.(); } catch {}
      unwatch = null;
      apply({ hold: false, reason: "stopped" });
    },
    poll,
    state,
    holding: () => blockerId !== null,
  };
}

export function createMainPwaBridgeWake({ port, isServerReady, blocker, dataDir, log }) {
  return createPwaBridgeWakeHold({
    isServerReady,
    fetchStatus: () => (isServerReady()
      ? fetch(`http://127.0.0.1:${port()}/api/pwa-bridge`, {
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
        credentials: "omit",
      }).then((response) => (response.ok ? response.json() : null))
      : Promise.resolve(null)),
    blocker,
    watch: (onChange) => watchPwaBridgeConfig(dataDir(), onChange),
    log,
  });
}
