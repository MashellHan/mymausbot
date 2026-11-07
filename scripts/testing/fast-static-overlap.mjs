import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function resultLocation(env) {
  const { RUNNER_TEMP: temp, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt, GITHUB_SHA: sha } = env;
  if (!temp || !isAbsolute(temp) || !existsSync(temp) || !/^\d+$/.test(runId ?? "") ||
      !/^\d+$/.test(attempt ?? "") || !/^[a-f\d]{40}$/i.test(sha ?? "")) throw new Error("Fast static run identity is unavailable");
  return { path: join(temp, `omb-fast-typecheck-${runId}-${attempt}.json`), runId, attempt, sha };
}

function terminate(child, signal) {
  if (!child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch {}
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function launch(argv, env, children, groups) {
  return new Promise((resolveExit) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: "inherit", detached: process.platform !== "win32" });
    children.add(child);
    if (process.platform !== "win32" && child.pid) groups.add(child.pid);
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      children.delete(child);
      if (process.platform !== "win32" && child.pid && !groupAlive(child.pid)) groups.delete(child.pid);
      resolveExit(code);
    };
    child.once("error", (error) => { console.error(`${argv[0]} could not start: ${error.message}`); done(127); });
    child.once("close", (code) => done(code ?? 1));
  });
}

export async function runFastStatic({ core, typecheck, env = process.env, signal } = {}) {
  const location = resultLocation(env);
  rmSync(location.path, { force: true });
  if (signal?.aborted) return 130;
  const children = new Set();
  const groups = new Set();
  let cleanup;
  const active = () => {
    for (const pid of groups) if (!groupAlive(pid)) groups.delete(pid);
    return groups.size > 0 || children.size > 0;
  };
  const waitForCleanup = async (ms) => {
    const deadline = Date.now() + ms;
    while (active() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    return !active();
  };
  const stop = () => {
    if (process.platform === "win32") for (const child of children) terminate(child, "SIGTERM");
    else for (const pid of groups) try { process.kill(-pid, "SIGTERM"); } catch {}
    cleanup = (async () => {
      if (await waitForCleanup(2_000)) return;
      for (const pid of groups) try { process.kill(-pid, "SIGKILL"); } catch {}
      for (const child of children) terminate(child, "SIGKILL");
      if (!await waitForCleanup(1_000)) throw new Error("Fast static process groups did not stop");
    })();
    void cleanup.catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const checking = typecheck ? launch(typecheck, env, children, groups) : Promise.resolve(null);
    const testing = launch(core, env, children, groups);
    const [typecheckCode, coreCode] = await Promise.all([checking, testing]);
    if (signal?.aborted) return 130;
    if (typecheck) writeFileSync(location.path, JSON.stringify({ ...location, typecheckCode, coreCode }) + "\n", { mode: 0o600 });
    console.log(`Fast core exited ${coreCode}; typecheck exited ${typecheckCode ?? "not selected"}`);
    return coreCode;
  } finally {
    signal?.removeEventListener("abort", stop);
    if (cleanup) await cleanup;
    for (const child of children) terminate(child, "SIGKILL");
  }
}

export function typecheckResult(env = process.env) {
  const { path, runId, attempt, sha } = resultLocation(env);
  const row = JSON.parse(readFileSync(path, "utf8"));
  if (row.runId !== runId || row.attempt !== attempt || row.sha !== sha ||
      !Number.isInteger(row.typecheckCode) || row.typecheckCode < 0 || row.typecheckCode > 255 ||
      !Number.isInteger(row.coreCode) || row.coreCode < 0 || row.coreCode > 255) throw new Error("Fast static phase result is invalid");
  return row.typecheckCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "typecheck-result") process.exitCode = typecheckResult();
    else if (process.argv[2] === "run") {
      if (!["true", "false"].includes(process.env.OMB_FAST_TYPECHECK)) throw new Error("Fast static typecheck selection is invalid");
      const files = (process.env.OMB_VITEST_SUBSET ?? "").trim().split(/\s+/).filter(Boolean);
      if (!files.length || files.some((file) => !/^[\w./-]+\.test\.[cm]?[jt]sx?$/.test(file))) throw new Error("Fast static test selection is invalid");
      const controller = new AbortController();
      const interrupt = () => controller.abort();
      process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
      try {
        process.exitCode = await runFastStatic({
          core: ["pnpm", "exec", "vitest", "run", ...files, "--reporter=default", "--reporter=github-actions", "--reporter=json", "--outputFile.json=qa-results/vitest.json"],
          typecheck: process.env.OMB_FAST_TYPECHECK === "true" ? ["pnpm", "typecheck"] : null,
          signal: controller.signal,
        });
      } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
    } else throw new Error("Use fast-static-overlap run or typecheck-result");
  } catch (error) { console.error(error); process.exitCode = 1; }
}
