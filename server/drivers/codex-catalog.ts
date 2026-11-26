// Codex model catalog: official ChatGPT rows stay in the main picker; everything wired in ~/.codex is
// tagged `custom`. `codex app-server` thread/start takes `model` and `modelProvider` separately.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { isEffortLevel, type EffortLevel } from "../../shared/model-selection.ts";
import type { ModelCatalog } from "../contracts.ts";
import { qualifiedModelLabel } from "../contracts.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { isLoopback } from "../provider-key-check.ts";
import { codexHome } from "./codex-identity.ts";
import { MODEL_ID, SEP, TIERED_ID, codexTierOf } from "./codex-tier.ts";
import { unconfirmedModelCatalog } from "../startup-model-catalog.ts";
import { codexInjectHost, codexLocalProviderArgs, localProviderRoute, mergeLocalInject } from "./local-inject.ts";
import { configuredProviderRoute, loopbackOriginTag, providerLabel } from "../model-provider-routes.ts";

export const STATIC_CODEX_MODELS: ModelCatalog = {
  default: "gpt-5.6-sol",
  options: [
    // Only used when live discovery fails; these rows do not establish account access.
    { id: "gpt-6-astra", label: "GPT-6 Astra (availability unverified)" },
    { id: "gpt-6-sol", label: "GPT-6 Sol (availability unverified)" },
    { id: "gpt-6-luna", label: "GPT-6 Luna (availability unverified)" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  ],
};

/** Official rows force this provider, so a local `model_provider = "omlx"` cannot swallow GPT-5.6. */
export const OFFICIAL_CODEX_PROVIDER = "openai";

const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/i;

export function encodeCodexSelection(provider: string, model: string): string {
  return `${provider}${SEP}${model}`;
}

export function decodeCodexSelection(id: string | null | undefined): {
  model: string | null;
  modelProvider: string | null;
  serviceTier?: string;
} {
  if (!id) return { model: null, modelProvider: null };
  const sep = id.indexOf(SEP);
  if (sep > 0) {
    return { model: id.slice(sep + SEP.length), modelProvider: id.slice(0, sep) };
  }
  // A bare id is official: a new cloud model must not fall through to the user's local provider.
  if (!MODEL_ID.test(id)) return { model: id, modelProvider: null };
  const tiered = codexTierOf(id);
  if (tiered) return { model: tiered.model, modelProvider: OFFICIAL_CODEX_PROVIDER, serviceTier: tiered.tier };
  return { model: id, modelProvider: OFFICIAL_CODEX_PROVIDER };
}

/** The model and provider a thread is started or resumed with: a routed (company or endpoint) instance and a ChatGPT plan
 * name their own, any other follows the model's selection. */
export function codexThreadSelection(route: { routedProvider?: string; plan: boolean }, model: string | null | undefined): { model?: string | null; modelProvider: string | null; serviceTier?: string } {
  if (route.routedProvider) return { model, modelProvider: route.routedProvider };
  return route.plan ? { model, modelProvider: "openai_chatgpt_plan" } : decodeCodexSelection(model);
}

/** Starts Codex on the chosen model's provider. codex-cli 0.167.0 refuses a turn whose thread provider differs from its
 * current one ("This chat uses custom, but your current provider is magpie"), whatever config.toml's model_provider says. */
export function codexSelectedProviderArgs(env: Record<string, string | undefined>, modelId: string | null | undefined): string[] {
  const provider = decodeCodexSelection(modelId).modelProvider;
  return [...codexLocalProviderArgs(env, modelId), ...(provider ? ["-c", `model_provider=${JSON.stringify(provider)}`] : [])];
}

interface CodexAppServerModel {
  id?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  isDefault?: unknown;
  serviceTiers?: unknown;
  defaultServiceTier?: unknown;
  supportedReasoningEfforts?: unknown;
}

const FAST_TIER = /fast/i;

function effortLevels(value: unknown): readonly EffortLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value.map((entry) => typeof entry === "string" ? entry
    : entry?.reasoningEffort ?? entry?.reasoning_effort ?? entry?.effort);
  if (levels.some((level) => typeof level !== "string")) return undefined;
  return [...new Set(levels.filter(isEffortLevel))];
}

