import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const databaseNames = ["messages.db", "runtime.db"];
const keychainPath = (path) => path.includes("/Library/Keychains") || path.includes("/private/var/db/Keychains")
  || path.endsWith("/login.keychain") || path.endsWith("/login.keychain-db");
const inside = (parent, child) => child === parent || (!relative(parent, child).startsWith("..") && !isAbsolute(relative(parent, child)));

function file(path) {
  let initial;
  try { initial = lstatSync(path, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  assert(initial.isFile() && initial.uid === BigInt(process.getuid()) && initial.nlink === 1n);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert.equal(opened.dev, initial.dev);
    assert.equal(opened.ino, initial.ino);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, count));
    const final = fstatSync(fd, { bigint: true });
    assert.equal(final.size, initial.size);
    assert.equal(final.mtimeNs, initial.mtimeNs);
    return { size: Number(final.size), sha256: hash.digest("hex"), dev: String(final.dev), ino: String(final.ino),
      mtimeNs: String(final.mtimeNs) };
  } finally { closeSync(fd); }
}

export function assertClosedSqliteCopy(sourceDir, copyDir) {
  const source = realpathSync(sourceDir), copy = realpathSync(copyDir);
  assert.equal(resolve(sourceDir), source);
  assert.equal(resolve(copyDir), copy);
  assert(!keychainPath(source) && !keychainPath(copy) && !inside(source, copy) && !inside(copy, source));
  for (const root of [source, copy]) {
    const info = lstatSync(root, { bigint: true });
    assert(info.isDirectory() && info.uid === BigInt(process.getuid()) && (info.mode & 0o022n) === 0n);
  }
  const names = ["routines.json", ...databaseNames.flatMap(name => [name, `${name}-wal`, `${name}-shm`, `${name}-journal`])];
  const before = Object.fromEntries(names.map(name => [name, file(`${source}/${name}`)]));
  const copied = Object.fromEntries(names.map(name => [name, file(`${copy}/${name}`)]));
  for (const name of ["routines.json", ...databaseNames]) {
    assert(before[name] && copied[name], `${name} is missing`);
    assert.equal(copied[name].sha256, before[name].sha256, `${name} changed in the copy`);
  }
  for (const name of databaseNames) {
    assert(!before[`${name}-journal`] && !copied[`${name}-journal`], `${name} has an unbound rollback journal`);
    const liveWal = before[`${name}-wal`], copiedWal = copied[`${name}-wal`];
    if ((liveWal?.size ?? 0) > 0) {
      assert(copiedWal && copiedWal.size === liveWal.size && copiedWal.sha256 === liveWal.sha256,
        `${name} has a missing or changed meaningful WAL`);
      const liveShm = before[`${name}-shm`], copyShm = copied[`${name}-shm`];
      assert(liveShm && copyShm && liveShm.size === copyShm.size && liveShm.sha256 === copyShm.sha256,
        `${name} has a missing or changed shared-memory index`);
    } else {
      assert((copiedWal?.size ?? 0) === 0, `${name} copy has an unbound WAL`);
    }
  }
  const after = Object.fromEntries(names.map(name => [name, file(`${source}/${name}`)]));
  assert.deepEqual(after, before, "Closed SQLite source changed while its copy was checked");
  return { complete: true, source, copy,
    files: Object.fromEntries(names.filter(name => before[name] || copied[name]).map(name => [name, {
      source: before[name] && { size: before[name].size, sha256: before[name].sha256 },
      copy: copied[name] && { size: copied[name].size, sha256: copied[name].sha256 },
    }])) };
}
