import { z } from "zod";

import { credentialIsConfigured, CREDENTIAL_TARGETS, PROVIDER_CREDENTIAL_TARGETS, type CredentialConfig, type CredentialTargetId } from "../../shared/credential-request.ts";
import { WINDOW_PREFS, type WindowPrefId } from "../../shared/app-settings.ts";
import { BOT_PROFILE_LIMITS, fitsOnOneLine } from "../../shared/bot-profile.ts";
import { defaultBotPerson } from "../../shared/default-bot.ts";
import { EFFORT_LEVELS, MAUS_COLOR_NAMES, type EffortLevel, type MausColor } from "../../shared/wire.ts";
import { defaultBotThreads, MAX_CONCURRENT_BOT_THREADS } from "../bot-thread-limits.ts";
import { parseSocks5Proxy } from "../browser/egress/policy.ts";
import { MAX_WINDOW_MINUTES } from "../cache-keepwarm.ts";
import { isClaudeBedrock } from "../claude-bedrock.ts";
import { isClaudeEndpoint } from "../claude-endpoints.ts";
import { isCodexEndpoint } from "../codex-endpoints.ts";
import { cacheKeepWarmSettings, MAX_MCP_CALL_TIMEOUT_MINUTES, MAX_ROOM_TURN_TIMEOUT_MINUTES, MAX_THREAD_EVENT_LOG_BYTES, mcpCallTimeoutMinutes, MIN_MCP_CALL_TIMEOUT_MINUTES, MIN_ROOM_TURN_TIMEOUT_MINUTES, MIN_THREAD_EVENT_LOG_BYTES, persistableInstanceConfigs, roomTurnTimeoutMinutes, showToolCallsEnabled, skillAuthoringEnabled, threadEventLogMaxBytes, type AppConfig } from "../config.ts";
import type { InstanceConfig } from "../contracts.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { endpointBaseUrl, endpointDisplayUrl, isAddedEndpoint } from "../openai-compat-endpoints.ts";
import type { RequestAuth } from "../request-auth.ts";
import { callRoute, type RouteReply } from "../routes/call-route.ts";
import { engineChosen } from "../routes/instances.ts";
import type { RouteHandler } from "../routes/table.ts";
import { skillsLibraryEnabled } from "../skill-library.ts";
import { shareLearnedSkillsMode, type ShareLearnedSkillsMode } from "../skill-share.ts";
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
  preview?(value: unknown): string;
  describe?(value: unknown): { change: string } | { refusal: string };
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
  pinBot(botId: string, pinned: boolean): Promise<string | null>;
  renameBot(botId: string, name: string): Promise<string | null>;
  colorBot(botId: string, color: MausColor): Promise<string | null>;
  archiveBot(botId: string, archived: boolean, demoteChief: boolean): Promise<string | null>;
  showHelper(botId: string, shown: boolean): Promise<string | null>;
  credentials(): CredentialConfig;
  window: { read(id: WindowPrefId): unknown; write(id: WindowPrefId, value: unknown): string | null };
  engines(): Array<{ instanceId: string; name: string; working: boolean }>;
  engineChosen(instanceId: string): boolean;
  addEngine(path: "openai-compat" | "claude-bedrock", body: Record<string, unknown>): Promise<string | null>;
  removeEngine(instanceId: string): Promise<string | null>;
}

/** A setting's value for a person or bot; empty when unset, so each edge can say "not set" in its own words. */
export const display = (value: unknown): string => (value === undefined || value === null || value === "" ? "" : typeof value === "string" ? value : JSON.stringify(value));
const url = z.string().trim().max(2048).refine((text) => text === "" || /^https?:\/\/\S+$/.test(text), "an http(s) address, or empty to clear");

const KEY_WHERE: Partial<Record<CredentialTargetId, Where>> = {
  ttsKey: "Settings → General", geminiTtsKey: "Settings → General", fishAudioKey: "Settings → General",
  onePasswordToken: "Settings → Vault", boxToken: "Settings → Desktops & browser", composioApiKey: "Settings → AI",
};

