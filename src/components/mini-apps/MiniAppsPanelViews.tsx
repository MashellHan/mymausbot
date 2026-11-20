import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { ChevronDown, ChevronUp, History, Loader2, RotateCw } from "lucide-react";
import { activeLocale, t } from "@/lib/i18n";
import type { DefaultMiniAppKind, MiniAppDocument, MiniAppState, MiniAppSummary } from "../../../shared/mini-apps";
import { revealSelectedTab, scrollTabsWithWheel } from "../computer-panel-tabs";
import { InfoHint } from "../InfoHint";
import { DailyXWholePage } from "./DailyXWholePage";
import { GitHubActivityWholePage } from "./GitHubActivityWholePage";
import { HongguoView } from "./HongguoView";
import { MiniAppDashboard } from "./MiniAppDashboard";
import { MiniAppFrame } from "./MiniAppFrame";
import { MiniAppIcon, iconKindForApp } from "./MiniAppIcon";
import { MojoWholePage } from "./MojoWholePage";
import { dailyXHostEligible } from "./daily-x-host";
import { githubActivityHostEligible } from "./github-activity-host";
import { hongguoText } from "./hongguo-copy";
import { isManagedHongguoDocument } from "./hongguo-frame-host";
import { miniAppDisplayDescription, miniAppDisplayName } from "./mini-app-display";
import { managedMiniAppSite } from "./mini-app-site";
import { readAppReleaseMeta, shortCommit, type MiniAppUpdateInfo } from "./mini-app-update";
import { mojoHostEligible } from "./mojo-host";

function stamp(value: number): string {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(activeLocale()) : t("computer.miniApps.timeUnavailable");
}

