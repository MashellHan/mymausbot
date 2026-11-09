import type {
  LocalUsageCategory, LocalUsageCounts, LocalUsageMergedCounts, LocalUsageResponse,
  LocalUsageTrendDay, LocalUsageWindow, LocalUsageMergedResponse, LocalUsageRepositories,
} from "../../shared/local-dashboard.ts";
import { usageTrendRange, type UsageTrendRange } from "../../shared/local-usage-range.ts";

type UsageCounts = LocalUsageCounts & { knownCommits: number | null };
type Categories = Record<LocalUsageCategory, UsageCounts>;
export type UsageWindow = Omit<LocalUsageWindow, "categories" | "repositories"> & UsageCounts & {
  categories: Categories;
  repositories: Omit<LocalUsageWindow["repositories"], "rows"> & { rows: (LocalUsageWindow["repositories"]["rows"][number] & UsageCounts)[] };
};
export type UsageTrendDay = Omit<LocalUsageTrendDay, "categories" | "repositories"> & UsageCounts & { categories: Categories; repositories?: UsageWindow["repositories"] };
export type UsageRepositoryWindow = Pick<UsageWindow, "startDay" | "endDay" | "repositories"> & { comparison: Pick<UsageWindow["comparison"], "startDay" | "endDay"> };
const periods = ["1", "7", "30"] as const;
const shiftDay = (day: string, offset: number) => new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
const counts = (value?: LocalUsageMergedCounts): UsageCounts => value ?? { prs: null, knownPrs: null, commits: null, knownCommits: null };
const emptyComparisons = () => ({ work: { prs: null, commits: null }, personal: { prs: null, commits: null }, unclassified: { prs: null, commits: null } });
const categoryCounts = (value?: Record<LocalUsageCategory, LocalUsageMergedCounts>): Categories => ({
  work: counts(value?.work), personal: counts(value?.personal), unclassified: counts(value?.unclassified),
});

function tokensIn(snapshot: LocalUsageResponse, startDay: string, endDay: string) {
  const exact = snapshot.windows && Object.values(snapshot.windows).find((window) => window.startDay === startDay && window.endDay === endDay);
  if (exact) return { tokenCoverage: exact.tokenCoverage, unavailableTokenDays: exact.unavailableTokenDays,
    newTokens: exact.newTokens, cacheRead: exact.cacheRead, totalTokens: exact.totalTokens };
  const daily = new Map(snapshot.trend.map((row) => [row.day, row]));
  const dates: string[] = [];
  for (let day = startDay; day <= endDay; day = shiftDay(day, 1)) dates.push(day);
  const available = dates.map((day) => daily.get(day)).filter((row): row is LocalUsageTrendDay => !!row && row.tokenStatus !== "unavailable");
  const unavailableTokenDays = dates.filter((day) => !daily.has(day) || daily.get(day)!.tokenStatus === "unavailable");
  const sum = (field: "newTokens" | "cacheRead" | "totalTokens") => available.length ? available.reduce((total, row) => total + (row[field] ?? 0), 0) : null;
  return { tokenCoverage: !available.length ? "unavailable" as const
    : unavailableTokenDays.length || available.some((row) => row.tokenStatus !== "ready") ? "partial" as const : "ready" as const,
  unavailableTokenDays, newTokens: sum("newTokens"), cacheRead: sum("cacheRead"), totalTokens: sum("totalTokens") };
}

function tokenChange(snapshot: LocalUsageResponse, window: Pick<LocalUsageWindow, "days" | "startDay" | "endDay">) {
  const local = snapshot.windows?.[String(window.days) as typeof periods[number]];
  if (local?.startDay === window.startDay && local.endDay === window.endDay) return local.comparison.totalTokens;
  const current = tokensIn(snapshot, window.startDay, window.endDay);
  const previous = tokensIn(snapshot, shiftDay(window.startDay, -window.days), shiftDay(window.startDay, -1));
  if (current.tokenCoverage !== "ready" || previous.tokenCoverage !== "ready" || current.totalTokens === null || previous.totalTokens === null) return null;
  return previous.totalTokens === 0 ? current.totalTokens === 0 ? 0 : "new" as const : (current.totalTokens - previous.totalTokens) / previous.totalTokens * 100;
}

