import { describe, expect, it } from "vitest";

import { configuredProviderRoute, withModelProviderRoutes } from "./model-provider-routes.ts";

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
});
