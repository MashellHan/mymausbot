import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { t } from "@/lib/i18n";
import { SITE_FRAME_ALLOW } from "@/lib/published-apps";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { MiniAppFrame } from "./MiniAppFrame";
import { DAILY_X_FRAME_NAME, DAILY_X_URL, dailyXPageAllowed } from "./daily-x-host";

const READY_TIMEOUT_MS = 10_000;
const DAILY_X_ORIGIN = new URL(DAILY_X_URL).origin;
const DAILY_X_SANDBOX = "allow-scripts allow-same-origin allow-popups";
type Phase = "loading" | "ready" | "failed";
const views = ["web", "saved"] as const;
type View = typeof views[number];

export function DailyXWholePage({ document, state, onRevoked }: {
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
}) {
  const tabId = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("web");
  const frame = useRef<HTMLIFrameElement>(null);
  const challenge = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");

  const beginHandshake = useCallback(() => {
    const nonce = window.crypto.randomUUID();
    challenge.current = nonce;
    setNavigation((value) => value + 1);
    setPhase("loading");
    frame.current?.contentWindow?.postMessage({ xreport: 1, type: "challenge", nonce }, DAILY_X_ORIGIN);
  }, []);

  useEffect(() => {
    if (view !== "web" || phase !== "loading") return;
    const timer = setTimeout(() => setPhase("failed"), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [view, phase, attempt, navigation]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== DAILY_X_ORIGIN || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.xreport !== 1
        || !["ready", "leaving", "shown"].includes(message.type) || typeof message.path !== "string") return;
      if (!dailyXPageAllowed(`${DAILY_X_ORIGIN}${message.path}`)) { challenge.current = null; return setPhase("failed"); }
      if (message.type === "ready") {
        if (challenge.current === null || message.nonce !== challenge.current) return;
        challenge.current = null;
        setPhase("ready");
      } else if (message.type === "shown") beginHandshake();
      else {
        challenge.current = null;
        setNavigation((value) => value + 1);
        setPhase("loading");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [beginHandshake]);

  const retry = () => {
    challenge.current = null;
    setAttempt((value) => value + 1);
    setPhase("loading");
  };
  const choose = (next: View) => {
    if (next === "saved") {
      challenge.current = null;
      if (phase === "ready") setPhase("loading");
    }
    setView(next);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-daily-x-tab="${next}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === "ArrowRight" || event.key === "End" ? "saved"
      : event.key === "ArrowLeft" || event.key === "Home" ? "web" : null;
    if (!next) return;
    event.preventDefault();
    choose(next);
  };
  const hosted = phase === "failed" ? <div role="alert" className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="daily-x-failed">
    <p className="text-[14px] font-medium text-ink">{t("webPanels.page.pageGone")}</p>
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" className="ui-button ui-button-primary" onClick={retry}>{t("webPanels.page.reload")}</button>
      <button type="button" className="ui-button" onClick={() => choose("saved")}>{t("computer.miniApps.report.open")}</button>
    </div>
  </div> : <div className="relative min-h-0 min-w-0 flex-1 bg-panel" data-testid="daily-x-web">
    <iframe key={attempt} ref={frame} data-daily-x-frame="" src={DAILY_X_URL} name={DAILY_X_FRAME_NAME}
      title={t("computer.miniApps.report.xTitle")} sandbox={DAILY_X_SANDBOX} allow={SITE_FRAME_ALLOW}
      referrerPolicy="no-referrer" onLoad={beginHandshake} onError={() => { challenge.current = null; setPhase("failed"); }}
      className="absolute inset-0 h-full w-full border-0 bg-white" />
    {phase === "loading" && <div role="status" className="absolute inset-0 flex items-center justify-center bg-panel p-6 text-[13px] text-ink-secondary">
      {t("computer.miniApps.opening")}
    </div>}
  </div>;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="daily-x-whole-page">
    <div ref={tabs} role="tablist" aria-label={t("computer.miniApps.report.xTitle")} onKeyDown={onKeyDown}
      className="flex shrink-0 gap-1 border-b border-hairline px-4">
      {views.map((name) => <button key={name} id={`${tabId}-tab-${name}`} type="button"
        role="tab" data-daily-x-tab={name} aria-selected={view === name} aria-controls={`${tabId}-panel-${name}`}
        tabIndex={view === name ? 0 : -1} onClick={() => choose(name)}
        className={`min-h-10 border-b-2 px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${view === name
          ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"}`}>
        {t(name === "web" ? "computer.miniApps.report.webReport" : "computer.miniApps.report.savedEditions")}
      </button>)}
    </div>
    {views.map((name) => <section key={name} id={`${tabId}-panel-${name}`} role="tabpanel" aria-labelledby={`${tabId}-tab-${name}`} tabIndex={0}
      hidden={view !== name} inert={view !== name}
      className={`${view === name ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent`}>
      {view === name && (name === "web" ? hosted : <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="daily-x-saved">
        <MiniAppFrame document={document} state={state} onRevoked={onRevoked} />
      </div>)}
    </section>)}
  </div>;
}
