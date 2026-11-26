import { createHash } from "node:crypto";

import type { ModelProviderRoute } from "../shared/model-provider-route.ts";
import type { InstanceConfigMap, ModelCatalog } from "./contracts.ts";
import { isLoopback } from "./provider-key-check.ts";

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u;
const ROUTE_ID = /^[a-z0-9:_-]{1,80}$/;
const CONNECTION_GROUP = /^loopback:[0-9a-f]{16}$/;
const LOOPBACK_ORIGIN = /^origin(?:-only)?:[0-9a-f]{16}$/;
const BARE_SLUG = /^[a-z0-9_-]+$/;
const UNKNOWN: ModelProviderRoute = { id: "unknown", provenance: "unknown" };
const CODEX_NATIVE: ModelProviderRoute = { id: "native:openai", label: "OpenAI", provenance: "native" };
const CODEX_PLAN: ModelProviderRoute = { id: "native:chatgpt-plan", label: "OpenAI", provenance: "native" };

type LoopbackGroupMeta = { origin: string; pathname: string; originOnly: boolean };
const loopbackGroups = new Map<string, LoopbackGroupMeta>();

function originHash(origin: string): string {
  return createHash("sha256").update(origin).digest("hex").slice(0, 16);
}

export function providerLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  return LABEL.test(label) ? label : undefined;
}

function parseLoopbackUrl(baseUrl?: string): { origin: string; pathname: string } | undefined {
  if (!baseUrl || !URL.canParse(baseUrl)) return undefined;
  const url = new URL(baseUrl);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopback(url.hostname) ||
      url.username || url.password || url.search || url.hash) return undefined;
  return { origin: url.origin, pathname: url.pathname.replace(/\/+$/, "") };
}

export function loopbackOriginTag(baseUrl?: string, originOnly = false): string | undefined {
  const parsed = parseLoopbackUrl(baseUrl);
  if (!parsed) return undefined;
  if (originOnly) {
    return parsed.pathname === "" ? `origin-only:${originHash(parsed.origin)}` : undefined;
  }
  return parsed.pathname === "" || parsed.pathname === "/v1"
    ? `origin:${originHash(parsed.origin)}`
    : undefined;
}

export function sanitizeLoopbackOrigin(value: unknown): string | undefined {
  return typeof value === "string" && LOOPBACK_ORIGIN.test(value) ? value : undefined;
}

export function configuredProviderRoute(id: string, label?: string, baseUrl?: string): ModelProviderRoute {
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  const safe = providerLabel(label) ?? providerLabel(id);
  const connectionGroup = loopbackConnectionGroup(id, baseUrl);
  return { id: `configured:${digest}`, ...(safe ? { label: safe } : {}), provenance: "configured", ...(connectionGroup ? { connectionGroup } : {}) };
}

export function configuredLoopbackOriginRoute(label: string | undefined, baseUrl?: string): ModelProviderRoute | undefined {
  const parsed = parseLoopbackUrl(baseUrl);
  if (!parsed || parsed.pathname !== "") return undefined;
  const id = `configured:${createHash("sha256").update(`origin:${parsed.origin}`).digest("hex").slice(0, 16)}`;
  const connectionGroup = `loopback:${createHash("sha256").update(JSON.stringify(["origin", parsed.origin])).digest("hex").slice(0, 16)}`;
  const safe = providerLabel(label);
  loopbackGroups.set(connectionGroup, { origin: parsed.origin, pathname: parsed.pathname, originOnly: true });
  return { id, ...(safe ? { label: safe } : {}), provenance: "configured", connectionGroup };
}

function loopbackConnectionGroup(id: string, baseUrl?: string): string | undefined {
  const parsed = parseLoopbackUrl(baseUrl);
  if (!parsed) return undefined;
  const endpoint = `${parsed.origin}${parsed.pathname}`;
  const digest = createHash("sha256").update(JSON.stringify([id, endpoint])).digest("hex").slice(0, 16);
  const group = `loopback:${digest}`;
  loopbackGroups.set(group, { origin: parsed.origin, pathname: parsed.pathname, originOnly: false });
  return group;
}

