import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import type { UsageTrendDay, UsageWindow, UsageRepositoryWindow } from "@/lib/local-usage-view";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { metricText, UsageCount, UsageChange, usageMetrics, useUsageMetricHint } from "./LocalUsageValues";
import { InfoHint } from "./InfoHint";

const tableRegion = "overflow-x-auto rounded-lg border border-hairline/60 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";
const previousWeekDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);

export function UsageDailyTable({ days }: { days: UsageTrendDay[] }) {
  const usageMetricHint = useUsageMetricHint();
  const rangeLabel = days.length ? `${days[0]!.day} – ${days.at(-1)!.day}` : null;
  return <details className="group mt-6" data-usage-daily>
    <summary className="flex min-h-8 cursor-pointer list-none flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md pe-1 outline-none hover:text-ink-secondary focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
      <span className="inline-flex items-center gap-1.5 text-[16px] font-semibold text-ink group-hover:text-ink-secondary">
        <ChevronRight size={16} className="shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-90" aria-hidden="true" />
        <span>{t("computer.usage.dailyValues")}</span>
      </span>
      {rangeLabel && <span className="text-[13px] tabular-nums text-ink-secondary">{rangeLabel}</span>}
    </summary>
    <p className="mt-2 mb-3 text-[13px] leading-5 text-ink-secondary">{t("computer.usage.wowHint")}</p>
    <div className={tableRegion} role="region" aria-label={t("computer.usage.dailyValues")} tabIndex={0}>
      <table className="w-full min-w-[880px] table-fixed text-[13px] tabular-nums">
        <colgroup><col className="w-[104px]" /><col /><col /><col /><col className="w-44" /><col className="w-56" /></colgroup>
        <thead className="bg-inset text-ink-secondary"><tr>
          <th scope="col" className="sticky left-0 z-10 bg-inset px-3 py-2 text-left font-medium">{t("computer.usage.day")}</th>
          {usageMetrics.map((metric) => <th key={metric} title={usageMetricHint(metric)} scope="col" className="px-3 py-2 text-right font-medium">{t(`computer.usage.metric.${metric}`)}</th>)}
          <th scope="col" className="px-3 py-2 text-right font-medium">{t("computer.usage.changeHeading")}</th>
          <th scope="col" className="px-3 py-2 text-left font-medium">{t("computer.usage.primaryRepositories")}</th>
        </tr></thead>
        <tbody className="text-ink">
          {days.slice().reverse().map((day) => <tr key={day.day} className="border-t border-hairline/40">
            <th scope="row" className="sticky left-0 bg-panel px-3 py-2 text-left align-top font-medium">{day.day}</th>
            <td className="px-3 py-2 text-right align-top"><UsageCount value={day.prs} known={day.knownPrs} /></td>
            <td className="px-3 py-2 text-right align-top"><UsageCount value={day.commits} known={day.knownCommits} /></td>
            <td className="px-3 py-2 text-right align-top">{metricText(day.totalTokens)}</td>
            <td className="px-3 py-2 text-right">{usageMetrics.map((metric) => <div key={metric} className="flex justify-between gap-3 leading-5">
              <span className="text-ink-secondary">{t(`computer.usage.metric.${metric}`)}</span>
              <UsageChange value={day.wow[metric]} startDay={previousWeekDay(day.day)} endDay={previousWeekDay(day.day)} metric={metric} daily className="text-[13px]" />
            </div>)}</td>
            <td className="px-3 py-2 align-top">
              {!day.repositories || day.repositories.coverage === "unavailable" ? <span className="text-ink-secondary">{t("computer.usage.repositoriesUnavailable")}</span>
                : <details data-usage-day-repositories>
                  <summary className="min-h-11 cursor-pointer rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60">{t("computer.usage.primaryRepositories")}</summary>
                  {day.repositories.coverage === "partial" && <p className="text-ink-secondary">{t("computer.usage.repositoriesPartial")}</p>}
                  <ul className="mt-1 space-y-2">
                    {day.repositories.rows.map(row => <li key={row.id} className="[overflow-wrap:anywhere]">
                      <span dir="auto">{row.name}</span> · {t(`computer.usage.category.${row.category}`)}
                      <div>{t("computer.usage.metric.prs")} <UsageCount value={row.prs} known={row.knownPrs} /> · {t("computer.usage.metric.commits")} <UsageCount value={row.commits} known={row.knownCommits} /></div>
                    </li>)}
                    {!!((day.repositories.unattributedPrs ?? 0) + (day.repositories.unattributedCommits ?? 0)) && <li>{t("computer.usage.unattributedRepository")} · {t("computer.usage.metric.prs")} <UsageCount value={day.prs === null ? null : day.repositories.unattributedPrs} known={day.repositories.unattributedPrs} /> · {t("computer.usage.metric.commits")} {metricText(day.repositories.unattributedCommits)}</li>}
                  </ul>
                  {!day.repositories.rows.length && !((day.repositories.unattributedPrs ?? 0) + (day.repositories.unattributedCommits ?? 0)) && <p>{t(day.repositories.coverage === "ready" ? "computer.usage.noRepositoryActivity" : "computer.usage.repositoriesUnavailable")}</p>}
                </details>}
            </td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </details>;
}

export const shortUsagePeriods = ["1", "7", "30"] as const;
type Period = typeof shortUsagePeriods[number] | "60";

export function UsagePeriodSection<P extends Period>({ kind, heading, hint, periods, period, onPeriodChange, window, open, onToggle, children }: {
  kind: "models" | "repositories"; heading: string; hint: ReactNode;
  periods: readonly P[]; period: P; onPeriodChange: (period: P) => void;
  window: Pick<UsageWindow, "startDay" | "endDay">; open?: boolean; onToggle?: () => void; children: ReactNode;
}) {
  const id = useId();
  const panelId = `${id}-panel`;
  return <section className="mt-6" aria-labelledby={`${id}-heading`} data-usage-period={kind}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id={`${id}-heading`} className="text-[16px] font-semibold text-ink">
          {onToggle ? <button type="button" aria-expanded={open} aria-controls={panelId} onClick={onToggle}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md pe-1 text-left outline-none hover:text-ink-secondary focus-visible:ring-2 focus-visible:ring-accent/60">
            <ChevronRight size={16} className={cn("shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
            <span>{heading}</span>
          </button> : heading}
        </h3>
        <span className="text-[13px] tabular-nums text-ink-secondary">{window.startDay === window.endDay && kind === "models" ? window.endDay : `${window.startDay} – ${window.endDay}`}</span>
        {open !== false && hint}
      </div>
      {open !== false && <div role="tablist" aria-label={t(kind === "models" ? "computer.usage.modelPeriod" : "computer.usage.repositoryPeriod")} className="flex rounded-lg bg-inset p-1">
        {periods.map((key, index) => <button key={key} type="button" role="tab" id={`${id}-tab-${key}`} aria-controls={panelId}
          aria-selected={period === key} tabIndex={period === key ? 0 : -1} onClick={() => onPeriodChange(key)}
          onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % periods.length : event.key === "ArrowLeft" ? (index + periods.length - 1) % periods.length
              : event.key === "Home" ? 0 : event.key === "End" ? periods.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); onPeriodChange(periods[next]!);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
          className={cn("min-h-8 rounded-md px-3 text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent/60", period === key ? "bg-card font-medium text-ink" : "text-ink-secondary hover:bg-raised-hover")}>
          {t("computer.usage.periodDays", { days: key })}
        </button>)}
      </div>}
    </div>
    <div role="tabpanel" id={panelId} aria-labelledby={`${id}-tab-${period}`} tabIndex={0} hidden={open === false} className="mt-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
      {children}
    </div>
  </section>;
}

export function UsageRepositoryTable({ windows, historyWindow, defaultPeriod = "1" }: {
  windows: Record<typeof shortUsagePeriods[number], UsageWindow>; historyWindow?: UsageRepositoryWindow | null; defaultPeriod?: Period;
}) {
  const usageMetricHint = useUsageMetricHint();
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const periods: readonly Period[] = historyWindow ? [...shortUsagePeriods, "60"] : shortUsagePeriods;
  const window = period === "60" && historyWindow ? historyWindow : windows[period === "60" ? "30" : period];
  const periodDays = period === "60" ? undefined : windows[period].days;
  const repositories = window.repositories;
  return <UsagePeriodSection kind="repositories" heading={t("computer.usage.primaryRepositories")} periods={periods} period={period} onPeriodChange={setPeriod} window={window}
    hint={repositories.coverage === "partial" && <InfoHint label={t("computer.usage.coverage.partial")} warning>{t("computer.usage.repositoriesPartial")}</InfoHint>}>
      {repositories.coverage === "unavailable" ? <p className="text-[14px] text-ink-secondary">{t("computer.usage.repositoriesUnavailable")}</p> : <>
        <div className={tableRegion} role="region" aria-label={t("computer.usage.primaryRepositories")} tabIndex={0}>
          <table className="w-full min-w-[560px] table-fixed text-[13px] tabular-nums" data-usage-repositories>
            <colgroup><col className="w-[43%]" /><col className="w-[17%]" /><col className="w-[22%]" /><col className="w-[18%]" /></colgroup>
            <thead className="bg-inset text-ink-secondary"><tr>
              {(["repository", "category", "metric.prs", "metric.commits"] as const).map((key, index) => <th key={key} title={index === 2 ? usageMetricHint("prs") : index === 3 ? usageMetricHint("commits") : undefined} scope="col" className={cn("px-2 py-2 font-medium [overflow-wrap:anywhere]", index < 2 ? "text-left" : "text-right")}>{t(`computer.usage.${key}`)}</th>)}
            </tr></thead>
            <tbody className="text-ink">
              {repositories.rows.map((row) => <tr key={row.id} className="border-t border-hairline/40">
                <th scope="row" dir="auto" className="px-2 py-2 text-left font-medium [overflow-wrap:anywhere]">{row.name}</th>
                <td className="px-2 py-2 text-ink-secondary [overflow-wrap:anywhere]">{t(`computer.usage.category.${row.category}`)}</td>
                <td className="px-2 py-2 text-right [overflow-wrap:anywhere]"><UsageCount value={row.prs} known={row.knownPrs} />
                  <UsageChange value={row.comparison.prs ?? row.knownComparison?.prs ?? null} known={row.comparison.prs === null && row.knownComparison?.prs != null}
                    periodDays={periodDays} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric="prs" className="block text-[13px]" /></td>
                <td className="px-2 py-2 text-right [overflow-wrap:anywhere]"><UsageCount value={row.commits} known={row.knownCommits} />
                  <UsageChange value={row.comparison.commits ?? row.knownComparison?.commits ?? null} known={row.comparison.commits === null && row.knownComparison?.commits != null}
                    periodDays={periodDays} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric="commits" className="block text-[13px]" /></td>
              </tr>)}
              {!!((repositories.unattributedPrs ?? 0) + (repositories.unattributedCommits ?? 0)) && <tr className="border-t border-hairline/40 text-ink-secondary">
                <th scope="row" colSpan={2} className="px-3 py-2 text-left font-normal">{t("computer.usage.unattributedRepository")}</th>
                <td className="px-3 py-2 text-right"><UsageCount value={repositories.coverage === "ready" ? repositories.unattributedPrs : null} known={repositories.unattributedPrs} /></td>
                <td className="px-3 py-2 text-right">{metricText(repositories.unattributedCommits)}</td>
              </tr>}
            </tbody>
          </table>
        </div>
        {repositories.rows.length === 0 && !((repositories.unattributedPrs ?? 0) + (repositories.unattributedCommits ?? 0)) && <p className="mt-3 text-[14px] text-ink-secondary">{t(repositories.coverage === "ready" ? "computer.usage.noRepositoryActivity" : "computer.usage.repositoriesUnavailable")}</p>}
      </>}
  </UsagePeriodSection>;
}
