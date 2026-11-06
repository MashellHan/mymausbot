import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const configs = { ui: "tsconfig.json", server: "tsconfig.server.json" };
const args = process.argv.slice(2);
let projects = Object.keys(configs);
let fresh = Boolean(process.env.CI && process.env.CI !== "false");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fresh") fresh = true;
  else if (args[i] === "--project" && Object.hasOwn(configs, args[i + 1])) projects = [args[++i]];
  else throw new Error("Use typecheck [--project ui|server] [--fresh]");
}
const directory = join(process.cwd(), ".omb-scratch", "typecheck");
mkdirSync(directory, { recursive: true });
for (const project of projects) {
  const state = join(directory, `${project}.tsbuildinfo`);
  if (fresh) rmSync(state, { force: true });
  const started = Date.now();
  const result = spawnSync(process.execPath, [compiler, "--project", configs[project],
    "--incremental", "--tsBuildInfoFile", state], { stdio: "inherit" });
  console.log(`Typecheck ${project}: ${((Date.now() - started) / 1000).toFixed(1)}s; ${fresh ? "fresh" : "incremental"}; exit ${result.status ?? 1}`);
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
