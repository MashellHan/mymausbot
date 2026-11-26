import { EFFORT_LEVELS, type EffortLevel } from "../../shared/model-selection.ts";
import type { ModelCatalog } from "../contracts.ts";
import { configuredProviderRoute, loopbackOriginTag } from "../model-provider-routes.ts";

export function piThinkingLevel(effort: EffortLevel): (typeof EFFORT_LEVELS)[number] | "off" {
  return effort === "none" ? "off" : effort;
}

interface PiModelEntry {
  provider: string;
  id: string;
  name?: string;
  baseUrl?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ReturnType<typeof piThinkingLevel>, string | null>>;
}

interface PiModelsResponse {
  type: "response";
  command: "get_available_models";
  success: boolean;
  data?: { models?: PiModelEntry[] };
}

export function piCatalogFromFrame(frame: unknown, fallbackDefault: string): ModelCatalog | null {
  const res = frame as PiModelsResponse;
  if (res?.type !== "response" || res.command !== "get_available_models" || !res.success) return null;
  const options: ModelCatalog["options"] = [];
  for (const m of res.data?.models ?? []) {
    if (typeof m?.provider !== "string" || !m.provider || typeof m.id !== "string" || !m.id) continue;
    const id = `${m.provider}/${m.id}`;
    const contextWindow = typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow) && m.contextWindow > 0
      ? Math.floor(m.contextWindow)
      : undefined;
    const effortLevels = typeof m.reasoning === "boolean" ? piModelEffortLevels(m) : undefined;
    const hasBaseUrl = typeof m.baseUrl === "string" && m.baseUrl.length > 0;
    const loopbackOrigin = hasBaseUrl ? loopbackOriginTag(m.baseUrl) : undefined;
    options.push({
      id, label: typeof m.name === "string" ? m.name : m.id, custom: true, provider: m.provider,
      ...(hasBaseUrl ? { providerRoute: configuredProviderRoute(m.provider, m.provider, m.baseUrl) } : {}),
      ...(loopbackOrigin ? { loopbackOrigin } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(effortLevels ? { effortLevels } : {}),
    });
  }
  return { default: fallbackDefault || (options[0]?.id ?? ""), options };
}

function piModelEffortLevels(model: PiModelEntry): EffortLevel[] {
  if (!model.reasoning) return [];
  // Pi 1.5.2 excludes null mappings and requires an explicit mapping for xhigh and max.
  return EFFORT_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[piThinkingLevel(level)];
    return mapped !== null && ((level !== "xhigh" && level !== "max") || typeof mapped === "string");
  });
}

export function parsePiCatalog(stdout: string, fallbackDefault = ""): ModelCatalog {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const catalog = piCatalogFromFrame(msg, fallbackDefault);
    if (catalog) return catalog;
  }
  return { default: fallbackDefault, options: [] };
}
