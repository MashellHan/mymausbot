import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LocalUsageCategory, LocalUsageResponse } from "../../shared/local-dashboard";
import { cn } from "@/lib/cn";
import { localUsageView, retainUsageSnapshot, type UsageTrendDay, type UsageWindow } from "@/lib/local-usage-view";
import { tokenTrendStacks, weeklyUsageTrend, type TokenTrendMode, type TokenTrendSeries, type UsageTrendBucket } from "@/lib/local-usage-trends";
import { usageTrendRanges, type UsageTrendRange } from "../../shared/local-usage-range";
import { metricText, observedCountText, UsageCount, UsageChange, useUsageMetricHint, UsageSourceContext, usageMetrics as metrics, type UsageMetric as Metric } from "./LocalUsageValues";
import { UsageDailyTable, UsageRepositoryTable, shortUsagePeriods } from "./LocalUsageTables";
import { costText, UsageModelPanel } from "./LocalUsageModels";
import { InfoHint } from "./InfoHint";
import { Select } from "./Select";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";

const ROUTE = "/api/local-dashboard/usage";
const REFRESH_MS = 5_000;
const unavailable: LocalUsageResponse = {
  status: "unavailable", asOf: null, timeZone: "Asia/Shanghai", sourceCoverage: null,
  prSourceCoverage: null, prCoverage: null, windows: null, trend: [],
};