/** The model's Fast tier (codex-cli 0.167 lists `{id: "priority", name: "Fast"}`), unless it already runs on it. */
function fastTier(row: CodexAppServerModel): { id: string; name: string } | null {
  if (!Array.isArray(row.serviceTiers)) return null;
  for (const tier of row.serviceTiers) {
    const id = tier?.id, name = tier?.name;
    if (typeof id !== "string" || typeof name !== "string" || !FAST_TIER.test(name) || !PROVIDER_ID.test(id)) continue;
    return id === row.defaultServiceTier ? null : { id, name };
  }
  return null;
}

/** The installed Codex CLI's own ChatGPT catalog, every page: it changes more often than our releases. */
export function readCodexAppServerModelCatalog(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs = 8_000,
): Promise<ModelCatalog | null> {
  return new Promise((resolve) => {
    const child = spawnCli(cli, ["app-server"], {
      cwd: homedir(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let buffer = "";
    let nextId = 1;
    const models: CodexAppServerModel[] = [];
    const cursors = new Set<string>();
    const pending = new Map<number, "initialize" | "models">();

    const finish = (catalog: ModelCatalog | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killCliTree(child);
      resolve(catalog);
    };
    const request = (method: string, params: unknown, kind: "initialize" | "models") => {
      const id = nextId++;
      pending.set(id, kind);
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        finish(null);
      }
    };
    const requestModels = (cursor: string | null) => {
      request("model/list", { cursor, limit: 100 }, "models");
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const kind = pending.get(message.id);
        if (!kind) continue;
        pending.delete(message.id);
        if (message.error) {
          finish(null);
          return;
        }
        if (kind === "initialize") {
          try {
            child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
          } catch {
            finish(null);
            return;
          }
          requestModels(null);
          continue;
        }

        const page = message.result;
        if (Array.isArray(page?.data)) models.push(...page.data);
        const cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
        if (cursor && !cursors.has(cursor)) {
          cursors.add(cursor);
          requestModels(cursor);
          continue;
        }

        const options: ModelCatalog["options"] = [];
        const seen = new Set<string>();
        let defaultModel: string | null = null;
        for (const row of models) {
          if (!row || row.hidden === true || typeof row.id !== "string" || !MODEL_ID.test(row.id) || seen.has(row.id)) continue;
          seen.add(row.id);
          const label = typeof row.displayName === "string" && row.displayName.trim() ? row.displayName : row.id;
          const levels = effortLevels(row.supportedReasoningEfforts);
          const option = { id: row.id, label, ...(levels ? { effortLevels: levels } : {}) };
          options.push(option);
          const fast = fastTier(row);
          if (fast && !TIERED_ID.test(row.id)) options.push({ ...option, id: `${row.id}+${fast.id}`, label: `${label} · ${fast.name}` });
          if (row.isDefault === true) defaultModel = row.id;
        }
        if (!options.length) {
          finish(null);
          return;
        }
        finish({
          default: defaultModel && seen.has(defaultModel) ? defaultModel : options[0].id,
          options,
        });
      }
    });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    request("initialize", { clientInfo: { name: "openmausbot", version: "1" } }, "initialize");
  });
}

