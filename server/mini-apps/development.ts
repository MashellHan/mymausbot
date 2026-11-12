import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";

type Receipt = { actor: string; target: string; operation: string; result: string; created_at: number };
type ReceiptApp = { id: string; slug: string; revision: number; templateVersion: number };
type Version = { doc: string; bindings: string };

export function ensureMiniAppDevelopment(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS mini_app_development (
    app_id TEXT NOT NULL, bot_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(app_id, bot_id)
  );
  CREATE INDEX IF NOT EXISTS mini_app_development_bot ON mini_app_development(bot_id);
  CREATE TABLE IF NOT EXISTS mini_app_recommendation_meta (key TEXT PRIMARY KEY);`);
  if (db.prepare("SELECT 1 FROM mini_app_recommendation_meta WHERE key = 'development-backfill-v1'").get()) return;

  const receipts = db.prepare("SELECT actor, target, operation, result, created_at FROM mini_app_receipts").all() as unknown as Receipt[];
  const states = new Map<string, Map<number, number>>();
  const parsed = receipts.flatMap((receipt) => {
    try {
      const app = JSON.parse(receipt.result) as ReceiptApp;
      if (typeof app.id !== "string" || typeof app.slug !== "string" ||
          !Number.isSafeInteger(app.revision) || !Number.isSafeInteger(app.templateVersion) ||
          (receipt.target !== app.id && receipt.target !== `slug:${app.slug}`)) return [];
      const revisions = states.get(app.id) ?? new Map<number, number>();
      revisions.set(app.revision, app.templateVersion);
      states.set(app.id, revisions);
      return [{ ...receipt, app }];
    } catch { return []; }
  });
  const version = db.prepare("SELECT doc, bindings FROM mini_app_versions WHERE app_id = ? AND version = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO mini_app_development VALUES (?, ?, ?)");
  const exists = db.prepare("SELECT 1 FROM mini_apps WHERE id = ?");
  for (const { actor, operation, app, created_at } of parsed) {
    if (actor === "workspace-owner" || operation !== "publish" || !exists.get(app.id)) continue;
    const current = version.get(app.id, app.templateVersion) as Version | undefined;
    if (!current) continue;
    const previousVersion = states.get(app.id)?.get(app.revision - 1);
    const previous = previousVersion === undefined ? undefined : version.get(app.id, previousVersion) as Version | undefined;
    if (app.revision === 1 || (previous && (previous.doc !== current.doc ||
        !isDeepStrictEqual(JSON.parse(previous.bindings), JSON.parse(current.bindings))))) {
      insert.run(app.id, actor, created_at);
    }
  }
  db.prepare("INSERT INTO mini_app_recommendation_meta VALUES ('development-backfill-v1')").run();
}

export function developedMiniApps(db: DatabaseSync, botId: string): Set<string> {
  return new Set((db.prepare("SELECT app_id FROM mini_app_development WHERE bot_id = ?").all(botId) as Array<{ app_id: string }>).map(({ app_id }) => app_id));
}

export function recordMiniAppDevelopment(db: DatabaseSync, appId: string, botId: string, at: number): void {
  db.prepare("INSERT OR IGNORE INTO mini_app_development VALUES (?, ?, ?)").run(appId, botId, at);
}
