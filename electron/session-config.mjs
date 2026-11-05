const MAX_BYTES = 128 * 1024;

/** The current utility server may hand its validated config to the App; the next utility server receives it from memory. */
export function createSessionConfigMemory() {
  const snapshots = new Map();
  const pending = new Map();
  const cancel = (dataDir, requestId) => {
    const request = pending.get(dataDir);
    if (!request || request.requestId !== requestId) return false;
    if (request.committed) {
      if (request.previous === undefined) snapshots.delete(dataDir);
      else snapshots.set(dataDir, request.previous);
    }
    pending.delete(dataDir);
    return true;
  };
  return {
    receive(dataDir, message, owner) {
      if (message?.type !== "openmausbot:session-config") return false;
      if (typeof message.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(message.requestId)) throw new Error("Invalid session configuration receipt");
      if (pending.has(dataDir)) throw new Error("A session configuration is already being confirmed");
      const value = message.config;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session configuration");
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("Session configuration exceeds the desktop handoff limit");
      pending.set(dataDir, { requestId: message.requestId, owner, snapshot: JSON.parse(json), previous: snapshots.get(dataDir), committed: false });
      return true;
    },
    commit(dataDir, requestId, owner) {
      const request = pending.get(dataDir);
      if (!request || request.requestId !== requestId || request.owner !== owner || request.committed) return false;
      snapshots.set(dataDir, request.snapshot);
      request.committed = true;
      return true;
    },
    finish(dataDir, requestId, owner) {
      const request = pending.get(dataDir);
      if (!request || request.requestId !== requestId || request.owner !== owner || !request.committed) return false;
      pending.delete(dataDir);
      return true;
    },
    cancel,
    rejectProcess(owner) {
      for (const [dataDir, request] of pending) if (request.owner === owner) cancel(dataDir, request.requestId);
    },
    handleMessage(dataDir, owner, message) {
      const type = message?.type;
      if (!["openmausbot:session-config", "openmausbot:session-config-commit", "openmausbot:session-config-finish", "openmausbot:session-config-cancel"].includes(type)) return false;
      if (type === "openmausbot:session-config-finish") { this.finish(dataDir, message.requestId, owner); return true; }
      if (type === "openmausbot:session-config-cancel") { cancel(dataDir, message.requestId); return true; }
      const phase = type === "openmausbot:session-config" ? "prepared" : "committed";
      let ok = true;
      try { ok = phase === "prepared" ? this.receive(dataDir, message, owner) : this.commit(dataDir, message.requestId, owner); }
      catch { ok = false; }
      try { owner.postMessage({ type: "openmausbot:session-config-result", requestId: message.requestId, phase, ok }); }
      catch (error) { cancel(dataDir, message.requestId); throw error; }
      return true;
    },
    childEnvironment(dataDir) {
      const snapshot = snapshots.get(dataDir);
      return snapshot === undefined ? {} : { OMB_SESSION_CONFIG_JSON: JSON.stringify(snapshot) };
    },
  };
}
