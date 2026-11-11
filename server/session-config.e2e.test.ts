import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const configModule = new URL("./config.ts", import.meta.url).href;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omb-session-config-"));
  roots.push(root);
  const old = { openai: { key: "old-persistent-key", url: "https://old.example.test" },
    instances: { old: { driver: "customAcp", environment: { TOKEN: "old-instance-key" } } },
    mcpServers: { old: { env: { TOKEN: "old-mcp-key" } } } };
  writeFileSync(join(root, "config.json"), JSON.stringify(old), { mode: 0o600 });
  return { root, old };
}

function run(root: string, script: string, mode = "session", overlay?: object): any {
  const env = { HOME: root, USERPROFILE: root, OMB_DATA_DIR: root, OMB_DESKTOP_PARENT: "1", OMB_CREDENTIAL_MODE: mode,
    PATH: process.env.PATH ?? "", ...(overlay ? { OMB_SESSION_CONFIG_JSON: JSON.stringify(overlay) } : {}) };
  return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
    { cwd: root, env, encoding: "utf8", timeout: 15_000 }).trim());
}

describe("embedded server session config across App-run restarts", () => {
  it("keeps newly entered provider, instance and MCP secrets off disk while the App passes them to a restarted server", () => {
    const { root, old } = fixture();
    const first = run(root, `import { saveConfig, loadConfig, setSessionConfigPublisher } from ${JSON.stringify(configModule)};
      let snapshot = null;
      setSessionConfigPublisher((value) => { snapshot = value; });
      saveConfig({ openai: { key: "new-openai-key", url: "https://new.example.test" }, anthropic: { key: "new-anthropic-key" },
        openrouter: { key: "new-router-key" }, mistral: { key: "new-mistral-key" },
        composio: { userId: "new-session-user", sessionId: "new-login-grant" },
        instances: { custom: { driver: "customAcp", environment: { API_KEY: "new-instance-key" } } },
        mcpServers: { custom: { env: { API_KEY: "new-mcp-key" } } }, profile: { name: "Session fixture" } });
      console.log(JSON.stringify({ snapshot, runtime: loadConfig() }));`);
    const disk = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
    expect(disk.openai).toEqual(old.openai);
    expect(disk.profile.name).toBe("Session fixture");
    expect(disk.instances).toEqual(old.instances);
    expect(disk.mcpServers).toEqual(old.mcpServers);
    expect(readFileSync(join(root, "config.json"), "utf8")).not.toMatch(/new-openai-key|new-anthropic-key|new-router-key|new-mistral-key|new-login-grant|new-instance-key|new-mcp-key/);
    expect(first.runtime.openai.key).toBe("new-openai-key");
    expect(first.runtime.composio.sessionId).toBe("new-login-grant");
    writeFileSync(join(root, "config.json"), JSON.stringify({ ...disk, profile: { name: "Updated between utility servers" } }));
    const recovered = run(root, `import { loadConfig } from ${JSON.stringify(configModule)};
      console.log(JSON.stringify({ runtime: loadConfig(), seedAfterImport: process.env.OMB_SESSION_CONFIG_JSON ?? null }));`, "session", first.snapshot);
    expect(recovered.runtime.openai.key).toBe("new-openai-key");
    expect(recovered.runtime.profile.name).toBe("Updated between utility servers");
    expect(recovered.runtime.instances.custom.environment.API_KEY).toBe("new-instance-key");
    expect(recovered.runtime.mcpServers.custom.env.API_KEY).toBe("new-mcp-key");
    expect(recovered.seedAfterImport).toBeNull();
    const newAppRun = run(root, `import { loadConfig } from ${JSON.stringify(configModule)}; console.log(JSON.stringify(loadConfig()));`);
    expect(newAppRun.openai.key).toBe(old.openai.key);
    expect(newAppRun.anthropic.key).toBeUndefined();
  });

  it.each([undefined, "old-modelgo-key"])("keeps a ModelGo session key off disk with previous key %s", (diskKey) => {
    const { root, old } = fixture();
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ ...old, ...(diskKey ? { modelgo: { key: diskKey } } : {}) }));
    const result = run(root, `import { saveConfig, loadConfig, confirmSessionConfig, setSessionConfigPublisher } from ${JSON.stringify(configModule)};
      let snapshot = null;
      setSessionConfigPublisher((value) => { snapshot = value; });
      saveConfig({ modelgo: { key: "synthetic-modelgo-session-key" } });
      await confirmSessionConfig();
      saveConfig({ profile: { name: "Session fixture" } });
      await confirmSessionConfig();
      console.log(JSON.stringify({ snapshot, runtime: loadConfig() }));`);
    expect(JSON.parse(readFileSync(file, "utf8")).modelgo?.key).toBe(diskKey);
    expect(readFileSync(file, "utf8")).not.toContain("synthetic-modelgo-session-key");
    expect(result.runtime.modelgo.key).toBe("synthetic-modelgo-session-key");
    expect(result.snapshot.modelgo.key).toBe("synthetic-modelgo-session-key");
    const restarted = run(root, `import { loadConfig } from ${JSON.stringify(configModule)};
      console.log(JSON.stringify(loadConfig()));`, "session", result.snapshot);
    expect(restarted.modelgo.key).toBe("synthetic-modelgo-session-key");
    const newAppRun = run(root, `import { loadConfig } from ${JSON.stringify(configModule)};
      console.log(JSON.stringify(loadConfig()));`);
    expect(newAppRun.modelgo?.key).toBe(diskKey);
  });

  it.each([undefined, "old-modelgo-key"])("refuses a ModelGo session save before changing disk key %s when its publisher is absent", (diskKey) => {
    const { root, old } = fixture();
    const file = join(root, "config.json");
    writeFileSync(file, JSON.stringify({ ...old, ...(diskKey ? { modelgo: { key: diskKey } } : {}) }));
    const before = readFileSync(file);
    const result = run(root, `import { saveConfig } from ${JSON.stringify(configModule)};
      let error = null;
      try { saveConfig({ modelgo: { key: "synthetic-modelgo-refused-key" }, profile: { name: "Refused" } }); }
      catch (cause) { error = cause.message; }
      console.log(JSON.stringify({ error }));`);
    expect(result.error).toBe("The desktop session credential owner is unavailable");
    expect(readFileSync(file)).toEqual(before);
  });

  it("keeps the existing secure-mode disk behavior", () => {
    const { root } = fixture();
    run(root, `import { saveConfig } from ${JSON.stringify(configModule)}; saveConfig({ openai: { key: "system-mode-key" } }); console.log(JSON.stringify({ ok: true }));`, "system");
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).openai.key).toBe("system-mode-key");
  });

  it("clears a session key in memory without deleting the older persistent copy", () => {
    const { root, old } = fixture();
    const result = run(root, `import { saveConfig, loadConfig, confirmSessionConfig, setSessionConfigPublisher } from ${JSON.stringify(configModule)};
      let snapshot = null;
      setSessionConfigPublisher((value) => { snapshot = value; });
      saveConfig({ openai: { key: "new-session-key" } });
      await confirmSessionConfig();
      saveConfig({ openai: { key: "" } });
      await confirmSessionConfig();
      console.log(JSON.stringify({ snapshot, runtime: loadConfig() }));`);
    expect(result.runtime.openai.key).toBe("");
    expect(result.snapshot.openai.key).toBe("");
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).openai.key).toBe(old.openai.key);
  });

  it("keeps the previous App-run key and disk bytes after a parent refusal", () => {
    const { root, old } = fixture();
    const result = run(root, `import { saveConfig, loadConfig, confirmSessionConfig, setSessionConfigPublisher } from ${JSON.stringify(configModule)};
      setSessionConfigPublisher((value) => value.openai?.key === "rejected-session-key"
        ? Promise.reject(new Error("parent refused")) : Promise.resolve());
      saveConfig({ openai: { key: "accepted-session-key" } });
      await confirmSessionConfig();
      saveConfig({ openai: { key: "rejected-session-key" } });
      let failed = false;
      try { await confirmSessionConfig(); } catch { failed = true; }
      console.log(JSON.stringify({ failed, runtime: loadConfig() }));`);
    expect(result.failed).toBe(true);
    expect(result.runtime.openai.key).toBe("accepted-session-key");
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).openai.key).toBe(old.openai.key);
  });

  it("refuses an overlapping MCP/config save without adopting an unconfirmed key", () => {
    const { root, old } = fixture();
    const result = run(root, `import { saveConfig, loadConfig, confirmSessionConfig, setSessionConfigPublisher } from ${JSON.stringify(configModule)};
      let rejectFirst;
      const snapshots = [];
      setSessionConfigPublisher((value) => {
        snapshots.push(value);
        return snapshots.length === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve();
      });
      saveConfig({ openai: { key: "unconfirmed-session-key" } });
      const first = confirmSessionConfig();
      let overlappingStatus = null;
      try { saveConfig({ mcpServers: { notes: { headers: { Authorization: "Bearer other-session-secret" } } } }); }
      catch (error) { overlappingStatus = error.status; }
      rejectFirst(new Error("parent refused"));
      await first.catch(() => {});
      saveConfig({ mcpServers: { notes: { headers: { Authorization: "Bearer accepted-session-secret" } } } });
      await confirmSessionConfig();
      console.log(JSON.stringify({ overlappingStatus, snapshots, runtime: loadConfig() }));`);
    expect(result.overlappingStatus).toBe(409);
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[1].openai.key).toBe(old.openai.key);
    expect(result.runtime.openai.key).toBe(old.openai.key);
    expect(result.runtime.mcpServers.notes.headers.Authorization).toBe("Bearer accepted-session-secret");
    expect(readFileSync(join(root, "config.json"), "utf8")).not.toContain("accepted-session-secret");
  });
});
