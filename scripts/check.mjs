import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { changedCodeLines, readCheckPolicy, SAFE_TEST_PATH, selectCheckPlan } from "./ci-scope.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const digest = (value) => createHash("sha256").update(value).digest("hex");
const nul = (value) => value ? value.replace(/\0$/, "").split("\0") : [];

export function localChange(base = "origin/main", cwd = process.cwd()) {
  if (!base || base.startsWith("-")) throw new Error("Invalid base revision");
  const head = git(["rev-parse", "HEAD"], cwd).trim();
  const behindBase = Number(git(["rev-list", "--count", `${head}..${base}`, "--"], cwd).trim());
  const mergeBase = git(["merge-base", base, head], cwd).trim();
  const diff = git(["diff", "--binary", "--no-ext-diff", "--no-renames", mergeBase, "--"], cwd);
  const untracked = nul(git(["ls-files", "--others", "--exclude-standard", "-z"], cwd));
  const files = [...new Set([...nul(git(["diff", "--name-only", "--no-renames", "-z", mergeBase, "--"], cwd)), ...untracked])].sort();
  return {
    head, base: mergeBase, behindBase, files,
    dirty: Boolean(git(["status", "--porcelain"], cwd).trim()),
    sourceHash: digest(diff + untracked.map((file) => `${file}\0${digest(readFileSync(join(cwd, file)))}`).join("\0")),
    lockHash: existsSync(join(cwd, "pnpm-lock.yaml")) ? digest(readFileSync(join(cwd, "pnpm-lock.yaml"))) : null,
  };
}

function main() {
  const [action = "plan", ...args] = process.argv.slice(2);
  if (!["plan", "edit", "ready"].includes(action)) throw new Error("Use check:plan, check:edit or check:ready");
  let base = "origin/main";
  const extra = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base" && args[i + 1]) base = args[++i];
    else if (args[i] === "--test" && args[i + 1]) extra.push(args[++i]);
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (extra.some((file) => !SAFE_TEST_PATH.test(file) || !existsSync(file))) throw new Error("--test must name an existing test file");
  const source = localChange(base);
  if (source.behindBase > 0) console.error(`Checkout is ${source.behindBase} commit(s) behind ${base}; read policy from the current task checkout or fetched main. Preserve active work; do not reset it.`);
  const policy = readCheckPolicy();
  const plan = selectCheckPlan({ files: source.files, policy, lines: changedCodeLines(source.base), mode: process.env.MAUSBOT_CI_MODE || "shadow" });
  console.log(JSON.stringify({ ...plan, source }, null, 2));
  if (action === "plan") return;
  const nativeRelay = plan.nativeRelay || extra.some((file) => file.startsWith("relay/test/"));
  const files = [...new Set([...plan[action], ...extra.filter((file) => !file.startsWith("relay/test/"))])].sort();
  if (!files.length && !nativeRelay) throw new Error("No mapped contract test: supply --test <file>, then record the mapping for review");
  const startedAt = new Date().toISOString();
  const directory = join(".omb-scratch", "validation", `${startedAt.replace(/[:.]/g, "-")}-${action}`);
  mkdirSync(directory, { recursive: true });
  const resultFile = join(directory, "vitest.json");
  const command = ["node_modules/vitest/vitest.mjs", "run", ...files, "--reporter=default", "--reporter=json", `--outputFile.json=${resultFile}`];
  const env = { OMB_VITEST_WORKERS: "1", OMB_VITEST_E2E: "all", OMB_DASHBOARD_UI: files.includes("scripts/testing/local-dashboard-ui.e2e.test.ts") ? "1" : "0" };
  const result = files.length ? spawnSync(process.execPath, command, { stdio: "inherit", env: { ...process.env, ...env } }) : null;
  const nativeCommand = nativeRelay ? ["pnpm", "--dir", "relay", "test"] : null;
  const nativeResult = nativeCommand ? spawnSync(nativeCommand[0], nativeCommand.slice(1), { encoding: "utf8", env: process.env }) : null;
  const nativeOutput = `${nativeResult?.stdout ?? ""}${nativeResult?.stderr ?? ""}`;
  if (nativeResult) {
    process.stdout.write(nativeOutput);
    writeFileSync(join(directory, "relay.tap"), nativeOutput);
  }
  const durationMs = Date.now() - Date.parse(startedAt);
  const budgetMs = action === "edit" ? 30_000 : 120_000;
  const endSource = localChange(base);
  const inputsStable = ["head", "base", "sourceHash", "lockHash"].every((key) => source[key] === endSource[key]);
  let counts = null;
  if (existsSync(resultFile)) {
    const report = JSON.parse(readFileSync(resultFile, "utf8"));
    counts = Object.fromEntries(["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests"].map((key) => [key, report[key]]));
  }
  const nativeSummary = [...nativeOutput.matchAll(/^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)];
  const nativeCounts = nativeSummary.length ? Object.fromEntries(nativeSummary.map((match) => [match[1], Number(match[2])])) : null;
  const exitCode = [result, nativeResult].every((item) => !item || item.status === 0) ? 0 : 1;
  const receipt = {
    version: 1, action, source, endSource, inputsStable, plan, command: result ? [process.execPath, ...command] : null,
    nativeCommand, nativeCounts, nativeResultFile: nativeResult ? join(directory, "relay.tap") : null,
    env: { ...env, CI: process.env.CI ?? "", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, LANG: process.env.LANG ?? "" },
    node: process.version, platform: process.platform, arch: process.arch,
    startedAt, finishedAt: new Date().toISOString(), durationMs, budgetMs, overBudget: durationMs > budgetMs,
    exitCode, signal: result?.signal ?? nativeResult?.signal,
    error: result?.error?.message ?? nativeResult?.error?.message, counts, resultFile,
  };
  writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`Validation receipt: ${directory}/receipt.json`);
  console.log(`Local ${action}: ${(durationMs / 1000).toFixed(1)}s; target ${budgetMs / 1000}s. Global typecheck belongs in CI; pnpm build includes its own typecheck.`);
  if (durationMs > budgetMs) console.error("Local feedback exceeded its target; record and fix the expensive phase instead of repeating unchanged checks.");
  console.log(`Local validation: ${files.length} Vitest files${nativeRelay ? " and the Relay native suite" : ""}; ordinary PR CI runs the Ubuntu core and bounded affected tests, with full validation after integration and on the daily/release lanes. Normal push hooks and independent review still apply.`);
  if (!inputsStable) console.error("Source inputs changed during validation; this receipt cannot mark the current source ready.");
  process.exitCode = inputsStable ? exitCode : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
