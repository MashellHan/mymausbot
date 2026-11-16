import { z } from "zod";

import { credentialIsConfigured, CREDENTIAL_TARGETS, PROVIDER_CREDENTIAL_TARGETS, type CredentialConfig, type CredentialTargetId } from "../../shared/credential-request.ts";
import { WINDOW_PREFS, type WindowPrefId } from "../../shared/app-settings.ts";
import { defaultBotThreads, MAX_CONCURRENT_BOT_THREADS } from "../bot-thread-limits.ts";
import { MAX_MCP_CALL_TIMEOUT_MINUTES, MAX_ROOM_TURN_TIMEOUT_MINUTES, mcpCallTimeoutMinutes, MIN_MCP_CALL_TIMEOUT_MINUTES, MIN_ROOM_TURN_TIMEOUT_MINUTES, roomTurnTimeoutMinutes, type AppConfig } from "../config.ts";
import type { RequestAuth } from "../request-auth.ts";
import { callRoute, type RouteReply } from "../routes/call-route.ts";
import type { RouteHandler } from "../routes/table.ts";
import type { BotRecord, Store } from "../store.ts";

/** Where the person changes it by hand, as the bot tells them. */
type Where = "Settings → Appearance" | "Settings → General" | "Settings → AI" | "Settings → AI → API keys" | "Settings → You and your bots"
  | "Settings → Phone & devices" | "Settings → Vault" | "Settings → Data" | "Settings → Your account" | "Settings → Desktops & browser" | "the sidebar" | "a bot's Settings";

interface Base {
  id: string;
  label: string;
  help: string;
  where: Where;
  synonyms: string[];
  /** What a person or bot sees. Never a secret: a key reads as set or not set. */
  read(): string;
}
/** `value` checks what the bot sends at the boundary; `current` is the typed value as `write` takes it, kept for Undo. */
interface Writable {
  tier: "safe" | "confirm";
  value: z.ZodType;
  allowed: string;
  current(): unknown;
  write(value: unknown): Promise<string | null>;
}
interface Secret {
  tier: "secret";
  credentialId: CredentialTargetId;
}
interface OwnerOnly {
  tier: "owner-only";
}
export type SettingEntry = Base & (Writable | Secret | OwnerOnly);
export type WritableEntry = Base & Writable;

export interface RegistryDeps {
  cfg(): AppConfig;
  /** PUT /api/config as Settings does; a refusal comes back as its text. */
  saveConfig(patch: Record<string, unknown>): Promise<string | null>;
  bots(): BotRecord[];
  sections(): string[];
  reorderBots(botIds: string[]): Promise<string | null>;
  credentials(): CredentialConfig;
  window: { read(id: WindowPrefId): unknown; write(id: WindowPrefId, value: unknown): string | null };
}

/** A setting's value for a person or bot; empty when unset, so each edge can say "not set" in its own words. */
export const display = (value: unknown): string => (value === undefined || value === null || value === "" ? "" : typeof value === "string" ? value : JSON.stringify(value));
const url = z.string().trim().max(2048).refine((text) => text === "" || /^https?:\/\/\S+$/.test(text), "an http(s) address, or empty to clear");

const KEY_WHERE: Partial<Record<CredentialTargetId, Where>> = {
  ttsKey: "Settings → General", geminiTtsKey: "Settings → General", fishAudioKey: "Settings → General",
  onePasswordToken: "Settings → Vault", boxToken: "Settings → Desktops & browser", composioApiKey: "Settings → AI",
};

type WritableSpec = Omit<Base, "read"> & Omit<Writable, "write"> & { read?(): string; write(value: never): Promise<string | null> };

