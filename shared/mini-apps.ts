import type { MiniAppDataBinding, MiniAppNamedPage, MiniAppSourceTable } from "./mini-app-data.ts";
import type { LocalAgentActivityResponse, LocalAgentTeamsResponse, LocalUsageResponse } from "./local-dashboard.ts";
export type { MiniAppSourceTable } from "./mini-app-data.ts";

export const MINI_APP_DASHBOARD_RESOURCES = {
  "agent-team": ["teams", "activity"],
  usage: ["usage"],
} as const;
export type MiniAppDashboardKind = keyof typeof MINI_APP_DASHBOARD_RESOURCES;
export type MiniAppDashboardResource = "teams" | "activity" | "usage";
export type MiniAppShippedTemplateKind = "bookkeeping" | "x_ai_digest" | "github_activity";
export const DEFAULT_MINI_APP_KINDS = ["bookkeeping", "x_ai_digest", "github_activity", "agent-team", "usage"] as const;
export type DefaultMiniAppKind = typeof DEFAULT_MINI_APP_KINDS[number];

/** The local owner adds bundled apps once; only an explicit restore re-adds a removed app. */
export interface MiniAppDefaultsInput {
  bookkeepingHtml: string;
  restore?: DefaultMiniAppKind;
}

export interface MiniAppDefaultsResult {
  apps: MiniAppSummary[];
  issues: Array<{ kind: DefaultMiniAppKind; error: string }>;
}
/** A native dashboard grant belongs to the installed app, independent of its HTML template. */
export type MiniAppDashboardDeclaration = {
  [K in MiniAppDashboardKind]: { kind: K; renderer: "native"; htmlRole: "fallback-only";
    editableFields: readonly ["title", "description"]; resources: typeof MINI_APP_DASHBOARD_RESOURCES[K] }
}[MiniAppDashboardKind];
export interface MiniAppDashboardDiscovery {
  id: string;
  revision: number;
  dashboardIdentity: MiniAppDashboardKind;
  dashboard: MiniAppDashboardDeclaration | null;
}

export type MiniAppDashboardRead =
  | { resource: "teams"; expectedRevision: number }
  | { resource: "activity"; expectedRevision: number; agentId: string }
  | { resource: "usage"; expectedRevision: number };
export type MiniAppDashboardReadResult =
  | { appId: string; revision: number; resource: "teams"; snapshot: LocalAgentTeamsResponse }
  | { appId: string; revision: number; resource: "activity"; snapshot: LocalAgentActivityResponse }
  | { appId: string; revision: number; resource: "usage"; snapshot: LocalUsageResponse };

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
  /** Present on current host replies; old saved receipts may omit it. */
  dashboard?: MiniAppDashboardDeclaration | null;
  /** Installed built-in identity survives grant revocation; it grants no dashboard reads. */
  dashboardIdentity?: MiniAppDashboardKind | null;
  /** Owner-assigned display provenance; it grants no publisher, Data or dashboard access. */
  shippedTemplateKind?: MiniAppShippedTemplateKind | null;
  createdAt: number;
  updatedAt: number;
}

export interface MiniAppVersion {
  version: number;
  createdAt: number;
  title: string;
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
  /** Only the workspace owner may set or revoke a native dashboard grant. */
  dashboardKind?: MiniAppDashboardKind | null;
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
  onDataChanged(listener: () => void): () => void;
}
