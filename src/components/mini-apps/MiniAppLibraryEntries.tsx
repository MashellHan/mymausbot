import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { LEGACY_MINI_APP_IDS } from "../../../shared/mini-app-release-packages";
import { DEFAULT_MINI_APP_KINDS, type DefaultMiniAppKind, type MiniAppDefaultsResult, type MiniAppSummary } from "../../../shared/mini-apps";
import { REPORT_APPS } from "../../../shared/report-mini-app";
import { DASHBOARD_APPS } from "./DashboardInstall";
import { MiniAppIcon, iconKindForApp } from "./MiniAppIcon";
import { miniAppDisplayName } from "./mini-app-display";
import { hongguoText } from "./hongguo-copy";
import type { MiniAppUpdateCandidate, MiniAppUpdateInfo } from "./mini-app-update";

export const shippedAppDetails = (kind: DefaultMiniAppKind) => kind === "bookkeeping"
  ? { name: t("computer.miniApps.bookkeepingTitle"), description: t("computer.miniApps.bookkeepingDescription") }
  : kind === "mojo" ? { name: "Mojo", description: t("computer.miniApps.mojo.description") }
  : kind === "hongguo"
    ? { name: hongguoText("computer.miniApps.hongguo.title"), description: hongguoText("computer.miniApps.hongguo.description") }
  : kind === "agent-team" || kind === "usage"
    ? { name: t(DASHBOARD_APPS[kind].title), description: t(DASHBOARD_APPS[kind].description) }
    : { name: t(kind === "x_ai_digest" ? "computer.miniApps.report.xTitle" : "computer.miniApps.report.githubTitle"),
      description: REPORT_APPS[kind].description };

