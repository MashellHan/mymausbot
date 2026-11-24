// Desktop/admin routes for configuring the Mac PWA bridge, rotating its secret, and minting `#pair=` invites.
import { z } from "zod";

import type {
  PwaBridgeInviteResponse,
  PwaBridgeRotateSecretResponse,
  PwaBridgeSettingsResponse,
  PwaPairingPayload,
} from "../../shared/pwa-bridge.ts";
import type { PwaBridge } from "../pwa-bridge.ts";
import {
  DEFAULT_PWA_ORIGIN,
  generatePwaBridgeSecret,
  normalizeBotId,
  normalizeBridgeHttpOrigin,
  normalizeHostId,
  publicPwaBridgeConfig,
  savePwaBridgeConfig,
  type PwaBridgeConfig,
} from "../pwa-bridge-config.ts";
import { ownerOrAdmin } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";
import { userErrorFields } from "../user-errors.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface PwaBridgeRouteDeps {
  bridge: () => PwaBridge | null;
  dataDir: string;
  sessions: Pick<SessionRegistry, "openPairing" | "isLive">;
  managedRemoteAccessRefusal?: () => string | undefined;
}

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    relayUrl: z.string().optional(),
    hostId: z.string().optional(),
    pwaOrigin: z.string().optional(),
    defaultBotId: z.string().nullable().optional(),
  })
  .strict();

const inviteSchema = z
  .object({
    label: z.string().max(80).optional(),
    defaultBotId: z.string().nullable().optional(),
  })
  .strict();

