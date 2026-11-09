import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  LocalUsageCategory, LocalUsageCoverage, LocalUsagePrSourceCoverage, LocalUsageResponse,
  LocalUsageSourceCoverage, LocalUsageTokenStatus, LocalUsageTrendDay, LocalUsageWindow,
  LocalUsageComparison, LocalUsageCountComparison, LocalUsageCounts, LocalUsageRepositories, LocalUsageWeekChange,
} from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { createLocalUsageMergedReader } from "./local-usage-merged.ts";
import { createLocalUsageGithubReader } from "./local-usage-github.ts";
import { MAX_USAGE_HISTORY_DAYS } from "../shared/local-usage-range.ts";

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
  commitObserved: boolean;
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

function category(raw: unknown, historical = false): DailyCategory {
  const row = object(raw);
  const knownPrs = count(row.knownPrs);
  const prs = row.prs === null ? null : count(row.prs);
  const input = count(row.input);
  const output = count(row.output);
  const cacheRead = count(row.cacheRead);
  const totalTokens = sum([input, output, cacheRead]);
  if (prs !== null && prs !== knownPrs || count(row.cacheWrite) > input || count(row.reasoning) > output ||
      count(row.newTokens) !== input + output || row.totalTokens !== undefined && count(row.totalTokens) !== totalTokens) throw new Error("Invalid activity accounting");
  return { prs, knownPrs, commits: row.commits === null && historical ? 0 : count(row.commits),
    commitObserved: row.commits !== null, input, output, cacheRead };
}

function rows(raw: unknown, captureDay: string, span = 31, historical = false): Map<string, DailyRow> {
  if (!Array.isArray(raw) || raw.length > span) throw new Error("Invalid activity days");
  const daily = new Map<string, DailyRow>();
  const oldest = offsetDay(captureDay, 1 - span);
  for (const value of raw) {
    const row = object(value);
    const day = row.day;
    dayNumber(day);
    if (typeof day !== "string" || day < oldest || day > captureDay || daily.has(day)) throw new Error("Invalid activity day range");
    if (row.tokenStatus !== "ready" && row.tokenStatus !== "partial" && row.tokenStatus !== "unavailable") throw new Error("Invalid token coverage");
    const rawCategories = object(row.categories);
    const categories = {} as Record<LocalUsageCategory, DailyCategory>;
    for (const key of CATEGORIES) categories[key] = category(rawCategories[key], historical);
    daily.set(day, { day, tokenStatus: row.tokenStatus, categories });
  }
  return daily;
}

function sourceCoverage(raw: unknown): { coverage: LocalUsageSourceCoverage; activityScopeReady: boolean; tokenScopeReady: boolean } {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid activity sources");
  const coverage = { total: raw.length, ready: 0, partial: 0, stale: 0, missing: 0 };
  let missingSourcesUnsampled = true;
  let tokenReady = 0, tokenIncomplete = false;
  for (const value of raw) {
    const source = object(value);
    const status = source.status;
    if (source.tokenStatus !== undefined && source.tokenStatus !== "ready" && source.tokenStatus !== "partial" &&
        source.tokenStatus !== "unavailable") throw new Error("Invalid token source status");
    if (status === "ok" && (source.tokenStatus === undefined || source.tokenStatus === "ready") ||
        status === "partial" && source.tokenStatus === "ready") tokenReady++;
    else if (status !== "missing") tokenIncomplete = true;
    if (status === "ok") coverage.ready++;
    else if (status === "missing") {
      coverage.missing++;
      if (source.capturedAt != null || source.logFiles != null || source.repositoryCount != null ||
          source.firstUsageDay != null || source.lastUsageDay != null) missingSourcesUnsampled = false;
    } else if (status === "partial" || status === "stale") coverage[status]++;
    else throw new Error("Invalid activity source status");
  }
  return { coverage, activityScopeReady: coverage.ready > 0 && coverage.partial === 0 && coverage.stale === 0 && missingSourcesUnsampled,
    tokenScopeReady: tokenReady > 0 && !tokenIncomplete && missingSourcesUnsampled };
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
    commits: categories.every((value) => value.commitObserved) ? sum(categories.map((value) => value.commits)) : null,
    newTokens: sum(categories.map((value) => value.input + value.output)),
    cacheRead: sum(categories.map((value) => value.cacheRead)),
    totalTokens: sum(categories.map((value) => value.input + value.output + value.cacheRead)),
  };
}

