import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 960;
const PANEL_RESIZE_STEP = 40;

export function useComputerPanelResize() {
  const [panelWidth, setPanelWidth] = useState(PANEL_MAX_WIDTH);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta)));
  };
  const separatorRef = useRef<HTMLDivElement>(null);
  const [separatorWidth, setSeparatorWidth] = useState<number | null>(null);
  useEffect(() => {
    const panel = separatorRef.current?.closest("aside");
    if (!panel) return;
    const read = () => setSeparatorWidth(panel.offsetWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const onSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const widen = event.key === "ArrowLeft" ? PANEL_RESIZE_STEP : event.key === "ArrowRight" ? -PANEL_RESIZE_STEP : null;
    if (widen === null || separatorWidth === null) return;
    event.preventDefault();
    onResizeBy(widen);
  };
  return { panelWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd };
}
