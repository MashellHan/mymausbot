import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import { LEGACY_MINI_APP_IDS, matchesMiniAppReleasePackage } from "../../shared/mini-app-release-packages.ts";
import type { HongguoHistoryEntry, HongguoHistoryRequest, HongguoHistoryResponse, HongguoPreferencesRequest,
  HongguoPreferencesResponse } from "../../shared/hongguo-mini-app.ts";
import { MINI_APP_AGENT_TEAM_BASE_RESOURCES, MINI_APP_DASHBOARD_RESOURCES, MINI_APP_SHIPPED_TEMPLATE_KINDS, type MiniAppArchive, type MiniAppCustomIcon, type MiniAppDashboardDeclaration, type MiniAppDashboardDiscovery,
  type MiniAppDashboardKind, type MiniAppDashboardReadResult, type MiniAppDocument, type MiniAppMutationResult,
  type MiniAppDashboardResource, type MiniAppQuery, type MiniAppQueryResult, type MiniAppReleaseProvenance,
  type MiniAppRollback, type MiniAppState, type MiniAppShippedTemplateKind, type MiniAppNativeKind,
  type MiniAppSummary, type MiniAppUpdateCheckResult } from "../../shared/mini-apps.ts";
import { AppDocs } from "../app-docs.ts";
import { rowRate } from "../chat-apps.ts";
import type { DataEngine } from "../data/types.ts";
import { applicationDatabase, withApplicationWrite } from "../message-db.ts";
import type { LocalDashboardProviders } from "../routes/local-dashboard.ts";
import { appFailure, archiveSchema, miniAppIconSchema, parseDashboardRead, parsePublish, parseQuery, parseReleaseUpdateApply, rollbackSchema } from "./validation.ts";
import { developedMiniApps, ensureMiniAppDevelopment, recordMiniAppDevelopment } from "./development.ts";
import { AGENT_TEAM_NATIVE_PLACEHOLDER_SHA256, REVIEWED_AGENT_TEAM_HTML_SHA256 } from "./default-template-history.ts";
import { parseHongguoHistory, parseHongguoPreferences } from "./hongguo-validation.ts";
import { hasRevokedBuiltInGrant, isCustomAppTemplate, isReleaseCompatible, miniAppReleaseMapping, MiniAppReleaseSource } from "./release-source.ts";

export const MINI_APPS_OWNER = "workspace-owner";

export interface MiniAppActor {
  botId?: string;
  writeAllowed: boolean;
  assertActive(): void;
  canBind(datasetId: string): boolean;
}

export interface MiniAppDatabaseAccess {
  database(): DatabaseSync;
  write<T>(work: (db: DatabaseSync) => T): T;
}

