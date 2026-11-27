import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const INBOX_MIN_WIDTH = 280;
export const INBOX_DEFAULT_WIDTH = 320;
export const INBOX_ADVANCED_DEFAULT_WIDTH = 380;
export const INBOX_WIDE_WIDTH = 640;
export const INBOX_MAX_WIDTH = 720;
const INBOX_STORAGE_KEY = "omb-inbox-panel-width";
const INBOX_RESIZE_STEP = 32;
const VIEWPORT_MIN_REMAINING = 320;

export function inboxPanelMaxWidth(viewportWidth: number): number {
  const available = Math.max(0, viewportWidth - VIEWPORT_MIN_REMAINING);
  return Math.min(INBOX_MAX_WIDTH, available > 0 ? Math.max(Math.min(INBOX_MIN_WIDTH, viewportWidth), available) : viewportWidth);
}

export function clampInboxPanelWidth(width: number, viewportWidth: number): number {
  const maxWidth = inboxPanelMaxWidth(viewportWidth);
  return Math.min(maxWidth, Math.max(Math.min(INBOX_MIN_WIDTH, maxWidth), Math.round(width)));
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= INBOX_MIN_WIDTH ? Math.round(parsed) : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, String(Math.round(width)));
  } catch {}
}

export interface SidePanelResizeOptions {
  defaultWidth: number;
  wideWidth?: number;
  wide?: boolean;
  onWideChange?: (wide: boolean) => void;
  storageKey?: string;
  minWidth?: number;
  maxWidth?: number;
}

export function useSidePanelResize(options: SidePanelResizeOptions) {
  const storageKey = options.storageKey ?? INBOX_STORAGE_KEY;
  const minWidth = options.minWidth ?? INBOX_MIN_WIDTH;
  const maxLimit = options.maxWidth ?? INBOX_MAX_WIDTH;
  const [customWidth, setCustomWidth] = useState<number | null>(() => readStoredWidth(storageKey));
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const separatorRef = useRef<HTMLDivElement>(null);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);

  const panelMaxWidth = Math.min(maxLimit, inboxPanelMaxWidth(viewportWidth));
  const effectiveMin = Math.min(minWidth, panelMaxWidth);
  const clamp = (value: number) => Math.min(panelMaxWidth, Math.max(effectiveMin, Math.round(value)));

  const baseWidth = options.wide ? (options.wideWidth ?? INBOX_WIDE_WIDTH) : options.defaultWidth;
  const panelWidth = clamp(customWidth ?? baseWidth);

  const commitWidth = (next: number) => {
    const clamped = clamp(next);
    setCustomWidth(clamped);
    writeStoredWidth(storageKey, clamped);
    if (options.onWideChange && options.wide !== undefined) {
      const midpoint = ((options.defaultWidth + (options.wideWidth ?? INBOX_WIDE_WIDTH)) / 2);
      const nextWide = clamped >= midpoint;
      if (nextWide !== options.wide) options.onWideChange(nextWide);
    }
  };

  const resetToPreset = (wide: boolean) => {
    setCustomWidth(null);
    writeStoredWidth(storageKey, null);
    options.onWideChange?.(wide);
  };

  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    const startWidth = measuredWidth && measuredWidth > 0 ? measuredWidth : panelWidth;
    resizeFrom.current = { x: event.clientX, width: startWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    commitWidth(resizeFrom.current.width + (resizeFrom.current.x - event.clientX));
  };

  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const delta = event.key === "ArrowLeft" ? INBOX_RESIZE_STEP : event.key === "ArrowRight" ? -INBOX_RESIZE_STEP : null;
    if (delta === null) return;
    event.preventDefault();
    commitWidth((measuredWidth && measuredWidth > 0 ? measuredWidth : panelWidth) + delta);
  };

  const onDoubleClick = () => {
    resetToPreset(false);
  };

  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useLayoutEffect(() => {
    const panel = separatorRef.current?.closest("aside");
    if (!panel) return;
    const read = () => {
      if (panel.offsetWidth > 0) setMeasuredWidth(panel.offsetWidth);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  return {
    panelWidth,
    panelMinWidth: effectiveMin,
    panelMaxWidth,
    separatorRef,
    separatorWidth: measuredWidth ?? panelWidth,
    onSeparatorKeyDown,
    onResizeStart,
    onResizeMove,
    onResizeEnd,
    onDoubleClick,
    resetToPreset,
  };
}
