import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface DataCatalogAccess {
  getDatabase(): DatabaseSync;
  withWrite<T>(write: (db: DatabaseSync) => T): T;
}

export interface DataDataset {
  datasetId: string;
  storeId: string;
  ownerId: string;
}

export interface DataPromotion extends DataDataset {
  botId: string;
  phase: "copying" | "switched";
  sha256: string | null;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validDataId(id: string): boolean { return ID.test(id); }

export class DataCatalog {
  private readonly access: DataCatalogAccess;
  private initializedFor: DatabaseSync | null = null;

  constructor(access: DataCatalogAccess) { this.access = access; }

  currentDatabase(): DatabaseSync { return this.access.getDatabase(); }

  private init(): void {
    const database = this.access.getDatabase();
    if (this.initializedFor === database) return;
    this.access.withWrite((db) => db.exec(`
      CREATE TABLE IF NOT EXISTS mini_app_data_stores (
        store_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mini_app_data_datasets (
        dataset_id TEXT PRIMARY KEY, store_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL, FOREIGN KEY (store_id) REFERENCES mini_app_data_stores(store_id)
      );
      CREATE TABLE IF NOT EXISTS mini_app_data_bot_aliases (
        bot_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL,
        FOREIGN KEY (dataset_id) REFERENCES mini_app_data_datasets(dataset_id)
      );
      CREATE TABLE IF NOT EXISTS mini_app_data_promotions (
        store_id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL UNIQUE,
        owner_id TEXT NOT NULL, bot_id TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK (phase IN ('copying', 'switched')),
        sha256 TEXT
      );
    `));
    this.initializedFor = this.access.getDatabase();
  }

  forBot(botId: string): DataDataset | null {
    this.init();
    const row = this.access.getDatabase().prepare(`
      SELECT d.dataset_id AS datasetId, d.store_id AS storeId, d.owner_id AS ownerId
      FROM mini_app_data_bot_aliases a JOIN mini_app_data_datasets d ON d.dataset_id = a.dataset_id
      WHERE a.bot_id = ?
    `).get(botId) as DataDataset | undefined;
    return row ?? null;
  }

  forDataset(datasetId: string, ownerId: string): DataDataset | null {
    this.init();
    if (!validDataId(datasetId)) return null;
    const row = this.access.getDatabase().prepare(`
      SELECT dataset_id AS datasetId, store_id AS storeId, owner_id AS ownerId
      FROM mini_app_data_datasets WHERE dataset_id = ? AND owner_id = ?
    `).get(datasetId, ownerId) as DataDataset | undefined;
    return row ?? null;
  }

  stores(): DataDataset[] {
    this.init();
    return this.access.getDatabase().prepare(`
      SELECT dataset_id AS datasetId, store_id AS storeId, owner_id AS ownerId
      FROM mini_app_data_datasets ORDER BY store_id
    `).all() as unknown as DataDataset[];
  }

  promotions(): DataPromotion[] {
    this.init();
    return this.access.getDatabase().prepare(`
      SELECT dataset_id AS datasetId, store_id AS storeId, owner_id AS ownerId,
             bot_id AS botId, phase, sha256
      FROM mini_app_data_promotions ORDER BY store_id
    `).all() as unknown as DataPromotion[];
  }

  beginPromotion(botId: string, ownerId: string): DataDataset {
    this.init();
    const dataset: DataDataset = { datasetId: randomUUID(), storeId: randomUUID(), ownerId };
    this.access.withWrite((db) => {
      if (db.prepare("SELECT 1 FROM mini_app_data_bot_aliases WHERE bot_id = ?").get(botId)) throw new Error("Data store is already promoted.");
      db.prepare(`INSERT INTO mini_app_data_promotions (store_id, dataset_id, owner_id, bot_id, phase)
        VALUES (?, ?, ?, ?, 'copying')`).run(dataset.storeId, dataset.datasetId, ownerId, botId);
    });
    return dataset;
  }

  switchPromotion(promotion: DataDataset & { botId: string; sha256: string }): void {
    this.init();
    this.access.withWrite((db) => {
      const current = db.prepare("SELECT phase FROM mini_app_data_promotions WHERE store_id = ? AND bot_id = ?").get(promotion.storeId, promotion.botId) as { phase: string } | undefined;
      if (current?.phase !== "copying") throw new Error("Data promotion journal changed.");
      db.prepare("INSERT INTO mini_app_data_stores (store_id, owner_id) VALUES (?, ?)").run(promotion.storeId, promotion.ownerId);
      db.prepare("INSERT INTO mini_app_data_datasets (dataset_id, store_id, owner_id) VALUES (?, ?, ?)").run(promotion.datasetId, promotion.storeId, promotion.ownerId);
      db.prepare("INSERT INTO mini_app_data_bot_aliases (bot_id, dataset_id) VALUES (?, ?)").run(promotion.botId, promotion.datasetId);
      db.prepare("UPDATE mini_app_data_promotions SET phase = 'switched', sha256 = ? WHERE store_id = ?").run(promotion.sha256, promotion.storeId);
    });
  }

  finishPromotion(storeId: string): void {
    this.init();
    this.access.withWrite((db) => db.prepare("DELETE FROM mini_app_data_promotions WHERE store_id = ?").run(storeId));
  }

  detachBot(botId: string): void {
    this.init();
    this.access.withWrite((db) => db.prepare("DELETE FROM mini_app_data_bot_aliases WHERE bot_id = ?").run(botId));
  }
}
