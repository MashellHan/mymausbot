/** Read-only host observations for the local owner's Computer panel. */
export type LocalDashboardStatus = "ready" | "stale" | "unavailable";

export type LocalAgentState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface LocalAgentMember {
  id: string;
  name: string;
  /** Opaque current Herdr occupant; absent when its session identity cannot be verified. */
  occupantId?: string;
  kind: string;
  role: string | null;
  model: string | null;
  reasoningEffort: string | null;
  contextUsed: number | null;
  contextWindow: number | null;
  state: LocalAgentState;
  /** Latest user instruction, redacted and bounded; never the full transcript. */
  taskHint: string | null;
  /** Latest visible assistant commentary or final response for the verified occupant, redacted and bounded. */
  messagePreview?: string | null;
  /** Rolling 24-hour verified member usage and estimated USD cost; absent on legacy hosts. */
  tokenUsage24h?: LocalAgentMemberTokenUsageWindow;
  /** Rolling 7-day verified member usage and estimated USD cost; absent on legacy hosts. */
  tokenUsage7d?: LocalAgentMemberTokenUsageWindow;
}

/** A partial count is a lower bound from verified current-team sessions; null never means zero. */
export interface LocalAgentTokenUsageWindow {
  coverage: "ready" | "partial" | "unavailable";
  knownTokens: number | null;
}

