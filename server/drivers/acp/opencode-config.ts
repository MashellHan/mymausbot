import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { MAX_CONTEXT_WINDOW_TOKENS, MIN_CONTEXT_WINDOW_TOKENS } from "../../../shared/model-selection.ts";
import type { ModelCatalog, ModelVariantOption } from "../../contracts.ts";
import { configuredProviderRoute, loopbackOriginTag } from "../../model-provider-routes.ts";
import { labelForModel } from "./opencode-probe.ts";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function opencodeConfigDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

/** JSON with comments and trailing commas, as OpenCode reads its config. */
export function parseJsonc(text: string): unknown {
  let plain = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      plain += character;
      if (character === "\\") plain += text[++index] ?? "";
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      plain += character;
    } else if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      plain += "\n";
    } else if (character === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
    } else plain += character;
  }
  let clean = "";
  inString = false;
  for (let index = 0; index < plain.length; index += 1) {
    const character = plain[index]!;
    if (inString) {
      clean += character;
      if (character === "\\") clean += plain[++index] ?? "";
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      clean += character;
    } else if (character === ",") {
      let next = index + 1;
      while (next < plain.length && /\s/u.test(plain[next]!)) next += 1;
      if (plain[next] !== "}" && plain[next] !== "]") clean += character;
    } else clean += character;
  }
  try {
    return JSON.parse(clean);
  } catch {
    return undefined;
  }
}

export interface OpenCodeConfiguredModel {
  contextWindow?: number;
  variants?: ModelVariantOption[];
}

export interface OpenCodeConfiguredProvider {
  name?: string;
  baseUrl?: string;
  models: Map<string, OpenCodeConfiguredModel>;
}

function extractVariants(modelCfg: Record<string, unknown>): ModelVariantOption[] | undefined {
  const reasoning = record(record(modelCfg.capabilities).reasoning);
  if (Array.isArray(reasoning.effort)) {
    const efforts = [...new Set(
      reasoning.effort
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    )];
    if (efforts.length) return efforts.map((id) => ({ id, label: labelForModel(id) }));
  }
  if (modelCfg.variants && typeof modelCfg.variants === "object" && !Array.isArray(modelCfg.variants)) {
    const ids = Object.entries(modelCfg.variants as Record<string, unknown>)
      .filter(([, settings]) => (
        settings && typeof settings === "object" && !Array.isArray(settings)
        && (settings as Record<string, unknown>).disabled !== true
      ))
      .map(([id]) => id);
    if (ids.length) return ids.map((id) => ({ id, label: labelForModel(id) }));
  }
  return undefined;
}

function mergeProviderBucket(
  result: Map<string, OpenCodeConfiguredProvider>,
  bucket: unknown,
  urlContainerKey: "options" | "settings",
): void {
  for (const [providerId, rawProvider] of Object.entries(record(bucket))) {
    if (!providerId || FORBIDDEN_KEYS.has(providerId)) continue;
    if (!rawProvider || typeof rawProvider !== "object" || Array.isArray(rawProvider)) continue;
    const cfg = rawProvider as Record<string, unknown>;
    let entry = result.get(providerId);
    if (!entry) {
      entry = { models: new Map() };
      result.set(providerId, entry);
    }
    if (typeof cfg.name === "string" && cfg.name.trim()) entry.name = cfg.name.trim();
    const urlContainer = record(cfg[urlContainerKey]);
    if (typeof urlContainer.baseURL === "string" && urlContainer.baseURL.trim()) {
      entry.baseUrl = urlContainer.baseURL.trim();
    }
    for (const [modelId, rawModel] of Object.entries(record(cfg.models))) {
      if (!modelId || FORBIDDEN_KEYS.has(modelId)) continue;
      if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
      const modelCfg = rawModel as Record<string, unknown>;
      const existing = entry.models.get(modelId) ?? {};
      const limit = record(modelCfg.limit);
      if (typeof limit.context === "number" && Number.isFinite(limit.context) && limit.context > 0) {
        const floored = Math.floor(limit.context);
        if (floored > 0) existing.contextWindow = floored;
      }
      const variants = extractVariants(modelCfg);
      if (variants?.length) existing.variants = variants;
      if (existing.contextWindow !== undefined || existing.variants?.length) {
        entry.models.set(modelId, existing);
      }
    }
  }
}

