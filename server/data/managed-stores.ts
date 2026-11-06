import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { DataCatalog, type DataDataset } from "./catalog.ts";
import { durableCopy, durablePromote, fileHash, removeSourceStore, storeFile, storeFolder, verifyDataSnapshot, DATA_DB_FILE } from "./storage.ts";
import type { DataSnapshotManifest } from "./types.ts";

export async function closeKnownDatabases<T extends { close(strict: boolean): Promise<void>; revoke(): void }>(bots: Iterable<T>, stores: Iterable<T>, revoke = false): Promise<void> {
  const databases = new Set([...bots, ...stores]);
  await Promise.all([...databases].map((database) => database.close(true)));
  if (revoke) for (const database of databases) database.revoke();
}

export function listOwnerDatasets(catalog: DataCatalog, ownerId: string, revisionFor: (dataset: DataDataset) => Promise<number>): Promise<Array<DataDataset & { revision: number }>> {
  return Promise.all(catalog.stores().filter((dataset) => dataset.ownerId === ownerId)
    .map(async (dataset) => ({ ...dataset, revision: await revisionFor(dataset) })));
}

export async function recoverPromotions(catalog: DataCatalog, dataDir: string, botFolder: (botId: string) => string): Promise<void> {
  for (const journal of catalog.promotions()) {
    const destination = storeFolder(dataDir, journal.storeId);
    if (journal.phase === "copying") {
      if (!existsSync(join(botFolder(journal.botId), DATA_DB_FILE))) throw new Error("Data promotion source is missing.");
      await rm(`${destination}.candidate`, { recursive: true, force: true });
      await rm(destination, { recursive: true, force: true });
    } else {
      const file = storeFile(dataDir, journal.storeId);
      if (!journal.sha256 || !existsSync(file) || await fileHash(file) !== journal.sha256) {
        throw new Error("Promoted Data store did not pass recovery verification.");
      }
      await removeSourceStore(botFolder(journal.botId));
    }
    catalog.finishPromotion(journal.storeId);
  }
}

export async function promoteDataStore(
  catalog: DataCatalog, dataDir: string, botFolder: (botId: string) => string,
  botId: string, ownerId: string, closeSource: () => Promise<number>, switched: (dataset: DataDataset) => void,
): Promise<DataDataset & { revision: number }> {
  const revision = await closeSource();
  const sourceFolder = botFolder(botId);
  const promotion = catalog.beginPromotion(botId, ownerId);
  const sha256 = await durablePromote(join(sourceFolder, DATA_DB_FILE), dataDir, promotion.storeId);
  catalog.switchPromotion({ ...promotion, botId, sha256 });
  switched(promotion);
  await removeSourceStore(sourceFolder);
  catalog.finishPromotion(promotion.storeId);
  return { ...promotion, revision };
}

export async function copyDataSnapshots(
  catalog: DataCatalog, dataDir: string, directory: string,
  closeStore: (dataset: DataDataset) => Promise<number>,
): Promise<DataSnapshotManifest> {
  if (catalog.promotions().length) throw new Error("A Data promotion is incomplete.");
  const stores: DataSnapshotManifest["stores"] = [];
  for (const dataset of catalog.stores()) {
    const revision = await closeStore(dataset);
    const path = `stores/${dataset.storeId}/${DATA_DB_FILE}`;
    const sha256 = await durableCopy(storeFile(dataDir, dataset.storeId), join(directory, path));
    stores.push({ datasetId: dataset.datasetId, storeId: dataset.storeId, revision, sha256, path });
  }
  const manifest: DataSnapshotManifest = { version: 1, stores };
  await verifyDataSnapshot(directory, manifest);
  return manifest;
}
