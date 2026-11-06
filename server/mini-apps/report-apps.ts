import { isDeepStrictEqual } from "node:util";
import type { MiniAppSummary } from "../../shared/mini-apps.ts";
import { reportMiniAppBinding } from "../../shared/report-mini-app.ts";
import type { DataEngine } from "../data/types.ts";
import { MINI_APPS_OWNER, type MiniAppActor, type MiniApps } from "./registry.ts";
import { appFailure } from "./validation.ts";

export type BoundReportApp = Pick<MiniAppSummary, "slug" | "status" | "shippedTemplateKind" | "publisherBotIds"> & { reportBoundToProducer: boolean };

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
    return [{ slug, status, shippedTemplateKind, publisherBotIds, reportBoundToProducer: !!datasetId
      && document.bindings.length === 1 && isDeepStrictEqual(document.bindings[0], reportMiniAppBinding(datasetId, kind)) }];
  });
}