function parseTomlString(input: string, start: number): { value: string; next: number } | null {
  const quote = input[start];
  if (quote === "'") {
    const end = input.indexOf("'", start + 1);
    return end === -1 ? null : { value: input.slice(start + 1, end), next: end + 1 };
  }
  if (quote !== '"') return null;
  let value = "";
  for (let i = start + 1; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"') return { value, next: i + 1 };
    if (ch !== "\\") {
      value += ch;
      continue;
    }
    i += 1;
    if (i >= input.length) return null;
    const esc = input[i];
    if (esc === '"') value += '"';
    else if (esc === "\\") value += "\\";
    else if (esc === "n") value += "\n";
    else if (esc === "r") value += "\r";
    else if (esc === "t") value += "\t";
    else if (esc === "b") value += "\b";
    else if (esc === "f") value += "\f";
    else if (esc === "u" || esc === "U") {
      const len = esc === "u" ? 4 : 8;
      const hex = input.slice(i + 1, i + 1 + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return null;
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) return null;
      value += String.fromCodePoint(codePoint);
      i += len;
    } else {
      value += `\\${esc}`;
    }
  }
  return null;
}

function skipTomlWsAndComments(input: string, start: number): number {
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      const nl = input.indexOf("\n", i + 1);
      i = nl === -1 ? input.length : nl + 1;
      continue;
    }
    break;
  }
  return i;
}

function parseTomlStringArray(raw: string): string[] | null {
  let i = skipTomlWsAndComments(raw, 0);
  if (raw[i] !== "[") return null;
  i += 1;
  const items: string[] = [];
  while (i < raw.length) {
    i = skipTomlWsAndComments(raw, i);
    if (raw[i] === "]") {
      i = skipTomlWsAndComments(raw, i + 1);
      return i === raw.length ? items : null;
    }
    const parsed = parseTomlString(raw, i);
    if (!parsed) return null;
    items.push(parsed.value);
    i = skipTomlWsAndComments(raw, parsed.next);
    if (raw[i] === ",") {
      i += 1;
      continue;
    }
    if (raw[i] === "]") continue;
    return null;
  }
  return null;
}

function hasUnquotedClosingBracket(raw: string): boolean {
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "#") {
      const nl = raw.indexOf("\n", i + 1);
      if (nl === -1) return false;
      i = nl;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const parsed = parseTomlString(raw, i);
      if (!parsed) return false;
      i = parsed.next - 1;
      continue;
    }
    if (ch === "]") return true;
  }
  return false;
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const parsed = parseTomlString(value, 0);
    if (parsed) {
      const tail = value.slice(parsed.next).trim();
      if (!tail || tail.startsWith("#")) return parsed.value;
    }
  }
  const hash = value.indexOf(" #");
  return (hash !== -1 ? value.slice(0, hash) : value).trim();
}

function parsePositiveInt(raw: string): number | undefined {
  const cleaned = unquote(raw);
  if (!/^\d[\d_]*$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned.replace(/_/g, ""));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function unquoteSectionId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

interface CodexProviderAuth {
  command: string;
  args: string[];
  timeoutMs?: number;
}

interface CodexProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  envKey?: string;
  wireApi?: string;
  auth?: CodexProviderAuth;
}

interface CodexToml {
  model?: string;
  modelProvider?: string;
  modelCatalogJson?: string;
  providers: CodexProvider[];
}

