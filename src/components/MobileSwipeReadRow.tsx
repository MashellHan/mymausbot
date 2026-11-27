import { useRef, useState, type Dispatch, type MouseEvent, type ReactNode, type TouchEvent } from "react";
import { BellDot, CheckCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { markBotRead } from "@/lib/folder-read";
import { t } from "@/lib/i18n";
import { api, type Action, type Bot, type BotAnnouncement, type Group } from "@/state/store";

const REVEAL_WIDTH = 88, MAX_OFFSET = 124, AXIS_LOCK_PX = 10, CLICK_SUPPRESS_MS = 350;

type SwipeRequest<T> = (path: string, init?: RequestInit) => Promise<T>;

export async function toggleBotUnread(
  bot: Pick<Bot, "id" | "threadId" | "unread" | "tasks">,
  unread: boolean,
  dispatch: Dispatch<Action>,
  request: SwipeRequest<{ bot: BotAnnouncement }> = api,
): Promise<void> {
  if (!unread) { dispatch({ type: "markUnread", botId: bot.id }); return; }
  try {
    await markBotRead(bot, request, (updated) => dispatch({ type: "botPatched", bot: updated }));
  } catch { return; }
}

export async function toggleGroupUnread(
  group: Pick<Group, "id" | "threadId" | "unread" | "tasks">,
  unread: boolean,
  dispatch: Dispatch<Action>,
  request: SwipeRequest<{ group?: Partial<Group> & { id: string } }> = api,
): Promise<void> {
  try {
    if (!unread) {
      const result = await request(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ unread: true }) });
      dispatch({ type: "groupPatched", group: result?.group ?? { id: group.id, unread: true } });
      return;
    }
    const unreadThreads = group.tasks?.filter((task) => task.unread ?? (task.threadId === group.threadId && group.unread)).map((task) => task.threadId);
    const threadIds = unreadThreads && unreadThreads.length > 0 ? unreadThreads : [group.threadId];
    for (const threadId of threadIds) {
      const result = await request(`/api/groups/${group.id}/read`, { method: "POST", body: JSON.stringify({ threadId }) });
      if (result?.group) dispatch({ type: "groupPatched", group: result.group });
    }
  } catch { return; }
}

export function resolveSwipeRowRelease(offsetPx: number, vx: number): "trigger" | "open" | "close" {
  if (offsetPx >= 78 || (offsetPx >= 44 && vx >= 0.45)) return "trigger";
  if (offsetPx >= 40) return "open";
  return "close";
}

interface TouchGesture {
  startX: number;
  startY: number;
  lastX: number;
  lastTime: number;
  vx: number;
  offset: number;
  fromRevealed: boolean;
  axis: "none" | "horizontal" | "vertical";
}

