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
  return <div role="status" data-live-connection={notice ?? "outbox"} className="flex flex-wrap items-center justify-center gap-2 border-b border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
    {notice && (
      <>
        {notice === "offline" || notice === "mac-offline" ? <CloudOff size={14} className="shrink-0" aria-hidden="true" /> : <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden="true" />}
        <span>{t(messageKey)}</span>
        {(notice === "reconnecting" || notice === "mac-offline") && help && <button type="button" onClick={retryLiveEvents} className="shrink-0 rounded px-2 py-1 text-ink underline underline-offset-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2">
          {t("liveConnection.retry")}
        </button>}
      </>
    )}
    {outbox.failedCount > 0 && (
      <button
        type="button"
        data-outbox-retry-all
        onClick={() => void retryAllOutboxSends()}
        className="shrink-0 rounded px-2 py-1 text-ink underline underline-offset-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2"
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
          className="shrink-0 rounded px-2 py-1 text-ink underline underline-offset-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t("liveConnection.importAndResend")}
        </button>
        <button
          type="button"
          data-outbox-discard-prior
          onClick={() => void discardPriorSessionOutbox()}
          className="shrink-0 rounded px-2 py-1 text-ink-tertiary underline underline-offset-2 hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {t("chat.outbox.discard")}
        </button>
      </span>
    )}
  </div>;
}
