import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { verifyPrivateBrowserFuse } from "../electron/private-cookie-fuse.mjs";
import { finishOwnedPrivateFixture, inspectPrivateCredentialStorage } from "./private-credential-storage.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const { values } = parseArgs({ options: { app: { type: "string" }, evidence: { type: "string" } } });
assert(values.app && isAbsolute(values.app), "Supply --app with an absolute signed package path");
const app = realpathSync(values.app);
assert(app.endsWith(".app") && !app.startsWith("/Applications/"), "Use an isolated packaged App, not the live installation");
const executable = join(app, "Contents/MacOS/mymausbot");
assert(existsSync(executable));
const evidence = values.evidence ? resolve(values.evidence) : realpathSync(mkdtempSync(join(tmpdir(), "omb-private-file-evidence-")));
if (values.evidence && !existsSync(evidence)) mkdirSync(evidence, { mode: 0o700, recursive: false });
assert.equal(realpathSync(evidence), evidence);
assert(lstatSync(evidence).isDirectory() && statSync(evidence).uid === process.getuid()
  && (statSync(evidence).mode & 0o777) === 0o700);
const attemptsPath = join(evidence, "attempts.json");
const attempts = existsSync(attemptsPath) ? JSON.parse(readFileSync(attemptsPath, "utf8")) : { firstStartedAtMs: Date.now(), attempts: [] };
assert(Number.isSafeInteger(attempts.firstStartedAtMs) && Array.isArray(attempts.attempts));
const attempt = attempts.attempts.length + 1;
const attemptStartedAtMs = Date.now();
const deadlineMs = attemptStartedAtMs + 120_000;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();
const remaining = () => Math.max(0, deadlineMs - Date.now());
const startedAt = now();
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "omb-private-file-e2e-")));
const profile = join(fixture, "profile"), home = join(fixture, "home"), data = join(fixture, "data"), temporary = join(fixture, "tmp");
for (const path of [profile, home, data, temporary]) mkdirSync(path, { mode: 0o700 });
writeFileSync(join(profile, "desktop-prefs.json"), JSON.stringify({ credentialMode: "private-file", analytics: false, language: "en" }), { mode: 0o600 });
writeFileSync(join(data, "config.json"), JSON.stringify({
  features: { smartSetupChoices: false },
  instances: { claude: { driver: "claudeAgent", displayName: "Synthetic startup fixture",
    config: { cli: join(root, "server/testing/fake-claude-cli.ts") } } },
  onboarding: { completedAt: now(), version: 1, hintsSeen: ["met-chief-v1"] },
  computerName: "SYNTHETIC private credential package",
}), { mode: 0o600 });
const oldNames = ["credentials.bin", "cloud-account.bin", "company-connection.bin", "company-library.bin", "company-backup-schedule.bin"];
const oldHashes = Object.fromEntries(oldNames.map(name => {
  const bytes = randomBytes(96);
  writeFileSync(join(profile, name), bytes, { mode: 0o600 });
  return [name, sha(bytes)];
}));
const sandbox = join(fixture, "fixture.sb"), canary = join(fixture, "denied-canary");
writeFileSync(canary, "Synthetic file-denial canary");
const blocked = [".openmausbot", ".codex", ".copilot", ".claude", ".agents", ".ssh", ".config",
  ".local/share/mymausbot-auth", "Library/Application Support/openmausbot", "Library/Keychains"].map(name => join(homedir(), name));
