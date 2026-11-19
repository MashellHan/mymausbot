import { shiftUsageDay } from "../../shared/local-usage-range.ts";
import type { UsageTrendDay } from "./local-usage-view.ts";

export type UsageTrendBucket = UsageTrendDay & { endDay?: string };

function sum(values: (number | null)[], exact = false): number | null {
  if (!values.some((value) => value !== null) || exact && values.some((value) => value === null)) return null;
  const total = values.reduce<number>((total, value) => total + (value ?? 0), 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function weeklyUsageTrend(days: UsageTrendDay[]): UsageTrendBucket[] {
  const weeks = new Map<string, UsageTrendDay[]>();
  for (const day of days) {
    const weekday = new Date(`${day.day}T00:00:00Z`).getUTCDay();
    const monday = shiftUsageDay(day.day, -((weekday + 6) % 7));
    const week = weeks.get(monday) ?? [];
    week.push(day); weeks.set(monday, week);
  }
  return [...weeks.values()].map((week) => {
    const counts = (rows: Pick<UsageTrendDay, "prs" | "knownPrs" | "commits" | "knownCommits">[]) => ({
      prs: sum(rows.map((row) => row.prs), true), knownPrs: sum(rows.map((row) => row.knownPrs)),
      commits: sum(rows.map((row) => row.commits), true), knownCommits: sum(rows.map((row) => row.knownCommits)),
    });
    return { day: week[0]!.day, endDay: week.at(-1)!.day, ...counts(week),
      coverage: week.every((day) => day.coverage === "unavailable") ? "unavailable"
        : week.every((day) => day.coverage === "ready") ? "ready" : "partial",
      tokenStatus: week.every((day) => day.tokenStatus === "unavailable") ? "unavailable"
        : week.every((day) => day.tokenStatus === "ready") ? "ready" : "partial",
      newTokens: sum(week.map((day) => day.newTokens)), cacheRead: sum(week.map((day) => day.cacheRead)),
      totalTokens: sum(week.map((day) => day.totalTokens)),
      categories: { work: counts(week.map((day) => day.categories.work)),
        personal: counts(week.map((day) => day.categories.personal)), unclassified: counts(week.map((day) => day.categories.unclassified)) },
      wow: { prs: null, commits: null, newTokens: null, totalTokens: null },
    };
  });
}

export type TokenTrendMode = "types" | "models";
export const tokenTypeKeys = ["cacheRead", "input", "output"] as const;
type TokenType = typeof tokenTypeKeys[number];

export type TokenTrendSeries = { kind: "type"; key: TokenType } | { kind: "model"; key: string }
  | { kind: "other" | "unknown"; key: "other" | "unknown" };

export function tokenTrendStacks(days: UsageTrendDay[], buckets: UsageTrendBucket[], mode: TokenTrendMode) {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const modelTotals = new Map<string, number>();
  const points = buckets.map((bucket) => {
    const rows: UsageTrendDay[] = [];
    for (let date = bucket.day; date <= (bucket.endDay ?? bucket.day); date = shiftUsageDay(date, 1)) {
      const row = byDay.get(date);
      if (row && row.totalTokens !== null) rows.push(row);
    }
    const types = mode === "types" ? {
      cacheRead: sum(rows.map((day) => day.tokenDetails?.cacheRead ?? day.cacheRead)),
      input: sum(rows.map((day) => day.tokenDetails?.input ?? null)),
      output: sum(rows.map((day) => day.tokenDetails?.output ?? null)),
    } : null;
    const models = new Map<string, number>();
    if (mode === "models") {
      for (const day of rows) {
        const detail = day.tokenDetails?.models;
        if (!detail || detail.coverage === "unavailable") continue;
        for (const row of detail.rows) models.set(row.model, (models.get(row.model) ?? 0) + row.totalTokens);
      }
    }
    const knownTotal = types ? tokenTypeKeys.reduce((total, key) => total + (types[key] ?? 0), 0)
      : [...models.values()].reduce((total, tokens) => total + tokens, 0);
    if (bucket.totalTokens === null || knownTotal > bucket.totalTokens) {
      return { types: null, models: new Map<string, number>(), unknown: bucket.totalTokens };
    }
    for (const [model, tokens] of models) {
      if (tokens > 0) modelTotals.set(model, (modelTotals.get(model) ?? 0) + tokens);
    }
    return { types, models, unknown: bucket.totalTokens - knownTotal };
  });
  const ranked = [...modelTotals].sort(([a, aTokens], [b, bTokens]) => bTokens - aTokens || (a < b ? -1 : 1));
  const top = new Set(ranked.slice(0, 5).map(([name]) => name));
  const series: TokenTrendSeries[] = mode === "types" ? tokenTypeKeys.map((key) => ({ kind: "type", key }))
    : [...top].map((key) => ({ kind: "model", key }));
  if (ranked.length > top.size) series.push({ kind: "other", key: "other" });
  if (points.some(({ unknown }) => unknown !== null && unknown > 0)) series.push({ kind: "unknown", key: "unknown" });
  return { series, points: points.map((point) => {
    const other = [...point.models].reduce((total, [model, tokens]) => top.has(model) ? total : total + tokens, 0);
    return series.map((item) => item.kind === "type" ? point.types?.[item.key] ?? null
      : item.kind === "model" ? point.models.get(item.key) ?? 0 : item.kind === "other" ? other : point.unknown);
  }) };
}
