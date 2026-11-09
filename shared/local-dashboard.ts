/** Read-only host observations for the local owner's Computer panel. */
export type LocalDashboardStatus = "ready" | "stale" | "unavailable";

export type LocalAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface LocalAgentMember {
  id: string;
  name: string;
  kind: string;
  role: string | null;
  model: string | null;
  reasoningEffort: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
  state: LocalAgentState;
  /** Latest user instruction, redacted and bounded; never the full transcript. */
  taskHint: string | null;
}

/** A partial count is a lower bound from verified current-team sessions; null never means zero. */
export interface LocalAgentTokenUsageWindow {
  coverage: "ready" | "partial" | "unavailable";
  knownTokens: number | null;
}

export interface LocalAgentTeam {
  id: string;
  name: string;
  agentCount: number;
  /** Agents currently working; blocked, idle and completed responses are not active. */
  activeAgentCount: number;
  /** Latest timestamp in a verified live agent session; absent or null when unavailable. */
  lastActivityAt?: number | null;
  tokenUsage24h?: LocalAgentTokenUsageWindow;
  tokenUsage7d?: LocalAgentTokenUsageWindow;
  agents: LocalAgentMember[];
}

/** A null count means Herdr has never produced a valid snapshot. Stale rows are last-known observations. */
export interface LocalAgentTeamsResponse {
  status: LocalDashboardStatus;
  updatedAt: number | null;
  teamCount: number | null;
  teams: LocalAgentTeam[];
}

export type LocalAgentActivityStatus = "ready" | "stale" | "unavailable" | "unsupported";
export type LocalAgentActivityKind = "user" | "assistant" | "tool-call" | "tool-result";

/** Redacted, bounded visible Codex events; IDs are local event positions, never session or tool credentials. */
export interface LocalAgentActivityEvent {
  id: string;
  at: number | null;
  kind: LocalAgentActivityKind;
  tool: string | null;
  text: string | null;
}

/** Details are fetched separately from the team metadata only while a member's disclosure is open. */
export interface LocalAgentActivityResponse {
  agentId: string;
  status: LocalAgentActivityStatus;
  /** Last successful read of this exact session; null when no matching readable session exists. */
  updatedAt: number | null;
  /** Earlier events or long excerpts were omitted by the read/response bounds. */
  truncated: boolean;
  events: LocalAgentActivityEvent[];
}

export type LocalAgentConfigurationDocumentStatus = "ready" | "missing" | "error" | "unverified" | "unavailable";

/** Content comes only from a server-verified Herdr member or team association. */
export interface LocalAgentConfigurationDocument {
  status: LocalAgentConfigurationDocumentStatus;
  markdown: string | null;
}

export interface LocalAgentConfigurationSkill {
  id: string;
  name: string;
  association: "agent" | "team";
  loadedState: "unknown";
}

export interface LocalAgentConfigurationResponse {
  agentId: string;
  teamId: string;
  occupantId: string | null;
  agent: LocalAgentConfigurationDocument;
  skillReferences: "verified" | "unverified";
  skills: LocalAgentConfigurationSkill[];
}

export interface LocalAgentSkillDocumentResponse extends LocalAgentConfigurationDocument {
  agentId: string;
  teamId: string;
  occupantId: string | null;
  skillId: string;
}

export interface LocalAgentTeamRulesResponse extends LocalAgentConfigurationDocument {
  teamId: string;
}

export type LocalUsageStatus = "ready" | "partial" | "stale" | "unavailable";
export type LocalUsageCoverage = "ready" | "partial" | "unavailable";
export type LocalUsageTokenStatus = "ready" | "partial" | "unavailable";
export type LocalUsageCategory = "work" | "personal" | "unclassified";

export interface LocalUsageCounts {
  prs: number | null;
  knownPrs: number | null;
  commits: number | null;
}

/** Null means either date is incomplete; "new" means a positive value after a verified zero. */
export type LocalUsageWeekChange = number | "new" | null;
export type LocalUsagePeriodChange = LocalUsageWeekChange;
export type LocalUsageCountComparison = Record<"prs" | "commits", LocalUsagePeriodChange>;

