import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  LocalContributionAccount, LocalContributionCounts, LocalContributionDay, LocalContributionEnvelope,
  LocalContributionRepositoryDay, LocalContributionRepositories, LocalContributionSnapshot,
  LocalContributionSource, LocalContributionTrendDay, LocalContributionWindow, LocalContributionsResponse,
} from "../shared/local-contributions.ts";
import type {
  LocalUsageCategory, LocalUsageCoverage, LocalUsagePeriodChange, LocalUsageStatus,
} from "../shared/local-dashboard.ts";

const CATEGORIES = ["work", "personal", "unclassified"] as const;
const PERIODS = [1, 7, 30, 60] as const;
const DAY_MS = 86_400_000;
const STALE_MS = 15 * 60_000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCES = 32;
const MAX_REPOSITORIES_PER_DAY = 5_000;
const MAX_REPOSITORY_ROWS = 100_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const CHINA_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid contribution object");
  return value as Record<string, unknown>;
}

function hasControl(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function text(value: unknown, length = 256): string {
  if (typeof value !== "string" || !value || value.length > length || hasControl(value)) {
    throw new Error("Invalid contribution text");
  }
  return value;
}

function reasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((reason) =>
    typeof reason !== "string" || !reason || reason.length > 256 || hasControl(reason))) {
    throw new Error("Invalid contribution reasons");
  }
  return value.map((reason) => /^[a-z][a-z0-9._:-]{0,79}$/i.test(reason) ? reason : "provider-read-failure");
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid contribution count");
  return value;
}

function optionalCount(value: unknown): number | null {
  return value === null ? null : count(value);
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid collection duration");
  return value;
}

function sum(values: number[]): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result) || result > MAX_SAFE) throw new Error("Contribution count overflow");
  return result;
}

function known(values: (number | null)[]): number | null {
  const observed = values.filter((value): value is number => value !== null);
  return observed.length ? sum(observed) : null;
}

function exact(values: (number | null)[]): number | null {
  return values.length && values.every((value) => value !== null) ? sum(values as number[]) : null;
}

function day(value: unknown): string {
  const source = text(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source) || new Date(`${source}T00:00:00Z`).toISOString().slice(0, 10) !== source) {
    throw new Error("Invalid contribution day");
  }
  return source;
}

function shift(value: string, offset: number): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

function instant(value: unknown, now: number): number {
  const source = text(value, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(source)) throw new Error("Invalid contribution instant");
  const result = Date.parse(source);
  if (!Number.isFinite(result) || result > now + 300_000 || new Date(result).toISOString().slice(0, 19) !== source.slice(0, 19)) {
    throw new Error("Invalid contribution instant");
  }
  return result;
}

function status(value: unknown): LocalUsageStatus {
  if (value !== "ready" && value !== "partial" && value !== "stale" && value !== "unavailable") {
    throw new Error("Invalid contribution status");
  }
  return value;
}

function counts(value: Record<string, unknown>): LocalContributionCounts {
  const result = {
    prs: optionalCount(value.prs), knownPrs: optionalCount(value.knownPrs),
    commits: optionalCount(value.commits), knownCommits: optionalCount(value.knownCommits),
  };
  if (result.prs !== null && result.knownPrs !== result.prs ||
      result.commits !== null && result.knownCommits !== result.commits) throw new Error("Exact contribution count differs from its subtotal");
  return result;
}

function repository(value: unknown): LocalContributionRepositoryDay {
  const raw = record(value);
  const category = raw.category;
  if (!CATEGORIES.some((candidate) => candidate === category)) throw new Error("Invalid contribution category");
  const state = status(raw.status);
  const totals = counts(raw);
  if (state === "ready" && (totals.prs === null || totals.commits === null)) throw new Error("Ready repository lacks exact counts");
  if (raw.provenance !== undefined) record(raw.provenance);
  return { id: text(raw.id), name: text(raw.name, 512), category: category as LocalUsageCategory,
    status: state, ...totals };
}

