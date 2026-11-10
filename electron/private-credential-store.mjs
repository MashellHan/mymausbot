import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;
const MARK = "openmausbot-private-credentials-v1\n";
const unsafe = () => new Error("Private credential storage is unsafe or unreadable");
const owner = process.getuid?.();
const noFollow = fs.constants.O_NOFOLLOW;

function inspect(files, target, kind, mode) {
  let stat;
  try { stat = files.lstatSync(target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (owner === undefined || typeof noFollow !== "number" || stat.uid !== owner ||
      (stat.mode & 0o777) !== mode ||
      (kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES)) throw unsafe();
  return stat;
}

function readFile(files, file) {
  const before = inspect(files, file, "file", 0o600);
  if (!before) return null;
  const fd = files.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = files.fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.uid !== owner ||
        !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) throw unsafe();
    const bytes = files.readFileSync(fd);
    if (bytes.length > MAX_BYTES) throw unsafe();
    return bytes;
  } finally { files.closeSync(fd); }
}

function writeAtomic(files, file, bytes) {
  if (bytes.length > MAX_BYTES) throw unsafe();
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = files.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    files.writeFileSync(fd, bytes);
    files.fsyncSync(fd);
    files.closeSync(fd);
    fd = undefined;
    inspect(files, file, "file", 0o600);
    files.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) files.closeSync(fd);
    try { files.unlinkSync(temporary); } catch {}
  }
}

function directory(files, target, create) {
  if (create) {
    try { files.mkdirSync(target, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  if (!inspect(files, target, "directory", 0o700)) throw unsafe();
}

/** File mode is opt-in; its browser profile and credential files never enter the legacy encrypted profile. */
export function preparePrivateCredentialStorage(userData, files = fs) {
  const root = inspect(files, userData, "directory", files.lstatSync(userData).mode & 0o777);
  if (!root || (root.mode & 0o022) !== 0) throw unsafe();
  const privateDir = path.join(userData, "private-credentials");
  const browserDir = path.join(privateDir, "browser-session");
  const anchor = path.join(userData, "private-credentials.ready");
  const saved = readFile(files, anchor);
  if (saved && !saved.equals(Buffer.from(MARK))) throw unsafe();
  if (!saved) {
    const existing = inspect(files, privateDir, "directory", 0o700);
    if (existing && files.readdirSync(privateDir).length) throw unsafe();
    if (!existing) directory(files, privateDir, true);
    directory(files, browserDir, true);
    writeAtomic(files, anchor, Buffer.from(MARK));
  } else {
    directory(files, privateDir, false);
    directory(files, browserDir, false);
  }
  return { directory: privateDir, browserSessionData: browserDir };
}

export function createPrivateCredentialStore(privateDir, name, files = fs) {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw unsafe();
  const file = path.join(privateDir, name);
  const mark = `${file}.seen`;
  const checkParent = () => {
    const root = inspect(files, path.dirname(privateDir), "directory", files.lstatSync(path.dirname(privateDir)).mode & 0o777);
    if (!root || (root.mode & 0o022) !== 0) throw unsafe();
    directory(files, privateDir, false);
  };
  const read = () => {
    checkParent();
    const seen = readFile(files, mark), bytes = readFile(files, file);
    if (!seen && !bytes) return null;
    if (!seen?.equals(Buffer.from(MARK)) || !bytes) throw unsafe();
    try {
      const record = JSON.parse(bytes.toString("utf8"));
      if (record?.version === 1 && Object.keys(record).length === 2 && Object.hasOwn(record, "value") &&
          (record.value === null || (typeof record.value === "object" && !Array.isArray(record.value)))) return record.value;
    } catch {}
    throw unsafe();
  };
  const write = value => {
    read();
    if (value !== null && (!value || typeof value !== "object" || Array.isArray(value))) throw unsafe();
    if (!readFile(files, mark)) writeAtomic(files, mark, Buffer.from(MARK));
    writeAtomic(files, file, Buffer.from(JSON.stringify({ version: 1, value })));
  };
  let tail = Promise.resolve();
  return {
    async read() { await tail.catch(() => {}); return read(); },
    write(value) {
      const operation = tail.catch(() => {}).then(() => write(value));
      tail = operation;
      return operation;
    },
    async available() { try { read(); return true; } catch { return false; } },
    moveAside() {
      checkParent();
      const bytes = readFile(files, file);
      if (bytes) files.renameSync(file, `${file}.unreadable-${Date.now()}-${randomUUID()}`);
      if (!readFile(files, mark)) writeAtomic(files, mark, Buffer.from(MARK));
      writeAtomic(files, file, Buffer.from(JSON.stringify({ version: 1, value: null })));
    },
  };
}