/** Member usage over the rolling window; cost coverage is tracked independently from token coverage. */
export interface LocalAgentMemberTokenUsageWindow extends LocalAgentTokenUsageWindow {
  estimatedCost: LocalUsageEstimatedCost;
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
export type LocalAgentToolDetailStatus = "available" | "absent" | "withheld";

/** Redacted, bounded visible local-agent events; IDs are local event positions, never session or tool credentials. */
export interface LocalAgentActivityEvent {
  id: string;
  at: number | null;
  kind: LocalAgentActivityKind;
  tool: string | null;
  text: string | null;
  detailStatus?: LocalAgentToolDetailStatus;
}

export interface LocalAgentActivityHistoryRequest {
  occupantId: string;
  before?: string;
}

export const LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR = /^([a-f0-9]{32})\.(e[a-z0-9]{1,14}(?:-[0-9]{1,7})?)$/;

/** Details are fetched separately from the team metadata only while a member's disclosure is open. */
export interface LocalAgentActivityResponse {
  agentId: string;
  status: LocalAgentActivityStatus;
  /** Last successful read of this exact session; null when no matching readable session exists. */
  updatedAt: number | null;
  /** Earlier events or long excerpts were omitted by the read/response bounds. */
  truncated: boolean;
  events: LocalAgentActivityEvent[];
  /** Present on history v1 requests. Do not mix pages from different streams. */
  history?: { version: 1; streamId: string | null; nextBefore: string | null };
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
  association: "agent" | "team" | "codex";
  codexAvailable?: boolean;
  loadedState: "unknown";
}

export interface LocalAgentConfigurationResponse {
  agentId: string;
  teamId: string;
  occupantId: string | null;
  agent: LocalAgentConfigurationDocument;
  skillReferences: "verified" | "unverified";
  /** Codex skills/list is scoped to the verified occupant's cwd; it does not report session loading. */
  skillDiscovery: "ready" | "partial" | "unavailable" | "timeout" | "error";
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
  knownCommits?: number | null;
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
  /** Previous equal-length period using qualified known subtotals when exact coverage is unavailable. */
  knownComparison?: LocalUsageCountComparison;
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
  /** Qualified local-ref commit comparisons when fetch-disabled scope matches across both periods. */
  known?: { prs: LocalUsagePeriodChange; commits: LocalUsagePeriodChange };
  totalTokens: LocalUsagePeriodChange;
  categories: Record<LocalUsageCategory, LocalUsageCountComparison>;
}

/** Partial coverage qualifies the USD value as a priced subtotal. */
export interface LocalUsageEstimatedCost {
  coverage: LocalUsageCoverage;
  usd: number | null;
}

export interface LocalUsageModelRow {
  model: string;
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  estimatedCost: LocalUsageEstimatedCost;
}

export interface LocalUsageTokenDetails {
  /** Fresh input includes cache writes. Output includes reasoning. */
  input: number | null;
  output: number | null;
  estimatedCost: LocalUsageEstimatedCost;
  models: { coverage: LocalUsageCoverage; rows: LocalUsageModelRow[] };
}

/** Numeric exact counts are complete; known counts qualify lower bounds when the exact count is null. */
export interface LocalUsageWindow<Days extends 1 | 7 | 30 | 60 = 1 | 7 | 30> {
  days: Days;
  startDay: string;
  endDay: string;
  asOf: number;
  coverage: LocalUsageCoverage;
  tokenCoverage: LocalUsageTokenStatus;
  tokenDetails?: LocalUsageTokenDetails;
  missingDays: string[];
  unavailableTokenDays: string[];
  prs: number | null;
  knownPrs: number | null;
  commits: number | null;
  knownCommits?: number | null;
  newTokens: number | null;
  cacheRead: number | null;
  totalTokens: number | null;
  categories: Record<LocalUsageCategory, LocalUsageCounts>;
  repositories: LocalUsageRepositories;
  comparison: LocalUsageComparison;
}

/** Per-day verified member usage reconciled to the day's collected totalTokens; native session IDs stay server-local. */
export interface LocalUsageAgentTokenRow {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
  totalTokens: number;
}

/** Missing dates have null metrics. Token-unavailable dates have null token metrics. */
export interface LocalUsageTrendDay {
  day: string;
  /** Per-day repository observations; absent on older readers, never inferred from window totals. */
  repositories?: LocalUsageRepositories;
  coverage: LocalUsageCoverage;
  tokenStatus: LocalUsageTokenStatus;
  /** Absent when the daily token total lacks a qualified fresh-input/output split. */
  tokenDetails?: LocalUsageTokenDetails & { cacheRead: number | null };
  /** Verified member token buckets reconciled to totalTokens; absent or empty means unattributed. */
  agentTokens?: LocalUsageAgentTokenRow[];
  prs: number | null;
  knownPrs: number | null;
  commits: number | null;
  knownCommits?: number | null;
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

export interface LocalUsageMergedWindow<Days extends 1 | 7 | 30 | 60 = 1 | 7 | 30> extends LocalUsageMergedCounts {
  days: Days;
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
  /** Per-day source-qualified repository observations, with the same coverage and metric definition. */
  repositories?: LocalUsageMergedWindow["repositories"];
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
  /** Source-window deduplication is independent of the longer daily-history horizon. */
  sixtyDayRepositories?: Pick<LocalUsageMergedWindow<60>, "startDay" | "endDay" | "repositories">;
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
  /** API query-span observations include the UTC guard date and may include later bucket activity; private/email coverage is unknown. */
  accounts?: {
    id: string; host: string; apiStatus: LocalUsageStatus;
    startAt: number | null; endAt: number | null;
    contributions: number | null; commits: number | null; rawPrs: number | null;
    restricted: number | null; outsideWindowPrs: number | null;
  }[];
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
  /** Source-aggregated 60-day detail; never a sum of overlapping per-repository totals. */
  sixtyDayRepositories?: Pick<LocalUsageWindow<60>, "startDay" | "endDay" | "repositories">;
  trend: LocalUsageTrendDay[];
  /** Optional extended token observations; absent dates are unknown, including on legacy snapshots. */
  history?: LocalUsageTrendDay[];
  merged?: LocalUsageMergedResponse;
  github?: LocalUsageGithubResponse;
  /** Primary source-qualified contribution contract; legacy views remain explicit diagnostics. */
  contributions?: import("./local-contributions.ts").LocalContributionsResponse;
}
