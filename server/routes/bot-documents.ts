import { z } from "zod";

import type { BotAccessLevel } from "../../shared/bot-access.ts";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile.ts";
import { readAgentMirror, readSoulMirror, soulHash } from "../bot-folder.ts";
import { profileRevision, profileSnapshot } from "../profile-revision.ts";
import { recordProfileChange } from "../profile-versions.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

type DocumentKind = "agents" | "soul";

const saveSchema = z.strictObject({
  text: z.string().refine((text) => Buffer.byteLength(text, "utf8") <= BOT_PROFILE_LIMITS.soul &&
    Buffer.from(text).toString("utf8") === text, "The document must be valid UTF-8 and at most 24000 bytes"),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
});

function documentState(bot: BotRecord, kind: DocumentKind) {
  if (kind === "agents") {
    const text = bot.agentInstructions ?? "";
    const mirror = readAgentMirror(bot.id);
    return { doc: { text, hash: soulHash(JSON.stringify([bot.id, text, mirror ?? null])) }, mirror };
  }
  const text = bot.soul ?? "";
  const mirror = readSoulMirror(bot.id);
  const hash = soulHash(JSON.stringify([bot.id, profileRevision(bot), mirror ?? null]));
  return { doc: { text, hash }, mirror };
}

export function createBotDocumentRoutes({ store, levelOf, changed }: {
  store: Pick<Store, "bot" | "setSoul" | "setAgentInstructions">;
  levelOf(auth: RequestAuth, botId: string): BotAccessLevel;
  changed(bot: BotRecord): void;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = /^\/api\/bots\/([\w-]+)\/documents\/(agents|soul)$/.exec(path);
    if (!match || (method !== "GET" && method !== "PUT")) return PASS;
    const botId = match[1]!;
    const kind = match[2] as DocumentKind;
    const profileScope = auth.scopes.includes("admin") ||
      (auth.kind === "session" && auth.session.membershipAuthority === "team");
    const companion = req.headers["x-openmausbot-companion"] === "1";
    const access = () => {
      const bot = store.bot(botId);
      const level = levelOf(auth, botId);
      if (!bot || bot.home || level === "none") return { status: 404, error: "no such bot" } as const;
      if (level !== "edit" || !profileScope || companion) {
        return { status: 403, error: "Only people who can edit this bot can manage its standing instructions" } as const;
      }
      return bot;
    };
    const before = access();
    if ("status" in before) return json(res, before.status, { error: before.error });
    if (method === "GET") return json(res, 200, documentState(before, kind).doc);
    const parsed = saveSchema.safeParse(await readBody(req, 6 * BOT_PROFILE_LIMITS.soul + 1024));
    if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "Invalid document" });

    const bot = access();
    if ("status" in bot) return json(res, bot.status, { error: bot.error });
    const { text, expectedHash } = parsed.data;
    const { doc, mirror } = documentState(bot, kind);
    const mirrorDrift = mirror !== undefined && mirror !== doc.text;
    const soulDrift = kind === "soul" && mirrorDrift;
    if (doc.hash !== expectedHash || soulDrift) {
      return json(res, 409, {
        error: soulDrift ? "SOUL.md has external edits. Resolve them in Bot settings before saving." : "The document changed since you opened it.",
        code: "conflict",
        current: kind === "agents" ? mirror ?? doc.text : doc.text,
        currentHash: doc.hash,
        ...(soulDrift ? { mirrorDrift: true } : {}),
      });
    }
    if (doc.text === text && !mirrorDrift) return json(res, 200, doc);
    if (kind === "agents") {
      const saved = store.setAgentInstructions(bot.id, text);
      if (!saved) return json(res, 404, { error: "no such bot" });
      return json(res, 200, documentState(saved, kind).doc);
    }

    const previous = profileSnapshot(bot);
    const saved = store.setSoul(bot.id, text);
    if (!saved) return json(res, 404, { error: "no such bot" });
    recordProfileChange(bot.id, "user", "ui", previous, profileSnapshot(saved));
    changed(saved);
    return json(res, 200, documentState(saved, kind).doc);
  };
}
