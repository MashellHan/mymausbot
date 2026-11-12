import { createHash } from "node:crypto";

import type { ModelProviderRoute } from "../shared/model-provider-route.ts";
import type { InstanceConfigMap, ModelCatalog } from "./contracts.ts";
import { localHost } from "./drivers/local-inject.ts";

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

export function localProviderRoute(id: string): ModelProviderRoute | undefined {
  const host = localHost(id);
  return host ? { id: `local:${host.id}`, label: host.label, provenance: "local" } : undefined;
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
    const config = configs[instance.instanceId];
    const label = providerLabel(config?.displayName);
    const configured = config?.displayName ? { id: "connection", ...(label ? { label } : {}), provenance: "configured" as const } : undefined;
    const codexConfig = instance.driverKind === "codex" ? config?.config as { endpoint?: unknown; managed?: unknown; authMode?: unknown } | undefined : undefined;
    const routedCodex = Boolean(codexConfig?.endpoint || codexConfig?.managed);
    return { ...instance, models: { ...instance.models, options: instance.models.options.map((option) => {
      const localId = option.custom && !routedCodex ? option.id.split("::", 1)[0] : undefined;
      const route = (routedCodex ? configured ?? { id: "connection", provenance: "configured" as const } : undefined)
        ?? (localId ? localProviderRoute(localId) : undefined)
        ?? safeRoute(option.providerRoute)
        ?? (instance.driverKind === "codex" && !option.custom ? codexConfig?.authMode === "chatgpt-plan" ? CODEX_PLAN : CODEX_NATIVE : undefined)
        ?? configured ?? UNKNOWN;
      return { ...option, providerRoute: route };
    }) } };
  });
}
