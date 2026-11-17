import { Network } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { LocalAgentTeam } from "../../shared/local-dashboard";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";

export function teamActivity(team: LocalAgentTeam) {
  return team.activeAgentCount > 0 ? "working" : team.agents.some((agent) => agent.state === "blocked") ? "blocked"
    : team.agents.some((agent) => agent.state === "unknown") ? "unknown" : "idle";
}

export function AgentTown({ teams, stale, selectedId, detailsId, selectorRef, countLabel, readLabel, onSelect, children }: {
  teams: LocalAgentTeam[]; stale: boolean; selectedId: string | null; detailsId: string;
  selectorRef: Ref<HTMLDivElement>; countLabel: string; readLabel: string; onSelect: (id: string) => void; children?: ReactNode;
}) {
  return <section className={cn("agent-town pt-2", teams.length ? "mb-5" : "mb-3")} aria-label={t("computer.agentTeam.town")}>
    <div data-testid="agent-offices-header" className="mb-2 flex min-w-0 items-center gap-2">
      <h2 className="shrink-0 text-[17px] font-semibold leading-6 text-ink">{t("computer.agentTeam.town")}</h2>
      <p data-testid="agent-town-summary" className="ml-auto min-w-0 text-right text-[11px] font-normal leading-4 text-ink-secondary [overflow-wrap:anywhere]">
        {countLabel}<span aria-hidden="true"> · </span>{readLabel}
      </p>
    </div>
    {children}
    {teams.length > 0 && <div ref={selectorRef} className="agent-town-offices flex max-h-36 flex-wrap gap-2 overflow-y-auto p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60" role="region" aria-label={t("computer.agentTeam.town")} tabIndex={0}>
      {teams.map((team) => <button key={team.id} type="button" data-team-house={team.id} data-activity={teamActivity(team)}
        aria-pressed={selectedId === team.id} aria-controls={selectedId === team.id ? detailsId : undefined}
        onClick={() => onSelect(team.id)}
        className={cn("min-w-0 max-w-full rounded-lg border border-hairline/60 px-3 py-2 text-left outline-none hover:bg-raised-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60", selectedId === team.id && "border-accent/60 bg-accent/5")}>
        <span dir="auto" title={team.name} className="flex items-center gap-1.5 text-[12px] font-medium leading-4 text-ink [overflow-wrap:anywhere]"><Network size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />{team.name}</span>
        <span className="mr-2 inline-block text-[11px] leading-4 tabular-nums text-ink-secondary">{team.agentCount === 1 ? t("computer.agentTeam.agentCountOne") : t("computer.agentTeam.agentCount", { count: team.agentCount })}</span>
        <span className="mr-2 inline-block text-[11px] leading-4 tabular-nums text-ink-secondary">{stale ? t("computer.agentTeam.lastActive", { count: team.activeAgentCount }) : t("computer.agentTeam.activeCount", { count: team.activeAgentCount })}</span>
      </button>)}
    </div>}
  </section>;
}