const initialized = new WeakSet<DatabaseSync>();
const shippedKindColumn = `shipped_template_kind TEXT CHECK(shipped_template_kind IN (${MINI_APP_SHIPPED_TEMPLATE_KINDS.map((kind) => `'${kind}'`).join(", ")}) OR shipped_template_kind IS NULL)`;
export function ensureMiniApps(db: DatabaseSync): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mini_apps (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
      revision INTEGER NOT NULL, template_version INTEGER NOT NULL, publishers TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      dashboard_kind TEXT CHECK(dashboard_kind IN ('agent-team', 'usage') OR dashboard_kind IS NULL),
      dashboard_identity TEXT CHECK(dashboard_identity IN ('agent-team', 'usage') OR dashboard_identity IS NULL),
      dashboard_html INTEGER NOT NULL DEFAULT 0 CHECK(dashboard_html IN (0, 1)),
      agent_team_detail_grant INTEGER NOT NULL DEFAULT 0 CHECK(agent_team_detail_grant IN (0, 1)),
      native_kind TEXT CHECK(native_kind = 'hongguo' OR native_kind IS NULL),
      native_identity TEXT CHECK(native_identity = 'hongguo' OR native_identity IS NULL),
      ${shippedKindColumn},
      responsible_bot_id TEXT, capabilities TEXT NOT NULL DEFAULT '[]',
      release_provenance TEXT,
      icon TEXT,
      sort_order INTEGER,
      UNIQUE(owner_id, slug)
    );
    CREATE TABLE IF NOT EXISTS mini_app_versions (
      app_id TEXT NOT NULL, version INTEGER NOT NULL, doc TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL, bindings TEXT NOT NULL, created_at INTEGER NOT NULL,
      dashboard_html INTEGER NOT NULL DEFAULT 0 CHECK(dashboard_html IN (0, 1)),
      release_provenance TEXT,
      icon TEXT,
      PRIMARY KEY(app_id, version), FOREIGN KEY(app_id) REFERENCES mini_apps(id)
    );
    CREATE TABLE IF NOT EXISTS mini_app_receipts (
      actor TEXT NOT NULL, target TEXT NOT NULL, operation TEXT NOT NULL, request_key TEXT NOT NULL,
      content_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(actor, target, operation, request_key)
    );
    CREATE TABLE IF NOT EXISTS mini_app_hongguo_history (
      app_id TEXT NOT NULL, series_id TEXT NOT NULL, series_title TEXT NOT NULL, cover_url TEXT,
      episode_id TEXT NOT NULL, episode_number INTEGER, episode_title TEXT NOT NULL,
      position_seconds REAL NOT NULL, duration_seconds REAL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(app_id, series_id), FOREIGN KEY(app_id) REFERENCES mini_apps(id)
    );
    CREATE TABLE IF NOT EXISTS mini_app_hongguo_preferences (
      app_id TEXT PRIMARY KEY, autoplay_next INTEGER NOT NULL CHECK(autoplay_next IN (0, 1)),
      FOREIGN KEY(app_id) REFERENCES mini_apps(id)
    );
  `);
  const columns = db.prepare("PRAGMA table_info(mini_apps)").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "dashboard_kind")) {
    db.exec("ALTER TABLE mini_apps ADD COLUMN dashboard_kind TEXT CHECK(dashboard_kind IN ('agent-team', 'usage') OR dashboard_kind IS NULL)");
  }
  if (!columns.some(({ name }) => name === "dashboard_identity")) {
    db.exec("ALTER TABLE mini_apps ADD COLUMN dashboard_identity TEXT CHECK(dashboard_identity IN ('agent-team', 'usage') OR dashboard_identity IS NULL)");
    db.exec("UPDATE mini_apps SET dashboard_identity = dashboard_kind WHERE dashboard_kind IS NOT NULL");
  }
  if (!columns.some(({ name }) => name === "dashboard_html")) {
    db.exec("ALTER TABLE mini_apps ADD COLUMN dashboard_html INTEGER NOT NULL DEFAULT 0 CHECK(dashboard_html IN (0, 1))");
  }
  if (!columns.some(({ name }) => name === "agent_team_detail_grant")) {
    db.exec("SAVEPOINT mini_app_agent_team_grant");
    try {
      db.exec(`ALTER TABLE mini_apps ADD COLUMN agent_team_detail_grant INTEGER NOT NULL DEFAULT 0 CHECK(agent_team_detail_grant IN (0, 1));
        UPDATE mini_apps SET agent_team_detail_grant = 1 WHERE status = 'active' AND dashboard_kind = 'agent-team' AND dashboard_html = 1;
        RELEASE mini_app_agent_team_grant;`);
    } catch (error) {
      db.exec("ROLLBACK TO mini_app_agent_team_grant; RELEASE mini_app_agent_team_grant;");
      throw error;
    }
  }
  const versionColumns = db.prepare("PRAGMA table_info(mini_app_versions)").all() as Array<{ name: string }>;
  if (!versionColumns.some(({ name }) => name === "dashboard_html")) {
    db.exec("ALTER TABLE mini_app_versions ADD COLUMN dashboard_html INTEGER NOT NULL DEFAULT 0 CHECK(dashboard_html IN (0, 1))");
  }
  if (!columns.some(({ name }) => name === "native_kind")) {
    db.exec("ALTER TABLE mini_apps ADD COLUMN native_kind TEXT CHECK(native_kind = 'hongguo' OR native_kind IS NULL)");
  }
  if (!columns.some(({ name }) => name === "native_identity")) {
    db.exec("ALTER TABLE mini_apps ADD COLUMN native_identity TEXT CHECK(native_identity = 'hongguo' OR native_identity IS NULL)");
  }
  if (!columns.some(({ name }) => name === "shipped_template_kind")) {
    db.exec(`ALTER TABLE mini_apps ADD COLUMN ${shippedKindColumn}`);
  } else {
    const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'mini_apps' AND type = 'table'").get()?.sql;
    if (typeof schema === "string" && schema.includes("CHECK(shipped_template_kind IN ('bookkeeping', 'x_ai_digest', 'github_activity') OR shipped_template_kind IS NULL)")) {
      db.exec("SAVEPOINT mini_app_shipped_kind");
      try {
        db.exec(`ALTER TABLE mini_apps RENAME COLUMN shipped_template_kind TO previous_shipped_template_kind;
          ALTER TABLE mini_apps ADD COLUMN ${shippedKindColumn};
          UPDATE mini_apps SET shipped_template_kind = previous_shipped_template_kind;
          ALTER TABLE mini_apps DROP COLUMN previous_shipped_template_kind;
          RELEASE mini_app_shipped_kind;`);
      } catch (error) {
        db.exec("ROLLBACK TO mini_app_shipped_kind; RELEASE mini_app_shipped_kind;");
        throw error;
      }
    }
  }
  if (!columns.some(({ name }) => name === "responsible_bot_id")) db.exec("ALTER TABLE mini_apps ADD COLUMN responsible_bot_id TEXT");
  if (!columns.some(({ name }) => name === "capabilities")) db.exec("ALTER TABLE mini_apps ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'");
  if (!columns.some(({ name }) => name === "release_provenance")) db.exec("ALTER TABLE mini_apps ADD COLUMN release_provenance TEXT");
  if (!columns.some(({ name }) => name === "icon")) db.exec("ALTER TABLE mini_apps ADD COLUMN icon TEXT");
  if (!columns.some(({ name }) => name === "sort_order")) db.exec("ALTER TABLE mini_apps ADD COLUMN sort_order INTEGER");
  if (!versionColumns.some(({ name }) => name === "release_provenance")) db.exec("ALTER TABLE mini_app_versions ADD COLUMN release_provenance TEXT");
  if (!versionColumns.some(({ name }) => name === "icon")) db.exec("ALTER TABLE mini_app_versions ADD COLUMN icon TEXT");
  ensureMiniAppDevelopment(db);
  initialized.add(db);
}

export function miniAppDocRefs(db: DatabaseSync = applicationDatabase()): string[] {
  ensureMiniApps(db);
  return db.prepare("SELECT DISTINCT doc FROM mini_app_versions").all().map((row) => String(row.doc));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

type AppRow = {
  id: string; slug: string; title: string; description: string; status: MiniAppSummary["status"];
  revision: number; template_version: number; publishers: string; created_at: number; updated_at: number;
  dashboard_kind: MiniAppDashboardKind | null; dashboard_identity: MiniAppDashboardKind | null; dashboard_html: number;
  agent_team_detail_grant: number;
  native_kind: MiniAppNativeKind | null; native_identity: MiniAppNativeKind | null;
  shipped_template_kind: MiniAppShippedTemplateKind | null;
  responsible_bot_id: string | null; capabilities: string;
  release_provenance: string | null;
  icon: string | null;
};
type VersionRow = { version: number; doc: string; title: string; description: string; bindings: string; created_at: number; dashboard_html: number; release_provenance: string | null; icon: string | null };
const parseProvenance = (raw: string | null | undefined): MiniAppReleaseProvenance | null =>
  raw ? JSON.parse(raw) as MiniAppReleaseProvenance : null;
const parseIcon = (raw: string | null | undefined): MiniAppCustomIcon | null => {
  if (!raw) return null;
  try {
    const parsed = miniAppIconSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
function declaration(kind: MiniAppDashboardKind | null, html: boolean, agentTeamDetails: boolean): MiniAppDashboardDeclaration | null {
  if (kind === null) return null;
  if (kind === "agent-team") return html
    ? { kind, renderer: "html", htmlRole: "primary", editableFields: ["title", "description"],
      resources: agentTeamDetails ? MINI_APP_DASHBOARD_RESOURCES[kind] : MINI_APP_AGENT_TEAM_BASE_RESOURCES }
    : { kind, renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: MINI_APP_AGENT_TEAM_BASE_RESOURCES };
  if (kind === "usage") return html
    ? { kind, renderer: "html", htmlRole: "primary", editableFields: ["title", "description"], resources: MINI_APP_DASHBOARD_RESOURCES[kind] }
    : { kind, renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"], resources: MINI_APP_DASHBOARD_RESOURCES[kind] };
  throw appFailure(503, "The Mini App dashboard grant is invalid.");
}
const summary = (row: AppRow): MiniAppSummary => ({
  id: row.id, slug: row.slug, title: row.title, description: row.description, status: row.status,
  revision: row.revision, templateVersion: row.template_version, publisherBotIds: JSON.parse(row.publishers) as string[],
  responsibleBotId: row.responsible_bot_id, capabilities: JSON.parse(row.capabilities) as string[],
  dashboard: declaration(row.dashboard_kind, row.dashboard_html === 1, row.agent_team_detail_grant === 1), dashboardIdentity: row.dashboard_identity,
  nativeKind: row.native_kind, nativeIdentity: row.native_identity,
  shippedTemplateKind: row.shipped_template_kind,
  icon: parseIcon(row.icon),
  release: parseProvenance(row.release_provenance),
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export class MiniApps {
  private readonly access: MiniAppDatabaseAccess;
  private readonly rate = rowRate(240, 60_000);
  private readonly running = new Map<string, number>();
  readonly docs: AppDocs;
  readonly data: Pick<DataEngine, "validateBinding" | "readNamed" | "listDatasets">;
  private readonly validPublisher: (id: string) => boolean;
  private readonly dashboardProviders?: LocalDashboardProviders;
  private readonly releaseSource: MiniAppReleaseSource;

  constructor(deps: {
    docs: AppDocs;
    data: MiniApps["data"];
    validPublisher(id: string): boolean;
    dashboardProviders?: LocalDashboardProviders;
    access?: MiniAppDatabaseAccess;
    releaseSource?: MiniAppReleaseSource;
  }) {
    this.docs = deps.docs;
    this.data = deps.data;
    this.validPublisher = deps.validPublisher;
    this.dashboardProviders = deps.dashboardProviders;
    this.access = deps.access ?? { database: applicationDatabase, write: withApplicationWrite };
    this.releaseSource = deps.releaseSource ?? new MiniAppReleaseSource();
  }

  private db(): DatabaseSync {
    const db = this.access.database();
    ensureMiniApps(db);
    return db;
  }

  initialize(): void { this.db(); }

  private row(id: string): AppRow | undefined {
    return this.db().prepare("SELECT * FROM mini_apps WHERE id = ? AND owner_id = ?").get(id, MINI_APPS_OWNER) as AppRow | undefined;
  }

  private authorize(actor: MiniAppActor, app?: MiniAppSummary, write = false): void {
    actor.assertActive();
    if (actor.botId && (!this.validPublisher(actor.botId) || (app && !app.publisherBotIds.includes(actor.botId)))) throw appFailure(403, "This bot has no current publisher grant for this Mini App.");
    if (write && !actor.writeAllowed) throw appFailure(403, "Mini App writes are disabled for this turn.");
  }

  private authorizeTemplate(actor: MiniAppActor, app?: MiniAppSummary, bindings: MiniAppDataBinding[] = []): void {
    this.authorize(actor, app, true);
    if (actor.botId && app?.status === "archived") throw appFailure(403, "Only the workspace owner can restore an archived Mini App.");
    const granted: MiniAppDataBinding[] = app ? JSON.parse(this.version(app.id, app.templateVersion).bindings) : [];
    for (const binding of bindings) {
      if (!actor.canBind(binding.datasetId) && !granted.some((candidate) => canonical(candidate) === canonical(binding))) {
        throw appFailure(403, "This turn can only reuse the target app's current binding or bind its own Data source.");
      }
    }
  }

  private require(actor: MiniAppActor, id: string, write = false): MiniAppSummary {
    this.authorize(actor, undefined, write);
    const row = this.row(id);
    if (!row) throw appFailure(404, "Mini App not found.");
    const app = summary(row);
    this.authorize(actor, app, write);
    return app;
  }

  requireHongguo(actor: MiniAppActor, id: string, revision: number): MiniAppSummary {
    if (actor.botId) throw appFailure(403, "Only the workspace owner can open Hongguo.");
    const app = this.require(actor, id);
    this.expected(app, revision);
    if (app.status !== "active") throw appFailure(409, "This Mini App is archived.");
    if (app.nativeKind !== "hongguo" || app.nativeIdentity !== "hongguo") {
      throw appFailure(403, "This Mini App has no Hongguo grant.");
    }
    return app;
  }

  requireGithubActivity(actor: MiniAppActor, id: string, revision: number): MiniAppSummary {
    if (actor.botId) throw appFailure(403, "Only the workspace owner can read GitHub Activity media.");
    const app = this.require(actor, id);
    this.expected(app, revision);
    if (app.status !== "active") throw appFailure(409, "This Mini App is archived.");
    const legacy = app.id === LEGACY_MINI_APP_IDS.github_activity && app.slug === "github-activity";
    if (app.shippedTemplateKind !== "github_activity" || app.dashboard || app.nativeKind
      || (!legacy && !matchesMiniAppReleasePackage("github_activity", app.release))) {
      throw appFailure(403, "This Mini App has no GitHub Activity media grant.");
    }
    return app;
  }

  private hongguoHistoryResult(db: DatabaseSync, app: MiniAppSummary): HongguoHistoryResponse {
    const rows = db.prepare(`SELECT series_id, series_title, cover_url, episode_id, episode_number,
      episode_title, position_seconds, duration_seconds, updated_at FROM mini_app_hongguo_history
      WHERE app_id = ? ORDER BY updated_at DESC, series_id`).all(app.id) as unknown as Array<{
      series_id: string; series_title: string; cover_url: string | null; episode_id: string; episode_number: number | null;
      episode_title: string; position_seconds: number; duration_seconds: number | null; updated_at: number;
    }>;
    const entries: HongguoHistoryEntry[] = rows.map((row) => ({ seriesId: row.series_id, seriesTitle: row.series_title,
      coverUrl: row.cover_url, episodeId: row.episode_id, episodeNumber: row.episode_number,
      episodeTitle: row.episode_title, positionSeconds: row.position_seconds,
      durationSeconds: row.duration_seconds, updatedAt: row.updated_at }));
    const preference = db.prepare("SELECT autoplay_next FROM mini_app_hongguo_preferences WHERE app_id = ?")
      .get(app.id) as { autoplay_next: number } | undefined;
    return { appId: app.id, revision: app.revision, entries, autoplayNext: preference?.autoplay_next !== 0 };
  }

  hongguoHistory(actor: MiniAppActor, id: string, raw: unknown): HongguoHistoryResponse {
    const input: HongguoHistoryRequest = parseHongguoHistory(raw);
    const app = this.requireHongguo(actor, id, input.expectedRevision);
    if (input.action === "list") return this.hongguoHistoryResult(this.db(), app);
    return this.access.write((db) => {
      const current = this.requireHongguo(actor, id, input.expectedRevision);
      if (input.action === "save") {
        const entry = input.entry;
        db.prepare(`INSERT INTO mini_app_hongguo_history (app_id, series_id, series_title, cover_url, episode_id,
          episode_number, episode_title, position_seconds, duration_seconds, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(app_id, series_id) DO UPDATE SET series_title=excluded.series_title, cover_url=excluded.cover_url,
          episode_id=excluded.episode_id, episode_number=excluded.episode_number, episode_title=excluded.episode_title,
          position_seconds=excluded.position_seconds, duration_seconds=excluded.duration_seconds, updated_at=excluded.updated_at`)
          .run(id, entry.seriesId, entry.seriesTitle, entry.coverUrl, entry.episodeId, entry.episodeNumber,
            entry.episodeTitle, entry.positionSeconds, entry.durationSeconds, Date.now());
      } else if (input.action === "delete") {
        db.prepare("DELETE FROM mini_app_hongguo_history WHERE app_id = ? AND series_id = ?").run(id, input.seriesId);
      } else {
        db.prepare("DELETE FROM mini_app_hongguo_history WHERE app_id = ?").run(id);
      }
      return this.hongguoHistoryResult(db, current);
    });
  }

  hongguoPreferences(actor: MiniAppActor, id: string, raw: unknown): HongguoPreferencesResponse {
    const input: HongguoPreferencesRequest = parseHongguoPreferences(raw);
    this.requireHongguo(actor, id, input.expectedRevision);
    return this.access.write((db) => {
      const current = this.requireHongguo(actor, id, input.expectedRevision);
      db.prepare(`INSERT INTO mini_app_hongguo_preferences (app_id, autoplay_next) VALUES (?, ?)
        ON CONFLICT(app_id) DO UPDATE SET autoplay_next=excluded.autoplay_next`).run(id, Number(input.autoplayNext));
      return { appId: id, revision: current.revision, autoplayNext: input.autoplayNext };
    });
  }

  list(actor: MiniAppActor): MiniAppSummary[] {
    this.authorize(actor);
    return (this.db().prepare("SELECT * FROM mini_apps WHERE owner_id = ? ORDER BY COALESCE(sort_order, 2147483647), created_at, id").all(MINI_APPS_OWNER) as unknown as AppRow[])
      .map(summary).filter((app) => !actor.botId || app.publisherBotIds.includes(actor.botId));
  }

  reorder(actor: MiniAppActor, rawIds: readonly string[]): MiniAppSummary[] {
    this.authorize(actor, undefined, true);
    if (actor.botId) throw appFailure(403, "Only the workspace owner can reorder Mini Apps.");
    const requested = rawIds.filter((id, index) => typeof id === "string" && id.length > 0 && rawIds.indexOf(id) === index);
    return this.access.write((db) => {
      const current = (db.prepare("SELECT id FROM mini_apps WHERE owner_id = ? ORDER BY COALESCE(sort_order, 2147483647), created_at, id").all(MINI_APPS_OWNER) as Array<{ id: string }>)
        .map((row) => row.id);
      const currentSet = new Set(current);
      const ordered = requested.filter((id) => currentSet.has(id));
      const seen = new Set(ordered);
      for (const id of current) if (!seen.has(id)) ordered.push(id);
      const update = db.prepare("UPDATE mini_apps SET sort_order = ? WHERE owner_id = ? AND id = ?");
      ordered.forEach((id, index) => { update.run(index, MINI_APPS_OWNER, id); });
      return (db.prepare("SELECT * FROM mini_apps WHERE owner_id = ? ORDER BY COALESCE(sort_order, 2147483647), created_at, id").all(MINI_APPS_OWNER) as unknown as AppRow[]).map(summary);
    });
  }

  developedBy(botId: string): Set<string> {
    return developedMiniApps(this.db(), botId);
  }

  dashboardCatalog(actor: MiniAppActor): MiniAppDashboardDiscovery[] {
    this.authorize(actor);
    return (this.db().prepare("SELECT * FROM mini_apps WHERE owner_id = ? AND status = 'active' AND dashboard_identity IS NOT NULL ORDER BY created_at, id")
      .all(MINI_APPS_OWNER) as unknown as AppRow[]).map((row) => ({ id: row.id, revision: row.revision,
      dashboardIdentity: row.dashboard_identity!, dashboard: declaration(row.dashboard_kind, row.dashboard_html === 1, row.agent_team_detail_grant === 1) }));
  }

  canAdoptAgentTeamDefault(actor: MiniAppActor, id: string): boolean {
    const app = this.require(actor, id);
    if (app.status !== "active" || app.dashboardIdentity !== "agent-team" || app.dashboard?.renderer !== "native" || app.release) return false;
    const versions = this.db().prepare("SELECT doc, bindings FROM mini_app_versions WHERE app_id = ? ORDER BY version").all(id) as
      Array<{ doc: string; bindings: string }>;
    return versions.length > 0 && versions.length <= 128 && versions.every((version) => {
      const document = this.docs.read(version.doc);
      const hash = document && createHash("sha256").update(document.html).digest("hex");
      return version.bindings === "[]" && hash && (AGENT_TEAM_NATIVE_PLACEHOLDER_SHA256 as readonly string[]).includes(hash);
    });
  }

  private versionBindings(actor: MiniAppActor, id: string): { app: MiniAppSummary; bindings: MiniAppDataBinding[] } {
    const app = this.require(actor, id);
    const version = this.version(id, app.templateVersion);
    return { app, bindings: JSON.parse(version.bindings) as MiniAppDataBinding[] };
  }

  document(actor: MiniAppActor, id: string): MiniAppDocument {
    const app = this.require(actor, id);
    const version = this.version(id, app.templateVersion);
    const doc = this.docs.read(version.doc);
    if (!doc) throw appFailure(503, "The Mini App document is unavailable. Restore its workspace backup.");
    const versionRows = this.db().prepare("SELECT version, title, created_at AS createdAt, release_provenance FROM mini_app_versions WHERE app_id = ? ORDER BY version DESC")
      .all(id) as Array<{ version: number; title: string; createdAt: number; release_provenance: string | null }>;
    return { app, html: doc.html, bindings: JSON.parse(version.bindings) as MiniAppDataBinding[],
      versions: versionRows.map((row) => ({
        version: row.version,
        title: row.title,
        createdAt: row.createdAt,
        release: parseProvenance(row.release_provenance),
      })) };
  }

  private version(id: string, version: number): VersionRow {
    const row = this.db().prepare("SELECT * FROM mini_app_versions WHERE app_id = ? AND version = ?").get(id, version) as VersionRow | undefined;
    if (!row) throw appFailure(404, "Mini App template version not found.");
    return row;
  }

  private replay(actor: MiniAppActor, target: string, operation: string, input: { requestKey: string }): MiniAppMutationResult | null {
    const row = this.db().prepare("SELECT content_hash, result FROM mini_app_receipts WHERE actor = ? AND target = ? AND operation = ? AND request_key = ?")
      .get(actor.botId ?? MINI_APPS_OWNER, target, operation, input.requestKey) as { content_hash: string; result: string } | undefined;
    if (!row) return null;
    if (row.content_hash !== this.hash(input)) throw appFailure(409, "This request key was already used with different content.");
    const app = JSON.parse(row.result) as MiniAppSummary;
    return { app: { ...app, dashboard: app.dashboard ?? null, dashboardIdentity: app.dashboardIdentity ?? app.dashboard?.kind ?? null,
      shippedTemplateKind: app.shippedTemplateKind ?? null, icon: app.icon ?? null, responsibleBotId: app.responsibleBotId ?? null,
      capabilities: app.capabilities ?? [], release: app.release ?? null }, replayed: true };
  }

  private hash(input: unknown): string { return createHash("sha256").update(canonical(input)).digest("hex"); }

  private receipt(db: DatabaseSync, actor: MiniAppActor, target: string, operation: string, input: { requestKey: string }, app: MiniAppSummary): MiniAppMutationResult {
    db.prepare("INSERT INTO mini_app_receipts VALUES (?, ?, ?, ?, ?, ?, ?)").run(actor.botId ?? MINI_APPS_OWNER, target, operation, input.requestKey, this.hash(input), JSON.stringify(app), Date.now());
    return { app, replayed: false };
  }

  private expected(app: MiniAppSummary | undefined, revision: number): void {
    if ((app?.revision ?? 0) !== revision) throw appFailure(409, "The Mini App changed. Read its current version before publishing again.");
  }

  private requireNativeBindings(native: boolean, bindings: MiniAppDataBinding[]): void {
    if (native && bindings.length) throw appFailure(400, "Native Mini Apps require empty Data bindings.");
  }

  private requireDashboardTemplateWrite(actor: MiniAppActor, app: MiniAppSummary | undefined, html: string): void {
    if (!actor.botId || app?.dashboard?.renderer !== "html") return;
    const current = this.docs.read(this.version(app.id, app.templateVersion).doc);
    if (!current || current.html !== html) throw appFailure(403, "Only the owner can change this dashboard page.");
  }

  async publish(actor: MiniAppActor, raw: unknown, id?: string, trustedAgentTeamHtml = false): Promise<MiniAppMutationResult> {
    this.authorize(actor, undefined, true);
    const input = parsePublish(raw);
    if (trustedAgentTeamHtml && (actor.botId || input.dashboardKind !== "agent-team" || input.bindings.length
      || createHash("sha256").update(input.html).digest("hex") !== REVIEWED_AGENT_TEAM_HTML_SHA256)) {
      throw appFailure(403, "Only the owner can activate a reviewed Agent Team template.");
    }
    if (actor.botId && input.dashboardKind !== undefined) throw appFailure(403, "Only the workspace owner can grant dashboard resources.");
    if (actor.botId && input.nativeKind !== undefined) throw appFailure(403, "Only the workspace owner can grant native apps.");
    if (actor.botId && input.shippedTemplateKind !== undefined) throw appFailure(403, "Only the workspace owner can identify a shipped template.");
    if (actor.botId && input.responsibleBotId !== undefined) throw appFailure(403, "Only the workspace owner can assign responsibility.");
    if (input.responsibleBotId && !this.validPublisher(input.responsibleBotId)) throw appFailure(400, "The responsible Bot does not exist.");
    const target = id ?? `slug:${input.slug}`;
    const existing = id ? this.require(actor, id, true) : (() => {
      const row = this.db().prepare("SELECT * FROM mini_apps WHERE owner_id = ? AND slug = ?").get(MINI_APPS_OWNER, input.slug) as AppRow | undefined;
      return row && summary(row);
    })();
    this.authorizeTemplate(actor, existing);
    this.requireDashboardTemplateWrite(actor, existing, input.html);
    const replay = this.replay(actor, target, "publish", input);
    if (replay) return replay;
    if (!id && existing) throw appFailure(409, "A Mini App already uses this slug. Publish a new version using its app id.");
    this.expected(existing, input.expectedRevision);
    if (existing && existing.slug !== input.slug) throw appFailure(400, "An installed Mini App keeps its slug.");
    if (existing?.dashboardIdentity && input.dashboardKind && existing.dashboardIdentity !== input.dashboardKind) {
      throw appFailure(409, "An installed native dashboard keeps its built-in identity.");
    }
    if (existing?.nativeIdentity && input.nativeKind && existing.nativeIdentity !== input.nativeKind) {
      throw appFailure(409, "An installed native app keeps its built-in identity.");
    }
    if (existing?.shippedTemplateKind && input.shippedTemplateKind && existing.shippedTemplateKind !== input.shippedTemplateKind) {
      throw appFailure(409, "An installed shipped template keeps its identity.");
    }
    if ([(existing?.dashboardIdentity ?? input.dashboardKind), (existing?.nativeIdentity ?? input.nativeKind),
      (existing?.shippedTemplateKind ?? input.shippedTemplateKind)].filter(Boolean).length > 1) {
      throw appFailure(400, "A built-in Mini App keeps one identity.");
    }
    this.requireNativeBindings(Boolean(existing?.dashboardIdentity ?? input.dashboardKind ?? existing?.nativeIdentity ?? input.nativeKind), input.bindings);
    const publishers = [...new Set(input.publisherBotIds ?? existing?.publisherBotIds ?? (actor.botId ? [actor.botId] : []))];
    if (actor.botId && input.publisherBotIds !== undefined) throw appFailure(403, "Only the workspace owner can change publisher grants.");
    if (publishers.some((publisher) => !this.validPublisher(publisher))) throw appFailure(400, "A publisher bot no longer exists.");
    this.authorizeTemplate(actor, existing, input.bindings);
    for (const binding of input.bindings) await this.data.validateBinding(MINI_APPS_OWNER, binding);
    this.authorizeTemplate(actor, existing && this.require(actor, existing.id, true), input.bindings);
    this.requireDashboardTemplateWrite(actor, existing && this.require(actor, existing.id, true), input.html);
    const stored = this.docs.put({ source: "html", html: input.html });
    if (!stored.ok) throw appFailure(413, "The local app document store is full. The previous version is unchanged.");
    return this.access.write((db) => {
      const current = existing ? this.require(actor, existing.id, true) : undefined;
      this.authorizeTemplate(actor, current, input.bindings);
      this.requireDashboardTemplateWrite(actor, current, input.html);
      const retry = this.replay(actor, target, "publish", input);
      if (retry) return retry;
      this.expected(current, input.expectedRevision);
      if (!current && db.prepare("SELECT 1 FROM mini_apps WHERE owner_id = ? AND slug = ?").get(MINI_APPS_OWNER, input.slug)) throw appFailure(409, "A Mini App already uses this slug.");
      if (publishers.some((publisher) => !this.validPublisher(publisher))) throw appFailure(409, "A publisher bot was removed during publication.");
      const responsibleBotId = input.responsibleBotId === undefined ? current?.responsibleBotId ?? null : input.responsibleBotId;
      if (responsibleBotId && !this.validPublisher(responsibleBotId)) throw appFailure(409, "The responsible Bot no longer exists.");
      const now = Date.now();
      const appId = current?.id ?? randomUUID();
      const last = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM mini_app_versions WHERE app_id = ?").get(appId) as { version: number };
      const dashboardKind = input.dashboardKind === undefined ? current?.dashboard?.kind ?? null : input.dashboardKind;
      const dashboardIdentity = current?.dashboardIdentity ?? dashboardKind;
      const nativeKind = input.nativeKind === undefined ? current?.nativeKind ?? null : input.nativeKind;
      const nativeIdentity = current?.nativeIdentity ?? nativeKind;
      const shippedTemplateKind = current?.shippedTemplateKind ?? input.shippedTemplateKind ?? null;
      if (current?.dashboardIdentity && dashboardKind && current.dashboardIdentity !== dashboardKind) {
        throw appFailure(409, "An installed native dashboard keeps its built-in identity.");
      }
      if (current?.shippedTemplateKind && input.shippedTemplateKind && current.shippedTemplateKind !== input.shippedTemplateKind) {
        throw appFailure(409, "An installed shipped template keeps its identity.");
      }
      if (current?.nativeIdentity && nativeKind && current.nativeIdentity !== nativeKind) {
        throw appFailure(409, "An installed native app keeps its built-in identity.");
      }
      if ([dashboardIdentity, nativeIdentity, shippedTemplateKind].filter(Boolean).length > 1) {
        throw appFailure(400, "A built-in Mini App keeps one identity.");
      }
      this.requireNativeBindings(Boolean(dashboardIdentity || nativeIdentity), input.bindings);
      const previousVersion = current && this.version(appId, current.templateVersion);
      const dashboardHtml = dashboardKind === "agent-team" && (trustedAgentTeamHtml || previousVersion?.dashboard_html === 1)
        || dashboardIdentity === "usage" && previousVersion?.dashboard_html === 1 && previousVersion.doc === stored.doc;
      const agentTeamDetails = dashboardKind === "agent-team" && (this.row(appId)?.agent_team_detail_grant === 1 || (!current && trustedAgentTeamHtml));
      const developed = !current || previousVersion?.doc !== stored.doc ||
        !isDeepStrictEqual(JSON.parse(previousVersion.bindings) as MiniAppDataBinding[], input.bindings);
      const releaseProvenance = developed ? null : parseProvenance(previousVersion?.release_provenance);
      const releaseProvenanceJson = releaseProvenance ? JSON.stringify(releaseProvenance) : null;
      const icon: MiniAppCustomIcon | null = input.icon === undefined ? current?.icon ?? null : input.icon;
      const iconJson = icon ? JSON.stringify(icon) : null;
      const app: MiniAppSummary = { id: appId, slug: input.slug, title: input.title, description: input.description,
        status: "active", revision: (current?.revision ?? 0) + 1, templateVersion: last.version + 1,
        publisherBotIds: publishers, responsibleBotId, capabilities: input.capabilities ?? current?.capabilities ?? [],
        dashboard: declaration(dashboardKind, dashboardHtml, agentTeamDetails), dashboardIdentity, nativeKind, nativeIdentity, shippedTemplateKind,
        icon, release: releaseProvenance, createdAt: current?.createdAt ?? now, updatedAt: now };
      db.prepare(`INSERT INTO mini_apps (id, owner_id, slug, title, description, status, revision, template_version, publishers, created_at, updated_at, dashboard_kind, dashboard_identity, dashboard_html, agent_team_detail_grant, native_kind, native_identity, shipped_template_kind, responsible_bot_id, capabilities, release_provenance, icon)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, status=excluded.status,
        revision=excluded.revision, template_version=excluded.template_version, publishers=excluded.publishers,
        updated_at=excluded.updated_at, dashboard_kind=excluded.dashboard_kind, dashboard_identity=excluded.dashboard_identity,
        dashboard_html=excluded.dashboard_html, agent_team_detail_grant=excluded.agent_team_detail_grant,
        native_kind=excluded.native_kind, native_identity=excluded.native_identity,
        shipped_template_kind=excluded.shipped_template_kind, responsible_bot_id=excluded.responsible_bot_id,
        capabilities=excluded.capabilities, release_provenance=excluded.release_provenance, icon=excluded.icon`)
        .run(appId, MINI_APPS_OWNER, app.slug, app.title, app.description, app.status, app.revision, app.templateVersion,
          JSON.stringify(publishers), app.createdAt, now, dashboardKind, dashboardIdentity, dashboardHtml ? 1 : 0, agentTeamDetails ? 1 : 0, nativeKind, nativeIdentity, shippedTemplateKind,
          responsibleBotId, JSON.stringify(app.capabilities), releaseProvenanceJson, iconJson);
      db.prepare("INSERT INTO mini_app_versions (app_id, version, doc, title, description, bindings, created_at, dashboard_html, release_provenance, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(appId, app.templateVersion, stored.doc, app.title, app.description, JSON.stringify(input.bindings), now, dashboardHtml ? 1 : 0, releaseProvenanceJson, iconJson);
      if (actor.botId && developed) recordMiniAppDevelopment(db, appId, actor.botId, now);
      return this.receipt(db, actor, target, "publish", input, app);
    });
  }

  async checkUpdate(actor: MiniAppActor, id: string, signal?: AbortSignal): Promise<MiniAppUpdateCheckResult> {
    if (actor.botId) throw appFailure(403, "Only the workspace owner can check Mini App updates.");
    const doc = this.document(actor, id);
    const result = await this.releaseSource.checkUpdate(doc.app, doc.html, doc.bindings, signal);
    if (signal?.aborted) throw appFailure(503, "Mini App release request was cancelled.");
    this.authorize(actor);
    return result;
  }

  async applyUpdate(actor: MiniAppActor, id: string, raw: unknown, signal?: AbortSignal): Promise<MiniAppMutationResult> {
    this.authorize(actor, undefined, true);
    if (actor.botId) throw appFailure(403, "Only the workspace owner can update Mini Apps from releases.");
    const input = parseReleaseUpdateApply(raw);
    const existing = this.require(actor, id, true);
    const replay = this.replay(actor, id, "update", input);
    if (replay) return replay;
    this.expected(existing, input.expectedRevision);
    const existingVersion = this.version(id, existing.templateVersion);
    const existingDoc = this.docs.read(existingVersion.doc);
    if (!existingDoc) throw appFailure(503, "The Mini App document is unavailable. Restore its workspace backup.");
    const existingBindings = JSON.parse(existingVersion.bindings) as MiniAppDataBinding[];
    const verified = await this.releaseSource.fetchVerifiedUpdate(
      existing,
      existingDoc.html,
      existingBindings,
      { appVersion: input.appVersion, sourceCommit: input.sourceCommit },
      signal,
    );
    if (signal?.aborted) throw appFailure(503, "Mini App release request was cancelled.");
    for (const binding of existingBindings) await this.data.validateBinding(MINI_APPS_OWNER, binding);
    if (signal?.aborted) throw appFailure(503, "Mini App release request was cancelled.");
    this.authorize(actor, undefined, true);
    const stored = this.docs.put({ source: "html", html: verified.html });
    if (!stored.ok) throw appFailure(413, "The local app document store is full. The previous version is unchanged.");
    return this.access.write((db) => {
      if (signal?.aborted) throw appFailure(503, "Mini App release request was cancelled.");
      const current = this.require(actor, id, true);
      const retry = this.replay(actor, id, "update", input);
      if (retry) return retry;
      this.expected(current, input.expectedRevision);
      if (current.status !== "active") throw appFailure(409, "This Mini App is archived.");
      const mapping = miniAppReleaseMapping(current);
      const currentVersion = this.version(id, current.templateVersion);
      const currentDoc = this.docs.read(currentVersion.doc);
      if (!currentDoc) throw appFailure(503, "The Mini App document is unavailable. Restore its workspace backup.");
      const currentBindings = JSON.parse(currentVersion.bindings) as MiniAppDataBinding[];
      if (!mapping || isCustomAppTemplate(current, mapping, currentDoc.html, currentBindings)) {
        throw appFailure(409, "This Mini App has custom changes and cannot be overwritten by a release update.");
      }
      if (hasRevokedBuiltInGrant(current, mapping)) {
        throw appFailure(403, "This Mini App's built-in grant has been revoked.");
      }
      if (verified.provenance.packageId !== mapping.packageId || !isReleaseCompatible(current, mapping, verified.provenance.requires)) {
        throw appFailure(409, "The Mini App identity changed while applying the update.");
      }
      const now = Date.now();
      const last = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM mini_app_versions WHERE app_id = ?").get(id) as { version: number };
      const dashboardHtml = current.dashboard?.kind === "agent-team" || current.dashboard?.kind === "usage";
      const release = { ...verified.provenance, previousTemplateVersion: current.templateVersion, updateRequestKey: input.requestKey };
      const releaseProvenanceJson = JSON.stringify(release);
      const app: MiniAppSummary = {
        ...current,
        revision: current.revision + 1,
        templateVersion: last.version + 1,
        dashboard: declaration(current.dashboard?.kind ?? null, dashboardHtml, this.row(id)?.agent_team_detail_grant === 1),
        shippedTemplateKind: mapping.kind === "mojo" ? "mojo" : current.shippedTemplateKind ?? null,
        release,
        updatedAt: now,
      };
      db.prepare("UPDATE mini_apps SET revision = ?, template_version = ?, updated_at = ?, dashboard_html = ?, shipped_template_kind = ?, release_provenance = ? WHERE id = ?")
        .run(app.revision, app.templateVersion, now, dashboardHtml ? 1 : 0, app.shippedTemplateKind ?? null, releaseProvenanceJson, id);
      db.prepare("INSERT INTO mini_app_versions (app_id, version, doc, title, description, bindings, created_at, dashboard_html, release_provenance, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, app.templateVersion, stored.doc, app.title, app.description, currentVersion.bindings, now, dashboardHtml ? 1 : 0, releaseProvenanceJson, app.icon ? JSON.stringify(app.icon) : null);
      return this.receipt(db, actor, id, "update", input, app);
    });
  }

  async rollback(actor: MiniAppActor, id: string, raw: unknown): Promise<MiniAppMutationResult> {
    const input = rollbackSchema.safeParse(raw);
    if (!input.success) throw appFailure(400, "Invalid Mini App rollback.");
    const current = this.require(actor, id, true);
    this.authorizeTemplate(actor, current);
    if (actor.botId && current.dashboard?.renderer === "html") {
      throw appFailure(403, "Only the owner can change this dashboard page.");
    }
    const replay = this.replay(actor, id, "rollback", input.data);
    if (replay) return replay;
    this.expected(current, input.data.expectedRevision);
    const version = this.version(id, input.data.templateVersion);
    if (actor.botId && current.dashboardIdentity && version.dashboard_html === 1) {
      throw appFailure(403, "Only the owner can change this dashboard page.");
    }
    if (!this.docs.read(version.doc)) throw appFailure(503, "The requested template is unavailable.");
    const bindings = JSON.parse(version.bindings) as MiniAppDataBinding[];
    const managed = Boolean(current.release || version.release_provenance || this.db()
      .prepare("SELECT 1 FROM mini_app_versions WHERE app_id = ? AND release_provenance IS NOT NULL LIMIT 1").get(id));
    if (managed) {
      if (actor.botId) throw appFailure(403, "Only the workspace owner can restore Mini App releases.");
      const currentBindings = JSON.parse(this.version(id, current.templateVersion).bindings) as MiniAppDataBinding[];
      if (!isDeepStrictEqual(currentBindings, bindings)) {
        throw appFailure(409, "This template uses different Data bindings. The current Mini App was kept unchanged.");
      }
    }
    this.requireNativeBindings(Boolean(current.dashboardIdentity || current.nativeIdentity), bindings);
    this.authorizeTemplate(actor, current, bindings);
    for (const binding of bindings) await this.data.validateBinding(MINI_APPS_OWNER, binding);
    this.authorizeTemplate(actor, this.require(actor, id, true), bindings);
    return this.changeHead(actor, id, "rollback", input.data, (app, targetVersion) => {
      this.authorizeTemplate(actor, app, bindings);
      this.requireNativeBindings(Boolean(app.dashboardIdentity || app.nativeIdentity), bindings);
      return { ...app, title: managed ? app.title : version.title, description: managed ? app.description : version.description,
        icon: managed ? app.icon ?? null : parseIcon(targetVersion.icon),
        templateVersion: version.version, status: "active" };
    });
  }

  archive(actor: MiniAppActor, id: string, raw: unknown): MiniAppMutationResult {
    const input = archiveSchema.safeParse(raw);
    if (!input.success) throw appFailure(400, "Invalid Mini App archive.");
    return this.changeHead(actor, id, "archive", input.data, (app) => ({ ...app, status: "archived", dashboard: null, nativeKind: null }));
  }

  private changeHead(actor: MiniAppActor, id: string, operation: string, input: MiniAppRollback | MiniAppArchive, change: (app: MiniAppSummary, targetVersion: VersionRow) => MiniAppSummary): MiniAppMutationResult {
    this.require(actor, id, true);
    return this.access.write((db) => {
      const current = this.require(actor, id, true);
      const replay = this.replay(actor, id, operation, input);
      if (replay) return replay;
      this.expected(current, input.expectedRevision);
      const requestedVersion = "templateVersion" in input ? input.templateVersion : current.templateVersion;
      const targetVersion = this.version(id, requestedVersion);
      const changed = change(current, targetVersion);
      const dashboardHtml = targetVersion.dashboard_html === 1;
      const releaseProvenance = parseProvenance(targetVersion.release_provenance);
      const releaseProvenanceJson = releaseProvenance ? JSON.stringify(releaseProvenance) : null;
      const iconJson = changed.icon ? JSON.stringify(changed.icon) : null;
      const agentTeamDetails = changed.dashboard?.kind === "agent-team" && this.row(id)?.agent_team_detail_grant === 1;
      const app = { ...changed, dashboard: declaration(changed.dashboard?.kind ?? null, dashboardHtml, agentTeamDetails),
        release: releaseProvenance, revision: current.revision + 1, updatedAt: Date.now() };
      db.prepare("UPDATE mini_apps SET title = ?, description = ?, status = ?, revision = ?, template_version = ?, updated_at = ?, dashboard_kind = ?, dashboard_html = ?, agent_team_detail_grant = ?, native_kind = ?, release_provenance = ?, icon = ? WHERE id = ?")
        .run(app.title, app.description, app.status, app.revision, app.templateVersion, app.updatedAt, app.dashboard?.kind ?? null, dashboardHtml ? 1 : 0, agentTeamDetails ? 1 : 0, app.nativeKind ?? null, releaseProvenanceJson, iconJson, id);
      return this.receipt(db, actor, id, operation, input, app);
    });
  }

  async state(actor: MiniAppActor, id: string): Promise<MiniAppState> {
    const { app, bindings } = this.versionBindings(actor, id);
    const wanted = new Set(bindings.map((binding) => binding.datasetId));
    const data = wanted.size ? (await this.data.listDatasets(MINI_APPS_OWNER)).filter((dataset) => wanted.has(dataset.datasetId))
      .map(({ datasetId, revision }) => ({ datasetId, revision })) : [];
    const current = this.require(actor, id);
    this.expected(current, app.revision);
    if (data.length !== wanted.size) throw appFailure(503, "A bound Data source is unavailable.");
    return { appId: id, revision: current.revision, templateVersion: current.templateVersion, status: current.status, data };
  }

  async dashboardRead(actor: MiniAppActor, id: string, raw: unknown): Promise<MiniAppDashboardReadResult> {
    const input = parseDashboardRead(raw);
    if (actor.botId) throw appFailure(403, "Bots cannot read the workspace owner's dashboard snapshots.");
    const allowed = (app: MiniAppSummary, resource: MiniAppDashboardResource) => {
      if (app.status !== "active") throw appFailure(409, "This Mini App is archived.");
      if (!app.dashboard || !(app.dashboard.resources as readonly string[]).includes(resource)) {
        throw appFailure(403, "This Mini App is not granted that dashboard resource.");
      }
    };
    const app = this.require(actor, id);
    this.expected(app, input.expectedRevision);
    allowed(app, input.resource);
    const providers = this.dashboardProviders;
    if (!providers) throw appFailure(503, "Local dashboard data is unavailable.");
    const key = `${MINI_APPS_OWNER}:${id}`;
    if ((this.running.get(key) ?? 0) >= 8 || !this.rate.take(key)) throw appFailure(429, "Too many Mini App reads. Wait a moment.");
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    try {
      const currentMember = async () => {
        const teams = providers.agents.getRoster ? await providers.agents.getRoster() : await providers.agents.get(true);
        if (teams.status !== "ready") throw appFailure(409, "The current Agent Team session is unavailable.");
        if (input.resource === "team-rules") {
          if (teams.teams.filter((team) => team.id === input.teamId).length !== 1) {
            throw appFailure(409, "The Agent Team changed while its details were being read.");
          }
        } else if (input.resource === "activity" || input.resource === "configuration" || input.resource === "skill") {
          const members = teams.teams.flatMap((team) => team.agents).filter((member) => member.id === input.agentId
            && member.occupantId === input.occupantId);
          if (members.length !== 1) throw appFailure(409, "The Agent Team session changed while its details were being read.");
        }
      };
      if (input.resource !== "teams" && input.resource !== "usage") await currentMember();
      let result: MiniAppDashboardReadResult;
      if (input.resource === "teams") result = { appId: id, revision: app.revision, resource: "teams",
        snapshot: await providers.agents.get() };
      else if (input.resource === "activity") result = { appId: id, revision: app.revision, resource: "activity",
        snapshot: input.history === 1
          ? await providers.activity.get(input.agentId, { occupantId: input.occupantId, before: input.before })
          : await providers.activity.get(input.agentId) };
      else if (input.resource === "configuration") result = { appId: id, revision: app.revision, resource: "configuration",
        snapshot: await providers.configuration.getAgent(input.agentId) };
      else if (input.resource === "team-rules") result = { appId: id, revision: app.revision, resource: "team-rules",
        snapshot: await providers.configuration.getTeamRules(input.teamId) };
      else if (input.resource === "skill") result = { appId: id, revision: app.revision, resource: "skill",
        snapshot: await providers.configuration.getSkill(input.agentId, input.skillId) };
      else result = { appId: id, revision: app.revision, resource: "usage",
        snapshot: await providers.usage.get() };
      if (input.resource !== "teams" && input.resource !== "usage") await currentMember();
      if (input.resource === "activity" && result.resource === "activity" && result.snapshot.agentId !== input.agentId
        || input.resource === "configuration" && result.resource === "configuration" && (result.snapshot.agentId !== input.agentId || result.snapshot.occupantId !== input.occupantId)
        || input.resource === "skill" && result.resource === "skill" && (result.snapshot.agentId !== input.agentId || result.snapshot.occupantId !== input.occupantId || result.snapshot.skillId !== input.skillId)
        || input.resource === "team-rules" && result.resource === "team-rules" && result.snapshot.teamId !== input.teamId) {
        throw appFailure(409, "The Agent Team details changed while they were being read.");
      }
      const current = this.require(actor, id);
      this.expected(current, app.revision);
      allowed(current, input.resource);
      if (Buffer.byteLength(JSON.stringify(result)) > 1_000_000) throw appFailure(413, "This dashboard snapshot is too large.");
      return result;
    } finally {
      const count = (this.running.get(key) ?? 1) - 1;
      if (count) this.running.set(key, count); else this.running.delete(key);
    }
  }

  async query(actor: MiniAppActor, id: string, raw: unknown): Promise<MiniAppQueryResult> {
    const input: MiniAppQuery = parseQuery(raw);
    const { app, bindings } = this.versionBindings(actor, id);
    this.expected(app, input.expectedRevision);
    if (app.status !== "active") throw appFailure(409, "This Mini App is archived.");
    const binding = bindings.find((candidate) => Object.hasOwn(candidate.queries, input.queryId));
    if (!binding) throw appFailure(400, "This query is not declared by the installed Mini App.");
    const key = `${actor.botId ?? MINI_APPS_OWNER}:${id}`;
    if ((this.running.get(key) ?? 0) >= 8 || !this.rate.take(key)) throw appFailure(429, "Too many Mini App reads. Wait a moment.");
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    try {
      const result = await this.data.readNamed({ ownerId: MINI_APPS_OWNER, binding, queryId: input.queryId, parameters: input.parameters,
        scope: `${MINI_APPS_OWNER}:${id}:${app.revision}`, ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.expectedDataRevision === undefined ? {} : { expectedRevision: input.expectedDataRevision }) });
      const current = this.require(actor, id);
      this.expected(current, app.revision);
      if (Buffer.byteLength(JSON.stringify(result)) > 1_000_000) throw appFailure(413, "This query page is too large. Publish a smaller page size or fewer columns.");
      return result;
    } finally {
      const count = (this.running.get(key) ?? 1) - 1;
      if (count) this.running.set(key, count); else this.running.delete(key);
    }
  }
}
