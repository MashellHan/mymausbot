import { matchesMiniAppReleasePackage } from "../../../shared/mini-app-release-packages";
import type { MiniAppDocument } from "../../../shared/mini-apps";
import { DAILY_X_FRAME_NAME, DAILY_X_URL } from "./daily-x-host";
import { GITHUB_ACTIVITY_FRAME_NAME, GITHUB_ACTIVITY_URL, githubWebUrlForSelection, type GithubActivitySelection } from "./github-activity-host";

export const MOJO_POETRY_SITE = "mojo-poetry";
export const MINI_APP_REPORT_SITES = {
  "daily-x": { channel: "xreport", name: DAILY_X_FRAME_NAME, title: "computer.miniApps.report.xTitle", url: DAILY_X_URL },
  "github-activity": { channel: "githubDeepDive", name: GITHUB_ACTIVITY_FRAME_NAME, title: "computer.miniApps.report.githubTitle", url: GITHUB_ACTIVITY_URL },
} as const;
export type MiniAppReportSite = keyof typeof MINI_APP_REPORT_SITES;
export type MiniAppSite = typeof MOJO_POETRY_SITE | MiniAppReportSite;

export function miniAppReleaseSite(release: { packageId: string; requires: readonly string[] } | null | undefined): MiniAppSite | undefined {
  if (matchesMiniAppReleasePackage("mojo", release)) return MOJO_POETRY_SITE;
  if (matchesMiniAppReleasePackage("x_ai_digest", release)) return "daily-x";
  if (matchesMiniAppReleasePackage("github_activity", release)) return "github-activity";
  return undefined;
}

export function managedMiniAppSite(document: MiniAppDocument | null): MiniAppSite | undefined {
  const app = document?.app;
  if (!app || app.status !== "active" || app.dashboardIdentity || app.dashboard || app.nativeIdentity || app.nativeKind) return undefined;
  const site = miniAppReleaseSite(app.release);
  if (site === MOJO_POETRY_SITE && app.shippedTemplateKind === "mojo" && !document.bindings.length) return site;
  if (site === "daily-x" && app.shippedTemplateKind === "x_ai_digest" && document.bindings.length) return site;
  if (site === "github-activity" && app.shippedTemplateKind === "github_activity" && document.bindings.length) return site;
  return undefined;
}

export type MiniAppSiteViewport = { x: number; y: number; width: number; height: number };
export type MiniAppReportSitePhase = "loading" | "ready" | "failed";
export type MiniAppReportSiteView = {
  site: MiniAppReportSite;
  viewport: MiniAppSiteViewport | null;
  phase: MiniAppReportSitePhase;
  opening: number;
  attempt: number;
  url: string;
  signal(phase: MiniAppReportSitePhase, selection?: GithubActivitySelection): void;
};
export type MiniAppSiteView = { site: typeof MOJO_POETRY_SITE; viewport: MiniAppSiteViewport | null } | MiniAppReportSiteView | undefined;

function sameSelection(a: GithubActivitySelection | null, b: GithubActivitySelection | null): boolean {
  return a?.editionKey === b?.editionKey && a?.repo === b?.repo;
}

const MAX_VIEWPORT_PX = 32_768;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
  && Math.abs(value) <= MAX_VIEWPORT_PX;
const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === "object" && !Array.isArray(value);

