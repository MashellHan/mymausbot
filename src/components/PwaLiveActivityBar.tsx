import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronUp } from "lucide-react";

import { openPwaNotificationTarget } from "@/hooks/use-external-chat-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { turnNowPhrases } from "@/lib/live-activity";
import { useMacOffline } from "@/lib/pwa-connection";
import { resolveMobileTopChromeMode } from "@/lib/pwa-top-chrome";
import { lastNonReceipt } from "@/lib/receipts";
import { roomThreadSpeakerId, roomThreadWorking } from "@/lib/room-threads";
import { useShowThreads } from "@/lib/thread-preferences";
import { useTurnLive } from "@/state/turn-status";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";

export type LiveActivityPriority = "waiting" | "working" | "queued";

export interface LiveActivityEntry {
  kind: "bot" | "group";
  ownerId: string;
  ownerName: string;
  threadId: string;
  threadTitle?: string;
  bot?: Bot;
  priority: LiveActivityPriority;
  rank: number;
  updatedAt: number;
}

export function selectLiveActivityEntries(
  bots: Bot[],
  groups: Array<{
    id: string;
    name: string;
    threadId: string;
    dm?: boolean;
    busyBotId?: string | null;
    createdAt: number;
    tasks?: Array<{ threadId: string; title: string; activity?: string; busy?: boolean; createdAt?: number; updatedAt?: number }>;
  }>,
  pendingQueued: Record<string, unknown[]>,
): LiveActivityEntry[] {
  const entries: LiveActivityEntry[] = [];
  for (const bot of bots) {
    if (bot.hidden) continue;
    const tasks = bot.tasks?.length
      ? bot.tasks
      : [{ threadId: bot.threadId, title: "", createdAt: 0, busy: bot.busy, activity: bot.activity, waitingForTeammates: bot.waitingForTeammates }];
    for (const task of tasks) {
      if (task.routineRunId || task.archivedAt !== undefined) continue;
      const waiting = task.activity === "waiting-on-you" || (task.threadId === bot.threadId && bot.activity === "waiting-on-you");
      const working = !waiting && (task.busy === true || task.activity === "working" || task.waitingForTeammates === true || (task.threadId === bot.threadId && Boolean(bot.busy)));
      const queued = !waiting && !working && Boolean(pendingQueued[task.threadId]?.length);
      if (!waiting && !working && !queued) continue;
      const priority: LiveActivityPriority = waiting ? "waiting" : working ? "working" : "queued";
      const rank = waiting ? 1 : working ? 2 : 3;
      entries.push({
        kind: "bot",
        ownerId: bot.id,
        ownerName: bot.name,
        threadId: task.threadId,
        threadTitle: task.title || undefined,
        bot,
        priority,
        rank,
        updatedAt: task.updatedAt ?? task.createdAt ?? 0,
      });
    }
  }

  for (const group of groups) {
    if (group.dm) continue;
    const tasks = group.tasks?.length
      ? group.tasks
      : [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt }];
    for (const task of tasks) {
      const speakerId = roomThreadSpeakerId(group as never, task.threadId);
      const speaker = speakerId ? bots.find((b) => b.id === speakerId) : undefined;
      const waiting = speaker?.activity === "waiting-on-you" || task.activity === "waiting-on-you";
      const working = !waiting && roomThreadWorking(group as never, task.threadId);
      const queued = !waiting && !working && Boolean(pendingQueued[task.threadId]?.length);
      if (!waiting && !working && !queued) continue;
      const priority: LiveActivityPriority = waiting ? "waiting" : working ? "working" : "queued";
      const rank = waiting ? 1 : working ? 2 : 3;
      entries.push({
        kind: "group",
        ownerId: group.id,
        ownerName: group.name,
        threadId: task.threadId,
        threadTitle: task.title && task.title !== group.name ? task.title : undefined,
        bot: speaker,
        priority,
        rank,
        updatedAt: task.updatedAt ?? task.createdAt ?? 0,
      });
    }
  }

  return entries.sort((a, b) => a.rank - b.rank || b.updatedAt - a.updatedAt);
}

function useLiveEntryPhrase(entry: LiveActivityEntry): string {
  const live = useTurnLive(entry.threadId);
  if (entry.priority === "waiting") return t("task.waiting");
  if (entry.priority === "queued") return t("task.queued");
  const lastMsg = entry.bot ? lastNonReceipt(entry.bot.messages) : undefined;
  const now = turnNowPhrases(live.status, lastMsg);
  return now?.phrases[0] ?? t("chat.activity.working");
}

function LiveEntryStageText({ entry }: { entry: LiveActivityEntry }) {
  const phrase = useLiveEntryPhrase(entry);
  return <span className="truncate text-[12px] text-ink-secondary">{phrase}</span>;
}

function LiveEntryTrayChip({ entry }: { entry: LiveActivityEntry }) {
  const phrase = useLiveEntryPhrase(entry);
  return (
    <span className={cn("shrink-0 text-[12px] font-medium", entry.priority === "waiting" ? "text-warning" : entry.priority === "working" ? "text-success" : "text-ink-secondary")}>
      {phrase}
    </span>
  );
}

