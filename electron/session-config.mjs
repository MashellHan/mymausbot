const MAX_BYTES = 1024 * 1024;

/** The current utility server may hand its validated config to the App; the next utility server receives it from memory. */
export function createSessionConfigMemory() {
  const snapshots = new Map();
  return {
    receive(dataDir, message) {
      if (message?.type !== "openmausbot:session-config") return false;
      if (typeof message.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(message.requestId)) throw new Error("Invalid session configuration receipt");
      const value = message.config;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session configuration");
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("Session configuration exceeds the desktop handoff limit");
      snapshots.set(dataDir, JSON.parse(json));
      return true;
    },
    childEnvironment(dataDir) {
      const snapshot = snapshots.get(dataDir);
      return snapshot === undefined ? {} : { OMB_SESSION_CONFIG_JSON: JSON.stringify(snapshot) };
    },
  };
}
