import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { PanelFilePreview } from "@/lib/file-preview";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";
import { LibraryTab } from "./bot-panel/LibraryTab";
import { PAGES, type SimplePageId } from "./bot-panel/page-registry";
import { PageBody, pageSurfaceCls } from "./bot-panel/pages";
import { PageHeader } from "./bot-panel/rows";
import { TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";

const MiniAppsPanel = lazy(() => import("./mini-apps/MiniAppsPanel").then((module) => ({ default: module.MiniAppsPanel })));

function FilesWithLibrary({ bot, filePreview, onPreviewClose }: { bot: Bot; filePreview?: PanelFilePreview | null; onPreviewClose?: () => void }) {
  const derived = useBotSettingsDerived(bot);
  const [page, setPage] = useState<SimplePageId | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { if (filePreview) setPage(null); }, [filePreview]);
  const openPage = (next: SimplePageId) => {
    setPage(next);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-panel-back]")?.focus());
  };
  const back = () => {
    const previous = page;
    setPage(null);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-panel-page="${previous}"]`)?.focus());
  };
  return <div ref={root} className="flex min-h-0 flex-1 flex-col">
    {page ? <div data-panel-page-view={page} className="min-h-0 flex-1 overflow-y-auto px-4 pb-5">
      <PageHeader back={t("computer.tab.files")} title={t(PAGES[page].title, { name: bot.name })}
        intro={PAGES[page].intro ? t(PAGES[page].intro, { name: bot.name }) : undefined} onBack={back} />
      <div className={cn("mt-4", pageSurfaceCls)}><PageBody page={page} bot={bot} derived={derived} onOpen={openPage} /></div>
    </div> : <>
      <div className={cn("flex min-h-0 flex-col overflow-hidden", filePreview?.botId === bot.id && "flex-1")}>
        <ComputerFilesPane bot={bot} filePreview={filePreview} onPreviewClose={onPreviewClose} showFolder={false} bounded />
      </div>
      {!filePreview && <div data-testid="files-library-links" className="max-h-[42%] shrink-0 overflow-y-auto border-t border-hairline/50 px-4 pb-5">
        <LibraryTab bot={bot} onOpen={openPage} embedded />
      </div>}
    </>}
  </div>;
}

export function ComputerPanelInfoTab({ view, bot, filePreview, onPreviewClose, requestedApp }: {
  view: "files" | "mini-apps"; bot: Bot; filePreview?: PanelFilePreview | null; onPreviewClose?: () => void;
  requestedApp?: { id: string; nonce: number };
}) {
  return (
    <div {...tabPanelProps(view)} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
      {view === "files" && <FilesWithLibrary key={bot.id} bot={bot} filePreview={filePreview} onPreviewClose={onPreviewClose} />}
      {view === "mini-apps" && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("computer.miniApps.loading")}</div>}>
        <MiniAppsPanel requestedApp={requestedApp} />
      </Suspense>}
    </div>
  );
}
