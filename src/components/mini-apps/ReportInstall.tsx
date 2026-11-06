import { useState } from "react";
import { t } from "@/lib/i18n";
import { scheduleLabel } from "@/lib/schedule-label";
import { api, useStore } from "@/state/store";
import { REPORT_APPS, type ReportKind, type ReportSourceResult } from "../../../shared/report-mini-app";
import type { MiniAppMutationResult, MiniAppSummary } from "../../../shared/mini-apps";
import { Select } from "../Select";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

type Inventory = { apps: MiniAppSummary[] };

export function ReportInstall({ kind, onCancel, onInstalled }: {
  kind: ReportKind; onCancel(): void; onInstalled(appId: string): void;
}) {
  const { state, dispatch } = useStore();
  const [routineId, setRoutineId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const routines = state.routines.filter((routine) => routine.enabled && routine.target === "bot" && routine.runOn === "maus");
  const routine = routines.find((entry) => entry.id === routineId) ?? routines[0];
  const producer = state.bots.find((bot) => bot.id === routine?.botId);
  const app = REPORT_APPS[kind];
  const nativeGuard = miniAppNativeFrameGuard();

  const install = async () => {
    if (!nativeGuard || !routine || busy) return;
    setBusy(true);
    setError("");
    try {
      const inventory = await api<Inventory>("/api/mini-apps", { timeoutMs: 10_000 });
      const existing = inventory.apps.find((entry) => entry.slug === app.slug);
      if (existing?.status === "archived") throw new Error(t("computer.miniApps.report.archived"));
      if (existing) { onInstalled(existing.id); return; }
      const source = await api<ReportSourceResult>("/api/mini-apps/report-source", {
        method: "POST", body: JSON.stringify({ kind, routineId: routine.id }), timeoutMs: 20_000,
      });
      if (source.kind !== kind || source.slug !== app.slug || source.routineId !== routine.id || source.publication.slug !== app.slug
        || !source.producerBotId || source.publication.expectedRevision !== 0) throw new Error(t("computer.miniApps.report.invalidSource"));
      const result = await api<MiniAppMutationResult>("/api/mini-apps", {
        method: "POST", body: JSON.stringify({ ...source.publication, publisherBotIds: [source.producerBotId] }), timeoutMs: 20_000,
      });
      onInstalled(result.app.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("computer.miniApps.report.installFailed"));
    } finally { setBusy(false); }
  };

  if (!nativeGuard) return <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>;

  return <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" data-testid="report-install" aria-labelledby="report-install-title">
    <header className="flex items-start justify-between gap-3 pt-3">
      <div>
        <h2 id="report-install-title" className="text-[16px] font-semibold text-ink">{t("computer.miniApps.report.installTitle", { name: t(kind === "x_ai_digest" ? "computer.miniApps.report.xTitle" : "computer.miniApps.report.githubTitle") })}</h2>
        <p className="mt-1 text-[13px] leading-5 text-ink-secondary">{t("computer.miniApps.report.installDescription")}</p>
      </div>
      <button type="button" className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" onClick={onCancel}>{t("computer.miniApps.cancel")}</button>
    </header>
    {error && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
    {routines.length ? <div className="mt-5 space-y-4">
      <label className="block text-[12px] font-medium text-ink-secondary">{t("computer.miniApps.report.routine")}
        <Select value={routine?.id ?? ""} disabled={busy} onChange={(event) => { setRoutineId(event.target.value); setError(""); }} className="mt-1 w-full">
          {routines.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </Select>
      </label>
      {routine && <dl className="grid grid-cols-1 gap-3 rounded-xl bg-inset p-3 text-[13px] @min-[29rem]/mini-apps:grid-cols-2">
        <div><dt className="text-[12px] text-ink-secondary">{t("computer.miniApps.report.producer")}</dt><dd className="mt-1 font-medium text-ink">{producer?.name ?? t("computer.miniApps.report.producerUnavailable")}</dd></div>
        <div><dt className="text-[12px] text-ink-secondary">{t("computer.miniApps.report.schedule")}</dt><dd className="mt-1 text-ink">{scheduleLabel(routine.schedule)}{routine.schedule.type === "cron" ? "" : ` · ${t("computer.miniApps.report.localTime")}`}</dd></div>
        <div className="@min-[29rem]/mini-apps:col-span-2"><dt className="text-[12px] text-ink-secondary">{t("computer.miniApps.report.dataConnection")}</dt><dd className="mt-1 text-ink">{t("computer.miniApps.report.dataConnectionDescription")}</dd></div>
      </dl>}
      <p className="text-[12px] leading-5 text-ink-secondary">{t("computer.miniApps.report.noRunClaim")}</p>
      <button type="button" disabled={busy || !routine} onClick={() => void install()} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">{busy ? t("computer.miniApps.install.working") : t("computer.miniApps.report.installAction")}</button>
    </div> : <div className="mt-5 space-y-3 rounded-xl bg-inset p-3 text-[13px] text-ink-secondary">
      <p role="status">{state.routinesLoadState === "loading" ? t("computer.miniApps.report.routinesLoading") : state.routinesLoadState === "error" ? t("computer.miniApps.report.routinesUnavailable") : t("computer.miniApps.report.noRoutine")}</p>
      <button type="button" onClick={() => dispatch({ type: "showRoutines" })} className="rounded-lg bg-control px-3 py-1.5 font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">{t("computer.miniApps.report.openAutomations")}</button>
    </div>}
  </section>;
}
