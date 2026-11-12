import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Sparkles } from "lucide-react";
import type { MiniAppSummary } from "../../shared/mini-apps";
import type { Routine, RoutineRun, RoutineRunOn } from "@/lib/routines";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { usePageVisible } from "@/lib/page-visible";
import { api, useStore, type Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";
import { modelName } from "@/lib/simple-model-menu";
import { RoutinesSection } from "./bot-settings/RoutinesSection";
import { RowIcon, RowText, rowCls } from "./bot-panel/rows";
import { MiniAppIcon, iconKindForApp } from "./mini-apps/MiniAppIcon";
import { miniAppDisplayName } from "./mini-apps/mini-app-display";
import { miniAppNativeFrameGuard } from "./mini-apps/native-frame-guard";

function OverviewModel({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const [expanded, setExpanded] = useState(false);
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  const summary = modelName(instance, selection.model, selection.variant);

  return <section data-panel-card="model">
    <button type="button" aria-expanded={expanded} aria-controls="bot-overview-model-content" onClick={() => setExpanded((open) => !open)}
      className="flex w-full min-w-0 items-center gap-3 rounded-lg px-1 py-2 text-left hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent">
      <RowIcon icon={Sparkles} />
      <span className="min-w-0 flex-1">
        <span data-panel-model-title="" className="block text-[15px] font-semibold text-ink">{t("model.simple.model")}</span>
        <span className="block truncate text-[12px] text-ink-secondary" title={summary}>{summary}</span>
      </span>
      <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", expanded && "rotate-180")} aria-hidden="true" />
    </button>
    <div id="bot-overview-model-content" hidden={!expanded}>{expanded &&
      <div data-panel-row="model" className={cn(rowCls, "rounded-[8px]")}>
        <ModelPicker bot={bot} contained threadId={bot.threadId} showReasoning
          label={<RowText title={t("model.simple.model")} />} />
      </div>}
    </div>
  </section>;
}

export function BotOverviewIntro({ bot, routines, runs, defaultRunOn, onOpenApp }: {
  bot: Bot;
  routines: Routine[];
  runs: RoutineRun[];
  defaultRunOn: RoutineRunOn;
  onOpenApp: (id: string) => void;
}) {
  const owner = useOwnerOrAdmin();
  const nativeGuard = miniAppNativeFrameGuard();
  const visible = usePageVisible();
  const [apps, setApps] = useState<MiniAppSummary[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!visible || owner !== true || !nativeGuard) return;
    const controller = new AbortController();
    void api<{ apps: MiniAppSummary[] }>("/api/mini-apps", { background: true, signal: controller.signal, timeoutMs: 10_000 })
      .then((result) => {
        if (!controller.signal.aborted) setApps(result.apps.filter((app) => app.status === "active"));
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [visible, owner, nativeGuard]);

  return <div className="space-y-6" data-testid="bot-overview-intro">
    <header className="flex min-w-0 items-center gap-3 border-b border-hairline/50 pb-5 pt-4">
      <BotAvatar bot={bot} size={52} state="happy" animated={false} />
      <h1 className="min-w-0 truncate text-[19px] font-semibold leading-7 text-ink" title={bot.name}>{bot.name}</h1>
    </header>
    <OverviewModel key={`model:${bot.id}`} bot={bot} />
    <RoutinesSection key={bot.id} bot={bot} routines={routines} runs={runs} defaultRunOn={defaultRunOn} compact />
    <section aria-label={t("model.suggested")}>
      <h2 className="mb-3 text-[15px] font-semibold text-ink">{t("model.suggested")}</h2>
      {owner !== true || !nativeGuard ? <p className="text-[12px] text-ink-secondary">{t(owner === null ? "computer.miniApps.loading" : owner === false ? "computer.miniApps.accessEnded" : "computer.miniApps.desktopRequired")}</p>
        : error ? <p role="alert" className="text-[12px] text-danger">{t("computer.miniApps.loadFailed")}</p>
        : apps === null ? <p role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.loading")}</p>
        : apps.length === 0 ? <p className="text-[12px] text-ink-secondary">{t("computer.miniApps.chooseApp")}: {t("botPanel.none")}</p>
        : <div className="grid grid-cols-2 gap-2 @min-[34rem]/botoverview:grid-cols-3">
          {apps.map((app) => <button key={app.id} type="button" title={miniAppDisplayName(app)} onClick={() => onOpenApp(app.id)}
            className="flex min-w-0 items-center gap-2.5 rounded-lg border border-hairline/50 bg-card px-3 py-2 text-left text-[13px] text-ink hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent">
            <MiniAppIcon kind={iconKindForApp(app)} />
            <span className="min-w-0 flex-1 truncate">{miniAppDisplayName(app)}</span>
            <ChevronRight size={14} className="shrink-0 text-ink-secondary rtl:-scale-x-100" aria-hidden="true" />
          </button>)}
        </div>}
    </section>
  </div>;
}
