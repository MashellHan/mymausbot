import { lazy, Suspense } from "react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";

const MiniAppsPanel = lazy(() => import("./mini-apps/MiniAppsPanel").then((module) => ({ default: module.MiniAppsPanel })));

export function ComputerPanelInfoTab({ view, bot }: { view: "files" | "mini-apps"; bot: Bot }) {
  return (
    <div {...tabPanelProps(view)} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
      {view === "files" && <ComputerFilesPane bot={bot} />}
      {view === "mini-apps" && <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t("computer.miniApps.loading")}</div>}>
        <MiniAppsPanel />
      </Suspense>}
    </div>
  );
}
