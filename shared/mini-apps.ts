import type { MiniAppDataBinding, MiniAppNamedPage, MiniAppSourceTable } from "./mini-app-data.ts";
export type { MiniAppSourceTable } from "./mini-app-data.ts";

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
