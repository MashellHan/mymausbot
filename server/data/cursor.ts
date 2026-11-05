import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { MiniAppNamedRead } from "../../shared/mini-app-data.ts";
import { DataFailure } from "./types.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class DataCursorCodec {
  private readonly key = randomBytes(32);

  private context(input: MiniAppNamedRead): string {
    return createHash("sha256").update(canonical({ ownerId: input.ownerId, binding: input.binding, queryId: input.queryId, parameters: input.parameters, scope: input.scope })).digest("hex");
  }

  next(input: MiniAppNamedRead, revision: number, offset: number): string {
    const body = Buffer.from(JSON.stringify({ context: this.context(input), revision, offset, expires: Date.now() + 10 * 60_000 })).toString("base64url");
    const signature = createHmac("sha256", this.key).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  position(input: MiniAppNamedRead): { revision: number; offset: number } | null {
    if (!input.cursor) return null;
    if (input.cursor.length > 4096) throw new DataFailure({ code: "invalid_input", message: "Invalid Data cursor." });
    const [body, signature, extra] = input.cursor.split(".");
    if (!body || !signature || extra) throw new DataFailure({ code: "invalid_input", message: "Invalid Data cursor." });
    const expected = createHmac("sha256", this.key).update(body).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new DataFailure({ code: "invalid_input", message: "Invalid Data cursor." });
    let position: { context?: unknown; revision?: unknown; offset?: unknown; expires?: unknown };
    try { position = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); }
    catch { throw new DataFailure({ code: "invalid_input", message: "Invalid Data cursor." }); }
    if (!position || position.context !== this.context(input) || typeof position.expires !== "number" || position.expires < Date.now() ||
        !Number.isSafeInteger(position.revision) || !Number.isSafeInteger(position.offset) || Number(position.offset) < 0) {
      throw new DataFailure({ code: "write_refused", message: "Data cursor expired or its query changed." });
    }
    return { revision: Number(position.revision), offset: Number(position.offset) };
  }
}
