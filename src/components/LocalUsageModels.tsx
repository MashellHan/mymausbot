import { useState } from "react";
import type { UsageWindow } from "@/lib/local-usage-view";
import { activeLocale, t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { formatUsd, usdText } from "@/lib/usage";
import { InfoHint } from "./InfoHint";
import { UsagePeriodSection, shortUsagePeriods } from "./LocalUsageTables";
import { metricText } from "./LocalUsageValues";

type Cost = NonNullable<UsageWindow["tokenDetails"]>["estimatedCost"];

export function costText(estimate?: Cost) {
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

function usableCost(estimate?: Cost): number | null {
  const usd = estimate?.usd;
  return estimate?.coverage !== "unavailable" && typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : null;
}

function ShareBar({ share }: { share: number }) {
  return <div aria-hidden="true" className="mt-1 h-1 min-w-16 overflow-hidden rounded-sm bg-inset">
    <div className="h-full bg-accent/75" style={{ width: `${share * 100}%` }} />
  </div>;
}

const tableCell = "px-2 py-2 text-start align-top";
const numericCell = `${tableCell} whitespace-nowrap`;

type ShortPeriod = typeof shortUsagePeriods[number];

export function UsageModelPanel({ windows }: { windows: Record<ShortPeriod, UsageWindow> }) {
  const [period, setPeriod] = useState<ShortPeriod>("1");
  const [open, setOpen] = useState(true);
  const window = windows[period];
  const models = window.tokenDetails?.models;
  const rows = models?.coverage === "unavailable" ? [] : models?.rows.toSorted((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model, activeLocale())) ?? [];
  const percent = new Intl.NumberFormat(activeLocale(), { style: "percent", maximumFractionDigits: 1 });
  const title = t("computer.usage.modelUsage");
  const estimate = window.tokenDetails?.estimatedCost;
  const rawTotal = usableCost(estimate);
  const modelCostTotal = rows.reduce((total, row) => total + (usableCost(row.estimatedCost) ?? 0), 0);
  const matchingScope = estimate?.coverage === "partial" ||
    models?.coverage === "ready" && rows.every((row) => row.estimatedCost.coverage === "ready" && usableCost(row.estimatedCost) !== null);
  const comparableTotal = rawTotal !== null && rawTotal > 0 && matchingScope &&
    Math.abs(rawTotal - modelCostTotal) <= rawTotal * Number.EPSILON * rows.length ? rawTotal : null;
  const columns = [t("usage.history.byModel"), t("computer.usage.modelTotalTokens"),
    t("computer.usage.cachedInput"), t("computer.usage.freshInput"), t("computer.usage.output"), t("computer.usage.estimatedCost")];
  return <UsagePeriodSection kind="models" heading={title} periods={shortUsagePeriods} period={period} onPeriodChange={setPeriod} window={window}
    open={open} onToggle={() => setOpen((current) => !current)}
    hint={<InfoHint label={t("computer.usage.costHelp")}>{t("computer.usage.costHint")}</InfoHint>}>
    {rows.length === 0 ? <p className="text-[14px] text-ink-secondary">
      {t(models?.coverage === "ready" && window.totalTokens === 0 ? "computer.usage.modelsEmpty" : "computer.usage.modelsUnavailable")}
    </p> : <div role="region" aria-label={title} tabIndex={0} data-usage-model-table-region
      className="overflow-x-auto rounded-lg border border-hairline/60 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
      <table className="w-full text-[13px] tabular-nums" data-usage-model-table>
        <caption className="sr-only">
          {title}
          {models?.coverage === "partial" && ` · ${t("computer.usage.modelsPartial")}`}
          {window.tokenCoverage === "partial" && ` · ${t("computer.usage.recordedShare")}`}
        </caption>
        <thead className="bg-inset text-ink-secondary"><tr>
          {columns.map((label) => <th key={label} scope="col" className={cn(numericCell, "font-medium")}>{label}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-hairline/60 text-ink">
          {rows.map((row) => {
            const total = window.totalTokens;
            const share = window.tokenCoverage !== "unavailable" && total !== null && total > 0 && row.totalTokens <= total ? row.totalTokens / total : null;
            const usd = usableCost(row.estimatedCost);
            const costShare = comparableTotal !== null && usd !== null ? Math.min(1, usd / comparableTotal) : null;
            const estimatedShare = costShare === null ? null : percent.format(costShare);
            const costShareLabel = estimatedShare === null ? undefined : t(estimate?.coverage === "partial"
              ? "computer.usage.recordedCostShare" : "computer.usage.estimatedCostShare", { share: estimatedShare });
            return <tr key={row.model}>
              <th scope="row" dir="auto" className={cn(tableCell, "w-[22%] min-w-40 font-medium [overflow-wrap:anywhere]")}>{row.model}</th>
              <td className={numericCell}>
                {metricText(row.totalTokens)}
                <div data-usage-model-share className="mt-0.5 text-ink-secondary">
                  {share === null ? t("computer.usage.shareUnavailable") : <>
                    <span className="sr-only">{t("computer.usage.tokenShare")}{" "}</span>{percent.format(share)}
                    <ShareBar share={share} />
                  </>}
                </div>
              </td>
              <td className={numericCell}>{metricText(row.cacheRead)}</td>
              <td className={numericCell}>{metricText(row.input)}</td>
              <td className={numericCell}>{metricText(row.output)}</td>
              <td className={numericCell}>
                {costText(row.estimatedCost)}
                {costShare !== null && <div data-usage-cost-share title={costShareLabel} className="mt-0.5 text-ink-secondary">
                  <span aria-hidden="true">{estimatedShare}</span><span className="sr-only">{costShareLabel}</span>
                  <ShareBar share={costShare} />
                </div>}
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
  </UsagePeriodSection>;
}