function sourceDay(value: unknown, first: string, last: string, capturedAt: number, now: number): LocalContributionDay {
  const raw = record(value);
  const date = day(raw.day);
  if (date < first || date > last || instant(raw.capturedAt, now) > capturedAt) throw new Error("Contribution day outside capture window");
  const state = status(raw.status);
  const totals = counts(raw);
  if (state === "ready" && (totals.prs === null || totals.commits === null)) throw new Error("Ready day lacks exact counts");
  if (!Array.isArray(raw.repositories) || raw.repositories.length > MAX_REPOSITORIES_PER_DAY) throw new Error("Invalid repository day rows");
  const repositories = raw.repositories.map(repository);
  if (new Set(repositories.map((row) => row.id)).size !== repositories.length) throw new Error("Duplicate repository day");
  for (const metric of ["knownPrs", "knownCommits"] as const) {
    const values = repositories.map((row) => row[metric]);
    const observed = known(values);
    if (observed !== null && (totals[metric] === null ? values.every((value) => value !== null) : observed > totals[metric])) {
      throw new Error("Repository subtotal exceeds account day");
    }
  }
  return { day: date, capturedAt: raw.capturedAt as string, status: state, ...totals, repositories };
}

function eligibilityDays(value: unknown, first: string, last: string): string[] {
  if (!Array.isArray(value) || value.length > 60) throw new Error("Invalid eligibility days");
  const days = value.map((item) => day(item));
  if (new Set(days).size !== days.length || days.some((value) => value < first || value > last)) {
    throw new Error("Invalid eligibility days");
  }
  return days;
}

function source(value: unknown, first: string, last: string, capturedAt: number, now: number,
  provider: "github" | "ado"): LocalContributionSource {
  const raw = record(value);
  const account = record(raw.account);
  const coverage = record(raw.coverage);
  for (const key of ["identityVerified", "paginationComplete", "visibilityComplete"] as const) {
    if (typeof coverage[key] !== "boolean") throw new Error("Invalid contribution coverage");
  }
  const state = status(raw.status);
  if (state === "ready" && ![coverage.identityVerified, coverage.paginationComplete, coverage.visibilityComplete].every(Boolean)) {
    throw new Error("Ready source lacks verified coverage");
  }
  if (!Array.isArray(raw.days) || raw.days.length > 60) throw new Error("Invalid contribution source days");
  const days = raw.days.map((row) => sourceDay(row, first, last, capturedAt, now));
  if (new Set(days.map((row) => row.day)).size !== days.length) throw new Error("Duplicate contribution source day");
  const uncertain = coverage.eligibilityUncertainDays;
  const eligibilityUncertainDays = uncertain === undefined ? undefined : eligibilityDays(uncertain, first, last);
  const scopedRaw = coverage.eligibilityUncertainDaysByCategory;
  const scoped = scopedRaw === undefined ? undefined : record(scopedRaw);
  if (scoped && (Object.keys(scoped).length !== CATEGORIES.length || CATEGORIES.some((category) => !Object.hasOwn(scoped, category)))) {
    throw new Error("Invalid eligibility categories");
  }
  const eligibilityUncertainDaysByCategory = scoped && Object.fromEntries(CATEGORIES.map((category) =>
    [category, eligibilityDays(scoped[category], first, last)])) as Record<LocalUsageCategory, string[]> | undefined;
  if (eligibilityUncertainDaysByCategory && JSON.stringify([...new Set(Object.values(eligibilityUncertainDaysByCategory).flat())].sort()) !==
      JSON.stringify([...(eligibilityUncertainDays ?? [])].sort())) throw new Error("Invalid eligibility categories");
  if (state === "ready" && eligibilityUncertainDays?.length) throw new Error("Ready source has uncertain eligibility");
  if (state === "ready" && days.length !== 60) throw new Error("Ready source lacks full 60-day window");
  if (raw.provenance !== undefined) record(raw.provenance);
  const scope = raw.scope === undefined ? undefined : record(raw.scope);
  if (provider === "ado" && !scope) throw new Error("ADO source lacks verified project scope");
  return {
    id: text(raw.id), account: { host: text(account.host, 128), login: text(account.login, 128), stableId: text(account.stableId) },
    ...(scope ? { scope: { organization: text(scope.organization, 128), project: text(scope.project, 128) } } : {}),
    status: state,
    coverage: { identityVerified: coverage.identityVerified as boolean, paginationComplete: coverage.paginationComplete as boolean,
      visibilityComplete: coverage.visibilityComplete as boolean,
      ...(eligibilityUncertainDays === undefined ? {} : { eligibilityUncertainDays }),
      ...(eligibilityUncertainDaysByCategory === undefined ? {} : { eligibilityUncertainDaysByCategory }),
      reasons: reasons(coverage.reasons) },
    days,
  };
}

