import type { RuntimeEvent } from "../contracts.ts";
import type { Store } from "../store.ts";

type TurnRef = Pick<RuntimeEvent, "threadId" | "turnId" | "providerInstanceId">;
type InstanceOrder = { instanceId: string; order: number };

export function createSetupRecovery(store: Pick<Store, "tasks" | "setTaskActivity">) {
  const starts = new Map<string, InstanceOrder & { turnId: string }>();
  const marks = new Map<string, InstanceOrder>();
  let order = 0;
  return {
    started({ threadId, turnId, providerInstanceId }: TurnRef): void {
      if (!turnId || !providerInstanceId) return;
      const current = starts.get(threadId);
      if (current?.turnId === turnId && current.instanceId === providerInstanceId) return;
      starts.set(threadId, { turnId, instanceId: providerInstanceId, order: ++order });
    },
    failed(botId: string, { threadId, providerInstanceId }: TurnRef): void {
      if (providerInstanceId) marks.set(threadId, { instanceId: providerInstanceId, order: ++order });
      else marks.delete(threadId);
      store.setTaskActivity(botId, threadId, "dead");
    },
    completed(botId: string, event: TurnRef & { ok: boolean; stopReason?: string | null }, { replayed, stopped }: { replayed: boolean; stopped: boolean }): void {
      const started = starts.get(event.threadId);
      if (!started || started.turnId !== event.turnId || started.instanceId !== event.providerInstanceId) return;
      starts.delete(event.threadId);
      if (!event.ok || replayed || stopped || event.stopReason === "cancelled" || event.stopReason === "interrupted") return;
      for (const task of store.tasks(botId)) {
        const mark = marks.get(task.threadId);
        if (task.activity !== "dead" || !mark || mark.instanceId !== started.instanceId || mark.order >= started.order) continue;
        marks.delete(task.threadId);
        store.setTaskActivity(botId, task.threadId, "idle");
      }
    },
    forget(threadId: string): void {
      starts.delete(threadId);
      marks.delete(threadId);
    },
  };
}
