import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MINI_APPS_OWNER, ensureMiniApps, type MiniAppActor } from "./registry.ts";
import { appFailure } from "./validation.ts";

export const MINI_APP_ACTION_CAPABILITIES = {
  "run-routine": "action:routine-run",
  "send-bot-message": "action:bot-task",
  "append-record": "action:dataset-append",
} as const;

const scalarValueSchema = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()]);

export const miniAppActionRequestSchema = z.object({
  expectedRevision: z.number().int().min(1),
  requestKey: z.string().regex(/^[A-Za-z0-9._:-]{4,128}$/),
  action: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("run-routine"),
      routineId: z.string().min(1).max(128),
    }).strict(),
    z.object({
      kind: z.literal("send-bot-message"),
      threadId: z.string().min(1).max(128).optional(),
      prompt: z.string().min(1).max(4000),
      context: z.record(z.string().max(64), scalarValueSchema).optional(),
    }).strict(),
    z.object({
      kind: z.literal("append-record"),
      bindingDatasetId: z.string().uuid(),
      table: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      row: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), scalarValueSchema),
    }).strict(),
  ]),
}).strict();

export type MiniAppActionRequest = z.infer<typeof miniAppActionRequestSchema>;

export interface MiniAppActionResult {
  appId: string;
  revision: number;
  kind: MiniAppActionRequest["action"]["kind"];
  replayed: boolean;
  receiptKey: string;
  detail: Record<string, unknown>;
}

export interface MiniAppActionHandlers {
  runRoutine?(input: { appId: string; responsibleBotId: string | null; routineId: string }): Promise<Record<string, unknown>>;
  sendBotMessage?(input: { appId: string; responsibleBotId: string; threadId?: string; prompt: string; context?: Record<string, unknown> }): Promise<Record<string, unknown>>;
  appendRecord?(input: { appId: string; datasetId: string; table: string; row: Record<string, string | number | boolean | null> }): Promise<Record<string, unknown>>;
}

function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasActionCapability(capabilities: string[], action: MiniAppActionRequest["action"]): boolean {
  const required = MINI_APP_ACTION_CAPABILITIES[action.kind];
  if (capabilities.includes(required)) return true;
  if (action.kind === "append-record") {
    return capabilities.includes(`${required}:${action.bindingDatasetId}`) || capabilities.includes(`${required}:${action.table}`);
  }
  return false;
}

export class MiniAppActionBridge {
  constructor(
    private readonly dbAccess: { database(): DatabaseSync; write<T>(work: (db: DatabaseSync) => T): T },
    private readonly handlers: MiniAppActionHandlers = {},
  ) {}

  async invoke(actor: MiniAppActor, appId: string, raw: unknown): Promise<MiniAppActionResult> {
    actor.assertActive();
    if (!actor.writeAllowed || actor.botId) {
      throw appFailure(403, "Only the local workspace owner can execute Mini App actions.", "action_owner_only");
    }
    const parsed = miniAppActionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw appFailure(400, "Invalid Mini App action request.", "invalid_action_request");
    }
    const input = parsed.data;
    const contentHash = canonicalHash({ expectedRevision: input.expectedRevision, action: input.action });
    const receiptActor = MINI_APPS_OWNER;
    const operation = `action:${input.action.kind}`;

    const db = this.dbAccess.database();
    ensureMiniApps(db);

    const existingReceipt = db.prepare(
      "SELECT content_hash, result FROM mini_app_receipts WHERE actor = ? AND target = ? AND operation = ? AND request_key = ?",
    ).get(receiptActor, appId, operation, input.requestKey) as { content_hash: string; result: string } | undefined;

    if (existingReceipt) {
      if (existingReceipt.content_hash !== contentHash) {
        throw appFailure(409, "This requestKey was already used with a different action payload.", "idempotency_conflict");
      }
      const saved = JSON.parse(existingReceipt.result) as MiniAppActionResult;
      return { ...saved, replayed: true };
    }

    const appRow = db.prepare(
      "SELECT status, revision, template_version, responsible_bot_id, capabilities FROM mini_apps WHERE owner_id = ? AND id = ?",
    ).get(MINI_APPS_OWNER, appId) as {
      status: string;
      revision: number;
      template_version: number;
      responsible_bot_id: string | null;
      capabilities: string;
    } | undefined;

    if (!appRow) throw appFailure(404, "Mini App not found.");
    if (appRow.status !== "active") throw appFailure(409, "Archived Mini Apps cannot run actions.", "app_archived");
    if (appRow.revision !== input.expectedRevision) {
      throw appFailure(409, "Mini App revision changed. Refresh and try again.", "revision_conflict");
    }

    const capabilities = JSON.parse(appRow.capabilities || "[]") as string[];
    if (!hasActionCapability(capabilities, input.action)) {
      throw appFailure(403, `This Mini App lacks the required capability (${MINI_APP_ACTION_CAPABILITIES[input.action.kind]}).`, "capability_denied");
    }

    let detail: Record<string, unknown>;
    if (input.action.kind === "run-routine") {
      if (!this.handlers.runRoutine) throw appFailure(503, "Routine execution is unavailable for Mini Apps.");
      detail = await this.handlers.runRoutine({
        appId,
        responsibleBotId: appRow.responsible_bot_id,
        routineId: input.action.routineId,
      });
    } else if (input.action.kind === "send-bot-message") {
      if (!appRow.responsible_bot_id) {
        throw appFailure(403, "This Mini App has no assigned responsible Bot.", "missing_responsible_bot");
      }
      if (!this.handlers.sendBotMessage) throw appFailure(503, "Bot messaging is unavailable for Mini Apps.");
      detail = await this.handlers.sendBotMessage({
        appId,
        responsibleBotId: appRow.responsible_bot_id,
        threadId: input.action.threadId,
        prompt: input.action.prompt,
        context: input.action.context,
      });
    } else {
      const versionRow = db.prepare(
        "SELECT bindings FROM mini_app_versions WHERE app_id = ? AND version = ?",
      ).get(appId, appRow.template_version) as { bindings: string } | undefined;
      const bindings = versionRow ? (JSON.parse(versionRow.bindings) as Array<{ datasetId: string }>) : [];
      if (!bindings.some((binding) => binding.datasetId === input.action.bindingDatasetId)) {
        throw appFailure(403, "Dataset is not bound to this Mini App.", "unbound_dataset");
      }
      if (Object.keys(input.action.row).length === 0) {
        throw appFailure(400, "Record row must include at least one column.");
      }
      if (!this.handlers.appendRecord) throw appFailure(503, "Dataset append is unavailable for Mini Apps.");
      detail = await this.handlers.appendRecord({
        appId,
        datasetId: input.action.bindingDatasetId,
        table: input.action.table,
        row: input.action.row,
      });
    }

    const result: MiniAppActionResult = {
      appId,
      revision: appRow.revision,
      kind: input.action.kind,
      replayed: false,
      receiptKey: input.requestKey,
      detail,
    };

    this.dbAccess.write((writeDb) => {
      ensureMiniApps(writeDb);
      writeDb.prepare(`
        INSERT OR IGNORE INTO mini_app_receipts (actor, target, operation, request_key, content_hash, result, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(receiptActor, appId, operation, input.requestKey, contentHash, JSON.stringify(result), Date.now());
    });

    return result;
  }
}
