import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureElectronRuntime } from "./ensure-electron.mjs";

const electronDirectory = fileURLToPath(new URL("../electron/", import.meta.url));
const electronExecutable = ensureElectronRuntime();
const modules = readdirSync(electronDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(?:cjs|mjs)$/.test(entry.name))
  .map((entry) => path.join(electronDirectory, entry.name))
  .sort();

if (modules.length === 0) throw new Error("No Electron modules were found to syntax-check");
for (const modulePath of modules) {
  execFileSync(electronExecutable, ["--check", modulePath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
}

console.log(`Syntax-checked ${modules.length} Electron modules.`);
