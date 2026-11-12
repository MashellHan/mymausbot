import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ChatGptPlanAuthController } from "./drivers/chatgpt-plan-auth.ts";
import { claudeAuthStatus } from "./drivers/claude-auth-status.ts";
import { LOGINS_FILE, LOGINS_KEY_FILE, MEMBER_SECRETS_FILE, VaultStore as LoginStore } from "./vault-store.ts";
import { McpOAuthStore } from "./mcp-oauth-store.ts";
import { SecretVault } from "./secret-vault.ts";
import { appLoginKeychainForbidden, appSessionCredentials } from "./app-session-credentials.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-session-store-"));
  roots.push(root);
  vi.stubEnv("OMB_DESKTOP_PARENT", "1");
  vi.stubEnv("OMB_CREDENTIAL_MODE", "session");
  return root;
}

it("private file mode keeps server persistence available while refusing implicit Claude CLI auth probes", async () => {
  const root = fixture();
  vi.stubEnv("OMB_CREDENTIAL_MODE", "private-file");
  expect(appSessionCredentials()).toBe(false);
  expect(appLoginKeychainForbidden()).toBe(true);
  const run = vi.fn();
  const providerEnv = { ...process.env, OMB_DESKTOP_PARENT: "0", OMB_CREDENTIAL_MODE: "system" };
  expect(appLoginKeychainForbidden(providerEnv)).toBe(true);
  expect(await claudeAuthStatus("claude", providerEnv, run as never)).toEqual({});
  expect(run).not.toHaveBeenCalled();
  expect(appLoginKeychainForbidden({ OMB_DESKTOP_PARENT: "1", OMB_CREDENTIAL_MODE: "system" })).toBe(true);
  const oauth = new McpOAuthStore(join(root, "mcp-oauth.json"));
  oauth.put("docs", { url: "https://example.test/mcp", state: "signed-in", tokens: { access: "synthetic-private" } });
  expect(new McpOAuthStore(join(root, "mcp-oauth.json")).get("docs", "https://example.test/mcp")?.tokens?.access).toBe("synthetic-private");
  const logins = new LoginStore({ dataDir: root });
  logins.create({ site: "example.test", hosts: ["example.test"], exactHost: false,
    username: "synthetic", password: "synthetic-private", source: "settings", bots: "all" });
  expect(new LoginStore({ dataDir: root }).list()).toHaveLength(1);
  vi.stubEnv("OMB_DESKTOP_PARENT", "0");
  vi.stubEnv("OMB_CREDENTIAL_MODE", "system");
  expect(appLoginKeychainForbidden({ OMB_DESKTOP_PARENT: "1", OMB_CREDENTIAL_MODE: "private-file" })).toBe(true);
});

it("keeps pre-existing MCP OAuth and saved-login files untouched and refuses persistence-only saves", () => {
  const root = fixture();
  const oauthFile = join(root, "mcp-oauth.json");
  const loginFile = join(root, LOGINS_FILE);
  const keyFile = join(root, LOGINS_KEY_FILE);
  const memberFile = join(root, MEMBER_SECRETS_FILE);
  const oldOauth = Buffer.from(JSON.stringify({ servers: { docs: { url: "https://example.test/mcp", state: "signed-in", tokens: { access: "old-synthetic" } } } }));
  const oldLogins = Buffer.from("old synthetic encrypted login bytes");
  const oldKey = Buffer.from("ab".repeat(32));
  const oldMembers = Buffer.from("old synthetic member secret bytes");
  writeFileSync(memberFile, oldMembers);
  writeFileSync(oauthFile, oldOauth); writeFileSync(loginFile, oldLogins); writeFileSync(keyFile, oldKey);
  const oauth = new McpOAuthStore(oauthFile);
  expect(oauth.get("docs", "https://example.test/mcp")).toBeUndefined();
  expect(() => oauth.put("docs", { url: "https://example.test/mcp", state: "signed-in", tokens: { access: "new-synthetic" } })).toThrow("session-only credential mode");
  const logins = new LoginStore({ dataDir: root });
  expect(logins.list()).toEqual([]);
  expect(() => logins.create({ site: "example.test", hosts: ["example.test"], exactHost: false,
    username: "synthetic", password: "new-synthetic", source: "settings", bots: "all" })).toThrow("session-only credential mode");
  expect(() => logins.setOnePasswordToken("new-synthetic")).toThrow("session-only credential mode");
  expect(logins.listSecrets({ person: "fixture@example.test", team: true })).toEqual([]);
  expect(() => logins.saveSecret({ name: "Fixture key", value: "new-synthetic", source: "settings", bots: "all",
    person: "fixture@example.test" })).toThrow("session-only credential mode");
  expect(readFileSync(oauthFile)).toEqual(oldOauth);
  expect(readFileSync(loginFile)).toEqual(oldLogins);
  expect(readFileSync(keyFile)).toEqual(oldKey);
  expect(readFileSync(memberFile)).toEqual(oldMembers);
});

it("refuses persistent secret files while one-use memory refs remain available", () => {
  const root = fixture();
  const vault = new SecretVault();
  expect(vault.saveRef({ botId: "bot", threadId: "thread" }, "card", "API key", "synthetic-secret")).toMatch(/^secret-ref:/);
  expect(() => vault.saveFile({ botId: "bot", threadId: "thread" }, "card-2", "synthetic-secret", { host: join(root, "private"), shown: "/private" })).toThrow("session-only credential mode");
  expect(existsSync(join(root, "private"))).toBe(false);
});

it("does not read or replace old App-owned ChatGPT plan credentials", async () => {
  const root = fixture();
  const directory = join(root, "plan");
  const file = join(directory, "credentials.json");
  const old = Buffer.from("old synthetic credential record");
  mkdirSync(directory);
  writeFileSync(file, old);
  const auth = new ChatGptPlanAuthController({ directory });
  expect(await auth.snapshot()).toMatchObject({ authenticated: false });
  await expect(auth.start()).rejects.toThrow("session-only credential mode");
  await expect(auth.accessToken()).rejects.toThrow("session-only credential mode");
  await auth.signOut();
  expect(readFileSync(file)).toEqual(old);
});

it("does not run an automatic Claude auth-status CLI probe in session mode", async () => {
  fixture();
  const run = vi.fn();
  expect(await claudeAuthStatus("claude", { OMB_DESKTOP_PARENT: "1", OMB_CREDENTIAL_MODE: "session" }, run as never)).toEqual({});
  expect(run).not.toHaveBeenCalled();
});
