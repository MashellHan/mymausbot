import { Pause, Play } from "lucide-react";
import { useState } from "react";
import type { LocalAgentTeam } from "../../shared/local-dashboard";
import { t } from "@/lib/i18n";
import { AgentTownHouse } from "./AgentTownHouse";
import "./agent-town.css";

export function teamActivity(team: LocalAgentTeam) {
  return team.activeAgentCount > 0 ? "working" : team.agents.some((agent) => agent.state === "blocked") ? "blocked"
    : team.agents.some((agent) => agent.state === "unknown") ? "unknown" : "idle";
}

export function AgentTown({ teams, stale, onSelect }: { teams: LocalAgentTeam[]; stale: boolean; onSelect: (id: string) => void }) {
  const [paused, setPaused] = useState(false);
  return <section className="agent-town mb-5" data-paused={paused || stale} aria-label={t("computer.agentTeam.town")}>
    <div className="mb-1 flex items-center justify-between gap-2">
      <h3 className="text-[13px] font-medium text-ink-secondary">{t("computer.agentTeam.town")}</h3>
      <button type="button" aria-pressed={paused} aria-label={t(paused ? "computer.agentTeam.playTown" : "computer.agentTeam.pauseTown")}
        onClick={() => setPaused(!paused)} className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
        {paused ? <Play size={14} /> : <Pause size={14} />}
      </button>
    </div>
    <div className="flex gap-3 overflow-x-auto rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60" role="region" aria-label={t("computer.agentTeam.town")} tabIndex={0}>
      {teams.map((team, index) => <button key={team.id} type="button" data-team-house={team.id} data-activity={teamActivity(team)}
        aria-label={t("computer.agentTeam.openTeam", { name: team.name })} onClick={() => onSelect(team.id)}
        className="town-house min-w-0 rounded-lg pb-2 text-center outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-accent/60">
        <AgentTownHouse index={index} />
        <span dir="auto" className="block px-1 text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{team.name}</span>
        <span className="mt-0.5 block text-[12px] tabular-nums text-ink-secondary">{stale ? t("computer.agentTeam.lastActive", { count: team.activeAgentCount }) : t("computer.agentTeam.activeCount", { count: team.activeAgentCount })}</span>
      </button>)}
    </div>
  </section>;
}