export function createSettingsRegistry(deps: RegistryDeps): SettingEntry[] {
  const cfg = deps.cfg;
  const names = (ids: readonly string[]) => ids.map((id) => deps.bots().find((bot) => bot.id === id)?.name ?? id).join(", ");
  const writable = (spec: WritableSpec): SettingEntry => ({ ...spec, read: spec.read ?? (() => display(spec.current())), write: spec.write as Writable["write"] });
  const config = <V,>(patch: (value: V) => Record<string, unknown>) => (value: V) => deps.saveConfig(patch(value));
  const windowPref = (id: WindowPrefId, label: string, help: string, where: Where, synonyms: string[], allowed: string): SettingEntry =>
    writable({ id, label, help, where, synonyms, tier: "safe", value: WINDOW_PREFS[id], allowed, current: () => deps.window.read(id), write: async (value: unknown) => deps.window.write(id, value) });
  const enumOf = (values: readonly string[]) => values.join(", ");
  const groups = () => Object.fromEntries(deps.sections().map((section) => [section, deps.bots().filter((bot) => bot.section === section).map((bot) => bot.id)]));

  const safe: SettingEntry[] = [
    windowPref("appearance.skin", "Skin", "The window's look; \"system\" follows the computer's light or dark mode.", "Settings → Appearance", ["theme", "dark mode", "light mode", "colors", "look"], enumOf(WINDOW_PREFS["appearance.skin"].options)),
    windowPref("appearance.mode", "Interface mode", "Raw is the first-use layout; Simple shows everyday controls; Advanced shows every setting and tool.", "Settings → Appearance", ["raw mode", "simple mode", "advanced mode", "interface mode"], enumOf(WINDOW_PREFS["appearance.mode"].options)),
    windowPref("appearance.font", "Font", "The app's typeface.", "Settings → Appearance", ["typeface", "typography"], enumOf(WINDOW_PREFS["appearance.font"].options)),
    windowPref("appearance.chatWidth", "Chat width", "How wide the chat column is.", "Settings → Appearance", ["layout", "column", "wide"], enumOf(WINDOW_PREFS["appearance.chatWidth"].options)),
    windowPref("general.sendKey", "Send key", "Which key sends a message in the composer.", "Settings → General", ["enter", "typing", "keyboard", "shortcut"], enumOf(WINDOW_PREFS["general.sendKey"].options)),
    windowPref("general.notificationSounds", "Notification sounds", "Play a sound when a bot needs you or finishes.", "Settings → General", ["sound", "sounds", "mute", "alerts", "notifications"], "true or false"),
    writable({
      id: "general.language", label: "Language", help: "The app's language, as a tag such as en, de or pt-br; empty follows the computer.", where: "Settings → General",
      synonyms: ["locale", "translation"], tier: "safe", value: z.string().trim().max(16).regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$|^$/i, "a language tag such as en or pt-br"), allowed: "a language tag such as en, de, ja, pt-br, zh-tw; empty to follow the computer",
      current: () => cfg().language ?? "", write: config((language: string) => ({ language })),
    }),
    writable({
      id: "bots.order", label: "Bot order", help: "The order bots are listed in the sidebar and on phones. Send bot ids from list_bots; bots you leave out keep their places.", where: "the sidebar",
      synonyms: ["reorder", "sidebar order", "sort bots", "move bot", "arrange"], tier: "safe", value: z.array(z.string().regex(/^[\w-]+$/)).min(1).max(100), allowed: "an array of bot ids in the wanted order",
      current: () => deps.bots().map((bot) => bot.id), read: () => names(deps.bots().map((bot) => bot.id)), write: (botIds: string[]) => deps.reorderBots(botIds),
    }),
    writable({
      id: "threads.maxConcurrentPerBot", label: "Threads per bot", help: "How many conversations one bot may work on at once.", where: "Settings → You and your bots",
      synonyms: ["concurrent", "parallel", "limit", "limits", "thread limit"], tier: "safe", value: z.number().int().min(1).max(MAX_CONCURRENT_BOT_THREADS), allowed: `1 to ${MAX_CONCURRENT_BOT_THREADS}`,
      current: () => cfg().threads?.maxConcurrentPerBot ?? defaultBotThreads(), write: config((maxConcurrentPerBot: number) => ({ threads: { maxConcurrentPerBot } })),
    }),
    writable({
      id: "threads.eventLogRetentionDays", label: "Thread log retention", help: "Days a closed conversation's event logs are kept; null keeps them forever.", where: "Settings → Data",
      synonyms: ["cleanup", "clean up", "retention", "logs", "delete old", "storage"], tier: "safe", value: z.number().int().min(1).max(3650).nullable(), allowed: "1 to 3650 days, or null to keep forever",
      current: () => cfg().threads?.eventLogRetentionDays ?? null, read: () => display(cfg().threads?.eventLogRetentionDays ?? "forever"),
      write: config((eventLogRetentionDays: number | null) => ({ threads: { eventLogRetentionDays } })),
    }),
    writable({
      id: "rooms.turnTimeoutMinutes", label: "Room turn timeout", help: "Minutes a bot's turn in a room may run before it is stopped.", where: "Settings → You and your bots",
      synonyms: ["room", "channel", "timeout", "turn limit"], tier: "safe", value: z.number().int().min(MIN_ROOM_TURN_TIMEOUT_MINUTES).max(MAX_ROOM_TURN_TIMEOUT_MINUTES), allowed: `${MIN_ROOM_TURN_TIMEOUT_MINUTES} to ${MAX_ROOM_TURN_TIMEOUT_MINUTES} minutes`,
      current: () => roomTurnTimeoutMinutes(cfg()), write: config((turnTimeoutMinutes: number) => ({ rooms: { turnTimeoutMinutes } })),
    }),
    writable({
      id: "mcp.callTimeoutMinutes", label: "MCP call timeout", help: "Minutes one MCP tool call may run.", where: "Settings → AI",
      synonyms: ["mcp", "tool timeout", "call timeout"], tier: "safe", value: z.number().int().min(MIN_MCP_CALL_TIMEOUT_MINUTES).max(MAX_MCP_CALL_TIMEOUT_MINUTES), allowed: `${MIN_MCP_CALL_TIMEOUT_MINUTES} to ${MAX_MCP_CALL_TIMEOUT_MINUTES} minutes`,
      current: () => mcpCallTimeoutMinutes(cfg()), write: config((callTimeoutMinutes: number) => ({ mcp: { callTimeoutMinutes } })),
    }),
    writable({
      id: "bots.defaultModel", label: "Default model for new bots", help: "The engine and model a newly created bot starts on; existing bots keep theirs. Ids come from list_models.", where: "Settings → You and your bots",
      synonyms: ["default model", "new bots", "model", "engine"], tier: "safe", value: z.object({ instanceId: z.string().min(1).max(80), model: z.string().min(1).max(200) }), allowed: "{ instanceId, model } from list_models",
      current: () => cfg().defaultModelSelection, read: () => { const selection = cfg().defaultModelSelection; return selection ? `${selection.instanceId} / ${selection.model}` : ""; },
      write: config((defaultModelSelection: { instanceId: string; model: string } | undefined) => ({ defaultModelSelection: defaultModelSelection ?? null })),
    }),
  ];

  const provider = (id: string, label: string, synonyms: string[], current: () => string | undefined, patch: (text: string) => Record<string, unknown>): SettingEntry => writable({
    id, label, help: `${label}: the address mymausbot sends requests to. Empty uses the provider's own.`, where: "Settings → AI", synonyms: [...synonyms, "url", "base url", "endpoint", "address", "proxy"],
    tier: "confirm", value: url, allowed: "an http(s) address, or empty to clear", current: () => current() ?? "", write: config(patch),
  });
  const confirm: SettingEntry[] = [
    provider("providers.anthropic.url", "Anthropic address", ["anthropic", "claude"], () => cfg().anthropic?.url, (text) => ({ anthropic: { url: text } })),
    provider("providers.xai.url", "xAI address", ["xai", "grok"], () => cfg().xai?.url, (text) => ({ xai: { url: text } })),
    provider("providers.groq.url", "Groq address", ["groq"], () => cfg().groq?.url, (text) => ({ groq: { url: text } })),
    provider("providers.meta.url", "Meta address", ["meta", "llama"], () => cfg().meta?.url, (text) => ({ meta: { url: text } })),
    provider("providers.openaiCompat.url", "OpenAI-compatible address", ["openai compatible", "custom provider", "ollama", "lm studio", "openrouter"], () => cfg().openaiCompat?.url, (text) => ({ openaiCompat: { url: text } })),
    writable({
      id: "providers.openaiCompat.model", label: "OpenAI-compatible model", help: "The model name sent to the OpenAI-compatible provider.", where: "Settings → AI",
      synonyms: ["openai compatible", "custom provider", "model name"], tier: "confirm", value: z.string().trim().max(200), allowed: "a model name, or empty to clear",
      current: () => cfg().openaiCompat?.model ?? "", write: config((model: string) => ({ openaiCompat: { model } })),
    }),
    provider("voice.baseUrl", "Voice server address", ["tts", "voice", "speech", "chatterbox"], () => cfg().tts?.baseUrl, (text) => ({ tts: { baseUrl: text } })),
  ];

  const secret: SettingEntry[] = (Object.keys(CREDENTIAL_TARGETS) as CredentialTargetId[]).map((credentialId) => {
    const target = CREDENTIAL_TARGETS[credentialId];
    return {
      id: `keys.${credentialId}`, label: target.label, help: target.description, synonyms: ["key", "api key", "token", "credential", target.label.split(" ")[0]!.toLowerCase()],
      where: KEY_WHERE[credentialId] ?? ((PROVIDER_CREDENTIAL_TARGETS as readonly string[]).includes(credentialId) ? "Settings → AI → API keys" : "Settings → AI"),
      tier: "secret", credentialId, read: () => (credentialIsConfigured(deps.credentials(), credentialId) ? "set" : ""),
    };
  });

  const ownerOnly = (id: string, label: string, help: string, where: Where, synonyms: string[], read: () => string): SettingEntry => ({ id, label, help, where, synonyms, tier: "owner-only", read });
  const owner: SettingEntry[] = [
    ownerOnly("bots.groups", "Sidebar groups", "Departments determine bot team context and access. Move bots in the sidebar.", "the sidebar",
      ["group", "groups", "department", "departments", "section", "sections", "team", "folder"], () => {
        const grouped = Object.entries(groups()).map(([section, ids]) => `${section}: ${names(ids) || "(empty)"}`);
        const loose = deps.bots().filter((bot) => !bot.section).map((bot) => bot.id);
        return [...grouped, ...(loose.length ? [`ungrouped: ${names(loose)}`] : [])].join("; ");
      }),
    ownerOnly("bots.approvalModes", "Approval modes", "What each bot may do without asking (Ask, Approve for me, Full access).", "a bot's Settings", ["permissions", "full access", "approve", "ask", "approval", "autonomy"],
      () => deps.bots().map((bot) => `${bot.name}: ${bot.approvalMode}`).join("; ")),
    ownerOnly("remote.access", "Remote access", "How phones and other devices reach this computer (local network, tunnel, Tailscale or a public address).", "Settings → Phone & devices", ["remote", "tunnel", "tailscale", "public url", "phone", "pair", "relay"],
      () => display(cfg().cliStartup?.access ?? "local")),
    ownerOnly("cloud.account", "My Cloud account", "The account this app is signed in with, and its plan.", "Settings → Your account", ["account", "sign in", "sign out", "plan", "billing", "subscription"], () => "managed in Settings"),
    ownerOnly("vault.logins", "Vault and logins", "Saved website logins and secrets bots may use.", "Settings → Vault", ["vault", "password", "passwords", "login", "logins", "1password"], () => "managed in Settings"),
    ownerOnly("data.backups", "Backups", "Backing up and restoring this app's data.", "Settings → Data", ["backup", "backups", "restore", "export", "import"], () => "managed in Settings"),
    ownerOnly("computer.sharing", "Computer sharing", "Lending this computer to other places and people.", "Settings → Desktops & browser", ["share computer", "lend", "lending", "shared computers", "desktop"], () => "managed in Settings"),
  ];

  return [...safe, ...confirm, ...secret, ...owner];
}

