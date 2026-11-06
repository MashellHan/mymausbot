import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (before, after, label) => requireValue(isDeepStrictEqual(before, after), `${label} changed`);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));

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
  uniqueRecords(before.routines, "Routine definitions");
  uniqueRecords(after.routines, "Routine definitions");
  const { runs: beforeRuns, ...beforeDefinitions } = before;
  const { runs: afterRuns, ...afterDefinitions } = after;
  same(beforeDefinitions, afterDefinitions, "Routine definitions");
  const oldRuns = uniqueRecords(beforeRuns, "Routine runs");
  const newRuns = uniqueRecords(afterRuns, "Routine runs");
  const identity = ["id", "routineId", "botId", "createdAt", "scheduledFor", "runOn", "manual", "triggerSource", "target",
    "groupId", "eventSource", "webhookId", "deliveryId", "access", "deliver", "attachments", "prompt", "durationMinutes", "timeoutMinutes"];
  for (const [id, oldRun] of oldRuns) {
    requireValue(newRuns.has(id), "Existing Routine run history was lost");
    for (const key of identity) same([Object.hasOwn(oldRun, key), oldRun[key]],
      [Object.hasOwn(newRuns.get(id), key), newRuns.get(id)[key]], "Existing Routine run identity");
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
    else throw new Error("Use check:delivery request <request.json> | inventory <before.json> <after.json> | routines <before.json> <after.json>");
    console.log(JSON.stringify({ passed: true, check, readOnly: true }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
