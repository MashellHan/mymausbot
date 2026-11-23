import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";

// Pi 1.6.0's SettingsManager loads packages, extensions, skills and prompts from settings.json.
const SETTINGS_KEPT = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "transport", "retry", "httpProxy",
  "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "shellPath"] as const;

export function piAgentDir(env: Record<string, string | undefined>): string {
  const home = resolve(env.HOME || env.USERPROFILE || homedir());
  const named = env.PI_CODING_AGENT_DIR;
  if (!named) return join(home, ".pi", "agent");
  return named === "~" ? home : named.startsWith("~/") ? join(home, named.slice(2)) : resolve(named);
}

function regularEntry(path: string) {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.nlink !== 1n)) throw new Error("Pi agent configuration must be a regular, unlinked file");
  return entry;
}

export function readPiAgentFile(path: string): string | null {
  const entry = regularEntry(path);
  if (!entry) return null;
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const file = fstatSync(fd, { bigint: true });
    if (!file.isFile() || file.nlink !== 1n || file.ino !== entry.ino || file.dev !== entry.dev) {
      throw new Error("Pi agent configuration changed while being opened");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readPiDefaultModel(env: Record<string, string | undefined>): string {
  try {
    const text = readPiAgentFile(join(piAgentDir(env), "settings.json"));
    if (!text) return "";
    const settings = JSON.parse(text) as { defaultProvider?: string; defaultModel?: string };
    return settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : "";
  } catch {
    return "";
  }
}

function linkEntry(target: string, link: string, type: "file" | "junction"): void {
  const source = statSync(target, { throwIfNoEntry: false });
  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (!source) {
    if (existing?.isSymbolicLink() || (type === "file" && existing && existing.nlink > 1)) rmSync(link, { force: true });
    return;
  }
  if (!(type === "file" ? source.isFile() : source.isDirectory())) throw new Error("Invalid Pi agent entry");
  if (existing?.isSymbolicLink()) {
    if (statSync(link, { throwIfNoEntry: false }) && realpathSync(link) === realpathSync(target)) return;
  } else if (type === "junction" && existing?.isDirectory()) {
    return;
  }
  rmSync(link, { force: true });
  // Pi 1.6.0 keys the auth lock by real path, which differs across hard links.
  symlinkSync(target, link, type);
}

function seeded(dir: string, name: string, text: string | null): void {
  const path = join(dir, name), mark = join(dir, `.${name}.from`);
  const entry = regularEntry(path);
  const last = readPiAgentFile(mark);
  if (text === null) {
    if (last !== null) {
      rmSync(path, { force: true });
      rmSync(mark, { force: true });
    }
    return;
  }
  const hash = createHash("sha256").update(text).digest("hex");
  if (hash === last && entry) return;
  writeFileAtomic(path, text, { mode: 0o600 });
  writeFileAtomic(mark, hash, { mode: 0o600 });
}

function settingsText(path: string): string | null {
  const text = readPiAgentFile(path);
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const settings = parsed as Record<string, unknown>;
  return `${JSON.stringify(Object.fromEntries(SETTINGS_KEPT.filter((key) => key in settings).map((key) => [key, settings[key]])), null, 2)}\n`;
}

export function preparePiAgentConfig(profile: string, dir: string, root: string): void {
  const path = relative(root, dir);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) throw new Error("Pi agent directory is outside its assigned home");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let folder = root;
  for (const component of path.split(sep).filter(Boolean)) {
    folder = join(folder, component);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!lstatSync(folder).isDirectory()) throw new Error("Pi agent directory must be a regular directory");
  }
  if (statSync(profile, { throwIfNoEntry: false }) && realpathSync(profile) === realpathSync(dir)) {
    throw new Error("Pi agent profile overlaps its assigned directory");
  }
  seeded(dir, "models.json", readPiAgentFile(join(profile, "models.json")));
  seeded(dir, "settings.json", settingsText(join(profile, "settings.json")));
}

export function ownPiAgentDir(env: Record<string, string | undefined>, instanceId: string, dataDir = DATA_DIR): string {
  const profile = piAgentDir(env);
  const own = join(resolve(dataDir), "providers", "pi-own", createHash("sha256").update(instanceId).digest("hex"), "agent");
  try {
    preparePiAgentConfig(profile, own, dataDir);
    try {
      linkEntry(join(profile, "auth.json"), join(own, "auth.json"), "file");
    } catch (error) {
      throw new Error("Could not share the Pi sign-in through a symbolic link", { cause: error });
    }
    // Pi 1.6.0 can download missing search binaries into its own bin folder.
    try { linkEntry(join(profile, "bin"), join(own, "bin"), "junction"); } catch {}
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not prepare the isolated Pi agent directory. ${detail}`, { cause: error });
  }
  return own;
}
