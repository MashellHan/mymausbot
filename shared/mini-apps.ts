import type { MiniAppDataBinding, MiniAppField, MiniAppNamedPage, MiniAppNamedQuery, MiniAppSourceTable } from "./mini-app-data.ts";
import type { LocalAgentActivityResponse, LocalAgentConfigurationResponse, LocalAgentSkillDocumentResponse,
  LocalAgentTeamRulesResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "./local-dashboard.ts";
export type { MiniAppSourceTable } from "./mini-app-data.ts";

export const MINI_APP_DASHBOARD_RESOURCES = {
  "agent-team": ["teams", "activity", "configuration", "team-rules", "skill"],
  usage: ["usage"],
} as const;
export type MiniAppDashboardKind = keyof typeof MINI_APP_DASHBOARD_RESOURCES;
export type MiniAppDashboardResource = "teams" | "activity" | "configuration" | "team-rules" | "skill" | "usage";
export const MINI_APP_SHIPPED_TEMPLATE_KINDS = ["bookkeeping", "x_ai_digest", "github_activity", "mojo"] as const;
export type MiniAppShippedTemplateKind = typeof MINI_APP_SHIPPED_TEMPLATE_KINDS[number];
export const DEFAULT_MINI_APP_KINDS = ["bookkeeping", "x_ai_digest", "github_activity", "agent-team", "usage", "hongguo", "mojo"] as const;
export type DefaultMiniAppKind = typeof DEFAULT_MINI_APP_KINDS[number];
export type MiniAppNativeKind = "hongguo";

/** The local owner adds bundled apps once; only an explicit restore re-adds a removed app. */
export interface MiniAppDefaultsInput {
  bookkeepingHtml: string;
  agentTeamHtml?: string;
  restore?: DefaultMiniAppKind;
}

export interface MiniAppDefaultsResult {
  apps: MiniAppSummary[];
  issues: Array<{ kind: DefaultMiniAppKind; error: string }>;
}
/** A native dashboard grant belongs to the installed app, independent of its HTML template. */
export type MiniAppDashboardDeclaration =
  | { kind: "agent-team"; renderer: "native"; htmlRole: "fallback-only";
    editableFields: readonly ["title", "description"]; resources: readonly ["teams", "activity"] }
  | { kind: "agent-team"; renderer: "html"; htmlRole: "primary";
    editableFields: readonly ["title", "description"]; resources: typeof MINI_APP_DASHBOARD_RESOURCES["agent-team"] }
  | { kind: "usage"; renderer: "html"; htmlRole: "primary";
    editableFields: readonly ["title", "description"]; resources: typeof MINI_APP_DASHBOARD_RESOURCES["usage"] }
  | { kind: "usage"; renderer: "native"; htmlRole: "fallback-only";
    editableFields: readonly ["title", "description"]; resources: typeof MINI_APP_DASHBOARD_RESOURCES["usage"] };
export interface MiniAppDashboardDiscovery {
  id: string;
  revision: number;
  dashboardIdentity: MiniAppDashboardKind;
  dashboard: MiniAppDashboardDeclaration | null;
}

export type MiniAppDashboardRead =
  | { resource: "teams"; expectedRevision: number }
  | { resource: "activity"; expectedRevision: number; agentId: string; occupantId: string; history?: never; before?: never }
  | { resource: "activity"; expectedRevision: number; agentId: string; occupantId: string; history: 1; before?: string }
  | { resource: "configuration"; expectedRevision: number; agentId: string; occupantId: string }
  | { resource: "team-rules"; expectedRevision: number; teamId: string }
  | { resource: "skill"; expectedRevision: number; agentId: string; occupantId: string; skillId: string }
  | { resource: "usage"; expectedRevision: number };
export type MiniAppDashboardRequest = MiniAppDashboardRead extends infer R
  ? R extends MiniAppDashboardRead ? Omit<R, "expectedRevision"> : never : never;
export type MiniAppDashboardReadResult =
  | { appId: string; revision: number; resource: "teams"; snapshot: LocalAgentTeamsResponse }
  | { appId: string; revision: number; resource: "activity"; snapshot: LocalAgentActivityResponse }
  | { appId: string; revision: number; resource: "configuration"; snapshot: LocalAgentConfigurationResponse }
  | { appId: string; revision: number; resource: "team-rules"; snapshot: LocalAgentTeamRulesResponse }
  | { appId: string; revision: number; resource: "skill"; snapshot: LocalAgentSkillDocumentResponse }
  | { appId: string; revision: number; resource: "usage"; snapshot: LocalUsageResponse };

export const MINI_APP_RELEASE_REPO = "MashellHan/mymausbotminiapps";
export const MINI_APP_RELEASE_BOUNDS = {
  manifestBytes: 16 * 1024,
  htmlBytes: 512 * 1024,
  queriesBytes: 64 * 1024,
} as const;
export const MINI_APP_RELEASE_ASSETS = ["manifest.json", "index.html", "queries.json"] as const;

export interface MiniAppReleaseManifestArtifact {
  bytes: number;
  sha256: string;
}

/** Manifest v1 published as `manifest.json` on per-app GitHub Releases (`mini-app/<slug>/v<appVersion>`). */
export interface MiniAppReleaseManifestV1 {
  formatVersion: 1;
  packageId: string;
  appVersion: string;
  sourceCommit: string;
  requires: string[];
  artifacts: {
    "index.html": MiniAppReleaseManifestArtifact;
    "queries.json": MiniAppReleaseManifestArtifact;
  };
}

/** Provenance bound to an installed template version from a verified independent release. */
export interface MiniAppReleaseProvenance {
  packageId: string;
  appVersion: string;
  sourceCommit: string;
  tag: string;
  requires: string[];
  htmlSha256: string;
  htmlBytes: number;
  queriesSha256: string;
  queriesBytes: number;
}

export type MiniAppUpdateStatus = "available" | "current" | "unavailable" | "incompatible" | "custom";

export interface MiniAppUpdateCandidate {
  appVersion: string;
  sourceCommit: string;
}

export interface MiniAppUpdateCheckResult {
  installedVersion: string | null;
  status: MiniAppUpdateStatus;
  available: MiniAppUpdateCandidate | null;
}

/** Portable query slot declaration published in `queries.json` without local datasetIds. */
export interface MiniAppReleaseQuerySlot {
  id: string;
  source: { schema: string | null; table: string | null };
  fields: Record<string, MiniAppField>;
  queries: Record<string, MiniAppNamedQuery>;
}

/** Portable `queries.json` artifact published alongside `manifest.json` and `index.html`. */
export interface MiniAppReleaseQueriesFile {
  notice?: string;
  contractVersion: string;
  dataSlots: MiniAppReleaseQuerySlot[];
}

export interface MiniAppUpdateApply {
  appVersion: string;
  sourceCommit: string;
  expectedRevision: number;
  requestKey: string;
}

/** Local apps belong to the workspace owner; publisher grants do not transfer ownership. */
export interface MiniAppSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  status: "active" | "archived";
  revision: number;
  templateVersion: number;
  publisherBotIds: string[];
  /** Current host replies use null for old apps. This does not grant access. */
  responsibleBotId?: string | null;
  /** Current host replies use [] for old apps; these are descriptions, not permissions. */
  capabilities?: string[];
  /** Present on current host replies; old saved receipts may omit it. */
  dashboard?: MiniAppDashboardDeclaration | null;
  /** Installed built-in identity survives grant revocation; it grants no dashboard reads. */
  dashboardIdentity?: MiniAppDashboardKind | null;
  /** Current owner grant for the bundled native Hongguo experience. */
  nativeKind?: MiniAppNativeKind | null;
  /** Installed native identity survives archive and grant revocation. */
  nativeIdentity?: MiniAppNativeKind | null;
  /** Owner-assigned display provenance; it grants no publisher, Data or dashboard access. */
  shippedTemplateKind?: MiniAppShippedTemplateKind | null;
  /** Independent release provenance bound to the current template version, or null for bundled/custom templates. */
  release?: MiniAppReleaseProvenance | null;
  createdAt: number;
  updatedAt: number;
}

