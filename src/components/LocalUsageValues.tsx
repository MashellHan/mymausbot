import type { LocalUsageWeekChange } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";

export const usageMetrics = ["prs", "commits", "totalTokens"] as const;
export type UsageMetric = typeof usageMetrics[number];
export const metricText = (value: number | null) => value === null ? t("computer.usage.unavailable") : value.toLocaleString(activeLocale());
export const countText = (value: number | null, known: number | null) => metricText(value ?? known);
export const usageMetricHint = (metric: UsageMetric) => t(metric === "prs" ? "computer.usage.mergedPrHint"
  : metric === "commits" ? "computer.usage.mergedCommitHint" : "computer.usage.activityScopeHint");
export const changeText = (value: LocalUsageWeekChange) => value === null ? "—" : value === "new" ? t("computer.usage.newActivity")
  : new Intl.NumberFormat(activeLocale(), { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(value / 100);

export function UsageChange({ value, startDay, endDay, metric, daily = false, periodDays, unavailableHint, className = "text-[13px] text-ink-secondary" }: {
  value: LocalUsageWeekChange; startDay: string; endDay: string;
  metric: "prs" | "commits" | "totalTokens"; daily?: boolean; periodDays?: 1 | 7 | 30; unavailableHint?: string; className?: string;
}) {
  const shown = changeText(value);
  const period = periodDays ? t(`computer.usage.changePeriod.${periodDays}`) : null;
  const previous = startDay === endDay ? startDay : `${startDay}–${endDay}`;
  const description = `${t("computer.usage.changeDescription", { change: shown, previous })}`
    + `${daily ? ` ${t("computer.usage.dailyComparisonHint")}` : ""}`
    + `${period ? ` ${t("computer.usage.periodComparisonHint", { period, days: periodDays! })}` : ""}`
    + ` ${usageMetricHint(metric)}`
    + `${value === null ? ` ${unavailableHint ?? t("computer.usage.changeUnavailableHint")}` : ""}`;
  return <span data-usage-change className={className} title={description}>
    <span aria-hidden="true">{shown}</span><span className="sr-only">{description}</span>
  </span>;
}

export function UsageCount({ value, known }: { value: number | null; known: number | null }) {
  const partial = value === null && known !== null;
  return <span data-usage-provisional={partial || undefined} title={partial ? t("computer.usage.syncedCountHint") : undefined}>{countText(value, known)}</span>;
}
