import { createHash } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { DATA_DIR } from "../config.ts";
import { engineHomes } from "../engine-homes/engine-homes.ts";

// Pi 1.6.0's SettingsManager loads packages, extensions, skills and prompts from settings.json.
const SETTINGS_KEPT = ["defaultProvider", "defaultModel", "defaultThinkingLevel", "transport", "retry", "httpProxy",
  "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "shellPath"] as const;

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

export function piAgentDir(env: Record<string, string | undefined>): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const named = env.PI_CODING_AGENT_DIR;
  if (!named) return join(home, ".pi", "agent");
  return named === "~" ? home : named.startsWith("~/") ? join(home, named.slice(2)) : resolve(named);
}

export function readPiDefaultModel(env: Record<string, string | undefined>): string {
  try {
    const settings = JSON.parse(readFileSync(join(piAgentDir(env), "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string };
    return settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : "";
  } catch {
    return "";
  }
}

function sameFile(target: string, other: string): boolean {
  const a = statSync(target, { bigint: true, throwIfNoEntry: false });
  const b = statSync(other, { bigint: true, throwIfNoEntry: false });
  return a !== undefined && b !== undefined && a.ino === b.ino && a.dev === b.dev;
}

function linkEntry(target: string, link: string, type: "file" | "junction"): void {
  const source = statSync(target, { throwIfNoEntry: false });
  const existing = lstatSync(link, { throwIfNoEntry: false });
  const hardlinkMarker = join(dirname(link), `.${basename(link)}.hardlink`);
  if (!source) {
    if (existing?.isSymbolicLink() || lstatSync(hardlinkMarker, { throwIfNoEntry: false })) {
      rmSync(link, { force: true });
      rmSync(hardlinkMarker, { force: true });
    }
    return;
  }
  if (!(type === "file" ? source.isFile() : source.isDirectory())) {
    throw new Error(`Invalid Pi agent entry: ${target}`);
  }
  if (sameFile(target, link) || (type === "junction" && existing?.isDirectory())) return;
  rmSync(link, { force: true });
  rmSync(hardlinkMarker, { force: true });
  try {
    symlinkSync(target, link, type);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && sameFile(target, link)) return;
    if (process.platform !== "win32" || type !== "file") throw error;
    // Windows may refuse a symlink without Developer Mode. Pi updates auth.json in place.
    writeFileAtomic(hardlinkMarker, "", { mode: 0o600 });
    linkSync(target, link);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

function seeded(own: string, name: string, text: string | null): void {
  const path = join(own, name), mark = join(own, `.${name}.from`);
  const hash = text === null ? null : createHash("sha256").update(text).digest("hex");
  const last = readText(mark);
  if (hash === last && (text === null || lstatSync(path, { throwIfNoEntry: false })?.isFile())) return;
  if (text === null || hash === null) {
    rmSync(path, { force: true });
    rmSync(mark, { force: true });
    return;
  }
  writeFileAtomic(path, text, { mode: 0o600 });
  writeFileAtomic(mark, hash, { mode: 0o600 });
}

function settingsText(path: string): string | null {
  const text = readText(path);
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const settings = parsed as Record<string, unknown>;
  return `${JSON.stringify(Object.fromEntries(SETTINGS_KEPT.filter((key) => key in settings).map((key) => [key, settings[key]])), null, 2)}\n`;
}

export function ownPiAgentDir(env: Record<string, string | undefined>, instanceId: string, dataDir = DATA_DIR,
  teamCloud = engineHomes.active()): string | null {
  const person = piAgentDir(env);
  const own = join(resolve(dataDir), "providers", "pi-own", createHash("sha256").update(instanceId).digest("hex"), "agent");
  if (teamCloud || inside(resolve(dataDir), person)) return null;
  try {
    mkdirSync(own, { recursive: true, mode: 0o700 });
    linkEntry(join(person, "auth.json"), join(own, "auth.json"), "file");
    // Pi 1.6.0 can download missing search binaries into its own bin folder.
    try { linkEntry(join(person, "bin"), join(own, "bin"), "junction"); } catch {}
    seeded(own, "models.json", readText(join(person, "models.json")));
    seeded(own, "settings.json", settingsText(join(person, "settings.json")));
  } catch (error) {
    throw new Error("Could not prepare the isolated Pi agent directory", { cause: error });
  }
  return own;
}

export function withOwnPiAgentDir(env: Record<string, string | undefined>, instanceId: string, dataDir = DATA_DIR,
  teamCloud = engineHomes.active()): Record<string, string | undefined> {
  const own = ownPiAgentDir(env, instanceId, dataDir, teamCloud);
  return own ? { ...env, PI_CODING_AGENT_DIR: own } : env;
}
