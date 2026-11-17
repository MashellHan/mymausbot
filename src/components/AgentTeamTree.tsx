import { Check, CircleHelp, CirclePause, LoaderCircle, MessageCircleQuestion, UserRound } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { LocalAgentMember, LocalAgentTeam } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { AgentActivityDetails, type AgentActivityReader } from "./AgentActivityDetails";
import "./agent-team-tree.css";

export const stateLabel = {
  working: "computer.agentTeam.state.working", blocked: "computer.agentTeam.state.blocked",
  idle: "computer.agentTeam.state.idle", done: "computer.agentTeam.state.done", unknown: "computer.agentTeam.state.unknown",
} as const;
export const stateDot = {
  working: "bg-success", blocked: "bg-warning", idle: "bg-ink-secondary/60", done: "bg-accent", unknown: "bg-ink-secondary/30",
} as const;
const stateIcon = { working: LoaderCircle, blocked: MessageCircleQuestion, idle: CirclePause, done: Check, unknown: CircleHelp };
const identity = (member: LocalAgentMember) => JSON.stringify([member.id, member.occupantId ?? null, member.name]);

function MemberStatus({ member, stale }: { member: LocalAgentMember; stale: boolean }) {
  const Icon = stateIcon[member.state];
  return <span data-agent-state={stale ? "stale" : member.state} className="inline-flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-ink-secondary">
    <Icon size={14} aria-hidden="true" className={cn("shrink-0", !stale && member.state === "working" && "agent-tree-working text-success", !stale && member.state === "blocked" && "text-warning", !stale && member.state === "done" && "text-accent-text")} />
    {stale ? t("computer.agentTeam.lastObserved", { state: t(stateLabel[member.state]) }) : t(stateLabel[member.state])}
  </span>;
}

export function AgentTeamTree({ team, stale, active, onConfiguration, readActivity }: {
  team: LocalAgentTeam; stale: boolean; active: boolean;
  onConfiguration: (member: LocalAgentMember) => void; readActivity?: AgentActivityReader;
}) {
  const members = [...team.agents].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  const [selected, setSelected] = useState<string | null>(null);
  const member = members.find((candidate) => identity(candidate) === selected);
  const rootRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const focusedElement = useRef<{ element: Element; inside: boolean } | null>(null);
  const id = useId();
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      const element = event.target as Element;
      focusedElement.current = { element, inside: !!rootRef.current?.contains(element) };
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);
  useLayoutEffect(() => {
    if (selected && !member) setSelected(null);
    const focused = focusedElement.current;
    if (focused?.inside && !focused.element.isConnected) rootRef.current?.focus({ preventScroll: true });
  }, [selected, member, team.agents]);
  const number = (value: number | null) => value === null ? "—" : value.toLocaleString(activeLocale());
  const context = member && member.contextUsed !== null && member.contextWindow !== null && member.contextWindow > 0
    ? Math.round(member.contextUsed / member.contextWindow * 100) : null;

  return <div ref={rootRef} tabIndex={-1} className="min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
    {members.length ? <ul className="agent-tree-branches" aria-label={team.name}>
      {members.map((candidate, index) => {
        const key = identity(candidate);
        const expanded = key === selected;
        return <li key={key} data-agent-id={candidate.id} className="agent-tree-branch min-w-0" data-last-row={index >= Math.floor((members.length - 1) / 3) * 3}>
          <span className="agent-tree-trunk" aria-hidden="true" />
          <div className={cn("agent-tree-node overflow-hidden rounded-xl border bg-card", expanded ? "border-accent/70" : "border-hairline")}>
            <button type="button" data-agent-select={candidate.id} aria-expanded={expanded} aria-controls={expanded ? id : undefined}
              onClick={() => setSelected(expanded ? null : key)}
              className="block w-full min-w-0 rounded-lg p-3 text-left outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
              <span className="flex min-w-0 items-center gap-2">
                <UserRound size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                <span dir="auto" title={candidate.name} className="truncate text-[13px] font-medium text-ink">{candidate.name}</span>
              </span>
              <span className="mt-1 block truncate text-[11px] text-ink-secondary">{candidate.role ?? t("computer.agentTeam.roleUnavailable")}</span>
              <span dir="auto" title={candidate.model ?? undefined} className="mt-1 block truncate text-[11px] text-ink-secondary">
                {candidate.model ? <>{t("computer.agentTeam.modelLabel")} · {candidate.model}</> : t("computer.agentTeam.modelUnavailable")}
              </span>
              <span dir="auto" title={candidate.taskHint ?? undefined} className="mt-2 line-clamp-2 min-h-8 text-[12px] leading-4 text-ink-secondary [overflow-wrap:anywhere]">
                <span className="sr-only">{t("computer.agentTeam.latestInstruction")}: </span>{candidate.taskHint ?? t("computer.agentTeam.instructionUnavailable")}
              </span>
            </button>
            <div className="flex min-h-9 items-center justify-between gap-2 border-t border-hairline/50 px-3 py-1">
              <MemberStatus member={candidate} stale={stale} />
              <button type="button" aria-haspopup="dialog" onClick={() => onConfiguration(candidate)}
                className="shrink-0 rounded-md px-1 py-1 text-[11px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
                {t("computer.agentTeam.config.title")}
              </button>
            </div>
          </div>
        </li>;
      })}
    </ul> : <p className="py-4 text-[12px] text-ink-secondary">{t("computer.agentTeam.noAgents")}</p>}
    <section ref={detailRef} id={id} hidden={!member} aria-labelledby={`${id}-name`} className="mt-5 min-w-0 border-t border-hairline pt-4" data-testid="agent-tree-detail">
      {member && <>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h4 id={`${id}-name`} dir="auto" className="text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{member.name}</h4>
          <span aria-live="polite" aria-atomic="true"><MemberStatus member={member} stale={stale} /></span>
        </div>
        <p dir="auto" className="mt-2 text-[12px] text-ink-secondary [overflow-wrap:anywhere]">{member.model ?? t("computer.agentTeam.modelUnavailable")}</p>
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-secondary">
          <div className="flex gap-1"><dt>{t("computer.agentTeam.reasoning")}</dt><dd>{member.reasoningEffort ?? "—"}</dd></div>
          <div className="flex flex-wrap gap-1 tabular-nums"><dt>{t("computer.agentTeam.context")}</dt><dd>{number(member.contextUsed)} / {number(member.contextWindow)}{context !== null ? ` · ${context}%` : ""}</dd></div>
        </dl>
        {context !== null && <div role="meter" className="mt-2 h-1 overflow-hidden rounded-full bg-inset" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(context, 100)} aria-valuetext={`${context}%`} aria-label={t("computer.agentTeam.context")}>
          <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(context, 100)}%` }} />
        </div>}
        <p dir="auto" className="mt-3 text-[12px] leading-5 text-ink-secondary [overflow-wrap:anywhere]">
          <span className="font-medium">{t("computer.agentTeam.latestInstruction")}: </span>{member.taskHint ?? t("computer.agentTeam.instructionUnavailable")}
        </p>
        <AgentActivityDetails key={identity(member)} agentId={member.id} active={active} readActivity={readActivity} />
      </>}
    </section>
  </div>;
}