export function sanitizeModelProviderRoute(value: unknown): ModelProviderRoute | undefined {
  if (!value || typeof value !== "object") return undefined;
  const route = value as Partial<ModelProviderRoute>;
  if (typeof route.id !== "string" || !ROUTE_ID.test(route.id) ||
    !["configured", "native", "local", "unknown"].includes(String(route.provenance))) return undefined;
  const label = providerLabel(route.label);
  const connectionGroup = route.provenance === "configured" && typeof route.connectionGroup === "string" && CONNECTION_GROUP.test(route.connectionGroup)
    ? route.connectionGroup : undefined;
  return { id: route.id, ...(label ? { label } : {}), provenance: route.provenance!, ...(connectionGroup ? { connectionGroup } : {}) };
}

type DescribedInstance = { instanceId: string; driverKind: string; models: ModelCatalog };

export function withModelProviderRoutes(described: unknown, configs: InstanceConfigMap): unknown {
  if (!Array.isArray(described)) return described;
  const persistedOrigins = new WeakMap<object, string>();
  const resolved = described.map((instance: DescribedInstance) => {
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
      const { loopbackOrigin: rawLoopbackOrigin, ...rest } = option;
      const route: ModelProviderRoute = (routedCodex ? configured ?? { id: "connection", provenance: "configured" as const } : undefined)
        ?? (codexConfig?.authMode === "chatgpt-plan" ? CODEX_PLAN : undefined)
        ?? sanitizeModelProviderRoute(option.providerRoute)
        ?? (instance.driverKind === "codex" && !option.custom ? CODEX_NATIVE : undefined)
        ?? configured ?? UNKNOWN;
      const next = { ...rest, providerRoute: route };
      const originTag = sanitizeLoopbackOrigin(rawLoopbackOrigin);
      if (originTag) persistedOrigins.set(next, originTag);
      return next;
    }) } };
  });

  const originInfo = (option: object, group: string): { originKey: string; originOnly: boolean } | undefined => {
    const tag = persistedOrigins.get(option);
    if (tag) {
      return tag.startsWith("origin-only:")
        ? { originKey: tag.slice("origin-only:".length), originOnly: true }
        : { originKey: tag.slice("origin:".length), originOnly: false };
    }
    const meta = loopbackGroups.get(group);
    if (!meta) return undefined;
    if (meta.originOnly) {
      return meta.pathname === "" ? { originKey: originHash(meta.origin), originOnly: true } : undefined;
    }
    if (meta.pathname !== "" && meta.pathname !== "/v1") return undefined;
    return { originKey: originHash(meta.origin), originOnly: false };
  };

  const byOrigin = new Map<string, { groups: Set<string>; label?: string }>();
  for (const instance of resolved) {
    if (!instance || !Array.isArray(instance.models?.options)) continue;
    for (const option of instance.models.options) {
      const group = option.providerRoute?.connectionGroup;
      if (!group) continue;
      const info = originInfo(option, group);
      if (!info || info.originOnly) continue;
      let entry = byOrigin.get(info.originKey);
      if (!entry) byOrigin.set(info.originKey, entry = { groups: new Set() });
      entry.groups.add(group);
      const routeLabel = option.providerRoute?.label;
      if (routeLabel && (!entry.label || (BARE_SLUG.test(entry.label) && !BARE_SLUG.test(routeLabel)))) {
        entry.label = routeLabel;
      }
    }
  }
  if (!byOrigin.size) return resolved;

  return resolved.map((instance: DescribedInstance) => {
    if (!instance || !Array.isArray(instance.models?.options)) return instance;
    let changed = false;
    const options = instance.models.options.map((option) => {
      const route = option.providerRoute;
      const group = route?.connectionGroup;
      if (!route || !group) return option;
      const info = originInfo(option, group);
      if (!info?.originOnly) return option;
      const match = byOrigin.get(info.originKey);
      if (!match || match.groups.size !== 1) return option;
      const [targetGroup] = match.groups;
      changed = true;
      return {
        ...option,
        providerRoute: {
          ...route,
          connectionGroup: targetGroup,
          ...(match.label ? { label: match.label } : {}),
        },
      };
    });
    return changed ? { ...instance, models: { ...instance.models, options } } : instance;
  });
}
