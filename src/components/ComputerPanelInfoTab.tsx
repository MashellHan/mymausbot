import { lazy, Suspense } from "react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { PanelFilePreview } from "@/lib/file-preview";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";

const MiniAppsPanel = lazy(() => import("./mini-apps/MiniAppsPanel").then((module) => ({ default: module.MiniAppsPanel })));

export function ComputerPanelInfoTab({ view, bot, filePreview, onPreviewClose }: {
  view: "files" | "mini-apps"; bot: Bot; filePreview?: PanelFilePreview | null; onPreviewClose?: () => void;
}) {
  return (
    <div {...tabPanelProps(view)} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
      {view === "files" && <ComputerFilesPane bot={bot} filePreview={filePreview} onPreviewClose={onPreviewClose} />}
      {view === "mini-apps" && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("computer.miniApps.loading")}</div>}>
        <MiniAppsPanel />
      </Suspense>}
    </div>
  );
}
