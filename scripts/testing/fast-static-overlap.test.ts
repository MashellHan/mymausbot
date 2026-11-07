import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runFastStatic, typecheckResult } from "./fast-static-overlap.mjs";

let temp: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "omb-fast-static-"));
  env = { ...process.env, RUNNER_TEMP: temp, GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40) };
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

const exits = (code: number) => [process.execPath, "-e", `process.exit(${code})`];

it("runs both required phases together after one setup and binds their successful result", async () => {
  const coreStarted = join(temp, "core-started"), typecheckStarted = join(temp, "typecheck-started");
  const waitsFor = (own: string, peer: string) => [process.execPath, "-e", `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(own)}, "started");
    let attempts = 0;
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(peer)})) { clearInterval(timer); process.exit(0); }
      if (++attempts > 300) { clearInterval(timer); process.exit(9); }
    }, 10);
  `];
  expect(await runFastStatic({ core: waitsFor(coreStarted, typecheckStarted),
    typecheck: waitsFor(typecheckStarted, coreStarted), env })).toBe(0);
  expect(typecheckResult(env)).toBe(0);
});

it.each([
  { core: 7, typecheck: 0 },
  { core: 0, typecheck: 9 },
])("preserves core=$core and typecheck=$typecheck failures separately", async ({ core, typecheck }) => {
  expect(await runFastStatic({ core: exits(core), typecheck: exits(typecheck), env })).toBe(core);
  expect(typecheckResult(env)).toBe(typecheck);
  expect(() => typecheckResult({ ...env, GITHUB_SHA: "b".repeat(40) })).toThrow("Fast static phase result is invalid");
});

it("keeps an unselected typecheck and a missing phase result from becoming success", async () => {
  expect(await runFastStatic({ core: exits(0), typecheck: null, env })).toBe(0);
  expect(() => typecheckResult(env)).toThrow();
  writeFileSync(join(temp, "omb-fast-typecheck-42-1.json"), "{}");
  expect(() => typecheckResult(env)).toThrow("Fast static phase result is invalid");
});

it("stops both process groups and leaves no success result when cancelled", async () => {
  const controller = new AbortController();
  const paused = [process.execPath, "-e", "setTimeout(() => process.exit(0), 10_000)"];
  const run = runFastStatic({ core: paused, typecheck: paused, env, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  expect(await run).toBe(130);
  expect(() => typecheckResult(env)).toThrow();
});

it.skipIf(process.platform === "win32")("reaps a TERM-resistant descendant after its phase leader exits", async () => {
  const childReady = join(temp, "child-ready"), leaderReady = join(temp, "leader-ready");
  const pids = join(temp, "pids.json"), leaderTerm = join(temp, "leader-term");
  const descendant = `const fs = require("node:fs"); process.on("SIGTERM", () => {});
    fs.writeFileSync(${JSON.stringify(childReady)}, "ready"); setInterval(() => {}, 1_000);`;
  const leader = `const fs = require("node:fs"), { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
    fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ leader: process.pid, child: child.pid }));
    process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(leaderTerm)}, "term"); process.exit(0); });
    fs.writeFileSync(${JSON.stringify(leaderReady)}, "ready"); setInterval(() => {}, 1_000);`;
  const controller = new AbortController();
  const run = runFastStatic({ core: exits(0), typecheck: [process.execPath, "-e", leader], env, signal: controller.signal });
  let leaderPid = 0, childPid = 0;
  const active = (pid: number) => execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8" }).split("\n")
    .some((line) => { const [seen, group, state] = line.trim().split(/\s+/); return (Number(seen) === pid || Number(group) === leaderPid) && !!state && !state.startsWith("Z"); });
  try {
    await vi.waitFor(() => { expect(existsSync(childReady)).toBe(true); expect(existsSync(leaderReady)).toBe(true); }, { timeout: 3_000 });
    ({ leader: leaderPid, child: childPid } = JSON.parse(readFileSync(pids, "utf8")));
    controller.abort();
    expect(await run).toBe(130);
    expect(existsSync(leaderTerm)).toBe(true);
    expect(active(childPid)).toBe(false);
    expect(() => typecheckResult(env)).toThrow();
  } finally {
    controller.abort();
    if (leaderPid) try { process.kill(-leaderPid, "SIGKILL"); } catch {}
    if (childPid) try { process.kill(childPid, "SIGKILL"); } catch {}
    await Promise.race([run.catch(() => {}), new Promise((resolve) => { const timer = setTimeout(resolve, 3_000); timer.unref(); })]);
  }
}, 10_000);

it.skipIf(process.platform === "win32")("uses the complete selected file list and verifies the compiler's real CLI exit", () => {
  const commandLog = join(temp, "pnpm-args.jsonl");
  writeFileSync(join(temp, "pnpm"), `#!/usr/bin/env node\nconst fs = require("node:fs");\nfs.appendFileSync(process.env.STUB_PNPM_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(process.argv[2] === "typecheck" ? 9 : 0);\n`, { mode: 0o755 });
  const script = fileURLToPath(new URL("./fast-static-overlap.mjs", import.meta.url));
  const selected = ["scripts/control-omb.test.ts", "server/room-coordination.e2e.test.ts"];
  const cliEnv = { ...env, PATH: `${temp}${delimiter}${process.env.PATH}`, STUB_PNPM_LOG: commandLog,
    OMB_FAST_TYPECHECK: "true", OMB_VITEST_SUBSET: selected.join(" ") };
  expect(spawnSync(process.execPath, [script, "run"], { env: cliEnv }).status).toBe(0);
  expect(readFileSync(commandLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
    ["typecheck"], ["exec", "vitest", "run", ...selected, "--reporter=default", "--reporter=github-actions",
      "--reporter=json", "--outputFile.json=qa-results/vitest.json"],
  ]));
  expect(spawnSync(process.execPath, [script, "typecheck-result"], { env: cliEnv }).status).toBe(9);
  const noBuild = { ...cliEnv, OMB_FAST_TYPECHECK: "false" };
  expect(spawnSync(process.execPath, [script, "run"], { env: noBuild }).status).toBe(0);
  expect(readFileSync(commandLog, "utf8").split("\n").filter((line) => line.includes('"typecheck"'))).toHaveLength(1);
  expect(() => typecheckResult(noBuild)).toThrow();
});
