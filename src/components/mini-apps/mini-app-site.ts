export const MOJO_POETRY_SITE = "mojo-poetry";
export const MOJO_POETRY_CAPABILITY = "mojo-poetry-v1";

export function releaseUsesMojoPoetry(release: { packageId: string; requires: readonly string[] } | null | undefined): boolean {
  return release?.packageId === "mashellhan.mojo" && release.requires.includes(MOJO_POETRY_CAPABILITY);
}

export type MiniAppSiteViewport = { x: number; y: number; width: number; height: number };
export type MiniAppSiteView = MiniAppSiteViewport | null | undefined;

const MAX_VIEWPORT_PX = 32_768;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
  && Math.abs(value) <= MAX_VIEWPORT_PX;
const record = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === "object" && !Array.isArray(value);

function parseViewport(value: unknown): MiniAppSiteView {
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
  isCurrent(): boolean;
  onView(view: MiniAppSiteView): void;
}) {
  let retired = false;
  let view: MiniAppSiteView;
  const retire = () => {
    retired = true;
    if (view === undefined) return;
    view = undefined;
    options.onView(view);
  };
  const checkCurrent = () => {
    if (!retired && !options.isCurrent()) retire();
    return !retired;
  };
  return {
    checkCurrent,
    retire,
    receive(event: MessageEvent, iframe: HTMLIFrameElement | null, initialized: boolean) {
      const { data } = event;
      if (!record(data) || data.mausMiniApp !== 1 || data.type !== "site-show") return false;
      const frame = iframe?.contentWindow;
      if (!iframe || !frame || event.source !== frame || event.origin !== "null") return true;
      const current = checkCurrent();
      const { id } = data;
      if (typeof id !== "string" || !id || id.length > 100) return true;
      const viewport = parseViewport(data.viewport);
      if (!current || !initialized || data.site !== MOJO_POETRY_SITE
        || Object.keys(data).length !== 5 || !["mausMiniApp", "type", "id", "site", "viewport"].every((key) => Object.hasOwn(data, key))
        || viewport === undefined || (viewport && !clipMiniAppSiteViewport(viewport, { width: iframe.clientWidth, height: iframe.clientHeight }))) {
        frame.postMessage({ mausMiniApp: 1, type: "site-result", id, error: "This site is unavailable." }, "*");
        return true;
      }
      if (viewport !== null || view !== undefined) {
        view = viewport;
        options.onView(view);
      }
      frame.postMessage({ mausMiniApp: 1, type: "site-result", id }, "*");
      return true;
    },
  };
}
