import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { createWorkspaceCredentialSaver } from "./workspace-credential-saver.mjs";
import { createSessionWorkspaceCredentials } from "./session-workspace-credentials.mjs";
import { createPrivateCredentialStore, preparePrivateCredentialStorage } from "./private-credential-store.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const start = main.indexOf("async function loadSecureCredentials()"), end = main.indexOf("\nasync function secureComposioConfig()", start);
assert(start >= 0 && end > start);
const source = main.slice(start, end) + "\nglobalThis.credentialFns = { loadSecureCredentials, saveSecureCredentials };";

test("session mode skips every credentials.bin and safeStorage operation while keeping old bytes", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-session-main-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "credentials.bin"), old = Buffer.from("synthetic old encrypted credentials");
  writeFileSync(file, old);
  const forbidden = new Proxy({}, { get: (_target, name) => { throw new Error(`unexpected access: ${String(name)}`); } });
  const context = vm.createContext({ SESSION_CREDENTIALS: true, PRIVATE_FILE_CREDENTIALS: false, credentialStoreUnavailable: false, CREDENTIALS_FILE: file,
    fs: forbidden, safeStorage: forbidden, readSecureCredentials: forbidden, path, process, slog: () => {} });
  vm.runInContext(source, context);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.credentialFns.loadSecureCredentials())), {});
  await context.credentialFns.saveSecureCredentials({ newKey: "only in memory" });
  assert.deepEqual(readFileSync(file), old);
});

test("normal mode still reads and writes through the existing encrypted store", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-secure-main-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "credentials.bin");
  writeFileSync(file, Buffer.from(JSON.stringify({ old: "synthetic-key" })));
  let availability = 0, decrypts = 0, encrypts = 0;
  const safeStorage = { isAsyncEncryptionAvailable: async () => { availability++; return true; },
    decryptStringAsync: async value => { decrypts++; return { shouldReEncrypt: false, result: value.toString() }; },
    encryptStringAsync: async value => { encrypts++; return Buffer.from(value); } };
  const context = vm.createContext({ SESSION_CREDENTIALS: false, PRIVATE_FILE_CREDENTIALS: false, credentialStoreUnavailable: false, CREDENTIALS_FILE: file,
    fs, safeStorage, readSecureCredentials, path, process, slog: () => {} });
  vm.runInContext(source, context);
  assert.deepEqual(await context.credentialFns.loadSecureCredentials(), { old: "synthetic-key" });
  await context.credentialFns.saveSecureCredentials({ next: "synthetic-key" });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { next: "synthetic-key" });
  assert.equal(availability, 2);
  assert.equal(decrypts, 1);
  assert.equal(encrypts, 1);
});

test("private file mode restores desktop keys in a new process without touching old ciphertext or safeStorage", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-private-main-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "credentials.bin"), old = Buffer.from("old synthetic encrypted credentials");
  writeFileSync(file, old);
  const { directory } = preparePrivateCredentialStorage(root);
  const forbidden = new Proxy({}, { get: (_target, name) => { throw new Error(`unexpected access: ${String(name)}`); } });
  const launch = () => {
    const context = vm.createContext({ SESSION_CREDENTIALS: false, PRIVATE_FILE_CREDENTIALS: true,
      privateWorkspaceCredentials: createPrivateCredentialStore(directory, "credentials.json"),
      credentialStoreUnavailable: false, CREDENTIALS_FILE: file,
      fs: forbidden, safeStorage: forbidden, readSecureCredentials: forbidden, path, process, slog: () => {} });
    vm.runInContext(source, context);
    return context;
  };
  const first = launch();
  assert.deepEqual(JSON.parse(JSON.stringify(await first.credentialFns.loadSecureCredentials())), {});
  await first.credentialFns.saveSecureCredentials({ provider: "synthetic-private-key" });
  const second = launch();
  assert.deepEqual(await second.credentialFns.loadSecureCredentials(), { provider: "synthetic-private-key" });
  assert.deepEqual(readFileSync(file), old);
  writeFileSync(path.join(directory, "credentials.json"), "broken JSON");
  const third = launch();
  assert.deepEqual(JSON.parse(JSON.stringify(await third.credentialFns.loadSecureCredentials())), {});
  assert.equal(third.credentialStoreUnavailable, true);
  await assert.rejects(third.credentialFns.saveSecureCredentials({ provider: "synthetic-new" }), /could not be read/);
  assert.deepEqual(readFileSync(file), old);
});

