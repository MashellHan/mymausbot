import { lazy, Suspense } from "react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ComputerFilesPane } from "./ComputerFilesPane";
import { TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";

const AgentTeamPanel = lazy(() => import("./AgentTeamPanel").then((module) => ({ default: module.AgentTeamPanel })));
const LocalUsagePanel = lazy(() => import("./LocalUsagePanel").then((module) => ({ default: module.LocalUsagePanel })));

export function ComputerPanelInfoTab({ view, bot }: { view: "files" | "agent-team" | "usage"; bot: Bot }) {
  return (
    <div {...tabPanelProps(view)} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
      {view === "files" ? <ComputerFilesPane bot={bot} /> : (
        <Suspense fallback={<div className="flex flex-1 items-center justify-center text-[13px] text-ink-secondary" role="status">{t(view === "agent-team" ? "computer.agentTeam.loading" : "computer.usage.loading")}</div>}>
          {view === "agent-team" ? <AgentTeamPanel /> : <LocalUsagePanel />}
        </Suspense>
      )}
    </div>
  );
}
