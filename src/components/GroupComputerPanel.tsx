import { AppWindow, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { releaseComputerPanelFocus, useComputerPanelEntry } from "@/lib/computer-panel-focus";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { useCaptionChrome } from "./DesktopCapabilities";
import { PANEL_MIN_WIDTH, useComputerPanelResize } from "./computer-panel-resize";
import { panelTabProps, TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";
import { MiniAppsPanel } from "./mini-apps/MiniAppsPanel";

export function GroupComputerPanel({ groupId }: { groupId: string }) {
  const { dispatch } = useStore();
  const { dragProps, noDragStyle } = useCaptionChrome();
  const scope = `group:${groupId}`;
  const panelRef = useComputerPanelEntry(scope, "mini-apps");
  const { panelWidth, panelMaxWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd } = useComputerPanelResize();
  return (
    <aside
      ref={panelRef}
      data-computer-panel
      aria-label={t("botPanel.tab.computer")}
      className={cn(
        "animate-panel-in relative flex h-full shrink-0 flex-col border-l border-hairline/40 bg-panel",
        "max-2xl:absolute max-2xl:inset-y-0 max-2xl:right-0 max-2xl:z-40",
      )}
      style={{ width: panelWidth, maxWidth: panelMaxWidth }}
    >
      <div
        ref={separatorRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("computer.resizeAria")}
        aria-valuemin={Math.min(PANEL_MIN_WIDTH, panelMaxWidth)}
        aria-valuemax={panelMaxWidth}
        aria-valuenow={separatorWidth ?? undefined}
        tabIndex={0}
        onKeyDown={onSeparatorKeyDown}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 focus-visible:bg-accent/60 max-2xl:hidden"
      />
      <div {...dragProps} className="ml-1.5 py-3 pl-2.5 pr-4">
        <div className="relative flex min-h-7 items-center justify-center">
          <div role="tablist" aria-label={t("botPanel.tab.computer")} className="mx-9 rounded-full bg-inset p-1" style={noDragStyle}>
            <button type="button" {...panelTabProps("mini-apps", true)} className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-[12px] font-medium text-ink shadow-sm">
              <AppWindow size={13} aria-hidden="true" /> {t("computer.tab.miniApps")}
            </button>
          </div>
          <button
            type="button"
            data-computer-panel-close
            onClick={() => {
              releaseComputerPanelFocus(panelRef.current, scope);
              dispatch({ type: "toggleComputer", open: false });
            }}
            style={noDragStyle}
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            aria-label={t("common.close")}
            title={t("common.close")}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div {...tabPanelProps("mini-apps")} className={cn("flex min-h-0 flex-1 flex-col", TAB_PANEL_FOCUS)}>
        <MiniAppsPanel />
      </div>
    </aside>
  );
}
