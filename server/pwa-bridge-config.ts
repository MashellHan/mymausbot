// Persisted Mac PWA bridge configuration in DATA_DIR (`pwa-bridge.json`, mode 0600, excluded from workspace backups).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import type { PwaBridgePublicConfig } from "../shared/pwa-bridge.ts";
import { writeFileAtomic } from "./atomic.ts";

export type { PwaBridgePublicConfig };

export const PWA_BRIDGE_CONFIG_FILE = "pwa-bridge.json";
export const DEFAULT_PWA_ORIGIN = "https://mausbot.mxhan.com";
export const DEFAULT_PWA_RELAY_URL = "https://relay.mxhan.com";
export const DEFAULT_PWA_HOST_ID = "mac-mini";

export interface PwaBridgeConfig {
  enabled: boolean;
  relayUrl: string;
  hostId: string;
  bridgeSecret: string;
  pwaOrigin: string;
  defaultBotId: string | null;
}

const storedSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean().default(false),
  relayUrl: z.string().default(""),
  hostId: z.string().default(DEFAULT_PWA_HOST_ID),
  bridgeSecret: z.string().default(""),
  pwaOrigin: z.string().default(DEFAULT_PWA_ORIGIN),
  defaultBotId: z.string().nullable().default(null),
});

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/** Validates an origin-only URL (`https://...`, or `http://` on loopback for local fixtures). */
export function normalizeBridgeHttpOrigin(raw: string, label: string): { ok: true; origin: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, origin: "" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `${label} must be a valid https:// URL` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: `${label} must not contain credentials` };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, error: `${label} must not contain query parameters or fragments` };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { ok: false, error: `${label} must be an origin without a path` };
  }
  const loopbackHttp = parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname.toLowerCase());
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    return { ok: false, error: `${label} must use https://` };
  }
  return { ok: true, origin: parsed.origin };
}

export function normalizeHostId(raw: string): { ok: true; hostId: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, hostId: "" };
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    return { ok: false, error: "hostId must be 1 to 64 characters using letters, numbers, '.', '_' or '-'" };
  }
  return { ok: true, hostId: trimmed };
}

export function normalizeBotId(raw: string | null | undefined): { ok: true; defaultBotId: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, defaultBotId: null };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, defaultBotId: null };
  if (!/^[\w-]{1,128}$/.test(trimmed)) {
    return { ok: false, error: "defaultBotId must be a valid bot id" };
  }
  return { ok: true, defaultBotId: trimmed };
}

export function defaultPwaBridgeConfig(): PwaBridgeConfig {
  return {
    enabled: false,
    relayUrl: DEFAULT_PWA_RELAY_URL,
    hostId: DEFAULT_PWA_HOST_ID,
    bridgeSecret: "",
    pwaOrigin: DEFAULT_PWA_ORIGIN,
    defaultBotId: null,
  };
}

export function publicPwaBridgeConfig(config: PwaBridgeConfig): PwaBridgePublicConfig {
  return {
    enabled: config.enabled,
    relayUrl: config.relayUrl,
    hostId: config.hostId,
    hasBridgeSecret: config.bridgeSecret.length > 0,
    pwaOrigin: config.pwaOrigin,
    defaultBotId: config.defaultBotId,
  };
}

export function generatePwaBridgeSecret(): { secret: string; sha256: string } {
  const secret = `omb_bridge_${randomBytes(32).toString("base64url")}`;
  const sha256 = createHash("sha256").update(secret, "utf8").digest("hex");
  return { secret, sha256 };
}

export function loadPwaBridgeConfig(dataDir: string): PwaBridgeConfig {
  const file = join(dataDir, PWA_BRIDGE_CONFIG_FILE);
  if (!existsSync(file)) return defaultPwaBridgeConfig();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const parsed = storedSchema.safeParse(raw);
    if (!parsed.success) return defaultPwaBridgeConfig();
    const relay = normalizeBridgeHttpOrigin(parsed.data.relayUrl, "relayUrl");
    const pwa = normalizeBridgeHttpOrigin(parsed.data.pwaOrigin, "pwaOrigin");
    const host = normalizeHostId(parsed.data.hostId);
    const bot = normalizeBotId(parsed.data.defaultBotId);
    return {
      enabled: parsed.data.enabled,
      relayUrl: relay.ok ? relay.origin : DEFAULT_PWA_RELAY_URL,
      hostId: host.ok && host.hostId ? host.hostId : DEFAULT_PWA_HOST_ID,
      bridgeSecret: parsed.data.bridgeSecret,
      pwaOrigin: pwa.ok && pwa.origin ? pwa.origin : DEFAULT_PWA_ORIGIN,
      defaultBotId: bot.ok ? bot.defaultBotId : null,
    };
  } catch {
    return defaultPwaBridgeConfig();
  }
}

export function savePwaBridgeConfig(dataDir: string, config: PwaBridgeConfig): void {
  const file = join(dataDir, PWA_BRIDGE_CONFIG_FILE);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(
    file,
    JSON.stringify({ version: 1, ...config }, null, 2) + "\n",
    { mode: 0o600 },
  );
}
