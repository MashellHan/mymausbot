import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AtSign,
  CheckCircle2,
  CircleHelp,
  HandHelping,
  Info,
  KeyRound,
  LogIn,
  Newspaper,
  RotateCcw,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";

import { openPwaNotificationTarget } from "@/hooks/use-external-chat-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { listenLiveFrames } from "@/lib/live-events";
import { computeBannerSwipeState } from "@/lib/pwa-top-chrome";
import { useShowThreads } from "@/lib/thread-preferences";
import type { LocaleKey } from "@/locales";
import { useStore } from "@/state/store";
import type { NotificationLogEntry, NotifyKind } from "../../shared/notification";
import { plainPreviewText } from "../../shared/plain-preview";
import { BotAvatar } from "./Avatar";
import { Layer } from "./Layer";

const P0_KINDS: ReadonlySet<NotifyKind> = new Set(["approval", "question", "sign-in", "secret"]);
const P0_DISMISS_MS = 10_000;
const P1_DISMISS_MS = 4_500;

const KIND_META: Record<NotifyKind, { Icon: LucideIcon; badgeClass: string; statusKey: LocaleKey }> = {
  approval: { Icon: HandHelping, badgeClass: "text-warning", statusKey: "notifications.status.approval" },
  question: { Icon: CircleHelp, badgeClass: "text-warning", statusKey: "notifications.status.question" },
  "sign-in": { Icon: LogIn, badgeClass: "text-warning", statusKey: "notifications.status.signIn" },
  secret: { Icon: KeyRound, badgeClass: "text-warning", statusKey: "notifications.status.secret" },
  done: { Icon: CheckCircle2, badgeClass: "text-success", statusKey: "notifications.status.done" },
  "delegation-settled": { Icon: CheckCircle2, badgeClass: "text-success", statusKey: "notifications.status.done" },
  mention: { Icon: AtSign, badgeClass: "text-accent", statusKey: "notifications.status.mention" },
  incident: { Icon: AlertTriangle, badgeClass: "text-danger", statusKey: "notifications.status.problem" },
  "turn-failed": { Icon: AlertTriangle, badgeClass: "text-danger", statusKey: "notifications.status.failed" },
  "routine-failed": { Icon: AlertTriangle, badgeClass: "text-danger", statusKey: "notifications.status.failed" },
  "routine-deferred": { Icon: RotateCcw, badgeClass: "text-accent", statusKey: "notifications.status.deferred" },
  spend: { Icon: Wallet, badgeClass: "text-accent", statusKey: "notifications.status.spend" },
  brief: { Icon: Newspaper, badgeClass: "text-accent", statusKey: "notifications.status.brief" },
  wait: { Icon: CheckCircle2, badgeClass: "text-success", statusKey: "notifications.status.done" },
  notice: { Icon: Info, badgeClass: "text-accent", statusKey: "notifications.status.notice" },
};

export interface QueuedBannerItem {
  notification: NotificationLogEntry;
  priority: "p0" | "p1";
  receivedAt: number;
}

export function isP0NotificationKind(kind: NotifyKind): boolean {
  return P0_KINDS.has(kind);
}

export function shouldSuppressBanner({
  notification,
  activeView,
  activeThreadId,
  drawerOpen,
  visibilityState,
}: {
  notification: NotificationLogEntry;
  activeView: string;
  activeThreadId: string | null;
  drawerOpen: boolean;
  visibilityState?: DocumentVisibilityState;
}): boolean {
  if (visibilityState === "hidden") return true;
  if (notification.kind === "spend") return false;
  if (drawerOpen) return false;
  if (activeView !== "chat" || !activeThreadId) return false;
  return notification.threadId === activeThreadId;
}

export function enqueueBannerItem(
  current: QueuedBannerItem | null,
  queue: QueuedBannerItem[],
  incoming: QueuedBannerItem,
): { current: QueuedBannerItem; queue: QueuedBannerItem[] } {
  if (!current) {
    return { current: incoming, queue };
  }
  if (incoming.priority === "p0") {
    if (current.priority === "p1") {
      return { current: incoming, queue: [current, ...queue] };
    }
    return { current, queue: [incoming, ...queue] };
  }
  if (current.priority === "p0") {
    return { current, queue: [...queue, incoming] };
  }
  return { current: incoming, queue };
}