export function parseContributionEnvelope(value: unknown, provider: "github" | "ado", now = Date.now()): LocalContributionEnvelope {
  const raw = record(value);
  if (raw.version !== 2 || raw.provider !== provider || raw.metricDefinition !==
      (provider === "github" ? "github-profile-beijing-v1" : "ado-default-head-beijing-v1")) throw new Error("Invalid contribution contract version");
  const basis = record(raw.dateBasis);
  const expected = { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" } as const;
  if (basis.prs !== expected.prs || basis.commits !== expected.commits) throw new Error("Invalid contribution date basis");
  const cutoff = instant(raw.asOfAt, now), capture = instant(raw.capturedAt, now);
  if (cutoff > capture) throw new Error("Contribution capture precedes cutoff");
  const operation = record(raw.operationWindow), first = day(operation.startDay), last = day(operation.endDay);
  if (first !== shift(last, -59) || last !== CHINA_DATE.format(cutoff) || operation.todayPartial !== true) {
    throw new Error("Invalid 60-day operation window");
  }
  const collection = record(raw.collection);
  if (typeof collection.complete !== "boolean") throw new Error("Invalid collection completeness");
  if (!Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > MAX_SOURCES ||
      !Array.isArray(raw.activeSourceIds) || raw.activeSourceIds.length !== raw.sources.length) throw new Error("Invalid contribution sources");
  const sources = raw.sources.map((row) => source(row, first, last, capture, now, provider));
  const ids = raw.activeSourceIds.map((id) => text(id));
  if (new Set(ids).size !== ids.length || new Set(sources.map((item) => item.id)).size !== sources.length ||
      ids.some((id) => !sources.some((item) => item.id === id))) throw new Error("Contribution source identity mismatch");
  if (sum(sources.flatMap((item) => item.days.map((row) => row.repositories.length))) > MAX_REPOSITORY_ROWS) {
    throw new Error("Too many contribution repository rows");
  }
  const accountKeys = sources.map((item) => [item.account.host, item.account.stableId,
    item.scope?.organization ?? "", item.scope?.project ?? ""].map((part, index) =>
    index === 0 || index >= 2 || provider === "ado" ? part.toLowerCase() : part).join("\0"));
  if (new Set(accountKeys).size !== accountKeys.length) throw new Error("Duplicate contribution account scope");
  if (raw.state !== undefined) record(raw.state);
  return { version: 2, metricDefinition: raw.metricDefinition as LocalContributionEnvelope["metricDefinition"], provider,
    asOfAt: raw.asOfAt as string, capturedAt: raw.capturedAt as string, dateBasis: expected as LocalContributionEnvelope["dateBasis"],
    operationWindow: { startDay: first, endDay: last, todayPartial: true }, activeSourceIds: ids, sources,
    collection: { requestCount: count(collection.requestCount), elapsedSeconds: finite(collection.elapsedSeconds),
      complete: collection.complete, reasons: reasons(collection.reasons),
      ...(collection.rateLimit === undefined ? {} : { rateLimit: record(collection.rateLimit) }) },
  };
}

export function parseContributionSnapshot(value: unknown, now = Date.now()): LocalContributionSnapshot {
  const raw = record(value);
  if (raw.version !== 2) throw new Error("Invalid contribution snapshot version");
  const github = parseContributionEnvelope(raw.github, "github", now);
  const ado = parseContributionEnvelope(raw.ado, "ado", now);
  if (github.operationWindow.startDay !== ado.operationWindow.startDay ||
      github.operationWindow.endDay !== ado.operationWindow.endDay) throw new Error("Provider dates do not align");
  return { version: 2, github, ado };
}

type Entry = { provider: "github" | "ado"; source: LocalContributionSource; day: LocalContributionDay | undefined };
type Aggregate = LocalContributionCounts & { coverage: LocalUsageCoverage; missingDays: string[];
  categories: Record<LocalUsageCategory, LocalContributionCounts>;
  repositories: LocalContributionRepositories };

function combine(values: LocalContributionCounts[]): LocalContributionCounts {
  return { prs: exact(values.map((value) => value.prs)), knownPrs: known(values.map((value) => value.knownPrs)),
    commits: exact(values.map((value) => value.commits)), knownCommits: known(values.map((value) => value.knownCommits)) };
}

function qualified(entry: Entry): LocalContributionCounts {
  const value = entry.day;
  if (!value || !entry.source.coverage.identityVerified) return { prs: null, knownPrs: null, commits: null, knownCommits: null };
  const exactDay = entry.source.coverage.identityVerified && entry.source.coverage.paginationComplete &&
    entry.source.coverage.visibilityComplete && value.status === "ready";
  return { prs: exactDay ? value.prs : null, knownPrs: value.knownPrs,
    commits: exactDay ? value.commits : null, knownCommits: value.knownCommits };
}

function accountedCategory(entry: Entry, category: LocalUsageCategory, metric: "knownPrs" | "knownCommits"): boolean {
  const value = entry.day, coverage = entry.source.coverage;
  if (!value || !coverage.identityVerified || !coverage.paginationComplete ||
      (entry.source.status !== "ready" && entry.source.status !== "partial") ||
      (value.status !== "ready" && value.status !== "partial")) return false;
  const uncertain = metric === "knownCommits" && coverage.eligibilityUncertainDays?.includes(value.day);
  const scoped = coverage.eligibilityUncertainDaysByCategory;
  if (uncertain && (!scoped || scoped[category].includes(value.day))) return false;
  const categoryRows = value.repositories.filter((row) => row.category === category);
  if (categoryRows.some((row) => (row.status !== "ready" && row.status !== "partial") || row[metric] === null)) return false;
  if (value[metric] === null) return Boolean(uncertain && scoped);
  return value.repositories.every((row) => (row.status === "ready" || row.status === "partial") &&
    (row[metric] !== null || (uncertain && scoped?.[row.category].includes(value.day)))) &&
    sum(value.repositories.filter((row) => row[metric] !== null).map((row) => row[metric]!)) === value[metric];
}

function aggregate(entries: Entry[]): Aggregate {
  const totals = combine(entries.map(qualified));
  const observed = entries.filter((entry) => entry.day && entry.source.coverage.identityVerified);
  const complete = entries.length > 0 && entries.every((entry) => qualified(entry).prs !== null && qualified(entry).commits !== null);
  const repositoryComplete = complete && observed.every((entry) => entry.day!.repositories.every((row) =>
    row.status === "ready" && row.prs !== null && row.commits !== null));
  const categories = Object.fromEntries(CATEGORIES.map((category) => [category, [] as LocalContributionCounts[]])) as
    Record<LocalUsageCategory, LocalContributionCounts[]>;
  const repositories = new Map<string, LocalContributionRepositories["rows"][number]>();
  let unattributedPrs = 0, unattributedCommits = 0;
  for (const entry of observed) {
    const sourceDay = entry.day!;
    const rows = sourceDay.repositories;
    for (const row of rows) {
      const key = JSON.stringify([entry.provider, entry.source.account.host.toLowerCase(), row.id]);
      const prior = repositories.get(key);
      if (prior && (prior.category !== row.category || prior.name !== row.name)) throw new Error("Repository identity changed within capture");
      const value = qualified(entry);
      const qualifiedRow: LocalContributionCounts = {
        prs: value.prs === null || row.status !== "ready" ? null : row.prs,
        knownPrs: row.knownPrs,
        commits: value.commits === null || row.status !== "ready" ? null : row.commits,
        knownCommits: row.knownCommits,
      };
      categories[row.category].push(qualifiedRow);
      repositories.set(key, { id: key, name: row.name, category: row.category,
        ...combine([...(prior ? [prior] : []), qualifiedRow]), comparison: { prs: null, commits: null } });
    }
    const accountedPrs = known(rows.map((row) => row.knownPrs)) ?? 0;
    const accountedCommits = known(rows.map((row) => row.knownCommits)) ?? 0;
    if (sourceDay.knownPrs !== null) unattributedPrs += sourceDay.knownPrs - accountedPrs;
    if (sourceDay.knownCommits !== null) unattributedCommits += sourceDay.knownCommits - accountedCommits;
  }
  if (unattributedPrs || unattributedCommits) categories.unclassified.push({
    prs: complete ? unattributedPrs : null, knownPrs: unattributedPrs,
    commits: complete ? unattributedCommits : null, knownCommits: unattributedCommits,
  });
  const categoryTotals = Object.fromEntries(CATEGORIES.map((category) => [category, {
    ...combine(categories[category]),
    prs: repositoryComplete && categories[category].every((row) => row.prs !== null)
      ? sum(categories[category].map((row) => row.prs!)) : null,
    commits: repositoryComplete && categories[category].every((row) => row.commits !== null)
      ? sum(categories[category].map((row) => row.commits!)) : null,
    knownPrs: !categories[category].length && entries.length > 0 && entries.every((entry) => accountedCategory(entry, category, "knownPrs"))
      ? 0 : known(categories[category].map((row) => row.knownPrs)),
    knownCommits: !categories[category].length && entries.length > 0 && entries.every((entry) => accountedCategory(entry, category, "knownCommits"))
      ? 0 : known(categories[category].map((row) => row.knownCommits)),
  }])) as Record<LocalUsageCategory, LocalContributionCounts>;
  const rows = [...repositories.values()].sort((a, b) => (b.knownPrs ?? 0) - (a.knownPrs ?? 0) || a.name.localeCompare(b.name));
  const coverage: LocalUsageCoverage = !observed.length ? "unavailable" : complete ? "ready" : "partial";
  return { ...totals, coverage, missingDays: entries.filter((entry) => !entry.day).map((entry) => entry.source.id),
    categories: categoryTotals,
    repositories: { coverage: !observed.length ? "unavailable" : repositoryComplete ? "ready" : "partial", rows,
      unattributedPrs: totals.knownPrs === null ? null : unattributedPrs,
      unattributedCommits: totals.knownCommits === null ? null : unattributedCommits, sharedCommits: 0 } };
}

function percentage(current: number | null, previous: number | null): LocalUsagePeriodChange {
  if (current === null || previous === null) return null;
  return previous === 0 ? current === 0 ? 0 : "new" : (current - previous) / previous * 100;
}

function unavailable(): LocalContributionsResponse {
  return { metricDefinition: "contributions-v2", status: "unavailable", asOf: null, cutoffAt: null, capturedAt: null,
    timeZone: "Asia/Shanghai", dateBasis: { github: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" },
      ado: { prs: "created-at/Asia-Shanghai", commits: "author-at/Asia-Shanghai" }, tokens: "Asia/Shanghai" },
    sourceCoverage: null, currentDayPartial: false, sourceDays: null, accounts: [], windows: null, trend: [], history: [] };
}

export function aggregateContributionSnapshot(snapshot: LocalContributionSnapshot, now = Date.now()): LocalContributionsResponse {
  const sources = [snapshot.github, snapshot.ado].flatMap((envelope) => envelope.sources.map((source) => ({
    provider: envelope.provider, source,
  })));
  const end = snapshot.github.operationWindow.endDay;
  const dates = Array.from({ length: 60 }, (_, index) => shift(end, index - 59));
  const dayMaps = new Map(sources.map(({ source }) => [source, new Map(source.days.map((row) => [row.day, row]))]));
  const on = (date: string): Entry[] => sources.map(({ provider, source }) => ({ provider, source,
    day: dayMaps.get(source)?.get(date) }));
  const dateAggregate = new Map(dates.map((date) => [date, aggregate(on(date))]));
  const aggregatePeriod = (period: number, ending: string) => {
    const start = shift(ending, 1 - period);
    const entries = Array.from({ length: period }, (_, index) => on(shift(start, index)));
    const daily = entries.map(aggregate);
    const combined = combine(daily);
    const categories = Object.fromEntries(CATEGORIES.map((category) => [category, combine(daily.map((row) => row.categories[category]))])) as
      Record<LocalUsageCategory, LocalContributionCounts>;
    const repositories = aggregate(entries.flat());
    const missingDays = entries.flatMap((rows, index) => rows.some((row) => !row.day) ? [shift(start, index)] : []);
    const coverage: LocalUsageCoverage = !daily.some((row) => row.coverage !== "unavailable") ? "unavailable"
      : daily.every((row) => row.coverage === "ready") ? "ready" : "partial";
    return { ...combined, coverage, categories, repositories: repositories.repositories,
      missingDays, startDay: start, endDay: ending };
  };
  const asOf = Math.min(Date.parse(snapshot.github.asOfAt), Date.parse(snapshot.ado.asOfAt));
  const capturedAt = Math.max(Date.parse(snapshot.github.capturedAt), Date.parse(snapshot.ado.capturedAt));
  const windows = Object.fromEntries(([1, 7, 30] as const).map((period) => {
    const current = aggregatePeriod(period, end), previous = aggregatePeriod(period, shift(current.startDay, -1));
    const previousStart = previous.startDay, previousEnd = previous.endDay;
    const observations = Array.from({ length: period * 2 }, (_, index) => on(shift(previousStart, index))).flat();
    const knownChange = (metric: "knownPrs" | "knownCommits") => observations.length > 0 && observations.every(({ source, day }) =>
      source.coverage.identityVerified && source.coverage.paginationComplete &&
      (source.status === "ready" || source.status === "partial") && day &&
      (metric === "knownPrs" || !source.coverage.eligibilityUncertainDays?.includes(day.day)) &&
      (day.status === "ready" || day.status === "partial") && day[metric] !== null)
      ? percentage(current[metric], previous[metric]) : null;
    const knownCategoryChange = (category: LocalUsageCategory, metric: "knownPrs" | "knownCommits") =>
      observations.length > 0 && observations.every((entry) => accountedCategory(entry, category, metric))
        ? percentage(current.categories[category][metric], previous.categories[category][metric]) : null;
    const compare = (value: LocalContributionCounts, prior: LocalContributionCounts) => ({
      prs: percentage(value.prs, prior.prs), commits: percentage(value.commits, prior.commits),
    });
    const priorRepos = new Map(previous.repositories.rows.map((row) => [row.id, row]));
    return [String(period), { ...current, days: period, asOf,
      repositories: { ...current.repositories, rows: current.repositories.rows.map((row) => {
        const prior = priorRepos.get(row.id);
        const knownRepoChange = (metric: "knownPrs" | "knownCommits") =>
          observations.length > 0 && (!prior || prior.category === row.category) &&
          observations.every((entry) => accountedCategory(entry, row.category, metric))
            ? percentage(row[metric], prior ? prior[metric] : 0) : null;
        return { ...row,
          comparison: compare(row, prior ?? { prs: previous.coverage === "ready" ? 0 : null,
            knownPrs: null, commits: previous.coverage === "ready" ? 0 : null, knownCommits: null }),
          knownComparison: { prs: knownRepoChange("knownPrs"), commits: knownRepoChange("knownCommits") } };
      }) },
      comparison: { startDay: previousStart, endDay: previousEnd, missingDays: previous.missingDays,
        ...compare(current, previous),
        known: { prs: knownChange("knownPrs"), commits: knownChange("knownCommits") },
        knownCategories: Object.fromEntries(CATEGORIES.map((category) => [category, {
          prs: knownCategoryChange(category, "knownPrs"), commits: knownCategoryChange(category, "knownCommits"),
        }])) as Record<LocalUsageCategory, { prs: LocalUsagePeriodChange; commits: LocalUsagePeriodChange }>,
        categories: Object.fromEntries(CATEGORIES.map((category) => [category,
          compare(current.categories[category], previous.categories[category])])) as
          Record<LocalUsageCategory, { prs: LocalUsagePeriodChange; commits: LocalUsagePeriodChange }> },
    } satisfies LocalContributionWindow];
  })) as LocalContributionsResponse["windows"];
  const history: LocalContributionTrendDay[] = dates.map((date) => {
    const current = dateAggregate.get(date)!;
    const previous = dateAggregate.get(shift(date, -7));
    return { day: date, ...current,
      wow: { prs: percentage(current.prs, previous?.prs ?? null), commits: percentage(current.commits, previous?.commits ?? null) } };
  });
  const countsForSource = (source: LocalContributionSource, provider: "github" | "ado", period: number) => {
    const first = shift(end, 1 - period), byDay = dayMaps.get(source)!;
    return combine(Array.from({ length: period }, (_, index) => qualified({ provider, source,
      day: byDay.get(shift(first, index)) })));
  };
  const sourceAccounts: LocalContributionAccount[] = sources.map(({ provider, source }) => {
    const envelope = provider === "github" ? snapshot.github : snapshot.ado;
    return { sourceId: source.id, sourceIds: [source.id], provider, host: source.account.host, login: source.account.login,
      ...(source.scope ? { scope: source.scope } : {}), status: source.status,
      scopes: source.scope ? [source.scope] : [],
      cutoffAt: Date.parse(envelope.asOfAt), capturedAt: Date.parse(envelope.capturedAt), coverage: source.coverage,
      windows: Object.fromEntries(PERIODS.map((period) => [String(period), countsForSource(source, provider, period)])) as
        LocalContributionAccount["windows"] };
  });
  const grouped = new Map<string, LocalContributionAccount>();
  for (const account of sourceAccounts) {
    const source = sources.find((row) => row.source.id === account.sourceId)!;
    const key = JSON.stringify([account.provider, account.host.toLowerCase(), source.source.account.stableId]);
    const previous = grouped.get(key);
    if (previous && previous.login.toLowerCase() !== account.login.toLowerCase()) throw new Error("Account login changed between source scopes");
    if (!previous) { grouped.set(key, account); continue; }
    const statuses = [previous.status, account.status];
    grouped.set(key, { ...previous, sourceIds: [...previous.sourceIds, account.sourceId], scopes: [...previous.scopes, ...account.scopes],
      scope: undefined,
      status: statuses.every((item) => item === "ready") ? "ready" : statuses.every((item) => item === "unavailable") ? "unavailable"
        : statuses.includes("stale") ? "stale" : "partial",
      cutoffAt: Math.min(previous.cutoffAt, account.cutoffAt), capturedAt: Math.max(previous.capturedAt, account.capturedAt),
      coverage: { identityVerified: previous.coverage.identityVerified && account.coverage.identityVerified,
        paginationComplete: previous.coverage.paginationComplete && account.coverage.paginationComplete,
        visibilityComplete: previous.coverage.visibilityComplete && account.coverage.visibilityComplete,
        reasons: [...new Set([...previous.coverage.reasons, ...account.coverage.reasons])] },
      windows: Object.fromEntries(PERIODS.map((period) => [String(period),
        combine([previous.windows[String(period) as "1" | "7" | "30" | "60"], account.windows[String(period) as "1" | "7" | "30" | "60"]])])) as
        LocalContributionAccount["windows"] });
  }
  const accounts = [...grouped.values()];
  const sourceCoverage = { total: sources.length, ready: 0, partial: 0, stale: 0, unavailable: 0 };
  for (const { source } of sources) sourceCoverage[source.status]++;
  const allReady = sources.length > 0 && sourceCoverage.ready === sources.length &&
    snapshot.github.collection.complete && snapshot.ado.collection.complete && history.every((row) => row.coverage === "ready");
  const anyObserved = history.some((row) => row.coverage !== "unavailable");
  const resultStatus: LocalUsageStatus = !anyObserved ? "unavailable"
    : now - Math.min(Date.parse(snapshot.github.capturedAt), Date.parse(snapshot.ado.capturedAt)) > STALE_MS || sourceCoverage.stale > 0 ? "stale"
      : allReady ? "ready" : "partial";
  const sixty = aggregatePeriod(60, end);
  return { metricDefinition: "contributions-v2", timeZone: "Asia/Shanghai", dateBasis: {
    github: snapshot.github.dateBasis, ado: snapshot.ado.dateBasis, tokens: "Asia/Shanghai" },
    status: resultStatus, asOf, cutoffAt: asOf, capturedAt,
    sourceCoverage, currentDayPartial: true,
    sourceDays: { github: { startDay: snapshot.github.operationWindow.startDay, endDay: end,
        coverage: snapshot.github.collection.complete && snapshot.github.sources.every((source) => source.status === "ready" &&
          source.days.length === 60 && source.days.every((row) => row.status === "ready")) ? "ready" : "partial" },
      ado: { startDay: snapshot.ado.operationWindow.startDay, endDay: end,
        coverage: snapshot.ado.collection.complete && snapshot.ado.sources.every((source) => source.status === "ready" &&
          source.days.length === 60 && source.days.every((row) => row.status === "ready")) ? "ready" : "partial" } },
    accounts, windows, sixtyDayRepositories: { startDay: sixty.startDay, endDay: sixty.endDay,
      repositories: sixty.repositories }, trend: history.slice(-30), history };
}

export function createLocalContributionsReader(file = join(homedir(), ".local", "share", "mymausbot", "usage", "contributions-v2.json"),
  now: () => number = Date.now) {
  return async (): Promise<LocalContributionsResponse> => {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return unavailable();
      const bytes = await readFile(file);
      if (bytes.length > MAX_FILE_BYTES) return unavailable();
      return aggregateContributionSnapshot(parseContributionSnapshot(JSON.parse(bytes.toString("utf8")), now()), now());
    } catch {
      return unavailable();
    }
  };
}
