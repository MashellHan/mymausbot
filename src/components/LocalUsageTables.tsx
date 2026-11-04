import { ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import type { LocalUsageTrendDay, LocalUsageWeekChange, LocalUsageWindow } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { metricText, PrCount, usageMetrics } from "./LocalUsageValues";

const tableRegion = "overflow-x-auto rounded-lg border border-hairline/60 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";

function changeText(value: LocalUsageWeekChange) {
  return value === null ? "—" : value === "new" ? t("computer.usage.newActivity")
    : new Intl.NumberFormat(activeLocale(), { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(value / 100);
}

export function UsageDailyTable({ days }: { days: LocalUsageTrendDay[] }) {
  return <details className="group mt-4" data-usage-daily>
    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg py-2 text-[14px] font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [&::-webkit-details-marker]:hidden">
      <ChevronRight size={16} className="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
      {t("computer.usage.dailyValues")}<span className="ml-auto text-[13px] font-normal text-ink-secondary">WoW</span>
    </summary>
    <p className="mb-3 text-[13px] leading-5 text-ink-secondary">{t("computer.usage.wowHint")}</p>
    <div className={tableRegion} role="region" aria-label={t("computer.usage.dailyValues")} tabIndex={0}>
      <table className="w-full min-w-[650px] table-fixed text-[13px] tabular-nums">
        <colgroup><col className="w-[104px]" /><col /><col /><col /><col className="w-44" /></colgroup>
        <thead className="bg-inset text-ink-secondary"><tr>
          <th scope="col" className="sticky left-0 z-10 bg-inset px-3 py-2 text-left font-medium">{t("computer.usage.day")}</th>
          {usageMetrics.map((metric) => <th key={metric} scope="col" className="px-3 py-2 text-right font-medium">{t(`computer.usage.metric.${metric}`)}</th>)}
          <th scope="col" className="px-3 py-2 text-right font-medium">WoW</th>
        </tr></thead>
        <tbody className="text-ink">
          {days.slice().reverse().map((day) => <tr key={day.day} className="border-t border-hairline/40">
            <th scope="row" className="sticky left-0 bg-panel px-3 py-2 text-left align-top font-medium">{day.day}</th>
            <td className="px-3 py-2 text-right align-top"><PrCount prs={day.prs} knownPrs={day.knownPrs} /></td>
            <td className="px-3 py-2 text-right align-top">{metricText(day.commits)}</td>
            <td className="px-3 py-2 text-right align-top">{metricText(day.newTokens)}</td>
            <td className="px-3 py-2 text-right">{usageMetrics.map((metric) => <div key={metric} className="flex justify-between gap-3 leading-5">
              <span className="text-ink-secondary">{t(`computer.usage.metric.${metric}`)}</span><span>{changeText(day.wow[metric])}</span>
            </div>)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </details>;
}

const periods = ["1", "7", "30"] as const;
type Period = typeof periods[number];

export function UsageRepositoryTable({ windows }: { windows: Record<Period, LocalUsageWindow> }) {
  const [period, setPeriod] = useState<Period>("1");
  const id = useId();
  const window = windows[period];
  const repositories = window.repositories;
  return <section className="mt-6" aria-labelledby={`${id}-heading`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id={`${id}-heading`} className="text-[16px] font-semibold text-ink">{t("computer.usage.repositories")}</h3>
      <div role="tablist" aria-label={t("computer.usage.repositoryPeriod")} className="flex rounded-lg bg-inset p-1">
        {periods.map((key, index) => <button key={key} type="button" role="tab" id={`${id}-tab-${key}`} aria-controls={`${id}-panel`}
          aria-selected={period === key} tabIndex={period === key ? 0 : -1} onClick={() => setPeriod(key)}
          onKeyDown={(event) => {
            const next = event.key === "ArrowRight" ? (index + 1) % periods.length : event.key === "ArrowLeft" ? (index + periods.length - 1) % periods.length
              : event.key === "Home" ? 0 : event.key === "End" ? periods.length - 1 : null;
            if (next === null) return;
            event.preventDefault(); setPeriod(periods[next]!);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
          className={cn("min-h-8 rounded-md px-3 text-[13px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-accent/60", period === key ? "bg-card font-medium text-ink" : "text-ink-secondary hover:bg-raised-hover")}>
          {t("computer.usage.periodDays", { days: key })}
        </button>)}
      </div>
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${period}`} tabIndex={0} className="mt-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
      <p className="mb-3 text-[13px] tabular-nums text-ink-secondary">{window.startDay} – {window.endDay}</p>
      {repositories.sharedCommits > 0 && <p className="mb-3 text-[13px] leading-5 text-ink-secondary">{t("computer.usage.sharedCommits", { count: repositories.sharedCommits })}</p>}
      {repositories.coverage === "unavailable" ? <p className="text-[14px] text-ink-secondary">{t("computer.usage.repositoriesUnavailable")}</p> : <>
        {repositories.coverage === "partial" && <p className="mb-3 text-[13px] leading-5 text-warning">{t("computer.usage.repositoriesPartial")}</p>}
        <div className={tableRegion} role="region" aria-label={t("computer.usage.repositories")} tabIndex={0}>
          <table className="w-full table-fixed text-[13px] tabular-nums" data-usage-repositories>
            <colgroup><col className="w-[43%]" /><col className="w-[17%]" /><col className="w-[22%]" /><col className="w-[18%]" /></colgroup>
            <thead className="bg-inset text-ink-secondary"><tr>
              {(["repository", "category", "metric.prs", "metric.commits"] as const).map((key, index) => <th key={key} scope="col" className={cn("px-2 py-2 font-medium [overflow-wrap:anywhere]", index < 2 ? "text-left" : "text-right")}>{t(`computer.usage.${key}`)}</th>)}
            </tr></thead>
            <tbody className="text-ink">
              {repositories.rows.map((row) => <tr key={row.id} className="border-t border-hairline/40">
                <th scope="row" dir="auto" className="px-2 py-2 text-left font-medium [overflow-wrap:anywhere]">{row.name}</th>
                <td className="px-2 py-2 text-ink-secondary [overflow-wrap:anywhere]">{t(`computer.usage.category.${row.category}`)}</td>
                <td className="px-2 py-2 text-right [overflow-wrap:anywhere]"><PrCount prs={row.prs} knownPrs={row.knownPrs} /></td>
                <td className="px-2 py-2 text-right [overflow-wrap:anywhere]">{metricText(row.commits)}</td>
              </tr>)}
              {!!((repositories.unattributedPrs ?? 0) + (repositories.unattributedCommits ?? 0)) && <tr className="border-t border-hairline/40 text-ink-secondary">
                <th scope="row" colSpan={2} className="px-3 py-2 text-left font-normal">{t("computer.usage.unattributedRepository")}</th>
                <td className="px-3 py-2 text-right">{metricText(repositories.unattributedPrs)}</td>
                <td className="px-3 py-2 text-right">{metricText(repositories.unattributedCommits)}</td>
              </tr>}
            </tbody>
          </table>
        </div>
        {repositories.rows.length === 0 && !((repositories.unattributedPrs ?? 0) + (repositories.unattributedCommits ?? 0)) && <p className="mt-3 text-[14px] text-ink-secondary">{t("computer.usage.noRepositoryActivity")}</p>}
      </>}
    </div>
  </section>;
}
