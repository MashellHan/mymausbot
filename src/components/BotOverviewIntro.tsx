import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Lightbulb, Loader2, Sparkles } from "lucide-react";
import type { MiniAppSuggestionReason, MiniAppSuggestionsRequest, MiniAppSuggestionsResult } from "../../shared/mini-apps";
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
import { RowIcon } from "./bot-panel/rows";
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
      <ModelPicker bot={bot} contained threadId={bot.threadId} showReasoning inlineSettings className="px-1 pb-2 pt-3" />}
    </div>
  </section>;
}

function suggestionReason(reason: MiniAppSuggestionReason): string {
  return reason.kind === "task" ? reason.capability
    : t(reason.kind === "responsible" ? "computer.miniApps.suggested.responsible" : "computer.miniApps.suggested.developed");
}

export function BotOverviewIntro({ bot, routines, runs, defaultRunOn, onOpenApps }: {
  bot: Bot;
  routines: Routine[];
  runs: RoutineRun[];
  defaultRunOn: RoutineRunOn;
  onOpenApps: (id?: string) => void;
}) {
  const owner = useOwnerOrAdmin();
  const nativeGuard = miniAppNativeFrameGuard();
  const visible = usePageVisible();
  const waitingForTask = Boolean(bot.switchingTo || bot.awaitingThreadSnapshot);
  const context = JSON.stringify([bot.id, bot.threadId, bot.title, bot.description, bot.soul, bot.modelSelection, waitingForTask,
    bot.tasks?.find((task) => task.threadId === bot.threadId)?.title]);
  const [response, setResponse] = useState<{ context: string; data: MiniAppSuggestionsResult | null; error: boolean } | null>(null);
  const current = response?.context === context ? response : null;
  const suggestions = current?.data?.suggestions.filter(({ app }) => app.status === "active").slice(0, 3) ?? [];

  useEffect(() => {
    if (!visible || owner !== true || !nativeGuard || waitingForTask) return;
    const controller = new AbortController();
    let followUp: ReturnType<typeof setTimeout> | undefined;
    setResponse({ context, data: null, error: false });
    const load = async (mayFollowUp: boolean) => {
      try {
        const data = await api<MiniAppSuggestionsResult>("/api/mini-apps/suggestions", {
          method: "POST", body: JSON.stringify({ botId: bot.id, threadId: bot.threadId } satisfies MiniAppSuggestionsRequest),
          background: true, signal: controller.signal, timeoutMs: 10_000,
        });
        if (controller.signal.aborted) return;
        if (data.botId !== bot.id || data.threadId !== bot.threadId) throw new Error("Suggestion context changed");
        setResponse({ context, data, error: !mayFollowUp && data.refreshPending && !data.suggestions.some(({ app }) => app.status === "active") });
        if (mayFollowUp && data.refreshPending) followUp = setTimeout(() => void load(false), 9_000);
      } catch {
        if (!controller.signal.aborted) setResponse({ context, data: null, error: true });
      }
    };
    void load(true);
    return () => { controller.abort(); clearTimeout(followUp); };
  }, [visible, owner, nativeGuard, waitingForTask, bot.id, bot.threadId, context]);

  return <div className="space-y-6" data-testid="bot-overview-intro">
    <header className="flex min-w-0 items-center gap-3 border-b border-hairline/50 pb-5 pt-4">
      <BotAvatar bot={bot} size={52} state="happy" animated={false} />
      <h1 className="min-w-0 truncate text-[19px] font-semibold leading-7 text-ink" title={bot.name}>{bot.name}</h1>
    </header>
    <OverviewModel key={`model:${bot.id}`} bot={bot} />
    <RoutinesSection key={bot.id} bot={bot} routines={routines} runs={runs} defaultRunOn={defaultRunOn} compact />
    <section aria-label={t("model.suggested")}>
      <div className="mb-3 flex items-center gap-3 px-1">
        <Lightbulb size={17} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <h2 data-overview-section-title="" className="min-w-0 flex-1 text-[15px] font-semibold text-ink">{t("model.suggested")}</h2>
        {owner === true && nativeGuard && <button type="button" onClick={() => onOpenApps()} aria-label={t("computer.miniApps.suggested.more")}
          className="rounded-sm text-[12px] text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-accent">{t("apps.more")}</button>}
      </div>
      {owner !== true || !nativeGuard ? <p className="text-[12px] text-ink-secondary">{t(owner === null ? "computer.miniApps.loading" : owner === false ? "computer.miniApps.accessEnded" : "computer.miniApps.desktopRequired")}</p>
        : current?.error ? <p role="alert" className="text-[12px] text-danger">{t("computer.miniApps.loadFailed")}</p>
        : !current?.data || current.data.refreshPending && suggestions.length === 0 ? <p role="status" className="flex items-center gap-2 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.loading")}</p>
        : suggestions.length === 0 ? <p className="text-[12px] text-ink-secondary">{t("computer.miniApps.suggested.empty")}</p>
        : <div className="grid grid-cols-2 gap-2 @min-[34rem]/botoverview:grid-cols-3">
          {suggestions.map(({ app, reason }) => <button key={app.id} type="button" title={miniAppDisplayName(app)} onClick={() => onOpenApps(app.id)}
            className="flex min-w-0 items-center gap-2.5 rounded-lg border border-hairline/50 bg-card px-3 py-2 text-left text-[13px] text-ink hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent">
            <MiniAppIcon kind={iconKindForApp(app)} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{miniAppDisplayName(app)}</span>
              <span className="mt-0.5 block truncate text-[11px] text-ink-secondary" title={reason.kind === "task" ? `${reason.capability} · ${reason.taskPhrase}` : undefined}>{suggestionReason(reason)}</span>
            </span>
            <ChevronRight size={14} className="shrink-0 text-ink-secondary rtl:-scale-x-100" aria-hidden="true" />
          </button>)}
        </div>}
    </section>
  </div>;
}
