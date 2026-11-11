import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertClosedSqliteCopy } from "./closed-sqlite-snapshot.mjs";
import { inspectPrivateCredentialStorage } from "./private-credential-storage.mjs";

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (before, after, label) => requireValue(isDeepStrictEqual(before, after), `${label} changed`);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const without = (record, fields) => Object.fromEntries(Object.entries(record).filter(([key]) => !fields.includes(key)));
const sameField = (before, after, key, label) => same([Object.hasOwn(before, key), before[key]],
  [Object.hasOwn(after, key), after[key]], `${label} ${key}`);
const identifier = (value) => typeof value === "string" && value.length > 0;

export function validateBuildRequest(request) {
  requireValue(object(request), "Build request must be an object");
  for (const key of ["sourceCheckout", "sourceCommit", "sourceTree", "sourceRef", "appVersion", "lockfileSha256",
    "targetApp", "packageApp", "officialApp", "expectedDownloadsPurpose", "expectedEnvironmentId"]) {
    requireValue(typeof request[key] === "string" && request[key].trim().length > 0, `Build request needs ${key}`);
  }
  for (const key of ["sourceCommit", "sourceTree"]) requireValue(/^[a-f0-9]{40}$/.test(request[key]), `Invalid ${key}`);
  requireValue(/^[a-f0-9]{64}$/.test(request.lockfileSha256), "Invalid lockfileSha256");
  requireValue(!request.sourceRef.startsWith("-"), "Invalid sourceRef");
  for (const key of ["sourceCheckout", "targetApp", "packageApp", "officialApp"]) requireValue(isAbsolute(request[key]), `${key} must be absolute`);
  requireValue(new Set([request.targetApp, request.packageApp, request.officialApp].map((path) => resolve(path))).size === 3,
    "Package, normal App and preserved official App must have different paths");
}

function uniqueRecords(records, label) {
  requireValue(Array.isArray(records), `${label} must be an array`);
  const indexed = new Map();
  for (const record of records) {
    requireValue(object(record) && typeof record.id === "string" && record.id.length > 0, `${label} has an invalid record`);
    requireValue(!indexed.has(record.id), `${label} has duplicate IDs`);
    indexed.set(record.id, record);
  }
  return indexed;
}

export function assertInventorySame(before, after) {
  const normalized = (inventory) => {
    requireValue(object(inventory), "Mini App inventory must be an object");
    uniqueRecords(inventory.apps, "Mini App inventory");
    return { ...inventory, apps: inventory.apps.map((app) => ({ shippedTemplateKind: null, ...app })) };
  };
  same(normalized(before), normalized(after), "Owner Mini App inventory");
}

