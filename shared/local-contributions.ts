import type {
  LocalUsageCategory, LocalUsageCoverage, LocalUsageCountComparison, LocalUsagePeriodChange, LocalUsageStatus,
} from "./local-dashboard.ts";

export interface LocalContributionCounts {
  prs: number | null;
  knownPrs: number | null;
  commits: number | null;
  knownCommits: number | null;
}

/** Versioned provider observations. GitHub Profile and ADO retain their own source-day bases. */
export interface LocalContributionEnvelope {
  version: 2;
  metricDefinition: "github-profile-v2" | "ado-default-head-v1";
  provider: "github" | "ado";
  asOfAt: string;
  capturedAt: string;
  dateBasis: { prs: "github-profile-day"; commits: "github-profile-day" } | { prs: "created-at/UTC"; commits: "author-at/UTC" };
  operationWindow: { startDay: string; endDay: string; todayPartial: true };
  activeSourceIds: string[];
  sources: LocalContributionSource[];
  collection: { requestCount: number; elapsedSeconds: number; complete: boolean; reasons: string[]; rateLimit?: object };
  /** Private collector continuation. Never copied into the owner API response. */
  state?: object;
}

export interface LocalContributionSource {
  id: string;
  account: { host: string; login: string; stableId: string };
  scope?: { organization: string; project: string };
  status: LocalUsageStatus;
  coverage: { identityVerified: boolean; paginationComplete: boolean; visibilityComplete: boolean; reasons: string[] };
  days: LocalContributionDay[];
  provenance?: object;
}

export interface LocalContributionDay extends LocalContributionCounts {
  day: string;
  capturedAt: string;
  status: LocalUsageStatus;
  repositories: LocalContributionRepositoryDay[];
}

export interface LocalContributionRepositoryDay extends LocalContributionCounts {
  id: string;
  name: string;
  category: LocalUsageCategory;
  status: LocalUsageStatus;
  provenance?: object;
}

/** One atomically published cache generation; replacing it never adds the prior generation. */
export interface LocalContributionSnapshot {
  version: 2;
  github: LocalContributionEnvelope;
  ado: LocalContributionEnvelope;
}

export interface LocalContributionAccount {
  sourceId: string;
  sourceIds: string[];
  provider: "github" | "ado";
  host: string;
  login: string;
  scope?: { organization: string; project: string };
  scopes: { organization: string; project: string }[];
  status: LocalUsageStatus;
  cutoffAt: number;
  capturedAt: number;
  coverage: LocalContributionSource["coverage"];
  windows: Record<"1" | "7" | "30" | "60", LocalContributionCounts>;
}

export interface LocalContributionRepositories {
  coverage: LocalUsageCoverage;
  rows: (LocalContributionCounts & { id: string; name: string; category: LocalUsageCategory; comparison: LocalUsageCountComparison })[];
  unattributedPrs: number | null;
  unattributedCommits: number | null;
  sharedCommits: number;
}

export interface LocalContributionWindow extends LocalContributionCounts {
  days: 1 | 7 | 30;
  startDay: string;
  endDay: string;
  asOf: number;
  coverage: LocalUsageCoverage;
  missingDays: string[];
  categories: Record<LocalUsageCategory, LocalContributionCounts>;
  repositories: LocalContributionRepositories;
  comparison: { startDay: string; endDay: string; missingDays: string[];
    prs: LocalUsagePeriodChange; commits: LocalUsagePeriodChange;
    /** Known subtotals are comparable only with verified, paginated observations for every source-day in both periods. */
    known?: LocalUsageCountComparison;
    knownCategories?: Record<LocalUsageCategory, LocalUsageCountComparison>;
    categories: Record<LocalUsageCategory, LocalUsageCountComparison> };
}

export interface LocalContributionTrendDay extends LocalContributionCounts {
  day: string;
  coverage: LocalUsageCoverage;
  categories: Record<LocalUsageCategory, LocalContributionCounts>;
  repositories?: LocalContributionRepositories;
  wow: LocalUsageCountComparison;
}

/** Source-day contribution totals; token dates remain on the existing China-day basis. */
export interface LocalContributionsResponse {
  metricDefinition: "contributions-v2";
  status: LocalUsageStatus;
  asOf: number | null;
  timeZone: "provider-days";
  dateBasis: { github: LocalContributionEnvelope["dateBasis"]; ado: LocalContributionEnvelope["dateBasis"]; tokens: "Asia/Shanghai" };
  cutoffAt: number | null;
  capturedAt: number | null;
  currentDayPartial: boolean;
  accounts: LocalContributionAccount[];
  /** A source-day can be complete through its cutoff while the day itself is still open. */
  sourceDays: Record<"github" | "ado", { startDay: string; endDay: string; coverage: LocalUsageCoverage }> | null;
  sourceCoverage: { total: number; ready: number; partial: number; stale: number; unavailable: number } | null;
  windows: Record<"1" | "7" | "30", LocalContributionWindow> | null;
  sixtyDayRepositories?: Pick<LocalContributionWindow, "startDay" | "endDay" | "repositories">;
  trend: LocalContributionTrendDay[];
  history?: LocalContributionTrendDay[];
}
