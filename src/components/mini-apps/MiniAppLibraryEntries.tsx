import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { DEFAULT_MINI_APP_KINDS, type DefaultMiniAppKind, type MiniAppDefaultsResult, type MiniAppSummary } from "../../../shared/mini-apps";
import { REPORT_APPS } from "../../../shared/report-mini-app";
import { DASHBOARD_APPS } from "./DashboardInstall";
import { MiniAppIcon, iconKindForApp } from "./MiniAppIcon";
import { miniAppDisplayName } from "./mini-app-display";

export const shippedAppDetails = (kind: DefaultMiniAppKind) => kind === "bookkeeping"
  ? { name: t("computer.miniApps.bookkeepingTitle"), description: t("computer.miniApps.bookkeepingDescription") }
  : kind === "agent-team" || kind === "usage"
    ? { name: t(DASHBOARD_APPS[kind].title), description: t(DASHBOARD_APPS[kind].description) }
    : { name: t(kind === "x_ai_digest" ? "computer.miniApps.report.xTitle" : "computer.miniApps.report.githubTitle"),
      description: REPORT_APPS[kind].description };

export function MiniAppLibraryEntries({ inventory, issues, busyKind, owner, nativeGuard, onOpen, onAdd, onRemove }: {
  inventory: MiniAppSummary[];
  issues: MiniAppDefaultsResult["issues"];
  busyKind: DefaultMiniAppKind | null;
  owner: boolean | null;
  nativeGuard: boolean;
  onOpen(id: string): void;
  onAdd(kind: DefaultMiniAppKind): void;
  onRemove(app: MiniAppSummary): void;
}) {
  const defaultApps = new Set(inventory.filter((app) => iconKindForApp(app) !== null).map((app) => app.id));
  const custom = inventory.filter((app) => !defaultApps.has(app.id));
  return <div data-mini-app-library className="space-y-4">
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-2" aria-label={t("computer.miniApps.catalog.included") }>
      {DEFAULT_MINI_APP_KINDS.map((kind) => {
        const matches = inventory.filter((app) => iconKindForApp(app) === kind);
        const app = matches.length === 1 ? matches[0] : null;
        const name = app ? miniAppDisplayName(app) : shippedAppDetails(kind).name;
        const nativeNeedsGrant = app && (kind === "agent-team" || kind === "usage") && !app.dashboard;
        const canOpen = app?.status === "active" && !nativeNeedsGrant;
        const canAct = owner === true && nativeGuard && matches.length <= 1;
        const issue = issues.find((entry) => entry.kind === kind);
        const state = matches.length > 1 ? "conflict" : !app ? "missing" : app.status === "archived" ? "removed"
          : nativeNeedsGrant ? "needs-access" : "active";
        return <li key={kind} data-mini-app-catalog={kind} data-mini-app-state={state}
          className="flex min-w-0 flex-col items-center rounded-xl bg-inset/60 px-1.5 py-2 text-center">
          <button type="button" data-mini-app-grid-item={kind} disabled={!canAct || busyKind !== null}
            onClick={() => canOpen ? onOpen(app!.id) : onAdd(kind)}
            aria-label={`${t(canOpen ? "computer.miniApps.catalog.open" : "computer.miniApps.catalog.add")} ${name}`}
            title={name} className="flex min-w-0 flex-col items-center gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60">
            <MiniAppIcon kind={kind} launcher />
            <span className="w-full text-[11px] leading-4 text-ink [overflow-wrap:anywhere]">{name}</span>
          </button>
          {busyKind === kind && <Loader2 size={12} className="mt-1 animate-spin text-ink-secondary" aria-hidden="true" />}
          {state !== "active" && <span className="mt-1 text-[10px] leading-3 text-ink-secondary">{t(state === "removed" ? "computer.miniApps.catalog.removed"
            : state === "needs-access" ? "computer.miniApps.catalog.needsAccessShort"
              : state === "conflict" ? "computer.miniApps.catalog.nameInUseShort" : "computer.miniApps.catalog.available")}</span>}
          {issue && <span role="status" className="mt-1 text-[10px] leading-3 text-warning [overflow-wrap:anywhere]">{issue.error}</span>}
          {app?.status === "active" && canAct && <button type="button" data-mini-app-remove={kind} disabled={busyKind !== null}
            onClick={() => onRemove(app!)} aria-label={`${t("computer.miniApps.catalog.remove")} ${name}`}
            className="mt-1 rounded px-1.5 py-0.5 text-[10px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
            {t("computer.miniApps.catalog.remove")}</button>}
        </li>;
      })}
    </ul>
    {custom.length > 0 && <section aria-labelledby="mini-app-custom-title">
      <h3 id="mini-app-custom-title" className="text-[12px] font-semibold text-ink">{t("computer.miniApps.catalog.other")}</h3>
      <ul className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-2">
        {custom.map((app) => <li key={app.id} data-mini-app-custom={app.id} className="flex min-w-0 flex-col items-center rounded-xl bg-inset/60 px-1.5 py-2 text-center">
          <button type="button" data-mini-app-grid-item={app.id} disabled={app.status !== "active" || owner !== true || !nativeGuard || busyKind !== null}
            onClick={() => onOpen(app.id)} aria-label={`${t("computer.miniApps.catalog.open")} ${app.title}`}
            className="flex min-w-0 flex-col items-center gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60">
            <MiniAppIcon kind={null} launcher /><span className="w-full text-[11px] leading-4 text-ink [overflow-wrap:anywhere]">{app.title}</span>
          </button>
          {app.status === "archived" && <span className="mt-1 text-[10px] text-ink-secondary">{t("computer.miniApps.archived")}</span>}
        </li>)}
      </ul>
    </section>}
  </div>;
}