function parseViewport(value: unknown): MiniAppSiteViewport | null | undefined {
  if (value === null) return null;
  if (!record(value) || Object.keys(value).length !== 4
    || !["x", "y", "width", "height"].every((key) => Object.hasOwn(value, key))) return undefined;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

export function clipMiniAppSiteViewport(viewport: MiniAppSiteViewport, frame: { width: number; height: number }) {
  const left = Math.max(0, viewport.x);
  const top = Math.max(0, viewport.y);
  const width = Math.min(frame.width, viewport.x + viewport.width) - left;
  const height = Math.min(frame.height, viewport.y + viewport.height) - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

export function createMiniAppSitePresentation(options: {
  site: MiniAppSite;
  isCurrent(): boolean;
  onView(view: MiniAppSiteView): void;
  onGithubSelection?(selection: GithubActivitySelection): void;
}) {
  let retired = false;
  let view: MiniAppSiteView;
  let githubSelection: GithubActivitySelection | null = null;
  let webGithubSelection: GithubActivitySelection | null = null;
  const setView = (next: MiniAppSiteView) => { view = next; options.onView(next); };
  const retire = () => {
    retired = true;
    if (view) setView(undefined);
  };
  const checkCurrent = () => {
    if (!retired && !options.isCurrent()) retire();
    return !retired;
  };
  return {
    checkCurrent,
    retire,
    setGithubSelection(selection: GithubActivitySelection) {
      if (options.site !== "github-activity" || !checkCurrent() || view?.viewport) return false;
      githubSelection = selection;
      return true;
    },
    receive(event: MessageEvent, iframe: HTMLIFrameElement | null, initialized: boolean) {
      const { data } = event;
      if (!record(data) || data.mausMiniApp !== 1 || data.type !== "site-show") return false;
      const frame = iframe?.contentWindow;
      if (!iframe || !frame || event.source !== frame || event.origin !== "null") return true;
      const current = checkCurrent();
      const { id } = data;
      if (typeof id !== "string" || !id || id.length > 100) return true;
      const viewport = parseViewport(data.viewport);
      const { site } = options;
      const keys = ["mausMiniApp", "type", "id", "site", "viewport"];
      if (site !== MOJO_POETRY_SITE) {
        keys.push("opening");
        if (data.retry === true) keys.push("retry");
      }
      const deny = () => {
        frame.postMessage({ mausMiniApp: 1, type: "site-result", id, error: "This site is unavailable." }, "*");
        return true;
      };
      if (!current || !initialized || data.site !== site
        || Object.keys(data).length !== keys.length || !keys.every((key) => Object.hasOwn(data, key))
        || viewport === undefined) {
        return deny();
      }
      const { clientWidth: width, clientHeight: height } = iframe;
      if (viewport && (iframe.ownerDocument.visibilityState === "hidden" || width <= 0 || height <= 0)) {
        if (!view?.viewport || (view.site !== MOJO_POETRY_SITE && (data.opening !== view.opening || data.retry))) return deny();
        setView({ ...view, viewport });
        frame.postMessage({ mausMiniApp: 1, type: "site-result", id }, "*");
        return true;
      }
      if (viewport && !clipMiniAppSiteViewport(viewport, { width, height })) return deny();
      if (site === MOJO_POETRY_SITE) {
        if (viewport || view) setView({ site, viewport });
      } else {
        const { opening, retry } = data;
        if (typeof opening !== "number" || !Number.isSafeInteger(opening) || opening <= 0) return deny();
        const previous = view?.site === site ? view : undefined;
        if (previous?.opening === opening) {
          if (retry || (viewport && !previous.viewport)) return deny();
          setView({ ...previous, viewport });
        } else {
          if (!viewport || opening < (previous?.opening ?? 0)) return deny();
          const selectionChanged = site === "github-activity" && !sameSelection(githubSelection, webGithubSelection);
          const reload = !previous || retry === true || previous.phase === "failed" || selectionChanged;
          const attempt = (previous?.attempt ?? 0) + Number(reload);
          const url = reload
            ? site === "github-activity" ? githubWebUrlForSelection(githubSelection) : DAILY_X_URL
            : previous.url;
          const signal: MiniAppReportSiteView["signal"] = (phase, selection) => {
            if (iframe.contentWindow !== frame || !checkCurrent() || view?.site !== site || view.opening !== opening
              || !view.viewport || view.phase === "failed") return;
            if (view.phase !== phase) {
              setView({ ...view, phase });
              frame.postMessage({ mausMiniApp: 1, type: "site-status", site, opening, phase }, "*");
            }
            if (site === "github-activity" && phase === "ready" && selection) {
              const changed = !sameSelection(githubSelection, selection);
              githubSelection = webGithubSelection = selection;
              if (changed) options.onGithubSelection?.(selection);
            }
          };
          setView({ site, opening, attempt, url, viewport, phase: "loading", signal });
        }
      }
      frame.postMessage({ mausMiniApp: 1, type: "site-result", id }, "*");
      return true;
    },
  };
}