export interface MiniAppVersion {
  version: number;
  createdAt: number;
  title: string;
  /** Independent release provenance for this template version, when installed from a verified release. */
  release?: MiniAppReleaseProvenance | null;
}

export interface MiniAppDocument {
  app: MiniAppSummary;
  html: string;
  bindings: MiniAppDataBinding[];
  versions: MiniAppVersion[];
}

export interface MiniAppState {
  appId: string;
  revision: number;
  templateVersion: number;
  status: "active" | "archived";
  data: Array<{ datasetId: string; revision: number }>;
}

/** A new app expects revision zero. Every publication is immutable and idempotent by requestKey and content. */
export interface MiniAppPublish {
  requestKey: string;
  expectedRevision: number;
  slug: string;
  title: string;
  description: string;
  html: string;
  bindings: MiniAppDataBinding[];
  publisherBotIds?: string[];
  /** Only the workspace owner may assign or clear responsibility. */
  responsibleBotId?: string | null;
  capabilities?: string[];
  /** Only the workspace owner may set or revoke a native dashboard grant. */
  dashboardKind?: MiniAppDashboardKind | null;
  /** Only the workspace owner may set or revoke a native app grant. */
  nativeKind?: MiniAppNativeKind | null;
  /** Only the workspace owner may label an installed shipped template. */
  shippedTemplateKind?: MiniAppShippedTemplateKind;
}

