import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { t } from "@/lib/i18n";
import { SITE_FRAME_ALLOW } from "@/lib/published-apps";
import type { MiniAppDocument, MiniAppState } from "../../../shared/mini-apps";
import { MiniAppFrame } from "./MiniAppFrame";
import { GITHUB_ACTIVITY_FRAME_NAME, GITHUB_ACTIVITY_URL, githubWebUrlForSelection,
  selectionFromGithubPath, type GithubActivitySelection } from "./github-activity-host";

const READY_TIMEOUT_MS = 10_000;
const GITHUB_ACTIVITY_ORIGIN = new URL(GITHUB_ACTIVITY_URL).origin;
const GITHUB_ACTIVITY_SANDBOX = "allow-scripts allow-same-origin allow-popups";
type Phase = "loading" | "ready" | "failed";
const views = ["web", "saved"] as const;
type View = typeof views[number];

export function GitHubActivityWholePage({ document, state, onRevoked }: {
  document: MiniAppDocument;
  state: MiniAppState;
  onRevoked(): void;
}) {
  const tabId = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("web");
  const [selection, setSelection] = useState<GithubActivitySelection | null>(null);
  const [webUrl, setWebUrl] = useState(GITHUB_ACTIVITY_URL);
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
    frame.current?.contentWindow?.postMessage({ githubDeepDive: 1, type: "challenge", nonce }, GITHUB_ACTIVITY_ORIGIN);
  }, []);

  useEffect(() => {
    if (view !== "web" || phase !== "loading") return;
    const timer = setTimeout(() => setPhase("failed"), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [view, phase, attempt, navigation]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== GITHUB_ACTIVITY_ORIGIN || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.githubDeepDive !== 1
        || !["ready", "leaving", "shown"].includes(message.type) || typeof message.path !== "string") return;
      const parsed = selectionFromGithubPath(message.path, message.editionKey, message.repo, message.type);
      if (!parsed.ok) {
        challenge.current = null;
        return setPhase("failed");
      }
      if (message.type === "ready") {
        if (challenge.current === null || message.nonce !== challenge.current) return;
        challenge.current = null;
        setSelection(parsed.selection);
        setPhase("ready");
      } else if (message.type === "shown") {
        setSelection(parsed.selection);
        beginHandshake();
      } else {
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
    setWebUrl(githubWebUrlForSelection(selection));
    setAttempt((value) => value + 1);
    setPhase("loading");
  };
  const choose = (next: View) => {
    if (next === "saved") {
      challenge.current = null;
      if (phase === "ready") setPhase("loading");
    } else if (view !== "web") {
      setWebUrl(githubWebUrlForSelection(selection));
      if (phase !== "failed") setPhase("loading");
    }
    setView(next);
    tabs.current?.querySelector<HTMLButtonElement>(`[data-github-activity-tab="${next}"]`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === "ArrowRight" || event.key === "End" ? "saved"
      : event.key === "ArrowLeft" || event.key === "Home" ? "web" : null;
    if (!next) return;
    event.preventDefault();
    choose(next);
  };
  const hosted = phase === "failed" ? <div role="alert" className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="github-activity-failed">
    <p className="text-[14px] font-medium text-ink">{t("webPanels.page.pageGone")}</p>
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" className="ui-button ui-button-primary" onClick={retry}>{t("webPanels.page.reload")}</button>
      <button type="button" className="ui-button" onClick={() => choose("saved")}>{t("computer.miniApps.report.githubOpenNative")}</button>
    </div>
  </div> : <div className="relative min-h-0 min-w-0 flex-1 bg-panel" data-testid="github-activity-web">
    <iframe key={attempt} ref={frame} data-github-activity-frame="" src={webUrl} name={GITHUB_ACTIVITY_FRAME_NAME}
      title={t("computer.miniApps.report.githubTitle")} sandbox={GITHUB_ACTIVITY_SANDBOX} allow={SITE_FRAME_ALLOW}
      referrerPolicy="no-referrer" onLoad={beginHandshake} onError={() => { challenge.current = null; setPhase("failed"); }}
      className="absolute inset-0 h-full w-full border-0 bg-white" />
    {phase === "loading" && <div role="status" className="absolute inset-0 flex items-center justify-center bg-panel p-6 text-[13px] text-ink-secondary">
      {t("computer.miniApps.opening")}
    </div>}
  </div>;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="github-activity-whole-page">
    <div ref={tabs} role="tablist" aria-label={t("computer.miniApps.report.githubTitle")} onKeyDown={onKeyDown}
      className="flex shrink-0 gap-1 border-b border-hairline px-4">
      {views.map((name) => <button key={name} id={`${tabId}-tab-${name}`} type="button"
        role="tab" data-github-activity-tab={name} aria-selected={view === name} aria-controls={`${tabId}-panel-${name}`}
        tabIndex={view === name ? 0 : -1} onClick={() => choose(name)}
        className={`min-h-10 border-b-2 px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${view === name
          ? "border-accent text-ink" : "border-transparent text-ink-secondary hover:bg-ink/[0.06] hover:text-ink"}`}>
        {t(name === "web" ? "computer.miniApps.report.githubWeb" : "computer.miniApps.report.githubNative")}
      </button>)}
    </div>
    {views.map((name) => <section key={name} id={`${tabId}-panel-${name}`} role="tabpanel" aria-labelledby={`${tabId}-tab-${name}`} tabIndex={0}
      hidden={view !== name} inert={view !== name}
      className={`${view === name ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent`}>
      {view === name && (name === "web" ? hosted : <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="github-activity-saved">
        <MiniAppFrame document={document} state={state} onRevoked={onRevoked}
          githubSelection={selection} onGithubSelectionChange={setSelection} />
      </div>)}
    </section>)}
  </div>;
}
