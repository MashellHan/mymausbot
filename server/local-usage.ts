import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  LocalUsageCategory, LocalUsageCoverage, LocalUsagePrSourceCoverage, LocalUsageResponse,
  LocalUsageSourceCoverage, LocalUsageTokenStatus, LocalUsageTrendDay, LocalUsageWindow,
  LocalUsageCounts, LocalUsageRepositories, LocalUsageWeekChange,
} from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";

const CATEGORIES: LocalUsageCategory[] = ["work", "personal", "unclassified"];
const WINDOWS = [1, 7, 30] as const;
const DAY_MS = 86_400_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const STALE_AFTER_MS = 15 * 60 * 1000;
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
  sources: LocalUsageSourceCoverage, prs: LocalUsagePrSourceCoverage, prComplete: boolean,
  prCoverage: Record<LocalUsageCategory, "ready" | "partial">, observedCategories: Set<LocalUsageCategory>): LocalUsageWindow {
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
  const categories = {} as Record<LocalUsageCategory, LocalUsageCounts>;
  for (const key of CATEGORIES) {
    const observed = present.map((row) => row.categories[key]);
    const categoryObserved = prObserved && (observedCategories.has(key) || prCoverage[key] === "ready");
    const categoryPrs = categoryObserved && present.length ? sum(observed.map((row) => row.knownPrs)) : null;
    categories[key] = {
      knownPrs: categoryPrs,
      prs: prCoverage[key] === "ready" && missingDays.length === 0 && observed.every((row) => row.prs !== null) ? categoryPrs : null,
      commits: sourceObserved && present.length ? sum(observed.map((row) => row.commits)) : null,
    };
  }
  return { days, startDay, endDay, asOf, coverage, tokenCoverage, missingDays, unavailableTokenDays,
    prs: exactPrs ? sum(observed.map((row) => row.prs!)) : null, knownPrs, commits, newTokens, cacheRead, categories,
    repositories: { coverage: "unavailable", rows: [], unattributedPrs: knownPrs, unattributedCommits: commits, sharedCommits: 0 } };
}

function weekChange(current: number | null, previous: number | null): LocalUsageWeekChange {
  if (current === null || previous === null) return null;
  return previous === 0 ? current === 0 ? 0 : "new" : (current - previous) / previous * 100;
}

function trend(window: LocalUsageWindow, daily: Map<string, DailyRow>, sources: LocalUsageSourceCoverage,
  prs: LocalUsagePrSourceCoverage, prComplete: boolean): LocalUsageTrendDay[] {
  const sourceObserved = sources.ready + sources.partial + sources.stale > 0;
  const prObserved = prs.ready + prs.stale > 0;
  const sourceReady = sources.total > 0 && sources.ready === sources.total;
  return Array.from({ length: 30 }, (_, index) => {
    const day = offsetDay(window.startDay, index);
    const row = daily.get(day);
    if (!row) return { day, coverage: "unavailable", tokenStatus: "unavailable", prs: null, knownPrs: null, commits: null, newTokens: null, cacheRead: null,
      wow: { prs: null, commits: null, newTokens: null } };
    const values = totals(row);
    const tokenStatus = !sourceObserved ? "unavailable" : row.tokenStatus === "ready" && !sourceReady ? "partial" : row.tokenStatus;
    const exactPrs = prObserved && prComplete && values.prs !== null;
    const knownPrs = prObserved ? values.knownPrs : null;
    const commits = sourceObserved ? values.commits : null;
    const newTokens = tokenStatus === "unavailable" ? null : values.newTokens;
    const previous = daily.get(offsetDay(day, -7));
    const baseline = previous ? totals(previous) : null;
    const wow = {
      prs: weekChange(exactPrs ? values.prs : null, prComplete ? baseline?.prs ?? null : null),
      commits: weekChange(sourceReady ? commits : null, sourceReady ? baseline?.commits ?? null : null),
      newTokens: weekChange(tokenStatus === "ready" ? newTokens : null, sourceReady && previous?.tokenStatus === "ready" ? baseline?.newTokens ?? null : null),
    };
    return { day, coverage: [knownPrs, commits, newTokens].every((value) => value === null) ? "unavailable"
      : tokenStatus === "ready" && exactPrs && sourceReady ? "ready" : "partial", tokenStatus,
      prs: exactPrs ? values.prs : null, knownPrs, commits, newTokens,
      cacheRead: tokenStatus === "unavailable" ? null : values.cacheRead, wow };
  });
}

interface RepositoryActivity {
  id: string;
  name: string;
  category: LocalUsageCategory;
  daily: { day: string; knownPrs: number; commits: number }[];
}

interface RepositorySnapshot {
  rows: RepositoryActivity[];
  attribution: Map<string, { knownPrs: number; commits: number }>;
}

