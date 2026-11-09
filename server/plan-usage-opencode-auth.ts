import { homedir } from "node:os";
import { join } from "node:path";

/** The CLI is xdg-flavoured on every platform, so the xdg data folder comes first. */
export function openCodeAuthText(env: NodeJS.ProcessEnv, readText: (path: string) => string | null): string | null {
  const home = env.HOME || env.USERPROFILE || homedir();
  const roots = [
    env.XDG_DATA_HOME || join(home, ".local", "share"),
    process.platform === "darwin" ? join(home, "Library", "Application Support") : "",
    process.platform === "win32" ? env.LOCALAPPDATA || join(home, "AppData", "Local") : "",
  ].filter(Boolean);
  for (const root of roots) { const text = readText(join(root, "opencode", "auth.json")); if (text) return text; }
  return null;
}