type WritableSpec = Omit<Base, "read"> & Omit<Writable, "write" | "describe"> & { read?(): string; write(value: never): Promise<string | null>; describe?(value: never): { change: string } | { refusal: string } };

const PROVIDER_KEY_SECTION = {
  openaiApiKey: "openai", anthropicApiKey: "anthropic", openrouterApiKey: "openrouter", mistralApiKey: "mistral", cerebrasApiKey: "cerebras",
  groqApiKey: "groq", greenferenceApiKey: "greenference", modelgoApiKey: "modelgo", metaApiKey: "meta", deepseekApiKey: "deepseek",
} as const satisfies Record<(typeof PROVIDER_CREDENTIAL_TARGETS)[number], keyof CredentialConfig>;
type ProviderKeyId = keyof typeof PROVIDER_KEY_SECTION;
const LOCAL_SERVER = { ollama: { name: "Ollama", key: "ollama" }, lmstudio: { name: "LM Studio", key: "lm-studio" } } as const;
const engineName = z.string().trim().min(1).max(80);
const engineUrl = z.string().trim().min(1).max(512).refine((value) => endpointBaseUrl(value) !== null, "an http(s) address without credentials or a query string");
const engineChange = z.record(z.string(), z.unknown())
  .refine((fields) => !Object.keys(fields).some((field) => field !== "keyFrom" && /key|token|secret|password/i.test(field)),
    "Never put a key or token in the value. Save it first with set on keys.<id> (a secure card asks the user), then name that id in keyFrom.")
  .pipe(z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["ollama", "lmstudio"]), name: engineName.optional(), url: engineUrl }).strict(),
    z.object({ kind: z.literal("openai-compat"), name: engineName, url: engineUrl, keyFrom: z.enum(PROVIDER_CREDENTIAL_TARGETS), models: z.array(z.string().trim().min(1).max(200)).max(64).optional() }).strict(),
    z.object({ kind: z.literal("bedrock"), name: engineName, awsProfile: z.string().trim().min(1).max(128), awsRegion: z.string().trim().min(1).max(40), model: z.string().trim().min(1).max(160) }).strict(),
    z.object({ kind: z.literal("remove"), instanceId: z.string().regex(/^[\w.-]{1,120}$/) }).strict(),
  ]));
type EngineChange = z.infer<typeof engineChange>;
const botId = z.string().regex(/^[\w-]{1,120}$/);
const botRename = z.object({
  botId,
  name: z.string().trim().min(1).max(BOT_PROFILE_LIMITS.name).refine(fitsOnOneLine, "one line without control characters"),
}).strict();
type BotRename = z.infer<typeof botRename>;
const botColor = z.object({ botId, color: z.enum(MAUS_COLOR_NAMES) }).strict();
type BotColor = z.infer<typeof botColor>;
const botArchive = z.object({ botId, archived: z.boolean() }).strict();
type BotArchive = z.infer<typeof botArchive>;
const keepWarmChange = z.object({ enabled: z.boolean(), windowMinutes: z.number().int().min(15).max(MAX_WINDOW_MINUTES).optional() }).strict();
type KeepWarmChange = z.infer<typeof keepWarmChange>;
const removableKind = (instanceId: string, entry: InstanceConfig | undefined) => isAddedEndpoint(instanceId, entry) ? "OpenAI-compatible server"
  : isClaudeBedrock(entry) ? "Claude on Amazon Bedrock" : isClaudeEndpoint(entry) ? "Claude endpoint" : isCodexEndpoint(entry) ? "Codex endpoint" : null;