export function PwaLiveActivityBar({ onJump }: { onJump?: () => void }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const macOffline = useMacOffline();
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const rawEntries = useMemo(
    () => selectLiveActivityEntries(state.bots, state.groups, state.pendingQueued),
    [state.bots, state.groups, state.pendingQueued],
  );
  const chromeMode = resolveMobileTopChromeMode({
    connected: state.connected,
    cachedHydrated: Boolean(state.cachedHydrated),
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    macOffline,
    hasWaitingActivity: rawEntries.some((entry) => entry.priority === "waiting"),
  });
  const entries = useMemo(
    () => (chromeMode.suppressWorkingActivity ? rawEntries.filter((entry) => entry.priority === "waiting") : rawEntries),
    [chromeMode.suppressWorkingActivity, rawEntries],
  );

  const waitingKeys = useMemo(
    () => entries.filter((e) => e.priority === "waiting").map((e) => `${e.ownerId}:${e.threadId}`),
    [entries],
  );
  const prevWaitingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const nextSet = new Set(waitingKeys);
    let hasNewWaiting = false;
    for (const key of nextSet) {
      if (!prevWaitingRef.current.has(key)) {
        hasNewWaiting = true;
        break;
      }
    }
    prevWaitingRef.current = nextSet;
    if (hasNewWaiting && collapsed) {
      setCollapsed(false);
    }
  }, [waitingKeys, collapsed]);

  useEffect(() => {
    if (entries.length <= 1 && expanded) {
      setExpanded(false);
    }
  }, [entries.length, expanded]);

  if (chromeMode.hideActivityBar || entries.length === 0) return null;

  const primary = entries[0]!;
  const anyWaiting = waitingKeys.length > 0;
  const extraCount = entries.length - 1;

  const jumpTo = (entry: LiveActivityEntry) => {
    openPwaNotificationTarget(
      dispatch,
      entry.kind === "group"
        ? { groupId: entry.ownerId, threadId: entry.threadId }
        : { botId: entry.ownerId, threadId: entry.threadId },
      state,
      showThreads,
      onJump,
    );
    setExpanded(false);
  };

  if (collapsed) {
    return (
      <div
        role="region"
        aria-label={t("liveActivityBar.region")}
        data-live-activity-bar="collapsed"
        className="h-7 border-b border-hairline/40 bg-panel/70 px-3"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex h-full w-full items-center justify-center gap-1.5 text-[12px] text-ink-secondary hover:text-ink"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              anyWaiting ? "bg-warning" : "bg-success animate-status-pulse motion-reduce:animate-none",
            )}
          />
          <span>
            {anyWaiting
              ? t("liveActivityBar.waiting", { count: waitingKeys.length })
              : t("liveActivityBar.active", { count: entries.length })}
          </span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label={t("liveActivityBar.region")}
      data-live-activity-bar="expanded"
      className="border-b border-hairline/40 bg-panel/95 text-ink transition-colors motion-reduce:transition-none"
    >
      <div className="flex min-h-10 max-md:min-h-11 items-center gap-2 px-3">
        <button
          type="button"
          onClick={() => jumpTo(primary)}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 text-left"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2 shrink-0 rounded-full",
              primary.priority === "waiting"
                ? "bg-warning"
                : primary.priority === "working"
                  ? "bg-success animate-status-pulse motion-reduce:animate-none"
                  : "bg-ink-tertiary",
            )}
          />
          {primary.bot && <BotAvatar bot={primary.bot} state="happy" size={20} animated={false} />}
          <span className="max-w-[35%] shrink-0 truncate text-[13px] font-medium text-ink">
            {primary.ownerName}
          </span>
          <LiveEntryStageText entry={primary} />
        </button>

        {extraCount > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t("liveActivityBar.expand")}
            onClick={() => setExpanded((prev) => !prev)}
            className="flex min-h-8 max-md:min-h-10 shrink-0 items-center gap-1 rounded-full bg-control px-2.5 text-[12px] font-medium tabular-nums text-ink hover:bg-raised-hover"
          >
            <span>+{extraCount}</span>
            <ChevronDown
              size={13}
              aria-hidden="true"
              className={cn("transition-transform duration-150 motion-reduce:transition-none", expanded && "rotate-180")}
            />
          </button>
        )}

        <button
          type="button"
          aria-label={t("liveActivityBar.collapse")}
          title={t("liveActivityBar.collapse")}
          onClick={() => {
            setExpanded(false);
            setCollapsed(true);
          }}
          className="flex size-8 max-md:size-10 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <ChevronUp size={15} aria-hidden="true" />
        </button>
      </div>

      {extraCount > 0 && expanded && (
        <div className="max-h-[220px] overflow-y-auto border-t border-hairline/30 bg-card/50">
          {entries.map((entry) => (
            <button
              key={`${entry.kind}:${entry.ownerId}:${entry.threadId}`}
              type="button"
              onClick={() => jumpTo(entry)}
              className="flex min-h-11 w-full items-center gap-2.5 border-b border-hairline/20 px-3.5 py-2 text-left last:border-b-0 hover:bg-raised/60"
            >
              {entry.bot && <BotAvatar bot={entry.bot} state="happy" size={22} animated={false} />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{entry.ownerName}</span>
                {entry.threadTitle && (
                  <span className="block truncate text-[11px] text-ink-secondary">{entry.threadTitle}</span>
                )}
              </span>
              <LiveEntryTrayChip entry={entry} />
              <ChevronRight size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
