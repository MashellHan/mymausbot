import { t } from "@/lib/i18n";
import { ApiError, api } from "@/state/store";

export type BotDocumentKind = "soul" | "agents";
export type BotDocument = { text: string; hash: string };
export type BotDocumentConflict = { current: string; currentHash: string; reason?: string; mirrorDrift?: true };
export type BotDocumentWrite =
  | { ok: true; doc: BotDocument }
  | ({ ok: false } & BotDocumentConflict);

function documentPath(botId: string, kind: BotDocumentKind) {
  return `/api/bots/${encodeURIComponent(botId)}/documents/${kind}`;
}

function isDocument(value: unknown): value is BotDocument {
  return value !== null && typeof value === "object" &&
    "text" in value && typeof value.text === "string" &&
    "hash" in value && typeof value.hash === "string" && value.hash.length > 0;
}

export async function readBotDocument(botId: string, kind: BotDocumentKind, signal: AbortSignal) {
  const doc = await api<unknown>(documentPath(botId, kind), { signal });
  if (!isDocument(doc)) throw new Error(t("botDocuments.loadFailed"));
  return doc;
}

export async function writeBotDocument(botId: string, kind: BotDocumentKind, text: string, expectedHash: string): Promise<BotDocumentWrite> {
  try {
    const doc = await api<unknown>(documentPath(botId, kind), {
      method: "PUT",
      body: JSON.stringify({ text, expectedHash }),
    });
    if (!isDocument(doc)) throw new Error(t("botDocuments.saveFailed"));
    return { ok: true, doc };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409 && error.body?.code === "conflict") {
      const { current, currentHash, error: detail, mirrorDrift } = error.body;
      if (typeof current === "string" && typeof currentHash === "string") {
        return {
          ok: false, current, currentHash,
          reason: typeof detail === "string" && detail ? error.message : undefined,
          mirrorDrift: mirrorDrift === true ? true : undefined,
        };
      }
    }
    throw error;
  }
}
