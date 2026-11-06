import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { LocalUsageCategory, LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../../shared/local-dashboard";
import { cn } from "@/lib/cn";
import { metricText, prText, PrCount, UsageChange, usageMetrics as metrics, type UsageMetric as Metric } from "./LocalUsageValues";
import { UsageDailyTable, UsageRepositoryTable } from "./LocalUsageTables";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";

const ROUTE = "/api/local-dashboard/usage";
const REFRESH_MS = 5 * 60 * 1_000;
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

function coverageText(coverage: LocalUsageWindow["coverage"]) {
  return t(coverage === "ready" ? "computer.usage.coverage.ready"
    : coverage === "partial" ? "computer.usage.coverage.partial" : "computer.usage.coverage.unavailable");
}

function WindowCard({ window }: { window: LocalUsageWindow }) {
  const rows = [
    ["prs", prText(window.prs, window.knownPrs), window.comparison.prs],
    ["commits", metricText(window.commits), window.comparison.commits],
    ["totalTokens", window.totalTokens !== null && window.totalTokens >= 1_000_000
      ? new Intl.NumberFormat(activeLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(window.totalTokens) : metricText(window.totalTokens), window.comparison.totalTokens],
  ] as const;
  return (
    <section className="min-w-0 rounded-xl border border-hairline/60 bg-card p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 className="text-[16px] font-semibold text-ink">{window.days === 1 ? t("computer.usage.windowOne") : t("computer.usage.window", { days: window.days })}</h3>
        <span className="text-[13px] tabular-nums text-ink-secondary">{window.startDay} – {window.endDay}</span>
        <span className={cn("ml-auto text-[12px]", window.coverage === "ready" ? "text-ink-secondary" : "text-warning")}>{coverageText(window.coverage)}</span>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2">
        {rows.map(([metric, value, comparison]) => (
          <div key={metric} className="min-w-0">
            <dt className="text-[13px] text-ink-secondary">{t(`computer.usage.metric.${metric}`)}</dt>
            <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 tabular-nums [overflow-wrap:anywhere]">
              <span title={metric === "totalTokens" ? metricText(window.totalTokens) : undefined} className="text-[18px] font-semibold text-ink">{metric === "prs" ? <PrCount prs={window.prs} knownPrs={window.knownPrs} /> : value}</span>
              <UsageChange value={comparison} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric={metric} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 border-t border-hairline/40 pt-2 text-[13px] tabular-nums">
        <div className="mb-1 grid grid-cols-[1fr_1fr_1fr] gap-2 text-ink-secondary" aria-hidden="true"><span /><span className="text-right">{t("computer.usage.metric.prs")}</span><span className="text-right">{t("computer.usage.metric.commits")}</span></div>
        {(["work", "personal", "unclassified"] as const).filter((key) => key !== "unclassified" || (window.categories[key].knownPrs ?? 0) + (window.categories[key].commits ?? 0) > 0).map((key) => <div key={key} data-usage-category-row={key} className="grid grid-cols-[1fr_1fr_1fr] gap-2 py-0.5">
          <span className="text-ink-secondary">{t(`computer.usage.category.${key}`)}</span>
          <span className="text-right text-ink"><span className="sr-only">{t("computer.usage.metric.prs")}: </span><PrCount prs={window.categories[key].prs} knownPrs={window.categories[key].knownPrs} />
            <UsageChange value={window.comparison.categories[key].prs} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric="prs" className="block text-[13px] text-ink-secondary" /></span>
          <span className="text-right text-ink"><span className="sr-only">{t("computer.usage.metric.commits")}: </span>{metricText(window.categories[key].commits)}
            <UsageChange value={window.comparison.categories[key].commits} startDay={window.comparison.startDay} endDay={window.comparison.endDay} metric="commits" className="block text-[13px] text-ink-secondary" /></span>
        </div>)}
      </div>
      {window.missingDays.length > 0 && <p className="mt-2 text-[13px] text-warning">{t("computer.usage.missingDays", { count: window.missingDays.length })}</p>}
      {window.unavailableTokenDays.length > 0 && <p className="mt-1 text-[13px] text-warning">{t("computer.usage.unavailableTokenDays", { count: window.unavailableTokenDays.length })}</p>}
    </section>
  );
}

function trendValue(day: LocalUsageTrendDay, metric: Metric): number | null {
  return metric === "prs" ? day.prs ?? day.knownPrs : day[metric];
}

const categoryOrder = ["work", "personal", "unclassified"] as const;
const categoryTone: Record<LocalUsageCategory, string> = {
  work: "bg-accent/75", personal: "bg-ink-secondary/70", unclassified: "bg-warning/65",
};
const partialCategoryTone: Record<LocalUsageCategory, string> = {
  work: "bg-accent/35", personal: "bg-ink-secondary/35", unclassified: "bg-warning/30",
};

function categoryValue(day: LocalUsageTrendDay, metric: "prs" | "commits", category: LocalUsageCategory): number | null {
  const counts = day.categories[category];
  return metric === "prs" ? counts.prs ?? counts.knownPrs : counts.commits;
}

function TrendChart({ days, metric }: { days: LocalUsageTrendDay[]; metric: Metric }) {
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [focusDay, setFocusDay] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusedButton = useRef<HTMLButtonElement | null>(null);
  const lastFocused = useRef<Element | null>(null);
  const tooltipId = useId();
  const weekdayFormat = new Intl.DateTimeFormat(activeLocale(), { weekday: "short", timeZone: "UTC" });
  const values = days.map((day) => trendValue(day, metric));
  const max = Math.max(1, ...values.filter((value): value is number => value !== null));
  const active = days.find((day) => day.day === activeDay) ?? null;
  const rovingDay = days.some((day) => day.day === focusDay) ? focusDay : days[0]?.day;
  const showUnclassified = metric !== "totalTokens" && days.some((day) => (categoryValue(day, metric, "unclassified") ?? 0) > 0);
  useLayoutEffect(() => {
    const rememberFocus = (event: FocusEvent) => { lastFocused.current = event.target as Element; };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);
  useLayoutEffect(() => {
    if (activeDay && !active) setActiveDay(null);
    if (focusDay && focusDay !== rovingDay) {
      const restore = focusedButton.current?.dataset.usageDay === focusDay && lastFocused.current === focusedButton.current;
      setFocusDay(rovingDay ?? null);
      if (restore && rovingDay) buttons.current.get(rovingDay)?.focus();
    }
  }, [activeDay, active, focusDay, rovingDay]);
  return (
    <div className="relative min-w-0 rounded-lg bg-inset p-2.5" data-usage-trend={metric}>
      <h4 className="text-[13px] font-medium text-ink-secondary">{t(`computer.usage.metric.${metric}`)}</h4>
      <div className="mt-2 flex h-16 items-end gap-[2px]">
        {days.map((day, index) => {
          const date = new Date(`${day.day}T00:00:00Z`);
          const weekday = date.getUTCDay();
          const weekend = weekday === 0 || weekday === 6;
          const value = values[index];
          const label = metric === "prs" ? `${prText(day.prs, day.knownPrs)}${day.prs === null && day.knownPrs !== null ? ` · ${t("computer.usage.synced")}` : ""}` : metricText(value);
          const segments = metric === "totalTokens" ? [] : categoryOrder.map((category) => ({
            category, value: categoryValue(day, metric, category) ?? 0,
            partial: metric === "prs" && day.categories[category].prs === null,
          })).filter((segment) => segment.value > 0);
          const segmentTotal = segments.reduce((total, segment) => total + segment.value, 0);
          return <button key={day.day} type="button" data-usage-day={day.day} data-usage-weekend={weekend ? "" : undefined}
            ref={(element) => { if (element) buttons.current.set(day.day, element); else buttons.current.delete(day.day); }}
            tabIndex={day.day === rovingDay ? 0 : -1}
            aria-label={t("computer.usage.trendPoint", { day: `${day.day} ${weekdayFormat.format(date)}`, metric: t(`computer.usage.metric.${metric}`), value: label })}
            aria-describedby={activeDay === day.day ? tooltipId : undefined}
            onMouseEnter={() => setActiveDay(day.day)} onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) setActiveDay(null); }}
            onFocus={(event) => { focusedButton.current = event.currentTarget; setFocusDay(day.day); setActiveDay(day.day); }}
            onBlur={(event) => { setActiveDay(null); if (event.currentTarget.isConnected) focusedButton.current = null; }} onClick={() => setActiveDay(day.day)}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setActiveDay(null); return; }
              const next = event.key === "ArrowRight" ? (index + 1) % days.length : event.key === "ArrowLeft" ? (index + days.length - 1) % days.length
                : event.key === "Home" ? 0 : event.key === "End" ? days.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); buttons.current.get(days[next]!.day)?.focus();
            }}
            className={cn("relative flex h-full min-w-0 flex-1 items-end rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60", weekend && "bg-ink/[0.035]")}>
            {value === null ? <span aria-hidden="true" className="h-full w-full bg-warning/15" />
              : <span aria-hidden="true" className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
                style={{ height: value === 0 ? 0 : `${Math.max(5, value / max * 100)}%` }}>
                {metric === "totalTokens" ? <span className="h-full w-full bg-accent/75" />
                  : segmentTotal ? segments.map(({ category, value: part, partial }) => <span key={category} data-usage-category={category}
                    className={partial ? partialCategoryTone[category] : categoryTone[category]} style={{ height: `${part / segmentTotal * 100}%` }} />)
                    : <span className="h-full w-full bg-ink-secondary/30" />}
              </span>}
            {weekend && <span aria-hidden="true" data-usage-weekend-tick className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] h-px bg-ink/25" />}
          </button>;
        })}
      </div>
      {active && <div id={tooltipId} role="tooltip" data-usage-tooltip
        className="pointer-events-none absolute bottom-2 right-2 z-20 w-[calc(100%-1rem)] max-w-[360px] rounded-lg border border-hairline bg-panel px-2 py-1.5 text-[12px] text-ink shadow-lg">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 tabular-nums">
          <time dateTime={active.day} className="font-medium">{active.day} · {weekdayFormat.format(new Date(`${active.day}T00:00:00Z`))}</time>
          <span>{t(`computer.usage.metric.${metric}`)}: {metric === "prs" ? <PrCount prs={active.prs} knownPrs={active.knownPrs} /> : metricText(trendValue(active, metric))}</span>
        </div>
        {metric !== "totalTokens" && <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-secondary">
          {categoryOrder.filter((category) => category !== "unclassified" || showUnclassified).map((category) => <span key={category}>
            {t(`computer.usage.category.${category}`)}: {metric === "prs"
              ? <PrCount prs={active.categories[category].prs} knownPrs={active.categories[category].knownPrs} />
              : metricText(active.categories[category].commits)}
          </span>)}
        </div>}
      </div>}
    </div>
  );
}

