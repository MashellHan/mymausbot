import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import { LEGACY_MINI_APP_IDS, matchesMiniAppReleasePackage, miniAppReleasePackage } from "../../shared/mini-app-release-packages.ts";
import {
  MINI_APP_RELEASE_ASSETS, MINI_APP_RELEASE_BOUNDS, MINI_APP_RELEASE_REPO,
  type DefaultMiniAppKind, type MiniAppReleaseManifestV1, type MiniAppReleaseProvenance,
  type MiniAppReleaseQueriesFile, type MiniAppSummary, type MiniAppUpdateCheckResult,
} from "../../shared/mini-apps.ts";
import { findCliCandidates, sealedFixture, whichWin } from "../env-path.ts";
import { matchesPendingDefaultHtml, NATIVE_DEFAULT_HTML } from "./default-documents.ts";
import {
  ADOPTABLE_LEGACY_TEMPLATE_SHA256, AGENT_TEAM_NATIVE_PLACEHOLDER_SHA256, GITHUB_ACTIVITY_CATALOG_TEMPLATE_SHA256,
  MOJO_LEGACY_HTML_SHA256, REVIEWED_AGENT_TEAM_HTML_SHA256, SHIPPED_TEMPLATE_SHA256,
} from "./default-template-history.ts";
import { bundledBookkeepingBinding } from "./default-updates.ts";
import { hasReportBindingForProducer } from "./report-apps.ts";
import { acceptsOptionalDailyXEditorial, bookkeepingReleaseQueriesMatch, reportReleaseQueriesMatch } from "./report-release-bindings.ts";
import {
  appFailure, bindingFieldSchema, bindingNameSchema, COMMIT_SHA_RE, namedQuerySchema,
  SEMVER_3_RE, sourceNameSchema,
} from "./validation.ts";

