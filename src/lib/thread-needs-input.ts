import { useEffect, useState } from "react";
import { api } from "@/state/api";

type JobAnswer = { needsInput?: Array<{ botId: string; threadId: string }> };

export function useThreadNeedsInputStop(
  botId: string,
  threadId: string,
  activity: string | undefined,
  enabled: boolean,
  stoppedAt: number | undefined,
): boolean {
  const key = `${botId}:${threadId}:${activity ?? ""}:${stoppedAt ?? ""}`;
  const [waitingKey, setWaitingKey] = useState<string>();

  useEffect(() => {
    if (!enabled) {
      setWaitingKey((prev) => (prev === undefined ? prev : undefined));
      return;
    }
    const controller = new AbortController();
    void api<JobAnswer>(`/api/threads/${threadId}/job?since=0`, { signal: controller.signal, background: true })
      .then(({ needsInput }) => {
        if (controller.signal.aborted) return;
        const waiting = Array.isArray(needsInput) && needsInput.some((item) => item.botId === botId && item.threadId === threadId);
        const next = waiting ? key : undefined;
        setWaitingKey((prev) => (prev === next ? prev : next));
      })
      .catch(() => {
        if (!controller.signal.aborted) setWaitingKey((prev) => (prev === undefined ? prev : undefined));
      });
    return () => controller.abort();
  }, [botId, enabled, key, threadId]);

  return enabled && waitingKey === key;
}
