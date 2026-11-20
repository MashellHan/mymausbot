import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { createBookkeepingPublish } from "../../shared/bookkeeping-mini-app.ts";
import { LEGACY_MINI_APP_IDS } from "../../shared/mini-app-release-packages.ts";
import { DEFAULT_MINI_APP_KINDS, type DefaultMiniAppKind, type MiniAppDefaultsInput, type MiniAppDefaultsResult,
  type MiniAppDocument, type MiniAppPublish, type MiniAppSummary } from "../../shared/mini-apps.ts";
import type { ReportKind } from "../../shared/report-mini-app.ts";
import { reportKindForRoutine } from "../../shared/report-routine.ts";
import type { DataEngine } from "../data/types.ts";
import type { Routine } from "../routines.ts";
import { DEFAULT_APPS, matchesPendingDefaultHtml, NATIVE_DEFAULT_HTML, pendingDefaultHtml, updatedDefaultAppTitle } from "./default-documents.ts";
import { REVIEWED_AGENT_TEAM_HTML_SHA256 } from "./default-template-history.ts";
import { existingBookkeepingSource } from "./default-sources.ts";
import { defaultMiniAppUpdate } from "./default-updates.ts";
import type { MiniAppActor, MiniApps } from "./registry.ts";
import type { ReportStore } from "./report-store.ts";
import { appFailure } from "./validation.ts";

const INPUT = z.object({ bookkeepingHtml: z.string().min(1).max(512 * 1024),
  agentTeamHtml: z.string().min(1).max(512 * 1024).optional(), restore: z.enum(DEFAULT_MINI_APP_KINDS).optional() }).strict();
const nativeKind = (kind: DefaultMiniAppKind) => kind === "agent-team" || kind === "usage";
const identity = (app: MiniAppSummary): DefaultMiniAppKind | null => app.dashboardIdentity ?? app.nativeIdentity ?? app.shippedTemplateKind ?? null;
const reviewedAgentTeamHtml = (html?: string) => !!html && createHash("sha256").update(html).digest("hex") === REVIEWED_AGENT_TEAM_HTML_SHA256;

export interface DefaultMiniAppDeps {
  apps: MiniApps;
  data: DataEngine;
  reports: ReportStore;
  bots(): Array<{ id: string }>;
  routines(): { listRoutines(): Routine[] } | null;
}

export class DefaultMiniApps {
  private readonly deps: DefaultMiniAppDeps;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(deps: DefaultMiniAppDeps) { this.deps = deps; }

  ensure(owner: MiniAppActor, raw: unknown): Promise<MiniAppDefaultsResult> {
    owner.assertActive();
    if (owner.botId || !owner.writeAllowed) throw appFailure(403, "Only the local workspace owner can add default apps.");
    const parsed = INPUT.safeParse(raw);
    if (!parsed.success) throw appFailure(400, "Pass the bundled bookkeeping page and an optional app to add back.");
    if (Buffer.byteLength(parsed.data.bookkeepingHtml) > 512 * 1024) throw appFailure(413, "Mini App HTML exceeds 512 KiB.");
    if (parsed.data.agentTeamHtml && !reviewedAgentTeamHtml(parsed.data.agentTeamHtml)) {
      throw appFailure(400, "The bundled Agent Team template is not reviewed by this host.");
    }
    const operation = this.pending.catch(() => undefined).then(() => this.apply(owner, parsed.data));
    this.pending = operation;
    return operation;
  }

  private async apply(owner: MiniAppActor, input: MiniAppDefaultsInput): Promise<MiniAppDefaultsResult> {
    const issues: MiniAppDefaultsResult["issues"] = [];
    for (const kind of DEFAULT_MINI_APP_KINDS) {
      owner.assertActive();
      try { await this.ensureKind(owner, kind, input); }
      catch (error) {
        owner.assertActive();
        issues.push({ kind, error: error instanceof Error ? error.message : "This app could not be opened. Try again." });
      }
    }
    return { apps: this.deps.apps.list(owner), issues };
  }