const TRUSTED_GH_HOST = "github.com";
const TRUSTED_GH_LOGIN = "MashellHan";
const NATIVE_DEFAULT_HTML_SHA256 = createHash("sha256").update(NATIVE_DEFAULT_HTML).digest("hex");
/** Verified official Agent Team HTML builds installed via owner publish before independent release provenance (#45 and #48). */
export const ADOPTABLE_AGENT_TEAM_HTML_SHA256: readonly string[] = [
  ...AGENT_TEAM_NATIVE_PLACEHOLDER_SHA256,
  REVIEWED_AGENT_TEAM_HTML_SHA256,
  "ff735189522a871f645b7942b9040d466b074b7b14033bb672c2f8d7b07a4c74",
  "7d9eb03023d99600b052840a6adef3ec95552f31a4aa0d2bc2ec104795256a94",
];
const HEX_64_RE = /^[0-9a-f]{64}$/;
const PACKAGE_ID_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const RELEASE_TAG_RE = /^mini-app\/[a-z0-9-]+\/v\d+\.\d+\.\d+$/;
const GH_DEFAULT_TIMEOUT_MS = 15_000;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface MiniAppReleaseSummary {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

export interface MiniAppReleaseAsset {
  name: string;
  size: number;
}

export interface MiniAppReleaseDescriptor extends MiniAppReleaseSummary {
  tagCommitSha: string;
  targetCommitish?: string;
  assets: MiniAppReleaseAsset[];
}

/** Injectable GitHub release transport used by MiniAppReleaseSource; tests supply synthetic implementations. */
export interface MiniAppReleaseReader {
  listReleases(repo: string, slug: string, signal?: AbortSignal): Promise<MiniAppReleaseSummary[]>;
  viewRelease(repo: string, tagName: string, signal?: AbortSignal): Promise<MiniAppReleaseDescriptor | null>;
  readAsset(repo: string, tagName: string, assetName: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface MiniAppReleaseMapping {
  packageId: string;
  releaseSlug: string;
  kind: DefaultMiniAppKind;
}

export interface VerifiedMiniAppRelease {
  manifest: MiniAppReleaseManifestV1;
  provenance: MiniAppReleaseProvenance;
  html: string;
  queries: MiniAppReleaseQueriesFile;
  compatible: boolean;
}

const manifestArtifactSchema = z.object({
  bytes: z.number().int().positive(),
  sha256: z.string().regex(HEX_64_RE),
}).strict();

const manifestV1Schema = z.object({
  formatVersion: z.literal(1),
  packageId: z.string().regex(PACKAGE_ID_RE).max(128),
  appVersion: z.string().regex(SEMVER_3_RE),
  sourceCommit: z.string().regex(COMMIT_SHA_RE),
  requires: z.array(z.string().min(1).max(64)).max(16),
  artifacts: z.object({
    "index.html": manifestArtifactSchema,
    "queries.json": manifestArtifactSchema,
  }).strict(),
}).strict();

const querySlotSchema = z.object({
  id: bindingNameSchema,
  source: z.object({
    schema: sourceNameSchema.nullable(),
    table: sourceNameSchema.nullable(),
  }).strict(),
  fields: z.record(bindingNameSchema, bindingFieldSchema),
  queries: z.record(bindingNameSchema, namedQuerySchema),
}).strict();

const queriesFileSchema = z.object({
  notice: z.string().max(1000).optional(),
  contractVersion: z.string().min(1).max(32),
  dataSlots: z.array(querySlotSchema).max(16),
}).strict();

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8Strict(bytes: Uint8Array, label: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw appFailure(422, `${label} must not contain a UTF-8 BOM.`);
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw appFailure(422, `${label} is not valid UTF-8.`);
  }
}

export function miniAppReleaseMapping(app: MiniAppSummary): MiniAppReleaseMapping | null {
  const kind = app.dashboardIdentity ?? app.nativeIdentity ?? app.shippedTemplateKind
    ?? (app.id === LEGACY_MINI_APP_IDS.mojo ? "mojo" : null);
  if (!kind) return null;
  const { packageId, releaseSlug } = miniAppReleasePackage(kind);
  return { kind, packageId, releaseSlug };
}

export function compareSemver3(a: string, b: string): number {
  const pa = SEMVER_3_RE.exec(a);
  const pb = SEMVER_3_RE.exec(b);
  if (pa?.[0] !== a || pb?.[0] !== b) throw appFailure(400, "Invalid 3-component semantic version.");
  for (const index of [1, 2, 3]) {
    const left = pa[index]!, right = pb[index]!;
    if (left !== right) return left.length - right.length || (left > right ? 1 : -1);
  }
  return 0;
}

export function releaseTagFor(slug: string, appVersion: string): string {
  return `mini-app/${slug}/v${appVersion}`;
}

export function parseReleaseTag(tagName: string, slug: string): string | null {
  const prefix = `mini-app/${slug}/v`;
  if (!tagName.startsWith(prefix)) return null;
  const version = tagName.slice(prefix.length);
  return SEMVER_3_RE.exec(version)?.[0] === version ? version : null;
}

export function hasRevokedBuiltInGrant(app: MiniAppSummary, mapping: MiniAppReleaseMapping): boolean {
  if (mapping.kind === "agent-team" || mapping.kind === "usage") {
    return !app.dashboard || app.dashboard.kind !== mapping.kind;
  }
  if (mapping.kind === "hongguo") return app.nativeKind !== "hongguo";
  return false;
}

export function isCustomAppTemplate(
  app: MiniAppSummary,
  mapping: MiniAppReleaseMapping | null,
  html: string,
  bindings: readonly MiniAppDataBinding[],
): boolean {
  if (!mapping) return true;
  const hash = sha256Hex(html);
  const nativeOrDashboard = mapping.kind === "agent-team" || mapping.kind === "usage" || mapping.kind === "hongguo" || mapping.kind === "mojo";
  if (app.release) {
    return !matchesMiniAppReleasePackage(mapping.kind, app.release) || hash !== app.release.htmlSha256 || (nativeOrDashboard && bindings.length > 0);
  }
  if (mapping.kind === "agent-team") {
    return bindings.length > 0 || !ADOPTABLE_AGENT_TEAM_HTML_SHA256.includes(hash);
  }
  if (mapping.kind === "usage") {
    return bindings.length > 0
      || (hash !== NATIVE_DEFAULT_HTML_SHA256 && !(AGENT_TEAM_NATIVE_PLACEHOLDER_SHA256 as readonly string[]).includes(hash));
  }
  if (mapping.kind === "hongguo") {
    return bindings.length > 0 || hash !== NATIVE_DEFAULT_HTML_SHA256;
  }
  if (mapping.kind === "mojo") {
    return bindings.length > 0 || !(app.shippedTemplateKind === "mojo" && matchesPendingDefaultHtml("mojo", html)
      || app.id === LEGACY_MINI_APP_IDS.mojo && hash === MOJO_LEGACY_HTML_SHA256);
  }
  if (bindings.length === 0) return !matchesPendingDefaultHtml(mapping.kind, html);
  const githubCatalog = mapping.kind === "github_activity" && hash === GITHUB_ACTIVITY_CATALOG_TEMPLATE_SHA256;
  const adoptable = (SHIPPED_TEMPLATE_SHA256[mapping.kind] as readonly string[]).includes(hash)
    || (ADOPTABLE_LEGACY_TEMPLATE_SHA256[mapping.kind] as readonly string[]).includes(hash) || githubCatalog;
  if (!adoptable) return true;
  if (mapping.kind === "bookkeeping") {
    return bindings.length !== 1 || !bundledBookkeepingBinding(bindings[0]!);
  }
  if (mapping.kind === "x_ai_digest") return !acceptsOptionalDailyXEditorial(bindings);
  return !hasReportBindingForProducer(bindings, bindings[0]!.datasetId, mapping.kind) || (githubCatalog && !bindings[1]?.queries.deep_dive_catalog);
}

export function isReleaseCompatible(app: MiniAppSummary, mapping: MiniAppReleaseMapping, requires: readonly string[]): boolean {
  return app.status === "active" && miniAppReleaseMapping(app)?.kind === mapping.kind && !hasRevokedBuiltInGrant(app, mapping)
    && matchesMiniAppReleasePackage(mapping.kind, { packageId: mapping.packageId, requires });
}

const requiresData = (kind: DefaultMiniAppKind) => kind === "bookkeeping" || kind === "x_ai_digest" || kind === "github_activity";

function findGhExecutable(): string | null {
  if (process.platform === "win32") return whichWin("gh");
  return findCliCandidates("gh").find((candidate) => {
    try { return statSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false; }
    catch { return false; }
  }) ?? null;
}

function sanitizedGhEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GITHUB_HOST",
    "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "GH_REPO",
  ]) {
    delete env[key];
  }
  env.GH_PROMPT_DISABLED = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.NO_COLOR = "1";
  return env;
}

