import { BOOKKEEPING_FIELDS, suggestedBookkeepingColumns, type BookkeepingColumns } from "../../shared/bookkeeping-mini-app.ts";
import type { MiniAppDataset, MiniAppSourceTable } from "../../shared/mini-apps.ts";
import type { DataEngine } from "../data/types.ts";
import { MINI_APPS_OWNER } from "./registry.ts";
import { appFailure } from "./validation.ts";

type LedgerCandidate = { datasetId: string | null; botId?: string; table: MiniAppSourceTable; columns: BookkeepingColumns };

export async function existingBookkeepingSource(data: DataEngine, botIds: string[], assertActive: () => void): Promise<{
  dataset: MiniAppDataset; table: MiniAppSourceTable; columns: BookkeepingColumns; publisherBotId?: string;
} | null> {
  const bots = await data.listBotSources(MINI_APPS_OWNER, botIds);
  const datasets = await data.listDatasets(MINI_APPS_OWNER);
  const candidates: LedgerCandidate[] = [];
  const inspect = async (datasetId: string | null, botId?: string) => {
    assertActive();
    const database = datasetId ? await data.forDataset(datasetId, MINI_APPS_OWNER) : await data.forBot(botId!);
    for (const table of await database.listSourceTables()) {
      const columns = suggestedBookkeepingColumns(table);
      if (BOOKKEEPING_FIELDS.every((field) => columns[field])) candidates.push({ datasetId, botId, table, columns });
    }
  };
  for (const dataset of datasets) await inspect(dataset.datasetId, bots.find((bot) => bot.datasetId === dataset.datasetId)?.botId);
  for (const bot of bots.filter((source) => !source.datasetId)) await inspect(null, bot.botId);
  const canonical = candidates.filter((candidate) => candidate.table.schema === "main" && candidate.table.name === "ledger_master");
  const matching = canonical.length ? canonical : candidates;
  if (matching.length > 1) throw appFailure(409, "More than one existing ledger matches. Ask your bookkeeping Bot to identify the main ledger.");
  const source = matching[0];
  if (!source) return null;
  assertActive();
  const dataset = source.datasetId ? datasets.find((entry) => entry.datasetId === source.datasetId)!
    : await data.promoteForBot(source.botId!, MINI_APPS_OWNER);
  assertActive();
  const tables = await (await data.forDataset(dataset.datasetId, MINI_APPS_OWNER)).listSourceTables();
  const table = tables.find((entry) => entry.schema === source.table.schema && entry.name === source.table.name);
  if (!table) throw appFailure(409, "The ledger changed while it was being connected. Open the app again.");
  return { dataset: { datasetId: dataset.datasetId, revision: dataset.revision, tables }, table,
    columns: suggestedBookkeepingColumns(table), publisherBotId: source.botId };
}
