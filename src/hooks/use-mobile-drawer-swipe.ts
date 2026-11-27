import { useCallback, useEffect, useMemo, useRef, useState, type Touch, type TouchEventHandler, type TouchList } from "react";

const IGNORE_TARGET_SELECTOR =
  'input, textarea, select, pre, table, [contenteditable="true"], [data-swipe-ignore], [data-swipe-action], [data-no-drawer-swipe], [role="slider"]';
const SWIPE_ROW_ACTIVE_SELECTOR = "[data-swipe-row-open], [data-swipe-row-dragging]";

const AXIS_LOCK_PX = 10;
const VERTICAL_ABORT_RATIO = 0.85;
const HORIZONTAL_LOCK_RATIO = 1.25;
const HORIZONTAL_SCROLL_SLOP_PX = 4;

const DISTANCE_THRESHOLD_PX = 68;
const RIGHT_OPEN_FLICK_PX = 32;
const LEFT_OPEN_FLICK_PX = 36;
const LEFT_CLOSE_FLICK_PX = 32;
const FLICK_VELOCITY = 0.35;

export type DrawerSwipeAction = "open" | "close" | "none";

export interface DrawerSwipeDecisionInput {
  drawerOpen: boolean;
  dx: number;
  vx: number;
}

export interface UseMobileDrawerSwipeOptions {
  enabled: boolean;
  drawerOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}

export interface MobileDrawerSwipeResult {
  dragProgress: number | null;
  dragging: boolean;
  touchHandlers: {
    onTouchStart: TouchEventHandler<HTMLElement>;
    onTouchMove: TouchEventHandler<HTMLElement>;
    onTouchEnd: TouchEventHandler<HTMLElement>;
    onTouchCancel: TouchEventHandler<HTMLElement>;
  };
}

interface ActiveGesture {
  id: number;
  startX: number;
  startY: number;
  startTime: number;
  drawerOpen: boolean;
  axis: "pending" | "horizontal";
  viewportWidth: number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const isHorizontalLock = (absX: number, absY: number) =>
  absX >= AXIS_LOCK_PX && absY <= absX * VERTICAL_ABORT_RATIO && absX > absY * HORIZONTAL_LOCK_RATIO;

function elementFromEventTarget(target: EventTarget | null): Element | null {
  if (typeof Element !== "undefined" && target instanceof Element) return target;
  if (typeof Node !== "undefined" && target instanceof Node) return target.parentElement;
  return null;
}

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    const touch = list[i];
    if (touch && touch.identifier === id) return touch;
  }
  return null;
}

export function shouldIgnoreDrawerSwipeTarget(
  target: EventTarget | null,
  container?: HTMLElement | null,
): boolean {
  if (typeof window !== "undefined" && window.getSelection?.()?.toString().trim()) return true;

  const startEl = elementFromEventTarget(target);
  if (!startEl) return false;
  if (startEl.closest(IGNORE_TARGET_SELECTOR)) return true;

  if (typeof window === "undefined") return false;
  let el: HTMLElement | null = startEl instanceof HTMLElement ? startEl : startEl.parentElement;
  while (el && el !== container && el !== document.body && el !== document.documentElement) {
    const overflowX = window.getComputedStyle(el).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && el.scrollWidth > el.clientWidth + HORIZONTAL_SCROLL_SLOP_PX) {
      return true;
    }
    el = el.parentElement;
  }

  return false;
}

export function decideDrawerSwipeAction({ drawerOpen, dx, vx }: DrawerSwipeDecisionInput): DrawerSwipeAction {
  if (!drawerOpen) {
    if (dx >= DISTANCE_THRESHOLD_PX || (dx >= RIGHT_OPEN_FLICK_PX && vx >= FLICK_VELOCITY)) return "open";
    if (dx <= -DISTANCE_THRESHOLD_PX || (dx <= -LEFT_OPEN_FLICK_PX && vx <= -FLICK_VELOCITY)) return "open";
    return "none";
  }
  if (dx <= -DISTANCE_THRESHOLD_PX || (dx <= -LEFT_CLOSE_FLICK_PX && vx <= -FLICK_VELOCITY)) return "close";
  return "none";
}

export function useMobileDrawerSwipe({
  enabled,
  drawerOpen,
  onOpen,
  onClose,
}: UseMobileDrawerSwipeOptions): MobileDrawerSwipeResult {
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
  onOpenRef.current = onOpen;
  onCloseRef.current = onClose;

  const resetGesture = useCallback(() => {
    gestureRef.current = null;
    setDragProgress((prev) => (prev === null ? prev : null));
  }, []);

  useEffect(() => {
    if (!enabled) resetGesture();
  }, [enabled, resetGesture]);

  const onTouchStart = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    if (!enabled) return;
    if (event.touches.length !== 1 || shouldIgnoreDrawerSwipeTarget(event.target, event.currentTarget)) {
      return resetGesture();
    }
    if (drawerOpen && elementFromEventTarget(event.target)?.closest(SWIPE_ROW_ACTIVE_SELECTOR)) {
      return resetGesture();
    }
    const touch = event.touches[0];
    if (!touch) return;
    const viewportWidth = Math.max(
      1,
      event.currentTarget.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0) || 375,
    );
    gestureRef.current = {
      id: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
      drawerOpen,
      axis: "pending",
      viewportWidth,
    };
  }, [drawerOpen, enabled, resetGesture]);

  const onTouchMove = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!enabled || event.touches.length !== 1) return resetGesture();
    const touch = findTouch(event.touches, gesture.id);
    if (!touch) return resetGesture();

    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;

    if (gesture.axis === "pending") {
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX < AXIS_LOCK_PX && absY < AXIS_LOCK_PX) return;
      if (absY > absX * VERTICAL_ABORT_RATIO) return resetGesture();
      if (!isHorizontalLock(absX, absY)) return;
      if (gesture.drawerOpen && (dx > 0 || elementFromEventTarget(event.target)?.closest(SWIPE_ROW_ACTIVE_SELECTOR))) {
        return resetGesture();
      }
      gesture.axis = "horizontal";
    }

    if (gesture.drawerOpen) setDragProgress(clamp01(1 + dx / gesture.viewportWidth));
    else if (dx > 0) setDragProgress(clamp01(dx / gesture.viewportWidth));
    else setDragProgress((prev) => (prev === null ? prev : null));
  }, [enabled, resetGesture]);

  const onTouchEnd = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const touch = findTouch(event.changedTouches, gesture.id);
    if (!touch) {
      if (event.touches.length === 0) resetGesture();
      return;
    }
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    const elapsedMs = Math.max(1, Date.now() - gesture.startTime);
    const horizontal =
      gesture.axis === "horizontal" ||
      (isHorizontalLock(Math.abs(dx), Math.abs(dy)) && !(gesture.drawerOpen && dx > 0));
    const startedOpen = gesture.drawerOpen;
    resetGesture();

    if (!horizontal) return;
    const action = decideDrawerSwipeAction({ drawerOpen: startedOpen, dx, vx: dx / elapsedMs });
    if (action === "open") onOpenRef.current();
    else if (action === "close") onCloseRef.current();
  }, [resetGesture]);

  const touchHandlers = useMemo(
    () => ({ onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: resetGesture }),
    [onTouchStart, onTouchMove, onTouchEnd, resetGesture],
  );

  return { dragProgress, dragging: dragProgress !== null, touchHandlers };
}