function parseCodexToml(text: string): CodexToml {
  const result: CodexToml = { providers: [] };
  const byId = new Map<string, CodexProvider>();
  const authDrafts = new Map<string, { command?: string; args?: string[]; timeoutMs?: number; invalidArgs?: boolean }>();
  let section:
    | { kind: "root" }
    | { kind: "other" }
    | { kind: "provider"; provider: CodexProvider }
    | { kind: "provider-auth"; provider: CodexProvider } = { kind: "root" };
  let pendingArgs: { providerId: string; raw: string } | null = null;

  const providerFor = (id: string): CodexProvider => {
    let provider = byId.get(id);
    if (!provider) {
      provider = { id };
      byId.set(id, provider);
      result.providers.push(provider);
    }
    return provider;
  };
  const authDraftFor = (id: string) => {
    let draft = authDrafts.get(id);
    if (!draft) {
      draft = {};
      authDrafts.set(id, draft);
    }
    return draft;
  };

  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    const header = /^\[([^\]]+)\](?:\s*#.*)?$/.exec(stripped);
    const isSectionHeader = Boolean(header) || (stripped.startsWith("[") && stripped.endsWith("]"));
    if (pendingArgs) {
      if (isSectionHeader) {
        authDraftFor(pendingArgs.providerId).invalidArgs = true;
        pendingArgs = null;
      } else {
        pendingArgs.raw += `\n${line}`;
        if (hasUnquotedClosingBracket(pendingArgs.raw)) {
          const parsed = parseTomlStringArray(pendingArgs.raw);
          const draft = authDraftFor(pendingArgs.providerId);
          if (parsed !== null) draft.args = parsed;
          else draft.invalidArgs = true;
          pendingArgs = null;
        }
        continue;
      }
    }
    if (!stripped || stripped.startsWith("#")) continue;
    if (isSectionHeader) {
      const inner = (header ? header[1] : stripped.slice(1, -1)).trim();
      const authMatch = /^model_providers\.(.+?)\.auth$/.exec(inner);
      if (authMatch) {
        const id = unquoteSectionId(authMatch[1]);
        section = PROVIDER_ID.test(id) ? { kind: "provider-auth", provider: providerFor(id) } : { kind: "other" };
        continue;
      }
      const match = /^model_providers\.(.+)$/.exec(inner);
      if (match) {
        const id = unquoteSectionId(match[1]);
        section = PROVIDER_ID.test(id) ? { kind: "provider", provider: providerFor(id) } : { kind: "other" };
      } else {
        section = { kind: "other" };
      }
      continue;
    }
    const eq = stripped.indexOf("=");
    if (eq < 0) continue;
    const key = stripped.slice(0, eq).trim();
    const rawValue = stripped.slice(eq + 1);
    if (section.kind === "provider-auth") {
      const draft = authDraftFor(section.provider.id);
      if (key === "command") {
        const value = unquote(rawValue);
        if (value) draft.command = value;
      } else if (key === "args") {
        const parsed = parseTomlStringArray(rawValue);
        if (parsed !== null) draft.args = parsed;
        else if (rawValue.trimStart().startsWith("[") && !hasUnquotedClosingBracket(rawValue)) {
          pendingArgs = { providerId: section.provider.id, raw: rawValue };
        } else {
          draft.invalidArgs = true;
        }
      } else if (key === "timeout_ms") {
        const timeoutMs = parsePositiveInt(rawValue);
        if (timeoutMs !== undefined) draft.timeoutMs = timeoutMs;
      }
      continue;
    }
    const value = unquote(rawValue);
    if (!value) continue;
    if (section.kind === "root") {
      if (key === "model") result.model = value;
      if (key === "model_provider") result.modelProvider = value;
      if (key === "model_catalog_json") result.modelCatalogJson = value;
      continue;
    }
    if (section.kind === "other") continue;
    if (key === "name") section.provider.name = value;
    if (key === "base_url") section.provider.baseUrl = value;
    if (key === "env_key") section.provider.envKey = value;
    if (key === "wire_api") section.provider.wireApi = value;
  }

  if (pendingArgs) {
    authDraftFor(pendingArgs.providerId).invalidArgs = true;
    pendingArgs = null;
  }

  for (const [id, draft] of authDrafts) {
    if (!draft.command || draft.invalidArgs) continue;
    const provider = byId.get(id);
    if (provider) {
      provider.auth = {
        command: draft.command,
        args: draft.args ?? [],
        ...(draft.timeoutMs !== undefined ? { timeoutMs: draft.timeoutMs } : {}),
      };
    }
  }
  return result;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function providerName(provider: string, known: Map<string, CodexProvider>): string {
  return providerLabel(known.get(provider)?.name) ?? providerLabel(provider) ?? "Local connection";
}

