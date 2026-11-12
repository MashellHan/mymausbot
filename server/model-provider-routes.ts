import { createHash } from "node:crypto";

import type { ModelProviderRoute } from "../shared/model-provider-route.ts";
import type { InstanceConfigMap, ModelCatalog } from "./contracts.ts";

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;
const ROUTE_ID = /^[a-z0-9:_-]{1,80}$/;
const UNKNOWN: ModelProviderRoute = { id: "unknown", provenance: "unknown" };
const CODEX_NATIVE: ModelProviderRoute = { id: "native:openai", label: "OpenAI", provenance: "native" };
const CODEX_PLAN: ModelProviderRoute = { id: "native:chatgpt-plan", label: "OpenAI", provenance: "native" };

export function providerLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return LABEL.test(label) ? label : undefined;
}

export function configuredProviderRoute(id: string, label?: string): ModelProviderRoute {
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  const safe = providerLabel(label) ?? providerLabel(id);
  return { id: `configured:${digest}`, ...(safe ? { label: safe } : {}), provenance: "configured" };
}

function safeRoute(value: unknown): ModelProviderRoute | undefined {
  if (!value || typeof value !== "object") return undefined;
  const route = value as Partial<ModelProviderRoute>;
  if (typeof route.id !== "string" || !ROUTE_ID.test(route.id) ||
    !["configured", "native", "local", "unknown"].includes(String(route.provenance))) return undefined;
  const label = providerLabel(route.label);
  return { id: route.id, ...(label ? { label } : {}), provenance: route.provenance! };
}

type DescribedInstance = { instanceId: string; driverKind: string; models: ModelCatalog };

export function withModelProviderRoutes(described: unknown, configs: InstanceConfigMap): unknown {
  if (!Array.isArray(described)) return described;
  return described.map((instance: DescribedInstance) => {
    if (!instance || typeof instance.instanceId !== "string" || typeof instance.driverKind !== "string" ||
      !Array.isArray(instance.models?.options)) return instance;
    const candidate = configs[instance.instanceId];
    const config = candidate?.driver === instance.driverKind ? candidate : undefined;
    const label = providerLabel(config?.displayName);
    const settings = config?.config && typeof config.config === "object" && !Array.isArray(config.config)
      ? config.config as Record<string, unknown> : {};
    const configured = config?.displayName || (instance.driverKind === "openai-compat" && typeof settings.url === "string" && settings.url.trim())
      ? { id: "connection", ...(label ? { label } : {}), provenance: "configured" as const } : undefined;
    const codexConfig = instance.driverKind === "codex" ? settings : undefined;
    const routedCodex = Boolean(codexConfig?.endpoint || codexConfig?.managed);
    return { ...instance, models: { ...instance.models, options: instance.models.options.map((option) => {
      const route = (routedCodex ? configured ?? { id: "connection", provenance: "configured" as const } : undefined)
        ?? (codexConfig?.authMode === "chatgpt-plan" ? CODEX_PLAN : undefined)
        ?? safeRoute(option.providerRoute)
        ?? (instance.driverKind === "codex" && !option.custom ? CODEX_NATIVE : undefined)
        ?? configured ?? UNKNOWN;
      return { ...option, providerRoute: route };
    }) } };
  });
}
