import type { AppState, Bot, Group } from "@/state/store";

export const SNAPSHOT_IDLE_DEBOUNCE_MS = 500;
export const SNAPSHOT_STREAM_CHECKPOINT_MS = 12_000;
export const SNAPSHOT_SETTLE_FLUSH_MS = 250;

export interface SnapshotDigestInput {
  selectedId: string;
  bots: readonly Bot[];
  groups: readonly Group[];
  sections?: readonly string[];
  configLanguage?: string;
}

export function isAnyConversationStreaming(bots: readonly Bot[], groups: readonly Group[]): boolean {
  for (const bot of bots) {
    if (bot.busy) return true;
    if (bot.tasks?.some((task) => task.busy === true)) return true;
  }
  for (const group of groups) {
    if (group.working || group.busyBotId) return true;
    if (group.tasks?.some((task) => task.working === true || Boolean(task.busyBotId))) return true;
  }
  return false;
}

/**
 * Compact O(bots + groups) structural fingerprint so transient UI toggles (drawer, modals, focus,
 * optimistic outbox overlays) never trigger redundant IndexedDB snapshot clones.
 */
export function computeSnapshotDigest(input: SnapshotDigestInput): string {
  const parts: string[] = [
    input.selectedId,
    input.configLanguage ?? "",
    (input.sections ?? []).join(","),
  ];

  for (const bot of input.bots) {
    let lastNonOptId = "";
    let lastNonOptLen = 0;
    let nonOptCount = 0;
    for (let i = bot.messages.length - 1; i >= 0; i -= 1) {
      const m = bot.messages[i];
      if (!m || m.id.startsWith("optimistic-")) continue;
      if (!lastNonOptId) {
        lastNonOptId = m.id;
        lastNonOptLen = m.text?.length ?? 0;
      }
      nonOptCount += 1;
    }
    parts.push(
      `b:${bot.id}:${bot.name}:${bot.threadId}:${nonOptCount}:${lastNonOptId}:${lastNonOptLen}:${bot.tasks?.length ?? 0}:${bot.unread ? 1 : 0}`,
    );
  }

  for (const group of input.groups) {
    let lastNonOptId = "";
    let lastNonOptLen = 0;
    let nonOptCount = 0;
    for (let i = group.messages.length - 1; i >= 0; i -= 1) {
      const m = group.messages[i];
      if (!m || m.id.startsWith("optimistic-")) continue;
      if (!lastNonOptId) {
        lastNonOptId = m.id;
        lastNonOptLen = m.text?.length ?? 0;
      }
      nonOptCount += 1;
    }
    parts.push(
      `g:${group.id}:${group.name}:${group.threadId}:${nonOptCount}:${lastNonOptId}:${lastNonOptLen}:${group.tasks?.length ?? 0}:${group.unread ? 1 : 0}`,
    );
  }

  return parts.join("|");
}

export interface SnapshotSchedulerOptions {
  persist: () => void;
  idleDebounceMs?: number;
  streamCheckpointMs?: number;
  settleFlushMs?: number;
  now?: () => number;
}

export interface SnapshotScheduler {
  notify(state: Pick<AppState, "selectedId" | "bots" | "groups" | "sections" | "config">): void;
  flushNow(): void;
  dispose(): void;
}

export function createPwaSnapshotScheduler(options: SnapshotSchedulerOptions): SnapshotScheduler {
  const idleDebounceMs = options.idleDebounceMs ?? SNAPSHOT_IDLE_DEBOUNCE_MS;
  const streamCheckpointMs = options.streamCheckpointMs ?? SNAPSHOT_STREAM_CHECKPOINT_MS;
  const settleFlushMs = options.settleFlushMs ?? SNAPSHOT_SETTLE_FLUSH_MS;
  const now = options.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastPersistedDigest: string | null = null;
  let latestDigest: string | null = null;
  let dirty = false;
  let wasStreaming = false;
  let lastWriteAt = 0;
  let hasPersistedOnce = false;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const commit = () => {
    clearTimer();
    if (disposed || !dirty) return;
    dirty = false;
    hasPersistedOnce = true;
    lastPersistedDigest = latestDigest;
    lastWriteAt = now();
    options.persist();
  };

  const scheduleAfter = (delayMs: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      commit();
    }, Math.max(0, delayMs));
  };

  return {
    notify(state) {
      if (disposed) return;
      const digest = computeSnapshotDigest({
        selectedId: state.selectedId,
        bots: state.bots,
        groups: state.groups,
        sections: state.sections,
        configLanguage: state.config?.language,
      });
      const streaming = isAnyConversationStreaming(state.bots, state.groups);
      const justSettled = wasStreaming && !streaming;
      wasStreaming = streaming;

      if (!hasPersistedOnce) {
        latestDigest = digest;
        dirty = true;
        commit();
        return;
      }

      if (digest === lastPersistedDigest) {
        dirty = false;
        if (justSettled) clearTimer();
        return;
      }

      latestDigest = digest;
      dirty = true;

      if (streaming) {
        const elapsed = now() - lastWriteAt;
        const remaining = streamCheckpointMs - elapsed;
        if (remaining <= 0) {
          commit();
        } else if (timer === null) {
          scheduleAfter(remaining);
        }
        return;
      }

      scheduleAfter(justSettled ? settleFlushMs : idleDebounceMs);
    },
    flushNow() {
      if (disposed || !dirty) return;
      commit();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
