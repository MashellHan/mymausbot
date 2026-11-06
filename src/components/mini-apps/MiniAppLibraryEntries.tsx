import type { MiniAppSummary } from "../../../shared/mini-apps";
import { REPORT_APPS } from "../../../shared/report-mini-app";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { DASHBOARD_APPS } from "./DashboardInstall";
import { MiniAppIcon, iconKindForApp, type MiniAppIconKind } from "./MiniAppIcon";

export const SHIPPED: MiniAppIconKind[] = ["bookkeeping", "x_ai_digest", "github_activity", "agent-team", "usage"];

export const shippedAppDetails = (kind: MiniAppIconKind) => kind === "bookkeeping"
  ? { slug: "bookkeeping", name: t("computer.miniApps.bookkeepingTitle"), description: t("computer.miniApps.bookkeepingDescription") }
  : kind === "agent-team" || kind === "usage"
    ? { slug: DASHBOARD_APPS[kind].slug, name: t(DASHBOARD_APPS[kind].title), description: t(DASHBOARD_APPS[kind].description) }
    : { slug: REPORT_APPS[kind].slug,
      name: t(kind === "x_ai_digest" ? "computer.miniApps.report.xTitle" : "computer.miniApps.report.githubTitle"),
      description: t(kind === "x_ai_digest" ? "computer.miniApps.report.xDescription" : "computer.miniApps.report.githubDescription") };

export function MiniAppLibraryEntries({ inventory, routines, owner, nativeGuard, onOpen, onSetup }: {
  inventory: MiniAppSummary[];
  routines: "ready" | "needs" | "loading" | "error";
  owner: boolean | null;
  nativeGuard: boolean;
  onOpen(id: string): void;
  onSetup(kind: MiniAppIconKind): void;
}) {
  const active = inventory.filter((app) => app.status === "active");
  return <div data-mini-app-library className="space-y-5">
    {active.length > 0 && <section aria-labelledby="mini-app-library-installed">
      <h3 id="mini-app-library-installed" className="text-[13px] font-semibold text-ink">{t("computer.miniApps.catalog.installed")}</h3>
      <ul className="mt-2 divide-y divide-hairline/60 border-y border-hairline/60">
        {active.map((app) => {
          const kind = iconKindForApp(app);
          return <li key={app.id} className="flex min-w-0 flex-wrap items-center gap-3 py-3">
            <MiniAppIcon kind={kind} large />
            <div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{app.title}</p>
              <p className="mt-0.5 text-[12px] leading-5 text-ink-secondary [overflow-wrap:anywhere]">{app.description}</p></div>
            <button type="button" data-mini-app-open={app.id} onClick={() => onOpen(app.id)} disabled={owner !== true || !nativeGuard}
              aria-label={`${t("computer.miniApps.catalog.open")} ${app.title}`}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
              {t("computer.miniApps.catalog.open")}</button>
          </li>;
        })}
      </ul>
    </section>}
    <section aria-labelledby="mini-app-library-included">
      <h3 id="mini-app-library-included" className="text-[13px] font-semibold text-ink">{t("computer.miniApps.catalog.included")}</h3>
      <ul className="mt-2 divide-y divide-hairline/60 border-y border-hairline/60">
        {SHIPPED.map((kind) => {
          const { slug, name, description } = shippedAppDetails(kind);
          const identities = kind === "agent-team" || kind === "usage"
            ? inventory.filter((app) => app.dashboardIdentity === kind) : [];
          const identity = identities.length === 1 ? identities[0] : null;
          const sameSlug = inventory.find((app) => app.slug === slug);
          const state = kind === "agent-team" || kind === "usage"
            ? identities.length > 1 || (!identity && sameSlug) ? "conflict"
              : identity?.status === "active" && identity.dashboard?.kind === kind ? "installed"
                : identity ? "repair" : "ready"
            : sameSlug?.status === "active" && sameSlug.shippedTemplateKind === kind ? "installed"
              : sameSlug ? "conflict"
                    : kind === "bookkeeping" ? "data"
                      : routines === "ready" ? "ready" : routines === "needs" ? "automation"
                        : routines;
          const blocked = owner !== true || !nativeGuard;
          const statusKey: LocaleKey = blocked ? owner === null ? "computer.miniApps.catalog.checkingAccess"
            : !nativeGuard ? "computer.miniApps.desktopRequired" : "computer.miniApps.catalog.ownerOnly"
            : state === "installed" ? "computer.miniApps.catalog.isInstalled"
              : state === "repair" ? "computer.miniApps.catalog.needsAccess"
                : state === "conflict" ? "computer.miniApps.catalog.nameInUse"
                  : state === "data" ? "computer.miniApps.catalog.needsData"
                      : state === "automation" ? "computer.miniApps.catalog.needsAutomation"
                        : state === "loading" ? "computer.miniApps.catalog.checkingAutomations"
                          : state === "error" ? "computer.miniApps.catalog.automationsUnavailable"
                            : "computer.miniApps.catalog.ready";
          const actionKey: LocaleKey = state === "installed" ? "computer.miniApps.catalog.open"
            : state === "repair" ? "computer.miniApps.dashboard.reauthorize"
              : state === "data" || state === "automation" || state === "error" || state === "loading"
                ? "computer.miniApps.catalog.setup" : "computer.miniApps.catalog.install";
          const canAct = !blocked && state !== "conflict";
          return <li key={kind} data-mini-app-catalog={kind} data-mini-app-state={state} tabIndex={-1}
            className="flex min-w-0 flex-wrap items-center gap-3 py-3 focus-visible:outline-2 focus-visible:outline-accent">
            <MiniAppIcon kind={kind} large />
            <div className="min-w-0 flex-1"><p className="text-[13px] font-medium text-ink">{name}</p>
              <p className="mt-0.5 text-[12px] leading-5 text-ink-secondary">{description}</p>
              <p className="mt-1 text-[12px] text-ink-secondary">{t(statusKey)}</p></div>
            {canAct && <button type="button" data-mini-app-choice={kind}
              onClick={() => state === "installed" && (identity || sameSlug) ? onOpen((identity ?? sameSlug)!.id) : onSetup(kind)}
              aria-label={`${t(actionKey)} ${name}`}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
              {t(actionKey)}</button>}
          </li>;
        })}
      </ul>
    </section>
  </div>;
}
