import { readFile, stat } from "node:fs/promises";
import type { LocalUsageCategory, LocalUsageCoverage, LocalUsageMergedCounts, LocalUsageMergedResponse,
  LocalUsageMergedTrendDay, LocalUsageMergedWindow, LocalUsagePeriodChange } from "../shared/local-dashboard.ts";

const CATEGORIES: LocalUsageCategory[] = ["work", "personal", "unclassified"];
const WINDOWS = [1, 7, 30] as const;
const DAY_MS = 86_400_000;
const STALE_MS = 15 * 60_000;
const MAX_BYTES = 16 * 1024 * 1024;
const OPAQUE = /^[0-9a-f]{64}$/;
const CHINA_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });
type Category = LocalUsageCategory;
type SourceStatus = "ready" | "partial" | "stale" | "unavailable";
type Repo = { id: string; name: string };
type Pr = { key: string; at: number; day: string; category: Category; repository: Repo; commits: string[] };
type Commit = { key: string; at: number; day: string; category: Category; repository: Repo };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote Usage record");
  return value as Record<string, unknown>;
}

function instant(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("Invalid remote Usage instant");
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error("Invalid remote Usage instant");
  return at;
}

function day(at: number): string {
  const parts = Object.fromEntries(CHINA_DATE.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shift(value: string, offset: number): string {
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid remote Usage date");
  }
  return new Date(at + offset * DAY_MS).toISOString().slice(0, 10);
}

function category(value: unknown): Category {
  if (!CATEGORIES.includes(value as Category)) throw new Error("Invalid remote Usage category");
  return value as Category;
}

function opaque(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE.test(value)) throw new Error("Invalid remote Usage identity");
  return value;
}