  private isPristineMojoPlaceholder(owner: MiniAppActor, app: MiniAppSummary): boolean {
    if (app.id === LEGACY_MINI_APP_IDS.mojo || app.status !== "active" || app.revision !== 1 || app.templateVersion !== 1) return false;
    if (!/^mojo-included-\d+$/.test(app.slug)) return false;
    if (app.shippedTemplateKind !== "mojo" || app.dashboard || app.dashboardIdentity || app.nativeKind || app.nativeIdentity) return false;
    if (app.title !== DEFAULT_APPS.mojo.title || app.description !== DEFAULT_APPS.mojo.description) return false;
    if (app.publisherBotIds.length || app.responsibleBotId !== null || app.capabilities?.length || app.release !== null) return false;
    const document = this.deps.apps.document(owner, app.id);
    return document.bindings.length === 0
      && document.versions.length === 1
      && document.versions[0]?.version === 1
      && document.versions[0].release === null
      && document.html === pendingDefaultHtml("mojo");
  }

  private matchesForKind(owner: MiniAppActor, kind: DefaultMiniAppKind, apps: MiniAppSummary[]): MiniAppSummary[] {
    if (kind !== "mojo") return apps.filter((app) => identity(app) === kind);
    const canonicalLegacy = apps.find((app) => app.id === LEGACY_MINI_APP_IDS.mojo && (!identity(app) || identity(app) === "mojo"));
    if (!canonicalLegacy) return apps.filter((app) => identity(app) === "mojo");
    if (canonicalLegacy.status === "active") {
      for (const candidate of apps) {
        if (candidate.id !== canonicalLegacy.id && identity(candidate) === "mojo" && this.isPristineMojoPlaceholder(owner, candidate)) {
          this.deps.apps.archive(owner, candidate.id, { requestKey: randomUUID(), expectedRevision: candidate.revision });
        }
      }
    }
    return [canonicalLegacy];
  }

  private async ensureKind(owner: MiniAppActor, kind: DefaultMiniAppKind, input: MiniAppDefaultsInput): Promise<void> {
    const apps = this.deps.apps.list(owner);
    const matches = this.matchesForKind(owner, kind, apps);
    if (matches.length > 1) throw appFailure(409, "More than one copy of this included app exists. Your apps were kept unchanged.");
    const existing = matches[0];
    if (existing?.status === "archived" && input.restore !== kind) return;
    const current = existing ? this.deps.apps.document(owner, existing.id) : null;
    if (current && (current.app.release || current.versions.some((version) => Boolean(version.release)))) {
      if (input.restore === kind && (current.app.status === "archived" || nativeKind(kind) && !current.app.dashboard
          || kind === "hongguo" && !current.app.nativeKind)) {
        await this.restore(owner, current, kind);
      }
      return;
    }
    if (current && !this.waiting(current, kind)) {
      if (kind === "agent-team" && input.agentTeamHtml && this.deps.apps.canAdoptAgentTeamDefault(owner, current.app.id)) {
        await this.deps.apps.publish(owner, { requestKey: randomUUID(), expectedRevision: current.app.revision,
          slug: current.app.slug, title: current.app.title, description: current.app.description,
          html: input.agentTeamHtml, bindings: [], publisherBotIds: current.app.publisherBotIds,
          dashboardKind: "agent-team" }, current.app.id, true);
        return;
      }
      const update = defaultMiniAppUpdate(current, kind, input.bookkeepingHtml);
      if (update) {
        await this.deps.apps.publish(owner, update, current.app.id);
        return;
      }
      if (input.restore === kind && (current.app.status === "archived" || nativeKind(kind) && !current.app.dashboard
          || kind === "hongguo" && !current.app.nativeKind)) {
        await this.restore(owner, current, kind);
      }
      return;
    }
    let publication: MiniAppPublish;
    try { publication = await this.publication(owner, kind, input.bookkeepingHtml, input.agentTeamHtml); }
    catch (error) {
      if (!current) await this.deps.apps.publish(owner, this.draft(kind, this.availableSlug(apps, kind), input.agentTeamHtml), undefined,
        kind === "agent-team" && !!input.agentTeamHtml);
      throw error;
    }
    if (current && !publication.bindings.length && current.app.status === "active") return;
    publication.slug = current?.app.slug ?? this.availableSlug(apps, kind);
    publication.title = current ? updatedDefaultAppTitle(kind, current.app.title) : publication.title;
    publication.description = current?.app.description ?? publication.description;
    publication.expectedRevision = current?.app.revision ?? 0;
    await this.deps.apps.publish(owner, publication, current?.app.id, kind === "agent-team" && !!input.agentTeamHtml);
  }