/** Local-only repository identity, without checkout paths, credentials or event IDs. */
export interface LocalUsageRepository extends LocalUsageCounts {
  id: string;
  name: string;
  category: LocalUsageCategory;
  /** Previous equal-length period; its dates are on the enclosing window. */
  comparison: LocalUsageCountComparison;
}

export interface LocalUsageRepositories {
  coverage: LocalUsageCoverage;
  rows: LocalUsageRepository[];
  unattributedPrs: number | null;
  unattributedCommits: number | null;
  /** Extra per-repository appearances of commits already counted once in the global total. */
  sharedCommits: number;
}

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

/** Percent changes against the immediately preceding, non-overlapping China-calendar period. */
export interface LocalUsageComparison {
  startDay: string;
  endDay: string;
  missingDays: string[];
  unavailableTokenDays: string[];
  prs: LocalUsagePeriodChange;
  commits: LocalUsagePeriodChange;
  totalTokens: LocalUsagePeriodChange;
  categories: Record<LocalUsageCategory, LocalUsageCountComparison>;
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
  totalTokens: number | null;
  categories: Record<LocalUsageCategory, LocalUsageCounts>;
  repositories: LocalUsageRepositories;
  comparison: LocalUsageComparison;
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
  totalTokens: number | null;
  categories: Record<LocalUsageCategory, LocalUsageCounts>;
  wow: Record<"prs" | "commits" | "newTokens" | "totalTokens", LocalUsageWeekChange>;
}

/** Exact counts and visible references; Profile commit references retain source days, not exact China-day counts. */
export interface LocalUsageMergedCounts {
  prs: number | null;
  knownPrs: number;
  commits: number | null;
  knownCommits: number | null;
}

export interface LocalUsageMergedRepository extends LocalUsageMergedCounts {
  id: string;
  name: string;
  category: LocalUsageCategory;
  comparison: LocalUsageCountComparison;
}

export interface LocalUsageMergedWindow extends LocalUsageMergedCounts {
  days: 1 | 7 | 30;
  startDay: string;
  endDay: string;
  asOf: number;
  coverage: LocalUsageCoverage;
  missingDays: string[];
  categories: Record<LocalUsageCategory, LocalUsageMergedCounts>;
  repositories: {
    coverage: LocalUsageCoverage;
    rows: LocalUsageMergedRepository[];
    unattributedPrs: number | null;
    unattributedCommits: number | null;
    sharedCommits: number;
  };
  comparison: {
    startDay: string;
    endDay: string;
    missingDays: string[];
    prs: LocalUsagePeriodChange;
    commits: LocalUsagePeriodChange;
    categories: Record<LocalUsageCategory, LocalUsageCountComparison>;
  };
}

export interface LocalUsageMergedTrendDay extends LocalUsageMergedCounts {
  day: string;
  coverage: LocalUsageCoverage;
  categories: Record<LocalUsageCategory, LocalUsageMergedCounts>;
  wow: Record<"prs" | "commits", LocalUsageWeekChange>;
}

export interface LocalUsageMergedResponse {
  status: LocalUsageStatus;
  asOf: number | null;
  timeZone: "Asia/Shanghai";
  sourceCoverage: { total: number; ready: number; partial: number; stale: number; unavailable: number } | null;
  overlaps: { repeatedShas: number; categoryConflicts: number; dayConflicts: number } | null;
  windows: Record<"1" | "7" | "30", LocalUsageMergedWindow> | null;
  trend: LocalUsageMergedTrendDay[];
  /** At most 191 actual China-calendar dates, including seven prior dates for daily comparisons. */
  history?: LocalUsageMergedTrendDay[];
}

/** GitHub's typed contributions; knownCommits refers to Profile buckets, not an exact China-day count.
 * Retained history uses the same split date bases; absent days remain unknown. */
export interface LocalUsageGithubResponse extends Omit<LocalUsageMergedResponse, "overlaps"> {
  metricDefinition: "github-profile-v1";
  dateBasis: { prs: "created-at/Asia-Shanghai"; commits: "github-profile-day" };
  chinaCommitAlignment: "unknown";
  qualification: "nonfork-at-capture";
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
  /** Optional extended token observations; absent dates are unknown, including on legacy snapshots. */
  history?: LocalUsageTrendDay[];
  merged?: LocalUsageMergedResponse;
  github?: LocalUsageGithubResponse;
}
