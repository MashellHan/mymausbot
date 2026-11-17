import { UsersRound } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { LocalAgentTeamRulesResponse, LocalAgentTeamsResponse, LocalAgentTokenUsageWindow } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";
import { cn } from "@/lib/cn";
import { AgentTown, teamActivity } from "./AgentTown";
import { type AgentActivityReader } from "./AgentActivityDetails";
import { AgentTeamTree, stateLabel, stateDot } from "./AgentTeamTree";
import { AgentConfigurationViewer, type AgentConfigurationTarget } from "./AgentConfigurationViewer";

const ROUTE = "/api/local-dashboard/agents";
const REFRESH_MS = 2_000;
const unavailable: LocalAgentTeamsResponse = { status: "unavailable", updatedAt: null, teamCount: null, teams: [] };

function tokenLabel(period: "24h" | "7d", usage: LocalAgentTokenUsageWindow | undefined, stale: boolean) {
  const known = typeof usage?.knownTokens === "number" && Number.isSafeInteger(usage.knownTokens) && usage.knownTokens >= 0
    ? usage.knownTokens : null;
  const full = known === null ? null : known.toLocaleString(activeLocale());
  const count = known === null ? null : usage?.coverage === "partial" ? full
    : new Intl.NumberFormat(activeLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(known);
  const label = period === "24h"
    ? known === null ? t(usage?.coverage === "partial" ? "computer.agentTeam.tokens24hPartialUnknown" : "computer.agentTeam.tokens24hUnavailable")
      : usage?.coverage === "ready" ? t("computer.agentTeam.tokens24h", { count: count! }) : t("computer.agentTeam.tokens24hPartial", { count: count! })
    : known === null ? t(usage?.coverage === "partial" ? "computer.agentTeam.tokens7dPartialUnknown" : "computer.agentTeam.tokens7dUnavailable")
      : usage?.coverage === "ready" ? t("computer.agentTeam.tokens7d", { count: count! }) : t("computer.agentTeam.tokens7dPartial", { count: count! });
  const exact = full === null ? label : period === "24h"
    ? t(usage?.coverage === "ready" ? "computer.agentTeam.tokens24h" : "computer.agentTeam.tokens24hPartial", { count: full })
    : t(usage?.coverage === "ready" ? "computer.agentTeam.tokens7d" : "computer.agentTeam.tokens7dPartial", { count: full });
  return { shown: stale ? t("computer.agentTeam.lastObserved", { state: label }) : label,
    accessible: t("computer.agentTeam.tokens24hScope", { value: stale ? t("computer.agentTeam.lastObserved", { state: exact }) : exact }) };
}

export function AgentTeamView({ snapshot, active = true, readActivity }: {
  snapshot: LocalAgentTeamsResponse | null; active?: boolean; readActivity?: AgentActivityReader;
}) {
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const initialized = useRef(false);
  const baseId = useId();
  const selectorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const membersRef = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const focusedElement = useRef<Element | null>(null);
  const [teamRules, setTeamRules] = useState<LocalAgentTeamRulesResponse | null>(null);
  const [viewer, setViewer] = useState<AgentConfigurationTarget | null>(null);
  const selectedTeam = snapshot?.teams.find((team) => team.id === selectedTeamId);
  const viewerTeam = viewer && snapshot?.teams.find((team) => team.id === viewer.teamId);
  const activeViewer = active && viewerTeam && selectedTeamId === viewer?.teamId && (viewer?.kind === "team"
    || viewerTeam.agents.some((member) => member.id === viewer?.agentId && member.name === viewer.name &&
      (member.occupantId ?? null) === viewer.occupantId)) ? viewer : null;
  const count = snapshot?.teamCount ?? t("computer.agentTeam.unknownCount");
  const readAt = snapshot?.updatedAt === null || snapshot?.updatedAt === undefined
    ? null : new Date(snapshot.updatedAt).toLocaleString(activeLocale());
  const countLabel = snapshot?.teamCount === 1 ? t("computer.agentTeam.teamCountOne") : t("computer.agentTeam.teamCount", { count });
  const readLabel = readAt ? t("computer.agentTeam.readAt", { time: readAt }) : t("computer.agentTeam.neverRead");
  const stale = snapshot?.status === "stale";
  const teamTokens = { "24h": tokenLabel("24h", selectedTeam?.tokenUsage24h, stale),
    "7d": tokenLabel("7d", selectedTeam?.tokenUsage7d, stale) };

  useEffect(() => {
    if (initialized.current || !active || !snapshot?.teams.length || snapshot.status === "unavailable") return;
    initialized.current = true;
    const candidates = snapshot.teams.filter((team) => team.activeAgentCount > 0 || team.agents.some((member) => member.state === "blocked") || (team.lastActivityAt ?? 0) > 0);
    const priority = (team: typeof candidates[number]) => team.activeAgentCount > 0 ? 2 : team.agents.some((member) => member.state === "blocked") ? 1 : 0;
    candidates.sort((a, b) => priority(b) - priority(a) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    setSelectedTeamId(candidates[0]?.id ?? null);
  }, [active, snapshot]);

  useEffect(() => {
    if (!active || !selectedTeamId) { setTeamRules(null); return; }
    const controller = new AbortController();
    let current = true;
    setTeamRules(null);
    void api<LocalAgentTeamRulesResponse>(`/api/local-dashboard/teams/${encodeURIComponent(selectedTeamId)}/rules`,
      { background: true, signal: controller.signal, timeoutMs: 10_000 })
      .then((result) => { if (current && result.teamId === selectedTeamId) setTeamRules(result); })
      .catch(() => { if (current && !controller.signal.aborted) setTeamRules(null); });
    return () => { current = false; controller.abort(); };
  }, [active, selectedTeamId]);

  useEffect(() => { if (viewer && !activeViewer) setViewer(null); }, [viewer, activeViewer]);

  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => { focusedElement.current = event.target as Element; };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);

  useLayoutEffect(() => {
    const shouldRestore = restoreFocus.current;
    restoreFocus.current = false;
    if (selectedTeamId && snapshot && !selectedTeam) {
      setSelectedTeamId(null);
      if (shouldRestore) (selectorRef.current ?? panelRef.current)?.focus();
    }
    const selectedOffice = selectorRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    const selectedMembers = membersRef.current;
    return () => {
      const focused = focusedElement.current;
      restoreFocus.current = !!focused && !!selectedTeamId && !!(selectedOffice?.contains(focused) || selectedMembers?.contains(focused));
    };
  }, [selectedTeamId, selectedTeam, snapshot]);

  return (
    <div ref={panelRef} tabIndex={-1} className="@container/agents min-h-0 flex-1 overflow-y-auto px-4 pb-5" data-testid="agent-team-panel">
      <AgentTown teams={snapshot?.teams ?? []} stale={stale} selectedId={selectedTeamId} detailsId={`${baseId}-members`} selectorRef={selectorRef}
        countLabel={countLabel} readLabel={readLabel} onSelect={(id) => { setViewer(null); setSelectedTeamId((current) => current === id ? null : id); }}>
        {snapshot === null ? <p role="status" className="text-[12px] text-ink-secondary">{t("computer.agentTeam.loading")}</p> : null}
        {stale ? <p role="status" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.agentTeam.stale")}</p> : null}
        {snapshot?.status === "unavailable" ? <p role="status" className="rounded-lg bg-inset px-3 py-3 text-[12px] text-ink-secondary">{t("computer.agentTeam.unavailable")}</p> : null}
        {snapshot?.teamCount === 0 && snapshot.teams.length === 0 ? <p className="rounded-lg bg-inset px-3 py-3 text-[12px] text-ink-secondary">{t("computer.agentTeam.empty")}</p> : null}
      </AgentTown>
      {selectedTeam && <section key={selectedTeam.id} ref={membersRef} id={`${baseId}-members`} aria-labelledby={`${baseId}-team-name`} data-testid="selected-agent-team" className="agent-team-tree min-w-0">
        <header className="agent-team-root relative flex min-w-0 max-w-lg items-start justify-between gap-3 rounded-xl border border-hairline bg-card px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            <UsersRound size={16} className="shrink-0 text-ink-secondary" aria-hidden="true" /><h3 id={`${baseId}-team-name`} dir="auto" className="text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{selectedTeam.name}</h3>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-secondary"><span className={cn("size-1.5 rounded-full", stale ? "bg-ink-secondary/30" : stateDot[teamActivity(selectedTeam)])} aria-hidden="true" />{stale ? t("computer.agentTeam.lastObserved", { state: t(stateLabel[teamActivity(selectedTeam)]) }) : t(stateLabel[teamActivity(selectedTeam)])}</span>
            {(["24h", "7d"] as const).map((period) => <span key={period} data-testid={`team-token-${period}`}
              aria-label={teamTokens[period].accessible} title={teamTokens[period].accessible}
              className="text-[11px] tabular-nums text-ink-secondary">{teamTokens[period].shown}</span>)}
          </div>
          <div className="flex shrink-0 items-start gap-2">
            {teamRules?.teamId === selectedTeam.id && (teamRules.status === "ready" || teamRules.status === "error") &&
              <button type="button" aria-haspopup="dialog" onClick={() => setViewer({ kind: "team", teamId: selectedTeam.id, name: selectedTeam.name })}
                className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-medium text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
                {t("computer.agentTeam.config.teamRules")}
              </button>}
            <div className="text-right text-[12px] tabular-nums text-ink-secondary">
              <span className="block">{selectedTeam.agentCount === 1 ? t("computer.agentTeam.agentCountOne") : t("computer.agentTeam.agentCount", { count: selectedTeam.agentCount })}</span>
              <span className={cn("mt-0.5 block", !stale && selectedTeam.activeAgentCount > 0 && "text-success")}>{t(stale ? "computer.agentTeam.lastActive" : "computer.agentTeam.activeCount", { count: selectedTeam.activeAgentCount })}</span>
            </div>
          </div>
        </header>
        <AgentTeamTree key={selectedTeam.id} team={selectedTeam} stale={stale} active={active} readActivity={readActivity}
          onConfiguration={(selected) => setViewer({ kind: "member", teamId: selectedTeam.id, agentId: selected.id,
            occupantId: selected.occupantId ?? null, name: selected.name })} />
      </section>}
      {activeViewer && <AgentConfigurationViewer key={`${activeViewer.kind}:${activeViewer.teamId}:${activeViewer.kind === "member" ? `${activeViewer.agentId}:${activeViewer.occupantId}` : ""}:${activeViewer.name}`}
        target={activeViewer} onClose={() => setViewer(null)} fallbackFocus={panelRef}
        onRulesRead={(result) => setTeamRules((current) => current?.teamId === result.teamId ? result : current)} />}
    </div>
  );
}

export function AgentTeamPanel({ active = true }: { active?: boolean }) {
  const pageVisible = usePageVisible();
  const visible = active && pageVisible;
  const [snapshot, setSnapshot] = useState<LocalAgentTeamsResponse | null>(null);

  useEffect(() => {
    if (!visible) return;
    let mounted = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const started = Date.now();
      try {
        const next = await api<LocalAgentTeamsResponse>(ROUTE, { background: true, signal: controller.signal, timeoutMs: 5_000 });
        if (mounted) setSnapshot((previous) => next.status === "unavailable" && previous?.updatedAt != null ? { ...previous, status: "stale" } : next);
      } catch (error) {
        if (mounted) setSnapshot((previous) => error instanceof ApiError && (error.status === 401 || error.status === 403) ? unavailable
          : previous?.updatedAt != null ? { ...previous, status: "stale" } : unavailable);
      } finally {
        if (mounted) timer = setTimeout(refresh, Math.max(0, REFRESH_MS - (Date.now() - started)));
      }
    };
    void refresh();
    return () => { mounted = false; controller.abort(); clearTimeout(timer); };
  }, [visible]);

  return <AgentTeamView snapshot={snapshot} active={visible} />;
}