export interface MiniAppRollback {
  requestKey: string;
  expectedRevision: number;
  templateVersion: number;
}

export interface MiniAppArchive {
  requestKey: string;
  expectedRevision: number;
}

export interface MiniAppMutationResult {
  app: MiniAppSummary;
  replayed: boolean;
}

/** Local owner request for the selected Bot's current task. */
export interface MiniAppSuggestionsRequest { botId: string; threadId: string }
export type MiniAppSuggestionReason =
  | { kind: "responsible" }
  | { kind: "developed" }
  /** Current publisher permission for this Bot; no publication or development is implied. */
  | { kind: "publisher-grant" }
  | { kind: "activities-task" }
  | { kind: "task"; capability: string; taskPhrase: string };
export interface MiniAppSuggestion { app: MiniAppSummary; reason: MiniAppSuggestionReason }
export interface MiniAppSuggestionsResult {
  botId: string;
  threadId: string;
  suggestions: MiniAppSuggestion[];
  refreshPending: boolean;
  status?: "ready" | "pending" | "unavailable";
  retryAfterMs?: number;
}

/** The host supplies the installed revision; an iframe can select only a declared query and parameters. */
export interface MiniAppQuery {
  queryId: string;
  parameters: Record<string, string | string[]>;
  expectedRevision: number;
  expectedDataRevision?: number;
  cursor?: string;
}

export type MiniAppQueryResult = MiniAppNamedPage;

export interface MiniAppDataset {
  datasetId: string;
  revision: number;
  tables: MiniAppSourceTable[];
}

/** Connecting a bot promotes its Data store to owner storage before an app can bind it. */
export interface MiniAppSources {
  bots: Array<{ id: string; name: string }>;
  datasets: MiniAppDataset[];
}

export interface MiniAppQueryOptions {
  cursor?: string;
  expectedDataRevision?: number;
}

/** Available in an opaque app frame. It has no chat, model, filesystem, write or generic tool capability. */
export interface MausApp {
  query(queryId: string, parameters: Record<string, string | string[]>, options?: MiniAppQueryOptions): Promise<MiniAppNamedPage>;
  dashboard: { read(request: MiniAppDashboardRequest): Promise<MiniAppDashboardReadResult> };
  onDataChanged(listener: () => void): () => void;
}