const emptyCountComparison = (): LocalUsageCountComparison => ({ prs: null, commits: null });
function emptyComparison(days: 1 | 7 | 30 | 60, startDay: string): LocalUsageComparison {
  return { startDay: offsetDay(startDay, -days), endDay: offsetDay(startDay, -1),
    missingDays: [], unavailableTokenDays: [], prs: null, commits: null, totalTokens: null,
    categories: { work: emptyCountComparison(), personal: emptyCountComparison(), unclassified: emptyCountComparison() } };
}

function buildWindow<Days extends 1 | 7 | 30 | 60>(days: Days, endDay: string, asOf: number, daily: Map<string, DailyRow>,
  sources: LocalUsageSourceCoverage, prs: LocalUsagePrSourceCoverage, prComplete: boolean,
  prCoverage: Record<LocalUsageCategory, "ready" | "partial">, observedCategories: Set<LocalUsageCategory>): LocalUsageWindow<Days> {
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
  const commits = sourceObserved && present.length && observed.every((row) => row.commits !== null)
    ? sum(observed.map((row) => row.commits!)) : null;
  const newTokens = tokenDays.length ? sum(tokenDays.map((row) => totals(row).newTokens)) : null;
  const cacheRead = tokenDays.length ? sum(tokenDays.map((row) => totals(row).cacheRead)) : null;
  const totalTokens = tokenDays.length ? sum(tokenDays.map((row) => totals(row).totalTokens)) : null;
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
      commits: sourceObserved && present.length && observed.every((row) => row.commitObserved)
        ? sum(observed.map((row) => row.commits)) : null,
    };
  }
  return { days, startDay, endDay, asOf, coverage, tokenCoverage, missingDays, unavailableTokenDays,
    prs: exactPrs ? sum(observed.map((row) => row.prs!)) : null, knownPrs, commits, newTokens, cacheRead, totalTokens, categories,
    repositories: { coverage: "unavailable", rows: [], unattributedPrs: knownPrs, unattributedCommits: commits, sharedCommits: 0 },
    comparison: emptyComparison(days, startDay) };
}

function weekChange(current: number | null, previous: number | null): LocalUsageWeekChange {
  if (current === null || previous === null) return null;
  return previous === 0 ? current === 0 ? 0 : "new" : (current - previous) / previous * 100;
}

function tokenComparisonReady(window: LocalUsageWindow, sources: LocalUsageSourceCoverage,
  tokenScopeReady: boolean): boolean {
  return tokenScopeReady && (window.tokenCoverage === "ready" ||
    sources.missing + sources.partial > 0 && window.unavailableTokenDays.length === 0);
}