function niceLabel(model: string, provider: string, known: Map<string, CodexProvider>): string {
  const host = providerName(provider, known);
  return qualifiedModelLabel(model, host, {
    redundantWhen: () => host === provider,
    decorate: (facet) => ` (${facet})`,
  });
}

type CatalogFacts = {
  effortLevels?: readonly EffortLevel[];
  contextWindow?: number;
  nonChatCapability?: boolean;
  responsesUnsupported?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return Number.isSafeInteger(floored) && floored > 0 ? floored : undefined;
}

function modelRecords(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const { models, data } = payload as { models?: unknown; data?: unknown };
  return Array.isArray(models) ? models : Array.isArray(data) ? data : [];
}

function modelFacts(row: Record<string, unknown>, provider?: CodexProvider): CatalogFacts {
  const capabilities = isPlainObject(row.capabilities) ? row.capabilities : undefined;
  const supports = isPlainObject(capabilities?.supports) ? capabilities.supports : undefined;
  const limits = isPlainObject(capabilities?.limits) ? capabilities.limits : undefined;
  const limit = isPlainObject(row.limit) ? row.limit : undefined;

  const parsedLevels =
    effortLevels(row.supported_reasoning_efforts) ??
    effortLevels(row.supported_reasoning_levels) ??
    effortLevels(row.reasoning_levels) ??
    effortLevels(supports?.reasoning_effort);
  const noReasoning =
    row.reasoning === false ||
    (supports !== undefined &&
      (supports.reasoning_effort === undefined || supports.reasoning_effort === false) &&
      row.reasoning !== true);
  const levels = parsedLevels ?? (noReasoning ? [] : undefined);

  const contextWindow =
    positiveInt(row.context_window) ??
    positiveInt(row.context_length) ??
    positiveInt(limits?.max_context_window_tokens) ??
    positiveInt(limit?.context);

  const capabilityType = capabilities?.type;
  const nonChatCapability =
    capabilityType === "image" || capabilityType === "embeddings"
      ? true
      : capabilityType === "chat"
        ? false
        : undefined;
  const endpoints = Array.isArray(row.supported_endpoints) && row.supported_endpoints.length > 0
    ? row.supported_endpoints
    : undefined;
  const responsesUnsupported =
    provider?.wireApi === "responses" && endpoints
      ? !endpoints.some((ep) => typeof ep === "string" && /\/responses\b/i.test(ep))
      : undefined;

  return {
    ...(levels ? { effortLevels: levels } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(nonChatCapability !== undefined ? { nonChatCapability } : {}),
    ...(responsesUnsupported !== undefined ? { responsesUnsupported } : {}),
  };
}

function addCatalogRecords(
  metadata: Map<string, CatalogFacts & { label?: string }>,
  parsed: unknown,
  resolveProvider: (row: Record<string, unknown>) => string | null,
  known: Map<string, CodexProvider>,
): void {
  for (const record of modelRecords(parsed)) {
    if (!isPlainObject(record)) continue;
    const provider = resolveProvider(record);
    if (!provider || !PROVIDER_ID.test(provider)) continue;
    const slug = typeof record.slug === "string" ? record.slug : typeof record.id === "string" ? record.id : "";
    if (!MODEL_ID.test(slug)) continue;
    const label = typeof record.display_name === "string" ? record.display_name
      : typeof record.name === "string" ? record.name : "";
    const id = encodeCodexSelection(provider, slug);
    metadata.set(id, { ...metadata.get(id), ...modelFacts(record, known.get(provider)), ...(label ? { label } : {}) });
  }
}

function collectCatalogMetadata(
  home: string,
  known: Map<string, CodexProvider>,
  catalogJsonPath?: string,
  mainProvider?: string,
): Map<string, CatalogFacts & { label?: string }> {
  const metadata = new Map<string, CatalogFacts & { label?: string }>();
  for (const file of listDir(join(home, "model-catalogs"))) {
    if (!file.endsWith(".json")) continue;
    const provider = basename(file, ".json").replace(/-models$/, "");
    if (!PROVIDER_ID.test(provider)) continue;
    const raw = readText(join(home, "model-catalogs", file));
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    addCatalogRecords(metadata, parsed, () => provider, known);
  }
  if (catalogJsonPath && isAbsolute(catalogJsonPath)) {
    const raw = readText(catalogJsonPath);
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        const stem = basename(catalogJsonPath, ".json").replace(/-models$/, "");
        const defaultProvider = PROVIDER_ID.test(stem) && known.has(stem)
          ? stem
          : mainProvider && PROVIDER_ID.test(mainProvider)
            ? mainProvider
            : null;
        addCatalogRecords(metadata, parsed, (row) => {
          const explicit = typeof row.provider === "string" ? row.provider
            : typeof row.model_provider === "string" ? row.model_provider : undefined;
          if (explicit && PROVIDER_ID.test(explicit) && (explicit === mainProvider || known.has(explicit))) {
            return explicit;
          }
          return defaultProvider;
        }, known);
      } catch {
      }
    }
  }
  return metadata;
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  if (!URL.canParse(baseUrl)) return false;
  const url = new URL(baseUrl);
  if (url.username || url.password) return false;
  return (url.protocol === "http:" || url.protocol === "https:") && isLoopback(url.hostname);
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