export function findSettings(entries: readonly SettingEntry[], query: string, limit = 8): SettingEntry[] {
  const words = query.toLowerCase().split(/[^a-z0-9.-]+/).filter((word) => word.length > 1);
  if (!words.length) return [];
  const phrase = words.join(" ");
  const scored = entries.map((entry) => {
    const label = entry.label.toLowerCase(), id = entry.id.toLowerCase();
    const synonyms = entry.synonyms.map((synonym) => synonym.toLowerCase());
    const loose = [entry.help, ...synonyms].join(" ").toLowerCase();
    const whole = id === phrase || label === phrase || synonyms.includes(phrase) ? 10 : 0;
    const score = words.reduce((sum, word) => sum + (id === word || label === word ? 6 : label.includes(word) || id.includes(word) ? 3 : loose.includes(word) ? 1 : 0), whole);
    return { entry, score };
  }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((hit) => hit.entry);
}

/** The registry over the Settings window's own routes, called as the window calls them. */
export function routeBackedRegistry(deps: {
  cfg(): AppConfig;
  store: Pick<Store, "bots" | "sections">;
  routes: { config: RouteHandler; botOrder: RouteHandler };
  credentials(): CredentialConfig;
  window: RegistryDeps["window"];
}): SettingEntry[] {
  const auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const refusal = async (reply: Promise<RouteReply>) => { const { status, body } = await reply; return status < 300 ? null : String(body.error ?? `HTTP ${status}`); };
  return createSettingsRegistry({
    cfg: deps.cfg, bots: () => deps.store.bots, sections: () => deps.store.sections, credentials: deps.credentials, window: deps.window,
    saveConfig: (patch) => refusal(callRoute(deps.routes.config, { method: "PUT", path: "/api/config", body: patch, auth })),
    reorderBots: (botIds) => refusal(callRoute(deps.routes.botOrder, { method: "PUT", path: "/api/bots/order", body: { botIds }, auth })),
  });
}