export function MobileSwipeReadRow({
  enabled,
  unread,
  onToggleUnread,
  children,
}: {
  enabled: boolean;
  unread: boolean;
  onToggleUnread: () => void | Promise<void>;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gestureRef = useRef<TouchGesture | null>(null);
  const suppressClickUntilRef = useRef(0);

  if (!enabled) return <>{children}</>;

  const label = t(unread ? "sidebar.bot.simple.markRead" : "sidebar.bot.simple.markUnread");
  const closeRow = () => { setOffset(0); setRevealed(false); };

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) { gestureRef.current = null; setDragging(false); return; }
    const touch = event.touches[0]!;
    gestureRef.current = {
      startX: touch.clientX, startY: touch.clientY, lastX: touch.clientX, lastTime: Date.now(),
      vx: 0, offset: revealed ? REVEAL_WIDTH : 0, fromRevealed: revealed, axis: "none",
    };
  };

  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (event.touches.length !== 1) {
      gestureRef.current = null; setDragging(false); setOffset(gesture.fromRevealed ? REVEAL_WIDTH : 0);
      return;
    }
    const touch = event.touches[0]!;
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    if (gesture.axis === "vertical") return;
    if (gesture.axis === "none") {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      if (Math.abs(dy) > Math.abs(dx) * 0.85) { gesture.axis = "vertical"; return; }
      if (!gesture.fromRevealed) {
        if (dx < AXIS_LOCK_PX || dx <= Math.abs(dy) * 1.25) { if (dx < 0) gesture.axis = "vertical"; return; }
      } else if (Math.abs(dx) < AXIS_LOCK_PX || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
      gesture.axis = "horizontal";
      setDragging(true);
    }
    event.stopPropagation();
    const now = Date.now();
    const dt = now - gesture.lastTime;
    if (dt > 0) gesture.vx = (touch.clientX - gesture.lastX) / dt;
    gesture.lastX = touch.clientX;
    gesture.lastTime = now;
    if (gesture.fromRevealed) {
      gesture.offset = dx < 0 ? Math.max(0, REVEAL_WIDTH + dx) : Math.min(MAX_OFFSET, REVEAL_WIDTH + dx * 0.35);
    } else {
      const clamped = Math.max(0, dx);
      gesture.offset = Math.min(MAX_OFFSET, clamped <= REVEAL_WIDTH ? clamped : REVEAL_WIDTH + (clamped - REVEAL_WIDTH) * 0.35);
    }
    setOffset(gesture.offset);
  };

  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || gesture.axis !== "horizontal") { setDragging(false); return; }
    event.stopPropagation();
    const now = Date.now();
    suppressClickUntilRef.current = now + CLICK_SUPPRESS_MS;
    const releaseVx = now - gesture.lastTime > 120 ? 0 : gesture.vx;
    setDragging(false);
    if (gesture.fromRevealed) {
      if (gesture.offset < 48 || releaseVx <= -0.35) closeRow();
      else { setOffset(REVEAL_WIDTH); setRevealed(true); }
      return;
    }
    const action = resolveSwipeRowRelease(gesture.offset, releaseVx);
    if (action === "trigger") { closeRow(); void onToggleUnread(); }
    else if (action === "open") { setOffset(REVEAL_WIDTH); setRevealed(true); }
    else closeRow();
  };

  const onTouchCancel = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    setDragging(false);
    if (gesture?.axis === "horizontal") {
      suppressClickUntilRef.current = Date.now() + CLICK_SUPPRESS_MS;
      setOffset(gesture.fromRevealed ? REVEAL_WIDTH : 0);
      setRevealed(gesture.fromRevealed);
    }
  };

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressClickUntilRef.current) { event.preventDefault(); event.stopPropagation(); return; }
    if (revealed) { event.preventDefault(); event.stopPropagation(); closeRow(); }
  };

  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      data-swipe-row=""
      data-swipe-row-open={revealed ? "" : undefined}
      data-swipe-row-dragging={dragging ? "" : undefined}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 flex items-stretch",
          !revealed && offset === 0 && "pointer-events-none opacity-0",
        )}
        style={{ width: Math.max(REVEAL_WIDTH, Math.round(offset)) }}
      >
        <button
          type="button"
          data-swipe-action=""
          tabIndex={revealed ? 0 : -1}
          aria-hidden={!revealed && offset === 0 ? true : undefined}
          aria-label={label}
          onClick={(event) => { event.stopPropagation(); closeRow(); void onToggleUnread(); }}
          className="flex w-full flex-col items-center justify-center gap-1 rounded-2xl bg-accent px-2 text-center text-[11px] font-medium leading-tight text-white active:brightness-95"
        >
          {unread ? <CheckCheck size={16} aria-hidden="true" /> : <BellDot size={16} aria-hidden="true" />}
          <span className="line-clamp-2">{label}</span>
        </button>
      </div>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        onClickCapture={onClickCapture}
        style={offset > 0 ? { transform: `translate3d(${offset}px, 0, 0)` } : undefined}
        className={cn(
          "relative rounded-2xl bg-app",
          dragging ? "transition-none" : "transition-transform duration-200 ease-out motion-reduce:transition-none",
        )}
      >
        {children}
      </div>
    </div>
  );
}