export function createPwaBridgeRoutes(deps: PwaBridgeRouteDeps): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const isRoot = path === "/api/pwa-bridge";
    const isRotate = path === "/api/pwa-bridge/rotate-secret";
    const isInvite = path === "/api/pwa-bridge/invite";
    if (!isRoot && !isRotate && !isInvite) return PASS;

    if (!ownerOrAdmin(auth)) {
      json(res, 403, { error: "forbidden: admin scope required" });
      return;
    }

    const bridge = deps.bridge();
    if (!bridge) {
      json(res, 403, { error: "PWA bridge is unavailable on this server." });
      return;
    }

    if (isRoot && method === "GET") {
      json(res, 200, {
        config: publicPwaBridgeConfig(bridge.config()),
        status: bridge.status(),
      } satisfies PwaBridgeSettingsResponse);
      return;
    }

    if (isRoot && method === "PUT") {
      if (auth.kind === "session" && !deps.sessions.isLive(auth.session.id)) {
        json(res, 401, { error: "Your session ended. Sign in again before updating PWA bridge settings." });
        return;
      }
      let raw: unknown;
      try {
        raw = await readBody(req, 8_192);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (auth.kind === "session" && !deps.sessions.isLive(auth.session.id)) {
        json(res, 401, { error: "Your session ended. Sign in again before updating PWA bridge settings." });
        return;
      }
      const parsed = updateSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid PWA bridge settings" });
        return;
      }
      const current = bridge.config();
      const relay = parsed.data.relayUrl !== undefined
        ? normalizeBridgeHttpOrigin(parsed.data.relayUrl, "relayUrl")
        : { ok: true as const, origin: current.relayUrl };
      if (!relay.ok) {
        json(res, 400, { error: relay.error });
        return;
      }
      const pwa = parsed.data.pwaOrigin !== undefined
        ? normalizeBridgeHttpOrigin(parsed.data.pwaOrigin, "pwaOrigin")
        : { ok: true as const, origin: current.pwaOrigin };
      if (!pwa.ok) {
        json(res, 400, { error: pwa.error });
        return;
      }
      const host = parsed.data.hostId !== undefined
        ? normalizeHostId(parsed.data.hostId)
        : { ok: true as const, hostId: current.hostId };
      if (!host.ok) {
        json(res, 400, { error: host.error });
        return;
      }
      const bot = parsed.data.defaultBotId !== undefined
        ? normalizeBotId(parsed.data.defaultBotId)
        : { ok: true as const, defaultBotId: current.defaultBotId };
      if (!bot.ok) {
        json(res, 400, { error: bot.error });
        return;
      }

      const updatingSettings =
        parsed.data.relayUrl !== undefined ||
        parsed.data.hostId !== undefined ||
        parsed.data.pwaOrigin !== undefined ||
        parsed.data.defaultBotId !== undefined;
      const next: PwaBridgeConfig = {
        enabled: parsed.data.enabled ?? (updatingSettings ? true : current.enabled),
        relayUrl: relay.origin,
        hostId: host.hostId,
        bridgeSecret: current.bridgeSecret,
        pwaOrigin: pwa.origin || DEFAULT_PWA_ORIGIN,
        defaultBotId: bot.defaultBotId,
      };
      if (next.enabled) {
        const refusal = deps.managedRemoteAccessRefusal?.();
        if (refusal) {
          json(res, 403, { error: refusal, code: "managed_policy" });
          return;
        }
        if (!next.relayUrl || !next.hostId) {
          json(res, 400, { error: "relayUrl and hostId are required when enabling the PWA bridge" });
          return;
        }
      }
      savePwaBridgeConfig(deps.dataDir, next);
      bridge.applyConfig(next);
      json(res, 200, {
        config: publicPwaBridgeConfig(bridge.config()),
        status: bridge.status(),
      } satisfies PwaBridgeSettingsResponse);
      return;
    }

    if (isRotate && method === "POST") {
      const { secret, sha256 } = generatePwaBridgeSecret();
      const current = bridge.config();
      const shouldEnable = !current.enabled && Boolean(current.relayUrl && current.hostId) && !deps.managedRemoteAccessRefusal?.();
      const next: PwaBridgeConfig = {
        ...current,
        enabled: shouldEnable ? true : current.enabled,
        bridgeSecret: secret,
      };
      savePwaBridgeConfig(deps.dataDir, next);
      bridge.applyConfig(next);
      json(res, 200, {
        config: publicPwaBridgeConfig(bridge.config()),
        status: bridge.status(),
        bridgeSecret: secret,
        bridgeSecretSha256: sha256,
      } satisfies PwaBridgeRotateSecretResponse);
      return;
    }

    if (isInvite && method === "POST") {
      const refusal = deps.managedRemoteAccessRefusal?.();
      if (refusal) {
        json(res, 403, { error: refusal, code: "managed_policy" });
        return;
      }
      if (auth.kind === "session" && !deps.sessions.isLive(auth.session.id)) {
        json(res, 401, { error: "Your session ended. Sign in again before creating a pairing link." });
        return;
      }
      let raw: unknown;
      try {
        raw = await readBody(req, 4_096);
      } catch {
        json(res, 400, { error: "invalid JSON body" });
        return;
      }
      if (auth.kind === "session" && !deps.sessions.isLive(auth.session.id)) {
        json(res, 401, { error: "Your session ended. Sign in again before creating a pairing link." });
        return;
      }
      const postBodyRefusal = deps.managedRemoteAccessRefusal?.();
      if (postBodyRefusal) {
        json(res, 403, { error: postBodyRefusal, code: "managed_policy" });
        return;
      }
      const parsed = inviteSchema.safeParse(raw);
      if (!parsed.success) {
        json(res, 400, { error: parsed.error.issues[0]?.message ?? "invalid invite request" });
        return;
      }
      const cfg = bridge.config();
      if (!cfg.enabled || !cfg.relayUrl || !cfg.hostId || !cfg.bridgeSecret) {
        json(res, 409, { error: "Enable and configure the PWA bridge before creating a pairing link." });
        return;
      }
      const bot = parsed.data.defaultBotId !== undefined
        ? normalizeBotId(parsed.data.defaultBotId)
        : { ok: true as const, defaultBotId: cfg.defaultBotId };
      if (!bot.ok) {
        json(res, 400, { error: bot.error });
        return;
      }

      let opened: ReturnType<SessionRegistry["openPairing"]>;
      try {
        opened = deps.sessions.openPairing({
          scopes: ["client"],
          pwa: true,
          label: parsed.data.label?.trim() || "Mobile PWA",
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === "cloud_personal") {
          json(res, 403, {
            error: (error as Error).message,
            code: "cloud_personal",
            ...userErrorFields(error),
          });
          return;
        }
        throw error;
      }

      const payload: PwaPairingPayload = {
        relayUrl: cfg.relayUrl,
        credential: opened.credential,
        ...(bot.defaultBotId ? { defaultBotId: bot.defaultBotId } : {}),
      };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const origin = (cfg.pwaOrigin || DEFAULT_PWA_ORIGIN).replace(/\/+$/, "");
      json(res, 200, {
        id: opened.id,
        inviteUrl: `${origin}/#pair=${encoded}`,
        expiresAt: opened.expiresAt,
        relayUrl: cfg.relayUrl,
        defaultBotId: bot.defaultBotId,
      } satisfies PwaBridgeInviteResponse);
      return;
    }

    return PASS;
  };
}
