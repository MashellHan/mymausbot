import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const configs = { ui: "tsconfig.json", server: "tsconfig.server.json" };
const args = process.argv.slice(2);
let projects = Object.keys(configs);
const ci = Boolean(process.env.CI && process.env.CI !== "false");
let fresh = ci;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--fresh") fresh = true;
  else if (args[i] === "--project" && Object.hasOwn(configs, args[i + 1])) projects = [args[++i]];
  else throw new Error("Use typecheck [--project ui|server] [--fresh]");
}
const directory = join(process.cwd(), ".omb-scratch", "typecheck");
mkdirSync(directory, { recursive: true });
function check(project) {
  const state = join(directory, `${project}.tsbuildinfo`);
  if (fresh) rmSync(state, { force: true });
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [compiler, "--project", configs[project],
      "--incremental", "--tsBuildInfoFile", state], { stdio: "inherit" });
    child.once("error", (error) => console.error(error.message));
    child.once("close", (code) => {
      const exitCode = code !== null && code >= 0 ? code : 1;
      console.log(`Typecheck ${project}: ${((Date.now() - started) / 1000).toFixed(1)}s; ${fresh ? "fresh" : "incremental"}; exit ${exitCode}`);
      resolve(exitCode);
    });
  });
}

if (ci) {
  const results = await Promise.all(projects.map(check));
  process.exitCode = results.find((code) => code !== 0) ?? 0;
} else {
  for (const project of projects) {
    const code = await check(project);
    if (code !== 0) { process.exitCode = code; break; }
  }
}