function remoteUsageView(snapshot: LocalUsageResponse, range: UsageTrendRange, github: Omit<LocalUsageMergedResponse, "overlaps"> | undefined) {
  const basis = github?.windows ?? snapshot.windows;
  const windows = basis && Object.fromEntries(periods.map((key) => {
    const window = basis[key], remote = github?.windows?.[key];
    const observed = remote?.coverage !== "unavailable" ? remote : undefined;
    const previousStart = shiftDay(window.startDay, -window.days), previousEnd = shiftDay(window.startDay, -1);
    const tokens = tokensIn(snapshot, window.startDay, window.endDay);
    const previousTokens = tokensIn(snapshot, previousStart, previousEnd);
    const local = snapshot.windows?.[key];
    const localMatches = local?.startDay === window.startDay && local.endDay === window.endDay;
    return [key, {
      days: window.days, startDay: window.startDay, endDay: window.endDay, asOf: window.asOf,
      ...counts(observed), ...tokens, categories: categoryCounts(observed?.categories),
      coverage: !observed && tokens.tokenCoverage === "unavailable" ? "unavailable"
        : remote?.coverage === "ready" && tokens.tokenCoverage === "ready" ? "ready" : "partial",
      missingDays: remote?.missingDays ?? [],
      repositories: remote?.repositories ?? { coverage: "unavailable", rows: [], unattributedPrs: null, unattributedCommits: null, sharedCommits: 0 },
      comparison: { startDay: previousStart, endDay: previousEnd, missingDays: remote?.comparison.missingDays ?? [],
        unavailableTokenDays: localMatches ? local.comparison.unavailableTokenDays : previousTokens.unavailableTokenDays,
        prs: observed?.comparison.prs ?? null, commits: observed?.comparison.commits ?? null,
        totalTokens: tokenChange(snapshot, window), categories: observed?.comparison.categories ?? emptyComparisons() },
    } satisfies UsageWindow];
  })) as Record<typeof periods[number], UsageWindow> | null;
  const remoteTrend = range === "30" ? github?.trend ?? []
    : github?.history ?? github?.trend ?? [];
  const remoteDays = new Map(remoteTrend.map((day) => [day.day, day]));
  const tokenTrend = range === "30" ? snapshot.trend : [...(snapshot.history ?? []), ...snapshot.trend];
  const tokenDays = new Map<string, LocalUsageTrendDay>();
  for (const row of tokenTrend) {
    const known = tokenDays.get(row.day);
    tokenDays.set(row.day, range !== "30" && row.tokenStatus === "unavailable" && known && known.tokenStatus !== "unavailable"
      ? { ...known, tokenStatus: "partial", wow: { ...known.wow, newTokens: null, totalTokens: null } } : row);
  }
  const period = basis && usageTrendRange(basis["30"].endDay, range);
  const trend: UsageTrendDay[] = period ? Array.from({ length: period.days }, (_, index) => {
    const day = shiftDay(period.startDay, index), raw = remoteDays.get(day);
    const remote = raw?.coverage !== "unavailable" ? raw : undefined, token = tokenDays.get(day);
    return { day, coverage: raw?.coverage ?? "unavailable", ...counts(remote), categories: categoryCounts(remote?.categories), repositories: remote?.repositories,
      tokenStatus: token?.tokenStatus ?? "unavailable", newTokens: token?.newTokens ?? null,
      cacheRead: token?.cacheRead ?? null, totalTokens: token?.totalTokens ?? null,
      wow: { prs: remote?.wow.prs ?? null, commits: remote?.wow.commits ?? null,
        newTokens: token?.wow.newTokens ?? null, totalTokens: token?.wow.totalTokens ?? null } };
  }) : [];
  const tokenStatus = !snapshot.windows ? "unavailable" : snapshot.status === "stale" ? "stale" : snapshot.windows["30"].tokenCoverage;
  const statuses = [github?.status ?? "unavailable", tokenStatus];
  const status = statuses.every((status) => status === "unavailable") ? "unavailable"
    : statuses.includes("stale") ? "stale" : statuses.every((status) => status === "ready") ? "ready" : "partial";
  return { windows, trend, period, status, asOf: github?.asOf ?? snapshot.asOf,
    sixtyDayRepositories: period ? repositoryHistoryWindow(period.endDay, github?.sixtyDayRepositories) : null };
}

export function profileUsageView(snapshot: LocalUsageResponse, range: UsageTrendRange = "30") {
  return remoteUsageView(snapshot, range, snapshot.github?.metricDefinition === "github-profile-v1" ? snapshot.github : undefined);
}

export function mergedUsageView(snapshot: LocalUsageResponse, range: UsageTrendRange = "30") {
  return remoteUsageView(snapshot, range, snapshot.merged);
}