function repositoryRows(raw: unknown, daily: Map<string, DailyRow>): RepositorySnapshot | null {
  if (raw === undefined) return null;
  try {
    const data = object(raw);
    if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > 1000 || !Array.isArray(data.attribution) || data.attribution.length > 31) throw new Error("Invalid repositories");
    const ids = new Set<string>();
    const accounting = new Map<string, { knownPrs: number; commits: number }>();
    const rows = data.rows.map((value) => {
      const row = object(value);
      if (typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id) || ids.has(row.id) ||
          typeof row.name !== "string" || row.name.length > 240 || redactSecretsInText(row.name) !== row.name || !/^[\p{L}\p{N}_.~-][\p{L}\p{N}\p{M}._~ %+-]*(\/[\p{L}\p{N}_.~-][\p{L}\p{N}\p{M}._~ %+-]*){0,3}$/u.test(row.name) || row.name.split("/").some((part) => part === "." || part === "..") ||
          !CATEGORIES.includes(row.category as LocalUsageCategory) || !Array.isArray(row.daily) || row.daily.length > 31) throw new Error("Invalid repository identity");
      ids.add(row.id);
      const category = row.category as LocalUsageCategory;
      const seen = new Set<string>();
      const records = row.daily.map((value) => {
        const item = object(value);
        const date = item.day;
        if (typeof date !== "string" || !daily.has(date) || seen.has(date)) throw new Error("Invalid repository day");
        seen.add(date);
        const knownPrs = count(item.knownPrs), commits = count(item.commits);
        const total = accounting.get(date) ?? { knownPrs: 0, commits: 0 };
        total.knownPrs = sum([total.knownPrs, knownPrs]); total.commits = sum([total.commits, commits]);
        const limit = totals(daily.get(date)!);
        if (total.knownPrs > limit.knownPrs || commits > limit.commits) throw new Error("Invalid repository accounting");
        accounting.set(date, total);
        return { day: date, knownPrs, commits };
      });
      return { id: row.id, name: row.name, category, daily: records };
    });
    const attribution = new Map<string, { knownPrs: number; commits: number }>();
    for (const value of data.attribution) {
      const row = object(value);
      if (typeof row.day !== "string" || !daily.has(row.day) || attribution.has(row.day)) throw new Error("Invalid repository attribution date");
      const knownPrs = count(row.knownPrs), commits = count(row.commits);
      const limit = totals(daily.get(row.day)!);
      if (knownPrs > limit.knownPrs || commits > limit.commits) throw new Error("Invalid repository attribution");
      attribution.set(row.day, { knownPrs, commits });
    }
    for (const date of new Set([...accounting.keys(), ...attribution.keys()])) {
      const assigned = attribution.get(date) ?? { knownPrs: 0, commits: 0 };
      const counted = accounting.get(date) ?? { knownPrs: 0, commits: 0 };
      if (counted.knownPrs !== assigned.knownPrs || counted.commits < assigned.commits || counted.commits > 0 && assigned.commits === 0) throw new Error("Invalid repository attribution totals");
    }
    return { rows, attribution };
  } catch { return null; }
}

function repositoryWindow(repositories: RepositorySnapshot | null, window: LocalUsageWindow): LocalUsageRepositories {
  if (repositories === null) return window.repositories;
  const rows = repositories.rows.map((row) => {
    const days = row.daily.filter((day) => day.day >= window.startDay && day.day <= window.endDay);
    const category = window.categories[row.category];
    const knownPrs = category.knownPrs === null ? null : sum(days.map((day) => day.knownPrs));
    const commits = category.commits === null ? null : sum(days.map((day) => day.commits));
    return { id: row.id, name: row.name, category: row.category, knownPrs, commits, prs: category.prs === null ? null : knownPrs };
  }).filter((row) => (row.knownPrs ?? 0) + (row.commits ?? 0) > 0)
    .sort((a, b) => (b.knownPrs ?? 0) - (a.knownPrs ?? 0) || (b.commits ?? 0) - (a.commits ?? 0) || a.name.localeCompare(b.name));
  const attribution = [...repositories.attribution].filter(([date]) => date >= window.startDay && date <= window.endDay).map(([, row]) => row);
  const assignedPrs = sum(attribution.map((row) => row.knownPrs)), assignedCommits = sum(attribution.map((row) => row.commits));
  const unattributedPrs = window.knownPrs === null ? null : window.knownPrs - assignedPrs;
  const unattributedCommits = window.commits === null ? null : window.commits - assignedCommits;
  const sharedCommits = window.commits === null ? 0 : sum(rows.map((row) => row.commits ?? 0)) - assignedCommits;
  const coverage = window.knownPrs === null && window.commits === null ? "unavailable"
    : window.prs !== null && window.missingDays.length === 0 && unattributedPrs === 0 && unattributedCommits === 0 ? "ready" : "partial";
  return { coverage, rows, unattributedPrs, unattributedCommits, sharedCommits };
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
  const rawSources = snapshot.prSources as Record<string, unknown>[];
  const categorized = rawSources.every((source) => CATEGORIES.includes(source.category as LocalUsageCategory));
  if (prs.total > 0 && categorized && !rawSources.some((source) => source.category === "unclassified") &&
      [...daily.values()].every((row) => row.categories.unclassified.knownPrs === 0)) {
    prCoverage.unclassified = "ready";
    for (const row of daily.values()) row.categories.unclassified.prs = 0;
  }
  const observedCategories = new Set(categorized ? rawSources.filter((source) => source.status === "ok" || source.status === "stale").map((source) => source.category as LocalUsageCategory) : CATEGORIES);
  const prComplete = prs.total > 0 && prs.ready === prs.total && CATEGORIES.every((key) => prCoverage[key] === "ready");
  const repositories = repositoryRows(snapshot.localRepositories, daily);
  const windows = {} as Record<"1" | "7" | "30", LocalUsageWindow>;
  for (const days of WINDOWS) {
    const window = buildWindow(days, endDay, asOf, daily, sources, prs, prComplete, prCoverage, observedCategories);
    window.repositories = repositoryWindow(repositories, window);
    if (sources.total === 0 || sources.ready !== sources.total) window.repositories.coverage = window.repositories.coverage === "unavailable" ? "unavailable" : "partial";
    windows[String(days) as "1" | "7" | "30"] = window;
  }
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
