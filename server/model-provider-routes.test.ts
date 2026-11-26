import { describe, expect, it } from "vitest";

import {
  configuredLoopbackOriginRoute,
  configuredProviderRoute,
  loopbackOriginTag,
  sanitizeLoopbackOrigin,
  withModelProviderRoutes,
} from "./model-provider-routes.ts";

describe("model provider routes", () => {
  it("uses registered Codex and local routes, and marks other unproved providers unknown", () => {
    const described = [
      { instanceId: "codex", driverKind: "codex", models: { default: "gpt", options: [
        { id: "gpt", label: "GPT" },
        { id: "omlx::Qwen", label: "Qwen", custom: true, providerRoute: { id: "local:omlx", label: "oMLX", provenance: "local" as const } },
      ] } },
      { instanceId: "other", driverKind: "other", models: { default: "m", options: [{ id: "m", label: "M" }] } },
    ];
    const result = withModelProviderRoutes(described, {}) as typeof described;
    expect(result[0].models.options.map((option) => (option as any).providerRoute)).toEqual([
      { id: "native:openai", label: "OpenAI", provenance: "native" },
      { id: "local:omlx", label: "oMLX", provenance: "local" },
    ]);
    expect((result[1].models.options[0] as any).providerRoute).toEqual({ id: "unknown", provenance: "unknown" });
  });

  it("does not infer a local provider from remote reserved or host-shaped model IDs", () => {
    const described = [
      { instanceId: "remote", driverKind: "openai-compat", models: { default: "ollama", options: [
        { id: "ollama", label: "Ollama", custom: true },
        { id: "omlx::M", label: "M", custom: true, providerRoute: { id: "configured:opaque", label: "Remote route", provenance: "configured" as const } },
      ] } },
      { instanceId: "unconfigured", driverKind: "other", models: { default: "omlx::M", options: [
        { id: "omlx::M", label: "M", custom: true },
      ] } },
    ];
    const configs = { remote: { driver: "openai-compat", config: { url: "https://remote.example.test/v1" } } };
    const result = withModelProviderRoutes(described, configs) as typeof described;
    expect(result[0].models.options.map((option) => (option as any).providerRoute)).toEqual([
      { id: "connection", provenance: "configured" },
      { id: "configured:opaque", label: "Remote route", provenance: "configured" },
    ]);
    expect((result[1].models.options[0] as any).providerRoute).toEqual({ id: "unknown", provenance: "unknown" });
    expect(result[0].models.options.map((option) => option.id)).toEqual(["ollama", "omlx::M"]);
  });

  it("bounds configured names and drops a route that resembles a credential-bearing URL", () => {
    const configured = configuredProviderRoute("proxy_alpha", "https://secret.example.test/key=abc");
    expect(configured).toMatchObject({ label: "proxy_alpha", provenance: "configured" });
    const described = [{ instanceId: "x", driverKind: "other", models: { default: "m", options: [
      { id: "m", label: "M", providerRoute: { id: "https://secret.example.test/key=abc", label: "token=abc", provenance: "configured" } },
    ] } }];
    const result = withModelProviderRoutes(described, { x: { driver: "other", displayName: "https://secret.example.test/key=abc" } }) as typeof described;
    expect((result[0].models.options[0] as any).providerRoute).toEqual({ id: "connection", provenance: "configured" });
    expect(JSON.stringify((result[0].models.options[0] as any).providerRoute)).not.toContain("secret.example");
  });

  it("groups only matching configured loopback endpoints across runtime catalogs", () => {
    const endpoint = "http://127.0.0.1:4040/v1";
    const codexRoute = configuredProviderRoute("raven", "Raven (Local)", endpoint);
    const piRoute = configuredProviderRoute("raven", "raven", `${endpoint}/`);
    expect(piRoute.connectionGroup).toMatch(/^loopback:[0-9a-f]{16}$/);
    expect(piRoute.connectionGroup).toBe(codexRoute.connectionGroup);
    expect(configuredProviderRoute("different", "Raven (Local)", endpoint).connectionGroup).not.toBe(piRoute.connectionGroup);
    expect(configuredProviderRoute("raven", "Raven (Local)", `${endpoint}/different`).connectionGroup).not.toBe(piRoute.connectionGroup);
    expect(configuredProviderRoute("raven", "Raven (Local)", "https://external.example/v1").connectionGroup).toBeUndefined();
    expect(configuredProviderRoute("raven", "Raven (Local)", `${endpoint}?key=secret`).connectionGroup).toBeUndefined();

    const described = [{ instanceId: "pi", driverKind: "piAgent", models: { default: "m", options: [
      { id: "m", label: "M", providerRoute: piRoute },
      { id: "x", label: "X", providerRoute: { ...piRoute, connectionGroup: `${endpoint}?key=secret` } },
    ] } }];
    const result = withModelProviderRoutes(described, {}) as typeof described;
    expect(result[0].models.options[0]?.providerRoute.connectionGroup).toBe(piRoute.connectionGroup);
    expect(result[0].models.options[1]?.providerRoute.connectionGroup).toBeUndefined();
  });

  it("keeps an explicit Codex endpoint on its configured connection even with ordinary noncustom model ids", () => {
    const described = [{ instanceId: "endpoint", driverKind: "codex", models: { default: "M", options: [
      { id: "M", label: "M", custom: false, providerRoute: { id: "native:openai", label: "OpenAI", provenance: "native" as const } },
    ] } }];
    const configs = { endpoint: { driver: "codex", displayName: "Private Gateway", config: { endpoint: { url: "https://secret.example.test/v1", models: ["M"] } } } };
    const result = withModelProviderRoutes(described, configs) as typeof described;
    expect((result[0].models.options[0] as any).providerRoute).toEqual({ id: "connection", label: "Private Gateway", provenance: "configured" });
    expect(JSON.stringify((result[0].models.options[0] as any).providerRoute)).not.toContain("secret.example");
  });

  it("distinguishes Company routing from a ChatGPT plan before the native Codex fallback", () => {
    const described = ["company", "plan"].map((instanceId) => ({
      instanceId, driverKind: "codex", models: { default: "M", options: [{ id: "M", label: "M" }] },
    }));
    const configs = {
      company: { driver: "codex", displayName: "Company · Codex", config: { managed: { url: "https://company.example.test/v1", models: ["M"] } } },
      plan: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
    };
    const result = withModelProviderRoutes(described, configs) as typeof described;
    expect((result[0].models.options[0] as any).providerRoute).toEqual({ id: "connection", provenance: "configured" });
    expect((result[1].models.options[0] as any).providerRoute).toEqual({ id: "native:chatgpt-plan", label: "OpenAI", provenance: "native" });
  });

  it("merges an origin-only loopback route into a unique /v1 loopback group on the same origin", () => {
    const endpoint = "http://127.0.0.1:4141/v1";
    const piRoute = configuredProviderRoute("raven", "raven", endpoint);
    const openCodeRoute = configuredProviderRoute("raven", "Raven (Local)", `${endpoint}/`);
    const claudeRoute = configuredLoopbackOriginRoute("Anthropic Proxy", "http://127.0.0.1:4141");
    expect(claudeRoute?.connectionGroup).toMatch(/^loopback:[0-9a-f]{16}$/);
    expect(claudeRoute?.connectionGroup).not.toBe(piRoute.connectionGroup);

    const described = [
      { instanceId: "pi", driverKind: "piAgent", models: { default: "m", options: [{ id: "m", label: "M", providerRoute: piRoute }] } },
      { instanceId: "opencode", driverKind: "opencodeGo", models: { default: "m", options: [{ id: "m", label: "M", providerRoute: openCodeRoute }] } },
      { instanceId: "claude", driverKind: "claude", models: { default: "m", options: [{ id: "m", label: "M", providerRoute: claudeRoute }] } },
    ];
    const result = withModelProviderRoutes(described, {}) as typeof described;
    expect(result[2].models.options[0]?.providerRoute).toEqual({
      id: claudeRoute!.id,
      label: "Raven (Local)",
      provenance: "configured",
      connectionGroup: piRoute.connectionGroup,
    });
    expect(JSON.stringify(result)).not.toContain("127.0.0.1:4141");
  });

  it("fails closed when multiple distinct loopback groups share the same origin", () => {
    const first = configuredProviderRoute("alpha", "Alpha", "http://127.0.0.1:4242/v1");
    const second = configuredProviderRoute("beta", "Beta", "http://127.0.0.1:4242/v1");
    const originOnly = configuredLoopbackOriginRoute("Shared Origin", "http://127.0.0.1:4242");
    expect(first.connectionGroup).not.toBe(second.connectionGroup);

    const described = [
      { instanceId: "a", driverKind: "piAgent", models: { default: "m", options: [{ id: "m", label: "M", providerRoute: first }] } },
      { instanceId: "b", driverKind: "opencodeGo", models: { default: "m", options: [{ id: "m", label: "M", providerRoute: second }] } },
      { instanceId: "c", driverKind: "claude", models: { default: "m", options: [{ id: "m", label: "M", providerRoute: originOnly }] } },
    ];
    const result = withModelProviderRoutes(described, {}) as typeof described;
    expect(result[2].models.options[0]?.providerRoute).toEqual(originOnly);
  });

  it("rejects non-loopback, malformed, path-scoped, and credential-bearing URLs for origin routes", () => {
    expect(configuredLoopbackOriginRoute("Remote", "https://api.example.test")).toBeUndefined();
    expect(configuredLoopbackOriginRoute("Creds", "http://user:pass@127.0.0.1:4040")).toBeUndefined();
    expect(configuredLoopbackOriginRoute("Query", "http://127.0.0.1:4040?key=secret")).toBeUndefined();
    expect(configuredLoopbackOriginRoute("Hash", "http://127.0.0.1:4040#frag")).toBeUndefined();
    expect(configuredLoopbackOriginRoute("Scheme", "file:///tmp/socket")).toBeUndefined();
    expect(configuredLoopbackOriginRoute("Missing", undefined)).toBeUndefined();
    expect(configuredLoopbackOriginRoute("PathScoped", "http://127.0.0.1:7024/other-proxy")).toBeUndefined();
    expect(configuredLoopbackOriginRoute("V1Path", "http://127.0.0.1:7024/v1")).toBeUndefined();
    expect(configuredLoopbackOriginRoute("TrailingSlash", "http://127.0.0.1:7024/")).toMatchObject({
      label: "TrailingSlash",
      provenance: "configured",
    });
  });

  it("does not merge a path-scoped loopback route into a /v1 provider on the same port", () => {
    const v1Route = configuredProviderRoute("raven", "Raven (Local)", "http://127.0.0.1:7024/v1");
    const v1Origin = loopbackOriginTag("http://127.0.0.1:7024/v1");
    expect(configuredLoopbackOriginRoute("Antigravity (Local)", "http://127.0.0.1:7024/other-proxy")).toBeUndefined();
    expect(loopbackOriginTag("http://127.0.0.1:7024/other-proxy", true)).toBeUndefined();
    expect(loopbackOriginTag("http://127.0.0.1:7024/other-proxy")).toBeUndefined();
    const fallbackRoute = configuredProviderRoute("antigravity", "Antigravity (Local)", "http://127.0.0.1:7024/other-proxy");

    const described = [
      { instanceId: "pi", driverKind: "piAgent", models: { default: "m", options: [{ id: "m", label: "M", providerRoute: v1Route, loopbackOrigin: v1Origin }] } },
      { instanceId: "agy", driverKind: "antigravityAgent", models: { default: "g", options: [{ id: "g", label: "G", providerRoute: fallbackRoute }] } },
    ];
    const result = withModelProviderRoutes(described, {}) as typeof described;
    expect(result[1].models.options[0]?.providerRoute).toEqual(fallbackRoute);
    expect(result[1].models.options[0]?.providerRoute.connectionGroup).not.toBe(v1Route.connectionGroup);
    expect(Object.hasOwn(result[0].models.options[0]!, "loopbackOrigin")).toBe(false);
  });

  it("merges persisted loopbackOrigin tags after restart without in-memory metadata and always strips loopbackOrigin", () => {
    const origin = loopbackOriginTag("http://127.0.0.1:7373/v1");
    const originOnly = loopbackOriginTag("http://127.0.0.1:7373", true);
    expect(origin).toMatch(/^origin:[0-9a-f]{16}$/);
    expect(originOnly).toMatch(/^origin-only:[0-9a-f]{16}$/);
    expect(sanitizeLoopbackOrigin(origin)).toBe(origin);
    expect(sanitizeLoopbackOrigin(originOnly)).toBe(originOnly);
    expect(sanitizeLoopbackOrigin("http://127.0.0.1:7373")).toBeUndefined();
    expect(sanitizeLoopbackOrigin("origin:not-hex")).toBeUndefined();

    // Fresh group IDs never registered in the in-memory loopbackGroups map (simulating a cold restart).
    const persistedV1Group = "loopback:aaaaaaaaaaaaaaaa";
    const persistedOriginOnlyGroup = "loopback:bbbbbbbbbbbbbbbb";
    const described = [
      {
        instanceId: "opencode",
        driverKind: "opencodeGo",
        models: {
          default: "m",
          options: [{
            id: "m",
            label: "M",
            providerRoute: { id: "configured:1111111111111111", label: "Raven (Local)", provenance: "configured" as const, connectionGroup: persistedV1Group },
            loopbackOrigin: origin,
          }],
        },
      },
      {
        instanceId: "agy",
        driverKind: "antigravityAgent",
        models: {
          default: "g",
          options: [{
            id: "g",
            label: "G",
            providerRoute: { id: "configured:2222222222222222", label: "Antigravity (Local)", provenance: "configured" as const, connectionGroup: persistedOriginOnlyGroup },
            loopbackOrigin: originOnly,
          }],
        },
      },
    ];
    const result = withModelProviderRoutes(described, {}) as Array<{ models: { options: Array<Record<string, unknown>> } }>;
    expect(result[1].models.options[0]?.providerRoute).toEqual({
      id: "configured:2222222222222222",
      label: "Raven (Local)",
      provenance: "configured",
      connectionGroup: persistedV1Group,
    });
    expect(Object.hasOwn(result[0].models.options[0]!, "loopbackOrigin")).toBe(false);
    expect(Object.hasOwn(result[1].models.options[0]!, "loopbackOrigin")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("loopbackOrigin");
    expect(JSON.stringify(result)).not.toContain("127.0.0.1:7373");

    // Even when no merge target exists, loopbackOrigin must still be stripped from wire output.
    const lone = withModelProviderRoutes([described[1]], {}) as Array<{ models: { options: Array<Record<string, unknown>> } }>;
    expect(Object.hasOwn(lone[0].models.options[0]!, "loopbackOrigin")).toBe(false);
    expect(lone[0].models.options[0]?.providerRoute).toEqual(described[1].models.options[0]!.providerRoute);
  });
});