const repositoryCounts = (value?: LocalUsageCounts): UsageCounts => ({
  prs: value?.prs ?? null, knownPrs: value?.knownPrs ?? null, commits: value?.commits ?? null, knownCommits: value?.commits ?? null,
});
const repositoryCategories = (value?: Record<LocalUsageCategory, LocalUsageCounts>): Categories => ({
  work: repositoryCounts(value?.work), personal: repositoryCounts(value?.personal), unclassified: repositoryCounts(value?.unclassified),
});

function repositoryDetails(value?: LocalUsageRepositories): UsageWindow["repositories"] | undefined {
  return value && { ...value, rows: value.rows.map(row => ({ ...row, ...repositoryCounts(row) })) };
}

function repositoryHistoryWindow(endDay: string, value?: Pick<UsageRepositoryWindow, "startDay" | "endDay" | "repositories">): UsageRepositoryWindow {
  const startDay = shiftDay(endDay, -59);
  return { startDay, endDay, comparison: { startDay: shiftDay(startDay, -60), endDay: shiftDay(startDay, -1) },
    repositories: value?.startDay === startDay && value.endDay === endDay ? value.repositories
      : { coverage: "unavailable", rows: [], unattributedPrs: null, unattributedCommits: null, sharedCommits: 0 } };
}

export function localUsageView(snapshot: LocalUsageResponse, range: UsageTrendRange = "30") {
  const windows = snapshot.windows && Object.fromEntries(periods.map((key) => {
    const window = snapshot.windows![key];
    return [key, { ...window, ...repositoryCounts(window), categories: repositoryCategories(window.categories),
      repositories: { ...window.repositories, rows: window.repositories.rows.map((row) => ({ ...row, ...repositoryCounts(row) })) },
    } satisfies UsageWindow];
  })) as Record<typeof periods[number], UsageWindow> | null;
  const period = windows && usageTrendRange(windows["30"].endDay, range);
  const activityDays = new Map((range === "30" ? snapshot.trend : [...(snapshot.history ?? []), ...snapshot.trend]).map((day) => [day.day, day]));
  const tokenDays = new Map<string, LocalUsageTrendDay>();
  for (const row of range === "30" ? snapshot.trend : [...(snapshot.history ?? []), ...snapshot.trend]) {
    const known = tokenDays.get(row.day);
    tokenDays.set(row.day, range !== "30" && row.tokenStatus === "unavailable" && known && known.tokenStatus !== "unavailable"
      ? { ...known, tokenStatus: "partial", wow: { ...known.wow, newTokens: null, totalTokens: null } } : row);
  }
  const trend: UsageTrendDay[] = period ? Array.from({ length: period.days }, (_, index) => {
    const day = shiftDay(period.startDay, index), raw = activityDays.get(day), token = tokenDays.get(day);
    const activity = raw?.coverage !== "unavailable" ? raw : undefined;
    return { day, coverage: raw?.coverage ?? "unavailable", ...repositoryCounts(activity), categories: repositoryCategories(activity?.categories), repositories: repositoryDetails(activity?.repositories),
      tokenStatus: token?.tokenStatus ?? "unavailable", newTokens: token?.newTokens ?? null,
      cacheRead: token?.cacheRead ?? null, totalTokens: token?.totalTokens ?? null,
      wow: { prs: activity?.wow.prs ?? null, commits: activity?.wow.commits ?? null,
        newTokens: token?.wow.newTokens ?? null, totalTokens: token?.wow.totalTokens ?? null } };
  }) : [];
  const sixty = snapshot.sixtyDayRepositories;
  const repositoryHistory = sixty && { ...sixty, repositories: repositoryDetails(sixty.repositories)! };
  return { windows, trend, period, status: snapshot.status, asOf: snapshot.asOf, metricDefinition: "repository-observations-v1" as const,
    sixtyDayRepositories: period ? repositoryHistoryWindow(period.endDay, repositoryHistory) : null };
}

export function retainUsageSnapshot(previous: LocalUsageResponse | null, next: LocalUsageResponse): LocalUsageResponse {
  const local = !next.windows && previous?.windows ? { ...previous, status: "stale" as const } : next;
  const merged = !next.merged?.windows && previous?.merged?.windows ? { ...previous.merged, status: "stale" as const } : next.merged;
  const github = !next.github?.windows && previous?.github?.windows ? { ...previous.github, status: "stale" as const } : next.github;
  return { ...local, merged, github };
}