async function execGh(
  executable: string,
  args: readonly string[],
  options: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? GH_DEFAULT_TIMEOUT_MS;
  return await new Promise<Buffer>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(appFailure(503, "Mini App release request was cancelled."));
      return;
    }
    const child = spawn(executable, args, {
      env: sanitizedGhEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (err?: Error, out?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolve(out!);
    };

    const killChild = () => {
      try { child.kill("SIGKILL"); } catch {}
    };

    const onAbort = () => {
      killChild();
      finish(appFailure(503, "Mini App release request was cancelled."));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      killChild();
      finish(appFailure(503, "Mini App release lookup timed out."));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxBytes) {
        killChild();
        finish(appFailure(413, "Mini App release response exceeded maximum allowed size."));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < 8192) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on("error", () => {
      finish(appFailure(503, "GitHub CLI is unavailable for Mini App releases."));
    });

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish(appFailure(503, stderr ? "Mini App release source is unavailable." : "GitHub release check failed."));
        return;
      }
      finish(undefined, Buffer.concat(stdoutChunks));
    });
  });
}

export class GhMiniAppReleaseReader implements MiniAppReleaseReader {
  private readonly timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? GH_DEFAULT_TIMEOUT_MS;
  }

  private async verifyAuth(executable: string, signal?: AbortSignal): Promise<void> {
    const out = await execGh(
      executable,
      ["api", "--hostname", TRUSTED_GH_HOST, "user", "--jq", ".login"],
      { maxBytes: 4096, timeoutMs: Math.min(this.timeoutMs, 10_000), signal },
    );
    const login = out.toString("utf8").trim();
    if (login !== TRUSTED_GH_LOGIN) {
      throw appFailure(503, "Authenticated GitHub account does not match the trusted Mini App publisher.");
    }
  }

  private requireGh(): string {
    const executable = findGhExecutable();
    if (!executable) throw appFailure(503, "GitHub CLI is not installed on this machine.");
    return executable;
  }

  async listReleases(repo: string, slug: string, signal?: AbortSignal): Promise<MiniAppReleaseSummary[]> {
    const executable = this.requireGh();
    await this.verifyAuth(executable, signal);
    const out = await execGh(
      executable,
      ["release", "list", "--repo", repo, "--exclude-drafts", "--exclude-pre-releases", "--limit", "200", "--json", "tagName,isDraft,isPrerelease"],
      { maxBytes: 512 * 1024, timeoutMs: this.timeoutMs, signal },
    );
    let parsed: unknown;
    try { parsed = JSON.parse(decodeUtf8Strict(out, "Release list")); }
    catch { throw appFailure(503, "Invalid release listing from GitHub."); }
    const rows = z.array(z.object({
      tagName: z.string(),
      isDraft: z.boolean(),
      isPrerelease: z.boolean(),
    })).safeParse(parsed);
    if (!rows.success) throw appFailure(503, "Invalid release listing schema from GitHub.");
    return rows.data.filter((entry) => !entry.isDraft && !entry.isPrerelease && parseReleaseTag(entry.tagName, slug) !== null);
  }

  async viewRelease(repo: string, tagName: string, signal?: AbortSignal): Promise<MiniAppReleaseDescriptor | null> {
    if (!RELEASE_TAG_RE.test(tagName)) throw appFailure(400, "Invalid Mini App release tag.");
    const executable = this.requireGh();
    await this.verifyAuth(executable, signal);
    const out = await execGh(
      executable,
      ["release", "view", tagName, "--repo", repo, "--json", "tagName,targetCommitish,isDraft,isPrerelease,assets"],
      { maxBytes: 256 * 1024, timeoutMs: this.timeoutMs, signal },
    );
    let parsed: unknown;
    try { parsed = JSON.parse(decodeUtf8Strict(out, "Release metadata")); }
    catch { throw appFailure(503, "Invalid release metadata from GitHub."); }
    const view = z.object({
      tagName: z.string(),
      targetCommitish: z.string().optional(),
      isDraft: z.boolean(),
      isPrerelease: z.boolean(),
      assets: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative() })),
    }).safeParse(parsed);
    if (!view.success) throw appFailure(503, "Invalid release metadata schema from GitHub.");

    const refOut = await execGh(
      executable,
      ["api", `repos/${repo}/git/ref/tags/${tagName}`],
      { maxBytes: 64 * 1024, timeoutMs: this.timeoutMs, signal },
    );
    let refParsed: unknown;
    try { refParsed = JSON.parse(decodeUtf8Strict(refOut, "Release tag ref")); }
    catch { throw appFailure(503, "Invalid release tag ref metadata from GitHub."); }
    const tagRef = z.object({
      ref: z.literal(`refs/tags/${tagName}`),
      object: z.object({
        type: z.literal("commit"),
        sha: z.string().regex(COMMIT_SHA_RE),
      }),
    }).safeParse(refParsed);
    if (!tagRef.success) {
      throw appFailure(422, "Mini App release tag must be a lightweight ref pointing directly to a commit.");
    }
    return {
      ...view.data,
      tagCommitSha: tagRef.data.object.sha.toLowerCase(),
    };
  }

  async readAsset(repo: string, tagName: string, assetName: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
    const executable = this.requireGh();
    await this.verifyAuth(executable, signal);
    return await execGh(
      executable,
      ["release", "download", tagName, "--repo", repo, "--pattern", assetName, "--output", "-"],
      { maxBytes, timeoutMs: this.timeoutMs, signal },
    );
  }
}

