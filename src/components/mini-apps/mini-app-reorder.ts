import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export const MINI_APP_LONG_PRESS_MS = 220;
export const MINI_APP_PRESS_CANCEL_PX = 8;

export interface MiniAppDropTarget {
  id: string;
  place: "before" | "after";
}

export function reorderMiniAppIds(
  ids: readonly string[],
  movedId: string,
  targetId: string,
  place: "before" | "after",
): string[] | null {
  if (movedId === targetId) return null;
  const from = ids.indexOf(movedId);
  const target = ids.indexOf(targetId);
  if (from < 0 || target < 0) return null;
  const next = ids.filter((id) => id !== movedId);
  const insertAt = next.indexOf(targetId) + (place === "after" ? 1 : 0);
  next.splice(insertAt, 0, movedId);
  if (next.every((id, index) => id === ids[index])) return null;
  return next;
}

export function applyMiniAppOrder<T extends { id: string }>(list: readonly T[], orderedIds: readonly string[]): T[] {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return [...list].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
}

export function reorderMiniAppByOffset(
  ids: readonly string[],
  movedId: string,
  delta: -1 | 1,
): string[] | null {
  const from = ids.indexOf(movedId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export function miniAppDropTargetAtPoint(
  clientX: number,
  movedId: string,
  items: ReadonlyArray<{ id: string; left: number; right: number }>,
  rtl = false,
): MiniAppDropTarget | null {
  const candidates = items.filter((item) => item.id !== movedId);
  if (!candidates.length) return null;
  let best = candidates[0]!;
  let bestDistance = Infinity;
  for (const item of candidates) {
    const mid = (item.left + item.right) / 2;
    const distance = Math.abs(clientX - mid);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  const mid = (best.left + best.right) / 2;
  const before = rtl ? clientX >= mid : clientX < mid;
  return { id: best.id, place: before ? "before" : "after" };
}

export function useMiniAppLongPressReorder({
  appIds,
  enabled,
  tabListRef,
  onReorder,
}: {
  appIds: readonly string[];
  enabled: boolean;
  tabListRef: RefObject<HTMLDivElement | null>;
  onReorder?: (orderedIds: string[]) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<MiniAppDropTarget | null>(null);
  const appIdsRef = useRef(appIds);
  const onReorderRef = useRef(onReorder);
  const suppressClickRef = useRef(false);
  const stateRef = useRef<{
    appId: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    drop: MiniAppDropTarget | null;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  appIdsRef.current = appIds;
  onReorderRef.current = onReorder;

  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  const startPress = (appId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!enabled || !onReorderRef.current || appIdsRef.current.length < 2) return;
    if (event.button !== 0 && event.pointerType !== "touch") return;
    cleanupRef.current?.();

    const current = {
      appId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      drop: null as MiniAppDropTarget | null,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    stateRef.current = current;

    const updateDrop = (clientX: number) => {
      const container = tabListRef.current;
      if (!container) return;
      const rects = [...container.querySelectorAll<HTMLElement>("[data-mini-app-item]")].map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.dataset.miniAppItem ?? "", left: rect.left, right: rect.right };
      }).filter((entry) => entry.id.length > 0 && entry.right > entry.left);
      const next = miniAppDropTargetAtPoint(clientX, current.appId, rects, document.documentElement.dir === "rtl");
      current.drop = next;
      setDropTarget(next);
    };

    const finish = (commit: boolean) => {
      if (current.timer !== null) {
        clearTimeout(current.timer);
        current.timer = null;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown);
      if (stateRef.current === current) stateRef.current = null;
      cleanupRef.current = null;
      const wasActive = current.active;
      const target = current.drop;
      setDraggingId(null);
      setDropTarget(null);
      if (wasActive) {
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 0);
        if (commit && target) {
          const next = reorderMiniAppIds(appIdsRef.current, current.appId, target.id, target.place);
          if (next) onReorderRef.current?.(next);
        }
      }
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== current.pointerId) return;
      if (!current.active) {
        const dx = moveEvent.clientX - current.startX;
        const dy = moveEvent.clientY - current.startY;
        if (Math.hypot(dx, dy) > MINI_APP_PRESS_CANCEL_PX) finish(false);
        return;
      }
      moveEvent.preventDefault();
      updateDrop(moveEvent.clientX);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== current.pointerId) return;
      if (current.active) updateDrop(upEvent.clientX);
      finish(true);
    };

    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== current.pointerId) return;
      finish(false);
    };

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") finish(false);
    };

    cleanupRef.current = () => finish(false);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown);

    current.timer = setTimeout(() => {
      current.timer = null;
      if (stateRef.current !== current) return;
      current.active = true;
      setDraggingId(current.appId);
      updateDrop(current.startX);
    }, MINI_APP_LONG_PRESS_MS);
  };

  const consumeSuppressedClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  return { draggingId, dropTarget, startPress, consumeSuppressedClick };
}
