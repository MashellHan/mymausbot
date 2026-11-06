import { reportKindForRoutine } from "../shared/report-routine.ts";
import type { MiniAppSummary } from "../shared/mini-apps.ts";
import { allowsTool } from "../shared/tool-scope.ts";
import type { Routine, RoutineRun } from "./routines.ts";

export type RoutineReportApp = Pick<MiniAppSummary, "slug" | "status" | "shippedTemplateKind" | "publisherBotIds"> & {
  reportBoundToProducer: boolean;
};

export interface RoutineReportPublicationContext {
  run: Pick<RoutineRun, "id" | "routineId" | "botId" | "target" | "runOn" | "status" | "triggerSource" | "eventSource" | "access"> | null;
  routine: Pick<Routine, "id" | "name" | "prompt" | "enabled" | "target" | "runOn" | "botId" | "access"> | null;
  bot: { id: string; toolScope?: unknown } | null;
  apps: readonly RoutineReportApp[];
  localEnabled: boolean;
  writeAllowed: boolean;
}

export interface RoutineReportTurnContext {
  routines: { runForThread(threadId: string): RoutineReportPublicationContext["run"];
    listRoutines(): NonNullable<RoutineReportPublicationContext["routine"]>[] } | null;
  botForId(botId: string): RoutineReportPublicationContext["bot"];
  reportAppsForBot(botId: string): Promise<readonly RoutineReportApp[]>;
  localEnabled(): boolean;
  writeAllowed(): boolean;
  stopped(): boolean;
}

export async function dispatchRoutineReportTurn(prompt: string, botId: string, threadId: string,
  context: RoutineReportTurnContext, dispatch: (prompt: string) => Promise<unknown>): Promise<void> {
  const run = context.routines?.runForThread(threadId);
  if (context.stopped() || !run || run.botId !== botId || run.status !== "running") return;
  const text = await routineReportTurnPrompt(prompt, botId, threadId, context);
  const current = context.routines?.runForThread(threadId);
  if (!context.stopped() && current?.id === run.id && current.status === "running" && current.botId === botId) await dispatch(text);
}

export async function routineReportTurnPrompt(prompt: string, botId: string, threadId: string,
  context: RoutineReportTurnContext): Promise<string> {
  if (!context.localEnabled() || !context.writeAllowed() || !context.routines || context.botForId(botId)?.id !== botId) return prompt;
  const run = context.routines.runForThread(threadId);
  if (!run || run.botId !== botId || run.status !== "running" || run.target !== "bot" || run.runOn !== "maus" ||
      run.triggerSource === "webhook" || run.eventSource !== undefined || run.access === "read-and-draft") return prompt;
  const routine = context.routines.listRoutines().find((candidate) => candidate.id === run.routineId) ?? null;
  if (!routine || !routine.enabled || routine.botId !== botId || routine.target !== "bot" || routine.runOn !== "maus" ||
      routine.access === "read-and-draft" || routine.prompt.includes("mini_app_report") || !reportKindForRoutine(routine)) return prompt;
  let apps: readonly RoutineReportApp[];
  try { apps = await context.reportAppsForBot(botId); }
  catch { return prompt; }
  const current = context.routines.runForThread(threadId);
  const currentRoutine = context.routines.listRoutines().find((candidate) => candidate.id === current?.routineId) ?? null;
  return routineReportPublicationPrompt(prompt, { run: current?.id === run.id ? current : null, routine: currentRoutine,
    bot: context.botForId(botId), apps, localEnabled: context.localEnabled(), writeAllowed: context.writeAllowed() });
}

export function routineReportPublicationPrompt(prompt: string, context: RoutineReportPublicationContext): string {
  const { run, routine, bot, apps, localEnabled, writeAllowed } = context;
  if (!localEnabled || !writeAllowed || !run || !routine || !bot || run.status !== "running" ||
      run.target !== "bot" || routine.target !== "bot" || run.runOn !== "maus" || routine.runOn !== "maus" ||
      run.triggerSource === "webhook" || run.eventSource !== undefined || !routine.enabled ||
      run.access === "read-and-draft" || routine.access === "read-and-draft" ||
      run.routineId !== routine.id || run.botId !== routine.botId || run.botId !== bot.id ||
      routine.prompt.includes("mini_app_report") || prompt.includes("[Installed report edition]")) return prompt;

  const kind = reportKindForRoutine(routine);
  if (!kind || !allowsTool(bot.toolScope, { kind: "mcp", server: "agents", name: "mini_app_report" }, { action: "publish", kind })) return prompt;
  const matched = apps.filter((app) => app.status === "active" && app.shippedTemplateKind === kind &&
    app.reportBoundToProducer === true && Array.isArray(app.publisherBotIds) && app.publisherBotIds.includes(bot.id));
  if (matched.length !== 1) return prompt;

  return `${prompt}\n\n[Installed report edition]\nThis Bot currently publishes the installed ${matched[0]!.slug} report. Finish the routine's original task, then use mini_app_report with action "publish", kind "${kind}" and a complete edition from verified sources. Follow the tool's existing report guide and schema. Omit editionKey so this Automation uses its original scheduled China day. Record source URLs and coverage honestly; use partial or unknown with a note when needed, and never invent items. Keep the normal reply. If publication is refused because access changed, report that refusal without bypassing it.\n[/Installed report edition]`;
}