interface FixtureReleaseEntry {
  tagName: string;
  tagCommitSha?: string;
  targetCommitish?: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  assets: Record<string, string | { base64: string; reportedSize?: number }>;
}

interface FixtureReleasesFile {
  mode?: "ok" | "unavailable";
  releases: FixtureReleaseEntry[];
}

export function createFixtureFileReader(filePath: string): MiniAppReleaseReader {
  if (!sealedFixture()) {
    throw appFailure(503, "Synthetic release fixture reader is only allowed in sealed test fixtures.");
  }
  const load = (): FixtureReleasesFile => {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as FixtureReleasesFile;
    if (raw.mode === "unavailable") throw appFailure(503, "Synthetic release source is unavailable.");
    return raw;
  };
  const bytesFor = (value: string | { base64: string; reportedSize?: number }): Buffer =>
    typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value.base64, "base64");

  return {
    async listReleases(_repo, slug) {
      const data = load();
      return data.releases
        .filter((entry) => !entry.isDraft && !entry.isPrerelease && parseReleaseTag(entry.tagName, slug) !== null)
        .map((entry) => ({ tagName: entry.tagName, isDraft: Boolean(entry.isDraft), isPrerelease: Boolean(entry.isPrerelease) }));
    },
    async viewRelease(_repo, tagName) {
      const data = load();
      const match = data.releases.find((entry) => entry.tagName === tagName);
      if (!match) return null;
      return {
        tagName: match.tagName,
        tagCommitSha: (match.tagCommitSha ?? match.targetCommitish ?? "").toLowerCase(),
        ...(match.targetCommitish ? { targetCommitish: match.targetCommitish } : {}),
        isDraft: Boolean(match.isDraft),
        isPrerelease: Boolean(match.isPrerelease),
        assets: Object.entries(match.assets).map(([name, value]) => ({
          name,
          size: typeof value === "object" && value.reportedSize !== undefined ? value.reportedSize : bytesFor(value).byteLength,
        })),
      };
    },
    async readAsset(_repo, tagName, assetName, maxBytes) {
      const data = load();
      const match = data.releases.find((entry) => entry.tagName === tagName);
      if (!match || !Object.hasOwn(match.assets, assetName)) {
        throw appFailure(404, `Release asset ${assetName} not found.`);
      }
      const bytes = bytesFor(match.assets[assetName]!);
      if (bytes.byteLength > maxBytes) {
        throw appFailure(413, `Release asset ${assetName} exceeds maximum allowed size.`);
      }
      return bytes;
    },
  };
}

