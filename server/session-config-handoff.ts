import { randomUUID } from "node:crypto";
import { setSessionConfigPublisher } from "./session-config.ts";

export type UtilityParentPort = {
  on(event: "message", listener: (event: { data?: object }) => void): void;
  postMessage(message: object): void;
};

export function installSessionConfigHandoff(port: UtilityParentPort | undefined, credentialMode: string | undefined) {
  if (credentialMode !== "session" || !port) return null;
  const handoff = createSessionConfigHandoff((message) => port.postMessage(message));
  setSessionConfigPublisher((config) => handoff.publish(config));
  return handoff;
}

export function createSessionConfigHandoff(post: (message: object) => void, timeoutMs = 5_000) {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout; expected: "prepared" | "committed" }>();
  const fail = (requestId: string) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    try { post({ type: "openmausbot:session-config-cancel", requestId }); } catch {}
    request.reject(new Error("The App did not retain this session credential"));
  };
  return {
    publish(config: object): Promise<void> {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => fail(requestId), timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, reject, timer, expected: "prepared" });
        try { post({ type: "openmausbot:session-config", requestId, config }); }
        catch { fail(requestId); }
      });
    },
    receive(raw: unknown): boolean {
      const message = raw as { type?: unknown; requestId?: unknown; phase?: unknown; ok?: unknown } | null;
      if (message?.type !== "openmausbot:session-config-result") return false;
      if (typeof message.requestId !== "string") return true;
      const request = pending.get(message.requestId);
      if (!request || message.phase !== request.expected || typeof message.ok !== "boolean") return true;
      if (!message.ok) { fail(message.requestId); return true; }
      if (request.expected === "prepared") {
        request.expected = "committed";
        try { post({ type: "openmausbot:session-config-commit", requestId: message.requestId }); }
        catch { fail(message.requestId); }
      } else {
        try { post({ type: "openmausbot:session-config-finish", requestId: message.requestId }); }
        catch { fail(message.requestId); return true; }
        pending.delete(message.requestId);
        clearTimeout(request.timer);
        request.resolve();
      }
      return true;
    },
  };
}