export function LocalUsageView({ snapshot }: { snapshot: LocalUsageResponse | null }) {
  const windows = snapshot?.windows;
  const showUnclassified = snapshot?.trend.some((day) => (day.categories.unclassified.prs ?? day.categories.unclassified.knownPrs ?? 0) > 0
    || (day.categories.unclassified.commits ?? 0) > 0) ?? false;
  return (
    <div className="@container/usage min-h-0 flex-1 overflow-y-auto px-4 pb-5" data-testid="local-usage-panel">
      <header className="mb-3 pt-2">
        <h2 className="text-[18px] font-semibold text-ink">{t("computer.usage.heading")}</h2>
        {snapshot?.asOf != null ? <p className="mt-1 text-[13px] text-ink-secondary"><time dateTime={new Date(snapshot.asOf).toISOString()}>{t("computer.usage.asOf", { time: asOfTime(snapshot.asOf) })}</time></p> : null}
      </header>
      {snapshot === null ? <p role="status" className="text-[14px] text-ink-secondary">{t("computer.usage.loading")}</p> : null}
      {snapshot?.status === "stale" ? <p role="status" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[14px] text-warning">{t("computer.usage.stale")}</p> : null}
      {snapshot?.status === "partial" ? <p role="status" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[14px] text-warning">{t("computer.usage.partial")}</p> : null}
      {snapshot?.status === "unavailable" ? <p role="status" className="rounded-lg bg-inset px-3 py-3 text-[14px] text-ink-secondary">{t("computer.usage.noData")}</p> : null}
      {windows && <>
        <div className="grid grid-cols-1 gap-2 @min-[42rem]/usage:grid-cols-3">
          {(["1", "7", "30"] as const).map((key) => <WindowCard key={key} window={windows[key]} />)}
        </div>
        <section className="mt-4">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3 className="text-[16px] font-semibold text-ink">{t("computer.usage.trend")}</h3>
            <span className="text-[13px] tabular-nums text-ink-secondary">{windows["30"].startDay} – {windows["30"].endDay}</span>
          </div>
          <div data-usage-category-legend className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-secondary">
            {categoryOrder.filter((category) => category !== "unclassified" || showUnclassified).map((category) => <span key={category} className="inline-flex items-center gap-1">
              <span aria-hidden="true" className={cn("size-2 rounded-sm", categoryTone[category])} />{t(`computer.usage.category.${category}`)}
            </span>)}
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3">
            {metrics.map((metric) => <TrendChart key={metric} days={snapshot.trend} metric={metric} />)}
          </div>
          <UsageDailyTable days={snapshot.trend} />
        </section>
        <UsageRepositoryTable windows={windows} />
      </>}
    </div>
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
      try {
        const next = await api<LocalUsageResponse>(ROUTE, { background: true, signal: controller.signal, timeoutMs: 5_000 });
        if (active) setSnapshot((previous) => next.status === "unavailable" && previous?.asOf != null ? { ...previous, status: "stale" } : next);
      } catch (error) {
        if (active) setSnapshot((previous) => error instanceof ApiError && (error.status === 401 || error.status === 403) ? unavailable
          : previous?.asOf != null ? { ...previous, status: "stale" } : unavailable);
      } finally {
        if (active) timer = setTimeout(refresh, REFRESH_MS);
      }
    };
    void refresh();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [visible]);

  return <LocalUsageView snapshot={snapshot} />;
}
