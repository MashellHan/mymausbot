import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import { MINI_APP_DASHBOARD_RESOURCES, type MiniAppArchive, type MiniAppDashboardDeclaration, type MiniAppDashboardDiscovery,
  type MiniAppDashboardKind, type MiniAppDashboardReadResult, type MiniAppDocument, type MiniAppMutationResult,
  type MiniAppDashboardResource, type MiniAppQuery, type MiniAppQueryResult, type MiniAppRollback, type MiniAppState,
  type MiniAppShippedTemplateKind, type MiniAppSummary } from "../../shared/mini-apps.ts";
import { AppDocs } from "../app-docs.ts";
import { rowRate } from "../chat-apps.ts";
import type { DataEngine } from "../data/types.ts";
import { applicationDatabase, withApplicationWrite } from "../message-db.ts";
import type { LocalDashboardProviders } from "../routes/local-dashboard.ts";
import { appFailure, archiveSchema, parseDashboardRead, parsePublish, parseQuery, rollbackSchema } from "./validation.ts";
import { developedMiniApps, ensureMiniAppDevelopment, recordMiniAppDevelopment } from "./development.ts";

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
      shipped_template_kind TEXT CHECK(shipped_template_kind IN ('bookkeeping', 'x_ai_digest', 'github_activity') OR shipped_template_kind IS NULL),
      responsible_bot_id TEXT, capabilities TEXT NOT NULL DEFAULT '[]',
      UNIQUE(owner_id, slug)
    );
    CREATE TABLE IF NOT EXISTS mini_app_versions (
      app_id TEXT NOT NULL, version INTEGER NOT NULL, doc TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL, bindings TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(app_id, version), FOREIGN KEY(app_id) REFERENCES mini_apps(id)
    );
    CREATE TABLE IF NOT EXISTS mini_app_receipts (
      actor TEXT NOT NULL, target TEXT NOT NULL, operation TEXT NOT NULL, request_key TEXT NOT NULL,
      content_hash TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(actor, target, operation, request_key)
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
  if (!columns.some(({ name }) => name === "shipped_template_kind")) {
    db.exec("ALTER TABLE mini_apps ADD COLUMN shipped_template_kind TEXT CHECK(shipped_template_kind IN ('bookkeeping', 'x_ai_digest', 'github_activity') OR shipped_template_kind IS NULL)");
  }
  if (!columns.some(({ name }) => name === "responsible_bot_id")) db.exec("ALTER TABLE mini_apps ADD COLUMN responsible_bot_id TEXT");
  if (!columns.some(({ name }) => name === "capabilities")) db.exec("ALTER TABLE mini_apps ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'");
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
  dashboard_kind: MiniAppDashboardKind | null; dashboard_identity: MiniAppDashboardKind | null;
  shipped_template_kind: MiniAppShippedTemplateKind | null;
  responsible_bot_id: string | null; capabilities: string;
};
type VersionRow = { version: number; doc: string; title: string; description: string; bindings: string; created_at: number };
function declaration(kind: MiniAppDashboardKind | null): MiniAppDashboardDeclaration | null {
  if (kind === null) return null;
  if (kind === "agent-team") return { kind, renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"],
    resources: MINI_APP_DASHBOARD_RESOURCES[kind] };
  if (kind === "usage") return { kind, renderer: "native", htmlRole: "fallback-only", editableFields: ["title", "description"],
    resources: MINI_APP_DASHBOARD_RESOURCES[kind] };
  throw appFailure(503, "The Mini App dashboard grant is invalid.");
}
const summary = (row: AppRow): MiniAppSummary => ({
  id: row.id, slug: row.slug, title: row.title, description: row.description, status: row.status,
  revision: row.revision, templateVersion: row.template_version, publisherBotIds: JSON.parse(row.publishers) as string[],
  responsibleBotId: row.responsible_bot_id, capabilities: JSON.parse(row.capabilities) as string[],
  dashboard: declaration(row.dashboard_kind), dashboardIdentity: row.dashboard_identity,
  shippedTemplateKind: row.shipped_template_kind,
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

  constructor(deps: {
    docs: AppDocs;
    data: MiniApps["data"];
    validPublisher(id: string): boolean;
    dashboardProviders?: LocalDashboardProviders;
    access?: MiniAppDatabaseAccess;
  }) {
    this.docs = deps.docs;
    this.data = deps.data;
    this.validPublisher = deps.validPublisher;
    this.dashboardProviders = deps.dashboardProviders;
    this.access = deps.access ?? { database: applicationDatabase, write: withApplicationWrite };
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

  list(actor: MiniAppActor): MiniAppSummary[] {
    this.authorize(actor);
    return (this.db().prepare("SELECT * FROM mini_apps WHERE owner_id = ? ORDER BY created_at, id").all(MINI_APPS_OWNER) as unknown as AppRow[])
      .map(summary).filter((app) => !actor.botId || app.publisherBotIds.includes(actor.botId));
  }

  developedBy(botId: string): Set<string> {
    return developedMiniApps(this.db(), botId);
  }

  dashboardCatalog(actor: MiniAppActor): MiniAppDashboardDiscovery[] {
    this.authorize(actor);
    return (this.db().prepare("SELECT * FROM mini_apps WHERE owner_id = ? AND status = 'active' AND dashboard_identity IS NOT NULL ORDER BY created_at, id")
      .all(MINI_APPS_OWNER) as unknown as AppRow[]).map((row) => ({ id: row.id, revision: row.revision,
      dashboardIdentity: row.dashboard_identity!, dashboard: declaration(row.dashboard_kind) }));
  }

  document(actor: MiniAppActor, id: string): MiniAppDocument {
    const app = this.require(actor, id);
    const version = this.version(id, app.templateVersion);
    const doc = this.docs.read(version.doc);
    if (!doc) throw appFailure(503, "The Mini App document is unavailable. Restore its workspace backup.");
    return { app, html: doc.html, bindings: JSON.parse(version.bindings) as MiniAppDataBinding[],
      versions: (this.db().prepare("SELECT version, title, created_at AS createdAt FROM mini_app_versions WHERE app_id = ? ORDER BY version DESC").all(id) as unknown as MiniAppDocument["versions"]) };
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
      shippedTemplateKind: app.shippedTemplateKind ?? null, responsibleBotId: app.responsibleBotId ?? null,
      capabilities: app.capabilities ?? [] }, replayed: true };
  }

  private hash(input: unknown): string { return createHash("sha256").update(canonical(input)).digest("hex"); }

  private receipt(db: DatabaseSync, actor: MiniAppActor, target: string, operation: string, input: { requestKey: string }, app: MiniAppSummary): MiniAppMutationResult {
    db.prepare("INSERT INTO mini_app_receipts VALUES (?, ?, ?, ?, ?, ?, ?)").run(actor.botId ?? MINI_APPS_OWNER, target, operation, input.requestKey, this.hash(input), JSON.stringify(app), Date.now());
    return { app, replayed: false };
  }

  private expected(app: MiniAppSummary | undefined, revision: number): void {
    if ((app?.revision ?? 0) !== revision) throw appFailure(409, "The Mini App changed. Read its current version before publishing again.");
  }

  private requireDashboardBindings(kind: MiniAppDashboardKind | null, bindings: MiniAppDataBinding[]): void {
    if (kind && bindings.length) throw appFailure(400, "Native dashboard Mini Apps require empty Data bindings.");
  }

  async publish(actor: MiniAppActor, raw: unknown, id?: string): Promise<MiniAppMutationResult> {
    this.authorize(actor, undefined, true);
    const input = parsePublish(raw);
    if (actor.botId && input.dashboardKind !== undefined) throw appFailure(403, "Only the workspace owner can grant dashboard resources.");
    if (actor.botId && input.shippedTemplateKind !== undefined) throw appFailure(403, "Only the workspace owner can identify a shipped template.");
    if (actor.botId && input.responsibleBotId !== undefined) throw appFailure(403, "Only the workspace owner can assign responsibility.");
    if (input.responsibleBotId && !this.validPublisher(input.responsibleBotId)) throw appFailure(400, "The responsible Bot does not exist.");
    const target = id ?? `slug:${input.slug}`;
    const existing = id ? this.require(actor, id, true) : (() => {
      const row = this.db().prepare("SELECT * FROM mini_apps WHERE owner_id = ? AND slug = ?").get(MINI_APPS_OWNER, input.slug) as AppRow | undefined;
      return row && summary(row);
    })();
    this.authorizeTemplate(actor, existing);
    const replay = this.replay(actor, target, "publish", input);
    if (replay) return replay;
    if (!id && existing) throw appFailure(409, "A Mini App already uses this slug. Publish a new version using its app id.");
    this.expected(existing, input.expectedRevision);
    if (existing && existing.slug !== input.slug) throw appFailure(400, "An installed Mini App keeps its slug.");
    if (existing?.dashboardIdentity && input.dashboardKind && existing.dashboardIdentity !== input.dashboardKind) {
      throw appFailure(409, "An installed native dashboard keeps its built-in identity.");
    }
    if (existing?.shippedTemplateKind && input.shippedTemplateKind && existing.shippedTemplateKind !== input.shippedTemplateKind) {
      throw appFailure(409, "An installed shipped template keeps its identity.");
    }
    if ((existing?.dashboardIdentity ?? input.dashboardKind) && (existing?.shippedTemplateKind ?? input.shippedTemplateKind)) {
      throw appFailure(400, "A native dashboard cannot also be a Data template.");
    }
    this.requireDashboardBindings(existing?.dashboardIdentity ?? input.dashboardKind ?? null, input.bindings);
    const publishers = [...new Set(input.publisherBotIds ?? existing?.publisherBotIds ?? (actor.botId ? [actor.botId] : []))];
    if (actor.botId && input.publisherBotIds !== undefined) throw appFailure(403, "Only the workspace owner can change publisher grants.");
    if (publishers.some((publisher) => !this.validPublisher(publisher))) throw appFailure(400, "A publisher bot no longer exists.");
    this.authorizeTemplate(actor, existing, input.bindings);
    for (const binding of input.bindings) await this.data.validateBinding(MINI_APPS_OWNER, binding);
    this.authorizeTemplate(actor, existing && this.require(actor, existing.id, true), input.bindings);
    const stored = this.docs.put({ source: "html", html: input.html });
    if (!stored.ok) throw appFailure(413, "The local app document store is full. The previous version is unchanged.");
    return this.access.write((db) => {
      const current = existing ? this.require(actor, existing.id, true) : undefined;
      this.authorizeTemplate(actor, current, input.bindings);
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
      const shippedTemplateKind = current?.shippedTemplateKind ?? input.shippedTemplateKind ?? null;
      if (current?.dashboardIdentity && dashboardKind && current.dashboardIdentity !== dashboardKind) {
        throw appFailure(409, "An installed native dashboard keeps its built-in identity.");
      }
      if (current?.shippedTemplateKind && input.shippedTemplateKind && current.shippedTemplateKind !== input.shippedTemplateKind) {
        throw appFailure(409, "An installed shipped template keeps its identity.");
      }
      if (dashboardIdentity && shippedTemplateKind) throw appFailure(400, "A native dashboard cannot also be a Data template.");
      this.requireDashboardBindings(dashboardIdentity, input.bindings);
      const previousVersion = current && this.version(appId, current.templateVersion);
      const developed = !current || previousVersion?.doc !== stored.doc ||
        !isDeepStrictEqual(JSON.parse(previousVersion.bindings) as MiniAppDataBinding[], input.bindings);
      const app: MiniAppSummary = { id: appId, slug: input.slug, title: input.title, description: input.description,
        status: "active", revision: (current?.revision ?? 0) + 1, templateVersion: last.version + 1,
        publisherBotIds: publishers, responsibleBotId, capabilities: input.capabilities ?? current?.capabilities ?? [],
        dashboard: declaration(dashboardKind), dashboardIdentity, shippedTemplateKind,
        createdAt: current?.createdAt ?? now, updatedAt: now };
      db.prepare(`INSERT INTO mini_apps (id, owner_id, slug, title, description, status, revision, template_version, publishers, created_at, updated_at, dashboard_kind, dashboard_identity, shipped_template_kind, responsible_bot_id, capabilities)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, status=excluded.status,
        revision=excluded.revision, template_version=excluded.template_version, publishers=excluded.publishers,
        updated_at=excluded.updated_at, dashboard_kind=excluded.dashboard_kind, dashboard_identity=excluded.dashboard_identity,
        shipped_template_kind=excluded.shipped_template_kind, responsible_bot_id=excluded.responsible_bot_id,
        capabilities=excluded.capabilities`)
        .run(appId, MINI_APPS_OWNER, app.slug, app.title, app.description, app.status, app.revision, app.templateVersion,
          JSON.stringify(publishers), app.createdAt, now, dashboardKind, dashboardIdentity, shippedTemplateKind,
          responsibleBotId, JSON.stringify(app.capabilities));
      db.prepare("INSERT INTO mini_app_versions VALUES (?, ?, ?, ?, ?, ?, ?)").run(appId, app.templateVersion, stored.doc, app.title, app.description, JSON.stringify(input.bindings), now);
      if (actor.botId && developed) recordMiniAppDevelopment(db, appId, actor.botId, now);
      return this.receipt(db, actor, target, "publish", input, app);
    });
  }

  async rollback(actor: MiniAppActor, id: string, raw: unknown): Promise<MiniAppMutationResult> {
    const input = rollbackSchema.safeParse(raw);
    if (!input.success) throw appFailure(400, "Invalid Mini App rollback.");
    const current = this.require(actor, id, true);
    this.authorizeTemplate(actor, current);
    const replay = this.replay(actor, id, "rollback", input.data);
    if (replay) return replay;
    const version = this.version(id, input.data.templateVersion);
    if (!this.docs.read(version.doc)) throw appFailure(503, "The requested template is unavailable.");
    const bindings = JSON.parse(version.bindings) as MiniAppDataBinding[];
    this.requireDashboardBindings(current.dashboardIdentity ?? null, bindings);
    this.authorizeTemplate(actor, current, bindings);
    for (const binding of bindings) await this.data.validateBinding(MINI_APPS_OWNER, binding);
    this.authorizeTemplate(actor, this.require(actor, id, true), bindings);
    return this.changeHead(actor, id, "rollback", input.data, (app) => {
      this.authorizeTemplate(actor, app, bindings);
      this.requireDashboardBindings(app.dashboardIdentity ?? null, bindings);
      return { ...app, title: version.title, description: version.description, templateVersion: version.version, status: "active" };
    });
  }

  archive(actor: MiniAppActor, id: string, raw: unknown): MiniAppMutationResult {
    const input = archiveSchema.safeParse(raw);
    if (!input.success) throw appFailure(400, "Invalid Mini App archive.");
    return this.changeHead(actor, id, "archive", input.data, (app) => ({ ...app, status: "archived", dashboard: null }));
  }

  private changeHead(actor: MiniAppActor, id: string, operation: string, input: MiniAppRollback | MiniAppArchive, change: (app: MiniAppSummary) => MiniAppSummary): MiniAppMutationResult {
    this.require(actor, id, true);
    return this.access.write((db) => {
      const current = this.require(actor, id, true);
      const replay = this.replay(actor, id, operation, input);
      if (replay) return replay;
      this.expected(current, input.expectedRevision);
      const app = { ...change(current), revision: current.revision + 1, updatedAt: Date.now() };
      db.prepare("UPDATE mini_apps SET title = ?, description = ?, status = ?, revision = ?, template_version = ?, updated_at = ?, dashboard_kind = ? WHERE id = ?")
        .run(app.title, app.description, app.status, app.revision, app.templateVersion, app.updatedAt, app.dashboard?.kind ?? null, id);
      return this.receipt(db, actor, id, operation, input, app);
    });
  }

  async state(actor: MiniAppActor, id: string): Promise<MiniAppState> {
    const document = this.document(actor, id);
    const wanted = new Set(document.bindings.map((binding) => binding.datasetId));
    const data = wanted.size ? (await this.data.listDatasets(MINI_APPS_OWNER)).filter((dataset) => wanted.has(dataset.datasetId))
      .map(({ datasetId, revision }) => ({ datasetId, revision })) : [];
    const current = this.require(actor, id);
    this.expected(current, document.app.revision);
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
      let result: MiniAppDashboardReadResult;
      if (input.resource === "teams") result = { appId: id, revision: app.revision, resource: "teams",
        snapshot: await providers.agents.get() };
      else if (input.resource === "activity") result = { appId: id, revision: app.revision, resource: "activity",
        snapshot: await providers.activity.get(input.agentId) };
      else result = { appId: id, revision: app.revision, resource: "usage",
        snapshot: await providers.usage.get() };
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
    const { app, bindings } = this.document(actor, id);
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
