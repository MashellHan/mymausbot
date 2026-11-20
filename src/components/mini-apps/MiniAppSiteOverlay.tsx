import { useLayoutEffect, useState, type RefObject } from "react";
import { t } from "@/lib/i18n";
import { SITE_THUMB_SANDBOX } from "@/lib/published-apps";
import { SiteFrame } from "../published-apps/SiteFrame";
import { clipMiniAppSiteViewport, type MiniAppSiteView } from "./mini-app-site";
import { MOJO_POETRY_FRAME_NAME, MOJO_POETRY_URL } from "./mojo-host";

export function MiniAppSiteOverlay({ frameBox, view }: { frameBox: RefObject<HTMLDivElement | null>; view: MiniAppSiteView }) {
  const [size, setSize] = useState({ width: 0, height: 0 });

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

  if (view === undefined) return null;
  const bounds = view && clipMiniAppSiteViewport(view, size);
  return <div hidden={!bounds} inert={!bounds} className={bounds ? "absolute z-10 flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel" : "hidden"}
    style={bounds ?? undefined} data-mini-app-site={MOJO_POETRY_FRAME_NAME}>
    <SiteFrame url={MOJO_POETRY_URL} title={t("computer.miniApps.mojo.poetry")} attempt={0}
      sandbox={SITE_THUMB_SANDBOX} frameName={MOJO_POETRY_FRAME_NAME} />
  </div>;
}
