import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const PANEL_MIN_WIDTH = 360;
export const PANEL_DEFAULT_WIDTH = 960;
export const COMPUTER_PANEL_DEFAULT_WIDTH = 1152;
export const PANEL_MAX_WIDTH = 1440;
export const CHAT_MIN_WIDTH = 360;
const PANEL_INLINE_BREAKPOINT = 1536;
const PANEL_INLINE_GUTTER = PANEL_INLINE_BREAKPOINT - PANEL_DEFAULT_WIDTH;
const PANEL_RESIZE_STEP = 40;

export function computerPanelMaxWidth(viewportWidth: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(0,
    viewportWidth >= PANEL_INLINE_BREAKPOINT ? viewportWidth - PANEL_INLINE_GUTTER : viewportWidth));
}

export function clampComputerPanelWidth(width: number, viewportWidth: number): number {
  const maxWidth = computerPanelMaxWidth(viewportWidth);
  return Math.min(maxWidth, Math.max(Math.min(PANEL_MIN_WIDTH, maxWidth), width));
}

type ComputerPanelResizeOptions = {
  defaultWidth?: number;
  width?: number;
  onWidthChange?: (width: number) => void;
};

export function useComputerPanelResize(options: ComputerPanelResizeOptions = {}) {
  const defaultWidth = options.defaultWidth ?? PANEL_DEFAULT_WIDTH;
  const [uncontrolledWidth, setUncontrolledWidth] = useState(defaultWidth);
  const controlled = options.width !== undefined;
  const chosenWidth = controlled ? options.width! : uncontrolledWidth;
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? PANEL_INLINE_BREAKPOINT : window.innerWidth);
  const [rowMaxWidth, setRowMaxWidth] = useState<number | null>(null);
  const panelMaxWidth = Math.min(computerPanelMaxWidth(viewportWidth), rowMaxWidth ?? Infinity);
  const panelWidth = Math.min(chosenWidth, panelMaxWidth);
  const setPanelWidth = (next: number | ((current: number) => number)) => {
    if (controlled) {
      const resolved = typeof next === "function" ? next(panelWidth) : next;
      options.onWidthChange?.(resolved);
      return;
    }
    setUncontrolledWidth((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      options.onWidthChange?.(resolved);
      return resolved;
    });
  };
  const separatorRef = useRef<HTMLDivElement>(null);
  const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: separatorWidth && separatorWidth > 0 ? separatorWidth : Math.min(panelWidth, panelMaxWidth) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(panelMaxWidth, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => Math.min(panelMaxWidth, Math.max(PANEL_MIN_WIDTH, Math.min(current, panelMaxWidth) + delta)));
  };
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useLayoutEffect(() => {
    const panel = separatorRef.current?.closest("aside");
    const row = panel?.parentElement;
    if (!panel || !row) return;
    let chat: HTMLElement | null = null;
    const read = () => {
      const current = row.querySelector<HTMLElement>(":scope > main");
      if (current !== chat) {
        if (chat) resizes.unobserve(chat);
        if (current) resizes.observe(current);
        chat = current;
      }
      const width = panel.offsetWidth;
      setSeparatorWidth(width);
      setRowMaxWidth(chat && width > 0
        ? Math.max(PANEL_MIN_WIDTH, width + chat.offsetWidth - CHAT_MIN_WIDTH)
        : null);
    };
    const resizes = new ResizeObserver(read);
    resizes.observe(panel);
    const swaps = new MutationObserver(read);
    swaps.observe(row, { childList: true });
    read();
    return () => {
      resizes.disconnect();
      swaps.disconnect();
    };
  }, []);
  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
    if (widen === null || separatorWidth === null) return;
    event.preventDefault();
    onResizeBy(widen);
  };
  return { panelWidth, panelMaxWidth, maxWidth: panelMaxWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd };
}