export function defaultMiniAppReleaseReader(): MiniAppReleaseReader {
  return new GhMiniAppReleaseReader();
}

export class MiniAppReleaseSource {
  private readonly reader: MiniAppReleaseReader;
  private readonly repo: string;

  constructor(options: { reader?: MiniAppReleaseReader; repo?: string } = {}) {
    this.reader = options.reader ?? defaultMiniAppReleaseReader();
    this.repo = options.repo ?? MINI_APP_RELEASE_REPO;
  }

  async checkUpdate(
    app: MiniAppSummary,
    html: string,
    bindings: readonly MiniAppDataBinding[],
    signal?: AbortSignal,
  ): Promise<MiniAppUpdateCheckResult> {
    const installedVersion = app.release?.appVersion ?? null;
    const mapping = miniAppReleaseMapping(app);
    if (!mapping || isCustomAppTemplate(app, mapping, html, bindings)) {
      return { installedVersion, status: "custom", available: null };
    }
    if (app.status !== "active" || hasRevokedBuiltInGrant(app, mapping) || (requiresData(mapping.kind) && !bindings.length)) {
      return { installedVersion, status: "unavailable", available: null };
    }
    let summaries: MiniAppReleaseSummary[];
    try {
      summaries = await this.reader.listReleases(this.repo, mapping.releaseSlug, signal);
    } catch {
      return { installedVersion, status: "unavailable", available: null };
    }
    const candidates = summaries
      .filter((item) => !item.isDraft && !item.isPrerelease)
      .map((item) => ({ item, version: parseReleaseTag(item.tagName, mapping.releaseSlug) }))
      .filter((entry): entry is { item: MiniAppReleaseSummary; version: string } => entry.version !== null)
      .sort((a, b) => compareSemver3(b.version, a.version));
    const latest = candidates[0];
    if (!latest) return { installedVersion, status: "unavailable", available: null };
    if (installedVersion !== null && compareSemver3(latest.version, installedVersion) <= 0) {
      return { installedVersion, status: "current", available: null };
    }
    let verified: VerifiedMiniAppRelease;
    try {
      verified = await this.verifyRelease(app, mapping, bindings, latest.item.tagName, latest.version, signal);
    } catch {
      return { installedVersion, status: "unavailable", available: null };
    }
    if (!verified.compatible) {
      return {
        installedVersion,
        status: "incompatible",
        available: { appVersion: verified.manifest.appVersion, sourceCommit: verified.manifest.sourceCommit },
      };
    }
    return {
      installedVersion,
      status: "available",
      available: { appVersion: verified.manifest.appVersion, sourceCommit: verified.manifest.sourceCommit },
    };
  }

