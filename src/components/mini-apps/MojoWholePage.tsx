import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { t } from "@/lib/i18n";
import { SITE_THUMB_SANDBOX } from "@/lib/published-apps";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { SiteFrame } from "../published-apps/SiteFrame";
import { MiniAppFrame } from "./MiniAppFrame";
import { MOJO_POETRY_FRAME_NAME, MOJO_POETRY_URL } from "./mojo-host";

type View = "quotes" | "poetry";
type Gesture = { pointerId: number; x: number; y: number };

export function MojoWholePage({ document, state, onRevoked }: {
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
}) {
  const [view, setView] = useState<View>("quotes");
  const [poetryOpened, setPoetryOpened] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const suppressClickUntil = useRef(0);
  const tabs = useRef<HTMLDivElement>(null);
  const choose = (next: View) => {
    if (next === "poetry") setPoetryOpened(true);
    setView(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === "ArrowRight" || event.key === "End" ? "poetry"
      : event.key === "ArrowLeft" || event.key === "Home" ? "quotes" : null;
    if (!next) return;
    event.preventDefault();
    choose(next);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-mojo-tab="${next}"]`)?.focus();
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    suppressClickUntil.current = 0;
    gesture.current = event.pointerType === "touch" && event.isPrimary
      ? { pointerId: event.pointerId, x: event.clientX, y: event.clientY } : null;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    if (start?.pointerId === event.pointerId && Math.abs(event.clientY - start.y) > 24
      && Math.abs(event.clientY - start.y) > Math.abs(event.clientX - start.x)) gesture.current = null;
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = gesture.current;
    gesture.current = null;
    if (!start || start.pointerId !== event.pointerId || !event.isPrimary) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    suppressClickUntil.current = performance.now() + 500;
    choose(dx < 0 ? "poetry" : "quotes");
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.detail === 0 || performance.now() > suppressClickUntil.current) return;
    suppressClickUntil.current = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="mojo-whole-page">
    <div ref={tabs} role="tablist" aria-label={t("computer.miniApps.mojo.views")} onKeyDown={onKeyDown}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={() => { gesture.current = null; }} onClickCapture={onClickCapture}
      className="flex shrink-0 touch-pan-y gap-1 border-b border-hairline px-4" data-mojo-navigation="">
      {(["quotes", "poetry"] as const).map((name) => <button key={name} id={`mojo-tab-${name}`} type="button"
        role="tab" data-mojo-tab={name} aria-selected={view === name} aria-controls={`mojo-panel-${name}`}
        tabIndex={view === name ? 0 : -1} onClick={() => choose(name)}
        className={`min-h-10 border-b-2 px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${view === name
          ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"}`}>
        {t(`computer.miniApps.mojo.${name}`)}
      </button>)}
    </div>
    <section id="mojo-panel-quotes" role="tabpanel" aria-labelledby="mojo-tab-quotes" tabIndex={0}
      hidden={view !== "quotes"} inert={view !== "quotes"}
      className={`${view === "quotes" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent`}>
      <MiniAppFrame document={document} state={state} onRevoked={onRevoked} />
    </section>
    <section id="mojo-panel-poetry" role="tabpanel" aria-labelledby="mojo-tab-poetry" tabIndex={0}
      hidden={view !== "poetry"} inert={view !== "poetry"}
      className={`${view === "poetry" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent`}>
      {poetryOpened && <SiteFrame url={MOJO_POETRY_URL} title={t("computer.miniApps.mojo.poetry")}
        attempt={0} sandbox={SITE_THUMB_SANDBOX} frameName={MOJO_POETRY_FRAME_NAME} />}
    </section>
  </div>;
}
