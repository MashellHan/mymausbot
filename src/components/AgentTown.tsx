import { Pause, Play } from "lucide-react";
import { useState, type ReactNode, type Ref } from "react";
import type { LocalAgentTeam } from "../../shared/local-dashboard";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { AgentTownHouse } from "./AgentTownHouse";
import "./agent-town.css";

export function teamActivity(team: LocalAgentTeam) {
  return team.activeAgentCount > 0 ? "working" : team.agents.some((agent) => agent.state === "blocked") ? "blocked"
    : team.agents.some((agent) => agent.state === "unknown") ? "unknown" : "idle";
}

export function AgentTown({ teams, stale, selectedId, detailsId, selectorRef, countLabel, readLabel, onSelect, children }: {
  teams: LocalAgentTeam[]; stale: boolean; selectedId: string | null; detailsId: string;
  selectorRef: Ref<HTMLDivElement>; countLabel: string; readLabel: string; onSelect: (id: string) => void; children?: ReactNode;
}) {
  const [paused, setPaused] = useState(false);
  return <section className={cn("agent-town pt-2", teams.length ? "mb-5" : "mb-3")} data-paused={paused || stale} aria-label={t("computer.agentTeam.town")}>
    <div data-testid="agent-offices-header" className="mb-2 flex min-w-0 items-center gap-2">
      <h2 className="shrink-0 text-[18px] font-semibold leading-6 text-ink">{t("computer.agentTeam.town")}</h2>
      <p data-testid="agent-town-summary" className="ml-auto min-w-0 text-right text-[11px] font-normal leading-4 text-ink-secondary [overflow-wrap:anywhere]">
        {countLabel}<span aria-hidden="true"> · </span>{readLabel}
      </p>
      {teams.length > 0 && <button type="button" aria-pressed={paused} aria-label={t(paused ? "computer.agentTeam.playTown" : "computer.agentTeam.pauseTown")}
        onClick={() => setPaused(!paused)} className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
        {paused ? <Play size={14} /> : <Pause size={14} />}
      </button>}
    </div>
    {children}
    {teams.length > 0 && <div ref={selectorRef} className="agent-town-offices rounded-lg border border-hairline/60 bg-inset/40 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60" role="region" aria-label={t("computer.agentTeam.town")} tabIndex={0}>
      {teams.map((team, index) => <button key={team.id} type="button" data-team-house={team.id} data-activity={teamActivity(team)}
        aria-pressed={selectedId === team.id} aria-controls={selectedId === team.id ? detailsId : undefined}
        onClick={() => onSelect(team.id)}
        className={cn("town-house min-w-0 rounded-lg border border-transparent px-1 pb-1 text-center outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60", selectedId === team.id && "border-accent/60 bg-accent/5")}>
        <AgentTownHouse index={index} />
        <span dir="auto" title={team.name} className="line-clamp-2 px-1 text-[12px] font-medium leading-4 text-ink [overflow-wrap:anywhere]">{team.name}</span>
        <span className="block text-[11px] leading-4 tabular-nums text-ink-secondary">{team.agentCount === 1 ? t("computer.agentTeam.agentCountOne") : t("computer.agentTeam.agentCount", { count: team.agentCount })}</span>
        <span className="block text-[11px] leading-4 tabular-nums text-ink-secondary">{stale ? t("computer.agentTeam.lastActive", { count: team.activeAgentCount }) : t("computer.agentTeam.activeCount", { count: team.activeAgentCount })}</span>
      </button>)}
    </div>}
  </section>;
}
