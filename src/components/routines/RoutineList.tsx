import { Clock3, FileText, Loader2, Repeat2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Routine, RoutineRun } from "@/lib/routines";
import { scheduleLabel } from "@/lib/schedule-label";
import { latestRoutineRun, routineDateTime, routineFinished, routineHeldNote, routineNextLabel, routineRunLabel, routineRunText, routineRunTone, routineScheduleState } from "@/lib/routine-display";
import type { Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";

export function RoutineList({ routines, runs, bots, loading, error, compact = false, onOpen, onLogs, onToggle }: {
  routines: Routine[];
  runs: RoutineRun[];
  bots?: Bot[];
  loading?: boolean;
  error?: boolean;
  compact?: boolean;
  onOpen: (routine: Routine) => void;
  onLogs: (routine: Routine) => void;
  onToggle?: (routine: Routine) => void;
}) {
  const visible = compact ? routines.filter((routine) => !routineFinished(routine)) : routines;
  const sorted = [...visible].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name));
  return <div className={cn(!compact && "space-y-3", compact && sorted.length > 0 && "divide-y divide-hairline/30 overflow-hidden rounded-xl border border-hairline/40 bg-card")} aria-label={t("routines.list")}>
    {error && <div role="alert" className="rounded-lg bg-danger/10 p-3 text-[12px] text-danger">{t("routines.loadError")}</div>}
    {loading && <p role="status" className="flex items-center gap-2 p-3 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("routines.loading")}</p>}
    {!loading && !error && routines.length === 0 && <div className="rounded-xl border border-dashed border-hairline/50 p-5 text-center text-[13px] text-ink-secondary"><Repeat2 size={20} className="mx-auto mb-2 opacity-60" />{t("routines.empty")}</div>}
    {sorted.map((routine) => {
      const latest = latestRoutineRun(routine.id, runs);
      const said = latest && (latest.attention ? "attention" : latest.error ? "error" : latest.output ? "output" : null);
      const bot = bots?.find((candidate) => candidate.id === routine.botId);
      const switched = onToggle !== undefined && !routineFinished(routine);
      return <article key={routine.id} className={compact ? "px-3 py-2.5" : "rounded-xl border border-hairline/40 bg-card p-3.5"} aria-label={routine.name}>
        <div className={cn("flex gap-2", compact ? "items-center" : "items-start")}>
          {compact && <Clock3 size={14} aria-hidden="true" className="shrink-0 text-ink-tertiary" />}
          <button type="button" onClick={() => onOpen(routine)} title={compact ? routine.name : undefined} className={cn("min-w-0 flex-1 text-left hover:text-accent", compact && "rounded-sm focus-visible:outline-2 focus-visible:outline-accent")}>
            <span className={cn("block truncate text-ink", compact ? "text-[13px] font-medium leading-[18px]" : "text-[13px] font-semibold")}>{routine.name}</span>
            <span className={compact ? "mt-0.5 block truncate text-[12px] text-ink-secondary" : "mt-1 block text-[12px] leading-relaxed text-ink-secondary"}>{!compact && bot && `${bot.name} · `}{scheduleLabel(routine.schedule)}</span>
            {compact && <span className="mt-0.5 block truncate text-[11px] text-ink-secondary">
              {t("routines.lastRunPrefix")} <span className={latest ? routineRunTone(latest) : undefined}>{latest ? routineRunLabel(latest) : t("routines.neverRun")}</span>
              {latest && <> · {routineDateTime(latest.finishedAt ?? latest.startedAt ?? latest.scheduledFor)}</>}
            </span>}
          </button>
          {switched
            ? <Switch checked={routine.enabled} aria-label={t("routines.toggle", { name: routine.name })} onClick={() => onToggle(routine)} />
            : <span className={cn("shrink-0 rounded-full bg-inset px-2 py-0.5 text-[10px]", routine.enabled && routine.nextRunAt != null ? "text-accent" : "text-ink-secondary")}>{routineScheduleState(routine)}</span>}
        </div>
        {!compact && <>
        {(switched || routineNextLabel(routine) !== routineScheduleState(routine)) && <div className="mt-2 text-[12px] text-ink-secondary">{routineNextLabel(routine)}</div>}
        <div className="mt-1 flex items-start justify-between gap-2">
          <div className="min-w-0 text-[12px]">
            {latest ? <><span className={routineRunTone(latest)}>{t("routines.latestRun", { status: routineRunLabel(latest) })}</span><span className="block text-[11px] text-ink-secondary">{routineDateTime(latest.finishedAt ?? latest.startedAt ?? latest.scheduledFor)}</span></> : <span className="text-ink-secondary">{t("routines.neverRun")}</span>}
          </div>
          <button type="button" onClick={() => onLogs(routine)} aria-label={t("routines.logsFor", { name: routine.name })} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink"><FileText size={12} />{t("routines.logs")}</button>
        </div>
        {latest && said && <p className={cn("mt-2 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed", latest.error ? "text-danger" : "text-ink-secondary")}>{routineRunText(latest, said)}</p>}
        {!!routine.failureStreak && <p className="mt-2 text-[12px] text-danger">{t("routines.failureStreak", { count: routine.failureStreak })}</p>}
        {routine.weekRuns && <p className="mt-2 text-[12px] text-ink-secondary">{t(routine.weekRuns.total === 1 ? "routines.weekRunsOne" : "routines.weekRuns", routine.weekRuns)}</p>}
        {routine.warning && <p className="mt-2 text-[12px] leading-relaxed text-warning">{routine.warning}</p>}
        {routine.heldFor && <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">{routineHeldNote(routine)}</p>}
        {!!routine.skippedRuns && <p className="mt-2 text-[12px] text-ink-secondary">
          {t("routines.skippedRuns", { count: routine.skippedRuns })}
          {routine.lastSkippedAt != null && <> · {t("routines.lastSkipped", { date: routineDateTime(routine.lastSkippedAt) })}</>}
        </p>}
        </>}
      </article>;
    })}
  </div>;
}
