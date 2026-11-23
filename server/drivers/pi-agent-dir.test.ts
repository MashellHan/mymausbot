import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { botBox } from "../bot-box/box.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { ensurePiInjectModel } from "./pi.ts";
import { assertPiAuthReachableInBox, ownPiAgentDir, piAgentDir, readPiDefaultModel } from "./pi-agent-dir.ts";
import { encodeInjectId } from "./local-inject.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync), symlinkSync: vi.fn(actual.symlinkSync) };
});

const same = (a: string, b: string) => {
  const [x, y] = [statSync(a, { bigint: true }), statSync(b, { bigint: true })];
  return x.ino === y.ino && x.dev === y.dev;
};

describe("MausBot's own Pi agent folder", () => {
  let root: string, home: string, dataDir: string, person: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-pi-agent-dir-"));
    home = join(root, "home");
    dataDir = join(home, ".openmausbot");
    person = join(home, ".pi", "agent");
    mkdirSync(join(person, "extensions"), { recursive: true });
    mkdirSync(join(person, "bin"), { recursive: true });
    writeFileSync(join(person, "AGENTS.md"), "My own instructions\n");
    writeFileSync(join(person, "APPEND_SYSTEM.md"), "Always do it my way\n");
    writeFileSync(join(person, "mcp.json"), '{"mcpServers":{}}');
    writeFileSync(join(person, "trust.json"), "{}");
    writeFileSync(join(person, "extensions", "edit.ts"), "export default () => {};\n");
    writeFileSync(join(person, "bin", "rg"), "");
    writeFileSync(join(person, "auth.json"), '{"anthropic":{"type":"oauth"}}');
    writeFileSync(join(person, "models.json"), '{"providers":{"mine":{"models":[]}}}');
    writeFileSync(join(person, "settings.json"), JSON.stringify({
      defaultProvider: "anthropic", defaultModel: "claude-x", transport: "sse", httpProxy: "http://127.0.0.1:8080",
      packages: ["npm:mine"], extensions: ["x"], skills: ["s"], prompts: ["p"],
    }));
  });
  afterEach(async () => { await removeTempDir(root); });

  const env = () => ({ HOME: home });

  it("carries the login, providers and model settings over, and none of the person's instructions, extensions or MCP servers", () => {
    const own = ownPiAgentDir(env(), "pi-1", dataDir);
    expect(own.startsWith(join(dataDir, "providers", "pi-own"))).toBe(true);
    expect(readdirSync(own).filter((name) => !name.startsWith(".")).sort()).toEqual(["auth.json", "bin", "models.json", "settings.json"]);
    expect(realpathSync(join(own, "auth.json"))).toBe(realpathSync(join(person, "auth.json")));
    expect(same(join(own, "bin"), join(person, "bin"))).toBe(true);
    expect(lstatSync(join(own, "models.json")).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(own, "settings.json"), "utf8"))).toEqual({
      defaultProvider: "anthropic", defaultModel: "claude-x", transport: "sse", httpProxy: "http://127.0.0.1:8080",
    });
    expect(readPiDefaultModel({ ...env(), PI_CODING_AGENT_DIR: own })).toBe("anthropic/claude-x");
    expect(ownPiAgentDir(env(), "pi-2", dataDir)).not.toBe(own);
  });

  it("uses a prepared directory even when the profile points to the data root", () => {
    const own = ownPiAgentDir({ ...env(), PI_CODING_AGENT_DIR: dataDir }, "pi-1", dataDir);
    expect(own.startsWith(join(dataDir, "providers", "pi-own"))).toBe(true);
    expect(own).not.toBe(dataDir);
  });

  it("copies from a Pi agent folder the person named themselves", () => {
    const profile = { ...env(), PI_CODING_AGENT_DIR: "~/pi-work" };
    const named = piAgentDir(profile);
    expect(named).toBe(join(home, "pi-work"));
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, "auth.json"), "{}");
    writeFileSync(join(named, "AGENTS.md"), "Work instructions\n");
    const own = ownPiAgentDir(profile, "pi-1", dataDir);
    expect(same(join(own, "auth.json"), join(named, "auth.json"))).toBe(true);
    expect(existsSync(join(own, "AGENTS.md"))).toBe(false);
  });

  it("keeps MausBot's local models out of the person's models.json, and picks up the person's later changes", () => {
    const own = ownPiAgentDir(env(), "pi-1", dataDir);
    ensurePiInjectModel(encodeInjectId("omlx", "MiniMax-M3-4bit"), { ...env(), PI_CODING_AGENT_DIR: own });
    expect(readFileSync(join(person, "models.json"), "utf8")).toBe('{"providers":{"mine":{"models":[]}}}');
    expect(JSON.parse(readFileSync(join(own, "models.json"), "utf8")).providers.omlx).toBeDefined();
    // Unchanged on the person's side: the turn's own rows stay.
    ownPiAgentDir(env(), "pi-1", dataDir);
    expect(JSON.parse(readFileSync(join(own, "models.json"), "utf8")).providers.omlx).toBeDefined();
    writeFileSync(join(person, "models.json"), '{"providers":{"mine":{"models":[]},"theirs":{"models":[]}}}');
    ownPiAgentDir(env(), "pi-1", dataDir);
    expect(JSON.parse(readFileSync(join(own, "models.json"), "utf8")).providers.theirs).toBeDefined();
  });

  it("works with nothing to carry over, and links a login the person makes later", () => {
    rmSync(join(home, ".pi"), { recursive: true, force: true });
    const own = ownPiAgentDir(env(), "pi-1", dataDir);
    expect(readdirSync(own)).toEqual([]);
    // What Pi wrote for itself while the person had no login gives way to theirs.
    writeFileSync(join(own, "auth.json"), "{}");
    mkdirSync(person, { recursive: true });
    writeFileSync(join(person, "auth.json"), '{"openai":{"type":"api_key"}}');
    ownPiAgentDir(env(), "pi-1", dataDir);
    expect(same(join(own, "auth.json"), join(person, "auth.json"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("drops a link to a login the person removed, so Pi never writes through it", () => {
    const own = ownPiAgentDir(env(), "pi-1", dataDir);
    rmSync(join(person, "auth.json"));
    ownPiAgentDir(env(), "pi-1", dataDir);
    expect(() => lstatSync(join(own, "auth.json"))).toThrow();
    // A link MausBot did not make that points elsewhere is replaced too.
    writeFileSync(join(person, "auth.json"), "{}");
    symlinkSync(join(root, "elsewhere.json"), join(own, "auth.json"));
    ownPiAgentDir(env(), "pi-1", dataDir);
    expect(same(join(own, "auth.json"), join(person, "auth.json"))).toBe(true);
  });

  it("fails closed when the OS refuses an auth symlink", () => {
    const original = join(person, "auth.json");
    rmSync(original);
    const own = ownPiAgentDir(env(), "pi-1", dataDir);
    const auth = join(own, "auth.json");
    writeFileSync(original, "{}");
    vi.mocked(symlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("Fixture symlink denied"), { code: "EPERM" });
    });
    expect(() => ownPiAgentDir(env(), "pi-1", dataDir)).toThrow("Could not share the Pi sign-in through a symbolic link");
    expect(existsSync(auth)).toBe(false);
    expect(readFileSync(original, "utf8")).toBe("{}");
  });

  it("rejects a failed setup before giving a bot the person's agent folder", () => {
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "providers"), "");
    expect(() => ownPiAgentDir(env(), "pi-1", dataDir)).toThrow("Could not prepare the isolated Pi agent directory");
  });

  it.skipIf(process.platform === "win32").each(["models.json", ".models.json.from"])("rejects a linked %s with no source model file", (name) => {
    rmSync(join(person, "models.json"));
    const own = ownPiAgentDir(env(), "pi-1", dataDir);
    const privateFile = join(root, "private.json");
    writeFileSync(privateFile, '{"keep":"private"}');
    symlinkSync(privateFile, join(own, name));
    expect(() => ownPiAgentDir(env(), "pi-1", dataDir)).toThrow("Pi agent configuration must be a regular, unlinked file");
    if (name === "models.json") {
      expect(() => ensurePiInjectModel("omlx::fixture", { ...env(), PI_CODING_AGENT_DIR: own })).toThrow("Pi agent configuration must be a regular, unlinked file");
    }
    expect(lstatSync(join(own, name)).isSymbolicLink()).toBe(true);
    expect(readFileSync(privateFile, "utf8")).toBe('{"keep":"private"}');
  });

  it.skipIf(process.platform === "win32")("publishes injected models with 0o600 mode at rename without post-publish chmod", () => {
    const own = ownPiAgentDir(env(), "pi-1", dataDir);
    const modelsPath = join(own, "models.json");
    chmodSync(modelsPath, 0o644);
    vi.mocked(chmodSync).mockClear();

    ensurePiInjectModel(encodeInjectId("omlx", "MiniMax-M3-4bit"), { ...env(), PI_CODING_AGENT_DIR: own });

    expect(vi.mocked(chmodSync)).not.toHaveBeenCalled();
    expect(lstatSync(modelsPath).isFile()).toBe(true);
    expect(lstatSync(modelsPath).isSymbolicLink()).toBe(false);
    expect(statSync(modelsPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("rejects a boxed Pi sign-in whose symlink chain passes through masked data even when the end file is under home", () => {
    const profileDir = join(home, "profiles", "raven");
    const canonicalDir = join(home, "canonical");
    const canonicalAuth = join(canonicalDir, "auth.json");
    const redirectDir = join(dataDir, "redirect");
    const redirectAuth = join(redirectDir, "auth.json");
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(canonicalDir, { recursive: true });
    mkdirSync(redirectDir, { recursive: true });
    writeFileSync(canonicalAuth, '{"raven":{"type":"api_key","key":"canonical"}}');
    symlinkSync(canonicalAuth, redirectAuth);
    symlinkSync(redirectAuth, join(profileDir, "auth.json"));

    const own = ownPiAgentDir({ HOME: home, PI_CODING_AGENT_DIR: profileDir }, "pi-chain", dataDir);
    const enabled = vi.spyOn(botBox, "enabled").mockReturnValue(true);
    const startOptions = vi.spyOn(botBox, "startOptions").mockReturnValue({
      dataDir,
      home,
      port: 0,
      denyEnv: new Set(),
      codeRoots: [],
      engineRoots: [],
    });
    try {
      const boxedEnv = { HOME: home, TMPDIR: "/tmp", PI_CODING_AGENT_DIR: own };
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).toThrow(/not reachable inside the bot box/);

      // An intermediate directory symlink passing through dataDir is also rejected.
      rmSync(join(profileDir, "auth.json"));
      const via = join(home, "via");
      symlinkSync(redirectDir, via);
      symlinkSync(join(via, "auth.json"), join(profileDir, "auth.json"));
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).toThrow(/not reachable inside the bot box/);

      // A symlink chain wholly inside unmasked home remains reachable.
      rmSync(join(profileDir, "auth.json"));
      symlinkSync(canonicalAuth, join(profileDir, "auth.json"));
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).not.toThrow();
    } finally {
      startOptions.mockRestore();
      enabled.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked data directory redirect and symlink loops before spawning", () => {
    const linkedHome = join(root, "linked-home");
    const realData = join(root, "real-data");
    const linkedData = join(linkedHome, ".openmausbot");
    const profileDir = join(linkedHome, "profiles", "raven");
    const canonicalAuth = join(linkedHome, "canonical", "auth.json");
    mkdirSync(realData, { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(join(linkedHome, "canonical"), { recursive: true });
    symlinkSync(realData, linkedData);
    writeFileSync(canonicalAuth, '{"raven":{"type":"api_key","key":"canonical"}}');
    mkdirSync(join(linkedData, "redirect"), { recursive: true });
    symlinkSync(canonicalAuth, join(linkedData, "redirect", "auth.json"));
    symlinkSync(join(linkedData, "redirect", "auth.json"), join(profileDir, "auth.json"));

    const own = ownPiAgentDir({ HOME: linkedHome, PI_CODING_AGENT_DIR: profileDir }, "pi-symdata", linkedData);
    const enabled = vi.spyOn(botBox, "enabled").mockReturnValue(true);
    const startOptions = vi.spyOn(botBox, "startOptions").mockReturnValue({
      dataDir: linkedData,
      home: linkedHome,
      port: 0,
      denyEnv: new Set(),
      codeRoots: [],
      engineRoots: [],
    });
    try {
      const boxedEnv = { HOME: linkedHome, TMPDIR: "/tmp", PI_CODING_AGENT_DIR: own };
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).toThrow(/not reachable inside the bot box/);

      rmSync(join(profileDir, "auth.json"));
      rmSync(join(own, "auth.json"));
      const loopA = join(linkedHome, "loop-a.json");
      const loopB = join(linkedHome, "loop-b.json");
      symlinkSync(loopB, loopA);
      symlinkSync(loopA, loopB);
      symlinkSync(loopA, join(own, "auth.json"), "file");
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).toThrow("Pi sign-in target could not be resolved for the bot box.");
    } finally {
      startOptions.mockRestore();
      enabled.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("evaluates directory symlinks before '..' rather than collapsing '..' lexically", () => {
    const profileDir = join(home, "profile");
    const routesDir = join(home, "routes");
    const redirectNested = join(dataDir, "redirects", "nested");
    const maskedAuth = join(dataDir, "redirects", "auth.json");
    const realTargetNested = join(home, "real-target", "nested");
    const realTargetAuth = join(home, "real-target", "auth.json");
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(routesDir, { recursive: true });
    mkdirSync(redirectNested, { recursive: true });
    mkdirSync(realTargetNested, { recursive: true });
    // Decoy file under HOME/routes/auth.json that lexical resolve() would mistakenly hit.
    writeFileSync(join(routesDir, "auth.json"), '{"raven":{"type":"api_key","key":"decoy"}}');
    writeFileSync(maskedAuth, '{"raven":{"type":"api_key","key":"masked"}}');
    writeFileSync(realTargetAuth, '{"raven":{"type":"api_key","key":"real"}}');
    symlinkSync(redirectNested, join(routesDir, "alias"));
    symlinkSync("../routes/alias/../auth.json", join(profileDir, "auth.json"));

    const own = ownPiAgentDir({ HOME: home, PI_CODING_AGENT_DIR: profileDir }, "pi-dotdot", dataDir);
    const enabled = vi.spyOn(botBox, "enabled").mockReturnValue(true);
    const startOptions = vi.spyOn(botBox, "startOptions").mockReturnValue({
      dataDir,
      home,
      port: 0,
      denyEnv: new Set(),
      codeRoots: [],
      engineRoots: [],
    });
    try {
      const boxedEnv = { HOME: home, TMPDIR: "/tmp", PI_CODING_AGENT_DIR: own };
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).toThrow(/not reachable inside the bot box/);

      // A directory alias followed by '..' that resolves inside unmasked HOME succeeds.
      rmSync(join(routesDir, "auth.json"));
      rmSync(join(routesDir, "alias"));
      symlinkSync(realTargetNested, join(routesDir, "alias"));
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).not.toThrow();

      // Backtracking outside HOME before re-entering HOME is rejected even if the collapsed path exists.
      rmSync(join(profileDir, "auth.json"));
      symlinkSync(`${home}/../home/real-target/auth.json`, join(profileDir, "auth.json"));
      expect(() => assertPiAuthReachableInBox(own, boxedEnv, "pi")).toThrow(/not reachable inside the bot box/);
    } finally {
      startOptions.mockRestore();
      enabled.mockRestore();
    }
  });
});
