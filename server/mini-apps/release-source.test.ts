import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as DuckDB from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalUsageResponse } from "../../shared/local-dashboard.ts";
import type { MiniAppPublish, MiniAppReleaseManifestV1, MiniAppSummary } from "../../shared/mini-apps.ts";
import { reportMiniAppBinding } from "../../shared/report-mini-app.ts";
import { createReportTemplate } from "../../shared/report-mini-app-template.ts";
import { AppDocs } from "../app-docs.ts";
import { DATA_DIR } from "../config.ts";
import { createDataEngine } from "../data/engine.ts";
import { resetPathCacheForTests } from "../env-path.ts";
import { closeMessageDb } from "../message-db.ts";
import { ADOPTABLE_LEGACY_TEMPLATE_SHA256, MOJO_LEGACY_HTML_SHA256 } from "./default-template-history.ts";
import type { LocalDashboardProviders } from "../routes/local-dashboard.ts";
import { NATIVE_DEFAULT_HTML } from "./default-documents.ts";
import { DefaultMiniApps } from "./defaults.ts";
import { MiniApps, type MiniAppActor } from "./registry.ts";
import { ReportStore } from "./report-store.ts";
import {
  ADOPTABLE_AGENT_TEAM_HTML_SHA256, createFixtureFileReader, defaultMiniAppReleaseReader,
  GhMiniAppReleaseReader, isCustomAppTemplate, miniAppReleaseMapping, MiniAppReleaseSource,
  type MiniAppReleaseDescriptor, type MiniAppReleaseReader, type MiniAppReleaseSummary,
} from "./release-source.ts";

const SHA_45 = "ff735189522a871f645b7942b9040d466b074b7b14033bb672c2f8d7b07a4c74";
const SHA_48 = "7d9eb03023d99600b052840a6adef3ec95552f31a4aa0d2bc2ec104795256a94";
const COMMIT_A = "81253883c34a1d4ca829fa907ee0514156b780d7";
const COMMIT_B = "99993883c34a1d4ca829fa907ee0514156b780d9";
const owner: MiniAppActor = { writeAllowed: true, assertActive: () => undefined, canBind: () => true };
const bot = (botId = "publisher"): MiniAppActor => ({ ...owner, botId });

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function makeQueriesJson(dataSlots: unknown[] = []): string {
  return JSON.stringify({
    contractVersion: "0.1-draft",
    dataSlots,
  });
}

interface SyntheticReleaseSpec {
  tagName: string;
  tagCommitSha?: string;
  targetCommitish?: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  assets: Record<string, Uint8Array | { bytes: Uint8Array; reportedSize?: number }>;
}

function buildValidRelease(params: {
  slug?: string;
  packageId?: string;
  appVersion: string;
  sourceCommit?: string;
  tagCommitSha?: string;
  targetCommitish?: string;
  requires?: string[];
  html?: string;
  queries?: string;
}): SyntheticReleaseSpec {
  const slug = params.slug ?? "agent-team";
  const packageId = params.packageId ?? "mashellhan.agent-team";
  const sourceCommit = params.sourceCommit ?? COMMIT_A;
  const html = params.html ?? `<!doctype html><html><meta charset="utf-8"><body><h1>Agent Team v${params.appVersion}</h1></body></html>`;
  const queries = params.queries ?? makeQueriesJson([]);
  const htmlBytes = Buffer.from(html, "utf8");
  const queriesBytes = Buffer.from(queries, "utf8");
  const manifest: MiniAppReleaseManifestV1 = {
    formatVersion: 1,
    packageId,
    appVersion: params.appVersion,
    sourceCommit,
    requires: params.requires ?? ["agent-team-v1"],
    artifacts: {
      "index.html": { bytes: htmlBytes.byteLength, sha256: sha256(htmlBytes) },
      "queries.json": { bytes: queriesBytes.byteLength, sha256: sha256(queriesBytes) },
    },
  };
  return {
    tagName: `mini-app/${slug}/v${params.appVersion}`,
    tagCommitSha: params.tagCommitSha ?? sourceCommit,
    ...(params.targetCommitish !== undefined ? { targetCommitish: params.targetCommitish } : { targetCommitish: "main" }),
    assets: {
      "manifest.json": Buffer.from(JSON.stringify(manifest), "utf8"),
      "index.html": htmlBytes,
      "queries.json": queriesBytes,
    },
  };
}

