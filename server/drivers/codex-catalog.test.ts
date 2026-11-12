import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { CodexDriver } from "./codex.ts";
import {
  decodeCodexSelection,
  encodeCodexSelection,
  OFFICIAL_CODEX_PROVIDER,
  readCodexModelCatalog,
  STATIC_CODEX_MODELS,
} from "./codex-catalog.ts";

const scratchDirs: string[] = [];
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(files: Record<string, string>, parent = tmpdir()): string {
  const home = mkdtempSync(join(parent, "omb-codex-catalog-"));
  scratchDirs.push(home);
  const root = join(home, ".codex");
  mkdirSync(root, { recursive: true });
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
  return home;
}

describe("decodeCodexSelection", () => {
  it("forces official rows onto the ChatGPT provider", () => {
    expect(decodeCodexSelection("gpt-5.6-sol")).toEqual({
      model: "gpt-5.6-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("forces newly discovered bare ids onto the ChatGPT provider too", () => {
    expect(decodeCodexSelection("gpt-future-codex")).toEqual({
      model: "gpt-future-codex",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
    });
  });

  it("splits provider-encoded custom ids", () => {
    expect(decodeCodexSelection("omlx::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning")).toEqual({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "omlx",
    });
  });
});

describe("readCodexModelCatalog", () => {
  it("returns the static cloud fallback when there is no config or CLI probe", async () => {
    expect(await readCodexModelCatalog({ HOME: join(tmpdir(), "omb-codex-missing-home") })).toEqual(
      STATIC_CODEX_MODELS,
    );
  });

  it("uses every visible page from the installed Codex app-server catalog", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      { HOME: join(tmpdir(), "omb-codex-app-server-models"), PATH: process.env.PATH },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default" },
        { id: "gpt-page-two", label: "GPT Page Two" },
      ],
    });
  });

  it("appends the configured local model and cached catalog slugs as custom", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:9/v1"
`,
      "omlx.config.toml": `
model_provider = "omlx"
model = "GLM-5.2-mxfp4"
`,
      "model-catalogs/omlx-models.json": JSON.stringify({
        models: [{ slug: "GLM-5.2-mxfp4", display_name: "GLM-5.2-mxfp4 (oMLX)" }],
      }),
    });

    const catalog = await readCodexModelCatalog({ HOME: home }, async () => {
      throw new Error("live probe should not be required");
    });

    expect(catalog.default).toBe(encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"));
    expect(catalog.options.slice(0, STATIC_CODEX_MODELS.options.length)).toEqual(STATIC_CODEX_MODELS.options);
    expect(catalog.options.filter((option) => option.custom).map((option) => option.id)).toEqual([
      encodeCodexSelection("omlx", "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning"),
      encodeCodexSelection("omlx", "GLM-5.2-mxfp4"),
    ]);
    expect(catalog.options.find((option) => option.id.endsWith("GLM-5.2-mxfp4"))?.label).toBe("GLM-5.2-mxfp4 (oMLX)");
  });

  it("keeps an official-looking model slug bound to its configured local provider", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "gpt-5.4"

[model_providers.omlx]
name = "oMLX"
`,
    });

    const catalog = await readCodexModelCatalog({ HOME: home });
    const local = encodeCodexSelection("omlx", "gpt-5.4");

    expect(catalog.default).toBe(local);
    expect(catalog.options).toContainEqual({
      id: local,
      label: "gpt-5.4 (oMLX)",
      custom: true,
      providerRoute: { id: "local:omlx", label: "oMLX", provenance: "local" },
    });
    expect(decodeCodexSelection(catalog.default)).toEqual({
      model: "gpt-5.4",
      modelProvider: "omlx",
    });
  });

  it("keeps configured provider identity without exposing its endpoint or credential key", async () => {
    const home = scratchHome({
      "config.toml": `model_provider = "proxy_alpha"\nmodel = "Model-A"\n[model_providers.proxy_alpha]\nname = "Studio Proxy"\nbase_url = "https://secret.example.test/token/path"\nenv_key = "PRIVATE_STUDIO_KEY"\n`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home }, async () => { throw new Error("offline fixture"); });
    const option = catalog.options.find((row) => row.id === "proxy_alpha::Model-A");
    expect(option?.providerRoute).toMatchObject({ label: "Studio Proxy", provenance: "configured" });
    expect(option?.providerRoute?.id).toMatch(/^configured:[a-f0-9]{16}$/);
    expect(JSON.stringify(option)).not.toMatch(/secret\.example|PRIVATE_STUDIO_KEY/);
  });

  it("does not repeat a credential-bearing provider name in a model label", async () => {
    const home = scratchHome({
      "config.toml": `model_provider = "proxy_alpha"\nmodel = "Model-A"\n[model_providers.proxy_alpha]\nname = "https://secret.example.test/key=abc"\n`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home });
    const option = catalog.options.find((row) => row.id === "proxy_alpha::Model-A");
    expect(option?.providerRoute?.label).toBe("proxy_alpha");
    expect(option?.label).toBe("Model-A");
    expect(JSON.stringify(option)).not.toContain("secret.example");
  });

  it("keeps a reserved Codex provider name configured when its endpoint is remote", async () => {
    const home = scratchHome({
      "config.toml": `model_provider = "ollama"\nmodel = "Model-A"\n[model_providers.ollama]\nname = "Remote Gateway"\nbase_url = "https://remote.example.test/v1"\n`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home }, async () => { throw new Error("offline fixture"); });
    const option = catalog.options.find((row) => row.id === "ollama::Model-A");
    expect(option?.providerRoute).toMatchObject({ label: "Remote Gateway", provenance: "configured" });
    expect(option?.providerRoute?.id).toMatch(/^configured:[a-f0-9]{16}$/);
  });

  it("keeps a newly probed reserved-provider model on its configured remote Codex route", async () => {
    const home = scratchHome({
      "config.toml": `model_provider = "ollama"\nmodel = "Seed"\n[model_providers.ollama]\nname = "Remote Gateway"\nbase_url = "https://remote.example.test/v1"\n`,
    });
    const catalog = await readCodexModelCatalog(
      { HOME: home, VITEST: "true", OPENMAUSBOT_PROBE_LOCAL_INJECT: "1" },
      async (url) => String(url).includes("remote.example.test/v1/models")
        ? new Response(JSON.stringify({ data: [{ id: "Seed" }] }), { status: 200 })
        : String(url).includes(":11434/v1/models")
          ? new Response(JSON.stringify({ data: [{ id: "M" }] }), { status: 200 })
          : new Response("nope", { status: 500 }),
    );
    expect(catalog.options.find((row) => row.id === "ollama::M")?.providerRoute)
      .toEqual(catalog.options.find((row) => row.id === "ollama::Seed")?.providerRoute);
    expect(catalog.options.find((row) => row.id === "ollama::M")?.providerRoute)
      .toMatchObject({ label: "Remote Gateway", provenance: "configured" });
    expect(JSON.stringify(catalog)).not.toContain("remote.example.test");
  });

  it("honors CODEX_HOME over HOME and merges live /v1/models", async () => {
    const ignored = scratchHome({
      "config.toml": `model_provider = "omlx"\nmodel = "ignored"\n`,
    });
    const parent = mkdtempSync(join(tmpdir(), "omb-codex-home-"));
    scratchDirs.push(parent);
    const codexHome = join(parent, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      `
model_provider = "unsloth_api"
model = "unsloth/gemma-4-26B-A4B-it-GGUF"

[model_providers.unsloth_api]
name = "Unsloth Studio"
base_url = "http://127.0.0.1:8888/v1"
env_key = "UNSLOTH_STUDIO_AUTH_TOKEN"
`,
    );

    const catalog = await readCodexModelCatalog(
      { HOME: ignored, CODEX_HOME: codexHome, UNSLOTH_STUDIO_AUTH_TOKEN: "sk-test" },
      async (url, init) => {
        expect(String(url)).toBe("http://127.0.0.1:8888/v1/models");
        expect((init as RequestInit | undefined)?.headers).toMatchObject({ Authorization: "Bearer sk-test" });
        return new Response(JSON.stringify({ data: [{ id: "unsloth/extra-live" }, { id: "bad id" }] }), { status: 200 });
      },
    );

    expect(catalog.options.map((option) => option.id)).toContain(
      encodeCodexSelection("unsloth_api", "unsloth/gemma-4-26B-A4B-it-GGUF"),
    );
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("unsloth_api", "unsloth/extra-live"));
    expect(catalog.options.map((option) => option.id)).not.toContain(encodeCodexSelection("omlx", "ignored"));
  });

  it("refuses a relative CODEX_HOME instead of falling back to ~/.codex", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "leaked-default"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:9/v1"
`,
    });

    const catalog = await readCodexModelCatalog({ HOME: home, CODEX_HOME: "relative-codex" });

    expect(catalog.default).toBe(STATIC_CODEX_MODELS.default);
    expect(catalog.options.map((option) => option.id)).not.toContain(
      encodeCodexSelection("omlx", "leaked-default"),
    );
  });

  it("refuses a relative user home just like the identity lookup", async () => {
    // Windows cannot express a relative path across different drives.
    const home = scratchHome({
      "config.toml": 'model_provider = "omlx"\nmodel = "relative-home-model"\n[model_providers.omlx]\nname = "Fixture"\nbase_url = "http://127.0.0.1:9/v1"\n',
    }, process.cwd());
    const relativeHome = relative(process.cwd(), home);
    expect(isAbsolute(relativeHome)).toBe(false);
    const catalog = await readCodexModelCatalog({ HOME: relativeHome, USERPROFILE: relativeHome });
    expect(catalog.options.map((option) => option.id)).not.toContain(
      encodeCodexSelection("omlx", "relative-home-model"),
    );
  });

  it("ignores invalid slugs and a default that is not in the catalog", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "nope!"
model = "not installed"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home });
    expect(catalog.default).toBe("gpt-5.6-sol");
    expect(catalog.options.every((option) => !option.custom)).toBe(true);
  });
});

describe("CodexDriver catalog", () => {
  it("loads the config catalog when the instance is created", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({
      "config.toml": `
model_provider = "omlx"
model = "MiniMax-M3-4bit"

[model_providers.omlx]
name = "oMLX"
`,
    });
    const instance = await CodexDriver.create({
      instanceId: "codex-catalog",
      displayName: "Codex",
      environment: { HOME: home, USERPROFILE: home },
      enabled: true,
      config: { ...CodexDriver.defaultConfig(), cli: FAKE_CLI },
    });
    try {
      expect(instance.models.options.some((option) => option.id === "omlx::MiniMax-M3-4bit" && option.custom)).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});