// Security invariant: only run provider auth commands for verified loopback endpoints, keeping tokens in memory.
function readAuthBearerToken(
  auth: CodexProviderAuth,
  env: Record<string, string | undefined>,
): Promise<string | null> {
  if (auth.command.includes("\0") || auth.args.some((arg) => arg.includes("\0"))) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      execFile(
        auth.command,
        auth.args,
        {
          env,
          timeout: Math.min(auth.timeoutMs ?? 5000, 5000),
          maxBuffer: 16 * 1024,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const token = stdout.trim();
          resolve(token && !hasControlChar(token) ? token : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function probeProviderModels(
  provider: CodexProvider,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<Array<{ model: string; facts: CatalogFacts }>> {
  if (!provider.baseUrl) return [];
  const url = `${provider.baseUrl.replace(/\/$/, "")}/models`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const headers: Record<string, string> = {};
    if (provider.envKey && env[provider.envKey]) {
      headers.Authorization = `Bearer ${env[provider.envKey]}`;
    } else if (provider.auth?.command && isLoopbackBaseUrl(provider.baseUrl)) {
      const token = await readAuthBearerToken(provider.auth, env);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 1000);
    timer.unref?.();
    const response = await fetchImpl(url, { signal: controller.signal, headers, redirect: "manual" });
    if (!response.ok) return [];
    const models: Array<{ model: string; facts: CatalogFacts }> = [];
    for (const record of modelRecords(await response.json())) {
      const row = record && typeof record === "object" ? record as Record<string, unknown> : undefined;
      const id = typeof record === "string" ? record : row?.id ?? row?.slug;
      if (typeof id === "string" && MODEL_ID.test(id)) models.push({ model: id, facts: row ? modelFacts(row, provider) : {} });
    }
    return models;
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function readCodexModelCatalog(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  cli?: string,
): Promise<ModelCatalog> {
  const official = cli ? await readCodexAppServerModelCatalog(cli, env) : null;
  const catalog = await catalogAround(official ?? STATIC_CODEX_MODELS, env, fetchImpl);
  if (cli && !official) unconfirmedModelCatalog(catalog);
  return catalog;
}

async function catalogAround(
  official: ModelCatalog,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<ModelCatalog> {
  // A relative CODEX_HOME or user home must not load a catalog from another directory.
  const home = codexHome(env);
  if (!home) return mergeLocalInject(official, env, fetchImpl);
  const mainText = readText(join(home, "config.toml"));
  if (!mainText) return mergeLocalInject(official, env, fetchImpl);

  const main = parseCodexToml(mainText);
  const known = new Map(main.providers.map((provider) => [provider.id, provider]));
  const profiles: CodexToml[] = [];
  for (const file of listDir(home)) {
    if (!file.endsWith(".config.toml")) continue;
    const profile = parseCodexToml(readText(join(home, file)) ?? "");
    profiles.push(profile);
    for (const provider of profile.providers) {
      if (!known.has(provider.id)) known.set(provider.id, provider);
    }
  }
  const metadata = collectCatalogMetadata(home, known, main.modelCatalogJson, main.modelProvider);
  const extras: Array<{ provider: string; model: string }> = [];

  const remember = (provider: string | undefined, model: string | undefined) => {
    if (!provider || !model) return;
    if (!PROVIDER_ID.test(provider) || !MODEL_ID.test(model)) return;
    // A local provider may serve an official slug: keep its row provider-qualified.
    if (
      provider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === model)
    ) return;
    extras.push({ provider, model });
  };

  remember(main.modelProvider, main.model);
  for (const profile of profiles) {
    remember(profile.modelProvider ?? main.modelProvider, profile.model);
  }

  for (const encoded of metadata.keys()) {
    const decoded = decodeCodexSelection(encoded);
    if (decoded.model && decoded.modelProvider) remember(decoded.modelProvider, decoded.model);
  }

  const live = await Promise.all(
    [...known.values()].map(async (provider) => {
      const models = await probeProviderModels(provider, env, fetchImpl);
      return models.map((row) => ({ provider: provider.id, ...row }));
    }),
  );
  for (const { provider, model, facts } of live.flat()) {
    const id = encodeCodexSelection(provider, model);
    metadata.set(id, { ...metadata.get(id), ...facts });
    remember(provider, model);
  }

  const options = official.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    const id = encodeCodexSelection(extra.provider, extra.model);
    if (seen.has(id)) continue;
    seen.add(id);
    const facts = metadata.get(id);
    const provider = known.get(extra.provider);
    const injectHost = codexInjectHost(extra.provider);
    const loopbackOrigin = injectHost ? undefined : loopbackOriginTag(provider?.baseUrl);
    options.push({
      id,
      label: facts?.label ?? niceLabel(extra.model, extra.provider, known),
      custom: true,
      providerRoute: (injectHost ? localProviderRoute(extra.provider) : undefined)
        ?? configuredProviderRoute(extra.provider, provider?.name, provider?.baseUrl),
      ...(loopbackOrigin ? { loopbackOrigin } : {}),
      ...(facts?.contextWindow !== undefined ? { contextWindow: facts.contextWindow } : {}),
      ...(facts?.effortLevels ? { effortLevels: facts.effortLevels } : {}),
      ...(facts?.nonChatCapability || facts?.responsesUnsupported ? { protocolUnsupported: true as const } : {}),
    });
  }

  const configured = main.model && main.modelProvider
    ? main.modelProvider === OFFICIAL_CODEX_PROVIDER &&
      official.options.some((option) => option.id === main.model)
      ? main.model
      : encodeCodexSelection(main.modelProvider, main.model)
    : main.model && seen.has(main.model)
      ? main.model
      : null;

  const catalog = await mergeLocalInject(
    {
      default: configured && seen.has(configured) ? configured : official.default,
      options,
    },
    env,
    fetchImpl,
  );
  for (const option of catalog.options) {
    if (option.providerRoute?.provenance !== "local") continue;
    const provider = decodeCodexSelection(option.id).modelProvider;
    const declared = provider ? known.get(provider) : undefined;
    if (provider && declared?.baseUrl && !codexInjectHost(provider)) {
      option.providerRoute = configuredProviderRoute(provider, declared.name, declared.baseUrl);
      const loopbackOrigin = loopbackOriginTag(declared.baseUrl);
      if (loopbackOrigin) option.loopbackOrigin = loopbackOrigin;
    }
  }
  return catalog;
}