function repository(value: unknown): Repo {
  const row = object(value);
  const name = row.name;
  if (typeof name !== "string" || !name || name.length > 200 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error("Invalid remote repository name");
  return { id: opaque(row.id), name };
}

function change(current: number | null, previous: number | null): LocalUsagePeriodChange {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : "new";
  return (current - previous) / previous * 100;
}

function counts(prs: Pr[], commits: Commit[], complete: boolean): LocalUsageMergedCounts {
  const knownPrs = prs.length, knownCommits = commits.length;
  return { prs: complete ? knownPrs : null, knownPrs, commits: complete ? knownCommits : null, knownCommits };
}

function inside<T extends { day: string }>(rows: T[], from: string, through: string): T[] {
  return rows.filter((row) => row.day >= from && row.day <= through);
}

function projection(raw: unknown, now: number): LocalUsageMergedResponse {
  const snapshot = object(raw);
  const asOf = instant(snapshot.asOfAt), capturedAt = instant(snapshot.capturedAt);
  if (snapshot.version !== 1 || asOf > now + 5 * 60_000 || capturedAt < asOf || capturedAt > now + 5 * 60_000) {
    throw new Error("Invalid remote Usage snapshot");
  }
  const endDay = day(asOf), firstDay = shift(endDay, -59);
  if (snapshot.windowStartDay !== firstDay || !Array.isArray(snapshot.sources) || snapshot.sources.length > 24) {
    throw new Error("Invalid remote Usage window");
  }
  const sourceIds = new Set<string>();
  const sources = snapshot.sources.map((value) => {
    const source = object(value);
    const status = source.status as SourceStatus;
    if (!["ready", "partial", "stale", "unavailable"].includes(status) || !["github", "ghe", "ado"].includes(String(source.provider)) ||
        !Array.isArray(source.items) || source.items.length > 1000) throw new Error("Invalid remote Usage source");
    const sourceId = opaque(source.id);
    if (sourceIds.has(sourceId)) throw new Error("Duplicate remote Usage source");
    sourceIds.add(sourceId);
    const observedAt = source.capturedAt === undefined ? null : instant(source.capturedAt);
    if (status === "ready" && observedAt !== asOf || status === "stale" && (observedAt === null || observedAt > asOf)) {
      throw new Error("Invalid remote Usage source time");
    }
    category(source.category);
    const items: Pr[] = source.items.map((value) => {
      const item = object(value), at = instant(item.at), repo = repository(item.repository);
      if (at > asOf || !Array.isArray(item.commits) || item.commits.length > 1000) throw new Error("Invalid remote PR");
      const commits = item.commits.map(opaque);
      if (new Set(commits).size !== commits.length) throw new Error("Duplicate original commit in PR");
      return { key: opaque(item.key), at, day: day(at), category: category(item.category), repository: repo, commits };
    }).filter((item) => item.day >= firstDay && item.day <= endDay);
    return { status, items };
  });
  const sourceCoverage = { total: sources.length, ready: 0, partial: 0, stale: 0, unavailable: 0 };
  for (const source of sources) sourceCoverage[source.status]++;
  const complete = sourceCoverage.total > 0 && sourceCoverage.ready === sourceCoverage.total;
  const byPr = new Map<string, Pr>();
  for (const source of sources) for (const item of source.items) {
    const previous = byPr.get(item.key);
    if (!previous) { byPr.set(item.key, item); continue; }
    if (previous.at !== item.at || previous.repository.id !== item.repository.id || JSON.stringify(previous.commits) !== JSON.stringify(item.commits)) {
      throw new Error("Conflicting remote PR identity");
    }
    if (previous.category !== item.category) byPr.set(item.key, { ...previous, category: "unclassified" });
  }
  const prs = [...byPr.values()];
  const occurrences = prs.flatMap((pr) => pr.commits.map((key) => ({ key, at: pr.at, day: pr.day,
    category: pr.category, repository: pr.repository, prKey: pr.key }))).sort((a, b) => a.at - b.at || a.prKey.localeCompare(b.prKey));
  const byRepoCommit = new Map<string, (typeof occurrences)[number]>();
  for (const item of occurrences) {
    const key = `${item.repository.id}:${item.key}`;
    if (!byRepoCommit.has(key)) byRepoCommit.set(key, item);
  }
  const repoCommits = [...byRepoCommit.values()];
  const byCommit = new Map<string, Commit>();
  const categories = new Map<string, Set<Category>>(), days = new Map<string, Set<string>>();
  for (const item of occurrences) {
    if (!byCommit.has(item.key)) byCommit.set(item.key, item);
    const priorCategories = categories.get(item.key) ?? new Set<Category>();
    priorCategories.add(item.category); categories.set(item.key, priorCategories);
    const priorDays = days.get(item.key) ?? new Set<string>();
    priorDays.add(item.day); days.set(item.key, priorDays);
  }
  const commits = [...byCommit.values()].map((item) => ({ ...item,
    category: categories.get(item.key)!.size > 1 ? "unclassified" as const : item.category }));
  const repeats = new Map<string, number>();
  for (const item of occurrences) repeats.set(item.key, (repeats.get(item.key) ?? 0) + 1);
  const overlaps = { repeatedShas: [...repeats.values()].filter((count) => count > 1).length,
    categoryConflicts: [...categories.values()].filter((values) => values.size > 1).length,
    dayConflicts: [...days.values()].filter((values) => values.size > 1).length };
  const coverage: LocalUsageCoverage = complete ? "ready" : sourceCoverage.total === 0 || sourceCoverage.unavailable === sourceCoverage.total ? "unavailable" : "partial";

  function makeWindow(days: 1 | 7 | 30, through: string): LocalUsageMergedWindow {
    const startDay = shift(through, 1 - days);
    const selectedPrs = inside(prs, startDay, through), selectedCommits = inside(commits, startDay, through);
    const total = counts(selectedPrs, selectedCommits, complete);
    const categoryCounts = Object.fromEntries(CATEGORIES.map((key) => [key, counts(
      selectedPrs.filter((item) => item.category === key), selectedCommits.filter((item) => item.category === key), complete)])) as Record<Category, LocalUsageMergedCounts>;
    const repoRows = new Map<string, { repository: Repo; category: Category; prs: Set<string>; commits: Set<string> }>();
    const rowFor = (repo: Repo, kind: Category) => {
      const row = repoRows.get(repo.id) ?? { repository: repo, category: kind, prs: new Set<string>(), commits: new Set<string>() };
      if (row.category !== kind) row.category = "unclassified";
      repoRows.set(repo.id, row);
      return row;
    };
    for (const pr of selectedPrs) rowFor(pr.repository, pr.category).prs.add(pr.key);
    for (const item of inside(repoCommits, startDay, through)) rowFor(item.repository, item.category).commits.add(item.key);
    const repoAll = [...repoRows.values()].sort((a, b) => b.prs.size + b.commits.size - a.prs.size - a.commits.size || a.repository.name.localeCompare(b.repository.name));
    const displayed = repoAll.slice(0, 100);
    const shownPrs = new Set(displayed.flatMap((row) => [...row.prs]));
    const shownCommits = new Set(displayed.flatMap((row) => [...row.commits]));
    const sharedCommits = Math.max(0, repoAll.reduce((sum, row) => sum + row.commits.size, 0) - selectedCommits.length);
    const repoResults = displayed.map((row) => {
      const earlier = inside(prs, shift(startDay, -days), shift(startDay, -1)).filter((pr) => pr.repository.id === row.repository.id);
      const earlierCommits = new Set(inside(repoCommits, shift(startDay, -days), shift(startDay, -1))
        .filter((item) => item.repository.id === row.repository.id).map((item) => item.key));
      return { id: row.repository.id, name: row.repository.name, category: row.category,
        prs: complete ? row.prs.size : null, knownPrs: row.prs.size,
        commits: complete ? row.commits.size : null, knownCommits: row.commits.size,
        comparison: { prs: change(complete ? row.prs.size : null, complete ? earlier.length : null),
          commits: change(complete ? row.commits.size : null, complete ? earlierCommits.size : null) } };
    });
    return { days, startDay, endDay: through, asOf, coverage, missingDays: [], ...total, categories: categoryCounts,
      repositories: { coverage: repoAll.length > displayed.length ? "partial" : coverage, rows: repoResults,
        unattributedPrs: complete ? selectedPrs.length - shownPrs.size : null,
        unattributedCommits: complete ? selectedCommits.filter((item) => !shownCommits.has(item.key)).length : null,
        sharedCommits },
      comparison: { startDay: shift(startDay, -days), endDay: shift(startDay, -1), missingDays: [],
        prs: null, commits: null, categories: Object.fromEntries(CATEGORIES.map((key) => [key, { prs: null, commits: null }])) as LocalUsageMergedWindow["comparison"]["categories"] } };
  }

  const windows = {} as Record<"1" | "7" | "30", LocalUsageMergedWindow>;
  for (const size of WINDOWS) {
    const current = makeWindow(size, endDay), previous = makeWindow(size, shift(current.startDay, -1));
    current.comparison.prs = change(current.prs, previous.prs);
    current.comparison.commits = change(current.commits, previous.commits);
    for (const key of CATEGORIES) current.comparison.categories[key] = {
      prs: change(current.categories[key].prs, previous.categories[key].prs),
      commits: change(current.categories[key].commits, previous.categories[key].commits) };
    windows[String(size) as "1" | "7" | "30"] = current;
  }
  const trend: LocalUsageMergedTrendDay[] = Array.from({ length: 30 }, (_, index) => {
    const currentDay = shift(endDay, index - 29);
    const current = makeWindow(1, currentDay), previous = makeWindow(1, shift(currentDay, -7));
    return { day: currentDay, coverage, prs: current.prs, knownPrs: current.knownPrs,
      commits: current.commits, knownCommits: current.knownCommits, categories: current.categories,
      wow: { prs: change(current.prs, previous.prs), commits: change(current.commits, previous.commits) } };
  });
  const stale = now - capturedAt > STALE_MS || day(now) !== endDay || sourceCoverage.stale > 0;
  const unavailable = sourceCoverage.total === 0 || sourceCoverage.unavailable === sourceCoverage.total;
  const status = unavailable ? "unavailable" : stale ? "stale" : complete ? "ready" : "partial";
  return { status, asOf, timeZone: "Asia/Shanghai", sourceCoverage, overlaps, windows, trend };
}

export function createLocalUsageMergedReader(file: string, now: () => number = Date.now) {
  let lastGood: LocalUsageMergedResponse | null = null;
  return async (): Promise<LocalUsageMergedResponse | undefined> => {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Invalid remote Usage file");
      const bytes = await readFile(file);
      if (bytes.length > MAX_BYTES) throw new Error("Invalid remote Usage file");
      const result = projection(JSON.parse(bytes.toString("utf8")), now());
      if (result.status !== "unavailable") lastGood = result;
      return result;
    } catch {
      return lastGood ? { ...lastGood, status: "stale" } : undefined;
    }
  };
}
