import { useEffect, useState } from "react";
import { CloudOff, Loader2 } from "lucide-react";
import { cloudAsleep, onCloudPower } from "@/lib/cloud-power";
import { t } from "@/lib/i18n";
import { retryLiveEvents } from "@/lib/live-events";
import { useMacOffline } from "@/lib/pwa-connection";
import { noteRefusedRequest } from "@/lib/session-ended";
import {
  discardPriorSessionOutbox,
  importPriorSessionOutbox,
  retryAllOutboxSends,
  useOutboxSummary,
} from "@/state/pwa-outbox";

export const RECONNECTING_AFTER_MS = 4_000;
export const CONNECTION_HELP_AFTER_MS = 20_000;

/** The live stream is down: replies and other people's messages wait until it is back. A blip shorter than a few
 * seconds says nothing; a Cloud asleep has its own strip. */
export function LiveConnectionStrip({ connected, hydrated, cachedHydrated = false }: { connected: boolean; hydrated: boolean; cachedHydrated?: boolean }) {
  const [late, setLate] = useState(false);
  const [help, setHelp] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [asleep, setAsleep] = useState(cloudAsleep);
  const macOffline = useMacOffline();
  const outbox = useOutboxSummary();
  useEffect(() => onCloudPower(setAsleep), []);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    setLate(false);
    setHelp(false);
    if (connected || asleep || !online) return;
    // The stream is a browser EventSource, so a refused handshake looks like any other drop. Ask the session endpoint
    // once it is late: an ended sign-in then shows the pairing page instead of "Connecting…" forever. Neither a sleeping
    // Cloud nor an offline device is woken just to ask.
    const probe = setTimeout(() => noteRefusedRequest(), RECONNECTING_AFTER_MS);
    const timer = setTimeout(() => setLate(true), RECONNECTING_AFTER_MS);
    const helpTimer = setTimeout(() => { setHelp(true); noteRefusedRequest(); }, CONNECTION_HELP_AFTER_MS);
    return () => { clearTimeout(probe); clearTimeout(timer); clearTimeout(helpTimer); };
  }, [connected, asleep, online]);
  if (asleep) return null;
  const notice = !online
    ? "offline"
    : macOffline && !connected
      ? "mac-offline"
      : !connected && late && (hydrated || help)
        ? "reconnecting"
        : !connected && cachedHydrated
          ? "connecting"
          : null;
  const hasOutboxActions = outbox.failedCount > 0 || outbox.priorSessionCount > 0;
  if (!notice && !hasOutboxActions) return null;
  const messageKey =
    notice === "offline"
      ? "liveConnection.offline"
      : notice === "mac-offline"
        ? "liveConnection.macOffline"
        : notice === "connecting"
          ? "liveConnection.connecting"
          : help
            ? "liveConnection.help"
            : "liveConnection.reconnecting";
  const actionPill = "inline-flex min-h-8 touch:min-h-10 shrink-0 items-center rounded-full border border-hairline bg-card px-3 text-[12px] font-medium text-ink transition-colors hover:bg-raised active:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2";
  return <div role="status" data-live-connection={notice ?? "outbox"} className="flex flex-wrap items-center justify-center gap-2 border-b border-hairline/50 bg-panel/95 px-3 py-2 text-[13px] text-ink-secondary tabular-nums">
    {notice && (
      <>
        {notice === "offline" || notice === "mac-offline" ? <CloudOff size={14} className="shrink-0 text-ink-tertiary" aria-hidden="true" /> : <Loader2 size={14} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        <span>{t(messageKey)}</span>
        {(notice === "reconnecting" || notice === "mac-offline") && help && <button type="button" onClick={retryLiveEvents} className={actionPill}>
          {t("liveConnection.retry")}
        </button>}
      </>
    )}
    {outbox.failedCount > 0 && (
      <button
        type="button"
        data-outbox-retry-all
        onClick={() => void retryAllOutboxSends()}
        className={actionPill}
      >
        {t("liveConnection.retryAll", { count: outbox.failedCount })}
      </button>
    )}
    {outbox.priorSessionCount > 0 && (
      <span data-outbox-prior-session className="flex flex-wrap items-center gap-2">
        <span>{t("liveConnection.priorOutbox", { count: outbox.priorSessionCount })}</span>
        <button
          type="button"
          data-outbox-import-prior
          onClick={() => void importPriorSessionOutbox()}
          className={actionPill}
        >
          {t("liveConnection.importAndResend")}
        </button>
        <button
          type="button"
          data-outbox-discard-prior
          onClick={() => void discardPriorSessionOutbox()}
          className="inline-flex min-h-8 touch:min-h-10 shrink-0 items-center rounded-full px-2.5 text-[12px] text-ink-tertiary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t("chat.outbox.discard")}
        </button>
      </span>
    )}
  </div>;
}