export function readOpenCodeConfiguredProviders(
  env: Record<string, string | undefined>,
): Map<string, OpenCodeConfiguredProvider> {
  const result = new Map<string, OpenCodeConfiguredProvider>();
  const apply = (raw: string | undefined) => {
    if (!raw?.trim()) return;
    const parsed = record(parseJsonc(raw));
    mergeProviderBucket(result, parsed.provider, "options");
    mergeProviderBucket(result, parsed.providers, "settings");
  };

  const globalDir = opencodeConfigDir(env);
  for (const name of ["config.json", "opencode.json", "opencode.jsonc"]) {
    apply(readText(join(globalDir, name)));
  }
  if (env.OPENCODE_CONFIG?.trim()) apply(readText(env.OPENCODE_CONFIG));
  const home = env.HOME || env.USERPROFILE || homedir();
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    apply(readText(join(home, ".opencode", name)));
  }
  if (env.OPENCODE_CONFIG_DIR?.trim()) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      apply(readText(join(env.OPENCODE_CONFIG_DIR, name)));
    }
  }
  apply(env.OPENCODE_CONFIG_CONTENT);
  return result;
}

export function enrichOpenCodeCatalog(
  catalog: ModelCatalog,
  env: Record<string, string | undefined>,
): ModelCatalog {
  if (!catalog.options.length) return catalog;
  const providers = readOpenCodeConfiguredProviders(env);
  if (!providers.size) return catalog;
  let changed = false;
  const options = catalog.options.map((option) => {
    const separator = option.id.indexOf("/");
    if (separator <= 0 || separator >= option.id.length - 1) return option;
    const provider = option.id.slice(0, separator);
    const model = option.id.slice(separator + 1);
    const cfg = providers.get(provider);
    if (!cfg) return option;
    const modelCfg = cfg.models.get(model);
    const providerRoute = option.providerRoute
      ?? (cfg.baseUrl || cfg.name ? configuredProviderRoute(provider, cfg.name, cfg.baseUrl) : undefined);
    const loopbackOrigin = option.loopbackOrigin
      ?? (!option.providerRoute && cfg.baseUrl ? loopbackOriginTag(cfg.baseUrl) : undefined);
    const contextWindow = option.contextWindow ?? modelCfg?.contextWindow;
    const variants = option.variants?.length
      ? option.variants
      : modelCfg?.variants?.length ? modelCfg.variants : undefined;
    if (
      providerRoute === option.providerRoute
      && loopbackOrigin === option.loopbackOrigin
      && contextWindow === option.contextWindow
      && variants === option.variants
    ) {
      return option;
    }
    changed = true;
    return {
      ...option,
      ...(providerRoute ? { providerRoute } : {}),
      ...(loopbackOrigin ? { loopbackOrigin } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(variants ? { variants } : {}),
    };
  });
  return changed ? { ...catalog, options } : catalog;
}

/** Merges a per-model context limit into OPENCODE_CONFIG_CONTENT for both v2 (`providers`) and v1 (`provider`) schemas. */
export function applyOpenCodeContextWindow(
  env: Record<string, string | undefined>,
  model: string | undefined,
  contextWindowTokens: number | undefined,
): void {
  if (
    contextWindowTokens === undefined
    || !Number.isSafeInteger(contextWindowTokens)
    || contextWindowTokens < MIN_CONTEXT_WINDOW_TOKENS
    || contextWindowTokens > MAX_CONTEXT_WINDOW_TOKENS
    || typeof model !== "string"
  ) return;
  const separator = model.indexOf("/");
  if (separator <= 0 || separator >= model.length - 1) return;
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  if (FORBIDDEN_KEYS.has(provider) || FORBIDDEN_KEYS.has(modelId)) return;

  let config: Record<string, unknown> = {};
  if (env.OPENCODE_CONFIG_CONTENT?.trim()) {
    const parsed = parseJsonc(env.OPENCODE_CONFIG_CONTENT);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    config = parsed as Record<string, unknown>;
  }

  const mergeBucket = (bucket: unknown): Record<string, unknown> => {
    const all = { ...record(bucket) };
    const existingProvider = Object.hasOwn(all, provider) ? record(all[provider]) : {};
    const existingModels = { ...record(existingProvider.models) };
    const existingModel = Object.hasOwn(existingModels, modelId) ? record(existingModels[modelId]) : {};
    const existingLimit = record(existingModel.limit);
    existingModels[modelId] = {
      ...existingModel,
      limit: { ...existingLimit, context: contextWindowTokens },
    };
    all[provider] = { ...existingProvider, models: existingModels };
    return all;
  };

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...config,
    providers: mergeBucket(config.providers),
    provider: mergeBucket(config.provider),
  });
}
