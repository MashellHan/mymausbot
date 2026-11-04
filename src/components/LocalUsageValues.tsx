import { activeLocale, t } from "@/lib/i18n";

export const usageMetrics = ["prs", "commits", "newTokens"] as const;
export type UsageMetric = typeof usageMetrics[number];
export const metricText = (value: number | null) => value === null ? t("computer.usage.unavailable") : value.toLocaleString(activeLocale());
export const prText = (prs: number | null, knownPrs: number | null) => metricText(prs ?? knownPrs);

export function PrCount({ prs, knownPrs }: { prs: number | null; knownPrs: number | null }) {
  return <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5">
    <span>{prText(prs, knownPrs)}</span>
    {prs === null && knownPrs !== null && <span className="text-[12px] font-normal text-warning" title={t("computer.usage.syncedHint")}>{t("computer.usage.synced")}</span>}
  </span>;
}