export function assertRoutinesSame(before, after) {
  requireValue(object(before) && object(after) && Number.isInteger(before.version) && Number.isInteger(after.version),
    "Routine documents need a version");
  const oldRoutines = uniqueRecords(before.routines, "Routine definitions");
  const newRoutines = uniqueRecords(after.routines, "Routine definitions");
  const oldRuns = uniqueRecords(before.runs, "Routine runs");
  const newRuns = uniqueRecords(after.runs, "Routine runs");
  const materializesCheck = (oldRun, newRun, routine) => oldRun.status === "queued"
    && oldRun.checkKey === undefined && oldRun.threadId === undefined && oldRun.startedAt === undefined
    && oldRun.triggerSource !== "webhook" && Array.isArray(routine?.checks) && routine.checks.length > 0
    && typeof newRun.checkKey === "string" && /^[\w-]{1,128}$/.test(newRun.checkKey) && identifier(newRun.prompt);
  const metadata = ["routines", "runs", "startupLaunchId"];
  same(without(before, metadata), without(after, metadata), "Routine document metadata");
  if (!isDeepStrictEqual(before.startupLaunchId, after.startupLaunchId)) {
    requireValue(identifier(after.startupLaunchId), "Routine startup identity was lost");
  }
  same([...oldRoutines.keys()], [...newRoutines.keys()], "Routine definitions");
  const operational = ["checkedAt", "wakeAt", "checkTrouble", "nextRunAt", "skippedRuns", "lastSkippedAt",
    "failureStreak", "weekRuns", "warning", "updatedAt"];
  for (const [id, oldRoutine] of oldRoutines) {
    const newRoutine = newRoutines.get(id);
    const allocatesResults = oldRoutine.resultsThreadId === undefined && identifier(newRoutine.resultsThreadId)
      && oldRoutine.target === "bot" && [...newRuns.values()].some((run) => run.routineId === id
        && run.botId === oldRoutine.botId && run.target === "bot" && run.resultsThreadId === newRoutine.resultsThreadId
        && (!oldRuns.has(run.id) || materializesCheck(oldRuns.get(run.id), run, oldRoutine)));
    const fields = allocatesResults ? [...operational, "resultsThreadId"] : operational;
    same(without(oldRoutine, fields), without(newRoutine, fields), "Routine configuration");
    if (oldRoutine.updatedAt !== undefined || newRoutine.updatedAt !== undefined) {
      requireValue(Number.isFinite(newRoutine.updatedAt) && newRoutine.updatedAt >= (oldRoutine.updatedAt ?? 0),
        "Routine revision was lost or moved backwards");
    }
  }
  const identity = ["id", "routineId", "botId", "createdAt", "scheduledFor", "runOn", "manual", "triggerSource", "target",
    "groupId", "eventSource", "webhookId", "deliveryId", "access", "deliver", "attachments", "durationMinutes", "timeoutMinutes",
    "routineName", "sourceThreadId"];
  for (const [id, oldRun] of oldRuns) {
    requireValue(newRuns.has(id), "Existing Routine run history was lost");
    const newRun = newRuns.get(id);
    for (const key of identity) sameField(oldRun, newRun, key, "Existing Routine run identity");
    const checked = materializesCheck(oldRun, newRun, oldRoutines.get(oldRun.routineId));
    if (!checked) for (const key of ["prompt", "checkKey"]) sameField(oldRun, newRun, key, "Existing Routine run check");
    const destination = newRoutines.get(oldRun.routineId)?.resultsThreadId;
    const allocatesResults = checked && oldRun.target === "bot" && oldRun.resultsThreadId === undefined
      && identifier(newRun.resultsThreadId) && (destination === undefined || newRun.resultsThreadId === destination);
    if (!allocatesResults) sameField(oldRun, newRun, "resultsThreadId", "Existing Routine run routing");
    if (oldRun.threadId !== undefined || newRun.threadId !== undefined) {
      const starts = oldRun.status === "queued" && oldRun.threadId === undefined && oldRun.startedAt === undefined
        && identifier(newRun.threadId) && Number.isFinite(newRun.startedAt);
      if (!starts) sameField(oldRun, newRun, "threadId", "Existing Routine run execution");
    }
  }
}

function checkRequestSource(request) {
  validateBuildRequest(request);
  const git = (...args) => execFileSync("git", args, { cwd: request.sourceCheckout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  same(git("rev-parse", "HEAD"), request.sourceCommit, "Build source commit");
  same(git("rev-parse", "HEAD^{tree}"), request.sourceTree, "Build source tree");
  same(git("rev-parse", "--verify", "--end-of-options", `${request.sourceRef}^{commit}`), request.sourceCommit, "Build source ref");
  requireValue(git("status", "--porcelain").length === 0, "Build source checkout must be clean");
  const lockHash = createHash("sha256").update(readFileSync(join(request.sourceCheckout, "pnpm-lock.yaml"))).digest("hex");
  same(lockHash, request.lockfileSha256, "Build lockfile");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [check, ...files] = process.argv.slice(2);
    if (check === "request" && files.length === 1) checkRequestSource(read(files[0]));
    else if (check === "inventory" && files.length === 2) assertInventorySame(...files.map(read));
    else if (check === "routines" && files.length === 2) assertRoutinesSame(...files.map(read));
    else if (check === "closed-sqlite" && files.length === 2) assertClosedSqliteCopy(...files);
    else if (["installed-helpers", "signed-helpers"].includes(check) && files.length === 2) {
      execFileSync("python3", ["-I", "-B", fileURLToPath(new URL("./installed_helpers.py", import.meta.url)), check, ...files],
        { stdio: ["ignore", "pipe", "pipe"] });
    }
    else if (check === "private-storage" && files.length >= 2 && files.length <= 3) {
      requireValue(!["prelaunch", "postquit"].includes(files[1]) || files.length === 3, "Closed storage check needs an expected snapshot");
      inspectPrivateCredentialStorage(files[0], { phase: files[1], ...(files[2] ? { expected: read(files[2]) } : {}) });
    } else throw new Error("Use check:delivery request <request.json> | inventory <before.json> <after.json> | routines <before.json> <after.json> | closed-sqlite <source-dir> <copy-dir> | installed-helpers|signed-helpers <directory> <hashes.json> | private-storage <fixture-root> <prelaunch|postlaunch|postquit> [expected.json]");
    console.log(JSON.stringify({ passed: true, check, readOnly: true }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
