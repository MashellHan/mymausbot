import { useEffect, useState } from "react";
import type { LocalUsageResponse, LocalUsageTrendDay, LocalUsageWindow } from "../../shared/local-dashboard";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { api, ApiError } from "@/state/store";

const ROUTE = "/api/local-dashboard/usage";
const REFRESH_MS = 60 * 60 * 1_000;
const unavailable: LocalUsageResponse = {
  status: "unavailable", asOf: null, timeZone: "Asia/Shanghai", sourceCoverage: null,
  prSourceCoverage: null, prCoverage: null, windows: null, trend: [],
};

type Metric = "prs" | "commits" | "newTokens";
const metrics: Metric[] = ["prs", "commits", "newTokens"];

const number = (value: number) => value.toLocaleString(activeLocale());
const metricText = (value: number | null) => value === null ? t("computer.usage.unavailable") : number(value);
const prText = (prs: number | null, knownPrs: number | null) => prs !== null ? number(prs)
  : knownPrs === null ? t("computer.usage.unavailable")
  : knownPrs === 0 ? t("computer.usage.pending") : `≥${number(knownPrs)}`;

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
    ["computer.usage.metric.prs", prText(window.prs, window.knownPrs)],
    ["computer.usage.metric.commits", metricText(window.commits)],
    ["computer.usage.metric.newTokens", metricText(window.newTokens)],
  ] as const;
  return (
    <section className="min-w-0 rounded-xl border border-hairline/60 bg-card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <h3 className="text-[13px] font-semibold text-ink">{window.days === 1 ? t("computer.usage.windowOne") : t("computer.usage.window", { days: window.days })}</h3>
        <span className={cn("text-[11px]", window.coverage === "ready" ? "text-ink-tertiary" : "text-warning")}>{coverageText(window.coverage)}</span>
      </div>
      <p className="mt-0.5 text-[11px] tabular-nums text-ink-secondary">{window.startDay} – {window.endDay}</p>
      <p className="mt-0.5 text-[11px] text-ink-tertiary">{t("computer.usage.asOf", { time: asOfTime(window.asOf) })}</p>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] text-ink-secondary">{t(label)}</dt>
            <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {window.missingDays.length > 0 && <p className="mt-2 text-[11px] text-warning">{t("computer.usage.missingDays", { count: window.missingDays.length })}</p>}
      {window.unavailableTokenDays.length > 0 && <p className="mt-1 text-[11px] text-warning">{t("computer.usage.unavailableTokenDays", { count: window.unavailableTokenDays.length })}</p>}
    </section>
  );
}

function trendValue(day: LocalUsageTrendDay, metric: Metric): number | null {
  return metric === "prs" ? day.prs ?? day.knownPrs : day[metric];
}

function TrendChart({ days, metric }: { days: LocalUsageTrendDay[]; metric: Metric }) {
  const values = days.map((day) => trendValue(day, metric));
  const max = Math.max(1, ...values.filter((value): value is number => value !== null));
  return (
    <div className="min-w-0 rounded-lg bg-inset p-2.5">
      <h4 className="text-[11px] font-medium text-ink-secondary">{t(`computer.usage.metric.${metric}`)}</h4>
      <div aria-hidden="true" className="mt-2 flex h-14 items-end gap-[2px]">
        {days.map((day, index) => {
          const value = values[index];
          return <span key={day.day} className="flex h-full min-w-0 flex-1 items-end" title={`${day.day}: ${value === null ? t("computer.usage.unavailable") : number(value)}`}>
            {value === null ? <span className="h-full w-full bg-warning/15" />
              : <span className={cn("w-full rounded-t-sm", metric === "prs" && day.prs === null ? "bg-accent/40" : "bg-accent/75")}
                style={{ height: value === 0 ? 0 : `${Math.max(5, value / max * 100)}%` }} />}
          </span>;
        })}
      </div>
    </div>
  );
}