export function MiniAppsHeader({ apps, selected, selectedId, selectedUpdate, barCollapsed, archivedKind, actionsBusy, checking,
  canRestore, libraryPopover, tabListRef, choose, toggleBar, onAddArchived, onRefresh, onRestorePrevious }: {
  apps: MiniAppSummary[] | null;
  selected: MiniAppSummary | null;
  selectedId: string | null;
  selectedUpdate: MiniAppUpdateInfo | null;
  barCollapsed: boolean;
  archivedKind: DefaultMiniAppKind | null;
  actionsBusy: boolean;
  checking: boolean;
  canRestore: boolean;
  libraryPopover: ReactNode;
  tabListRef: RefObject<HTMLDivElement | null>;
  choose(id: string): void;
  toggleBar(): void;
  onAddArchived(): void;
  onRefresh(): void;
  onRestorePrevious(): void;
}) {
  const onNavKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !apps?.length) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = buttons.findIndex((button) => button === event.target);
    if (at < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : event.key === "ArrowRight" ? (at + 1) % buttons.length : event.key === "ArrowLeft" ? (at - 1 + buttons.length) % buttons.length : -1;
    if (next < 0) return;
    event.preventDefault();
    const button = buttons[next]!;
    choose(button.dataset.appId!);
    button.focus();
    revealSelectedTab(event.currentTarget);
  };

  return (
    <header className={`shrink-0 border-b border-hairline/50 px-4 ${barCollapsed ? "py-2" : "pb-3 pt-2"}`}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="shrink-0 text-[15px] font-semibold text-ink">{t("computer.miniApps.heading")}</h2>
          {barCollapsed && selected && <button id={`mini-app-tab-${selected.id}`} data-mini-app-collapsed-current data-app-id={selected.id} type="button"
            onClick={toggleBar} title={miniAppDisplayName(selected)}
            className="flex min-w-0 items-center gap-1.5 rounded-lg bg-control px-2 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
            <MiniAppIcon kind={iconKindForApp(selected)} app={selected} />
            <span className="truncate">{miniAppDisplayName(selected)}</span>
          </button>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {archivedKind
            && <button type="button" data-mini-app-add className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              onClick={onAddArchived}>{t("computer.miniApps.add")}</button>}
          {apps && barCollapsed && libraryPopover}
          {canRestore && selected && <button type="button" data-mini-app-restore-version
            disabled={actionsBusy}
            aria-label={t("computer.miniApps.update.restorePrevious")} title={t("computer.miniApps.update.restorePrevious")}
            onClick={onRestorePrevious}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
            <History size={15} aria-hidden="true" />
          </button>}
          <button type="button" disabled={checking || actionsBusy} aria-label={t("computer.miniApps.refresh")} title={t("computer.miniApps.refresh")} onClick={onRefresh} className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"><RotateCw size={15} aria-hidden="true" /></button>
          {apps && <button type="button" data-mini-app-bar-toggle aria-expanded={!barCollapsed} aria-controls="mini-apps-bar"
            aria-label={t(barCollapsed ? "computer.miniApps.expandApps" : "computer.miniApps.collapseApps")}
            title={t(barCollapsed ? "computer.miniApps.expandApps" : "computer.miniApps.collapseApps")}
            onClick={toggleBar}
            className="rounded-lg p-1.5 text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">
            {barCollapsed ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
          </button>}
        </div>
      </div>
      {apps && !barCollapsed && <div id="mini-apps-bar" className="mt-2 flex min-w-0 items-center gap-2">
        {apps.length ? <div ref={tabListRef} role="tablist" aria-label={t("computer.miniApps.chooseApp")} onKeyDown={onNavKey} onWheel={scrollTabsWithWheel} className="flex min-w-0 flex-1 flex-nowrap gap-1 overflow-x-auto pb-1 [scrollbar-width:thin]">
          {apps.map((app) => <div key={app.id} className="relative w-[104px] shrink-0">
            <button id={`mini-app-tab-${app.id}`} data-app-id={app.id} type="button" role="tab" aria-selected={app.id === selectedId} aria-controls="mini-app-content" tabIndex={app.id === selectedId ? 0 : -1} onClick={() => choose(app.id)}
            aria-label={miniAppDisplayName(app)} title={miniAppDisplayName(app)}
            className={`flex w-full flex-col items-center gap-1 rounded-xl px-1.5 py-2 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-accent ${app.id === selectedId ? "bg-control text-ink" : "text-ink-secondary hover:bg-inset hover:text-ink"}`}>
              <MiniAppIcon kind={iconKindForApp(app)} app={app} launcher /><span className="line-clamp-2 min-h-8 w-full text-center leading-4">{miniAppDisplayName(app)}</span>
            </button>
            {app.id === selectedId && (() => {
              const release = readAppReleaseMeta(app, selectedUpdate);
              return <InfoHint className="absolute end-0 top-1" label={`${miniAppDisplayName(app)}: ${t("app.info")}`}>
                <p>{miniAppDisplayDescription(app)}</p>
                {release.version && <p data-mini-app-release-version className="tabular-nums text-ink-secondary">{t("computer.miniApps.update.installedVersion", { version: release.version })}</p>}
                {release.sourceCommit && <p data-mini-app-source-commit title={release.sourceCommit} className="tabular-nums text-ink-secondary">{t("computer.miniApps.update.sourceCommit", { commit: shortCommit(release.sourceCommit) })}</p>}
                {selectedUpdate?.status === "incompatible" && <p className="text-ink-secondary">{t("computer.miniApps.update.incompatible")}</p>}
                {selectedUpdate?.status === "custom" && <p className="text-ink-secondary">{t("computer.miniApps.update.custom")}</p>}
                <p className="tabular-nums text-ink-secondary">{t("computer.miniApps.published", { time: stamp(app.updatedAt) })}</p>
              </InfoHint>;
            })()}
          </div>)}
        </div> : <div className="min-w-0 flex-1" />}
        {libraryPopover}
      </div>}
    </header>
  );
}

export function MiniAppContent({ selected, document, appState, owner, nativeGuard, currentHead, stale, storageKey, frameEpoch,
  refreshKey, error, addDefault, revoked, changed, handleRuntimeReady }: {
  selected: MiniAppSummary;
  document: MiniAppDocument | null;
  appState: MiniAppState | null;
  owner: boolean | null;
  nativeGuard: boolean;
  currentHead: boolean;
  stale: boolean;
  storageKey: string | null;
  frameEpoch: number;
  refreshKey: number;
  error: string;
  addDefault(kind: DefaultMiniAppKind): Promise<void>;
  revoked(): void;
  changed(): void;
  handleRuntimeReady(info: { appId: string; revision: number; templateVersion: number }): void;
}) {
  const dashboard = document?.app.dashboard;
  const dashboardCurrent = currentHead && !!selected && !!dashboard && owner === true && nativeGuard
    && selected.dashboard?.kind === dashboard.kind && dashboard.renderer === "native" && dashboard.htmlRole === "fallback-only";
  const teamHtmlCurrent = currentHead && owner === true && nativeGuard && selected?.dashboard?.kind === "agent-team"
    && selected.dashboard.renderer === "html" && document?.app.dashboard?.kind === "agent-team"
    && document.app.dashboard.renderer === "html" && document.app.dashboardIdentity === "agent-team";
  const usageHtmlCurrent = currentHead && owner === true && nativeGuard && window.ogb?.app?.ownPage === true
    && window.ogb?.remoteClient?.active !== true && selected?.dashboardIdentity === "usage"
    && selected.dashboard?.kind === "usage" && selected.dashboard.renderer === "html"
    && document?.app.dashboardIdentity === "usage" && dashboard?.kind === "usage" && dashboard.renderer === "html"
    && document.bindings.length === 0 && appState?.data.length === 0;
  const recoveryKind = currentHead && selected && document && !dashboard && !selected.dashboard && selected.dashboardIdentity
    && document.app.dashboardIdentity === selected.dashboardIdentity ? selected.dashboardIdentity : null;
  const dashboardInstalled = !!(selected?.dashboardIdentity || document?.app.dashboardIdentity || selected?.dashboard || dashboard);
  const nativeInstalled = !!(selected?.nativeIdentity || document?.app.nativeIdentity || selected?.nativeKind || document?.app.nativeKind);
  const hongguoCurrent = currentHead && owner === true && selected?.nativeIdentity === "hongguo" && document?.app.nativeIdentity === "hongguo"
    && selected?.nativeKind === "hongguo" && document?.app.nativeKind === "hongguo";
  const managedScope = !stale && currentHead && owner === true && nativeGuard && window.ogb?.app?.ownPage === true
    && window.ogb?.remoteClient?.active !== true;
  const managedSite = managedScope ? managedMiniAppSite(document) : undefined;
  const managedHongguo = managedScope && hongguoCurrent && isManagedHongguoDocument(document);
  const hongguoRecovery = currentHead && owner === true && selected?.nativeIdentity === "hongguo" && document?.app.nativeIdentity === "hongguo"
    && !selected?.nativeKind && !document?.app.nativeKind;
  const mojoCurrent = !stale && mojoHostEligible({ selected, document, state: appState,
    localOwner: owner === true && typeof window !== "undefined" && window.ogb?.remoteClient?.active !== true, nativeGuard });
  const dailyXCurrent = !stale && dailyXHostEligible({ selected, document, state: appState,
    localOwner: owner === true && typeof window !== "undefined" && window.ogb?.app?.ownPage === true
      && window.ogb?.remoteClient?.active !== true, nativeGuard });
  const githubActivityCurrent = !stale && githubActivityHostEligible({ selected, document, state: appState,
    localOwner: owner === true && typeof window !== "undefined" && window.ogb?.app?.ownPage === true
      && window.ogb?.remoteClient?.active !== true, nativeGuard });


  return (
    <div id="mini-app-content" role="tabpanel" aria-labelledby={`mini-app-tab-${selected.id}`} tabIndex={0} className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:outline-2 focus-visible:outline-accent">
      {document && appState ? <>
        {managedSite || managedHongguo
          ? <MiniAppFrame key={`${document.app.id}:${frameEpoch}`} document={document} state={appState}
            site={managedSite} hongguo={managedHongguo} refreshKey={refreshKey} onRevoked={revoked} onChanged={changed} onRuntimeReady={handleRuntimeReady} />
          : appState.status === "active" && nativeGuard && nativeInstalled ? hongguoCurrent
          ? <HongguoView key={JSON.stringify([storageKey, document.app.id, document.app.revision])} document={document} state={appState}
            storageKey={storageKey} refreshKey={refreshKey} onRevoked={revoked} onChanged={changed} />
          : hongguoRecovery ? <section lang="zh-CN" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary" data-testid="hongguo-recovery">
            <p>{hongguoText("computer.miniApps.dashboard.recovery")}</p>
            <button type="button" onClick={() => void addDefault("hongguo")}
              className="mt-3 rounded-lg bg-control px-3 py-1.5 font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">{hongguoText("computer.miniApps.dashboard.reauthorize")}</button>
          </section>
          : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t(owner === true ? "computer.miniApps.changedDuringRead" : "computer.miniApps.accessEnded")}</p>
          : appState.status === "active" && nativeGuard && dashboardInstalled ? dashboardCurrent
          ? <MiniAppDashboard key={`${document.app.id}:${document.app.revision}`} document={document} state={appState} refreshKey={refreshKey} onRevoked={revoked} onChanged={changed} />
          : teamHtmlCurrent || usageHtmlCurrent ? <MiniAppFrame key={`${document.app.id}:${frameEpoch}`} document={document} state={appState} onRevoked={revoked} onChanged={changed} onRuntimeReady={handleRuntimeReady} />
          : recoveryKind && owner === true ? <section className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary" data-testid="dashboard-recovery">
            <p>{t("computer.miniApps.dashboard.recovery")}</p>
            <button type="button" onClick={() => void addDefault(recoveryKind)} className="mt-3 rounded-lg bg-control px-3 py-1.5 font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">{t("computer.miniApps.dashboard.reauthorize")}</button>
          </section>
          : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t(owner === null ? "computer.miniApps.opening" : owner === true ? "computer.miniApps.changedDuringRead" : "computer.miniApps.accessEnded")}</p>
          : appState.status === "active" && nativeGuard ? mojoCurrent
            ? <MojoWholePage key={`${document.app.id}:${document.app.revision}:${document.app.templateVersion}`}
              document={document} state={appState} onRevoked={revoked} />
            : dailyXCurrent ? <DailyXWholePage key={`${document.app.id}:${document.app.revision}:${document.app.templateVersion}`}
              document={document} state={appState} onRevoked={revoked} />
            : githubActivityCurrent ? <GitHubActivityWholePage key={`${document.app.id}:${document.app.revision}:${document.app.templateVersion}`}
              document={document} state={appState} onRevoked={revoked} />
            : <MiniAppFrame key={`${document.app.id}:${frameEpoch}`} document={document} state={appState} onRevoked={revoked} onRuntimeReady={handleRuntimeReady} />
          : appState.status === "active" ? <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>
          : <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.archivedContent")}</p>}
      </> : !error && <p role="status" className="flex items-center gap-2 px-4 py-8 text-[13px] text-ink-secondary"><Loader2 size={15} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.opening")}</p>}
    </div>
  );
}
