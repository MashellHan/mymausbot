import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

import { t } from "@/lib/i18n";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export function clampMermaidZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

export function MermaidLightbox({
  svg,
  onClose,
}: {
  svg: string;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);

  useLayoutEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((z) => clampMermaidZoom(z + ZOOM_STEP));
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom((z) => clampMermaidZoom(z - ZOOM_STEP));
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, []);

  const content = (
    <div
      data-testid="mermaid-lightbox"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("chat.mermaid.title")}
        tabIndex={-1}
        className="animate-pop-in flex h-full max-h-[92vh] w-full max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-hairline/40 bg-panel shadow-2xl outline-none"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline/40 bg-raised/60 px-4 py-2.5">
          <span className="truncate text-[13px] font-medium text-ink">
            {t("chat.mermaid.title")}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setZoom((z) => clampMermaidZoom(z - ZOOM_STEP))}
              disabled={zoom <= MIN_ZOOM}
              aria-label={t("canvas.zoomOut")}
              title={t("canvas.zoomOut")}
              className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              <ZoomOut size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              aria-label="100%"
              title="100%"
              className="min-w-[46px] rounded-lg px-2 py-1 text-center text-[12px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => clampMermaidZoom(z + ZOOM_STEP))}
              disabled={zoom >= MAX_ZOOM}
              aria-label={t("canvas.zoomIn")}
              title={t("canvas.zoomIn")}
              className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
            >
              <ZoomIn size={16} aria-hidden="true" />
            </button>
            {zoom !== 1 && (
              <button
                type="button"
                onClick={() => setZoom(1)}
                aria-label="Reset zoom"
                title="Reset zoom"
                className="flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
              >
                <RotateCcw size={15} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              title={t("common.close")}
              className="ms-1 flex size-8 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-inset p-6"
          onWheel={(event) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            setZoom((z) => clampMermaidZoom(z + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
          }}
        >
          <div
            data-testid="mermaid-lightbox-svg"
            style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}
            className="transition-transform duration-100 [&_svg]:h-auto [&_svg]:max-w-none"
            // Security: svg is produced exclusively by mermaid.render() under securityLevel "strict".
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(content, document.body) : null;
}

export function MermaidExpandIcon() {
  return <Maximize2 size={14} aria-hidden="true" />;
}