  async fetchVerifiedUpdate(
    app: MiniAppSummary,
    html: string,
    bindings: readonly MiniAppDataBinding[],
    expected: { appVersion: string; sourceCommit: string },
    signal?: AbortSignal,
  ): Promise<VerifiedMiniAppRelease> {
    if (app.status !== "active") throw appFailure(409, "This Mini App is archived.");
    const mapping = miniAppReleaseMapping(app);
    if (!mapping || isCustomAppTemplate(app, mapping, html, bindings)) {
      throw appFailure(409, "This Mini App has custom changes and cannot be overwritten by a release update.");
    }
    if (hasRevokedBuiltInGrant(app, mapping)) {
      throw appFailure(403, "This Mini App's built-in grant has been revoked.");
    }
    if (requiresData(mapping.kind) && !bindings.length) throw appFailure(409, "This Mini App is still waiting for its Data source.");
    if (app.release && compareSemver3(expected.appVersion, app.release.appVersion) <= 0) {
      throw appFailure(409, "This version is already installed or older than the current release. Use rollback to restore an earlier version.");
    }
    const tagName = releaseTagFor(mapping.releaseSlug, expected.appVersion);
    const verified = await this.verifyRelease(app, mapping, bindings, tagName, expected.appVersion, signal);
    if (verified.manifest.sourceCommit !== expected.sourceCommit) {
      throw appFailure(409, "The release commit does not match the requested candidate.");
    }
    if (!verified.compatible) {
      throw appFailure(409, "This Mini App release requires capabilities not supported by this Host.");
    }
    return verified;
  }

