import { useEffect } from "react";

export const KEYBOARD_INSET_THRESHOLD_PX = 96;

export interface ViewportMetricInput {
  layoutHeight: number;
  visualHeight: number;
  offsetTop?: number;
}

export interface ViewportMetrics {
  visualHeight: number;
  keyboardInset: number;
  keyboardOpen: boolean;
  offsetTop: number;
}

export function computeViewportMetrics(input: ViewportMetricInput): ViewportMetrics {
  const layoutHeight = Math.max(0, Math.round(input.layoutHeight));
  const visualHeight = Math.max(0, Math.round(input.visualHeight));
  const offsetTop = Math.max(0, Math.round(input.offsetTop ?? 0));
  const keyboardInset = Math.max(0, layoutHeight - visualHeight - offsetTop);
  return {
    visualHeight,
    keyboardInset,
    keyboardOpen: keyboardInset > KEYBOARD_INSET_THRESHOLD_PX,
    offsetTop,
  };
}

export function applyViewportMetricsToRoot(root: HTMLElement, metrics: ViewportMetrics): void {
  if (metrics.visualHeight > 0) {
    root.style.setProperty("--omb-vvh", `${metrics.visualHeight}px`);
  }
  root.style.setProperty("--omb-kb-inset", `${metrics.keyboardInset}px`);
  if (metrics.keyboardOpen) {
    root.dataset.kbOpen = "true";
  } else {
    delete root.dataset.kbOpen;
  }
}

/**
 * Publishes `--omb-vvh`, `--omb-kb-inset`, and `data-kb-open` on `<html>` so standalone iOS/Android
 * PWAs collapse resting home-indicator padding cleanly while the virtual keyboard is open and avoid
 * stray viewport drift when Safari shifts `visualViewport.offsetTop`.
 */
export function usePwaViewportVars(): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    let rafId: number | null = null;

    const sync = () => {
      rafId = null;
      const metrics = computeViewportMetrics({
        layoutHeight: window.innerHeight || root.clientHeight,
        visualHeight: vv.height,
        offsetTop: vv.offsetTop,
      });
      applyViewportMetricsToRoot(root, metrics);
      if (metrics.keyboardOpen && metrics.offsetTop > 0 && window.scrollY > 0) {
        window.scrollTo(0, 0);
      }
    };

    const schedule = () => {
      if (rafId !== null) return;
      rafId = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(sync)
        : (setTimeout(sync, 0) as unknown as number);
    };

    sync();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("orientationchange", schedule);

    return () => {
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("orientationchange", schedule);
      root.style.removeProperty("--omb-vvh");
      root.style.removeProperty("--omb-kb-inset");
      delete root.dataset.kbOpen;
    };
  }, []);
}
