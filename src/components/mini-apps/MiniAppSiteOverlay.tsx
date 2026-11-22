import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { t } from "@/lib/i18n";
import { usePageVisible } from "@/lib/page-visible";
import { SITE_FRAME_ALLOW, SITE_THUMB_SANDBOX } from "@/lib/published-apps";
import { SiteFrame } from "../published-apps/SiteFrame";
import { dailyXPageAllowed } from "./daily-x-host";
import { selectionFromGithubPath } from "./github-activity-host";
import { clipMiniAppSiteViewport, MINI_APP_REPORT_SITES, MOJO_POETRY_SITE, type MiniAppReportSiteView,
  type MiniAppSiteView } from "./mini-app-site";
import { MOJO_POETRY_FRAME_NAME, MOJO_POETRY_URL } from "./mojo-host";

const READY_TIMEOUT_MS = 10_000;

function ReportSiteFrame({ view, visible }: { view: MiniAppReportSiteView; visible: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { site, opening, attempt, url, signal } = view;
  const { channel, name, title } = MINI_APP_REPORT_SITES[site];
  const origin = new URL(MINI_APP_REPORT_SITES[site].url).origin;
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element || !visible) return;
    let nonce: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    const fail = () => {
      nonce = null;
      clearTimeout(timer);
      failed = true;
      signal("failed");
    };
    const loading = () => {
      clearTimeout(timer);
      timer = setTimeout(fail, READY_TIMEOUT_MS);
      signal("loading");
    };
    const challenge = () => {
      if (failed) return;
      nonce = window.crypto.randomUUID();
      loading();
      element.contentWindow?.postMessage({ [channel]: 1, type: "challenge", nonce }, origin);
    };
    const handle = (event: MessageEvent) => {
      const source = element.contentWindow;
      if (failed || !source || event.source !== source || event.origin !== origin) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object" || data[channel] !== 1 || typeof data.path !== "string"
        || data.path.length > 2048 || !data.path.startsWith("/")) return;
      const type = data.type;
      if (type !== "ready" && type !== "shown" && type !== "leaving") return;
      if (type === "ready" && (!nonce || data.nonce !== nonce)) return;
      const github = site === "github-activity"
        ? selectionFromGithubPath(data.path, data.editionKey, data.repo, type)
        : null;
      if (github ? !github.ok : !dailyXPageAllowed(origin + data.path)) return fail();
      if (type === "shown") challenge();
      else if (type === "leaving") { nonce = null; loading(); }
      else {
        nonce = null;
        clearTimeout(timer);
        signal("ready", github?.ok ? github.selection : undefined);
      }
    };
    element.addEventListener("load", challenge);
    element.addEventListener("error", fail);
    window.addEventListener("message", handle);
    challenge();
    return () => {
      clearTimeout(timer);
      element.removeEventListener("load", challenge);
      element.removeEventListener("error", fail);
      window.removeEventListener("message", handle);
    };
  }, [site, opening, attempt, signal, visible, origin, channel]);

  return <iframe key={attempt} ref={frame} data-mini-app-report-frame={site} src={url} name={name} title={t(title)}
    sandbox="allow-scripts allow-same-origin allow-popups" allow={SITE_FRAME_ALLOW} referrerPolicy="no-referrer"
    className="min-h-0 w-full flex-1 border-0" />;
}

export function MiniAppSiteOverlay({ frameBox, view }: { frameBox: RefObject<HTMLDivElement | null>; view: MiniAppSiteView }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const pageVisible = usePageVisible();

  useLayoutEffect(() => {
    const box = frameBox.current;
    if (!box) return;
    const measure = () => {
      const width = box.clientWidth;
      const height = box.clientHeight;
      setSize((prev) => prev.width === width && prev.height === height ? prev : { width, height });
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(box);
    measure();
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [frameBox]);

  if (!view) return null;
  const bounds = pageVisible && view.viewport ? clipMiniAppSiteViewport(view.viewport, size) : null;
  const mojo = view.site === MOJO_POETRY_SITE;
  const visible = Boolean(bounds) && (mojo || view.phase === "ready");
  return <div hidden={!bounds} inert={!visible} aria-hidden={!visible}
    className={bounds ? `absolute z-10 flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel${visible ? "" : " pointer-events-none invisible"}` : "hidden"}
    style={bounds ?? undefined} data-mini-app-site={view.site}>
    {mojo
      ? <SiteFrame url={MOJO_POETRY_URL} title={t("computer.miniApps.mojo.poetry")} attempt={0}
        sandbox={SITE_THUMB_SANDBOX} frameName={MOJO_POETRY_FRAME_NAME} />
      : <ReportSiteFrame view={view} visible={Boolean(bounds)} />}
  </div>;
}
