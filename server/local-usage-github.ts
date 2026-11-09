import { readFile, stat } from "node:fs/promises";
import type { LocalUsageCategory, LocalUsageGithubResponse, LocalUsageMergedCounts, LocalUsageMergedWindow } from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { MAX_USAGE_HISTORY_DAYS } from "../shared/local-usage-range.ts";

const CATEGORIES: LocalUsageCategory[] = ["work", "personal", "unclassified"];
const DAY = 86_400_000;
const DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
type Repo = { id: string; name: string; category: LocalUsageCategory; knownPrs: number; profileCommits: number | null };
type Row = { day: string; status: string; knownPrs: number; profileCommits: number | null; repositories: Repo[] };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid contribution object");
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid contribution count");
  return value as number;
}
function sum(values: number[]): number { return count(values.reduce((total, value) => total + value, 0)); }
function instant(value: unknown): number {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid contribution instant");
  return Date.parse(value);
}
function shift(day: string, offset: number): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== day) throw new Error("Invalid contribution day");
  return new Date(at + offset * DAY).toISOString().slice(0, 10);
}
function chinaDay(at: number): string {
  const parts = Object.fromEntries(DATE.formatToParts(at).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function opaque(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid contribution identity");
  return value;
}
function change(current: number | null, previous: number | null): number | "new" | null {
  return current === null || previous === null ? null : previous === 0 ? current === 0 ? 0 : "new" : (current - previous) / previous * 100;
}

function projection(raw: unknown, now: number): LocalUsageGithubResponse {
  const snapshot = object(raw), basis = object(snapshot.dateBasis), operation = object(snapshot.operationWindow);
  const asOf = instant(snapshot.asOfAt), capturedAt = instant(snapshot.capturedAt), end = chinaDay(asOf);
  if (snapshot.version !== 1 || snapshot.metricDefinition !== "github-profile-v1" || snapshot.qualification !== "nonfork-at-capture" || basis.prs !== "created-at/Asia-Shanghai" ||
      basis.commits !== "github-profile-day" || capturedAt < asOf || capturedAt > now + 300_000 || asOf > now + 300_000 ||
      operation.timeZone !== "Asia/Shanghai" || operation.startDay !== shift(end, -6) || operation.endDay !== end || operation.todayPartial !== true ||
      !Array.isArray(snapshot.activeSourceIds) || !snapshot.activeSourceIds.length || snapshot.activeSourceIds.length > 24 ||
      !Array.isArray(snapshot.sources) || snapshot.sources.length > 128) throw new Error("Invalid contribution definition or capture");
  const active = new Set(snapshot.activeSourceIds.map(opaque));
  if (active.size !== snapshot.activeSourceIds.length) throw new Error("Duplicate contribution account scope");
  const ids = new Set<string>();
  const sources = snapshot.sources.map(value => {
    const source = object(value), id = opaque(source.id), status = String(source.status);
    if (ids.has(id) || !["ready", "partial", "stale", "unavailable"].includes(status) || !Array.isArray(source.days) || source.days.length > 4096) throw new Error("Invalid contribution source");
    ids.add(id);
    if (!/^(?:github\.com|[a-z0-9-]+\.ghe\.com)$/.test(String(source.host))) throw new Error("Invalid contribution host");
    if (status !== "unavailable" && (typeof source.hasRestrictedContributions !== "boolean" ||
        (count(source.restrictedContributions) > 0 && !source.hasRestrictedContributions) || !opaque(source.account))) throw new Error("Invalid contribution visibility");
    const rows = new Map<string, Row>();
    for (const value of source.days) {
      const row = object(value), day = String(row.day);
      shift(day, 0);
      if (row.profilePrs !== null) count(row.profilePrs);
      if (day > end || rows.has(day) || !["partial", "stale"].includes(String(row.status)) || instant(row.capturedAt) > asOf ||
          row.chinaCommits !== null || typeof row.inProgress !== "boolean" ||
          count(row.rawPrs) !== count(row.knownPrs) + count(row.excludedForkPrs) ||
          !Array.isArray(row.repositories) || row.repositories.length > 1000) throw new Error("Invalid contribution day");
      const repositories: Repo[] = [], repoIds = new Set<string>();
      for (const value of row.repositories) {
        const repo = object(value), id = opaque(repo.id), category = repo.category as LocalUsageCategory;
        if (repoIds.has(id) || !CATEGORIES.includes(category) || typeof repo.name !== "string" || repo.name.length > 200 ||
            !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.name) || redactSecretsInText(repo.name) !== repo.name) throw new Error("Invalid contribution repository");
        repoIds.add(id);
        repositories.push({ id, name: repo.name, category, knownPrs: count(repo.knownPrs), profileCommits: repo.profileCommits === null ? null : count(repo.profileCommits) });
      }
      const knownPrs = count(row.knownPrs), profileCommits = row.profileCommits === null ? null : count(row.profileCommits);
      if (repositories.some(repo => (repo.profileCommits === null) !== (profileCommits === null)) ||
          sum(repositories.map(repo => repo.knownPrs)) !== knownPrs || profileCommits !== null && sum(repositories.map(repo => repo.profileCommits ?? 0)) !== profileCommits) throw new Error("Inconsistent contribution accounting");
      rows.set(day, { day, status: String(row.status), knownPrs, profileCommits, repositories });
    }
    const totals = source.collectionTotals === undefined ? null : object(source.collectionTotals);
    const startAt = source.startedAt === undefined ? null : instant(source.startedAt);
    const endAt = source.endedAt === undefined ? null : instant(source.endedAt);
    if (totals && (startAt === null || endAt === null || startAt > endAt || endAt > asOf)) throw new Error("Invalid contribution query totals");
    const account = { id, host: String(source.host), apiStatus: status as "ready" | "partial" | "stale" | "unavailable",
      startAt, endAt, contributions: totals ? count(totals.contributions) : null,
      commits: totals ? count(totals.commits) : null, rawPrs: totals ? count(totals.rawPrs) : null,
      restricted: source.restrictedContributions === undefined ? null : count(source.restrictedContributions),
      outsideWindowPrs: source.outsideWindowPrs === undefined ? null : count(source.outsideWindowPrs) };
    return { id, status: account.apiStatus, rows, account };
  }).filter(source => active.has(source.id));
  if (sources.length !== active.size) throw new Error("Missing configured contribution source");
  const sourceCoverage = { total: sources.length, ready: 0, partial: 0, stale: 0, unavailable: 0 };
  for (const source of sources) sourceCoverage[source.status]++;

  function makeWindow(days: 1 | 7 | 30, through: string): LocalUsageMergedWindow {
    const start = shift(through, 1 - days), dates = Array.from({ length: days }, (_, index) => shift(start, index));
    const selected = sources.flatMap(source => dates.flatMap(day => source.rows.get(day) ?? []));
    const missingDays = dates.filter(day => sources.some(source => !source.rows.has(day)));
    const completePrs = selected.length === days * sources.length && selected.every(row => row.status === "ready");
    const total = (category?: LocalUsageCategory): LocalUsageMergedCounts => {
      const repos = selected.flatMap(row => row.repositories).filter(repo => !category || repo.category === category);
      const knownPrs = sum(category ? repos.map(repo => repo.knownPrs) : selected.map(row => row.knownPrs));
      const observedCommits = selected.some(row => row.profileCommits !== null);
      return { prs: completePrs ? knownPrs : null, knownPrs, commits: null,
        knownCommits: observedCommits ? sum(category ? repos.map(repo => repo.profileCommits ?? 0) : selected.map(row => row.profileCommits ?? 0)) : null };
    };
    const repoRows = new Map<string, Repo>();
    for (const repo of selected.flatMap(row => row.repositories)) {
      const old = repoRows.get(repo.id);
      repoRows.set(repo.id, old ? { ...old, category: old.category === repo.category ? old.category : "unclassified",
        knownPrs: sum([old.knownPrs, repo.knownPrs]), profileCommits: old.profileCommits === null && repo.profileCommits === null ? null : sum([old.profileCommits ?? 0, repo.profileCommits ?? 0]) } : { ...repo });
    }
    const coverage = selected.length ? "partial" as const : "unavailable" as const;
    const allRows = [...repoRows.values()].sort((a, b) => b.knownPrs - a.knownPrs || (b.profileCommits ?? 0) - (a.profileCommits ?? 0) || a.name.localeCompare(b.name));
    const rows = allRows.slice(0, 100).map(repo => ({ id: repo.id, name: repo.name, category: repo.category,
      prs: completePrs ? repo.knownPrs : null, knownPrs: repo.knownPrs, commits: null, knownCommits: repo.profileCommits,
      comparison: { prs: null, commits: null } }));
    const counts = total();
    return { days, startDay: start, endDay: through, asOf, coverage, missingDays, ...counts,
      categories: Object.fromEntries(CATEGORIES.map(key => [key, total(key)])) as Record<LocalUsageCategory, LocalUsageMergedCounts>,
      repositories: { coverage, rows, unattributedPrs: completePrs ? counts.knownPrs - sum(rows.map(row => row.knownPrs)) : null,
        unattributedCommits: null, sharedCommits: 0 },
      comparison: { startDay: shift(start, -days), endDay: shift(start, -1), missingDays: [], prs: null, commits: null,
        categories: Object.fromEntries(CATEGORIES.map(key => [key, { prs: null, commits: null }])) as LocalUsageMergedWindow["comparison"]["categories"] } };
  }
  function comparedWindow(days: 1 | 7 | 30, through: string) {
    const current = makeWindow(days, through), previous = makeWindow(days, shift(current.startDay, -1));
    current.comparison.prs = change(current.prs, previous.prs);
    current.comparison.missingDays = previous.missingDays;
    for (const key of CATEGORIES) current.comparison.categories[key].prs = change(current.categories[key].prs, previous.categories[key].prs);
    return current;
  }
  const windows = { "1": comparedWindow(1, end), "7": comparedWindow(7, end), "30": comparedWindow(30, end) };
  const history = Array.from({ length: MAX_USAGE_HISTORY_DAYS }, (_, index) => {
    const day = shift(end, index + 1 - MAX_USAGE_HISTORY_DAYS), current = makeWindow(1, day), previous = makeWindow(1, shift(day, -7));
    return { day, coverage: current.coverage, prs: current.prs, knownPrs: current.knownPrs,
      commits: null, knownCommits: current.knownCommits, categories: current.categories,
      wow: { prs: change(current.prs, previous.prs), commits: null } };
  });
  const observed = sources.some(source => source.rows.size > 0);
  const stale = now - capturedAt > 900_000 || chinaDay(now) !== end || sources.some(source => source.status === "stale" || [...source.rows.values()].some(row => row.day >= shift(end, -6) && row.status === "stale"));
  return { metricDefinition: "github-profile-v1", dateBasis: { prs: "created-at/Asia-Shanghai", commits: "github-profile-day" },
    chinaCommitAlignment: "unknown", qualification: "nonfork-at-capture", accounts: sources.map(source => source.account), status: !observed ? "unavailable" : stale ? "stale" : "partial", asOf, timeZone: "Asia/Shanghai", sourceCoverage, windows, trend: history.slice(-30), history };
}

export function createLocalUsageGithubReader(file: string, now: () => number = Date.now) {
  let lastGood: LocalUsageGithubResponse | undefined;
  return async (): Promise<LocalUsageGithubResponse | undefined> => {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Invalid contribution file");
      const bytes = await readFile(file);
      if (bytes.length > 16 * 1024 * 1024) throw new Error("Invalid contribution file");
      const result = projection(JSON.parse(bytes.toString("utf8")), now());
      if (result.status !== "unavailable") lastGood = result;
      return result;
    } catch { return lastGood ? { ...lastGood, status: "stale" } : undefined; }
  };
}
