import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromeForTestingPin, installChromeForTesting } from "../../server/browser/chrome/install.ts";
import { installedChrome, UI_TOOLS_DIR } from "./control-omb-ui.ts";

export async function fixtureChrome(env: NodeJS.ProcessEnv = process.env, toolsDir = UI_TOOLS_DIR): Promise<string> {
  const explicit = env.OMB_CDP_CHROME?.trim() || env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`The explicit fixture browser does not exist: ${explicit}`);
    return resolve(explicit);
  }
  const installed = installedChrome(toolsDir);
  if (installed) return installed;
  const pin = chromeForTestingPin();
  if (!pin) throw new Error("No Chrome for Testing is pinned for this platform; set OMB_CDP_CHROME to a testing browser.");
  return installChromeForTesting({ dataDir: toolsDir, pin });
}
