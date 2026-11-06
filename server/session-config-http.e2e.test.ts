import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { launchRestartableServer } from "./testing/restartable-server.ts";

const OWNER = "A".repeat(43);
afterEach(() => vi.unstubAllEnvs());

it("keeps direct and desktop-external provider secrets in this App run through an isolated server restart", async () => {
  vi.stubEnv("OMB_TEST_DESKTOP_OWNER_TOKEN", OWNER);
  vi.stubEnv("OMB_TEST_SESSION_CREDENTIALS", "1");
  const fixture = await launchRestartableServer();
  const configFile = join(fixture.dataDir, "config.json");
  const captured = join(fixture.dataDir, "session-config-captured.json");
  const put = async (path: string, body: unknown) => {
    const response = await fetch(fixture.url + path, { method: "PUT", headers: {
      "content-type": "application/json", origin: fixture.url, "x-openmausbot-desktop-owner": OWNER,
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const status = async () => (await (await fetch(fixture.url + "/api/config", { signal: AbortSignal.timeout(5_000) })).json()) as Record<string, any>;
  try {
    const openai = "sk-proj-synthetic-session-0123456789";
    const xai = "xai-synthetic-session-0123456789";
    expect(await put("/api/config", { openai: { key: openai } })).toMatchObject({ status: 200, body: { openai: { configured: true } } });
    expect(readFileSync(configFile, "utf8")).not.toContain(openai);
    expect(JSON.parse(readFileSync(captured, "utf8")).openai.key).toBe(openai);
    await fixture.stop(); await fixture.start();
    expect((await status()).openai.configured).toBe(true);
    expect(readFileSync(configFile, "utf8")).not.toContain(openai);

    expect(await put("/api/config?secretStorage=external", { xai: { key: xai } })).toMatchObject({ status: 200, body: { xai: { configured: true } } });
    expect(readFileSync(configFile, "utf8")).not.toContain(xai);
    expect(JSON.parse(readFileSync(captured, "utf8")).xai.key).toBe(xai);
    await fixture.stop(); await fixture.start();
    expect((await status()).xai.configured).toBe(true);
    expect(await put("/api/config", { openai: { key: "" } })).toMatchObject({ status: 200, body: { openai: { configured: false } } });
    expect(readFileSync(configFile, "utf8")).not.toContain(openai);
    expect(JSON.parse(readFileSync(captured, "utf8")).openai.key).toBe("");
    const mcpSecret = "Bearer synthetic-session-mcp-key";
    const mcpResponse = await fetch(fixture.url + "/api/mcp/servers", { method: "POST", headers: {
      "content-type": "application/json", origin: fixture.url, "x-openmausbot-desktop-owner": OWNER,
    }, body: JSON.stringify({ name: "session_notes", type: "http", url: "https://example.test/mcp",
      headers: { Authorization: mcpSecret }, enabled: false }), signal: AbortSignal.timeout(15_000) });
    expect(mcpResponse.status).toBe(201);
    expect(readFileSync(configFile, "utf8")).not.toContain(mcpSecret);
    expect(JSON.parse(readFileSync(captured, "utf8")).mcpServers.session_notes.headers.Authorization).toBe(mcpSecret);
    await fixture.stop(); await fixture.start();
    expect((await (await fetch(fixture.url + "/api/mcp/servers")).json() as any).servers.some((row: any) => row.name === "session_notes")).toBe(true);
    expect((await fetch(fixture.url + "/api/config", { headers: { "x-forwarded-for": "203.0.113.8" } })).status).toBe(403);
  } finally { await fixture.close(); }
}, 120_000);

it.each(["deny", "drop", "drop-commit"])("does not commit a session key when the App parent %s its receipt", async (reply) => {
  vi.stubEnv("OMB_TEST_DESKTOP_OWNER_TOKEN", OWNER);
  vi.stubEnv("OMB_TEST_SESSION_CREDENTIALS", "1");
  vi.stubEnv("OMB_TEST_SESSION_CONFIG_REPLY", reply);
  const fixture = await launchRestartableServer();
  const file = join(fixture.dataDir, "config.json");
  const before = readFileSync(file);
  try {
    const response = await fetch(fixture.url + "/api/config", { method: "PUT", headers: {
      "content-type": "application/json", origin: fixture.url, "x-openmausbot-desktop-owner": OWNER,
    }, body: JSON.stringify({ openai: { key: "sk-synthetic-unconfirmed" } }), signal: AbortSignal.timeout(15_000) });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(readFileSync(file)).toEqual(before);
    expect(readFileSync(file, "utf8")).not.toContain("sk-synthetic-unconfirmed");
    expect(existsSync(join(fixture.dataDir, "session-config-captured.json"))).toBe(false);
    expect((await (await fetch(fixture.url + "/api/config")).json() as any).openai.configured).toBe(false);
    if (reply === "deny") {
      const mcp = await fetch(fixture.url + "/api/mcp/servers", { method: "POST", headers: {
        "content-type": "application/json", origin: fixture.url, "x-openmausbot-desktop-owner": OWNER,
      }, body: JSON.stringify({ name: "denied_notes", type: "http", url: "https://example.test/mcp",
        headers: { Authorization: "Bearer synthetic-denied" }, enabled: false }), signal: AbortSignal.timeout(15_000) });
      expect(mcp.status).toBeGreaterThanOrEqual(500);
      expect(readFileSync(file)).toEqual(before);
      expect((await (await fetch(fixture.url + "/api/mcp/servers")).json() as any).servers.some((row: any) => row.name === "denied_notes")).toBe(false);
    }
  } finally { await fixture.close(); }
}, 120_000);
