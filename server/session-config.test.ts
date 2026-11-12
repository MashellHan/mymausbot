import { describe, expect, it } from "vitest";
import type { JsonObject } from "./schema.ts";
import { hasSessionSecretPatch, persistedSessionConfig, withSessionSecrets } from "./session-config.ts";

describe("session-only config persistence", () => {
  it("keeps old disk secrets byte-for-byte while new provider secrets stay in memory", () => {
    const old: JsonObject = {
      openai: { key: "old-persistent-key", url: "https://old.example.test" },
      composio: { userId: "old-user", sessionId: "old-grant" },
      opencodeGo: { providerKeys: { VENICE_API_KEY: "old-provider-key" } },
      tts: { geminiKey: "old-gemini-key" },
      live: { key: "old-live-key", keyFor: "openai" },
      instances: { old: { driver: "customAcp", environment: { TOKEN: "old-instance-key" } } },
      mcpServers: { old: { env: { TOKEN: "old-mcp-key" } } },
    };
    const current: JsonObject = {
      openai: { key: "new-session-key", url: "https://new.example.test" },
      anthropic: { key: "new-anthropic-key", everyClaudeBot: false },
      composio: { userId: "new-user", sessionId: "new-grant" },
      opencodeGo: { providerKeys: { VENICE_API_KEY: "new-provider-key" } },
      tts: { geminiKey: "new-gemini-key" },
      live: { key: "new-live-key", keyFor: "azure:example.test", provider: "azure" },
      instances: { newer: { driver: "customAcp", environment: { TOKEN: "new-instance-key" } } },
      mcpServers: { newer: { env: { TOKEN: "new-mcp-key" } } },
    };
    const disk = persistedSessionConfig(current, old);
    expect(disk).toEqual({
      ...old, openai: { key: "old-persistent-key", url: "https://new.example.test" },
      anthropic: { everyClaudeBot: false }, live: { key: "old-live-key", keyFor: "openai", provider: "azure" },
    });
    expect(JSON.stringify(disk)).not.toMatch(/new-session-key|new-anthropic-key|new-grant|new-provider-key|new-instance-key|new-mcp-key|new-gemini-key|new-live-key|azure:example.test/);
    expect(old.openai).toEqual({ key: "old-persistent-key", url: "https://old.example.test" });
  });

  it("classifies direct provider keys and opaque instance or MCP updates, while ordinary settings stay durable", () => {
    const patches: JsonObject[] = [{ openai: { key: "new" } }, { anthropic: { key: "new" } }, { openrouter: { key: "new" } },
      { mistral: { key: "new" } }, { modelgo: { key: "new" } }, { opencodeGo: { providerKeys: { VENICE_API_KEY: "new" } } },
      { instances: { custom: { driver: "customAcp" } } }, { mcpServers: {} }, { composio: { sessionId: "grant" } },
      { tts: { geminiKey: "key" } }, { live: { keyFor: "azure:example.test" } }];
    for (const patch of patches) {
      expect(hasSessionSecretPatch(patch)).toBe(true);
    }
    expect(hasSessionSecretPatch({ profile: { name: "Ada" }, openai: { url: "https://example.test" } })).toBe(false);
  });

  it("prefers the current session key over an inherited provider environment", () => {
    expect(withSessionSecrets({ openai: { key: "inherited" }, profile: { name: "Ada" } },
      { openai: { key: "current" } })).toEqual({ openai: { key: "current" }, profile: { name: "Ada" } });
  });
});
