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

export interface PendingMiniAppUpdateRecovery {
  appId: string;
  previousTemplateVersion: number;
  candidateRevision: number;
  candidateTemplateVersion: number;
  rollbackRequestKey: string;
  deadlineAt: number;
}

export function pendingUpdateRecoveryStorageKey(storageKey: string | null, appId: string): string {
  return `omb-mini-app-pending-update:${updateProfileKey(storageKey)}:${appId}`;
}

export function readPendingUpdateRecovery(storageKey: string | null, appId: string): PendingMiniAppUpdateRecovery | null {
  try {
    const raw = localStorage.getItem(pendingUpdateRecoveryStorageKey(storageKey, appId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.appId !== "string"
      || parsed.appId !== appId
      || typeof parsed.rollbackRequestKey !== "string"
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

export function writePendingUpdateRecovery(storageKey: string | null, recovery: PendingMiniAppUpdateRecovery): void {
  try {
    localStorage.setItem(pendingUpdateRecoveryStorageKey(storageKey, recovery.appId), JSON.stringify(recovery));
  } catch {}
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