  private async verifyRelease(
    app: MiniAppSummary,
    mapping: MiniAppReleaseMapping,
    bindings: readonly MiniAppDataBinding[],
    tagName: string,
    expectedVersion: string,
    signal?: AbortSignal,
  ): Promise<VerifiedMiniAppRelease> {
    const descriptor = await this.reader.viewRelease(this.repo, tagName, signal);
    if (!descriptor || descriptor.isDraft || descriptor.isPrerelease || descriptor.tagName !== tagName) {
      throw appFailure(404, "Mini App release was not found.");
    }
    const expectedAssets = new Set<string>(MINI_APP_RELEASE_ASSETS);
    const seen = new Map<string, MiniAppReleaseAsset>();
    for (const asset of descriptor.assets) {
      if (!expectedAssets.has(asset.name) || seen.has(asset.name)) {
        throw appFailure(422, "Mini App release contains unexpected or duplicate assets.");
      }
      seen.set(asset.name, asset);
    }
    if (seen.size !== MINI_APP_RELEASE_ASSETS.length) {
      throw appFailure(422, "Mini App release is missing required assets.");
    }
    const assetBounds: Record<typeof MINI_APP_RELEASE_ASSETS[number], number> = {
      "manifest.json": MINI_APP_RELEASE_BOUNDS.manifestBytes,
      "index.html": MINI_APP_RELEASE_BOUNDS.htmlBytes,
      "queries.json": MINI_APP_RELEASE_BOUNDS.queriesBytes,
    };
    for (const name of MINI_APP_RELEASE_ASSETS) {
      const size = seen.get(name)!.size;
      if (size <= 0 || size > assetBounds[name]) {
        throw appFailure(413, `Mini App release asset ${name} is out of allowed byte bounds.`);
      }
    }

    const manifestRaw = await this.reader.readAsset(this.repo, tagName, "manifest.json", MINI_APP_RELEASE_BOUNDS.manifestBytes, signal);
    if (manifestRaw.byteLength === 0 || manifestRaw.byteLength > MINI_APP_RELEASE_BOUNDS.manifestBytes) {
      throw appFailure(413, "Mini App manifest.json exceeds 16 KiB.");
    }
    let manifestJson: unknown;
    try { manifestJson = JSON.parse(decodeUtf8Strict(manifestRaw, "manifest.json")); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw appFailure(422, "Mini App manifest.json is not valid JSON.");
    }
    const parsedManifest = manifestV1Schema.safeParse(manifestJson);
    if (!parsedManifest.success) throw appFailure(422, "Mini App manifest.json failed v1 schema validation.");
    const manifest = parsedManifest.data;
    if (manifest.packageId !== mapping.packageId) {
      throw appFailure(422, "Mini App release packageId does not match this app.");
    }
    if (manifest.appVersion !== expectedVersion || releaseTagFor(mapping.releaseSlug, manifest.appVersion) !== tagName) {
      throw appFailure(422, "Mini App release version does not match its tag.");
    }
    if (!COMMIT_SHA_RE.test(descriptor.tagCommitSha.toLowerCase())
      || descriptor.tagCommitSha.toLowerCase() !== manifest.sourceCommit) {
      throw appFailure(422, "Mini App release tag commit does not match manifest sourceCommit.");
    }
    if (descriptor.targetCommitish && COMMIT_SHA_RE.test(descriptor.targetCommitish.toLowerCase())
      && descriptor.targetCommitish.toLowerCase() !== manifest.sourceCommit) {
      throw appFailure(422, "Mini App release target commit does not match manifest sourceCommit.");
    }
    const declaredHtml = manifest.artifacts["index.html"];
    const declaredQueries = manifest.artifacts["queries.json"];
    if (declaredHtml.bytes > MINI_APP_RELEASE_BOUNDS.htmlBytes) {
      throw appFailure(413, "Mini App index.html exceeds 512 KiB.");
    }
    if (declaredQueries.bytes > MINI_APP_RELEASE_BOUNDS.queriesBytes) {
      throw appFailure(413, "Mini App queries.json exceeds 64 KiB.");
    }

    const htmlRaw = await this.reader.readAsset(this.repo, tagName, "index.html", MINI_APP_RELEASE_BOUNDS.htmlBytes, signal);
    if (htmlRaw.byteLength > MINI_APP_RELEASE_BOUNDS.htmlBytes) throw appFailure(413, "Mini App index.html exceeds 512 KiB.");
    if (htmlRaw.byteLength !== declaredHtml.bytes || sha256Hex(htmlRaw) !== declaredHtml.sha256) {
      throw appFailure(422, "Mini App index.html digest or byte length verification failed.");
    }
    const html = decodeUtf8Strict(htmlRaw, "index.html");

    const queriesRaw = await this.reader.readAsset(this.repo, tagName, "queries.json", MINI_APP_RELEASE_BOUNDS.queriesBytes, signal);
    if (queriesRaw.byteLength > MINI_APP_RELEASE_BOUNDS.queriesBytes) throw appFailure(413, "Mini App queries.json exceeds 64 KiB.");
    if (queriesRaw.byteLength !== declaredQueries.bytes || sha256Hex(queriesRaw) !== declaredQueries.sha256) {
      throw appFailure(422, "Mini App queries.json digest or byte length verification failed.");
    }
    let queriesJson: unknown;
    try { queriesJson = JSON.parse(decodeUtf8Strict(queriesRaw, "queries.json")); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error) throw error;
      throw appFailure(422, "Mini App queries.json is not valid JSON.");
    }
    const parsedQueries = queriesFileSchema.safeParse(queriesJson);
    if (!parsedQueries.success) throw appFailure(422, "Mini App queries.json failed schema validation.");
    const queries = parsedQueries.data;
    const slotIds = queries.dataSlots.map((slot) => slot.id);
    const queryIds = queries.dataSlots.flatMap((slot) => Object.keys(slot.queries));
    if (new Set(slotIds).size !== slotIds.length || new Set(queryIds).size !== queryIds.length || queryIds.length > 64) {
      throw appFailure(422, "Mini App queries.json slot and query names must be unique; at most 64 queries are allowed.");
    }
    if ((mapping.kind === "agent-team" || mapping.kind === "usage" || mapping.kind === "hongguo" || mapping.kind === "mojo")
      && queries.dataSlots.length > 0) {
      throw appFailure(422, "Native/dashboard Mini App releases must declare empty dataSlots.");
    }

    const compatible = isReleaseCompatible(app, mapping, manifest.requires)
      && (mapping.kind === "bookkeeping" ? !!bindings[0] && bookkeepingReleaseQueriesMatch(bindings[0], queries.dataSlots)
        : mapping.kind === "x_ai_digest" || mapping.kind === "github_activity" ? reportReleaseQueriesMatch(mapping.kind, queries.dataSlots) : true);
    const provenance: MiniAppReleaseProvenance = {
      packageId: manifest.packageId,
      appVersion: manifest.appVersion,
      sourceCommit: manifest.sourceCommit,
      tag: tagName,
      requires: [...manifest.requires],
      htmlSha256: declaredHtml.sha256,
      htmlBytes: declaredHtml.bytes,
      queriesSha256: declaredQueries.sha256,
      queriesBytes: declaredQueries.bytes,
    };
    return { manifest, provenance, html, queries, compatible };
  }
}