export function MiniAppLibraryEntries({
  inventory,
  issues,
  busyKind,
  owner,
  nativeGuard,
  selectedId,
  selectedUpdate,
  updatingAppId = null,
  updateError = "",
  restoreFocusOnError = true,
  onOpen,
  onAdd,
  onRemove,
  onUpdate,
}: {
  inventory: MiniAppSummary[];
  issues: MiniAppDefaultsResult["issues"];
  busyKind: DefaultMiniAppKind | null;
  owner: boolean | null;
  nativeGuard: boolean;
  selectedId?: string | null;
  selectedUpdate?: MiniAppUpdateInfo | null;
  updatingAppId?: string | null;
  updateError?: string;
  restoreFocusOnError?: boolean;
  onOpen(id: string): void;
  onAdd(kind: DefaultMiniAppKind): void;
  onRemove(app: MiniAppSummary): void;
  onUpdate?(app: MiniAppSummary, candidate: MiniAppUpdateCandidate): void;
}) {
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  const wasUpdatingRef = useRef(false);

  useEffect(() => {
    if (restoreFocusOnError && wasUpdatingRef.current && updatingAppId === null && updateError) {
      updateButtonRef.current?.focus();
    }
    wasUpdatingRef.current = updatingAppId !== null;
  }, [updatingAppId, updateError, restoreFocusOnError]);

  const legacyMojo = inventory.find((app) => app.id === LEGACY_MINI_APP_IDS.mojo && iconKindForApp(app) === "mojo");
  const defaultApps = new Set(inventory.filter((app) => {
    const kind = iconKindForApp(app);
    return kind !== null && (!legacyMojo || kind !== "mojo" || app.id === legacyMojo.id);
  }).map((app) => app.id));
  const custom = inventory.filter((app) => !defaultApps.has(app.id));
  const actionDisabled = busyKind !== null || updatingAppId !== null;
  const availableCandidate = selectedUpdate?.status === "available" ? selectedUpdate.available : null;

  return <div data-mini-app-library className="space-y-4">
    <ul className="grid grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-2" aria-label={t("computer.miniApps.catalog.included") }>
      {DEFAULT_MINI_APP_KINDS.map((kind) => {
        const text = kind === "hongguo" ? hongguoText : t;
        const matches = kind === "mojo" && legacyMojo ? [legacyMojo] : inventory.filter((app) => iconKindForApp(app) === kind);
        const app = matches.length === 1 ? matches[0] : null;
        const name = app ? miniAppDisplayName(app) : shippedAppDetails(kind).name;
        const nativeNeedsGrant = app && (kind === "hongguo" ? app.nativeKind !== "hongguo"
          : (kind === "agent-team" || kind === "usage") && !app.dashboard);
        const canOpen = app?.status === "active" && !nativeNeedsGrant;
        const canAct = owner === true && nativeGuard && matches.length <= 1;
        const issue = issues.find((entry) => entry.kind === kind);
        const state = matches.length > 1 ? "conflict" : !app ? "missing" : app.status === "archived" ? "removed"
          : nativeNeedsGrant ? "needs-access" : "active";
        const canUpdateSelected = Boolean(app && app.status === "active" && app.id === selectedId && canAct && availableCandidate && onUpdate);
        const isUpdating = Boolean(app && updatingAppId === app.id);
        return <li key={kind} data-mini-app-catalog={kind} data-mini-app-state={state}
          className="flex min-w-0 flex-col items-center rounded-xl bg-inset/60 px-1.5 py-2 text-center">
          <button type="button" data-mini-app-grid-item={kind} disabled={!canAct || actionDisabled}
            onClick={() => canOpen ? onOpen(app!.id) : onAdd(kind)}
            aria-label={`${text(canOpen ? "computer.miniApps.catalog.open" : "computer.miniApps.catalog.add")} ${name}`}
            title={name} className="flex min-w-0 flex-col items-center gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60">
            <MiniAppIcon kind={kind} app={app ?? undefined} launcher />
            <span className="w-full text-[11px] leading-4 text-ink [overflow-wrap:anywhere]">{name}</span>
          </button>
          {busyKind === kind && <Loader2 size={12} className="mt-1 animate-spin text-ink-secondary" aria-hidden="true" />}
          {state !== "active" && <span className="mt-1 text-[10px] leading-3 text-ink-secondary">{text(state === "removed" ? "computer.miniApps.catalog.removed"
            : state === "needs-access" ? "computer.miniApps.catalog.needsAccessShort"
              : state === "conflict" ? "computer.miniApps.catalog.nameInUseShort" : "computer.miniApps.catalog.available")}</span>}
          {issue && <span role="status" className="mt-1 text-[10px] leading-3 text-warning [overflow-wrap:anywhere]">{kind === "hongguo" ? text("computer.miniApps.hongguo.requestFailed") : issue.error}</span>}
          {canUpdateSelected && <button
            ref={updateButtonRef}
            type="button"
            data-mini-app-update={app!.id}
            disabled={actionDisabled}
            aria-busy={isUpdating || undefined}
            aria-label={t("computer.miniApps.update.actionFor", { name, version: availableCandidate!.appVersion })}
            onClick={() => onUpdate!(app!, availableCandidate!)}
            className="mt-1 inline-flex items-center justify-center gap-1 rounded-md bg-control px-1.5 py-0.5 text-[10px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {isUpdating && <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {t(isUpdating ? "computer.miniApps.update.updating" : "computer.miniApps.update.action")}
          </button>}
          {canUpdateSelected && updateError && <span role="alert" data-mini-app-update-error className="mt-1 text-[10px] leading-3 text-danger [overflow-wrap:anywhere]">{updateError}</span>}
          {app?.status === "active" && canAct && <button type="button" data-mini-app-remove={kind} disabled={actionDisabled}
            onClick={() => onRemove(app!)} aria-label={`${text("computer.miniApps.catalog.remove")} ${name}`}
            className="mt-1 rounded px-1.5 py-0.5 text-[10px] text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
            {text("computer.miniApps.catalog.remove")}</button>}
        </li>;
      })}
    </ul>
    {custom.length > 0 && <section aria-labelledby="mini-app-custom-title">
      <h3 id="mini-app-custom-title" className="text-[12px] font-semibold text-ink">{t("computer.miniApps.catalog.other")}</h3>
      <ul className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(78px,1fr))] gap-2">
        {custom.map((app) => {
          const canUpdateSelected = Boolean(app.status === "active" && app.id === selectedId && owner === true && nativeGuard && availableCandidate && onUpdate);
          const isUpdating = updatingAppId === app.id;
          return <li key={app.id} data-mini-app-custom={app.id} className="flex min-w-0 flex-col items-center rounded-xl bg-inset/60 px-1.5 py-2 text-center">
            <button type="button" data-mini-app-grid-item={app.id} disabled={app.status !== "active" || owner !== true || !nativeGuard || actionDisabled}
              onClick={() => onOpen(app.id)} aria-label={`${t("computer.miniApps.catalog.open")} ${app.title}`}
              className="flex min-w-0 flex-col items-center gap-1 rounded-lg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60">
              <MiniAppIcon kind={null} app={app} launcher /><span className="w-full text-[11px] leading-4 text-ink [overflow-wrap:anywhere]">{app.title}</span>
            </button>
            {canUpdateSelected && <button
              ref={updateButtonRef}
              type="button"
              data-mini-app-update={app.id}
              disabled={actionDisabled}
              aria-busy={isUpdating || undefined}
              aria-label={t("computer.miniApps.update.actionFor", { name: app.title, version: availableCandidate!.appVersion })}
              onClick={() => onUpdate!(app, availableCandidate!)}
              className="mt-1 inline-flex items-center justify-center gap-1 rounded-md bg-control px-1.5 py-0.5 text-[10px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {isUpdating && <Loader2 size={10} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {t(isUpdating ? "computer.miniApps.update.updating" : "computer.miniApps.update.action")}
            </button>}
            {canUpdateSelected && updateError && <span role="alert" data-mini-app-update-error className="mt-1 text-[10px] leading-3 text-danger [overflow-wrap:anywhere]">{updateError}</span>}
            {app.status === "archived" && <span className="mt-1 text-[10px] text-ink-secondary">{t("computer.miniApps.archived")}</span>}
          </li>;
        })}
      </ul>
    </section>}
  </div>;
}
