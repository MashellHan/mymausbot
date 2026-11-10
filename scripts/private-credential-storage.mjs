import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const MARK = Buffer.from("openmausbot-private-credentials-v1\n");
const inside = (parent, child) => child === parent || (!relative(parent, child).startsWith("..") && !isAbsolute(relative(parent, child)));
const owned = (path, directory) => {
  const found = lstatSync(path, { bigint: true });
  assert.equal(found.uid, BigInt(process.getuid()));
  assert.equal(found.mode & 0o777n, directory ? 0o700n : 0o600n);
  assert(directory ? found.isDirectory() : found.isFile() && found.nlink === 1n);
  return found;
};

function fileHash(path) {
  const before = owned(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert.equal(opened.dev, before.dev);
    assert.equal(opened.ino, before.ino);
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(1024 * 1024);
    for (let count; (count = readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, count));
    const after = fstatSync(fd, { bigint: true });
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

export function inspectPrivateCredentialStorage(fixtureRoot, { phase, expected } = {}) {
  assert(["prelaunch", "postlaunch"].includes(phase));
  const temporary = realpathSync(tmpdir());
  const root = realpathSync(fixtureRoot);
  assert(basename(root).startsWith("omb-private-file-e2e-") && inside(temporary, root));
  owned(root, true);
  const profile = join(root, "profile");
  owned(profile, true);
  assert.equal(realpathSync(profile), resolve(profile));
  const privateRoot = join(profile, "private-credentials");
  const marker = join(profile, "private-credentials.ready");
  const privateExists = (() => { try { lstatSync(privateRoot); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } })();
  const markerExists = (() => { try { lstatSync(marker); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } })();
  assert.equal(privateExists, markerExists);
  if (!privateExists) {
    assert.equal(phase, "prelaunch", "Private credential root is missing after launch");
    const result = { state: "absent" };
    if (expected !== undefined) assert.deepEqual(result, expected);
    return result;
  }
  owned(privateRoot, true);
  const browser = join(privateRoot, "browser-session");
  owned(browser, true);
  assert.equal(fileHash(marker), createHash("sha256").update(MARK).digest("hex"));
  const records = {};
  const browserEntries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = lstatSync(path, { bigint: true });
      assert.equal(info.uid, BigInt(process.getuid()));
      const inBrowser = inside(browser, path);
      const key = relative(privateRoot, path).replaceAll("\\", "/");
      if (info.isSymbolicLink()) {
        assert(inBrowser);
        browserEntries.push({ path: key, kind: "symlink", target: phase === "prelaunch" ? readlinkSync(path) : undefined });
      } else if (info.isDirectory()) {
        owned(path, true);
        if (inBrowser) browserEntries.push({ path: key, kind: "directory" });
        walk(path);
      } else {
        owned(path, false);
        const row = { path: key, kind: "file", size: Number(info.size) };
        if (inBrowser) browserEntries.push(phase === "prelaunch" ? { ...row, sha256: fileHash(path) } : row);
        else records[key] = fileHash(path);
      }
    }
  };
  walk(privateRoot);
  const result = { state: "present", markerSha256: fileHash(marker), records,
    browserEntries: phase === "prelaunch" ? browserEntries : browserEntries.length };
  if (expected !== undefined) {
    assert.equal(phase, "prelaunch");
    assert.deepEqual(result, expected);
  }
  return result;
}