function asOfTime(value: number) {
  return new Date(value).toLocaleString(activeLocale(), {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
}

function tokenComparisonUnavailableHint(window: UsageWindow) {
  if (window.totalTokens === null) return t("computer.usage.tokenPeriodUnavailable");
  if (window.comparison.unavailableTokenDays.length) return t("computer.usage.tokenHistoryMissing", {
    count: window.comparison.unavailableTokenDays.length,
  });
  if (window.unavailableTokenDays.length) return t("computer.usage.unavailableTokenDays", { count: window.unavailableTokenDays.length });
  return t("computer.usage.tokenCollectionIncomplete");
}

function WindowCard({ window }: { window: UsageWindow }) {
  const usageMetricHint = useUsageMetricHint();
  const details = window.tokenDetails;
  const cachedInput = window.cacheRead;
  const freshInput = details?.input ?? null;
  const output = details?.output ?? null;
  const cacheRatio = cachedInput !== null && freshInput !== null && output !== null
    && freshInput + output === window.newTokens && cachedInput + freshInput > 0
    ? new Intl.NumberFormat(activeLocale(), { style: "percent", maximumFractionDigits: 1 }).format(cachedInput / (cachedInput + freshInput))
    : null;
  const tokenCoverageHint = window.tokenCoverage === "partial" ? t("computer.usage.tokensPartial") : undefined;
  const tokenTotalTitle = [metricText(window.totalTokens), tokenCoverageHint].filter(Boolean).join(" · ");
  const rows = [
    ["prs", null, window.comparison.prs ?? window.comparison.known?.prs ?? null],
    ["commits", null, window.comparison.commits ?? window.comparison.known?.commits ?? null],
    ["totalTokens", window.totalTokens !== null && window.totalTokens >= 1_000_000
      ? new Intl.NumberFormat(activeLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(window.totalTokens) : metricText(window.totalTokens), window.comparison.totalTokens],
  ] as const;
  return (
    <section className="min-w-0 rounded-xl border border-hairline/60 bg-card p-3">
      <div className="flex items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <h3 className="text-[16px] font-semibold text-ink">{window.days === 1 ? t("computer.usage.windowOne") : t("computer.usage.window", { days: window.days })}</h3>
          <span className="text-[13px] tabular-nums text-ink-secondary">{window.startDay} – {window.endDay}</span>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        {rows.map(([metric, value, comparison]) => (
          <div key={metric} className="min-w-0">
            <dt title={usageMetricHint(metric)} className="text-[13px] text-ink-secondary">{t(`computer.usage.metric.${metric}`)}</dt>
            <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 tabular-nums [overflow-wrap:anywhere]">
              <span title={metric === "totalTokens" ? tokenTotalTitle : undefined} aria-description={metric === "totalTokens" ? tokenCoverageHint : undefined} className="text-[18px] font-semibold text-ink">{metric === "prs" ? <UsageCount value={window.prs} known={window.knownPrs} /> : metric === "commits" ? <UsageCount value={window.commits} known={window.knownCommits} /> : value}</span>
              <UsageChange value={comparison} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric={metric}
                periodDays={window.days} known={metric !== "totalTokens" && window.comparison[metric] === null && comparison !== null}
                unavailableHint={metric === "totalTokens" && comparison === null ? tokenComparisonUnavailableHint(window) : undefined} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 border-t border-hairline/40 pt-2">
        <dl data-usage-token-breakdown className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-1 text-[13px] tabular-nums">
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <dt className="text-ink-secondary">{t("computer.usage.cachedInput")}</dt>
            <dd className="text-ink">{metricText(cachedInput)}{cacheRatio === null ? null : ` (${cacheRatio})`}</dd>
          </div>
          <div className="min-w-0 [overflow-wrap:anywhere]">
            <dt className="text-ink-secondary">{t("computer.usage.estimatedCost")}</dt>
            <dd className="text-ink">{costText(details?.estimatedCost)}</dd>
          </div>
        </dl>
      </div>
      <div className="mt-2 border-t border-hairline/40 pt-2 text-[13px] tabular-nums">
        <div className="mb-1 grid grid-cols-[1fr_1fr_1fr] gap-2 text-ink-secondary" aria-hidden="true"><span /><span className="text-right">{t("computer.usage.metric.prs")}</span><span className="text-right">{t("computer.usage.metric.commits")}</span></div>
        {(["work", "personal", "unclassified"] as const).filter((key) => key !== "unclassified" || (window.categories[key].knownPrs ?? 0) + (window.categories[key].commits ?? window.categories[key].knownCommits ?? 0) > 0).map((key) => {
          const change = (metric: "prs" | "commits") => {
            const exact = window.comparison.categories[key][metric];
            const value = exact ?? window.comparison.knownCategories?.[key][metric] ?? null;
            return { value, known: exact === null && value !== null };
          };
          const prs = change("prs"), commits = change("commits");
          return (
            <div key={key} data-usage-category-row={key} className="grid grid-cols-[1fr_1fr_1fr] gap-2 py-0.5">
              <span className="text-ink-secondary">{t(`computer.usage.category.${key}`)}</span>
              <span className="text-right text-ink"><span className="sr-only">{t("computer.usage.metric.prs")}: </span><UsageCount value={window.categories[key].prs} known={window.categories[key].knownPrs} />
                <UsageChange value={prs.value} known={prs.known} periodDays={window.days} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric="prs" className="block text-[13px] text-ink-secondary" /></span>
              <span className="text-right text-ink"><span className="sr-only">{t("computer.usage.metric.commits")}: </span><UsageCount value={window.categories[key].commits} known={window.categories[key].knownCommits} />
                <UsageChange value={commits.value} known={commits.known} periodDays={window.days} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric="commits" className="block text-[13px] text-ink-secondary" /></span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function trendValue(day: UsageTrendDay, metric: Metric): number | null {
  return metric === "prs" ? day.prs ?? day.knownPrs : metric === "commits" ? day.commits ?? day.knownCommits : day.totalTokens;
}

function trendCountText(day: UsageTrendDay, metric: "prs" | "commits") {
  return observedCountText(day[metric], metric === "prs" ? day.knownPrs : day.knownCommits);
}

const categoryOrder = ["work", "personal", "unclassified"] as const;
const categoryTone: Record<LocalUsageCategory, string> = {
  work: "bg-accent/75", personal: "bg-ink-secondary/70", unclassified: "bg-warning/65",
};
const partialCategoryTone: Record<LocalUsageCategory, string> = {
  work: "bg-accent/35", personal: "bg-ink-secondary/35", unclassified: "bg-warning/30",
};

function categoryValue(day: UsageTrendDay, metric: "prs" | "commits", category: LocalUsageCategory): number | null {
  const counts = day.categories[category];
  return metric === "prs" ? counts.prs ?? counts.knownPrs : counts.commits ?? counts.knownCommits;
}

const tokenTrendModes = ["types", "models", "agents"] as const;
const tokenModeLabels = { types: "tokenTypes", models: "tokenModels", agents: "tokenAgents" } as const;
const tokenLabels = { cacheRead: "cachedInput", input: "freshInput", output: "output" } as const;
const seriesTones = ["bg-accent/80", "bg-success/75", "bg-warning/75", "bg-ink-secondary/75", "bg-accent/45"] as const;

function tokenSeriesLabel(series: TokenTrendSeries, mode: TokenTrendMode) {
  if (series.kind === "type") return t(`computer.usage.${tokenLabels[series.key]}`);
  if (series.kind === "model") return series.key;
  if (series.kind === "agent") return series.name;
  if (mode === "agents") return t("computer.usage.tokenUnattributed");
  return t(series.kind === "other" ? "computer.usage.otherModels" : mode === "types" ? "computer.usage.breakdownUnavailable" : "computer.usage.unattributedTokens");
}

function tokenSeriesTone(series: TokenTrendSeries, index: number) {
  if (series.kind === "other") return "bg-ink-secondary/35";
  if (series.kind === "unknown") return "bg-[repeating-linear-gradient(135deg,transparent_0_2px,var(--color-ink-secondary)_2px_3px)] opacity-60";
  return seriesTones[index % seriesTones.length];
}

function TrendChart({ days, metric, weekly, range, tokenDays }: { days: UsageTrendBucket[]; metric: Metric; weekly: boolean; range: UsageTrendRange; tokenDays?: UsageTrendDay[] }) {
  const usageMetricHint = useUsageMetricHint();
  const [mode, setMode] = useState<TokenTrendMode>("models");
  const stack = useMemo(() => tokenDays && tokenTrendStacks(tokenDays, days, mode), [tokenDays, days, mode]);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<{ day: string; series: TokenTrendSeries } | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusedButton = useRef<HTMLButtonElement | null>(null);
  const lastFocused = useRef<Element | null>(null);
  const tooltipId = useId();
  const weekdayFormat = new Intl.DateTimeFormat(activeLocale(), { weekday: "short", timeZone: "UTC" });
  const percent = new Intl.NumberFormat(activeLocale(), { style: "percent", maximumFractionDigits: 1 });
  const values = days.map((day) => trendValue(day, metric));
  const max = Math.max(1, ...values.filter((value): value is number => value !== null));
  const activeIndex = days.findIndex((day) => day.day === activeDay);
  const active = days[activeIndex];
  const tokenTotal = active?.totalTokens ?? 0;
  const tokenRows = stack && mode !== "types" && active?.totalTokens != null ? stack.series.flatMap((series, index) => {
    const amount = stack.points[activeIndex]?.[index];
    return amount || (series.kind === "agent" && amount === 0) ? [{ series, amount, index }] : [];
  }).sort((a, b) => b.amount - a.amount) : [];
  const teams = new Map<string, { name: string; total: number; members: typeof tokenRows }>();
  for (const row of tokenRows) {
    if (row.series.kind !== "agent") continue;
    const team = teams.get(row.series.teamId) ?? { name: row.series.teamName, total: 0, members: [] };
    team.total += row.amount;
    team.members.push(row);
    teams.set(row.series.teamId, team);
  }
  const partialTeamTotal = active?.tokenStatus !== "ready" || tokenRows.some(({ series }) => series.kind === "unknown");
  const tokenRow = ({ series, amount, index }: typeof tokenRows[number]) => {
    const highlighted = hoveredSegment?.day === active?.day
      && hoveredSegment?.series.kind === series.kind && hoveredSegment.series.key === series.key;
    return <tr key={index} data-usage-token-row={series.key} data-usage-token-highlighted={highlighted || undefined}
      className={highlighted ? "bg-raised" : undefined}>
      <th scope="row" dir="auto" className={cn("py-0.5 pe-3 text-start align-top font-normal [overflow-wrap:anywhere] text-ink-secondary", series.kind === "agent" && "ps-2")}>{tokenSeriesLabel(series, mode)}</th>
      <td className="whitespace-nowrap py-0.5 pe-3 text-start align-top text-ink">{metricText(amount)}</td>
      <td className="whitespace-nowrap py-0.5 text-start align-top text-ink">
        {tokenTotal > 0 && (mode === "agents" || series.kind === "model" || series.kind === "other") ? percent.format(amount / tokenTotal) : "—"}
      </td>
    </tr>;
  };
  const showDay = (day: string) => {
    setActiveDay(day);
    setHoveredSegment((segment) => segment?.day === day ? segment : null);
  };
  useLayoutEffect(() => { setHoveredSegment(null); }, [range]);
  const rovingDay = days.some((day) => day.day === focusDay) ? focusDay : days[0]?.day;
  const showUnclassified = metric !== "totalTokens" && days.some((day) => (categoryValue(day, metric, "unclassified") ?? 0) > 0);
  useLayoutEffect(() => {
    const rememberFocus = (event: FocusEvent) => { lastFocused.current = event.target as Element; };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);
  useLayoutEffect(() => {
    if (activeDay && !active) { setActiveDay(null); setHoveredSegment(null); }
    if (focusDay && focusDay !== rovingDay) {
      const restore = focusedButton.current?.dataset.usageDay === focusDay && lastFocused.current === focusedButton.current;
      setFocusDay(rovingDay ?? null);
      if (restore && rovingDay) buttons.current.get(rovingDay)?.focus();
    }
  }, [activeDay, active, focusDay, rovingDay]);
  const weekMarkers = <div aria-hidden="true" className={cn("pointer-events-none absolute grid gap-[2px]", stack ? "inset-0" : "inset-y-0 inset-x-2.5")}
        style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` }}>
        {days.map((day, index) => !weekly && index > 0 && new Date(`${day.day}T00:00:00Z`).getUTCDay() === 1
          ? <span key={day.day} data-usage-week-start={day.day} className="-ml-px border-l border-ink/[0.08]" style={{ gridColumn: index + 1 }} /> : null)}
      </div>;
  return (
    <div className="relative min-w-0 rounded-lg bg-inset p-2.5" data-usage-trend={metric} data-usage-granularity={weekly ? "week" : "day"}>
      {!stack && weekMarkers}
      <div className="relative flex flex-wrap items-center justify-between gap-1">
        <h4 title={usageMetricHint(metric)} className="text-[13px] font-medium text-ink-secondary">{t(`computer.usage.metric.${metric}`)}</h4>
        {stack && <div role="group" aria-label={t("computer.usage.tokenBreakdown")} className="flex rounded-lg p-0.5">
          {tokenTrendModes.map((key) => <button key={key} type="button" aria-pressed={mode === key} onClick={() => { setMode(key); setHoveredSegment(null); }}
            className={cn("min-h-7 rounded-md px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
              mode === key ? "bg-card font-medium text-ink" : "text-ink-secondary hover:bg-ink/[0.06]")}>
            {t(`computer.usage.${tokenModeLabels[key]}`)}
          </button>)}
        </div>}
      </div>
      <div className="relative mt-2 flex h-16 items-end gap-[2px]">
        {stack && weekMarkers}
        {days.map((day, index) => {
          const date = new Date(`${day.day}T00:00:00Z`);
          const value = values[index];
          const label = (metric === "totalTokens" ? metricText(value) : trendCountText(day, metric))
            + `${(metric === "totalTokens" ? day.tokenStatus : day.coverage) === "partial" ? ` · ${t("computer.usage.coverage.partial")}` : ""}`;
          const segments = metric === "totalTokens" ? [] : categoryOrder.map((category) => ({
            category, value: categoryValue(day, metric, category) ?? 0,
            partial: day.categories[category][metric] === null,
          })).filter((segment) => segment.value > 0);
          const segmentTotal = segments.reduce((total, segment) => total + segment.value, 0);
          return <button key={day.day} type="button" data-usage-day={day.day}
            ref={(element) => { if (element) buttons.current.set(day.day, element); else buttons.current.delete(day.day); }}
            tabIndex={day.day === rovingDay ? 0 : -1}
            aria-label={t("computer.usage.trendPoint", { day: weekly ? `${day.day} – ${day.endDay}` : `${day.day} ${weekdayFormat.format(date)}`, metric: t(`computer.usage.metric.${metric}`), value: label })}
            aria-describedby={activeDay === day.day ? tooltipId : undefined}
            onMouseEnter={() => showDay(day.day)}
            onMouseLeave={(event) => { setHoveredSegment(null); if (document.activeElement !== event.currentTarget) setActiveDay(null); }}
            onFocus={(event) => { focusedButton.current = event.currentTarget; setFocusDay(day.day); showDay(day.day); }}
            onBlur={(event) => { setActiveDay(null); setHoveredSegment(null); if (event.currentTarget.isConnected) focusedButton.current = null; }}
            onClick={() => showDay(day.day)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setActiveDay(null); setHoveredSegment(null); return; }
              const next = event.key === "ArrowRight" ? (index + 1) % days.length : event.key === "ArrowLeft" ? (index + days.length - 1) % days.length
                : event.key === "Home" ? 0 : event.key === "End" ? days.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); buttons.current.get(days[next]!.day)?.focus();
            }}
            className="relative flex h-full min-w-0 flex-1 items-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60">
            {value === null ? <span aria-hidden="true" className="h-full w-full bg-warning/15" />
              : <span aria-hidden="true" className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
                style={{ height: value === 0 ? 0 : `${Math.max(5, value / max * 100)}%` }}>
                {stack ? stack.series.map((series, seriesIndex) => {
                  const part = stack.points[index]?.[seriesIndex];
                  return !!part && <span key={seriesIndex} data-usage-token-segment={series.key}
                    onMouseEnter={mode !== "types" ? () => setHoveredSegment({ day: day.day, series }) : undefined}
                    onMouseLeave={mode !== "types" ? () => setHoveredSegment(null) : undefined}
                    className={tokenSeriesTone(series, seriesIndex)} style={{ height: `${part / value * 100}%` }} />;
                })
                  : segmentTotal ? segments.map(({ category, value: part, partial }) => <span key={category} data-usage-category={category}
                    className={partial ? partialCategoryTone[category] : categoryTone[category]} style={{ height: `${part / segmentTotal * 100}%` }} />)
                    : <span className="h-full w-full bg-ink-secondary/30" />}
              </span>}
          </button>;
        })}
      </div>
      {stack && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-secondary" data-usage-token-legend>
        {stack.series.map((series, index) => <span key={index} className="inline-flex min-w-0 items-center gap-1">
          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-sm", tokenSeriesTone(series, index))} />
          <span dir="auto" className="[overflow-wrap:anywhere]">{tokenSeriesLabel(series, mode)}</span>
        </span>)}
        {values.includes(null) && <span>{t("computer.usage.tokenGapLegend")}</span>}
      </div>}
      {active && <div id={tooltipId} role="tooltip" data-usage-tooltip
        className={cn("pointer-events-none absolute right-2 z-20 w-[calc(100%-1rem)] max-w-[360px] rounded-lg border border-hairline bg-panel px-2.5 py-2 text-[12px] text-ink shadow-lg",
          stack ? "top-full" : "bottom-2")}>
        {stack ? <>
          <time dateTime={active.day} className="block font-medium tabular-nums">
            {active.day}{weekly ? ` – ${active.endDay}` : ` · ${weekdayFormat.format(new Date(`${active.day}T00:00:00Z`))}`}
          </time>
          {active.tokenStatus === "partial" && <p className={mode === "types" ? "mt-0.5 text-ink-secondary" : "sr-only"}>{t("computer.usage.tokensPartial")}</p>}
          {mode === "types" && <dl className="mt-1.5 grid grid-cols-1 gap-y-0.5 tabular-nums">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <dt className="text-ink-secondary">{t("computer.usage.metric.totalTokens")}</dt>
              <dd className="shrink-0 text-right font-medium text-ink">{metricText(active.totalTokens)}</dd>
            </div>
            {active.totalTokens !== null && stack.series.map((series, index) => {
              const amount = stack.points[activeIndex]?.[index] ?? null;
              return (series.kind === "type" || !!amount) && <div key={index} className="flex min-w-0 items-baseline justify-between gap-3">
                <dt dir="auto" className="min-w-0 [overflow-wrap:anywhere] text-ink-secondary">{tokenSeriesLabel(series, mode)}</dt>
                <dd className="shrink-0 text-right text-ink">{metricText(amount)}</dd>
              </div>;
            })}
          </dl>}
          {mode !== "types" && <table className="mt-1.5 w-full tabular-nums">
            <thead className="text-ink-secondary"><tr>
              <th scope="col" className="w-full pb-1 pe-3 text-start font-normal">{t(mode === "agents" ? "computer.usage.tokenAgents" : "usage.history.byModel")}</th>
              <th scope="col" className="whitespace-nowrap pb-1 pe-3 text-start font-normal">{t("computer.usage.metric.totalTokens")}</th>
              <th scope="col" className="whitespace-nowrap pb-1 text-start font-normal">{t("computer.usage.tokenShare")}</th>
            </tr></thead>
            <tbody>
              <tr data-usage-token-total>
                <th scope="row" className="py-0.5 pe-3 text-start align-top font-medium">{t("computer.usage.modelTotalTokens")}</th>
                <td className="whitespace-nowrap py-0.5 pe-3 text-start align-top font-medium">{metricText(active.totalTokens)}</td>
                <td />
              </tr>
              {[...teams].map(([id, team]) => <Fragment key={id}>
                <tr data-usage-token-team={id} className="border-t border-hairline/50 font-medium">
                  <th scope="row" className="py-0.5 pe-3 text-start align-top [overflow-wrap:anywhere]">
                    {t("computer.usage.tokenTeamTotal")} · <bdi>{team.name}</bdi>
                  </th>
                  <td className="whitespace-nowrap py-0.5 pe-3 text-start align-top"
                    aria-label={partialTeamTotal ? t("computer.usage.tokenTeamPartial", { count: metricText(team.total) }) : undefined}>
                    {partialTeamTotal ? "≥ " : ""}{metricText(team.total)}
                  </td>
                  <td />
                </tr>
                {team.members.map(tokenRow)}
              </Fragment>)}
              {tokenRows.filter(({ series }) => series.kind !== "agent").map(tokenRow)}
            </tbody>
          </table>}
        </> : <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 tabular-nums">
            <time dateTime={active.day} className="font-medium">{active.day}{weekly ? ` – ${active.endDay}` : ` · ${weekdayFormat.format(new Date(`${active.day}T00:00:00Z`))}`}</time>
            <span>{t(`computer.usage.metric.${metric}`)}: {metric === "totalTokens" ? metricText(active.totalTokens) : trendCountText(active, metric)}</span>
          </div>
          {metric !== "totalTokens" && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-secondary">
            {categoryOrder.filter((category) => category !== "unclassified" || showUnclassified).map((category) => <span key={category}>
              {t(`computer.usage.category.${category}`)}: {observedCountText(active.categories[category][metric], metric === "prs" ? active.categories[category].knownPrs : active.categories[category].knownCommits)}
            </span>)}
          </div>}
        </>}
      </div>}
    </div>
  );
}

export function LocalUsageView({ snapshot }: { snapshot: LocalUsageResponse | null }) {
  const [range, setRange] = useState<UsageTrendRange>("30");
  const view = snapshot && localUsageView(snapshot, range);
  const chartDays = view ? range === "6m" ? weeklyUsageTrend(view.trend) : view.trend : [];
  const windows = view?.windows;
  const showUnclassified = view?.trend.some((day) => (day.categories.unclassified.prs ?? day.categories.unclassified.knownPrs ?? 0) > 0
    || (day.categories.unclassified.commits ?? day.categories.unclassified.knownCommits ?? 0) > 0) ?? false;
  return (
    <UsageSourceContext.Provider value="repositories">
    <div className="@container/usage min-h-0 flex-1 overflow-y-auto px-4 pb-5" data-testid="local-usage-panel">
      <header className="mb-3 flex flex-wrap items-center gap-1 pt-2">
        <h2 className="text-[18px] font-semibold text-ink">{t("computer.usage.heading")}</h2>
        {view && (view.status === "partial" || view.status === "stale") && <InfoHint label={t("app.info")} warning>
          {view.status === "partial" && <p>{t("computer.usage.partial")}</p>}
          {view.status === "stale" && <p>{t("computer.usage.stale")}</p>}
        </InfoHint>}
        {windows && <InfoHint label={t("computer.usage.countDefinitions")}>
          <div className="space-y-1.5">
            <p>{t("computer.usage.repositoryPrHint")}</p>
            <p>{t("computer.usage.repositoryCommitHint")}</p>
            <p>{t("computer.usage.observedCountHint")}</p>
            {snapshot?.prSourceCoverage && <p>{t("computer.usage.prSources", { ...snapshot.prSourceCoverage })}</p>}
          </div>
        </InfoHint>}
        {view?.asOf != null ? <time data-usage-latest-update dateTime={new Date(view.asOf).toISOString()}
          className="ml-auto min-w-0 text-right text-[13px] tabular-nums text-ink-secondary [overflow-wrap:anywhere]">
          {t(view.status === "stale" ? "computer.usage.retainedUpdate" : "computer.usage.latestUpdate", { time: asOfTime(view.asOf) })}
        </time> : <span data-usage-latest-update className="ml-auto min-w-0 text-right text-[13px] text-ink-secondary">
          {t("computer.usage.latestUpdate", { time: "—" })}
        </span>}
      </header>
      {snapshot === null ? <p role="status" className="text-[14px] text-ink-secondary">{t("computer.usage.loading")}</p> : null}
      {view?.status === "unavailable" ? <p role="status" className="rounded-lg bg-inset px-3 py-3 text-[14px] text-ink-secondary">{t("computer.usage.noData")}</p> : null}
      {snapshot && windows && <>
        <div className="grid grid-cols-1 gap-2 @min-[42rem]/usage:grid-cols-3">
          {shortUsagePeriods.map((key) => <WindowCard key={key} window={windows[key]} />)}
        </div>
        <section className="mt-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="text-[16px] font-semibold text-ink">{t("computer.usage.trend")}</h3>
            <span data-usage-trend-range className="text-[13px] tabular-nums text-ink-secondary">{view.period?.startDay} – {view.period?.endDay}</span>
            <Select size="lg" aria-label={t("computer.usage.trendRange")} value={range} onChange={(event) => setRange(event.target.value as UsageTrendRange)}
              className="ml-auto max-w-full">
              {usageTrendRanges.map((value) => <option key={value} value={value}>{value === "6m"
                ? t("computer.usage.sixMonths") : t("computer.usage.periodDays", { days: value })}</option>)}
            </Select>
          </div>
          <div data-usage-category-legend className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
            {categoryOrder.filter((category) => category !== "unclassified" || showUnclassified).map((category) => <span key={category} className="inline-flex items-center gap-1">
              <span aria-hidden="true" className={cn("size-2 rounded-sm", categoryTone[category])} />{t(`computer.usage.category.${category}`)}
            </span>)}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3">
            {metrics.map((metric) => <TrendChart key={metric} days={chartDays} metric={metric} weekly={range === "6m"} range={range} tokenDays={metric === "totalTokens" ? view.trend : undefined} />)}
          </div>
          <UsageDailyTable days={view.trend} />
        </section>
        <UsageModelPanel windows={windows} />
        <UsageRepositoryTable key={range} windows={windows} historyWindow={view.sixtyDayRepositories} defaultPeriod={range === "60" ? "60" : "1"} />
      </>}
    </div>
    </UsageSourceContext.Provider>
  );
}

export function LocalUsagePanel() {
  const visible = usePageVisible();
  const [snapshot, setSnapshot] = useState<LocalUsageResponse | null>(null);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const started = Date.now();
      try {
        const next = await api<LocalUsageResponse>(ROUTE, { background: true, signal: controller.signal, timeoutMs: 5_000 });
        if (active) setSnapshot((previous) => retainUsageSnapshot(previous, next));
      } catch (error) {
        if (active) setSnapshot((previous) => error instanceof ApiError && (error.status === 401 || error.status === 403) ? unavailable
          : retainUsageSnapshot(previous, unavailable, true));
      } finally {
        if (active) timer = setTimeout(refresh, Math.max(0, REFRESH_MS - (Date.now() - started)));
      }
    };
    void refresh();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [visible]);

  return <LocalUsageView snapshot={snapshot} />;
}
