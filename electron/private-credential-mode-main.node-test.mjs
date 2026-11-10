import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { createAppBrowserSession } from "./browser-session.mjs";
import { createDesktopPrefs, jsonFile } from "./desktop-prefs.mjs";
import { createPrivateCredentialStore, preparePrivateCredentialStorage } from "./private-credential-store.mjs";

const main = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const start = main.indexOf("const CREDENTIALS_FILE ="), end = main.indexOf("\nconst nativeText =", start);
assert(start >= 0 && end > start);
const source = `${main.slice(start, end)}\nglobalThis.selected = { CREDENTIAL_MODE, browserSession };`;

test("private file mode selects protected persistent browser data before the browser session is used", t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "omb-private-startup-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const preference = path.join(userData, "desktop-prefs.json");
  fs.writeFileSync(preference, JSON.stringify({ credentialMode: "private-file" }), { mode: 0o600 });
  const calls = [];
  const existing = { id: "persistent" };
  const launch = () => {
    const context = vm.createContext({ fs, path, createDesktopPrefs, jsonFile, createPrivateCredentialStore,
      preparePrivateCredentialStorage, createAppBrowserSession, createSessionConfigMemory: () => ({}),
      process: { umask: mode => calls.push(["umask", mode]) },
      app: { getPath: name => { assert.equal(name, "userData"); return userData; },
        setPath: (name, value) => calls.push([name, value]) },
      session: { defaultSession: existing, fromPartition: () => { throw new Error("unexpected session partition"); } } });
    vm.runInContext(source, context);
    return context.selected;
  };
  const chosen = launch();
  assert.equal(chosen.CREDENTIAL_MODE, "private-file");
  assert.equal(chosen.browserSession(), existing);
  assert.deepEqual(calls, [["umask", 0o077], ["sessionData", path.join(userData, "private-credentials", "browser-session")]]);
  assert.equal(fs.statSync(calls[1][1]).mode & 0o777, 0o700);

  fs.writeFileSync(preference, "invalid JSON");
  assert.throws(launch, /Private credential mode must be selected/);
  fs.writeFileSync(preference, JSON.stringify({ credentialMode: "session" }));
  assert.equal(launch().CREDENTIAL_MODE, "session");
});

test("Cloud and company grants select distinct private files without asking safeStorage", () => {
  const first = main.indexOf("const cloudEncryption ="), last = main.indexOf("\nfunction ensureCloudAccount()", first);
  assert(first >= 0 && last > first);
  const names = [];
  const forbidden = new Proxy({}, { get: (_target, name) => { throw new Error(`unexpected access: ${String(name)}`); } });
  const context = vm.createContext({ PRIVATE_FILE_CREDENTIALS: true, SESSION_CREDENTIALS: false,
    safeStorage: forbidden, createManagedDesktopStore: forbidden,
    privateCredentialStore: name => { names.push(name); return { name }; },
    cloudTarget: () => ({ file: "cloud-account.bin" }), process: { env: {}, platform: "darwin" }, path, app: forbidden });
  vm.runInContext(`${main.slice(first, last)}\nglobalThis.stores = { credentialRecordStore, cloudAccountStore };`, context);
  assert.equal(context.stores.cloudAccountStore().name, "cloud-account.json");
  assert.equal(context.stores.credentialRecordStore("company-connection.bin", forbidden).name, "company-connection.json");
  assert.equal(context.stores.credentialRecordStore("company-library.bin", forbidden).name, "company-library.json");
  assert.equal(context.stores.credentialRecordStore("company-backup-schedule.bin", forbidden).name, "company-backup-schedule.json");
  assert.deepEqual(names, ["cloud-account.json", "company-connection.json", "company-library.json", "company-backup-schedule.json"]);
});
