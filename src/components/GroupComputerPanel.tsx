import { useState } from "react";
import { AppWindow, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { releaseComputerPanelFocus, useComputerPanelEntry } from "@/lib/computer-panel-focus";
import { t } from "@/lib/i18n";
import { normalizeState } from "@/lib/mascot";
import { effectivePlace, placeLabelKey } from "@/lib/place";
import { useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ComputerPanel } from "./ComputerPanel";
import { useCaptionChrome } from "./DesktopCapabilities";
import { COMPUTER_PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, useComputerPanelResize } from "./computer-panel-resize";
import { panelTabProps, TAB_PANEL_FOCUS, tabPanelProps } from "./computer-panel-tabs";
import { MiniAppsPanel } from "./mini-apps/MiniAppsPanel";
import { Select } from "./Select";

function defaultTargetBot(
  members: readonly Bot[],
  busyBotId: string | undefined,
  defaultResponder: { kind: string; botId?: string } | undefined,
): Bot | null {
  if (!members.length) return null;
  if (busyBotId) {
    const busy = members.find((member) => member.id === busyBotId);
    if (busy) return busy;
  }
  if (defaultResponder?.kind === "member" && defaultResponder.botId) {
    const lead = members.find((member) => member.id === defaultResponder.botId);
    if (lead) return lead;
  }
  return members[0] ?? null;
}

function EmptyGroupComputerPanel({
  scope,
  panelWidth: sharedPanelWidth,
  onPanelWidthChange,
}: {
  scope: string;
  panelWidth?: number;
  onPanelWidthChange?: (width: number) => void;
}) {
  const { dispatch } = useStore();
  const { dragProps, noDragStyle } = useCaptionChrome();
  const panelRef = useComputerPanelEntry(scope, "mini-apps");
  const { panelWidth, panelMaxWidth, separatorRef, separatorWidth, onSeparatorKeyDown, onResizeStart, onResizeMove, onResizeEnd } = useComputerPanelResize({
    defaultWidth: COMPUTER_PANEL_DEFAULT_WIDTH,
    width: sharedPanelWidth,
    onWidthChange: onPanelWidthChange,
  });
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

export function GroupComputerPanel({
  groupId,
  panelWidth: sharedPanelWidth,
  onPanelWidthChange,
  onOpenVmWorkspace,
}: {
  groupId: string;
  panelWidth?: number;
  onPanelWidthChange?: (width: number) => void;
  onOpenVmWorkspace?: (botId: string) => void;
}) {
  const { state } = useStore();
  const scope = `group:${groupId}`;
  const group = state.groups.find((entry) => entry.id === groupId);
  const members = group
    ? group.memberIds
        .map((id) => state.bots.find((bot) => bot.id === id))
        .filter((bot): bot is Bot => Boolean(bot))
    : [];
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const selectedMember = selectedBotId ? members.find((member) => member.id === selectedBotId) ?? null : null;
  const targetBot = selectedMember ?? defaultTargetBot(members, group?.busyBotId ?? undefined, group?.defaultResponder);

  if (!targetBot) {
    return (
      <EmptyGroupComputerPanel
        scope={scope}
        panelWidth={sharedPanelWidth}
        onPanelWidthChange={onPanelWidthChange}
      />
    );
  }

  const targetPlace = effectivePlace(targetBot, targetBot.tasks?.find((task) => task.threadId === group?.threadId));
  return (
    <ComputerPanel
      key={`${scope}:${targetBot.id}`}
      bot={targetBot}
      focusScopeId={scope}
      viewScopeId={scope}
      defaultView="mini-apps"
      showBotSettings={false}
      ariaLabel={t("botPanel.tab.computer")}
      panelWidth={sharedPanelWidth}
      onPanelWidthChange={onPanelWidthChange}
      onOpenVmWorkspace={onOpenVmWorkspace}
      groupTarget={
        <div
          data-testid="group-computer-target"
          className="mx-4 mb-2 flex items-center justify-between gap-2 rounded-xl border border-hairline/50 bg-card/60 px-3 py-1.5 text-[12px]"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-ink-secondary">{t("room.computer.target")}</span>
            <BotAvatar bot={targetBot} state={normalizeState(targetBot.mascotExpression) ?? "happy"} size={18} animated={false} />
            {members.length > 1 ? (
              <Select
                variant="pill"
                size="sm"
                aria-label={t("room.computer.targetSelectAria")}
                value={targetBot.id}
                onChange={(event) => setSelectedBotId(event.target.value)}
                className="max-w-[240px]"
              >
                {members.map((member) => {
                  const place = effectivePlace(member, member.tasks?.find((task) => task.threadId === group?.threadId));
                  return (
                    <option key={member.id} value={member.id}>
                      {member.name} · {t(placeLabelKey(place))}
                    </option>
                  );
                })}
              </Select>
            ) : (
              <span className="truncate font-medium text-ink">{targetBot.name}</span>
            )}
          </div>
          <span className="shrink-0 text-ink-secondary">{t(placeLabelKey(targetPlace))}</span>
        </div>
      }
    />
  );
}