writeFileSync(sandbox, ["(version 1)", "(allow default)",
  '(deny network-bind (local ip "*:8799"))',
  '(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*"))',
  ...[...blocked, "/Library/Keychains", "/private/var/db/Keychains", canary]
    .map(path => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`),
  '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.securityd.systemkeychain") (global-name "com.apple.secd") (global-name "com.apple.security.agent"))',
  '(deny file-read* (subpath "/Applications/CuaDriver.app"))',
].join("\n") + "\n");
const appArgs = ["-f", sandbox, executable, `--user-data-dir=${profile}`, "--no-sandbox",
  "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"];
const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, CFFIXED_USER_HOME: home,
  TMPDIR: temporary, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local/share"), OMB_DATA_DIR: data, OMB_SMOKE_TEST: "1",
  OMB_SMOKE_KEEP_OPEN: "1", OMB_TEST_SEALED_PATH: "1", FAKE_CLAUDE_MODE: "happy",
  FAKE_CLAUDE_DUMP: join(data, "fake-claude-dump.json") };
const receipt = { kind: "PACKAGED_PRIVATE_FILE_CREDENTIAL_E2E", app, startedAt,
  originalStartedAt: new Date(attempts.firstStartedAtMs).toISOString(), attempt, phases: [], passed: false,
  scope: "Synthetic xAI key and browser cookie across fresh signed App processes; no real provider, Cloud or company sign-in",
  network: "OS sandbox allows fixture loopback and denies external outbound",
  protectedPaths: "Real data, auth and login Keychain paths plus security services denied" };

function safeRun(command, args, timeoutMs = 10_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: Math.min(timeoutMs, remaining()) });
  assert.equal(result.status, 0, `${basename(command)} failed its isolated preflight`);
  return result;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function cdp(url, method, params = {}) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error(`CDP timeout: ${method}`)); }, Math.min(15_000, remaining()));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`CDP failed: ${method}`)); });
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timer); socket.close();
      if (message.error) reject(new Error(`CDP refused ${method}`)); else resolve(message.result);
    });
  });
}
async function phase(name, before, assertion) {
  inspectPrivateCredentialStorage(fixture, { phase: "prelaunch", expected: before });
  assert(remaining() > 15_000, "Not enough of the original fixture budget remains to start another App");
  const record = { name, startedAt: now(), passed: false };
  receipt.phases.push(record);
  const child = spawn("/usr/bin/sandbox-exec", appArgs, { env, cwd: fixture, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  record.pid = child.pid;
  let output = "";
  child.on("error", error => { record.spawnError = error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + String(chunk)).slice(-16000); });
  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  async function until(check, label, timeoutMs = 45_000) {
    const deadline = Math.min(Date.now() + timeoutMs, deadlineMs);
    while (Date.now() < deadline) {
      const value = await check();
      if (value) return value;
      if (record.spawnError) throw new Error("Owned fixture could not start");
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited while waiting for ${label}`);
      await delay(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  let beforeQuit;
  let failure;
  try {
    const smoke = await until(() => {
      const failed = output.match(/\[smoke\] renderer-failed ([^\n]*)/);
      if (failed) throw new Error("Packaged renderer startup failed");
      const match = output.match(/\[smoke\] renderer-ready (\{[^\n]*\})/);
      return match && JSON.parse(match[1]);
    }, "packaged renderer");
    assert.equal(smoke.health.app, "openmausbot");
    assert.notEqual(new URL(smoke.location).port, "8799");
    assert.equal(smoke.capabilities.host.homeDir, home);
    const socket = await until(() => output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], "fixture debugging endpoint");
    const browserOrigin = new URL(socket);
    assert(["127.0.0.1", "localhost"].includes(browserOrigin.hostname));
    const pageSocket = await until(async () => {
      try {
        const signal = AbortSignal.timeout(Math.min(5_000, remaining()));
        const pages = await (await fetch(`http://${browserOrigin.host}/json/list`, { signal })).json();
        return pages.find(item => item.type === "page" && item.url.startsWith(new URL(smoke.location).origin + "/"))?.webSocketDebuggerUrl;
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") return null;
        throw error;
      }
    }, "fixture page", 20_000);
    async function evaluate(expression) {
      const answer = await cdp(pageSocket, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      assert(!answer.exceptionDetails, "Renderer assertion failed");
      return answer.result.value;
    }
    await until(async () => await evaluate("document.getElementById('root')?.childElementCount > 0 && window.ogb?.credentialMode?.()"), "React and preload", 20_000);
    assert.equal(await evaluate("window.ogb.credentialMode()"), "private-file");
    await assertion(evaluate, until);
    beforeQuit = inspectPrivateCredentialStorage(fixture, { phase: "postlaunch" });
    record.privateStorage = beforeQuit.state;
    record.passed = true;
  } catch (error) {
    failure = error;
  } finally {
    child.kill("SIGTERM");
    const gracefulDeadline = Date.now() + 10_000;
    while ((child.exitCode === null && child.signalCode === null || groupAlive()) && Date.now() < gracefulDeadline) await delay(100);
    let forced = false;
    if (child.exitCode === null && child.signalCode === null || groupAlive()) {
      forced = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      const terminateDeadline = Date.now() + 2_000;
      while ((child.exitCode === null && child.signalCode === null || groupAlive()) && Date.now() < terminateDeadline) await delay(100);
    }
    if (child.exitCode === null && child.signalCode === null || groupAlive()) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      const killDeadline = Date.now() + 5_000;
      while ((child.exitCode === null && child.signalCode === null || groupAlive()) && Date.now() < killDeadline) await delay(100);
    }
    record.cleanupComplete = (child.exitCode !== null || child.signalCode !== null) && !groupAlive();
    record.exitedGracefully = record.cleanupComplete && !forced;
    if (!record.cleanupComplete || forced) record.passed = false;
    try {
      assert(record.cleanupComplete && !forced, "Owned fixture did not finish graceful cleanup");
      if (beforeQuit) {
        record.closedStorage = inspectPrivateCredentialStorage(fixture, { phase: "postquit", expected: beforeQuit });
        record.credentialsPreservedOnQuit = true;
      }
    } catch (error) {
      record.passed = false;
      failure ??= error;
    } finally {
      record.finishedAt = now();
      record.elapsedMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
      writeFileSync(join(evidence, `attempt-${attempt}-${name}.log`), output, { mode: 0o600 });
    }
  }
  if (failure) throw failure;
  return record.closedStorage;
}

const slot = "xaiApiKey", syntheticKey = `synthetic-fixture-${randomBytes(12).toString("hex")}`;
const status = `(async () => { const response = await fetch('/api/config'); const body = await response.json();
  return { status: response.status, configured: body.xai?.configured === true,
    leaked: JSON.stringify(body).includes(${JSON.stringify(syntheticKey)}) }; })()`;
const credentialFile = join(profile, "private-credentials/credentials.json");
const configured = async evaluate => {
  const result = await evaluate(status);
  assert.deepEqual(result, { status: 200, configured: true, leaked: false });
};
const unconfigured = async evaluate => {
  const result = await evaluate(status);
  assert.deepEqual(result, { status: 200, configured: false, leaked: false });
};
try {
  assert.equal(process.platform, "darwin");
  safeRun("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  verifyPrivateBrowserFuse({ platform: "darwin", versions: { electron: "43.7.9" }, execPath: executable });
  safeRun("/usr/bin/sandbox-exec", ["-f", sandbox, "/usr/bin/true"]);
  assert.notEqual(spawnSync("/usr/bin/sandbox-exec", ["-f", sandbox, "/bin/cat", canary]).status, 0);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  env.OMB_WEBHOOK_PORT = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const saved = await phase("write", { state: "absent" }, async evaluate => {
    assert.equal(await evaluate(`window.ogb.setCredential(${JSON.stringify(slot)}, ${JSON.stringify(syntheticKey)}).then(() => true)`), true);
    await configured(evaluate);
    assert.equal(await evaluate("(() => { document.cookie = 'omb_private_fixture=synthetic-only; SameSite=Lax; Max-Age=3600'; return document.cookie.includes('omb_private_fixture=synthetic-only') })()"), true);
    assert.equal(JSON.parse(readFileSync(credentialFile, "utf8")).value[slot], syntheticKey);
  });
  const cleared = await phase("restore-and-clear", saved, async (evaluate, until) => {
    await until(async () => { const result = await evaluate(status); return result.status === 200 && result.configured && !result.leaked; },
      "fresh packaged server restored redacted configured status", 15_000);
    receipt.freshServerRestoredBeforeClear = true;
    assert.equal(await evaluate("document.cookie.includes('omb_private_fixture=synthetic-only')"), true);
    assert.equal(JSON.parse(readFileSync(credentialFile, "utf8")).value[slot], syntheticKey);
    assert.equal(await evaluate(`window.ogb.setCredential(${JSON.stringify(slot)}, '').then(() => true)`), true);
    await unconfigured(evaluate);
    assert.equal(await evaluate("(() => { document.cookie = 'omb_private_fixture=; Max-Age=0'; return !document.cookie.includes('omb_private_fixture=') })()"), true);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(credentialFile, "utf8")).value, slot), false);
  });
  await phase("verify-forgotten", cleared, async evaluate => {
    await unconfigured(evaluate);
    assert.equal(await evaluate("!document.cookie.includes('omb_private_fixture=')"), true);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(credentialFile, "utf8")).value, slot), false);
    receipt.freshProcessForgotten = true;
  });
  for (const name of oldNames) assert.equal(sha(readFileSync(join(profile, name))), oldHashes[name]);
  assert(receipt.freshServerRestoredBeforeClear && receipt.freshProcessForgotten);
  receipt.oldCiphertextPreserved = oldNames.length;
  receipt.passed = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  receipt.finishedAt = now();
  receipt.attemptElapsedMs = Date.now() - attemptStartedAtMs;
  receipt.totalElapsedMs = Date.now() - attempts.firstStartedAtMs;
  Object.assign(receipt, finishOwnedPrivateFixture(fixture, receipt.phases));
  if (!receipt.fixtureRemoved) receipt.passed = false;
  attempts.attempts.push({ attempt, startedAt, finishedAt: receipt.finishedAt,
    attemptElapsedMs: receipt.attemptElapsedMs, totalElapsedMs: receipt.totalElapsedMs, passed: receipt.passed });
  writeFileSync(attemptsPath, JSON.stringify(attempts, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(join(evidence, `attempt-${attempt}-receipt.json`), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ passed: receipt.passed, attempt, attemptElapsedMs: receipt.attemptElapsedMs,
    totalElapsedMs: receipt.totalElapsedMs,
    phases: receipt.phases.map(phase => ({ name: phase.name, passed: phase.passed, elapsedMs: phase.elapsedMs })), evidence }));
}