export function LocalUsageView({ snapshot }: { snapshot: LocalUsageResponse | null }) {
  const windows = snapshot?.windows;
  return (
    <div className="@container/usage min-h-0 flex-1 overflow-y-auto px-4 pb-5" data-testid="local-usage-panel">
      <header className="mb-4 pt-2">
        <h2 className="text-[15px] font-semibold text-ink">{t("computer.usage.heading")}</h2>
        <p className="mt-1 text-[11px] text-ink-secondary">{t("computer.usage.scope")}</p>
        {snapshot?.asOf != null ? <p className="mt-1 text-[11px] text-ink-tertiary"><time dateTime={new Date(snapshot.asOf).toISOString()}>{t("computer.usage.asOf", { time: asOfTime(snapshot.asOf) })}</time></p> : null}
      </header>
      {snapshot === null ? <p role="status" className="text-[12px] text-ink-secondary">{t("computer.usage.loading")}</p> : null}
      {snapshot?.status === "stale" ? <p role="status" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.usage.stale")}</p> : null}
      {snapshot?.status === "partial" ? <p role="status" className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">{t("computer.usage.partial")}</p> : null}
      {snapshot?.status === "unavailable" ? <p role="status" className="rounded-lg bg-inset px-3 py-3 text-[12px] text-ink-secondary">{t("computer.usage.noData")}</p> : null}
      {windows && <>
        <div className="grid grid-cols-1 gap-2 @min-[42rem]/usage:grid-cols-3">
          {(["1", "7", "30"] as const).map((key) => <WindowCard key={key} window={windows[key]} />)}
        </div>
        <p className="mt-3 text-[11px] leading-4 text-ink-tertiary">{t("computer.usage.provenance")}</p>
        <section className="mt-4 rounded-xl border border-hairline/60 bg-card p-3 text-[11px] leading-5 text-ink-secondary">
          <h3 className="text-[12px] font-semibold text-ink">{t("computer.usage.coverageHeading")}</h3>
          {snapshot.sourceCoverage && <p className="mt-1">{t("computer.usage.sources", { ...snapshot.sourceCoverage })}</p>}
          {snapshot.prSourceCoverage && <p>{t("computer.usage.prSources", { ...snapshot.prSourceCoverage })}</p>}
        </section>
        <section className="mt-5">
          <h3 className="text-[13px] font-semibold text-ink">{t("computer.usage.trend")}</h3>
          <p className="mt-0.5 text-[11px] tabular-nums text-ink-secondary">{windows["30"].startDay} – {windows["30"].endDay}</p>
          <p className="mt-1 text-[11px] text-ink-tertiary">{t("computer.usage.gapLegend")}</p>
          <div className="mt-3 grid grid-cols-1 gap-2 @min-[42rem]/usage:grid-cols-3">
            {metrics.map((metric) => <TrendChart key={metric} days={snapshot.trend} metric={metric} />)}
          </div>
          <div className="mt-3 overflow-x-auto rounded-lg border border-hairline/60 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60" role="region" aria-label={t("computer.usage.dailyValues")} tabIndex={0}>
            <table className="w-full min-w-[430px] text-[11px] tabular-nums">
              <thead className="bg-inset text-ink-secondary"><tr>
                <th scope="col" className="sticky left-0 bg-inset px-2 py-2 text-left font-medium">{t("computer.usage.day")}</th>
                {metrics.map((metric) => <th key={metric} scope="col" className="px-2 py-2 text-right font-medium">{t(`computer.usage.metric.${metric}`)}</th>)}
              </tr></thead>
              <tbody className="text-ink">
                {snapshot.trend.slice().reverse().map((day) => <tr key={day.day} className="border-t border-hairline/40">
                  <th scope="row" className="sticky left-0 bg-panel px-2 py-1.5 text-left font-medium">{day.day}</th>
                  <td className="px-2 py-1.5 text-right">{prText(day.prs, day.knownPrs)}</td>
                  <td className="px-2 py-1.5 text-right">{metricText(day.commits)}</td>
                  <td className="px-2 py-1.5 text-right">{metricText(day.newTokens)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        </section>
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
