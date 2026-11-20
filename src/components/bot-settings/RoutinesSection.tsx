import { CalendarClock, ChevronRight, FileText, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import type { Routine, RoutineRun, RoutineRunOn } from "@/lib/routines";
import { t } from "@/lib/i18n";
import { useUpcomingRoutinesFocus } from "@/lib/computer-panel-view";
import { RoutineEditor } from "../RoutinesPage";
import { RoutineList } from "../routines/RoutineList";

export function RoutinesSection({ bot, routines, runs, defaultRunOn, compact = false, upcoming = false }: { bot: Bot; routines: Routine[]; runs: RoutineRun[]; defaultRunOn?: RoutineRunOn; compact?: boolean; upcoming?: boolean }) {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useUpcomingRoutinesFocus(bot.id, heading, upcoming);
  const now = Date.now();
  const shown = upcoming ? routines.filter((routine) => routine.enabled && (routine.nextRunAt ?? 0) > now) : routines;
  return <div className={compact ? "flex flex-col gap-3" : "flex flex-col gap-4"}>
    <div className={compact ? "flex flex-wrap items-center gap-3 px-1" : "rounded-xl bg-card p-4"}>
      {compact ? <>
        <CalendarClock size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <h2 ref={heading} data-overview-section-title="" data-upcoming-routines={upcoming ? "" : undefined} tabIndex={upcoming ? -1 : undefined} className="min-w-0 flex-1 text-[15px] font-semibold text-ink">{t(upcoming ? "routines.upcoming" : "routines.kind.routine")}</h2>
        <button type="button" onClick={() => setEditing("new")} className="flex items-center gap-1 rounded-lg bg-control px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent"><Plus size={13} aria-hidden="true" />{t("computer.routines.create")}</button>
      </> : <>
      <div className="flex items-center gap-2"><CalendarClock size={16} className="text-accent" /><h2 className="min-w-0 flex-1 text-[15px] font-medium text-ink">{t("computer.tab.routines")}</h2><span className="text-[12px] text-ink-secondary">{routines.length}</span></div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => setEditing("new")} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-medium text-white hover:brightness-110"><Plus size={14} />{t("computer.routines.create")}</button>
        <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", botId: bot.id })} className="flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[12px] text-ink hover:bg-raised-hover"><FileText size={13} />{t("routines.logs")}</button>
      </div>
      </>}
    </div>
    <RoutineList routines={shown} runs={runs} compact={compact} upcoming={upcoming} pausedBots={state.config?.pausedBots} heldBots={state.config?.heldBots} loading={state.routinesLoadState === "loading" && shown.length === 0} error={state.routinesLoadState === "error"} unreadable={state.config?.routinesUnreadable} onOpen={setEditing} onLogs={(routine) => dispatch({ type: "showRoutines", section: "logs", botId: bot.id, routineId: routine.id })} onToggle={(routine) => dispatch({ type: "updateRoutine", routineId: routine.id, patch: { enabled: !routine.enabled } })} />
    <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "schedule", view: "list", botId: bot.id })} className="self-start text-[12px] text-accent hover:underline">{t("computer.routines.openTitle")} <ChevronRight size={14} aria-hidden="true" className="inline align-[-2px] rtl:-scale-x-100" /></button>
    {editing && <RoutineEditor key={bot.id} routine={editing === "new" ? undefined : editing} bots={[bot]} lockedBotId={bot.id} defaultRunOn={defaultRunOn} onClose={() => setEditing(null)} />}
  </div>;
}