  private waiting(document: MiniAppDocument, kind: DefaultMiniAppKind): boolean {
    return kind !== "hongguo" && kind !== "mojo" && !nativeKind(kind) && !document.bindings.length && !document.app.publisherBotIds.length
      && matchesPendingDefaultHtml(kind, document.html);
  }

  private availableSlug(apps: MiniAppSummary[], kind: DefaultMiniAppKind): string {
    const base = DEFAULT_APPS[kind].slug;
    if (!apps.some((app) => app.slug === base)) return base;
    for (let suffix = 1; suffix <= apps.length + 1; suffix++) {
      const slug = `${base}-included-${suffix}`;
      if (!apps.some((app) => app.slug === slug)) return slug;
    }
    throw appFailure(409, "No app name is available.");
  }

  private draft(kind: DefaultMiniAppKind, slug: string = DEFAULT_APPS[kind].slug, agentTeamHtml?: string): MiniAppPublish {
    return { ...DEFAULT_APPS[kind], slug, requestKey: randomUUID(), expectedRevision: 0,
      html: kind === "agent-team" && agentTeamHtml ? agentTeamHtml
        : nativeKind(kind) || kind === "hongguo" ? NATIVE_DEFAULT_HTML : pendingDefaultHtml(kind), bindings: [], publisherBotIds: [],
      ...(kind === "agent-team" || kind === "usage" ? { dashboardKind: kind }
        : kind === "hongguo" ? { nativeKind: kind } : { shippedTemplateKind: kind }) };
  }

  private async restore(owner: MiniAppActor, current: MiniAppDocument, kind: DefaultMiniAppKind): Promise<void> {
    await this.deps.apps.publish(owner, { requestKey: randomUUID(), expectedRevision: current.app.revision,
      slug: current.app.slug, title: current.app.title, description: current.app.description, html: current.html,
      bindings: current.bindings, publisherBotIds: current.app.publisherBotIds.filter((id) => this.deps.bots().some((bot) => bot.id === id)),
      ...(kind === "agent-team" || kind === "usage" ? { dashboardKind: kind }
        : kind === "hongguo" ? { nativeKind: kind } : { shippedTemplateKind: kind }) }, current.app.id);
  }

  private async publication(owner: MiniAppActor, kind: DefaultMiniAppKind, bookkeepingHtml: string, agentTeamHtml?: string): Promise<MiniAppPublish> {
    if (kind === "agent-team" || kind === "usage" || kind === "hongguo" || kind === "mojo") return this.draft(kind, undefined, agentTeamHtml);
    if (kind === "bookkeeping") {
      const source = await existingBookkeepingSource(this.deps.data, this.deps.bots().map((bot) => bot.id), owner.assertActive);
      if (!source) return this.draft(kind);
      return { ...createBookkeepingPublish({ ...source, html: bookkeepingHtml, requestKey: randomUUID(), title: DEFAULT_APPS.bookkeeping.title }),
        shippedTemplateKind: kind };
    }
    const routine = this.reportRoutine(kind);
    if (!routine) return this.draft(kind);
    owner.assertActive();
    const prepared = await this.deps.reports.prepare(routine.botId, kind);
    owner.assertActive();
    const current = this.reportRoutine(kind);
    if (!current || current.id !== routine.id || current.botId !== routine.botId) {
      throw appFailure(409, "The report Automation changed while its app was being prepared. Open it again.");
    }
    return { ...prepared.publication, requestKey: randomUUID(), publisherBotIds: [current.botId], shippedTemplateKind: kind };
  }

  private reportRoutine(kind: ReportKind): Routine | null {
    const matches = this.deps.routines()?.listRoutines().filter((routine) => routine.enabled && routine.target === "bot"
      && routine.runOn === "maus" && this.deps.bots().some((bot) => bot.id === routine.botId) && reportKindForRoutine(routine) === kind) ?? [];
    if (new Set(matches.map((routine) => routine.botId)).size > 1) {
      throw appFailure(409, "More than one Bot produces this report. Ask your report Bot to identify the main source.");
    }
    return matches[0] ?? null;
  }
}
