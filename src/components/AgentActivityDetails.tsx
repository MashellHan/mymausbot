import { ChevronRight } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { LocalAgentActivityEvent, LocalAgentActivityResponse } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";
import { cn } from "@/lib/cn";

const REFRESH_MS = 2_000;
const unavailable = (agentId: string): LocalAgentActivityResponse => ({ agentId, status: "unavailable", updatedAt: null, truncated: false, events: [] });
const kindLabel = {
  user: "computer.agentTeam.activity.user",
  assistant: "computer.agentTeam.activity.assistant",
  "tool-call": "computer.agentTeam.activity.toolCall",
  "tool-result": "computer.agentTeam.activity.toolResult",
} as const;

type ScrollAnchor = { bottom: true } | { bottom: false; id: string | null; offset: number; top: number };

export function AgentActivityDetails({ agentId, active = true }: { agentId: string; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<LocalAgentActivityResponse | null>(null);
  const [authLost, setAuthLost] = useState(false);
  const pageVisible = usePageVisible();
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const anchor = useRef<ScrollAnchor | null>(null);

  useEffect(() => { setOpen(false); setSnapshot(null); setAuthLost(false); }, [agentId]);
  useEffect(() => { if (!active) { setOpen(false); setSnapshot(null); setAuthLost(false); } }, [active]);

  const rememberScroll = () => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight <= 24) { anchor.current = { bottom: true }; return; }
    const first = [...list.children].find((item) => item.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    anchor.current = { bottom: false, id: first instanceof HTMLElement ? first.dataset.eventId ?? null : null,
      offset: first ? first.getBoundingClientRect().top - list.getBoundingClientRect().top : 0, top: list.scrollTop };
  };

  useLayoutEffect(() => {
    const list = listRef.current, saved = anchor.current;
    if (!list || !saved) return;
    if (saved.bottom) list.scrollTop = list.scrollHeight;
    else {
      const item = [...list.children].find((child) => child instanceof HTMLElement && child.dataset.eventId === saved.id);
      list.scrollTop = item ? list.scrollTop + item.getBoundingClientRect().top - list.getBoundingClientRect().top - saved.offset : saved.top;
    }
    anchor.current = null;
  }, [snapshot]);

  useEffect(() => {
    if (!open || !active || !pageVisible || authLost) return;
    let mounted = true, stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller = new AbortController();
      try {
        const next = await api<LocalAgentActivityResponse>(`/api/local-dashboard/agents/${encodeURIComponent(agentId)}/activity`,
          { background: true, signal: controller.signal, timeoutMs: 5_000 });
        if (!mounted) return;
        if (next.agentId !== agentId) { stopped = true; setSnapshot(unavailable(agentId)); return; }
        rememberScroll();
        setSnapshot(next);
      } catch (error) {
        if (!mounted || controller.signal.aborted) return;
        rememberScroll();
        setSnapshot(unavailable(agentId));
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) { stopped = true; setAuthLost(true); }
      } finally {
        if (mounted && !stopped) timer = setTimeout(refresh, REFRESH_MS);
      }
    };
    void refresh();
    return () => { mounted = false; controller?.abort(); clearTimeout(timer); };
  }, [agentId, open, active, pageVisible, authLost]);

  const toggle = () => {
    setOpen((value) => !value);
    setSnapshot(null);
    setAuthLost(false);
    anchor.current = null;
  };
  const time = (at: number | null) => at === null ? t("computer.agentTeam.activity.timeUnavailable")
    : new Date(at).toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit" });
  const asOf = snapshot?.updatedAt == null ? null : new Date(snapshot.updatedAt).toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const state = snapshot === null ? t("computer.agentTeam.activity.loading")
    : snapshot.status === "ready" ? t("computer.agentTeam.activity.source")
      : snapshot.status === "stale" ? t("computer.agentTeam.activity.stale")
        : t(snapshot.status === "unsupported" ? "computer.agentTeam.activity.unsupported" : "computer.agentTeam.activity.unavailable");

  return (
    <div className="mt-2 min-w-0" data-testid={`agent-activity-${agentId}`}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={toggle}
        className="inline-flex items-center gap-1 rounded-md py-1 text-[11px] font-medium text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/60">
        <ChevronRight size={13} className={cn("transition-transform", open && "rotate-90")} aria-hidden="true" />
        {t("computer.agentTeam.activity.toggle")}
      </button>
      <div id={id} hidden={!open} className="mt-1 rounded-lg border border-hairline/60 bg-inset/40 p-2.5">
        {open && <>
          <div className="flex flex-wrap items-baseline gap-x-1.5 text-[11px]">
            <p role="status" className={snapshot?.status === "stale" ? "text-warning" : "text-ink-tertiary"}>{state}</p>
            {asOf && snapshot?.updatedAt != null && <time aria-live="off" data-testid="agent-activity-as-of" className="text-ink-tertiary" dateTime={new Date(snapshot.updatedAt).toISOString()}>
              {t(snapshot?.status === "stale" ? "computer.agentTeam.activity.lastObserved" : "computer.agentTeam.activity.asOf", { time: asOf })}
            </time>}
          </div>
          {snapshot?.status === "ready" || snapshot?.status === "stale" ? <>
            {snapshot.truncated && <p className="mt-1 text-[11px] text-ink-tertiary">{t("computer.agentTeam.activity.truncated")}</p>}
            {snapshot.events.length ? <ol ref={listRef} role="region" tabIndex={0} aria-label={t("computer.agentTeam.activity.list")}
              className="mt-2 max-h-56 space-y-2 overflow-y-auto overscroll-contain pr-1 outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
              {snapshot.events.map((event: LocalAgentActivityEvent) => <li key={event.id} data-event-id={event.id} className="rounded-md bg-card px-2 py-1.5 text-[11px]">
                <div className="flex flex-wrap items-baseline gap-x-1.5 text-ink-tertiary">
                  <span className="font-medium text-ink-secondary">{t(kindLabel[event.kind])}</span>
                  {event.tool && <span dir="auto" className="min-w-0 [overflow-wrap:anywhere]">{event.tool}</span>}
                  <time className="ml-auto tabular-nums" dateTime={event.at === null ? undefined : new Date(event.at).toISOString()}>{time(event.at)}</time>
                </div>
                {event.text ? <p dir="auto" className="mt-0.5 min-w-0 whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{event.text}</p>
                  : <p className="mt-0.5 text-ink-tertiary">{t("computer.agentTeam.activity.textUnavailable")}</p>}
              </li>)}
            </ol> : <p className="mt-2 text-[11px] text-ink-tertiary">{t("computer.agentTeam.activity.empty")}</p>}
          </> : null}
        </>}
      </div>
    </div>
  );
}
