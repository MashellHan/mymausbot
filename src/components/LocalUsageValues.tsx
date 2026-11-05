import type { LocalUsageWeekChange } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";

export const usageMetrics = ["prs", "commits", "totalTokens"] as const;
export type UsageMetric = typeof usageMetrics[number];
export const metricText = (value: number | null) => value === null ? t("computer.usage.unavailable") : value.toLocaleString(activeLocale());
export const prText = (prs: number | null, knownPrs: number | null) => metricText(prs ?? knownPrs);
export const changeText = (value: LocalUsageWeekChange) => value === null ? "—" : value === "new" ? t("computer.usage.newActivity")
  : new Intl.NumberFormat(activeLocale(), { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(value / 100);

export function UsageChange({ value, startDay, endDay, metric, daily = false, className = "text-[13px] text-ink-secondary" }: {
  value: LocalUsageWeekChange; startDay: string; endDay: string;
  metric: "prs" | "commits" | "totalTokens"; daily?: boolean; className?: string;
}) {
  const shown = changeText(value);
  const previous = startDay === endDay ? startDay : `${startDay}–${endDay}`;
  const description = `${t("computer.usage.changeDescription", { change: shown, previous })}`
    + `${daily ? ` ${t("computer.usage.dailyComparisonHint")}` : ""}`
    + `${metric !== "prs" ? ` ${t("computer.usage.activityScopeHint")}` : ""}`
    + `${value === null ? ` ${t("computer.usage.changeUnavailableHint")}` : ""}`;
  return <span data-usage-change className={className} title={description}>
    <span aria-hidden="true">({shown})</span><span className="sr-only">{description}</span>
  </span>;
}

export function PrCount({ prs, knownPrs }: { prs: number | null; knownPrs: number | null }) {
  return <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
    <span>{prText(prs, knownPrs)}</span>
    {prs === null && knownPrs !== null && <span className="text-[12px] font-normal text-warning" title={t("computer.usage.syncedHint")}>{t("computer.usage.synced")}</span>}
  </span>;
}
