/** Read-only host observations for the local owner's Computer panel. */
export type LocalDashboardStatus = "ready" | "stale" | "unavailable";

export type LocalAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface LocalAgentMember {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  model: string | null;
  state: LocalAgentState;
  taskHint: string | null;
}

export interface LocalAgentTeam {
  id: string;
  name: string;
  agentCount: number;
  agents: LocalAgentMember[];
}

/** A null count means Herdr has never produced a valid snapshot. Stale rows are last-known observations. */
export interface LocalAgentTeamsResponse {
  status: LocalDashboardStatus;
  updatedAt: number | null;
  teamCount: number | null;
  teams: LocalAgentTeam[];
}

export type LocalUsageStatus = "ready" | "partial" | "stale" | "unavailable";
export type LocalUsageCoverage = "ready" | "partial" | "unavailable";
export type LocalUsageTokenStatus = "ready" | "partial" | "unavailable";
export type LocalUsageCategory = "work" | "personal" | "unclassified";

export interface LocalUsageSourceCoverage {
  total: number;
  ready: number;
  partial: number;
  stale: number;
  missing: number;
}

export interface LocalUsagePrSourceCoverage {
  total: number;
  ready: number;
  stale: number;
  unavailable: number;
  missing: number;
}

/** Numeric values are observed totals when coverage is partial; non-null knownPrs is a lower bound when prs is null. */
export interface LocalUsageWindow {
  days: 1 | 7 | 30;
  startDay: string;
  endDay: string;
  asOf: number;
  coverage: LocalUsageCoverage;
  tokenCoverage: LocalUsageTokenStatus;
  missingDays: string[];
  unavailableTokenDays: string[];
  prs: number | null;
  knownPrs: number | null;
  commits: number | null;
  newTokens: number | null;
  cacheRead: number | null;
}

/** Missing dates have null metrics. Token-unavailable dates have null token metrics. */
export interface LocalUsageTrendDay {
  day: string;
  coverage: LocalUsageCoverage;
  tokenStatus: LocalUsageTokenStatus;
  prs: number | null;
  knownPrs: number | null;
  commits: number | null;
  newTokens: number | null;
  cacheRead: number | null;
}

/** Windows include the capture date through asOf. The trend contains exactly the same 30 dates as window 30. */
export interface LocalUsageResponse {
  status: LocalUsageStatus;
  asOf: number | null;
  timeZone: "Asia/Shanghai";
  sourceCoverage: LocalUsageSourceCoverage | null;
  prSourceCoverage: LocalUsagePrSourceCoverage | null;
  prCoverage: Record<LocalUsageCategory, "ready" | "partial"> | null;
  windows: Record<"1" | "7" | "30", LocalUsageWindow> | null;
  trend: LocalUsageTrendDay[];
}
