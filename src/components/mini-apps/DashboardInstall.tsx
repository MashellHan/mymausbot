import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { randomUuid } from "@/lib/random-uuid";
import { api } from "@/state/store";
import type { MiniAppDashboardKind, MiniAppDocument, MiniAppMutationResult, MiniAppPublish, MiniAppSummary } from "../../../shared/mini-apps";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

export const DASHBOARD_APPS = {
  "agent-team": { slug: "agent-team", title: "computer.tab.agentTeam", description: "computer.miniApps.dashboard.teamDescription",
    reads: "computer.miniApps.dashboard.teamReads" },
  usage: { slug: "usage", title: "computer.tab.usage", description: "computer.miniApps.dashboard.usageDescription",
    reads: "computer.miniApps.dashboard.usageReads" },
} as const satisfies Record<MiniAppDashboardKind, { slug: string; title: string; description: string; reads: string }>;

const FALLBACK_HTML = '<!doctype html><html lang="en"><meta charset="utf-8"><title>Built-in dashboard</title><body>Open this app in the OpenMausBot desktop app.</body></html>';
type Inventory = { apps: MiniAppSummary[] };

export function DashboardInstall({ kind, onCancel, onInstalled }: {
  kind: MiniAppDashboardKind; onCancel(): void; onInstalled(appId: string): void;
}) {
  const nativeGuard = miniAppNativeFrameGuard();
  const app = DASHBOARD_APPS[kind];
  const heading = useRef<HTMLHeadingElement>(null);
  const publication = useRef<MiniAppPublish | null>(null);
  const installController = useRef<AbortController | null>(null);
  const [inventory, setInventory] = useState<MiniAppSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const identities = inventory?.filter((entry) => entry.dashboardIdentity === kind) ?? [];
  const identity = identities.length === 1 ? identities[0] : null;
  const installed = identity?.status === "active" && identity.dashboard?.kind === kind ? identity : null;
  const sameSlug = inventory?.find((entry) => entry.slug === app.slug);
  const conflict = identities.length > 1 || (!identity && !!sameSlug);

  useEffect(() => { heading.current?.focus(); return () => installController.current?.abort(); }, []);
  useEffect(() => {
    if (!nativeGuard) return;
    const controller = new AbortController();
    void api<Inventory>("/api/mini-apps", { background: true, signal: controller.signal, timeoutMs: 10_000 })
      .then((result) => { if (!controller.signal.aborted) setInventory(result.apps); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("computer.miniApps.dashboard.inventoryFailed")); });
    return () => controller.abort();
  }, [nativeGuard]);

  const install = async () => {
    if (!nativeGuard || busy || !inventory || conflict) return;
    if (installed) { onInstalled(installed.id); return; }
    setBusy(true);
    setError("");
    const controller = new AbortController();
    installController.current = controller;
    try {
      const previous = identity;
      let body = publication.current;
      if (!body) {
        const current = previous ? await api<MiniAppDocument>(`/api/mini-apps/${encodeURIComponent(previous.id)}`, {
          background: true, signal: controller.signal, timeoutMs: 10_000,
        }) : null;
        if (current && previous && (current.app.id !== previous.id || current.app.revision !== previous.revision
          || current.app.dashboardIdentity !== kind || current.bindings.length !== 0)) throw new Error(t("computer.miniApps.dashboard.changed"));
        body = { requestKey: randomUuid(), expectedRevision: previous?.revision ?? 0, slug: current?.app.slug ?? app.slug,
          title: current?.app.title ?? t(app.title), description: current?.app.description ?? t(app.description), html: current?.html ?? FALLBACK_HTML,
          bindings: [], publisherBotIds: current?.app.publisherBotIds ?? [], dashboardKind: kind };
        publication.current = body;
      }
      const path = previous ? `/api/mini-apps/${encodeURIComponent(previous.id)}/publish` : "/api/mini-apps";
      const result = await api<MiniAppMutationResult>(path, { method: "POST", body: JSON.stringify(body), signal: controller.signal, timeoutMs: 20_000 });
      if (!controller.signal.aborted) onInstalled(result.app.id);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("computer.miniApps.dashboard.installFailed"));
    } finally { if (!controller.signal.aborted) setBusy(false); if (installController.current === controller) installController.current = null; }
  };

  if (!nativeGuard) return <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>;

  return <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" data-testid="dashboard-install" aria-labelledby="dashboard-install-title">
    <header className="flex items-start justify-between gap-3 pt-3">
      <div className="min-w-0">
        <h2 id="dashboard-install-title" ref={heading} tabIndex={-1} className="text-[16px] font-semibold text-ink outline-none">{t("computer.miniApps.dashboard.installTitle", { name: t(app.title) })}</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-secondary">{t(app.description)}</p>
      </div>
      <button type="button" className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" onClick={onCancel}>{t("computer.miniApps.cancel")}</button>
    </header>
    <div className="mt-5 space-y-3">
      <p className="rounded-xl bg-inset px-3 py-2.5 text-[13px] leading-5 text-ink-secondary">{t(app.reads)}</p>
      <p className="text-[12px] leading-5 text-ink-secondary">{t("computer.miniApps.dashboard.ownerOnly")}</p>
      {inventory === null && !error && <p role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.dashboard.checking")}</p>}
      {conflict && <p role="alert" className="text-[12px] text-warning">{t("computer.miniApps.dashboard.slugConflict")}</p>}
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <button type="button" disabled={inventory === null || busy || conflict} onClick={() => void install()}
        className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
        {busy ? t("computer.miniApps.install.working") : installed ? t("computer.miniApps.dashboard.open")
          : identity?.status === "archived" ? t("computer.miniApps.dashboard.reinstall")
            : identity ? t("computer.miniApps.dashboard.reauthorize") : t("computer.miniApps.dashboard.install")}
      </button>
    </div>
  </section>;
}
