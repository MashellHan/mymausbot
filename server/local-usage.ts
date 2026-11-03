import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  LocalUsageCategory, LocalUsageCoverage, LocalUsagePrSourceCoverage, LocalUsageResponse,
  LocalUsageSourceCoverage, LocalUsageTokenStatus, LocalUsageTrendDay, LocalUsageWindow,
} from "../shared/local-dashboard.ts";

const CATEGORIES: LocalUsageCategory[] = ["work", "personal", "unclassified"];
const WINDOWS = [1, 7, 30] as const;
const DAY_MS = 86_400_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const CHINA_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

interface DailyCategory {
  prs: number | null;
  knownPrs: number;
  commits: number;
  input: number;
  output: number;
  cacheRead: number;
}

interface DailyRow {
  day: string;
  tokenStatus: LocalUsageTokenStatus;
  categories: Record<LocalUsageCategory, DailyCategory>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid activity aggregate");
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid activity count");
  return value as number;
}

function sum(values: number[]): number {
  return count(values.reduce((total, value) => total + value, 0));
}

function dayNumber(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid activity date");
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error("Invalid activity date");
  return timestamp;
}

function offsetDay(day: string, offset: number): string {
  return new Date(dayNumber(day) + offset * DAY_MS).toISOString().slice(0, 10);
}