function trend(window: LocalUsageWindow, daily: Map<string, DailyRow>, sources: LocalUsageSourceCoverage,
  activityScopeReady: boolean, tokenScopeReady: boolean, prs: LocalUsagePrSourceCoverage, prComplete: boolean,
  prCoverage: Record<LocalUsageCategory, "ready" | "partial">, observedCategories: Set<LocalUsageCategory>, span = 30,
  repositories: RepositorySnapshot | null = null): LocalUsageTrendDay[] {
  return Array.from({ length: span }, (_, index) => {
    const day = offsetDay(window.startDay, index);
    const current = buildWindow(1, day, window.asOf, daily, sources, prs, prComplete, prCoverage, observedCategories);
    const previous = buildWindow(1, offsetDay(day, -7), window.asOf, daily, sources, prs, prComplete, prCoverage, observedCategories);
    const tokenReady = tokenComparisonReady(current, sources, tokenScopeReady) && tokenComparisonReady(previous, sources, tokenScopeReady);
    const wow = {
      prs: weekChange(current.prs, previous.prs),
      commits: activityScopeReady ? weekChange(current.commits, previous.commits) : null,
      newTokens: tokenReady ? weekChange(current.newTokens, previous.newTokens) : null,
      totalTokens: tokenReady ? weekChange(current.totalTokens, previous.totalTokens) : null,
    };
    current.repositories = repositoryWindow(repositories, current);
    if (sources.total === 0 || sources.ready !== sources.total || !datesCovered(current, repositories)) current.repositories.coverage = current.repositories.coverage === "unavailable" ? "unavailable" : "partial";
    return { day, coverage: current.coverage, repositories: current.repositories, tokenStatus: current.tokenCoverage,
      prs: current.prs, knownPrs: current.knownPrs, commits: current.commits,
      newTokens: current.newTokens, cacheRead: current.cacheRead, totalTokens: current.totalTokens,
      categories: current.categories, wow };
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
  coveredDays: Set<string> | null;
}

function repositoryRows(raw: unknown, daily: Map<string, DailyRow>, span = 31): RepositorySnapshot | null {
  if (raw === undefined) return null;
  try {
    const data = object(raw);
    if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > 1000 || !Array.isArray(data.attribution) || data.attribution.length > span) throw new Error("Invalid repositories");
    let coveredDays: Set<string> | null = null;
    if (data.coveredDays !== undefined) {
      if (!Array.isArray(data.coveredDays) || data.coveredDays.length > span) throw new Error("Invalid repository coverage");
      coveredDays = new Set<string>();
      for (const date of data.coveredDays) {
        if (typeof date !== "string" || !daily.has(date) || coveredDays.has(date)) throw new Error("Invalid repository coverage date");
        coveredDays.add(date);
      }
    }
    const ids = new Set<string>();
    const accounting = new Map<string, { knownPrs: number; commits: number }>();
    const rows = data.rows.map((value) => {
      const row = object(value);
      if (typeof row.id !== "string" || !/^[a-f0-9]{64}$/.test(row.id) || ids.has(row.id) ||
          typeof row.name !== "string" || row.name.length > 240 || redactSecretsInText(row.name) !== row.name || !/^[\p{L}\p{N}_.~-][\p{L}\p{N}\p{M}._~ %+-]*(\/[\p{L}\p{N}_.~-][\p{L}\p{N}\p{M}._~ %+-]*){0,3}$/u.test(row.name) || row.name.split("/").some((part) => part === "." || part === "..") ||
          !CATEGORIES.includes(row.category as LocalUsageCategory) || !Array.isArray(row.daily) || row.daily.length > span) throw new Error("Invalid repository identity");
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
        if (total.knownPrs > limit.knownPrs || limit.commits === null && commits > 0 || limit.commits !== null && commits > limit.commits) throw new Error("Invalid repository accounting");
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
      if (knownPrs > limit.knownPrs || limit.commits === null && commits > 0 || limit.commits !== null && commits > limit.commits) throw new Error("Invalid repository attribution");
      attribution.set(row.day, { knownPrs, commits });
    }
    for (const date of new Set([...accounting.keys(), ...attribution.keys()])) {
      const assigned = attribution.get(date) ?? { knownPrs: 0, commits: 0 };
      const counted = accounting.get(date) ?? { knownPrs: 0, commits: 0 };
      if (counted.knownPrs !== assigned.knownPrs || counted.commits < assigned.commits || counted.commits > 0 && assigned.commits === 0) throw new Error("Invalid repository attribution totals");
    }
    return { rows, attribution, coveredDays };
  } catch { return null; }
}

function localHistory(raw: unknown, endDay: string, current: Map<string, DailyRow>): {
  daily: Map<string, DailyRow>; repositories: RepositorySnapshot;
} | null {
  if (raw === undefined) return null;
  try {
    const data = object(raw);
    if (data.version !== 1) throw new Error("Invalid activity history");
    const daily = rows(data.daily, endDay, 60, true);
    for (const [day, historical] of daily) {
      const recent = current.get(day);
      if (!recent) continue;
      for (const key of CATEGORIES) {
        const old = historical.categories[key], now = recent.categories[key];
        if (old.knownPrs !== now.knownPrs || old.input !== now.input || old.output !== now.output ||
            old.cacheRead !== now.cacheRead || old.commitObserved && old.commits !== now.commits ||
            old.prs !== null && old.prs !== now.prs) throw new Error("Inconsistent activity history");
      }
    }
    const repositories = repositoryRows(data.localRepositories, daily, 60);
    if (!repositories) throw new Error("Invalid repository history");
    repositories.coveredDays ??= new Set(daily.keys());
    return { daily, repositories };
  } catch { return null; }
}

function repositoryWindow(repositories: RepositorySnapshot | null, window: LocalUsageWindow<1 | 7 | 30 | 60>): LocalUsageRepositories {
  if (repositories === null) return window.repositories;
  const rows = repositories.rows.map((row) => {
    const days = row.daily.filter((day) => day.day >= window.startDay && day.day <= window.endDay);
    const category = window.categories[row.category];
    const knownPrs = category.knownPrs === null ? null : sum(days.map((day) => day.knownPrs));
    const commits = category.commits === null ? null : sum(days.map((day) => day.commits));
    return { id: row.id, name: row.name, category: row.category, knownPrs, commits, prs: category.prs === null ? null : knownPrs,
      comparison: emptyCountComparison() };
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

function datesCovered(window: LocalUsageWindow<1 | 7 | 30 | 60>, repositories: RepositorySnapshot | null): boolean {
  if (!repositories || window.missingDays.length) return false;
  if (!repositories.coveredDays) return true;
  return Array.from({ length: window.days }, (_, index) => offsetDay(window.startDay, index))
    .every((day) => repositories.coveredDays!.has(day));
}

function repositoryPrCovered(window: LocalUsageWindow, category: LocalUsageCategory,
  repositories: RepositorySnapshot | null): boolean {
  const exact = window.categories[category].prs;
  return exact !== null && datesCovered(window, repositories) &&
    sum(window.repositories.rows.filter((row) => row.category === category).map((row) => row.knownPrs ?? 0)) === exact;
}

function repositoryCommitsCovered(window: LocalUsageWindow, repositories: RepositorySnapshot | null,
  activityScopeReady: boolean): boolean {
  return activityScopeReady && window.commits !== null &&
    window.repositories.unattributedCommits === 0 && datesCovered(window, repositories);
}

function compareWindows(current: LocalUsageWindow, previous: LocalUsageWindow,
  currentRepositories: RepositorySnapshot | null, previousRepositories: RepositorySnapshot | null,
  sources: LocalUsageSourceCoverage, activityScopeReady: boolean, tokenScopeReady: boolean): void {
  const complete = current.missingDays.length === 0 && previous.missingDays.length === 0;
  const tokenReady = tokenComparisonReady(current, sources, tokenScopeReady) && tokenComparisonReady(previous, sources, tokenScopeReady);
  const categories = {} as LocalUsageComparison["categories"];
  for (const key of CATEGORIES) {
    categories[key] = {
      prs: complete ? weekChange(current.categories[key].prs, previous.categories[key].prs) : null,
      commits: complete && activityScopeReady ? weekChange(current.categories[key].commits, previous.categories[key].commits) : null,
    };
  }
  current.comparison = { startDay: previous.startDay, endDay: previous.endDay,
    missingDays: previous.missingDays, unavailableTokenDays: previous.unavailableTokenDays,
    prs: complete ? weekChange(current.prs, previous.prs) : null,
    commits: complete && activityScopeReady ? weekChange(current.commits, previous.commits) : null,
    totalTokens: complete && tokenReady
      ? weekChange(current.totalTokens, previous.totalTokens) : null, categories };
  const priorRows = new Map(previous.repositories.rows.map((row) => [row.id, row]));
  for (const row of current.repositories.rows) {
    const prior = priorRows.get(row.id);
    row.comparison = {
      prs: repositoryPrCovered(current, row.category, currentRepositories) &&
        repositoryPrCovered(previous, row.category, previousRepositories)
        ? weekChange(row.prs, prior?.prs ?? 0) : null,
      commits: repositoryCommitsCovered(current, currentRepositories, activityScopeReady) &&
        repositoryCommitsCovered(previous, previousRepositories, activityScopeReady)
        ? weekChange(row.commits, prior?.commits ?? 0) : null,
    };
  }
}

function project(raw: unknown, now: number): LocalUsageResponse {
  const snapshot = object(raw);
  const asOf = count(snapshot.updatedAt);
  if (snapshot.version !== 1 || snapshot.timeZone !== "Asia/Shanghai" || !asOf || asOf > now + 5 * 60_000 ||
      (snapshot.status !== "ready" && snapshot.status !== "partial")) throw new Error("Invalid activity snapshot");
  const endDay = chinaDay(asOf);
  const daily = rows(snapshot.daily, endDay);
  const { coverage: sources, activityScopeReady, tokenScopeReady } = sourceCoverage(snapshot.sources);
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
  const historical = localHistory(snapshot.localHistory, endDay, daily);
  const comparisonDaily = historical?.daily ?? daily;
  const comparisonRepositories = historical?.repositories ?? repositories;
  const windows = {} as Record<"1" | "7" | "30", LocalUsageWindow>;
  for (const days of WINDOWS) {
    const window = buildWindow(days, endDay, asOf, daily, sources, prs, prComplete, prCoverage, observedCategories);
    window.repositories = repositoryWindow(repositories, window);
    if (sources.total === 0 || sources.ready !== sources.total) window.repositories.coverage = window.repositories.coverage === "unavailable" ? "unavailable" : "partial";
    const previous = buildWindow(days, offsetDay(window.startDay, -1), asOf, comparisonDaily,
      sources, prs, prComplete, prCoverage, observedCategories);
    previous.repositories = repositoryWindow(comparisonRepositories, previous);
    compareWindows(window, previous, historical?.repositories ?? repositories, comparisonRepositories, sources, activityScopeReady, tokenScopeReady);
    windows[String(days) as "1" | "7" | "30"] = window;
  }
  const stale = chinaDay(now) !== endDay || now - asOf > STALE_AFTER_MS;
  const status = stale ? "stale" : snapshot.status === "ready" && windows["30"].coverage === "ready" ? "ready" : "partial";
  const recentTrend = trend(windows["30"], daily, sources, activityScopeReady, tokenScopeReady, prs, prComplete, prCoverage, observedCategories, 30, repositories);
  const baseline = trend({ ...windows["30"], startDay: offsetDay(endDay, -59) }, comparisonDaily,
    sources, activityScopeReady, tokenScopeReady, prs, prComplete, prCoverage, observedCategories, 60, comparisonRepositories);
  const history = tokenHistory(snapshot.trendHistory, endDay, recentTrend, baseline);
  const sixty = buildWindow(60, endDay, asOf, comparisonDaily, sources, prs, prComplete, prCoverage, observedCategories);
  sixty.repositories = repositoryWindow(comparisonRepositories, sixty);
  if (sources.total === 0 || sources.ready !== sources.total || !datesCovered(sixty, comparisonRepositories)) sixty.repositories.coverage = sixty.repositories.coverage === "unavailable" ? "unavailable" : "partial";
  return { status, asOf, timeZone: "Asia/Shanghai", sourceCoverage: sources, prSourceCoverage: prs,
    prCoverage, windows, trend: recentTrend, history, sixtyDayRepositories: { startDay: sixty.startDay, endDay: sixty.endDay, repositories: sixty.repositories } };
}

function tokenHistory(raw: unknown, endDay: string, recent: LocalUsageTrendDay[], baseline: LocalUsageTrendDay[]): LocalUsageTrendDay[] {
  const result = new Map<string, LocalUsageTrendDay>();
  try {
    if (raw !== undefined) {
      const data = object(raw);
      if (data.version !== 1 || !Array.isArray(data.daily) || data.daily.length > MAX_USAGE_HISTORY_DAYS) throw new Error("Invalid token history");
      for (const value of data.daily) {
        const row = object(value), day = row.day;
        dayNumber(day);
        if (typeof day !== "string" || day < offsetDay(endDay, 1 - MAX_USAGE_HISTORY_DAYS) || day > endDay || result.has(day)
          || !["ready", "partial", "unavailable"].includes(String(row.tokenStatus))) throw new Error("Invalid token history day");
        const missing = row.tokenStatus === "unavailable";
        const newTokens = missing && row.newTokens === null ? null : count(row.newTokens);
        const cacheRead = missing && row.cacheRead === null ? null : count(row.cacheRead);
        const totalTokens = missing && row.totalTokens === null ? null : count(row.totalTokens);
        if (missing ? [newTokens, cacheRead, totalTokens].some((value) => value !== null)
          : newTokens === null || cacheRead === null || totalTokens !== sum([newTokens, cacheRead])) throw new Error("Invalid token history accounting");
        const empty = () => ({ prs: null, knownPrs: null, commits: null });
        result.set(day, { day, coverage: "unavailable", tokenStatus: row.tokenStatus as LocalUsageTokenStatus,
          ...empty(), newTokens, cacheRead, totalTokens, categories: { work: empty(), personal: empty(), unclassified: empty() },
          wow: { prs: null, commits: null, newTokens: null, totalTokens: null } });
      }
    }
  } catch { result.clear(); }
  for (const row of [...baseline, ...recent]) {
    const known = result.get(row.day);
    result.set(row.day, row.tokenStatus === "unavailable" && known && known.tokenStatus !== "unavailable"
      ? { ...row, tokenStatus: "partial", newTokens: known.newTokens, cacheRead: known.cacheRead, totalTokens: known.totalTokens,
        wow: { ...row.wow, newTokens: null, totalTokens: null } } : row);
  }
  for (const row of result.values()) {
    if (recent.some((recent) => recent.day === row.day)) continue;
    const previous = result.get(offsetDay(row.day, -7));
    if (row.tokenStatus === "ready" && previous?.tokenStatus === "ready") row.wow = { ...row.wow,
      newTokens: weekChange(row.newTokens, previous.newTokens), totalTokens: weekChange(row.totalTokens, previous.totalTokens) };
  }
  return [...result.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const unavailable: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
  sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };

export function createLocalUsageProvider({ file = join(homedir(), ".local", "share", "agent-town", "activity", "latest.json"),
  mergedFile = join(homedir(), ".local", "share", "mymausbot", "usage", "merged-v1.json"),
  githubFile = join(homedir(), ".local", "share", "mymausbot", "usage", "github-profile-v1.json"), now = Date.now }: {
  file?: string; mergedFile?: string; githubFile?: string; now?: () => number;
} = {}) {
  let lastGood: LocalUsageResponse | null = null;
  const readMerged = createLocalUsageMergedReader(mergedFile, now);
  const readGithub = createLocalUsageGithubReader(githubFile, now);
  return {
    async get(): Promise<LocalUsageResponse> {
      let local: LocalUsageResponse;
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Invalid activity file");
        const data = await readFile(file, "utf8");
        if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error("Invalid activity file");
        lastGood = project(JSON.parse(data), now());
        local = lastGood;
      } catch {
        local = lastGood ? { ...lastGood, status: "stale" } : unavailable;
      }
      const merged = await readMerged();
      const github = await readGithub();
      return { ...local, ...(merged ? { merged } : {}), ...(github ? { github } : {}) };
    },
  };
}
