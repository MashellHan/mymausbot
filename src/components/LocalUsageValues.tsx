import { createContext, useContext } from "react";
import type { LocalUsageWeekChange } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";

export const usageMetrics = ["prs", "commits", "totalTokens"] as const;
export type UsageMetric = typeof usageMetrics[number];
export const metricText = (value: number | null) => value === null ? t("computer.usage.unavailable") : value.toLocaleString(activeLocale());
export const countText = (value: number | null, known: number | null) => metricText(value ?? known);
export const UsageSourceContext = createContext<"primary" | "repositories" | "profile" | "merged">("primary");
export function useUsageMetricHint() {
  const source = useContext(UsageSourceContext);
  return (metric: UsageMetric) => t(metric === "prs" ? source === "primary" ? "computer.usage.primaryPrHint" : source === "profile" ? "computer.usage.githubPrHint" : source === "merged" ? "computer.usage.mergedPrHint" : "computer.usage.repositoryPrHint"
    : metric === "commits" ? source === "primary" ? "computer.usage.primaryCommitHint" : source === "profile" ? "computer.usage.githubCommitHint" : source === "merged" ? "computer.usage.mergedCommitHint" : "computer.usage.repositoryCommitHint" : "computer.usage.activityScopeHint");
}
export const changeText = (value: LocalUsageWeekChange) => value === null ? "—" : value === "new" ? t("computer.usage.newActivity")
  : new Intl.NumberFormat(activeLocale(), { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(value / 100);

export function UsageChange({ value, startDay, endDay, metric, daily = false, periodDays, unavailableHint, className = "text-[13px] text-ink-secondary" }: {
  value: LocalUsageWeekChange; startDay: string; endDay: string;
  metric: "prs" | "commits" | "totalTokens"; daily?: boolean; periodDays?: 1 | 7 | 30; unavailableHint?: string; className?: string;
}) {
  const usageMetricHint = useUsageMetricHint();
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
  const source = useContext(UsageSourceContext);
  const partial = value === null && known !== null;
  const description = partial ? t(source === "primary" ? "computer.usage.primaryKnownCountHint" : source === "profile" ? "computer.usage.syncedCountHint" : "computer.usage.observedCountHint") : undefined;
  return <span data-usage-provisional={partial || undefined} title={description} aria-description={description}>{countText(value, known)}</span>;
}