export function PwaNotificationBanner({
  activeView,
  activeThreadId,
  drawerOpen,
  onJump,
}: {
  activeView: string;
  activeThreadId: string | null;
  drawerOpen: boolean;
  onJump?: () => void;
}) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [current, setCurrent] = useState<QueuedBannerItem | null>(null);
  const [queue, setQueue] = useState<QueuedBannerItem[]>([]);
  const [paused, setPaused] = useState(false);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [dragOpacity, setDragOpacity] = useState(1);
  const swipeRef = useRef<{ startY: number; startAt: number; moved: boolean } | null>(null);

  const suppressionRef = useRef({ activeView, activeThreadId, drawerOpen });
  suppressionRef.current = { activeView, activeThreadId, drawerOpen };

  const currentRef = useRef<QueuedBannerItem | null>(null);
  currentRef.current = current;
  const queueRef = useRef<QueuedBannerItem[]>([]);
  queueRef.current = queue;

  const dismissCurrent = useCallback(() => {
    const nextQueue = queueRef.current;
    if (nextQueue.length > 0) {
      const [next, ...rest] = nextQueue;
      setCurrent(next ?? null);
      setQueue(rest);
    } else {
      setCurrent(null);
    }
    setPaused(false);
    setDragOffsetY(0);
    setDragOpacity(1);
    swipeRef.current = null;
  }, []);

  useEffect(() => {
    return listenLiveFrames({
      onFrame: (frame) => {
        if (frame.kind !== "notify") return;
        const notification = frame.notification;
        const suppressed = shouldSuppressBanner({
          notification,
          activeView: suppressionRef.current.activeView,
          activeThreadId: suppressionRef.current.activeThreadId,
          drawerOpen: suppressionRef.current.drawerOpen,
          visibilityState: typeof document !== "undefined" ? document.visibilityState : "visible",
        });
        if (suppressed) return;
        const priority: "p0" | "p1" = isP0NotificationKind(notification.kind) ? "p0" : "p1";
        const result = enqueueBannerItem(currentRef.current, queueRef.current, {
          notification,
          priority,
          receivedAt: Date.now(),
        });
        setCurrent(result.current);
        setQueue(result.queue);
      },
    });
  }, []);

  useEffect(() => {
    if (!current || paused) return;
    const timeoutMs = current.priority === "p0" ? P0_DISMISS_MS : P1_DISMISS_MS;
    const timer = setTimeout(dismissCurrent, timeoutMs);
    return () => clearTimeout(timer);
  }, [current, paused, dismissCurrent]);

  useEffect(() => {
    if (!current) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissCurrent();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, dismissCurrent]);

  const bot = useMemo(
    () => (current ? state.bots.find((b) => b.id === current.notification.botId) ?? null : null),
    [current, state.bots],
  );

  if (!current) return null;

  const { notification, priority } = current;
  const isP0 = priority === "p0";
  const meta = KIND_META[notification.kind] ?? KIND_META.notice;
  const Icon = meta.Icon;
  const body = notification.body ? plainPreviewText(notification.body) : "";
  const extraCount = queue.length;

  const handleOpen = () => {
    const group = state.groups.find(
      (g) => !g.dm && (g.threadId === notification.threadId || (g.tasks ?? []).some((task) => task.threadId === notification.threadId)),
    );
    openPwaNotificationTarget(
      dispatch,
      {
        botId: notification.botId,
        threadId: notification.threadId,
        ...(group ? { groupId: group.id } : {}),
        notificationId: notification.id,
      },
      state,
      showThreads,
      onJump,
    );
    dismissCurrent();
  };

  return (
    <Layer>
      <div
        className="pointer-events-none fixed inset-x-3 z-[55] mx-auto max-w-[420px] sm:right-4 sm:left-auto sm:mx-0 sm:w-[360px]"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 8px)" }}
      >
        <div
          role={isP0 ? "alert" : "status"}
          aria-live={isP0 ? "assertive" : "polite"}
          aria-label={t("pwaBanner.region")}
          data-pwa-banner={priority}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
          onTouchStart={(event) => {
            const touch = event.touches[0];
            if (!touch) return;
            setPaused(true);
            swipeRef.current = { startY: touch.clientY, startAt: Date.now(), moved: false };
          }}
          onTouchMove={(event) => {
            const swipe = swipeRef.current;
            const touch = event.touches[0];
            if (!swipe || !touch) return;
            const dy = touch.clientY - swipe.startY;
            if (Math.abs(dy) > 4) swipe.moved = true;
            const state = computeBannerSwipeState(dy);
            setDragOffsetY(state.offsetY);
            setDragOpacity(state.opacity);
          }}
          onTouchEnd={(event) => {
            const swipe = swipeRef.current;
            swipeRef.current = null;
            setPaused(false);
            const touch = event.changedTouches[0];
            if (swipe && touch) {
              const dy = touch.clientY - swipe.startY;
              const elapsed = Math.max(1, Date.now() - swipe.startAt);
              const result = computeBannerSwipeState(dy, dy / elapsed);
              if (result.decision === "dismiss") {
                dismissCurrent();
                return;
              }
            }
            setDragOffsetY(0);
            setDragOpacity(1);
          }}
          onTouchCancel={() => {
            swipeRef.current = null;
            setPaused(false);
            setDragOffsetY(0);
            setDragOpacity(1);
          }}
          onClick={() => {
            if (swipeRef.current?.moved) return;
            handleOpen();
          }}
          style={dragOffsetY !== 0 || dragOpacity !== 1 ? { transform: `translateY(${dragOffsetY}px)`, opacity: dragOpacity } : undefined}
          className={cn(
            "pointer-events-auto relative flex w-full cursor-pointer items-stretch gap-2.5 overflow-hidden rounded-2xl bg-composer p-3 text-left shadow-(--shadow-float) transition-[transform,opacity] duration-150 active:scale-[0.99] animate-pop-in motion-reduce:animate-none motion-reduce:transition-none",
            isP0 ? "border border-warning/45" : "border border-edge",
          )}
        >
          {isP0 && <span aria-hidden="true" className="w-[3px] shrink-0 rounded-full bg-warning" />}

          <div className="flex shrink-0 items-center">
            {isP0 ? (
              <span className="flex size-7 items-center justify-center rounded-full bg-warning/15 text-warning" aria-hidden="true">
                <Icon size={15} />
              </span>
            ) : bot ? (
              <BotAvatar bot={bot} state="happy" size={28} animated={false} />
            ) : (
              <span className="flex size-7 items-center justify-center rounded-full bg-ink/[0.06]" aria-hidden="true">
                <Icon size={15} className={meta.badgeClass} />
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {isP0 ? (
                <>
                  <span className="shrink-0 text-[11px] font-semibold text-warning">{t(meta.statusKey)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{notification.botName}</span>
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate text-[13px] font-semibold text-ink">{notification.botName}</span>
                  <span className={cn("shrink-0 text-[11px] font-medium", notification.kind.includes("fail") || notification.kind === "incident" ? "text-danger" : "text-ink-secondary")}>
                    {t(meta.statusKey)}
                  </span>
                </>
              )}
              {extraCount > 0 && (
                <span className="shrink-0 rounded-full bg-control px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-secondary">
                  {t("pwaBanner.queuedMore", { count: extraCount })}
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-secondary">
              {body || notification.title}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isP0 && (
              <span className="shrink-0 rounded-full bg-warning/15 px-2.5 py-1 text-[12px] font-medium text-warning">
                {t("pwaBanner.review")}
              </span>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                dismissCurrent();
              }}
              aria-label={t("pwaBanner.dismiss")}
              className="-mt-1 -mr-1 flex size-9 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </Layer>
  );
}
