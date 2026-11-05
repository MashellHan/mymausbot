import type { LocalUsageWeekChange } from "../../shared/local-dashboard";
import { activeLocale, t } from "@/lib/i18n";

export const usageMetrics = ["prs", "commits", "totalTokens"] as const;
export type UsageMetric = typeof usageMetrics[number];
export const metricText = (value: number | null) => value === null ? t("computer.usage.unavailable") : value.toLocaleString(activeLocale());
export const prText = (prs: number | null, knownPrs: number | null) => metricText(prs ?? knownPrs);
export const changeText = (value: LocalUsageWeekChange) => value === null ? "—" : value === "new" ? t("computer.usage.newActivity")
  : new Intl.NumberFormat(activeLocale(), { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(value / 100);
export const periodChangeLabel = (days: 1 | 7 | 30) => t(days === 1 ? "computer.usage.change.dod"
  : days === 7 ? "computer.usage.change.wow" : "computer.usage.change.mom");

export function PrCount({ prs, knownPrs }: { prs: number | null; knownPrs: number | null }) {
  return <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
    <span>{prText(prs, knownPrs)}</span>
    {prs === null && knownPrs !== null && <span className="text-[12px] font-normal text-warning" title={t("computer.usage.syncedHint")}>{t("computer.usage.synced")}</span>}
  </span>;
}
