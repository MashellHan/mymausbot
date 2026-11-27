import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("reads a Fast row as its base model on the Fast tier", () => {
    expect(decodeCodexSelection("gpt-5.6-sol+priority")).toEqual({
      model: "gpt-5.6-sol",
      modelProvider: OFFICIAL_CODEX_PROVIDER,
      serviceTier: "priority",
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

  it("adds a Fast row after each model that offers Fast and does not already run on it", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const catalog = await readCodexModelCatalog(
      { HOME: join(tmpdir(), "omb-codex-app-server-tiers"), PATH: process.env.PATH, FAKE_CODEX_TIERS: "1", FAKE_CODEX_EFFORTS: "1" },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual({
      default: "gpt-fake-default",
      options: [
        { id: "gpt-fake-default", label: "GPT Fake Default", effortLevels: ["low", "high"] },
        { id: "gpt-fake-default+priority", label: "GPT Fake Default · Fast", effortLevels: ["low", "high"] },
        { id: "gpt-page-two", label: "GPT Page Two", effortLevels: [] },
      ],
    });
  });

  it("reads the app-server catalog again when the first listing fails", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const attempts = join(home, "catalog-attempts");
    const catalog = await readCodexModelCatalog(
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_CATALOG_FAILURES: "1", FAKE_CODEX_STATE: attempts },
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
    expect(readFileSync(attempts, "utf8")).toBe("2");
  });

  it("falls back to the static catalog when the second listing also fails", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const home = scratchHome({});
    const attempts = join(home, "catalog-attempts");
    const catalog = await readCodexModelCatalog(
      { HOME: home, PATH: process.env.PATH, FAKE_CODEX_CATALOG_FAILURES: "2", FAKE_CODEX_STATE: attempts },
      fetch,
      FAKE_CLI,
    );

    expect(catalog).toEqual(STATIC_CODEX_MODELS);
    expect(readFileSync(attempts, "utf8")).toBe("2");
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

  it("uses configured and live capability metadata for the exact provider model", async () => {
    const home = scratchHome({
      "config.toml": `model_provider = "raven"\nmodel = "native"\n[model_providers.raven]\nbase_url = "http://127.0.0.1:7024/v1"\n`,
      "model-catalogs/raven-models.json": JSON.stringify({ models: [
        { slug: "native", display_name: "Native Model", supported_reasoning_efforts: [{ reasoning_effort: "high" }] },
        { slug: "offline", reasoning: false },
      ] }),
    });
    const catalog = await readCodexModelCatalog({ HOME: home }, async () => new Response(JSON.stringify({ data: [
      { id: "native", supported_reasoning_levels: [{ effort: "medium" }] },
      { id: "gemini", supported_endpoints: ["/chat/completions"], reasoning_levels: ["high"] },
      { id: "legacy" },
    ] }), { status: 200 }));
    const model = (id: string) => catalog.options.find((row) => row.id === id);
    expect(model("raven::native")).toMatchObject({ label: "Native Model", effortLevels: ["medium"] });
    expect(model("raven::native")).not.toHaveProperty("protocolUnsupported");
    expect(model("raven::gemini")).toMatchObject({ effortLevels: ["high"] });
    expect(model("raven::gemini")).not.toHaveProperty("protocolUnsupported");
    expect(model("raven::offline")).toMatchObject({ effortLevels: [] });
    expect(model("raven::legacy")).not.toHaveProperty("effortLevels");
    expect(model("raven::legacy")).not.toHaveProperty("protocolUnsupported");
  });

  it("marks responses-incompatible and non-chat models unsupported and extracts context windows and effort levels", async () => {
    const externalDir = mkdtempSync(join(tmpdir(), "omb-codex-catalog-json-"));
    scratchDirs.push(externalDir);
    const catalogJson = join(externalDir, "raven-models.json");
    writeFileSync(catalogJson, JSON.stringify({
      models: [
        { slug: "gpt-5.4", context_window: 128_000, supported_reasoning_levels: ["low"] },
        { slug: "cached-only", context_window: 64_000.9, capabilities: { supports: { tool_calls: true } } },
      ],
    }));
    const home = scratchHome({
      "config.toml": `
model_provider = "raven"
model = "gpt-5.4"
model_catalog_json = ${JSON.stringify(catalogJson)}

[model_providers.raven]
name = "Raven"
base_url = "http://127.0.0.1:7024/v1"
wire_api = "responses"
`,
    });
    const catalog = await readCodexModelCatalog({ HOME: home }, async () => new Response(JSON.stringify({
      data: [
        {
          id: "gpt-5.4",
          supported_endpoints: ["/chat/completions", "/responses"],
          capabilities: {
            type: "chat",
            limits: { max_context_window_tokens: 272_000 },
            supports: { reasoning_effort: ["low", "medium", "high"] },
          },
        },
        {
          id: "gemini-4-neon",
          supported_endpoints: ["/chat/completions"],
          context_window: 1_000_000,
          reasoning_levels: ["low", "high"],
        },
        {
          id: "gpt-4.1",
          supported_endpoints: ["/responses"],
          capabilities: {
            type: "chat",
            limits: { max_context_window_tokens: 128_000 },
            supports: { tool_calls: true },
          },
        },
        {
          id: "gpt-image-1",
          supported_endpoints: ["/responses"],
          capabilities: { type: "image" },
        },
        {
          id: "text-embedding-3",
          capabilities: { type: "embeddings" },
        },
      ],
    }), { status: 200 }));

    const model = (id: string) => catalog.options.find((row) => row.id === id);
    expect(model("raven::gpt-5.4")).toMatchObject({
      contextWindow: 272_000,
      effortLevels: ["low", "medium", "high"],
    });
    expect(model("raven::gpt-5.4")).not.toHaveProperty("protocolUnsupported");
    expect(model("raven::gemini-4-neon")).toMatchObject({
      contextWindow: 1_000_000,
      effortLevels: ["low", "high"],
      protocolUnsupported: true,
    });
    expect(model("raven::gpt-4.1")).toMatchObject({
      contextWindow: 128_000,
      effortLevels: [],
    });
    expect(model("raven::gpt-4.1")).not.toHaveProperty("protocolUnsupported");
    expect(model("raven::gpt-image-1")).toMatchObject({ protocolUnsupported: true });
    expect(model("raven::text-embedding-3")).toMatchObject({ protocolUnsupported: true });
    expect(model("raven::cached-only")).toMatchObject({
      contextWindow: 64_000,
      effortLevels: [],
    });
  });

  it("runs provider auth command for loopback base_url and refuses it for non-loopback base_url", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "omb-codex-auth-marker-"));
    scratchDirs.push(markerDir);
    const remoteMarker = join(markerDir, "remote-ran");
    const home = scratchHome({
      "config.toml": `
model_provider = "local_gw"
model = "m-local"

[model_providers.local_gw]
name = "Local Gateway"
base_url = "http://127.0.0.1:7474/v1"

[model_providers.local_gw.auth]
command = ${JSON.stringify(process.execPath)}
args = ["--eval", "process.stdout.write(\\"loopback-secret-tok\\\\n\\")"]
timeout_ms = 3000

[model_providers.remote_gw]
name = "Remote Gateway"
base_url = "https://remote.example.test/v1"

[model_providers.remote_gw.auth]
command = ${JSON.stringify(process.execPath)}
args = ["--eval", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(remoteMarker)}, "ran"); process.stdout.write("remote-secret-tok")`) }]
timeout_ms = 3000
`,
    });

    const seenHeaders = new Map<string, Record<string, string>>();
    const catalog = await readCodexModelCatalog({ HOME: home }, async (url, init) => {
      const target = String(url);
      seenHeaders.set(target, ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>);
      if (target.includes("127.0.0.1:7474")) {
        return new Response(JSON.stringify({ data: [{ id: "m-local" }, { id: "m-probed" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "m-remote" }] }), { status: 200 });
    });

    expect(seenHeaders.get("http://127.0.0.1:7474/v1/models")).toMatchObject({
      Authorization: "Bearer loopback-secret-tok",
    });
    expect(seenHeaders.get("https://remote.example.test/v1/models")).not.toHaveProperty("Authorization");
    expect(existsSync(remoteMarker)).toBe(false);
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("local_gw", "m-probed"));
    expect(JSON.stringify(catalog)).not.toContain("loopback-secret-tok");
  });

  it("skips auth.command on malformed args, rejects userinfo loopback URLs, and sends redirect: manual", async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "omb-codex-bad-args-"));
    scratchDirs.push(markerDir);
    const badMarker = join(markerDir, "bad-ran");
    const markerScript = join(markerDir, "touch.js");
    writeFileSync(markerScript, `require("node:fs").writeFileSync(${JSON.stringify(badMarker)}, "ran");`);
    const home = scratchHome({
      "config.toml": `
model_provider = "bad_trailing"
model = "m-seed"

[model_providers.bad_trailing]
base_url = "http://127.0.0.1:7481/v1"

[model_providers.bad_trailing.auth]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(markerScript)}] trailing_garbage

