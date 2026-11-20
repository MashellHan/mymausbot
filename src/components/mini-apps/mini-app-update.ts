import type { MiniAppSummary } from "../../../shared/mini-apps";

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

/** Wire status returned by `GET /api/mini-apps/:appId/update`. */
export type MiniAppUpdateStatus =
  | "available"
  | "current"
  | "unavailable"
  | "incompatible"
  | "custom";

/** Candidate release metadata offered by the Host update check. */
export interface MiniAppUpdateCandidate {
  appVersion: string;
  sourceCommit: string;
}

/** Response shape for `GET /api/mini-apps/:appId/update`. */
export interface MiniAppUpdateCheckResult {
  installedVersion: string | null;
  status: MiniAppUpdateStatus;
  available: MiniAppUpdateCandidate | null;
}

export type MiniAppUpdateInfo = MiniAppUpdateCheckResult;

/** Request payload for `POST /api/mini-apps/:appId/update`. */
export interface MiniAppUpdateApply {
  appVersion: string;
  sourceCommit: string;
  expectedRevision: number;
  requestKey: string;
}

export type MiniAppUpdateRequest = MiniAppUpdateApply;

const VALID_STATUSES = new Set<MiniAppUpdateStatus>([
  "available",
  "current",
  "unavailable",
  "incompatible",
  "custom",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseUpdateCandidate(raw: unknown): MiniAppUpdateCandidate | null {
  if (!isRecord(raw)) return null;
  const appVersion = nonEmptyString(raw.appVersion);
  const sourceCommit = nonEmptyString(raw.sourceCommit);
  if (!appVersion || !sourceCommit) return null;
  return { appVersion, sourceCommit };
}

export function parseMiniAppUpdateInfo(raw: unknown): MiniAppUpdateCheckResult | null {
  if (!isRecord(raw) || typeof raw.status !== "string" || !VALID_STATUSES.has(raw.status as MiniAppUpdateStatus)) {
    return null;
  }
  const status = raw.status as MiniAppUpdateStatus;
  let installedVersion: string | null = null;
  if (raw.installedVersion !== null && raw.installedVersion !== undefined) {
    const parsedVersion = nonEmptyString(raw.installedVersion);
    if (!parsedVersion) return null;
    installedVersion = parsedVersion;
  }
  if (status === "available") {
    const available = parseUpdateCandidate(raw.available);
    if (!available) return null;
    return { installedVersion, status, available };
  }
  if (status === "incompatible") {
    if (raw.available === null || raw.available === undefined) {
      return { installedVersion, status, available: null };
    }
    const available = parseUpdateCandidate(raw.available);
    if (!available) return null;
    return { installedVersion, status, available };
  }
  if (raw.available !== null && raw.available !== undefined) return null;
  return { installedVersion, status, available: null };
}

export function updateProfileKey(storageKey: string | null): string {
  return storageKey ?? "default";
}

export function updateAnnouncementStorageKey(storageKey: string | null, appId: string): string {
  return `omb-mini-app-update-announced:${updateProfileKey(storageKey)}:${appId}`;
}

export function readAnnouncedUpdateVersions(storageKey: string | null, appId: string): string[] {
  try {
    const raw = localStorage.getItem(updateAnnouncementStorageKey(storageKey, appId));
    if (!raw) return [];
    if (raw.startsWith("[")) {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
    }
    return [raw];
  } catch {
    return [];
  }
}

export function hasAnnouncedUpdateVersion(storageKey: string | null, appId: string, appVersion: string): boolean {
  return readAnnouncedUpdateVersions(storageKey, appId).includes(appVersion);
}

export function rememberAnnouncedUpdateVersion(storageKey: string | null, appId: string, appVersion: string): void {
  try {
    const existing = readAnnouncedUpdateVersions(storageKey, appId);
    if (existing.includes(appVersion)) return;
    const next = [...existing, appVersion].slice(-20);
    localStorage.setItem(updateAnnouncementStorageKey(storageKey, appId), JSON.stringify(next));
  } catch {}
}

export const MINI_APP_RUNTIME_READY_TIMEOUT_MS = 10_000;
export const PENDING_UPDATE_INTENT_TTL_MS = 10 * 60_000;

export interface PendingMiniAppUpdateIntent {
  phase: "intent";
  appId: string;
  expectedRevision: number;
  previousTemplateVersion: number;
  packageId: string | null;
  appVersion: string;
  sourceCommit: string;
  requestKey: string;
  rollbackRequestKey: string;
  createdAt: number;
}

export interface PendingMiniAppUpdateRecovery {
  phase?: "applied";
  appId: string;
  previousTemplateVersion: number;
  candidateRevision: number;
  candidateTemplateVersion: number;
  rollbackRequestKey: string;
  deadlineAt: number;
}

export type PendingMiniAppUpdate = PendingMiniAppUpdateIntent | PendingMiniAppUpdateRecovery;

export type PendingUpdateReconcileResult =
  | { action: "keep"; record: PendingMiniAppUpdate; olderRead: boolean }
  | { action: "promote"; record: PendingMiniAppUpdateRecovery }
  | { action: "clear" };

export function isPendingUpdateApplied(
  value: PendingMiniAppUpdate | null | undefined,
): value is PendingMiniAppUpdateRecovery {
  return Boolean(value && value.phase !== "intent");
}

export function pendingUpdateRecoveryStorageKey(storageKey: string | null, appId: string): string {
  return `omb-mini-app-pending-update:${updateProfileKey(storageKey)}:${appId}`;
}

export function readPendingUpdate(storageKey: string | null, appId: string): PendingMiniAppUpdate | null {
  try {
    const raw = localStorage.getItem(pendingUpdateRecoveryStorageKey(storageKey, appId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.appId !== appId) return null;
    if (parsed.phase === "intent") {
      const appVersion = nonEmptyString(parsed.appVersion);
      const sourceCommit = nonEmptyString(parsed.sourceCommit);
      const requestKey = nonEmptyString(parsed.requestKey);
      const rollbackRequestKey = nonEmptyString(parsed.rollbackRequestKey);
      const packageId = parsed.packageId === null || parsed.packageId === undefined
        ? null
        : nonEmptyString(parsed.packageId);
      if (
        !appVersion
        || !sourceCommit
        || !requestKey
        || !rollbackRequestKey
        || (parsed.packageId !== null && parsed.packageId !== undefined && !packageId)
        || !Number.isSafeInteger(parsed.expectedRevision)
        || Number(parsed.expectedRevision) < 0
        || !Number.isSafeInteger(parsed.previousTemplateVersion)
        || !Number.isSafeInteger(parsed.createdAt)
        || Number(parsed.createdAt) <= 0
      ) {
        return null;
      }
      return {
        phase: "intent",
        appId: parsed.appId,
        expectedRevision: Number(parsed.expectedRevision),
        previousTemplateVersion: Number(parsed.previousTemplateVersion),
        packageId,
        appVersion,
        sourceCommit,
        requestKey,
        rollbackRequestKey,
        createdAt: Number(parsed.createdAt),
      };
    }
    if (parsed.phase !== undefined && parsed.phase !== "applied") return null;
    if (
      typeof parsed.rollbackRequestKey !== "string"
      || !parsed.rollbackRequestKey
      || !Number.isSafeInteger(parsed.previousTemplateVersion)
      || !Number.isSafeInteger(parsed.candidateRevision)
      || !Number.isSafeInteger(parsed.candidateTemplateVersion)
      || !Number.isSafeInteger(parsed.deadlineAt)
      || Number(parsed.deadlineAt) <= 0
    ) {
      return null;
    }
    return {
      phase: "applied",
      appId: parsed.appId,
      previousTemplateVersion: Number(parsed.previousTemplateVersion),
      candidateRevision: Number(parsed.candidateRevision),
      candidateTemplateVersion: Number(parsed.candidateTemplateVersion),
      rollbackRequestKey: parsed.rollbackRequestKey,
      deadlineAt: Number(parsed.deadlineAt),
    };
  } catch {
    return null;
  }
}

export function writePendingUpdate(storageKey: string | null, update: PendingMiniAppUpdate): boolean {
  try {
    const payload = update.phase === "intent"
      ? update
      : { ...update, phase: "applied" as const };
    const key = pendingUpdateRecoveryStorageKey(storageKey, update.appId);
    const serialized = JSON.stringify(payload);
    localStorage.setItem(key, serialized);
    return localStorage.getItem(key) === serialized;
  } catch { return false; }
}

export function readPendingUpdateRecovery(storageKey: string | null, appId: string): PendingMiniAppUpdateRecovery | null {
  const parsed = readPendingUpdate(storageKey, appId);
  return isPendingUpdateApplied(parsed) ? parsed : null;
}

export function writePendingUpdateRecovery(storageKey: string | null, recovery: PendingMiniAppUpdateRecovery): void {
  writePendingUpdate(storageKey, { ...recovery, phase: "applied" });
}

export function clearPendingUpdateRecovery(storageKey: string | null, appId: string): void {
  const key = pendingUpdateRecoveryStorageKey(storageKey, appId);
  try {
    if (typeof localStorage.removeItem === "function") {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, "");
    }
  } catch {}
}

export function readAppPackageId(app: MiniAppSummary): string | null {
  const extra = app as MiniAppSummary & { release?: { packageId?: unknown } | null };
  return extra.release ? nonEmptyString(extra.release.packageId) : null;
}

function readEntryReleaseProvenance(
  app: MiniAppSummary,
): { packageId: string | null; appVersion: string; sourceCommit: string } | null {
  const extra = app as MiniAppSummary & {
    release?: { packageId?: unknown; appVersion?: unknown; sourceCommit?: unknown } | null;
  };
  if (!isRecord(extra.release)) return null;
  const appVersion = nonEmptyString(extra.release.appVersion);
  const sourceCommit = nonEmptyString(extra.release.sourceCommit);
  if (!appVersion || !sourceCommit) return null;
  return {
    packageId: nonEmptyString(extra.release.packageId),
    appVersion,
    sourceCommit,
  };
}

export function matchesAppliedUpdateIntent(
  entry: MiniAppSummary,
  intent: PendingMiniAppUpdateIntent,
): boolean {
  if (
    entry.id !== intent.appId
    || entry.release?.updateRequestKey !== intent.requestKey
    || entry.status !== "active"
    || entry.revision !== intent.expectedRevision + 1
    || entry.templateVersion === intent.previousTemplateVersion
  ) {
    return false;
  }
  const provenance = readEntryReleaseProvenance(entry);
  if (!provenance) return false;
  if (provenance.appVersion !== intent.appVersion || provenance.sourceCommit !== intent.sourceCommit) {
    return false;
  }
  return intent.packageId === null || provenance.packageId === intent.packageId;
}

export function reconcilePendingUpdateWithSummary(
  pending: PendingMiniAppUpdate,
  entry: MiniAppSummary | undefined,
  now = Date.now(),
  inFlight = false,
): PendingUpdateReconcileResult {
  if (pending.phase === "intent") {
    if (!entry) return { action: "clear" };
    if (entry.status === "active" && entry.revision < pending.expectedRevision) {
      return { action: "keep", record: pending, olderRead: true };
    }
    if (
      entry.status === "active"
      && entry.revision === pending.expectedRevision
      && entry.templateVersion === pending.previousTemplateVersion
    ) {
      if (!inFlight && now - pending.createdAt > PENDING_UPDATE_INTENT_TTL_MS) {
        return { action: "clear" };
      }
      return { action: "keep", record: pending, olderRead: false };
    }
    if (matchesAppliedUpdateIntent(entry, pending)) {
      return {
        action: "promote",
        record: {
          phase: "applied",
          appId: pending.appId,
          previousTemplateVersion: pending.previousTemplateVersion,
          candidateRevision: entry.revision,
          candidateTemplateVersion: entry.templateVersion,
          rollbackRequestKey: pending.rollbackRequestKey,
          deadlineAt: now + MINI_APP_RUNTIME_READY_TIMEOUT_MS,
        },
      };
    }
    return { action: "clear" };
  }

  if (!entry) return { action: "clear" };
  if (entry.status === "active" && entry.revision < pending.candidateRevision) {
    return { action: "keep", record: pending, olderRead: true };
  }
  if (
    entry.status === "active"
    && entry.revision === pending.candidateRevision
    && entry.templateVersion === pending.candidateTemplateVersion
  ) {
    return { action: "keep", record: pending, olderRead: false };
  }
  return { action: "clear" };
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

export function readAppReleaseMeta(
  app: MiniAppSummary,
  updateInfo?: MiniAppUpdateCheckResult | null,
): { version: string | null; sourceCommit: string | null } {
  const extra = app as MiniAppSummary & {
    release?: { appVersion?: unknown; sourceCommit?: unknown } | null;
  };
  if (extra.release === null) {
    return { version: null, sourceCommit: null };
  }
  const summaryVersion = nonEmptyString(extra.release?.appVersion);
  const summaryCommit = nonEmptyString(extra.release?.sourceCommit);
  return {
    version: summaryVersion ?? updateInfo?.installedVersion ?? null,
    sourceCommit: summaryCommit,
  };
}
