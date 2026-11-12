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
  const [answer, setAnswer] = useState<{ key: string; waiting: boolean }>();

  useEffect(() => {
    if (!enabled) {
      setAnswer(undefined);
      return;
    }
    const controller = new AbortController();
    void api<JobAnswer>(`/api/threads/${threadId}/job?since=0`, { signal: controller.signal, background: true })
      .then(({ needsInput }) => {
        if (!controller.signal.aborted) setAnswer({
          key,
          waiting: Array.isArray(needsInput) && needsInput.some((item) => item.botId === botId && item.threadId === threadId),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setAnswer({ key, waiting: false });
      });
    return () => controller.abort();
  }, [botId, enabled, key, threadId]);

  return enabled && answer?.key === key && answer?.waiting === true;
}
