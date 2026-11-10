import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPrivateCredentialStore, preparePrivateCredentialStorage } from "./private-credential-store.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-private-credentials-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, "user-data");
  fs.mkdirSync(userData, { mode: 0o700 });
  return { root, userData };
}

test("private files survive a new store instance and deliberate forget, apart from old ciphertext", async t => {
  const { userData } = fixture(t);
  const old = Buffer.from("old synthetic ciphertext");
  for (const name of ["credentials.bin", "cloud-account.bin", "company-connection.bin"]) fs.writeFileSync(path.join(userData, name), old);
  const paths = preparePrivateCredentialStorage(userData);
  assert.equal(fs.statSync(paths.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.browserSessionData).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(userData, "private-credentials.ready")).mode & 0o777, 0o600);
  const first = createPrivateCredentialStore(paths.directory, "credentials.json");
  assert.equal(await first.read(), null);
  await first.write({ provider: "synthetic-new-secret" });
  const file = path.join(paths.directory, "credentials.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${file}.seen`).mode & 0o777, 0o600);
  assert.deepEqual(await createPrivateCredentialStore(paths.directory, "credentials.json").read(), { provider: "synthetic-new-secret" });
  const cloud = createPrivateCredentialStore(paths.directory, "cloud-account.json");
  await cloud.write({ token: "synthetic-cloud" });
  await first.write(null);
  assert.equal(await createPrivateCredentialStore(paths.directory, "credentials.json").read(), null);
  assert.deepEqual(await cloud.read(), { token: "synthetic-cloud" });
  for (const name of ["credentials.bin", "cloud-account.bin", "company-connection.bin"]) assert.deepEqual(fs.readFileSync(path.join(userData, name)), old);
});

test("corruption and a missing previously created file stay unavailable until an explicit reset", async t => {
  const { userData } = fixture(t);
  const { directory } = preparePrivateCredentialStorage(userData);
  const store = createPrivateCredentialStore(directory, "credentials.json");
  await store.write({ token: "synthetic-first" });
  const file = path.join(directory, "credentials.json");
  fs.writeFileSync(file, "broken JSON");
  await assert.rejects(store.read(), /unsafe or unreadable/);
  await assert.rejects(store.write({ token: "synthetic-second" }), /unsafe or unreadable/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken JSON");
  store.moveAside();
  assert.equal(await createPrivateCredentialStore(directory, "credentials.json").read(), null);
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith("credentials.json.unreadable-")).length, 1);
  await store.write({ token: "synthetic-third" });
  fs.unlinkSync(file);
  await assert.rejects(createPrivateCredentialStore(directory, "credentials.json").read(), /unsafe or unreadable/);
  await assert.rejects(store.write({ token: "synthetic-fourth" }), /unsafe or unreadable/);
  assert.equal(fs.existsSync(file), false);
});

test("explicit reset preserves a malformed marker and its credential before replacing both", async t => {
  const { userData } = fixture(t);
  const { directory } = preparePrivateCredentialStorage(userData);
  const store = createPrivateCredentialStore(directory, "credentials.json");
  await store.write({ token: "synthetic-original" });
  const file = path.join(directory, "credentials.json"), marker = `${file}.seen`;
  const original = fs.readFileSync(file);
  fs.writeFileSync(marker, "malformed marker");
  await assert.rejects(store.read(), /unsafe or unreadable/);
  store.moveAside();
  assert.equal(await createPrivateCredentialStore(directory, "credentials.json").read(), null);
  const movedFile = fs.readdirSync(directory).find(name => name.startsWith("credentials.json.unreadable-"));
  const movedMarker = fs.readdirSync(directory).find(name => name.startsWith("credentials.json.seen.unreadable-"));
  assert.deepEqual(fs.readFileSync(path.join(directory, movedFile)), original);
  assert.equal(fs.readFileSync(path.join(directory, movedMarker), "utf8"), "malformed marker");
  await store.write({ token: "synthetic-new" });
  assert.deepEqual(await createPrivateCredentialStore(directory, "credentials.json").read(), { token: "synthetic-new" });
});

test("symlinks, broad permissions, missing browser storage and unsafe parent paths fail closed", async t => {
  const { root, userData } = fixture(t);
  const { directory, browserSessionData } = preparePrivateCredentialStorage(userData);
  const store = createPrivateCredentialStore(directory, "credentials.json");
  await store.write({ token: "synthetic" });
  const file = path.join(directory, "credentials.json");
  fs.chmodSync(file, 0o644);
  await assert.rejects(store.read(), /unsafe or unreadable/);
  fs.chmodSync(file, 0o600);
  const wrongOwner = { ...fs, fstatSync: fd => new Proxy(fs.fstatSync(fd), {
    get: (stat, key) => key === "uid" ? stat.uid + 1 : Reflect.get(stat, key, stat),
  }) };
  await assert.rejects(createPrivateCredentialStore(directory, "credentials.json", wrongOwner).read(), /unsafe or unreadable/);
  fs.linkSync(file, `${file}.hardlink`);
  await assert.rejects(store.read(), /unsafe or unreadable/);
  fs.unlinkSync(`${file}.hardlink`);
  fs.renameSync(file, `${file}.original`);
  fs.symlinkSync(`${file}.original`, file);
  await assert.rejects(store.read(), /unsafe or unreadable/);
  fs.unlinkSync(file);
  fs.renameSync(`${file}.original`, file);
  fs.rmSync(browserSessionData, { recursive: true });
  assert.throws(() => preparePrivateCredentialStorage(userData), /unsafe or unreadable/);
  fs.mkdirSync(browserSessionData, { mode: 0o700 });
  fs.chmodSync(userData, 0o777);
  assert.throws(() => preparePrivateCredentialStorage(userData), /unsafe or unreadable/);
  fs.chmodSync(userData, 0o700);
  fs.renameSync(directory, `${directory}.original`);
  fs.symlinkSync(`${directory}.original`, directory);
  assert.throws(() => preparePrivateCredentialStorage(userData), /unsafe or unreadable/);
  fs.unlinkSync(directory);
  fs.rmSync(`${directory}.original`, { recursive: true });
  assert.throws(() => preparePrivateCredentialStorage(userData), /unsafe or unreadable/);
  assert.throws(() => createPrivateCredentialStore(directory, "../escape.json"), /unsafe or unreadable/);
  assert.equal(fs.existsSync(path.join(root, "escape.json")), false);
});

test("a failed atomic rename leaves the last whole credential record", async t => {
  const { userData } = fixture(t);
  const { directory } = preparePrivateCredentialStorage(userData);
  const file = path.join(directory, "credentials.json");
  await createPrivateCredentialStore(directory, "credentials.json").write({ token: "synthetic-old" });
  const original = fs.readFileSync(file);
  const broken = { ...fs, renameSync: (from, to) => { if (to === file) throw new Error("synthetic disk failure"); fs.renameSync(from, to); } };
  await assert.rejects(createPrivateCredentialStore(directory, "credentials.json", broken).write({ token: "synthetic-new" }), /synthetic disk failure/);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(await createPrivateCredentialStore(directory, "credentials.json").read(), { token: "synthetic-old" });
  assert.equal(fs.readdirSync(directory).filter(name => name.endsWith(".tmp")).length, 0);
});