export function createSettingsRegistry(deps: RegistryDeps): SettingEntry[] {
  const cfg = deps.cfg;
  const placeHelper = () => {
    const helpers = deps.bots().filter((bot) => bot.defaultBot && !defaultBotPerson(bot));
    return helpers.length === 1 ? helpers[0] : undefined;
  };
  const names = (ids: readonly string[]) => ids.map((id) => deps.bots().find((bot) => bot.id === id)?.name ?? id).join(", ");
  const writable = (spec: WritableSpec): SettingEntry => ({ ...spec, read: spec.read ?? (() => display(spec.current())), write: spec.write as Writable["write"] });
  const config = <V,>(patch: (value: V) => Record<string, unknown>) => (value: V) => deps.saveConfig(patch(value));
  const windowPref = (id: WindowPrefId, label: string, help: string, where: Where, synonyms: string[], allowed: string): SettingEntry =>
    writable({ id, label, help, where, synonyms, tier: "safe", value: WINDOW_PREFS[id], allowed, current: () => deps.window.read(id), write: async (value: unknown) => deps.window.write(id, value) });
  const enumOf = (values: readonly string[]) => values.join(", ");
  const pinned = () => deps.bots().filter((bot) => bot.pinned).map((bot) => bot.id);
  const groups = () => Object.fromEntries(deps.sections().map((section) => [section, deps.bots().filter((bot) => bot.section === section).map((bot) => bot.id)]));
  const newBotEffort = () => cfg().newBots?.effort ?? null;
  const effortLabel = (effort: EffortLevel | null) => effort ?? "provider default";
  const describeArchive = ({ botId, archived }: BotArchive): { change: string } | { refusal: string } => {
    const bot = deps.bots().find((candidate) => candidate.id === botId);
    if (!bot) return { refusal: `No bot has the id ${botId}. Use list_bots for the ids.` };
    if (bot.movedTo) return { refusal: `${bot.name} was moved to another computer and cannot be restored or archived here.` };
    if (archived && bot.defaultBot) return { refusal: `${bot.name} is this place's helper. Use sidebar.showHelper to hide its row.` };
    if (Boolean(bot.hidden) === archived) return { refusal: `${bot.name} is already ${archived ? "archived" : "active"}.` };
    if (archived && deps.bots().filter((candidate) => !candidate.hidden).length <= 1) return { refusal: "The last active bot cannot be archived." };
    return { change: archived
      ? `Archive ${JSON.stringify(bot.name)} (${bot.id}), keeping its chats and removing it from the sidebar${bot.chiefOfStaff ? " and ending its Chief of Staff role" : ""}`
      : `Restore ${JSON.stringify(bot.name)} (${bot.id}) to the sidebar, keeping its chats` };
  };

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
      id: "bots.pinned", label: "Pinned bots", help: "Which bots are pinned to the top of the sidebar. Send every bot id that should be pinned, including ones already pinned; the rest are unpinned.", where: "the sidebar",
      synonyms: ["pin", "pinned", "unpin", "favorite", "favourite", "top", "star"], tier: "safe", value: z.array(z.string().regex(/^[\w-]+$/)).max(100), allowed: "an array of the bot ids to pin; an empty array unpins every bot",
      current: pinned, read: () => names(pinned()),
      write: async (botIds: string[]) => {
        const bots = deps.bots();
        const wanted = new Set(botIds);
        const known = new Set(bots.map((bot) => bot.id));
        const unknown = botIds.find((id) => !known.has(id));
        if (unknown) return `No bot has the id ${unknown}. Use list_bots for the ids.`;
        const incomplete = "Pinned bots did not finish. Check the current pins in the sidebar, then retry with the full list if needed.";
        for (const bot of bots) {
          const shouldPin = wanted.has(bot.id);
          if (Boolean(bot.pinned) === shouldPin) continue;
          try {
            const refusal = await deps.pinBot(bot.id, shouldPin);
            if (refusal) return `${incomplete} ${refusal}`;
          } catch {
            return incomplete;
          }
        }
        const actual = pinned();
        return actual.length === wanted.size && actual.every((id) => wanted.has(id)) ? null : incomplete;
      },
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
    writable({
      id: "desktops.browserProxy", label: "Browser proxy", help: "An unauthenticated SOCKS5 proxy for public websites in the built-in browser. The address stays hidden; empty sends requests directly.", where: "Settings → Desktops & browser",
      synonyms: ["proxy", "socks", "socks5", "browser proxy"], tier: "confirm",
      value: z.string().trim().max(512).refine((text) => text === "" || parseSocks5Proxy(text) !== null, "an unauthenticated socks5://host:port address, or empty"),
      allowed: 'an unauthenticated "socks5://host:port", or "" for no proxy',
      current: () => cfg().browserEngine?.egress?.proxy ?? "", read: () => (cfg().browserEngine?.egress?.proxy ? "set" : ""),
      preview: (value: unknown) => value ? "set" : "",
      write: config((proxy: string) => ({ browserEngine: { egress: { proxy } } })),
    }),
  ];

  const provider = (id: string, label: string, synonyms: string[], current: () => string | undefined, patch: (text: string) => Record<string, unknown>): SettingEntry => writable({
    id, label, help: `${label}: the address mymausbot sends requests to. Empty uses the provider's own.`, where: "Settings → AI", synonyms: [...synonyms, "url", "base url", "endpoint", "address", "proxy"],
    tier: "confirm", value: url, allowed: "an http(s) address, or empty to clear", current: () => current() ?? "", write: config(patch),
  });
  const logCapText = (bytes: number | null) => bytes === null ? "no limit" : `${bytes} bytes`;
  const confirm: SettingEntry[] = [
    writable({
      id: "bots.newBotEffort", label: "Effort for new bots", help: "The reasoning effort a new bot starts with when its model names none; null uses the engine's own.", where: "Settings → You and your bots",
      synonyms: ["effort", "reasoning", "new bots", "thinking"], tier: "confirm", value: z.enum(EFFORT_LEVELS).nullable(),
      allowed: `${EFFORT_LEVELS.join(", ")}, or null for the provider default`,
      current: newBotEffort, read: () => effortLabel(newBotEffort()),
      describe: (effort: EffortLevel | null) => {
        const before = newBotEffort();
        return before === effort ? { refusal: `New bots already use ${effortLabel(effort)} effort.` }
          : { change: `Set new bots' effort to ${effortLabel(effort)} instead of ${effortLabel(before)}; existing bots keep their settings` };
      },
      write: config((effort: EffortLevel | null) => ({ newBots: { effort } })),
    }),
    writable({
      id: "appearance.runCard", label: "This run card", help: "Show the card that follows a bot's run while it works.", where: "Settings → Appearance",
      synonyms: ["this run", "run card", "progress"], tier: "confirm", value: WINDOW_PREFS["appearance.runCard"], allowed: "true or false",
      current: () => deps.window.read("appearance.runCard"),
      read: () => { const current = deps.window.read("appearance.runCard"); return current === undefined ? "" : current ? "shown" : "hidden"; },
      describe: (shown: boolean) => {
        const current = deps.window.read("appearance.runCard");
        return typeof current === "boolean" ? { change: `${shown ? "Show" : "Hide"} the card that follows each run; currently ${current ? "shown" : "hidden"}` }
          : { refusal: "Open mymausbot on this computer first; this setting lives in the app window." };
      },
      write: async (shown: boolean) => deps.window.write("appearance.runCard", shown),
    }),
    writable({
      id: "appearance.toolCalls", label: "Show tool calls", help: "Show each tool a bot runs in the conversation.", where: "Settings → Appearance",
      synonyms: ["tool calls", "tools", "show tools"], tier: "confirm", value: z.boolean(), allowed: "true or false",
      current: () => showToolCallsEnabled(cfg()), read: () => showToolCallsEnabled(cfg()) ? "shown" : "hidden",
      describe: (shown: boolean) => ({ change: `${shown ? "Show" : "Hide"} tool calls in conversations; currently ${showToolCallsEnabled(cfg()) ? "shown" : "hidden"}` }),
      write: config((showToolCalls: boolean) => ({ features: { showToolCalls } })),
    }),
    writable({
      id: "bots.skillAuthoring", label: "Bots write their own skills", help: "Bots may draft skills for your review; turning this off also pauses automatic skill review.", where: "Settings → You and your bots",
      synonyms: ["skills", "write skills", "early", "experimental"], tier: "confirm", value: z.boolean(), allowed: "true or false",
      current: () => skillAuthoringEnabled(cfg()), read: () => skillAuthoringEnabled(cfg()) ? "on" : "off",
      describe: (enabled: boolean) => {
        const review = cfg().features?.skillReview === true
          ? enabled ? " and allow automatic skill review again" : " and pause automatic skill review"
          : "";
        return { change: `${enabled ? "Let bots draft skills for your review" : "Stop bots drafting skills"}${review}; currently ${skillAuthoringEnabled(cfg()) ? "on" : "off"}` };
      },
      write: config((skillAuthoring: boolean) => ({ features: { skillAuthoring } })),
    }),
    writable({
      id: "bots.keepWarm", label: "Keep caches warm", help: "The place's on/off setting is the default for bots without an override. All eligible enabled bots, including bots explicitly set to On, use its shared window after a successful turn; each ping spends a few tokens.", where: "Settings → You and your bots",
      synonyms: ["keep warm", "cache", "prompt cache"], tier: "confirm", value: keepWarmChange, allowed: '{"enabled":true|false,"windowMinutes"?:15-1440}',
      current: () => cacheKeepWarmSettings(cfg()), read: () => display(cacheKeepWarmSettings(cfg())),
      describe: (change: KeepWarmChange) => {
        const before = cacheKeepWarmSettings(cfg());
        const after = { ...before, ...change };
        return { change: `Set the prompt-cache keep-warm place default from ${before.enabled ? "on" : "off"} to ${after.enabled ? "on" : "off"} and shared window from ${before.windowMinutes} to ${after.windowMinutes} minutes; all eligible enabled bots, including bots explicitly set to On, use that window after a successful turn. Each ping spends a few tokens; per-bot on/off choices stay unchanged` };
      },
      write: config((change: KeepWarmChange) => ({ cacheKeepWarm: { ...cacheKeepWarmSettings(cfg()), ...change } })),
    }),
    writable({
      id: "threads.eventLogMaxBytes", label: "Thread log size limit", help: "Limit each thread's event and native logs; threads and transcripts stay. Clearing the limit cannot restore trimmed entries.", where: "Settings → Data",
      synonyms: ["log size", "storage", "event log", "cleanup"], tier: "confirm",
      value: z.number().int().min(MIN_THREAD_EVENT_LOG_BYTES).max(MAX_THREAD_EVENT_LOG_BYTES).nullable(),
      allowed: `${MIN_THREAD_EVENT_LOG_BYTES} to ${MAX_THREAD_EVENT_LOG_BYTES} bytes, or null for no limit`,
      current: () => threadEventLogMaxBytes(cfg()), read: () => logCapText(threadEventLogMaxBytes(cfg())),
      describe: (bytes: number | null) => ({ change: `Change each thread's event-log limit from ${logCapText(threadEventLogMaxBytes(cfg()))} to ${logCapText(bytes)}; ${bytes === null
        ? "future writes stop trimming logs, but previously trimmed entries cannot be restored"
        : "future writes may permanently trim older event and native log entries; threads and transcripts stay"}` }),
      write: config((eventLogMaxBytes: number | null) => ({ threads: { eventLogMaxBytes } })),
    }),
    writable({
      id: "sidebar.showHelper", label: "Show helper in the sidebar", help: "Show or hide this place's own helper in the sidebar; the helper keeps working either way.", where: "Settings → General",
      synonyms: ["helper", "mausbot", "default bot", "sidebar", "show helper"], tier: "confirm", value: z.boolean(), allowed: "true or false",
      current: () => { const helper = placeHelper(); return helper ? !helper.sidebarHidden : undefined; },
      read: () => { const helper = placeHelper(); return helper ? (helper.sidebarHidden ? "hidden" : "shown") : ""; },
      describe: (shown: boolean) => {
        const helper = placeHelper();
        return helper ? { change: `${shown ? "Show" : "Hide"} ${JSON.stringify(helper.name)} (${helper.id}) in the sidebar; currently ${helper.sidebarHidden ? "hidden" : "shown"}` }
          : { refusal: "This place has no single helper of its own." };
      },
      write: (shown: boolean) => { const helper = placeHelper(); return helper ? deps.showHelper(helper.id, shown) : Promise.resolve("This place has no single helper of its own."); },
    }),
    writable({
      id: "bots.name", label: "Bot name", help: "The name of one bot in the sidebar and conversations. Use list_bots for its id.", where: "a bot's Settings",
      synonyms: ["rename bot", "bot name", "name bot"], tier: "confirm", value: botRename, allowed: '{"botId","name"}',
      current: () => undefined, read: () => deps.bots().map((bot) => `${bot.id}: ${JSON.stringify(bot.name)}`).join("; "),
      describe: ({ botId, name }: BotRename) => {
        const bot = deps.bots().find((candidate) => candidate.id === botId);
        return bot ? { change: `Rename ${JSON.stringify(bot.name)} to ${JSON.stringify(name)}` }
          : { refusal: `No bot has the id ${botId}. Use list_bots for the ids.` };
      },
      write: ({ botId, name }: BotRename) => deps.renameBot(botId, name),
    }),
    writable({
      id: "bots.color", label: "Bot colour", help: "The colour of one bot in the sidebar and conversations. Use list_bots for its id.", where: "a bot's Settings",
      synonyms: ["bot color", "bot colour", "colour bot", "color bot"], tier: "confirm", value: botColor,
      allowed: `{"botId","color"} with color one of ${MAUS_COLOR_NAMES.join(", ")}`,
      current: () => undefined, read: () => deps.bots().map((bot) => `${bot.id}: ${JSON.stringify(bot.name)} (${bot.color})`).join("; "),
      describe: ({ botId, color }: BotColor) => {
        const bot = deps.bots().find((candidate) => candidate.id === botId);
        return bot ? { change: `Change ${JSON.stringify(bot.name)} from ${bot.color} to ${color}` }
          : { refusal: `No bot has the id ${botId}. Use list_bots for the ids.` };
      },
      write: ({ botId, color }: BotColor) => deps.colorBot(botId, color),
    }),
    writable({
      id: "bots.archived", label: "Archived bots", help: "Archive one bot from the sidebar while keeping its chats, or restore it. Use list_bots for its id.", where: "the sidebar",
      synonyms: ["archive bot", "unarchive", "restore bot", "hidden bots"], tier: "confirm", value: botArchive,
      allowed: '{"botId","archived":true|false}', current: () => undefined,
      read: () => deps.bots().filter((bot) => bot.hidden && !bot.movedTo).map((bot) => `${bot.id}: ${JSON.stringify(bot.name)}`).join("; "),
      describe: describeArchive,
      write: (value: BotArchive) => {
        const described = describeArchive(value);
        if ("refusal" in described) return Promise.resolve(described.refusal);
        const bot = deps.bots().find((candidate) => candidate.id === value.botId);
        return deps.archiveBot(value.botId, value.archived, value.archived && Boolean(bot?.chiefOfStaff));
      },
    }),
    writable({
      id: "bots.shareLearnedSkills", label: "Share learned skills", help: "Off disables learned-skill sharing; Ask uses a review receipt; Automatic shares with eligible bots in the same department under visibility checks. Available when the skills library and bot skill authoring are on.", where: "Settings → You and your bots",
      synonyms: ["share skills", "skills library", "learned skills"], tier: "confirm", value: z.enum(["off", "ask", "auto"]), allowed: "off, ask or auto",
      current: () => shareLearnedSkillsMode(cfg()),
      describe: (mode: ShareLearnedSkillsMode) => {
        if (!skillsLibraryEnabled(cfg())) return { refusal: "Turn on the skills library in Settings first." };
        if (!skillAuthoringEnabled(cfg())) return { refusal: "Turn on bot skill authoring in Settings first." };
        const effect = mode === "off" ? "Turn off learned-skill sharing" : mode === "ask" ? "Ask before sharing learned skills" : "Automatically share learned skills with eligible bots in the same department under visibility checks";
        return { change: `${effect}; currently ${shareLearnedSkillsMode(cfg())}` };
      },
      write: config((shareLearnedSkills: ShareLearnedSkillsMode) => ({ features: { shareLearnedSkills } })),
    }),
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

  const instances = () => persistableInstanceConfigs(cfg());
  const savedKey = (id: ProviderKeyId) => deps.credentials()[PROVIDER_KEY_SECTION[id]]?.key;
  const keyMissing = (id: ProviderKeyId) => `Your ${CREDENTIAL_TARGETS[id].label} is not saved yet. Call set on keys.${id} with no value first (a secure card asks the user for it), then add the engine.`;
  const listEngines = () => deps.engines().map(({ instanceId, name, working }) => {
    const entry = instances()[instanceId];
    const address = isAddedEndpoint(instanceId, entry) ? endpointDisplayUrl(entry.config) : undefined;
    return `${instanceId}: ${name}${address ? ` at ${address}` : ""}${working ? "" : " (not working)"}${removableKind(instanceId, entry) ? "" : " (removed only in Settings)"}`;
  }).join("; ");
  const engines = writable({
    id: "engines", label: "AI engines", help: "The AI engines bots run on. get lists each id; set adds or removes one after an owner's Change/Cancel card.", where: "Settings → AI",
    synonyms: ["engine", "engines", "ai engine", "add engine", "remove engine", "provider", "providers", "ollama", "lm studio", "bedrock", "endpoint", "local model"],
    tier: "confirm", value: engineChange,
    allowed: '{"kind":"ollama" or "lmstudio","url"} for a local server; {"kind":"openai-compat","name","url","keyFrom":"<saved keys.* id>","models"?:[...]}; '
      + '{"kind":"bedrock","name","awsProfile","awsRegion","model"}; {"kind":"remove","instanceId"}. Sign-in accounts are managed by the user in Settings → AI',
    current: () => undefined, read: listEngines,
    describe: (change: EngineChange) => {
      if (change.kind === "remove") {
        const entry = instances()[change.instanceId];
        const listed = deps.engines().find((engine) => engine.instanceId === change.instanceId);
        if (!entry && !listed) return { refusal: `No engine has the id ${change.instanceId}. Use get on engines to list them.` };
        const name = listed?.name ?? entry?.displayName ?? change.instanceId;
        const kind = removableKind(change.instanceId, entry);
        if (!kind) return { refusal: `${name} is removed only by the user, in Settings → AI. Tell them where; do not try another way.` };
        if (deps.engineChosen(change.instanceId)) return { refusal: `Bots or the default model for new bots use ${name}. Move them to another model first, then remove it.` };
        const working = deps.engines().filter((engine) => engine.working);
        const onlyWorking = working.length === 1 && working[0]!.instanceId === change.instanceId;
        const address = isAddedEndpoint(change.instanceId, entry) ? endpointDisplayUrl(entry.config) : undefined;
        return { change: `Remove the engine "${name}" (${kind}${address ? `, ${address}` : ""})${onlyWorking ? ". It is your only working engine" : ""}` };
      }
      if (change.kind === "openai-compat") {
        if (!savedKey(change.keyFrom)) return { refusal: keyMissing(change.keyFrom) };
        return { change: `Add the engine "${change.name}" (OpenAI-compatible) at ${change.url}, sending it your saved ${CREDENTIAL_TARGETS[change.keyFrom].label}` };
      }
      if (change.kind === "bedrock") return { change: `Add the engine "${change.name}" (Claude on Amazon Bedrock), AWS profile ${change.awsProfile} in ${change.awsRegion}, model ${change.model}` };
      return { change: `Add the engine "${change.name ?? LOCAL_SERVER[change.kind].name}" (${LOCAL_SERVER[change.kind].name} on ${change.url})` };
    },
    write: async (change: EngineChange) => {
      if (change.kind === "remove") return deps.removeEngine(change.instanceId);
      if (change.kind === "bedrock") return deps.addEngine("claude-bedrock", { displayName: change.name, awsProfile: change.awsProfile, awsRegion: change.awsRegion, model: change.model });
      if (change.kind === "openai-compat") {
        const key = savedKey(change.keyFrom);
        return key ? deps.addEngine("openai-compat", { displayName: change.name, url: change.url, key, ...(change.models ? { models: change.models } : {}) }) : keyMissing(change.keyFrom);
      }
      const local = LOCAL_SERVER[change.kind];
      return deps.addEngine("openai-compat", { displayName: change.name ?? local.name, url: change.url, key: local.key, catalog: change.kind });
    },
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

  return [...safe, ...confirm, engines, ...secret, ...owner];
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
  store: Pick<Store, "bots" | "sections" | "tasks">;
  routes: { config: RouteHandler; botOrder: RouteHandler; botPatch: RouteHandler; instances: RouteHandler };
  providers: Pick<ProviderRegistry, "instances" | "lastSnapshot">;
  credentials(): CredentialConfig;
  window: RegistryDeps["window"];
}): SettingEntry[] {
  const auth: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
  const refusal = async (reply: Promise<RouteReply>) => { const { status, body } = await reply; return status < 300 ? null : String(body.error ?? `HTTP ${status}`); };
  return createSettingsRegistry({
    cfg: deps.cfg, bots: () => deps.store.bots, sections: () => deps.store.sections, credentials: deps.credentials, window: deps.window,
    saveConfig: (patch) => refusal(callRoute(deps.routes.config, { method: "PUT", path: "/api/config", body: patch, auth })),
    reorderBots: (botIds) => refusal(callRoute(deps.routes.botOrder, { method: "PUT", path: "/api/bots/order", body: { botIds }, auth })),
    pinBot: (botId, pinned) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body: { pinned }, auth })),
    renameBot: (botId, name) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body: { name }, auth })),
    colorBot: (botId, color) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body: { color }, auth })),
    archiveBot: (botId, archived, demoteChief) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body: { hidden: archived, ...(demoteChief ? { chiefOfStaff: false } : {}) }, auth })),
    showHelper: (botId, shown) => refusal(callRoute(deps.routes.botPatch, { method: "PATCH", path: `/api/bots/${encodeURIComponent(botId)}`, body: { sidebarHidden: !shown }, auth })),
    engines: () => deps.providers.instances().filter((instance) => instance.enabled).map((instance) => ({
      instanceId: instance.instanceId, working: deps.providers.lastSnapshot(instance.instanceId)?.state === "available",
      name: instance.displayName ?? BUILT_IN_DRIVERS.find((driver) => driver.driverKind === instance.driverKind)?.metadata.displayName ?? instance.instanceId,
    })),
    engineChosen: (instanceId) => engineChosen(deps.store, deps.cfg(), instanceId),
    addEngine: (path, body) => refusal(callRoute(deps.routes.instances, { method: "POST", path: `/api/instances/${path}`, body, auth })),
    removeEngine: (instanceId) => refusal(callRoute(deps.routes.instances, { method: "DELETE", path: `/api/instances/${encodeURIComponent(instanceId)}`, auth })),
  });
}