[model_providers.bad_multiline]
base_url = "http://127.0.0.1:7482/v1"

[model_providers.bad_multiline.auth]
command = ${JSON.stringify(process.execPath)}
args = [
  ${JSON.stringify(markerScript)}
  "--missing-comma"
]

[model_providers.bad_unclosed_section]
base_url = "http://127.0.0.1:7483/v1"

[model_providers.bad_unclosed_section.auth]
command = ${JSON.stringify(process.execPath)}
args = [
  ${JSON.stringify(markerScript)},

[model_providers.userinfo_loopback]
base_url = "http://user:pass@127.0.0.1:7484/v1"

[model_providers.userinfo_loopback.auth]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(markerScript)}]

[model_providers.bad_unclosed_eof]
base_url = "http://127.0.0.1:7485/v1"

[model_providers.bad_unclosed_eof.auth]
command = ${JSON.stringify(process.execPath)}
args = [
  ${JSON.stringify(markerScript)},
`,
    });

    const seenInits = new Map<string, RequestInit | undefined>();
    const catalog = await readCodexModelCatalog({ HOME: home }, async (url, init) => {
      seenInits.set(String(url), init);
      return new Response(JSON.stringify({ data: [{ id: "m-ok" }] }), { status: 200 });
    });

    expect(existsSync(badMarker)).toBe(false);
    expect(seenInits.size).toBe(5);
    for (const init of seenInits.values()) {
      expect(init?.redirect).toBe("manual");
      expect(init?.headers).not.toHaveProperty("Authorization");
    }
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("bad_unclosed_eof", "m-ok"));
  });

  it("handles NUL bytes in auth command or args and control chars in tokens without crashing", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "nul_cmd"
model = "m-seed"

[model_providers.nul_cmd]
base_url = "http://127.0.0.1:7491/v1"

[model_providers.nul_cmd.auth]
command = "/bin/echo\\u0000bad"
args = ["ok"]

[model_providers.nul_arg]
base_url = "http://127.0.0.1:7492/v1"

[model_providers.nul_arg.auth]
command = ${JSON.stringify(process.execPath)}
args = ["--eval", "bad\\u0000arg"]

[model_providers.ctrl_tok]
base_url = "http://127.0.0.1:7493/v1"

[model_providers.ctrl_tok.auth]
command = ${JSON.stringify(process.execPath)}
args = ["--eval", "process.stdout.write(\\"tok\\x07bad\\")"]
`,
    });

    const seenHeaders = new Map<string, Record<string, string>>();
    const catalog = await readCodexModelCatalog({ HOME: home }, async (url, init) => {
      seenHeaders.set(String(url), ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ data: [{ id: "m-live" }] }), { status: 200 });
    });

    expect(seenHeaders.get("http://127.0.0.1:7491/v1/models")).not.toHaveProperty("Authorization");
    expect(seenHeaders.get("http://127.0.0.1:7492/v1/models")).not.toHaveProperty("Authorization");
    expect(seenHeaders.get("http://127.0.0.1:7493/v1/models")).not.toHaveProperty("Authorization");
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("nul_cmd", "m-live"));
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("nul_arg", "m-live"));
    expect(catalog.options.map((option) => option.id)).toContain(encodeCodexSelection("ctrl_tok", "m-live"));
  });

  it("clears stale static protocolUnsupported when a live probe confirms chat and /responses", async () => {
    const home = scratchHome({
      "config.toml": `
model_provider = "raven"
model = "upgraded-chat"

[model_providers.raven]
name = "Raven"
base_url = "http://127.0.0.1:7024/v1"
wire_api = "responses"
`,
      "model-catalogs/raven-models.json": JSON.stringify({
        models: [
          {
            slug: "upgraded-chat",
            supported_endpoints: ["/chat/completions"],
            capabilities: { type: "image" },
            context_window: 1e20,
          },
          {
            slug: "still-image",
            capabilities: { type: "image" },
          },
        ],
      }),
    });

    const catalog = await readCodexModelCatalog({ HOME: home }, async () => new Response(JSON.stringify({
      data: [
        {
          id: "upgraded-chat",
          supported_endpoints: ["/chat/completions", "/responses"],
          capabilities: { type: "chat", limits: { max_context_window_tokens: 200_000 } },
        },
        {
          id: "still-image",
        },
      ],
    }), { status: 200 }));

    const upgraded = catalog.options.find((row) => row.id === "raven::upgraded-chat");
    const stillImage = catalog.options.find((row) => row.id === "raven::still-image");
    expect(upgraded).toMatchObject({ contextWindow: 200_000 });
    expect(upgraded).not.toHaveProperty("protocolUnsupported");
    expect(stillImage).toMatchObject({ protocolUnsupported: true });
    expect(stillImage).not.toHaveProperty("contextWindow");
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
