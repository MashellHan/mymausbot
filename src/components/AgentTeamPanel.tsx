import { ChevronRight, UserRound } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { LocalAgentMember, LocalAgentTeamsResponse } from "../../shared/local-dashboard";
import { t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";
import { cn } from "@/lib/cn";

const ROUTE = "/api/local-dashboard/agents";
const REFRESH_MS = 5_000;
const unavailable: LocalAgentTeamsResponse = { status: "unavailable", updatedAt: null, teamCount: null, teams: [] };

const stateLabel = {
  working: "computer.agentTeam.state.working",
  blocked: "computer.agentTeam.state.blocked",
  idle: "computer.agentTeam.state.idle",
  done: "computer.agentTeam.state.done",
  unknown: "computer.agentTeam.state.unknown",
} as const;

const stateDot = {
  working: "bg-success",
  blocked: "bg-warning",
  idle: "bg-ink-secondary/60",
  done: "bg-accent",
  unknown: "bg-ink-secondary/30",
} as const;

function memberRow(member: LocalAgentMember, stale: boolean) {
  return (
    <li key={member.id} className="flex min-w-0 gap-2.5 border-t border-hairline/40 py-3 first:border-t-0">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-inset text-ink-secondary" aria-hidden="true"><UserRound size={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
          <span dir="auto" className="min-w-0 text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{member.name}</span>
          <span className="text-[11px] text-ink-tertiary">{member.role ?? t("computer.agentTeam.roleUnavailable")}</span>
        </div>
        <div className="mt-1 text-[11px] text-ink-secondary">
          <span className="inline-flex items-center gap-1.5"><span className={cn("size-1.5 shrink-0 rounded-full", stale ? "bg-ink-secondary/30" : stateDot[member.state])} aria-hidden="true" />{stale ? t("computer.agentTeam.lastObserved", { state: t(stateLabel[member.state]) }) : t(stateLabel[member.state])}</span>
        </div>
        <div dir="auto" className="mt-0.5 min-w-0 text-[11px] text-ink-secondary [overflow-wrap:anywhere]">
          {member.model ? <>{t("computer.agentTeam.modelLabel")} · {member.model}</> : t("computer.agentTeam.modelUnavailable")}
        </div>
        <p dir="auto" className="mt-1.5 line-clamp-2 text-[12px] leading-4 text-ink-tertiary [overflow-wrap:anywhere]">
          <span className="sr-only">{t("computer.agentTeam.latestTask")}: </span>{member.taskHint ?? t("computer.agentTeam.taskUnavailable")}
        </p>
      </div>
    </li>
  );
}

export function AgentTeamView({ snapshot }: { snapshot: LocalAgentTeamsResponse | null }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const baseId = useId();
  const count = snapshot?.teamCount ?? t("computer.agentTeam.unknownCount");
  const readAt = snapshot?.updatedAt === null || snapshot?.updatedAt === undefined
    ? null : new Date(snapshot.updatedAt).toLocaleString();
  const stale = snapshot?.status === "stale";

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-5" data-testid="agent-team-panel">
      <header className="mb-4 pt-2">
        <h2 className="text-[15px] font-semibold text-ink">{t("computer.agentTeam.heading", { count })}</h2>
        <p className="mt-1 text-[11px] text-ink-tertiary">{readAt ? t("computer.agentTeam.readAt", { time: readAt }) : t("computer.agentTeam.neverRead")}</p>
      </header>
      {snapshot === null ? <p role="status" className="text-[12px] text-ink-secondary">{t("computer.agentTeam.loading")}</p> : null}
      {stale ? <p role="status" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.agentTeam.stale")}</p> : null}
      {snapshot?.status === "unavailable" ? <p role="status" className="rounded-lg bg-inset px-3 py-3 text-[12px] text-ink-secondary">{t("computer.agentTeam.unavailable")}</p> : null}
      {snapshot?.teamCount === 0 && snapshot.teams.length === 0 ? <p className="rounded-lg bg-inset px-3 py-3 text-[12px] text-ink-secondary">{t("computer.agentTeam.empty")}</p> : null}
      <div className="space-y-2">
        {snapshot?.teams.map((team) => {
          const open = expanded.has(team.id);
          const id = `${baseId}-${encodeURIComponent(team.id)}`;
          return (
            <section key={team.id} className="min-w-0 rounded-xl border border-hairline/60 bg-card">
              <h3>
                <button type="button" aria-expanded={open} aria-controls={id} onClick={() => toggle(team.id)}
                  className="flex w-full min-w-0 items-center gap-2 rounded-xl px-3 py-3 text-left outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
                  <ChevronRight size={15} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-90")} aria-hidden="true" />
                  <span dir="auto" className="min-w-0 flex-1 text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{team.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-secondary">{t("computer.agentTeam.agentCount", { count: team.agentCount })}</span>
                </button>
              </h3>
              <div id={id} hidden={!open} className="px-3 pb-1">
                {team.agents.length ? <ul>{team.agents.map((member) => memberRow(member, stale))}</ul>
                  : <p className="pb-3 text-[12px] text-ink-tertiary">{t("computer.agentTeam.noAgents")}</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function AgentTeamPanel() {
  const visible = usePageVisible();
  const [snapshot, setSnapshot] = useState<LocalAgentTeamsResponse | null>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api<LocalAgentTeamsResponse>(ROUTE, { background: true, signal: controller.signal, timeoutMs: 5_000 });
        if (active) setSnapshot((previous) => next.status === "unavailable" && previous?.updatedAt != null ? { ...previous, status: "stale" } : next);
      } catch (error) {
        if (active) setSnapshot((previous) => error instanceof ApiError && error.status === 403 ? unavailable
          : previous?.updatedAt != null ? { ...previous, status: "stale" } : unavailable);
      } finally {
        if (active) timer = setTimeout(refresh, REFRESH_MS);
      }
    };
    void refresh();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [visible]);

  return <AgentTeamView snapshot={snapshot} />;
}
