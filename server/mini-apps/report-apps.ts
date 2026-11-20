import { isDeepStrictEqual } from "node:util";
import type { MiniAppDataBinding } from "../../shared/mini-app-data.ts";
import type { MiniAppSummary } from "../../shared/mini-apps.ts";
import { githubDeepDiveBinding, reportMiniAppBinding, type ReportKind } from "../../shared/report-mini-app.ts";
import type { DataEngine } from "../data/types.ts";
import { MINI_APPS_OWNER, type MiniAppActor, type MiniApps } from "./registry.ts";
import { appFailure } from "./validation.ts";

export type BoundReportApp = Pick<MiniAppSummary, "slug" | "status" | "shippedTemplateKind" | "publisherBotIds"> & { reportBoundToProducer: boolean };

export function hasReportBindingForProducer(bindings: readonly MiniAppDataBinding[], datasetId: string, kind: ReportKind): boolean {
  if (!bindings.length || !isDeepStrictEqual(bindings[0], reportMiniAppBinding(datasetId, kind))) return false;
  if (bindings.length === 1) return true;
  if (kind !== "github_activity" || bindings.length !== 2) return false;
  return isDeepStrictEqual(bindings[1], githubDeepDiveBinding(datasetId))
    || isDeepStrictEqual(bindings[1], githubDeepDiveBinding(datasetId, { catalog: true }));
}

export async function reportAppsForBot(deps: {
  apps: MiniApps; data: Pick<DataEngine, "listBotSources">; localEnabled(): boolean; bots(): Array<{ id: string }>;
}, botId: string): Promise<BoundReportApp[]> {
  if (!deps.localEnabled() || !deps.bots().some((bot) => bot.id === botId)) return [];
  const assertActive = () => {
    if (!deps.localEnabled() || !deps.bots().some((bot) => bot.id === botId)) throw appFailure(403, "This local report producer is unavailable.");
  };
  const actor: MiniAppActor = { botId, assertActive, writeAllowed: false, canBind: () => false };
  const sources = await deps.data.listBotSources(MINI_APPS_OWNER, [botId]);
  assertActive();
  const datasetId = sources.find((source) => source.botId === botId)?.datasetId;
  return deps.apps.list(actor).flatMap((app) => {
    const kind = app.shippedTemplateKind;
    if (kind !== "x_ai_digest" && kind !== "github_activity") return [];
    const { slug, status, shippedTemplateKind, publisherBotIds } = app;
    const document = deps.apps.document(actor, app.id);
    return [{ slug, status, shippedTemplateKind, publisherBotIds,
      reportBoundToProducer: !!datasetId && hasReportBindingForProducer(document.bindings, datasetId, kind) }];
  });
}