test("provider key saves commit after server acceptance and roll back a failed update in private file mode", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-private-provider-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const { directory } = preparePrivateCredentialStorage(root);
  const file = createPrivateCredentialStore(directory, "credentials.json");
  const state = createSecureCredentialState({}, credentials => file.write(credentials));
  const requests = [];
  let accept = true;
  const saver = createWorkspaceCredentialSaver({ packaged: () => true, sessionOnly: false,
    encryptionAvailable: () => file.available(), dataDir: () => root, switching: () => false,
    ready: () => true, port: () => 43210, headers: () => ({ "x-openmausbot-desktop-owner": "synthetic" }),
    sessionState: () => { throw new Error("session state was used"); },
    secureUpdate: (derive, afterPersist) => state.update(derive, afterPersist),
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: accept, status: accept ? 200 : 503, json: async () => accept ? { xai: { configured: true } } : { error: "server unavailable" } };
    },
  });
  await saver.save("xaiApiKey", "synthetic-first");
  assert.equal(requests[0].url, "http://127.0.0.1:43210/api/config?secretStorage=external");
  assert.deepEqual(JSON.parse(requests[0].options.body), { xai: { key: "synthetic-first" } });
  assert.deepEqual(await createPrivateCredentialStore(directory, "credentials.json").read(), { xaiApiKey: "synthetic-first" });
  accept = false;
  await assert.rejects(saver.save("xaiApiKey", "synthetic-rejected"), /server unavailable/);
  assert.deepEqual(await createPrivateCredentialStore(directory, "credentials.json").read(), { xaiApiKey: "synthetic-first" });
});

test("desktop credential IPC uses external session config and rolls back a failed server save", async t => {
  const root = mkdtempSync(path.join(tmpdir(), "omb-session-ipc-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "credentials.bin"), old = Buffer.from("old synthetic encrypted credentials");
  writeFileSync(file, old);
  const requests = [];
  let accept = true, dataDir = "environment-a";
  const sessionWorkspaceCredentials = createSessionWorkspaceCredentials();
  const globalIdentity = { phoneSecretPrivateKey: "synthetic-app-identity" };
  const saver = createWorkspaceCredentialSaver({ packaged: () => true, sessionOnly: true,
    encryptionAvailable: () => { throw new Error("safeStorage was accessed"); },
    dataDir: () => dataDir, switching: () => false, ready: () => true, port: () => 43210,
    headers: () => ({ "x-openmausbot-desktop-owner": "synthetic" }),
    sessionState: (dir) => sessionWorkspaceCredentials.state(dir),
    secureUpdate: () => { throw new Error("App-global credential state was accessed"); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: accept, status: accept ? 200 : 503, json: async () => accept ? { xai: { configured: true } } : { error: "server unavailable" } };
    },
  });
  await saver.save("xaiApiKey", " new-session-key ");
  assert.equal(sessionWorkspaceCredentials.forServer("environment-a", globalIdentity).xaiApiKey, "new-session-key");
  assert.deepEqual(sessionWorkspaceCredentials.forServer("environment-b", globalIdentity), globalIdentity);
  assert.equal(requests[0].url, "http://127.0.0.1:43210/api/config?secretStorage=external");
  assert.deepEqual(JSON.parse(requests[0].options.body), { xai: { key: "new-session-key" } });
  accept = false;
  await assert.rejects(saver.save("xaiApiKey", "rejected-session-key"), /server unavailable/);
  assert.equal(sessionWorkspaceCredentials.forServer("environment-a", globalIdentity).xaiApiKey, "new-session-key");
  dataDir = "environment-b";
  assert.deepEqual(sessionWorkspaceCredentials.forServer("environment-b", globalIdentity), globalIdentity);
  assert.equal(sessionWorkspaceCredentials.forServer("environment-a", globalIdentity).xaiApiKey, "new-session-key", "recovery retains A without seeding B");
  assert.deepEqual(readFileSync(file), old);
});
