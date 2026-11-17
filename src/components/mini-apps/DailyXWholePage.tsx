import { useEffect, useRef, useState } from "react";

import { t } from "@/lib/i18n";
import { SITE_FRAME_ALLOW } from "@/lib/published-apps";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { MiniAppFrame } from "./MiniAppFrame";
import { DAILY_X_FRAME_NAME, DAILY_X_URL, dailyXPageAllowed } from "./daily-x-host";

const READY_TIMEOUT_MS = 10_000;
const DAILY_X_ORIGIN = new URL(DAILY_X_URL).origin;
const DAILY_X_SANDBOX = "allow-scripts allow-same-origin allow-popups";
type Phase = "loading" | "ready" | "failed" | "saved";

export function DailyXWholePage({ document, state, onRevoked }: {
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const [phase, setPhase] = useState<Phase>("loading");

  useEffect(() => {
    if (phase !== "loading") return;
    const timer = setTimeout(() => setPhase("failed"), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase, attempt, navigation]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== DAILY_X_ORIGIN || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.xreport !== 1
        || (message.type !== "ready" && message.type !== "leaving") || typeof message.path !== "string") return;
      if (!dailyXPageAllowed(`${DAILY_X_ORIGIN}${message.path}`)) return setPhase("failed");
      if (message.type === "ready") setPhase("ready");
      else {
        setNavigation((value) => value + 1);
        setPhase("loading");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const retry = () => {
    setAttempt((value) => value + 1);
    setPhase("loading");
  };
  if (phase === "saved") return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="daily-x-saved">
    <button type="button" className="ui-button self-start m-3" onClick={retry}>{t("webPanels.page.reload")}</button>
    <MiniAppFrame document={document} state={state} onRevoked={onRevoked} />
  </div>;
  if (phase === "failed") return <div role="alert" className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="daily-x-failed">
    <p className="text-[14px] font-medium text-ink">{t("webPanels.page.pageGone")}</p>
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" className="ui-button ui-button-primary" onClick={retry}>{t("webPanels.page.reload")}</button>
      <button type="button" className="ui-button" onClick={() => setPhase("saved")}>{t("computer.miniApps.report.open")}</button>
    </div>
  </div>;

  return <div className="relative min-h-0 min-w-0 flex-1 bg-panel" data-testid="daily-x-web">
    <iframe key={attempt} ref={frame} data-daily-x-frame="" src={DAILY_X_URL} name={DAILY_X_FRAME_NAME}
      title={t("computer.miniApps.report.xTitle")} sandbox={DAILY_X_SANDBOX} allow={SITE_FRAME_ALLOW}
      referrerPolicy="no-referrer" onError={() => setPhase("failed")}
      className="absolute inset-0 h-full w-full border-0 bg-white" />
    {phase === "loading" && <div role="status" className="absolute inset-0 flex items-center justify-center bg-panel p-6 text-[13px] text-ink-secondary">
      {t("computer.miniApps.opening")}
    </div>}
  </div>;
}
