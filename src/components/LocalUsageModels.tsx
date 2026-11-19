import { useState } from "react";
import type { UsageWindow } from "@/lib/local-usage-view";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { formatUsd, usdText } from "@/lib/usage";
import { InfoHint } from "./InfoHint";
import { UsagePeriodSection, shortUsagePeriods } from "./LocalUsageTables";
import { metricText } from "./LocalUsageValues";

type Cost = NonNullable<UsageWindow["tokenDetails"]>["estimatedCost"];

function costText(estimate?: Cost) {
  if (!estimate || estimate.usd === null || estimate.coverage === "unavailable") return t("computer.usage.unavailable");
  const { usd, coverage } = estimate;
  if (usd === 0) return coverage === "ready" ? usdText(0, 2) : t("computer.usage.costPartial", { cost: usdText(0, 2) });
  if (usd < 0.001) {
    const cost = t("computer.usage.costBelow", { cost: formatUsd(0.001) });
    return coverage === "ready" ? cost : t("computer.usage.costPartial", { cost });
  }
  if (coverage === "ready") return formatUsd(usd);
  const digits = usd < 0.01 ? 3 : 2;
  const units = 10 ** digits;
  const rounded = Number(usd.toFixed(digits));
  const bound = rounded <= usd ? rounded : (Math.round(rounded * units) - 1) / units;
  return t("computer.usage.costAtLeast", { cost: formatUsd(bound) });
}

export function UsageTokenBreakdown({ cacheRead, input, output, estimatedCost, asRows = false }: {
  cacheRead: number | null; input: number | null; output: number | null; estimatedCost?: Cost; asRows?: boolean;
}) {
  const metrics = [
    ["cachedInput", metricText(cacheRead)], ["freshInput", metricText(input)],
    ["output", metricText(output)], ["estimatedCost", costText(estimatedCost)],
  ] as const;
  return <dl data-usage-token-breakdown className={cn("grid min-w-0 gap-x-3 gap-y-1 text-[13px] tabular-nums", asRows ? "grid-cols-1" : "grid-cols-2")}>
    {metrics.map(([key, value]) => <div key={key} className={cn("min-w-0 [overflow-wrap:anywhere]", asRows && "flex items-baseline justify-between gap-x-3")}>
      <dt className="text-ink-secondary">{t(`computer.usage.${key}`)}</dt>
      <dd className={cn("text-ink", asRows && "text-end")}>{value}</dd>
    </div>)}
  </dl>;
}

type ShortPeriod = typeof shortUsagePeriods[number];

export function UsageModelPanel({ windows }: { windows: Record<ShortPeriod, UsageWindow> }) {
  const [period, setPeriod] = useState<ShortPeriod>("1");
  const [open, setOpen] = useState(true);
  const window = windows[period];
  const models = window.tokenDetails?.models;
  const rows = models?.coverage === "unavailable" ? [] : models?.rows.toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model, activeLocale())) ?? [];
  const percent = new Intl.NumberFormat(activeLocale(), { style: "percent", maximumFractionDigits: 1 });
  const title = t("computer.usage.modelUsage");
  return <UsagePeriodSection kind="models" heading={title} periods={shortUsagePeriods} period={period} onPeriodChange={setPeriod} window={window}
    open={open} onToggle={() => setOpen((current) => !current)}
    hint={<InfoHint label={t("computer.usage.costHelp")}>{t("computer.usage.costHint")}</InfoHint>}>
    {models?.coverage === "partial" && <p className="mb-2 text-[13px] text-ink-secondary">{t("computer.usage.modelsPartial")}</p>}
    {rows.length === 0 ? <p className="text-[14px] text-ink-secondary">
      {t(models?.coverage === "ready" && window.totalTokens === 0 ? "computer.usage.modelsEmpty" : "computer.usage.modelsUnavailable")}
    </p> : <>
      {window.tokenCoverage === "partial" && <p className="mb-2 text-[13px] text-ink-secondary">{t("computer.usage.recordedShare")}</p>}
      <ul className="divide-y divide-hairline/60 rounded-lg border border-hairline/60">
        {rows.map((row) => {
          const total = window.totalTokens;
          const share = window.tokenCoverage !== "unavailable" && total !== null && total > 0 && row.totalTokens <= total ? row.totalTokens / total : null;
          return <li key={row.model} className="grid min-w-0 gap-2 px-3 py-2.5 @min-[42rem]/usage:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] @min-[42rem]/usage:gap-4">
            <div className="min-w-0 text-[13px] tabular-nums">
              <p dir="auto" className="font-medium text-ink [overflow-wrap:anywhere]">{row.model}</p>
              <div className="flex flex-wrap justify-between gap-x-2 text-ink-secondary">
                <span>{t("computer.usage.modelTokenTotal", { total: metricText(row.totalTokens) })}</span>
                <span>{share === null ? t("computer.usage.shareUnavailable") : percent.format(share)}</span>
              </div>
              {share !== null && <div aria-hidden="true" className="mt-1 h-1 overflow-hidden rounded-sm bg-inset">
                <div className="h-full bg-accent/75" style={{ width: `${share * 100}%` }} />
              </div>}
            </div>
            <UsageTokenBreakdown {...row} asRows />
          </li>;
        })}
      </ul>
    </>}
  </UsagePeriodSection>;
}