function syntheticReader(releases: SyntheticReleaseSpec[], options: {
  beforeReadAsset?: (assetName: string) => Promise<void>;
  fail?: Error;
} = {}): MiniAppReleaseReader {
  const bytesOf = (value: Uint8Array | { bytes: Uint8Array; reportedSize?: number }) =>
    value instanceof Uint8Array ? value : value.bytes;
  return {
    async listReleases(_repo, slug): Promise<MiniAppReleaseSummary[]> {
      if (options.fail) throw options.fail;
      return releases
        .filter((r) => !r.isDraft && !r.isPrerelease && r.tagName.startsWith(`mini-app/${slug}/v`))
        .map((r) => ({ tagName: r.tagName, isDraft: Boolean(r.isDraft), isPrerelease: Boolean(r.isPrerelease) }));
    },
    async viewRelease(_repo, tagName): Promise<MiniAppReleaseDescriptor | null> {
      if (options.fail) throw options.fail;
      const found = releases.find((r) => r.tagName === tagName);
      if (!found) return null;
      return {
        tagName: found.tagName,
        tagCommitSha: found.tagCommitSha ?? found.targetCommitish ?? COMMIT_A,
        ...(found.targetCommitish ? { targetCommitish: found.targetCommitish } : {}),
        isDraft: Boolean(found.isDraft),
        isPrerelease: Boolean(found.isPrerelease),
        assets: Object.entries(found.assets).map(([name, val]) => ({
          name,
          size: val instanceof Uint8Array ? val.byteLength : (val.reportedSize ?? val.bytes.byteLength),
        })),
      };
    },
    async readAsset(_repo, tagName, assetName, maxBytes): Promise<Uint8Array> {
      if (options.fail) throw options.fail;
      if (options.beforeReadAsset) await options.beforeReadAsset(assetName);
      const found = releases.find((r) => r.tagName === tagName);
      const entry = found?.assets[assetName];
      if (!entry) throw new Error(`Missing asset ${assetName}`);
      const buf = bytesOf(entry);
      if (buf.byteLength > maxBytes) throw Object.assign(new Error("Too large"), { status: 413 });
      return buf;
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

function createRegistryFixture(reader: MiniAppReleaseReader, dashboardProviders?: LocalDashboardProviders) {
  const root = mkdtempSync(join(tmpdir(), "omb-release-source-"));
  const database = new DatabaseSync(join(root, "registry.db"));
  const publishers = new Set(["publisher"]);
  const write = <T>(work: (db: DatabaseSync) => T): T => work(database);
  const data = createDataEngine({
    dataDir: root,
    botFolder: (id) => join(root, "bots", id),
    binding: DuckDB,
    catalog: { getDatabase: () => database, withWrite: write },
  });
  const docs = new AppDocs(join(root, "docs"));
  const releaseSource = new MiniAppReleaseSource({ reader });
  const apps = new MiniApps({
    docs,
    data,
    validPublisher: (id) => publishers.has(id),
    access: { database: () => database, write },
    releaseSource,
    dashboardProviders,
  });
  cleanups.push(async () => {
    await data.closeAll();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { apps, data, docs, database, publishers, root };
}

function agentTeamInstall(extra: Partial<MiniAppPublish> = {}): MiniAppPublish {
  return {
    requestKey: "install",
    expectedRevision: 0,
    slug: "agent-team",
    title: "Agent Team",
    description: "Teams and activity.",
    html: readFileSync(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8"),
    bindings: [],
    dashboardKind: "agent-team",
    ...extra,
  };
}

describe("managed Mini App authorization", () => {
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it("retains the installed Agent Team resources when activating or rolling back a package", async () => {
    const { apps, database } = createRegistryFixture(syntheticReader([buildValidRelease({ appVersion: "1.0.0" })]));
    const { app: narrow } = await apps.publish(owner, agentTeamInstall({ html: NATIVE_DEFAULT_HTML }));
    const { app: detailed } = await apps.publish(owner, agentTeamInstall({ slug: "agent-team-with-details" }), undefined, true);
    const { appVersion, sourceCommit } = { appVersion: "1.0.0", sourceCommit: COMMIT_A };
    for (const installed of [narrow, detailed]) {
      const { app } = await apps.applyUpdate(owner, installed.id, { appVersion, sourceCommit, expectedRevision: 1, requestKey: "apply" });
      expect(app.dashboard).toMatchObject({ renderer: "html", resources: installed.dashboard!.resources });
      expect(app.release?.previousTemplateVersion).toBe(1);
      if (installed === narrow) {
        await expect(apps.dashboardRead(owner, app.id, { resource: "configuration", expectedRevision: app.revision,
          agentId: "w6:p1", occupantId: "o1234567890abcdef" })).rejects.toMatchObject({ status: 403 });
      }
      const { app: restored } = await apps.rollback(owner, app.id, { templateVersion: 1, expectedRevision: app.revision, requestKey: "restore" });
      expect(restored.dashboard).toEqual(installed.dashboard);
    }
    database.prepare("UPDATE mini_app_versions SET dashboard_html = 0 WHERE app_id = ? AND version = 1").run(detailed.id);
    const { app: fallback } = await apps.rollback(owner, detailed.id, { templateVersion: 1, expectedRevision: 3, requestKey: "native-fallback" });
    expect(fallback.dashboard).toMatchObject({ renderer: "native", resources: ["teams", "activity"] });
    const { app: migrated } = await apps.applyUpdate(owner, detailed.id, { appVersion, sourceCommit, expectedRevision: fallback.revision, requestKey: "migrate-again" });
    expect(migrated.dashboard).toEqual(detailed.dashboard);
    const { app: revoked } = await apps.publish(owner, agentTeamInstall({ slug: detailed.slug, dashboardKind: null, requestKey: "revoke", expectedRevision: migrated.revision }), detailed.id);
    const { app: restored } = await apps.rollback(owner, detailed.id, { templateVersion: 2, expectedRevision: revoked.revision, requestKey: "restore-released" });
    expect(restored.dashboard).toBeNull();
  });

  it("preserves current owner metadata and declines managed rollback across different Data bindings", async () => {
    const { datasetId: _datasetId, ...report } = reportMiniAppBinding("", "x_ai_digest");
    const release = buildValidRelease({ slug: "x-ai-digest", packageId: "mashellhan.x-ai-digest", appVersion: "1.0.0", requires: ["daily-x-site-v1"],
      queries: makeQueriesJson([report]) });
    const { apps, data } = createRegistryFixture(syntheticReader([release]));
    const reports = new ReportStore(data, createReportTemplate);
    const first = await reports.prepare("publisher", "x_ai_digest");
    const second = await reports.prepare("secondary", "x_ai_digest");
    const { app: installed } = await apps.publish(owner, { ...first.publication, shippedTemplateKind: "x_ai_digest" });
    const { app: before } = await apps.publish(owner, { ...second.publication, requestKey: "rebind", expectedRevision: 1 }, installed.id);
    const { app: applied } = await apps.applyUpdate(owner, installed.id, { appVersion: "1.0.0", sourceCommit: COMMIT_A,
      expectedRevision: before.revision, requestKey: "apply" });
    expect(applied.release?.previousTemplateVersion).toBe(before.templateVersion);
    const current = apps.document(owner, installed.id);
    await expect(apps.rollback(owner, installed.id, { templateVersion: installed.templateVersion,
      expectedRevision: applied.revision, requestKey: "wrong-binding" })).rejects.toMatchObject({ status: 409 });
    expect(apps.document(owner, installed.id)).toEqual(current);
    const { app: renamed } = await apps.publish(owner, { ...second.publication, html: current.html, title: "My current title", description: "My current description",
      requestKey: "rename", expectedRevision: applied.revision }, installed.id);
    const { app: restored } = await apps.rollback(owner, installed.id, { templateVersion: before.templateVersion,
      expectedRevision: renamed.revision, requestKey: "restore" });
    expect(restored).toMatchObject({ title: renamed.title, description: renamed.description, templateVersion: before.templateVersion, release: null });
    expect(apps.document(owner, installed.id).bindings).toEqual(second.publication.bindings);
    const { app: rebound } = await apps.publish(owner, { ...first.publication, requestKey: "rebind-again", expectedRevision: restored.revision }, installed.id);
    await expect(apps.rollback(owner, installed.id, { templateVersion: applied.templateVersion, expectedRevision: rebound.revision,
      requestKey: "restore-managed-to-wrong-binding" })).rejects.toMatchObject({ status: 409 });
    await expect(apps.rollback(owner, installed.id, { templateVersion: before.templateVersion, expectedRevision: rebound.revision,
      requestKey: "restore-stock-to-wrong-binding" })).rejects.toMatchObject({ status: 409 });
    expect(apps.document(owner, installed.id).bindings).toEqual(first.publication.bindings);
  });
});

describe("Activities versioned capability", () => {
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it("applies the exact package, reads owner usage, rolls back, and does not restore a revoked grant", async () => {
    const snapshot: LocalUsageResponse = { status: "unavailable", asOf: null, timeZone: "Asia/Shanghai",
      sourceCoverage: null, prSourceCoverage: null, prCoverage: null, windows: null, trend: [] };
    const unused = async () => { throw new Error("Unrelated dashboard provider"); };
    const getUsage = vi.fn(async () => snapshot);
    const dashboardProviders: LocalDashboardProviders = {
      usage: { get: getUsage }, agents: { get: unused }, activity: { get: unused },
      configuration: { getAgent: unused, getTeamRules: unused, getSkill: unused },
    };
    const html = "<!doctype html><html><body><h1>Activities</h1></body></html>";
    const baseRelease = { slug: "work-tracker", packageId: "mashellhan.work-tracker", html };
    const valid = buildValidRelease({ ...baseRelease, appVersion: "0.1.0", requires: ["usage-v1"] });
    const undeclared = buildValidRelease({ ...baseRelease, appVersion: "0.1.1", requires: [] });
    const unrelated = buildValidRelease({ ...baseRelease, appVersion: "0.1.2", requires: ["agent-team-v1"] });
    const releases = [valid];
    const { apps } = createRegistryFixture(syntheticReader(releases), dashboardProviders);
    const install = { requestKey: "install-activities", expectedRevision: 0, slug: "usage", title: "My activity",
      description: "Local work metrics", html: NATIVE_DEFAULT_HTML, bindings: [], publisherBotIds: ["publisher"],
      responsibleBotId: "publisher", dashboardKind: "usage" };
    const { app } = await apps.publish(owner, install);
    expect(app.dashboard).toMatchObject({ kind: "usage", renderer: "native" });
    expect(await apps.checkUpdate(owner, app.id)).toMatchObject({ status: "available", available: { appVersion: "0.1.0" } });
    const input = { appVersion: "0.1.0", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "apply" };
    const applied = await apps.applyUpdate(owner, app.id, input);
    expect(applied.app).toMatchObject({ id: app.id, title: "My activity", description: install.description, revision: 2,
      publisherBotIds: ["publisher"], responsibleBotId: "publisher",
      dashboard: { kind: "usage", renderer: "html", resources: ["usage"] },
      release: { packageId: "mashellhan.work-tracker", requires: ["usage-v1"], htmlSha256: sha256(html) } });
    expect(await apps.applyUpdate(owner, app.id, input)).toEqual({ app: applied.app, replayed: true });
    expect(apps.document(owner, app.id)).toMatchObject({ html, bindings: [] });
    expect(await apps.state(owner, app.id)).toMatchObject({ data: [], templateVersion: 2 });
    await expect(apps.dashboardRead(owner, app.id, { resource: "usage", expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
    await expect(apps.dashboardRead(owner, app.id, { resource: "teams", expectedRevision: 2 })).rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(bot(), app.id, { resource: "usage", expectedRevision: 2 })).rejects.toMatchObject({ status: 403 });
    await expect(apps.dashboardRead(owner, app.id, { resource: "usage", expectedRevision: 2 }))
      .resolves.toEqual({ appId: app.id, revision: 2, resource: "usage", snapshot });
    expect(getUsage).toHaveBeenCalledOnce();

    for (const release of [undeclared, unrelated]) {
      releases.push(release);
      expect(await apps.checkUpdate(owner, app.id)).toMatchObject({ status: "incompatible" });
      const appVersion = release.tagName.split("/v").at(-1)!;
      await expect(apps.applyUpdate(owner, app.id, { ...input, expectedRevision: 2,
        appVersion, requestKey: `reject-${appVersion}` })).rejects.toMatchObject({ status: 409 });
    }
    const fallback = await apps.rollback(owner, app.id, { expectedRevision: 2, templateVersion: 1, requestKey: "fallback" });
    expect(fallback.app).toMatchObject({ id: app.id, dashboard: { renderer: "native" }, release: null });
    await apps.publish(owner, { ...install, dashboardKind: null, expectedRevision: 3, requestKey: "revoke" }, app.id);
    const reverted = await apps.rollback(owner, app.id, { expectedRevision: 4, templateVersion: 2, requestKey: "restore-released" });
    expect(reverted.app).toMatchObject({ dashboard: null, dashboardIdentity: "usage", release: { appVersion: "0.1.0" } });
    await expect(apps.dashboardRead(owner, app.id, { resource: "usage", expectedRevision: 5 })).rejects.toMatchObject({ status: 403 });
  });
});

describe("MiniAppReleaseSource and MiniApps release lifecycle", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
  });

  afterEach(async () => {
    resetPathCacheForTests();
    delete process.env.OMB_TEST_SEALED_PATH;
    delete process.env.OMB_EXTRA_PATH;
    for (const close of cleanups.splice(0)) await close();
  });

  it("adopts verified #45 and #48 Agent Team builds while blocking genuinely custom HTML and preserving grants", async () => {
    expect(ADOPTABLE_AGENT_TEAM_HTML_SHA256).toContain(SHA_45);
    expect(ADOPTABLE_AGENT_TEAM_HTML_SHA256).toContain(SHA_48);
    const opt45Path = process.env.OMB_TEST_AGENT_TEAM_45_HTML;
    const opt48Path = process.env.OMB_TEST_AGENT_TEAM_48_HTML;
    const fallbackReviewed = readFileSync(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8");
    const html45 = opt45Path && existsSync(opt45Path) ? readFileSync(opt45Path, "utf8") : fallbackReviewed;
    const html48 = opt48Path && existsSync(opt48Path) ? readFileSync(opt48Path, "utf8") : fallbackReviewed;
    if (opt45Path && existsSync(opt45Path)) expect(sha256(html45)).toBe(SHA_45);
    if (opt48Path && existsSync(opt48Path)) expect(sha256(html48)).toBe(SHA_48);

    const v011 = buildValidRelease({ appVersion: "0.1.1", sourceCommit: COMMIT_A });
    const v012 = buildValidRelease({ appVersion: "0.1.2", sourceCommit: COMMIT_B });
    const { apps } = createRegistryFixture(syntheticReader([v011, v012]));

    // 1. Legacy #45 install with publisher grant & custom title
    const app45 = (await apps.publish(owner, agentTeamInstall({
      requestKey: "install-45",
      slug: "agent-team-45",
      title: "Team #45",
      html: html45,
      publisherBotIds: ["publisher"],
    }))).app;
    expect(app45.release).toBeNull();
    expect(await apps.checkUpdate(owner, app45.id)).toEqual({
      installedVersion: null,
      status: "available",
      available: { appVersion: "0.1.2", sourceCommit: COMMIT_B },
    });
    const updated45 = await apps.applyUpdate(owner, app45.id, {
      appVersion: "0.1.1",
      sourceCommit: COMMIT_A,
      expectedRevision: 1,
      requestKey: "adopt-45",
    });
    expect(updated45.replayed).toBe(false);
    expect(updated45.app).toMatchObject({
      id: app45.id,
      slug: "agent-team-45",
      title: "Team #45",
      revision: 2,
      templateVersion: 2,
      publisherBotIds: ["publisher"],
      dashboard: { kind: "agent-team", renderer: "html", htmlRole: "primary" },
      release: {
        packageId: "mashellhan.agent-team",
        appVersion: "0.1.1",
        sourceCommit: COMMIT_A,
        tag: "mini-app/agent-team/v0.1.1",
      },
    });

    // 2. Legacy #48 install
    const app48 = (await apps.publish(owner, agentTeamInstall({
      requestKey: "install-48",
      title: "Team #48",
      html: html48,
      publisherBotIds: ["publisher"],
    }))).app;
    expect(await apps.checkUpdate(owner, app48.id)).toEqual({
      installedVersion: null,
      status: "available",
      available: { appVersion: "0.1.2", sourceCommit: COMMIT_B },
    });
    const updated48 = await apps.applyUpdate(owner, app48.id, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 1,
      requestKey: "adopt-48",
    });
    expect(updated48.app.release?.appVersion).toBe("0.1.2");
    expect(await apps.checkUpdate(owner, app48.id)).toEqual({
      installedVersion: "0.1.2",
      status: "current",
      available: null,
    });

    // Metadata-only edit preserves release provenance
    const renamed = await apps.publish(owner, {
      ...agentTeamInstall({
        requestKey: "rename-only",
        expectedRevision: 2,
        title: "Team #48 Renamed",
        html: apps.document(owner, app48.id).html,
        publisherBotIds: ["publisher"],
      }),
    }, app48.id);
    expect(renamed.app.release?.appVersion).toBe("0.1.2");
    expect(await apps.checkUpdate(owner, app48.id)).toEqual({
      installedVersion: "0.1.2",
      status: "current",
      available: null,
    });

    // 3. Genuine custom HTML edit is blocked ("custom") and grants are preserved
    const customApp = (await apps.publish(owner, agentTeamInstall({
      requestKey: "install-custom",
      slug: "agent-team-custom",
      html: "<!doctype html><html><body><h1>My custom team edit</h1></body></html>",
      publisherBotIds: ["publisher"],
    }))).app;
    expect(await apps.checkUpdate(owner, customApp.id)).toEqual({
      installedVersion: null,
      status: "custom",
      available: null,
    });
    await expect(apps.applyUpdate(owner, customApp.id, {
      appVersion: "0.1.2",
      sourceCommit: COMMIT_B,
      expectedRevision: 1,
      requestKey: "overwrite-custom",
    })).rejects.toMatchObject({ status: 409 });

    // Custom HTML edit after adopting release clears release provenance and marks app custom
    const customizedAfter = await apps.publish(owner, agentTeamInstall({
      requestKey: "customize-after",
      expectedRevision: 3,
      title: "Team #48 Renamed",
      html: "<!doctype html><html><body><h1>Owner custom page</h1></body></html>",
      publisherBotIds: ["publisher"],
    }), app48.id);
    expect(customizedAfter.app.release).toBeNull();
    expect(await apps.checkUpdate(owner, app48.id)).toEqual({
      installedVersion: null,
      status: "custom",
      available: null,
    });

    // Rollback to version 2 (0.1.2) restores provenance and version 1 (#48) keeps adoptability, preserving grants
    const rolledBackTo012 = await apps.rollback(owner, app48.id, {
      requestKey: "rollback-to-012",
      expectedRevision: 4,
      templateVersion: 2,
    });
    expect(rolledBackTo012.app.release?.appVersion).toBe("0.1.2");
    expect(rolledBackTo012.app.publisherBotIds).toEqual(["publisher"]);
    expect(rolledBackTo012.app.dashboard).toMatchObject({ kind: "agent-team", renderer: "html" });

    const rolledBackTo48 = await apps.rollback(owner, app48.id, {
      requestKey: "rollback-to-48",
      expectedRevision: 5,
      templateVersion: 1,
    });
    expect(rolledBackTo48.app.release).toBeNull();
    expect(rolledBackTo48.app.publisherBotIds).toEqual(["publisher"]);
    expect(await apps.checkUpdate(owner, app48.id)).toEqual({
      installedVersion: null,
      status: "available",
      available: { appVersion: "0.1.2", sourceCommit: COMMIT_B },
    });
  });

  it("prevents DefaultMiniApps from overwriting independently managed releases", async () => {
    const v011 = buildValidRelease({ appVersion: "0.1.1", sourceCommit: COMMIT_A });
    const { apps, data } = createRegistryFixture(syntheticReader([v011]));
    const defaults = new DefaultMiniApps({
      apps,
      data,
      bots: () => [{ id: "publisher" }],
      routines: () => ({ listRoutines: () => [] }),
      reports: new ReportStore(data, createReportTemplate),
    });
    const reviewedHtml = readFileSync(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8");
    const bookkeepingHtml = readFileSync(new URL("../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");
    const ensured = await defaults.ensure(owner, { bookkeepingHtml, agentTeamHtml: reviewedHtml });
    const team = ensured.apps.find((a) => a.dashboardIdentity === "agent-team")!;
    const updated = await apps.applyUpdate(owner, team.id, {
      appVersion: "0.1.1",
      sourceCommit: COMMIT_A,
      expectedRevision: team.revision,
      requestKey: "upgrade-team",
    });
    expect(updated.app.release?.appVersion).toBe("0.1.1");

    // Re-running defaults.ensure must keep the independently managed release unchanged
    const afterDefaults = await defaults.ensure(owner, { bookkeepingHtml, agentTeamHtml: reviewedHtml });
    const teamAfter = afterDefaults.apps.find((a) => a.id === team.id)!;
    expect(teamAfter).toEqual(updated.app);
    expect(apps.document(owner, team.id).html).toBe(Buffer.from(v011.assets["index.html"] as Uint8Array).toString("utf8"));
  });

  it("enforces negative cases: bad digest, wrong packageId, bounds, incompatible capabilities, offline, idempotency, concurrency, revoked grant, archived/custom", async () => {
    // 1. Bad digest
    const badDigest = buildValidRelease({ appVersion: "0.1.1" });
    badDigest.assets["index.html"] = Buffer.from("<!doctype html><html><body>tampered</body></html>", "utf8");
    {
      const { apps } = createRegistryFixture(syntheticReader([badDigest]));
      const { app } = await apps.publish(owner, agentTeamInstall());
      expect(await apps.checkUpdate(owner, app.id)).toEqual({ installedVersion: null, status: "unavailable", available: null });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "bad-digest",
      })).rejects.toMatchObject({ status: 422 });
    }

    // 2. Wrong packageId
    const wrongPkg = buildValidRelease({ appVersion: "0.1.1", packageId: "mashellhan.bookkeeping" });
    {
      const { apps } = createRegistryFixture(syntheticReader([wrongPkg]));
      const { app } = await apps.publish(owner, agentTeamInstall());
      expect(await apps.checkUpdate(owner, app.id)).toEqual({ installedVersion: null, status: "unavailable", available: null });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "wrong-pkg",
      })).rejects.toMatchObject({ status: 422 });
    }

    // 3. Size bounds (HTML > 512 KiB and manifest > 16 KiB)
    const bigHtml = buildValidRelease({ appVersion: "0.1.1", html: "a".repeat(512 * 1024 + 1) });
    {
      const { apps } = createRegistryFixture(syntheticReader([bigHtml]));
      const { app } = await apps.publish(owner, agentTeamInstall());
      expect(await apps.checkUpdate(owner, app.id)).toEqual({ installedVersion: null, status: "unavailable", available: null });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "too-big",
      })).rejects.toMatchObject({ status: 413 });
    }
    const bigManifest = buildValidRelease({ appVersion: "0.1.1" });
    bigManifest.assets["manifest.json"] = Buffer.from(" ".repeat(16 * 1024 + 10), "utf8");
    {
      const { apps } = createRegistryFixture(syntheticReader([bigManifest]));
      const { app } = await apps.publish(owner, agentTeamInstall());
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "big-manifest",
      })).rejects.toMatchObject({ status: 413 });
    }

    // 4. Incompatible capabilities
    const incomp = buildValidRelease({ appVersion: "0.1.1", requires: ["agent-team-v1", "future-cap-v2"] });
    {
      const { apps } = createRegistryFixture(syntheticReader([incomp]));
      const { app } = await apps.publish(owner, agentTeamInstall());
      expect(await apps.checkUpdate(owner, app.id)).toEqual({
        installedVersion: null,
        status: "incompatible",
        available: { appVersion: "0.1.1", sourceCommit: COMMIT_A },
      });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "incomp",
      })).rejects.toMatchObject({ status: 409 });
    }

    // 5. Non-empty dataSlots for Agent Team rejected
    const badSlots = buildValidRelease({
      appVersion: "0.1.1",
      queries: makeQueriesJson([{ id: "slot", source: { schema: null, table: null }, fields: {}, queries: {} }]),
    });
    {
      const { apps } = createRegistryFixture(syntheticReader([badSlots]));
      const { app } = await apps.publish(owner, agentTeamInstall());
      expect(await apps.checkUpdate(owner, app.id)).toEqual({ installedVersion: null, status: "unavailable", available: null });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "bad-slots",
      })).rejects.toMatchObject({ status: 422 });
    }

    // 6. Offline / reader failure
    {
      const { apps } = createRegistryFixture(syntheticReader([], { fail: Object.assign(new Error("offline"), { status: 503 }) }));
      const { app } = await apps.publish(owner, agentTeamInstall());
      expect(await apps.checkUpdate(owner, app.id)).toEqual({ installedVersion: null, status: "unavailable", available: null });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "offline",
      })).rejects.toMatchObject({ status: 503 });
    }

    // 7. Repeat / idempotency, stale revision, concurrent requests, revoked grant, archived, bot access
    const v011 = buildValidRelease({ appVersion: "0.1.1", sourceCommit: COMMIT_A });
    const v012 = buildValidRelease({ appVersion: "0.1.2", sourceCommit: COMMIT_B });
    {
      let releaseGate!: () => void;
      let holdNextRead = false;
      const reader = syntheticReader([v011, v012], {
        beforeReadAsset: async (assetName) => {
          if (holdNextRead && assetName === "index.html") {
            holdNextRead = false;
            await new Promise<void>((resolve) => { releaseGate = resolve; });
          }
        },
      });
      const { apps } = createRegistryFixture(reader);
      const { app } = await apps.publish(owner, agentTeamInstall({ publisherBotIds: ["publisher"] }));

      // Bot cannot check or apply updates
      await expect(apps.checkUpdate(bot(), app.id)).rejects.toMatchObject({ status: 403 });
      await expect(apps.applyUpdate(bot(), app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "bot-try",
      })).rejects.toMatchObject({ status: 403 });

      // Idempotent replay & key collision & stale revision
      const first = await apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "req-1",
      });
      expect(first.replayed).toBe(false);
      expect(await apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "req-1",
      })).toEqual({ app: first.app, replayed: true });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.2", sourceCommit: COMMIT_B, expectedRevision: 1, requestKey: "req-1",
      })).rejects.toMatchObject({ status: 409 });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.2", sourceCommit: COMMIT_B, expectedRevision: 1, requestKey: "req-stale",
      })).rejects.toMatchObject({ status: 409 });

      // Concurrent requests: one paused in download while archive happens
      holdNextRead = true;
      const inFlight = apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.2", sourceCommit: COMMIT_B, expectedRevision: 2, requestKey: "req-race",
      });
      await vi.waitFor(() => expect(releaseGate).toBeTypeOf("function"));
      apps.archive(owner, app.id, { requestKey: "archive-race", expectedRevision: 2 });
      releaseGate();
      await expect(inFlight).rejects.toMatchObject({ status: 409 });
      expect(apps.document(owner, app.id).app).toMatchObject({ status: "archived", revision: 3 });
      expect(await apps.checkUpdate(owner, app.id)).toEqual({
        installedVersion: "0.1.1",
        status: "unavailable",
        available: null,
      });

      // Restore via rollback and test revoked built-in grant
      await apps.rollback(owner, app.id, { requestKey: "restore", expectedRevision: 3, templateVersion: 2 });
      const regranted = await apps.publish(owner, agentTeamInstall({
        requestKey: "revoke-grant",
        expectedRevision: 4,
        html: apps.document(owner, app.id).html,
        dashboardKind: null,
      }), app.id);
      expect(regranted.app.dashboard).toBeNull();
      expect(await apps.checkUpdate(owner, app.id)).toEqual({
        installedVersion: "0.1.1",
        status: "unavailable",
        available: null,
      });
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.2", sourceCommit: COMMIT_B, expectedRevision: 5, requestKey: "revoked-apply",
      })).rejects.toMatchObject({ status: 403 });
    }
  });

  it("verifies GhMiniAppReleaseReader resolves exact lightweight tag refs, strips env tokens, enforces MashellHan identity, and fails closed", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "omb-fake-gh-"));
    cleanups.push(async () => { rmSync(binDir, { recursive: true, force: true }); });
    const fakeGh = join(binDir, "gh");
    const stateFile = join(binDir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ login: "MashellHan" }));
    writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_HOST || process.env.GH_CONFIG_DIR) {
  process.stderr.write("leaked env");
  process.exit(9);
}
if (args[0] === "api" && args.includes("user")) {
  process.stdout.write(state.login + "\\n");
  process.exit(0);
}
if (args[0] === "api" && args[1] === "repos/MashellHan/mymausbotminiapps/git/ref/tags/mini-app/agent-team/v0.1.1") {
  process.stdout.write(JSON.stringify({
    ref: state.refName || "refs/tags/mini-app/agent-team/v0.1.1",
    object: {
      type: state.refType || "commit",
      sha: state.tagCommitSha || "${COMMIT_A}",
    },
  }));
  process.exit(0);
}
if (args[0] === "release" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{ tagName: "mini-app/agent-team/v0.1.1", isDraft: false, isPrerelease: false }]));
  process.exit(0);
}
if (args[0] === "release" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    tagName: "mini-app/agent-team/v0.1.1",
    ...(state.omitTargetCommitish ? {} : { targetCommitish: state.targetCommitish || "main" }),
    isDraft: false,
    isPrerelease: false,
    assets: [{ name: "manifest.json", size: 10 }, { name: "index.html", size: 10 }, { name: "queries.json", size: 10 }],
  }));
  process.exit(0);
}
if (args[0] === "release" && args[1] === "download") {
  if (state.oversize) {
    process.stdout.write("x".repeat(200));
    process.exit(0);
  }
  process.stdout.write("hello");
  process.exit(0);
}
process.exit(1);
`);
    chmodSync(fakeGh, 0o755);

    process.env.OMB_TEST_SEALED_PATH = "1";
    process.env.OMB_EXTRA_PATH = binDir;
    process.env.GH_TOKEN = "should-be-stripped";
    process.env.GITHUB_TOKEN = "should-be-stripped";
    process.env.GH_CONFIG_DIR = "/tmp/bad";
    resetPathCacheForTests();

    try {
      const reader = new GhMiniAppReleaseReader({ timeoutMs: 5000 });
      expect(await reader.listReleases("MashellHan/mymausbotminiapps", "agent-team")).toEqual([
        { tagName: "mini-app/agent-team/v0.1.1", isDraft: false, isPrerelease: false },
      ]);
      // targetCommitish is "main" or omitted, yet exact lightweight tag ref resolves to COMMIT_A
      expect(await reader.viewRelease("MashellHan/mymausbotminiapps", "mini-app/agent-team/v0.1.1")).toMatchObject({
        tagName: "mini-app/agent-team/v0.1.1",
        tagCommitSha: COMMIT_A,
        targetCommitish: "main",
      });
      writeFileSync(stateFile, JSON.stringify({ login: "MashellHan", omitTargetCommitish: true }));
      expect(await reader.viewRelease("MashellHan/mymausbotminiapps", "mini-app/agent-team/v0.1.1")).toMatchObject({
        tagName: "mini-app/agent-team/v0.1.1",
        tagCommitSha: COMMIT_A,
      });

      // Annotated tag (object.type !== "commit") fails closed
      writeFileSync(stateFile, JSON.stringify({ login: "MashellHan", refType: "tag" }));
      await expect(reader.viewRelease("MashellHan/mymausbotminiapps", "mini-app/agent-team/v0.1.1"))
        .rejects.toMatchObject({ status: 422 });

      // Mismatched ref name fails closed
      writeFileSync(stateFile, JSON.stringify({ login: "MashellHan", refName: "refs/tags/mini-app/agent-team/v0.1.2" }));
      await expect(reader.viewRelease("MashellHan/mymausbotminiapps", "mini-app/agent-team/v0.1.1"))
        .rejects.toMatchObject({ status: 422 });

      writeFileSync(stateFile, JSON.stringify({ login: "MashellHan" }));
      expect(Buffer.from(await reader.readAsset("MashellHan/mymausbotminiapps", "mini-app/agent-team/v0.1.1", "manifest.json", 100)).toString("utf8")).toBe("hello");

      // Mismatched tagCommitSha vs manifest.sourceCommit fails closed even when targetCommitish is "main"
      const badTagCommit = buildValidRelease({
        appVersion: "0.1.1",
        sourceCommit: COMMIT_A,
        tagCommitSha: COMMIT_B,
        targetCommitish: "main",
      });
      const { apps: tagCheckApps } = createRegistryFixture(syntheticReader([badTagCommit]));
      const { app: tagApp } = await tagCheckApps.publish(owner, agentTeamInstall({ requestKey: "tag-app" }));
      expect(await tagCheckApps.checkUpdate(owner, tagApp.id)).toEqual({
        installedVersion: null, status: "unavailable", available: null,
      });
      await expect(tagCheckApps.applyUpdate(owner, tagApp.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "bad-tag-sha",
      })).rejects.toMatchObject({ status: 422 });

      // Oversized response rejected
      writeFileSync(stateFile, JSON.stringify({ login: "MashellHan", oversize: true }));
      await expect(reader.readAsset("MashellHan/mymausbotminiapps", "mini-app/agent-team/v0.1.1", "manifest.json", 50))
        .rejects.toMatchObject({ status: 413 });

      // Identity mismatch fails closed
      writeFileSync(stateFile, JSON.stringify({ login: "WrongUser" }));
      await expect(reader.listReleases("MashellHan/mymausbotminiapps", "agent-team"))
        .rejects.toMatchObject({ status: 503 });

      // Missing gh fails closed
      delete process.env.OMB_EXTRA_PATH;
      const savedPath = process.env.PATH;
      process.env.PATH = "";
      resetPathCacheForTests();
      try {
        await expect(reader.listReleases("MashellHan/mymausbotminiapps", "agent-team"))
          .rejects.toMatchObject({ status: 503 });
      } finally {
        process.env.PATH = savedPath;
      }
    } finally {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_CONFIG_DIR;
    }
  });

  it("disables synthetic release injection outside sealed fixtures, rejects UTF-8 BOM, enforces exact Mojo/legacy adoption, and preserves rolled-back custom defaults", async () => {
    const prevFixtureEnv = process.env.OMB_TEST_MINI_APP_RELEASES_FILE;
    const prevSealed = process.env.OMB_TEST_SEALED_PATH;
    process.env.OMB_TEST_MINI_APP_RELEASES_FILE = "/tmp/nonexistent-releases.json";
    delete process.env.OMB_TEST_SEALED_PATH;
    try {
      expect(defaultMiniAppReleaseReader()).toBeInstanceOf(GhMiniAppReleaseReader);
      expect(() => createFixtureFileReader("/tmp/nonexistent-releases.json")).toThrow("sealed test fixtures");
    } finally {
      if (prevFixtureEnv === undefined) delete process.env.OMB_TEST_MINI_APP_RELEASES_FILE;
      else process.env.OMB_TEST_MINI_APP_RELEASES_FILE = prevFixtureEnv;
      if (prevSealed === undefined) delete process.env.OMB_TEST_SEALED_PATH;
      else process.env.OMB_TEST_SEALED_PATH = prevSealed;
    }

    // UTF-8 BOM in index.html must be rejected so stored HTML matches raw SHA-256 verbatim
    const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<!doctype html><html><body>bom</body></html>", "utf8")]);
    const bomRelease = buildValidRelease({ appVersion: "0.1.1", sourceCommit: COMMIT_A });
    const bomManifest: MiniAppReleaseManifestV1 = {
      ...JSON.parse(Buffer.from(bomRelease.assets["manifest.json"] as Uint8Array).toString("utf8")) as MiniAppReleaseManifestV1,
      artifacts: {
        "index.html": { bytes: bomBytes.byteLength, sha256: sha256(bomBytes) },
        "queries.json": (JSON.parse(Buffer.from(bomRelease.assets["manifest.json"] as Uint8Array).toString("utf8")) as MiniAppReleaseManifestV1).artifacts["queries.json"],
      },
    };
    bomRelease.assets["manifest.json"] = Buffer.from(JSON.stringify(bomManifest), "utf8");
    bomRelease.assets["index.html"] = bomBytes;
    {
      const { apps } = createRegistryFixture(syntheticReader([bomRelease]));
      const { app } = await apps.publish(owner, agentTeamInstall({ requestKey: "bom-app" }));
      await expect(apps.applyUpdate(owner, app.id, {
        appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "apply-bom",
      })).rejects.toMatchObject({ status: 422 });
    }

    // Mojo marker alone is custom (not adoptable); documented legacy hash and inventory snapshot hashes are present
    const mojoApp: MiniAppSummary = {
      id: "01d8d54b-5b1c-4e8d-be21-e60aa6e42fc7",
      slug: "mojo",
      title: "Mojo",
      description: "",
      status: "active",
      revision: 1,
      templateVersion: 1,
      publisherBotIds: [],
      responsibleBotId: null,
      capabilities: [],
      dashboard: null,
      dashboardIdentity: null,
      nativeKind: null,
      nativeIdentity: null,
      shippedTemplateKind: null,
      release: null,
      createdAt: 1,
      updatedAt: 1,
    };
    const mojoMapping = miniAppReleaseMapping(mojoApp);
    expect(mojoMapping?.packageId).toBe("mashellhan.mojo");
    expect(isCustomAppTemplate(mojoApp, mojoMapping, '<meta name="openmausbot:mojo-view" content="quotes-v1"><p>fake</p>', [])).toBe(true);
    expect(MOJO_LEGACY_HTML_SHA256).toBe("c7e3e34ae380dc585c41e57588908cd48858c49c00118a372902d1d79e1356f6");
    expect(ADOPTABLE_LEGACY_TEMPLATE_SHA256.bookkeeping).toContain("6cab8df9d0c2d2d90694c0e3202a4a9075bed84260f48467e4a6e1991e1465ce");
    expect(ADOPTABLE_LEGACY_TEMPLATE_SHA256.x_ai_digest).toContain("a25effe6fffb0f09d6833a3dd9d4ed331be1d4a34cfd889af628428718b320d3");

    // DefaultMiniApps preserves rolled-back and subsequently custom-edited installs
    const v011 = buildValidRelease({ appVersion: "0.1.1", sourceCommit: COMMIT_A });
    const { apps, data } = createRegistryFixture(syntheticReader([v011]));
    const defaults = new DefaultMiniApps({
      apps,
      data,
      bots: () => [{ id: "publisher" }],
      routines: () => ({ listRoutines: () => [] }),
      reports: new ReportStore(data, createReportTemplate),
    });
    const reviewedHtml = readFileSync(new URL("../../examples/mini-apps/agent-team/index.html", import.meta.url), "utf8");
    const bookkeepingHtml = readFileSync(new URL("../../examples/mini-apps/bookkeeping/index.html", import.meta.url), "utf8");
    const ensured = await defaults.ensure(owner, { bookkeepingHtml, agentTeamHtml: reviewedHtml });
    const team = ensured.apps.find((a) => a.dashboardIdentity === "agent-team")!;
    const updated = await apps.applyUpdate(owner, team.id, {
      appVersion: "0.1.1",
      sourceCommit: COMMIT_A,
      expectedRevision: team.revision,
      requestKey: "upgrade-for-rollback",
    });
    const rolledBack = await apps.rollback(owner, team.id, {
      requestKey: "rollback-to-1",
      expectedRevision: updated.app.revision,
      templateVersion: 1,
    });
    const customHtml = "<!doctype html><html><body><h1>Owner custom after rollback</h1></body></html>";
    const customEdited = await apps.publish(owner, agentTeamInstall({
      requestKey: "custom-after-rollback",
      expectedRevision: rolledBack.app.revision,
      html: customHtml,
    }), team.id);
    expect(customEdited.app.release).toBeNull();
    await defaults.ensure(owner, { bookkeepingHtml, agentTeamHtml: reviewedHtml });
    expect(apps.document(owner, team.id).html).toBe(customHtml);

    // Aborted request after release read must not write doc or advance revision
    const abort = new AbortController();
    const abortReader = syntheticReader([v011], {
      beforeReadAsset: async (assetName) => {
        if (assetName === "queries.json") abort.abort();
      },
    });
    const { apps: abortApps } = createRegistryFixture(abortReader);
    const { app: abortApp } = await abortApps.publish(owner, agentTeamInstall({ requestKey: "abort-app" }));
    await expect(abortApps.applyUpdate(owner, abortApp.id, {
      appVersion: "0.1.1", sourceCommit: COMMIT_A, expectedRevision: 1, requestKey: "abort-apply",
    }, abort.signal)).rejects.toMatchObject({ status: 503 });
    expect(abortApps.document(owner, abortApp.id).app.revision).toBe(1);
    expect(abortApps.document(owner, abortApp.id).versions).toHaveLength(1);
  });
});