function chinaDay(timestamp: number): string {
  const parts = Object.fromEntries(CHINA_DATE.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function category(raw: unknown): DailyCategory {
  const row = object(raw);
  const knownPrs = count(row.knownPrs);
  const prs = row.prs === null ? null : count(row.prs);
  const input = count(row.input);
  const output = count(row.output);
  const cacheRead = count(row.cacheRead);
  if (prs !== null && prs !== knownPrs || count(row.cacheWrite) > input || count(row.reasoning) > output ||
      count(row.newTokens) !== input + output) throw new Error("Invalid activity accounting");
  return { prs, knownPrs, commits: count(row.commits), input, output, cacheRead };
}

function rows(raw: unknown, captureDay: string): Map<string, DailyRow> {
  if (!Array.isArray(raw) || raw.length > 31) throw new Error("Invalid activity days");
  const daily = new Map<string, DailyRow>();
  const oldest = offsetDay(captureDay, -30);
  for (const value of raw) {
    const row = object(value);
    const day = row.day;
    dayNumber(day);
    if (typeof day !== "string" || day < oldest || day > captureDay || daily.has(day)) throw new Error("Invalid activity day range");
    if (row.tokenStatus !== "ready" && row.tokenStatus !== "partial" && row.tokenStatus !== "unavailable") throw new Error("Invalid token coverage");
    const rawCategories = object(row.categories);
    const categories = {} as Record<LocalUsageCategory, DailyCategory>;
    for (const key of CATEGORIES) categories[key] = category(rawCategories[key]);
    daily.set(day, { day, tokenStatus: row.tokenStatus, categories });
  }
  return daily;
}

function sourceCoverage(raw: unknown): LocalUsageSourceCoverage {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid activity sources");
  const coverage = { total: raw.length, ready: 0, partial: 0, stale: 0, missing: 0 };
  for (const value of raw) {
    const status = object(value).status;
    if (status === "ok") coverage.ready++;
    else if (status === "partial" || status === "stale" || status === "missing") coverage[status]++;
    else throw new Error("Invalid activity source status");
  }
  return coverage;
}

function prSourceCoverage(raw: unknown): LocalUsagePrSourceCoverage {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid PR sources");
  const coverage = { total: raw.length, ready: 0, stale: 0, unavailable: 0, missing: 0 };
  for (const value of raw) {
    const status = object(value).status;
    if (status === "ok") coverage.ready++;
    else if (status === "stale" || status === "unavailable" || status === "missing") coverage[status]++;
    else throw new Error("Invalid PR source status");
  }
  return coverage;
}

function totals(row: DailyRow) {
  const categories = CATEGORIES.map((key) => row.categories[key]);
  return {
    knownPrs: sum(categories.map((value) => value.knownPrs)),
    prs: categories.every((value) => value.prs !== null) ? sum(categories.map((value) => value.prs!)) : null,
    commits: sum(categories.map((value) => value.commits)),
    newTokens: sum(categories.map((value) => value.input + value.output)),
    cacheRead: sum(categories.map((value) => value.cacheRead)),
  };
}

function buildWindow(days: 1 | 7 | 30, endDay: string, asOf: number, daily: Map<string, DailyRow>,
  sources: LocalUsageSourceCoverage, prs: LocalUsagePrSourceCoverage, prComplete: boolean): LocalUsageWindow {
  const startDay = offsetDay(endDay, 1 - days);
  const dates = Array.from({ length: days }, (_, index) => offsetDay(startDay, index));
  const present = dates.map((day) => daily.get(day)).filter((row): row is DailyRow => !!row);
  const missingDays = dates.filter((day) => !daily.has(day));
  const sourceObserved = sources.ready + sources.partial + sources.stale > 0;
  const unavailableTokenDays = dates.filter((day) => !sourceObserved || daily.get(day)?.tokenStatus === "unavailable" || !daily.has(day));
  const tokenDays = sourceObserved ? present.filter((row) => row.tokenStatus !== "unavailable") : [];
  const prObserved = prs.ready + prs.stale > 0;
  const sourceReady = sources.total > 0 && sources.ready === sources.total;
  const observed = present.map(totals);
  const tokenCoverage: LocalUsageTokenStatus = tokenDays.length === 0 ? "unavailable"
    : tokenDays.length === days && tokenDays.every((row) => row.tokenStatus === "ready") && sourceReady ? "ready" : "partial";
  const knownPrs = prObserved && present.length ? sum(observed.map((row) => row.knownPrs)) : null;
  const exactPrs = prObserved && prComplete && missingDays.length === 0 && observed.every((row) => row.prs !== null);
  const commits = sourceObserved && present.length ? sum(observed.map((row) => row.commits)) : null;
  const newTokens = tokenDays.length ? sum(tokenDays.map((row) => totals(row).newTokens)) : null;
  const cacheRead = tokenDays.length ? sum(tokenDays.map((row) => totals(row).cacheRead)) : null;
  const coverage: LocalUsageCoverage = !present.length || [knownPrs, commits, newTokens].every((value) => value === null) ? "unavailable"
    : tokenCoverage === "ready" && exactPrs && commits !== null ? "ready" : "partial";
  return { days, startDay, endDay, asOf, coverage, tokenCoverage, missingDays, unavailableTokenDays,
    prs: exactPrs ? sum(observed.map((row) => row.prs!)) : null, knownPrs, commits, newTokens, cacheRead };
}

function trend(window: LocalUsageWindow, daily: Map<string, DailyRow>, sources: LocalUsageSourceCoverage,
  prs: LocalUsagePrSourceCoverage, prComplete: boolean): LocalUsageTrendDay[] {
  const sourceObserved = sources.ready + sources.partial + sources.stale > 0;
  const prObserved = prs.ready + prs.stale > 0;
  const sourceReady = sources.total > 0 && sources.ready === sources.total;
  return Array.from({ length: 30 }, (_, index) => {
    const day = offsetDay(window.startDay, index);
    const row = daily.get(day);
    if (!row) return { day, coverage: "unavailable", tokenStatus: "unavailable", prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null };
    const values = totals(row);
    const tokenStatus = !sourceObserved ? "unavailable" : row.tokenStatus === "ready" && !sourceReady ? "partial" : row.tokenStatus;
    const exactPrs = prObserved && prComplete && values.prs !== null;
    const knownPrs = prObserved ? values.knownPrs : null;
    const commits = sourceObserved ? values.commits : null;
    const newTokens = tokenStatus === "unavailable" ? null : values.newTokens;
    return { day, coverage: [knownPrs, commits, newTokens].every((value) => value === null) ? "unavailable"
      : tokenStatus === "ready" && exactPrs && sourceReady ? "ready" : "partial", tokenStatus,
      prs: exactPrs ? values.prs : null, knownPrs, commits, newTokens,
      cacheRead: tokenStatus === "unavailable" ? null : values.cacheRead };
  });
}

function project(raw: unknown, now: number): LocalUsageResponse {
  const snapshot = object(raw);
  const asOf = count(snapshot.updatedAt);
  if (snapshot.version !== 1 || snapshot.timeZone !== "Asia/Shanghai" || !asOf || asOf > now + 5 * 60_000 ||
      (snapshot.status !== "ready" && snapshot.status !== "partial")) throw new Error("Invalid activity snapshot");
  const endDay = chinaDay(asOf);
  const daily = rows(snapshot.daily, endDay);
  const sources = sourceCoverage(snapshot.sources);
  const prs = prSourceCoverage(snapshot.prSources);
  const rawPrCoverage = object(snapshot.prCoverage);
  const prCoverage = {} as Record<LocalUsageCategory, "ready" | "partial">;
  for (const key of CATEGORIES) {
    const value = rawPrCoverage[key];
    if (value !== "ready" && value !== "partial") throw new Error("Invalid PR coverage");
    prCoverage[key] = value;
  }
  const prComplete = prs.total > 0 && prs.ready === prs.total && CATEGORIES.every((key) => prCoverage[key] === "ready");
  const windows = {} as Record<"1" | "7" | "30", LocalUsageWindow>;
  for (const days of WINDOWS) windows[String(days) as "1" | "7" | "30"] = buildWindow(days, endDay, asOf, daily, sources, prs, prComplete);
  const stale = chinaDay(now) !== endDay || now - asOf > STALE_AFTER_MS;
  const status = stale ? "stale" : snapshot.status === "ready" && windows["30"].coverage === "ready" ? "ready" : "partial";
  return { status, asOf, timeZone: "Asia/Shanghai", sourceCoverage: sources, prSourceCoverage: prs,
    prCoverage, windows, trend: trend(windows["30"], daily, sources, prs, prComplete) };
}

const unavailable: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
  sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };

export function createLocalUsageProvider({ file = join(homedir(), ".local", "share", "agent-town", "activity", "latest.json"), now = Date.now }: {
  file?: string; now?: () => number;
} = {}) {
  let lastGood: LocalUsageResponse | null = null;
  return {
    async get(): Promise<LocalUsageResponse> {
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Invalid activity file");
        const data = await readFile(file, "utf8");
        if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error("Invalid activity file");
        lastGood = project(JSON.parse(data), now());
        return lastGood;
      } catch {
        return lastGood ? { ...lastGood, status: "stale" } : unavailable;
      }
    },
  };
}
