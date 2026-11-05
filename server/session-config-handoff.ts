import { randomUUID } from "node:crypto";

export function createSessionConfigHandoff(post: (message: object) => void, timeoutMs = 5_000) {
  const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const settle = (requestId: string, ok: boolean) => {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    clearTimeout(request.timer);
    if (ok) request.resolve();
    else request.reject(new Error("The App did not retain this session credential"));
  };
  return {
    publish(config: object): Promise<void> {
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => settle(requestId, false), timeoutMs);
        timer.unref?.();
        pending.set(requestId, { resolve, reject, timer });
        try { post({ type: "openmausbot:session-config", requestId, config }); }
        catch { settle(requestId, false); }
      });
    },
    receive(raw: unknown): boolean {
      const message = raw as { type?: unknown; requestId?: unknown; ok?: unknown } | null;
      if (message?.type !== "openmausbot:session-config-result") return false;
      if (typeof message.requestId === "string" && typeof message.ok === "boolean") settle(message.requestId, message.ok);
      return true;
    },
  };
}
