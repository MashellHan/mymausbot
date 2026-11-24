import type { MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { LEGACY_MINI_APP_IDS, matchesMiniAppReleasePackage } from "../../../shared/mini-app-release-packages";
import { GITHUB_ACTIVITY_URL, githubActivityPageAllowed } from "../../../electron/github-activity-frame.mjs";

export { GITHUB_ACTIVITY_URL, GITHUB_ACTIVITY_FRAME_NAME, githubActivityPageAllowed, githubMediaUrlAllowed } from "../../../electron/github-activity-frame.mjs";

export const GITHUB_ACTIVITY_APP_ID = LEGACY_MINI_APP_IDS.github_activity;
export const GITHUB_DEEP_DIVE_FIRST_EDITION = "2026-11-20";
const REPO_SEGMENT = /^[a-z0-9_.-]{1,100}$/;
const STRICT_DEMO_BINDINGS = new Map<string, { readonly editionKey: string; readonly repo: string }>([
  ["/github/demo/sqlglot-query-lab/", { editionKey: "2026-11-22", repo: "tobymao/sqlglot" }],
  ["/github/demo/hypothesis-orders/", { editionKey: "2026-11-23", repo: "hypothesisworks/hypothesis" }],
  ["/github/demo/jsonschema-agent-contract/", { editionKey: "2026-11-24", repo: "python-jsonschema/jsonschema" }],
]);

export interface GithubActivitySelection {
  editionKey: string | null;
  repo: string | null;
}

export function isValidIsoDate(iso: unknown): iso is string {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

export function isValidRepoSlug(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const parts = raw.split("/");
  return parts.length === 2
    && REPO_SEGMENT.test(parts[0]!) && parts[0] !== "." && parts[0] !== ".."
    && REPO_SEGMENT.test(parts[1]!) && parts[1] !== "." && parts[1] !== "..";
}

export function parseGithubSelection(raw: unknown): GithubActivitySelection | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const editionKey = record.editionKey ?? null;
  const repo = record.repo ?? null;
  if (editionKey !== null && !isValidIsoDate(editionKey)) return null;
  if (repo !== null && !isValidRepoSlug(repo)) return null;
  if (repo !== null && editionKey === null) return null;
  return { editionKey, repo };
}

export function githubWebUrlForSelection(selection: GithubActivitySelection | null): string {
  if (!selection || !selection.editionKey || selection.editionKey < GITHUB_DEEP_DIVE_FIRST_EDITION) {
    return GITHUB_ACTIVITY_URL;
  }
  const compact = selection.editionKey.replace(/-/g, "");
  const candidate = selection.repo
    ? `https://mxhan.com/github/${compact}/${selection.repo}/`
    : `https://mxhan.com/github/${compact}/`;
  return githubActivityPageAllowed(candidate) ? candidate : GITHUB_ACTIVITY_URL;
}

export function selectionFromGithubPath(
  path: string,
  rawEditionKey?: unknown,
  rawRepo?: unknown,
  messageType: "ready" | "leaving" | "shown" = "ready",
): { ok: true; selection: GithubActivitySelection } | { ok: false } {
  const fullUrl = `https://mxhan.com${path}`;
  if (!githubActivityPageAllowed(fullUrl)) return { ok: false };
  if (rawEditionKey !== undefined && rawEditionKey !== null && !isValidIsoDate(rawEditionKey)) return { ok: false };
  if (rawRepo !== undefined && rawRepo !== null && !isValidRepoSlug(rawRepo)) return { ok: false };
  if (rawRepo !== undefined && rawRepo !== null && rawEditionKey === null) return { ok: false };

  const pathname = new URL(fullUrl).pathname;
  const repoMatch = /^\/github\/(\d{8})\/([^/]+)\/([^/]+)\/$/.exec(pathname);
  if (repoMatch) {
    const editionKey = `${repoMatch[1]!.slice(0, 4)}-${repoMatch[1]!.slice(4, 6)}-${repoMatch[1]!.slice(6, 8)}`;
    const repo = `${repoMatch[2]!}/${repoMatch[3]!}`;
    if (rawEditionKey !== undefined && rawEditionKey !== editionKey) return { ok: false };
    if (rawRepo !== undefined && rawRepo !== repo) return { ok: false };
    return { ok: true, selection: { editionKey, repo } };
  }
  const editionMatch = /^\/github\/(\d{8})\/$/.exec(pathname);
  if (editionMatch) {
    const editionKey = `${editionMatch[1]!.slice(0, 4)}-${editionMatch[1]!.slice(4, 6)}-${editionMatch[1]!.slice(6, 8)}`;
    if (rawEditionKey !== undefined && rawEditionKey !== editionKey) return { ok: false };
    if (rawRepo !== undefined && rawRepo !== null) return { ok: false };
    return { ok: true, selection: { editionKey, repo: null } };
  }
  const demoBinding = STRICT_DEMO_BINDINGS.get(pathname);
  if (demoBinding) {
    if (messageType === "ready") {
      if (rawEditionKey !== demoBinding.editionKey || rawRepo !== demoBinding.repo) return { ok: false };
    } else {
      if (rawEditionKey !== undefined && rawEditionKey !== demoBinding.editionKey) return { ok: false };
      if (rawRepo !== undefined && rawRepo !== demoBinding.repo) return { ok: false };
      if ((rawEditionKey === undefined) !== (rawRepo === undefined)) return { ok: false };
    }
    return { ok: true, selection: { editionKey: demoBinding.editionKey, repo: demoBinding.repo } };
  }
  const fallbackEdition = (rawEditionKey as string | null | undefined) ?? null;
  const fallbackRepo = (rawRepo as string | null | undefined) ?? null;
  if (fallbackRepo !== null && fallbackEdition === null) return { ok: false };
  return { ok: true, selection: { editionKey: fallbackEdition, repo: fallbackRepo } };
}

export function isEligibleGithubActivityDocument(document: MiniAppDocument | null): boolean {
  return !!document
    && (document.app.id === GITHUB_ACTIVITY_APP_ID && document.app.slug === "github-activity"
      || matchesMiniAppReleasePackage("github_activity", document.app.release))
    && document.app.shippedTemplateKind === "github_activity"
    && document.app.status === "active"
    && !document.app.dashboard
    && !document.app.nativeKind;
}

export function githubActivityHostEligible({ selected, document, state, localOwner, nativeGuard }: {
  selected: MiniAppSummary | null;
  document: MiniAppDocument | null;
  state: MiniAppState | null;
  localOwner: boolean;
  nativeGuard: boolean;
}): boolean {
  return localOwner && nativeGuard && selected?.id === GITHUB_ACTIVITY_APP_ID && document?.app.id === GITHUB_ACTIVITY_APP_ID
    && state?.appId === GITHUB_ACTIVITY_APP_ID && selected.status === "active" && document.app.status === "active" && state.status === "active"
    && selected.shippedTemplateKind === "github_activity" && document.app.shippedTemplateKind === "github_activity"
    && selected.slug === "github-activity" && document.app.slug === "github-activity"
    && selected.revision === document.app.revision && state.revision === document.app.revision
    && selected.templateVersion === document.app.templateVersion && state.templateVersion === document.app.templateVersion
    && !selected.dashboard && !document.app.dashboard && !selected.nativeKind && !document.app.nativeKind;
}
