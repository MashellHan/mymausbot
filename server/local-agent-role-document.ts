import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES, type LocalAgentRoleDocument,
  type LocalAgentRoleDocumentWrite, type LocalAgentRoleSaveResult } from "../shared/local-dashboard.ts";
import { inside } from "./local-agent-association.ts";

export interface LocalAgentRoleSource {
  root: string;
  roles: string;
  file: string;
  agentName: string;
  memberNames: string[];
  runtime: string;
}

export type RoleFileExchange = (current: string, staged: string) => void;

// macOS renamex_np with RENAME_SWAP exchanges both paths in one filesystem operation.
const RENAME_SWAP = `ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'uint32']]);
function run(args) { if ($.renamex_np(args[0], args[1], 2) !== 0) throw Error('Could not exchange role files.'); }`;

const exchangeLocalRoleFiles: RoleFileExchange = (current, staged) => {
  if (process.platform !== "darwin") throw new Error("Atomic role editing requires macOS.");
  execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", RENAME_SWAP, current, staged], { timeout: 5000, stdio: "ignore" });
};

export function roleFrontMatter(text: string): string | null {
  if (!/^---(?:\r?\n|$)/.test(text)) return "";
  return /^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m.exec(text)?.[0] ?? null;
}

function read(source: LocalAgentRoleSource, fileToRead = source.file) {
  const { root, roles, file, agentName, memberNames, runtime } = source;
  if (!inside(root, roles) || dirname(file) !== roles || !/^[a-z][a-z0-9-]*\.md$/.test(basename(file))) return null;
  const canonicalRoot = realpathSync(root);
  if (realpathSync(roles) !== join(canonicalRoot, relative(root, roles))) return null;
  const entry = lstatSync(fileToRead);
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES) return null;
  const fd = openSync(fileToRead, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== entry.dev || stat.ino !== entry.ino || stat.size !== entry.size) return null;
    const content = Buffer.alloc(stat.size);
    for (let offset = 0; offset < content.length;) {
      const bytesRead = readSync(fd, content, offset, content.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const checked = fstatSync(fd);
    if (checked.size !== stat.size || checked.mtimeMs !== stat.mtimeMs || checked.ctimeMs !== stat.ctimeMs) return null;
    const full = content.toString("utf8");
    if (!Buffer.from(full).equals(content) || full.includes("\0")) return null;
    const metadata = roleFrontMatter(full);
    if (metadata === null) return null;
    const sourcePath = join(canonicalRoot, relative(root, file));
    if (realpathSync(fileToRead) !== (fileToRead === file ? sourcePath : fileToRead)) return null;
    const doc: LocalAgentRoleDocument = { file: relative(root, file).split("\\").join("/"), sourcePath, agentName, memberNames, runtime,
      documentId: createHash("sha256").update(sourcePath).digest("hex"),
      text: full.slice(metadata.length), hash: createHash("sha256")
        .update(JSON.stringify([sourcePath, stat.dev, stat.ino])).update(content).digest("hex") };
    return { doc, metadata, mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}

export function getLocalAgentRoleDocument(source: LocalAgentRoleSource): LocalAgentRoleDocument | null {
  try { return read(source)?.doc ?? null; }
  catch { return null; }
}

export function saveLocalAgentRoleDocument(source: LocalAgentRoleSource, input: LocalAgentRoleDocumentWrite,
  exchange: RoleFileExchange = exchangeLocalRoleFiles): LocalAgentRoleSaveResult {
  if (exchange === exchangeLocalRoleFiles && process.platform !== "darwin") return { status: "unavailable" };
  let temporary: string | undefined;
  let removeStaging = true;
  try {
    const current = read(source);
    if (!current || current.doc.documentId !== input.documentId) return { status: "unavailable" };
    if (current.doc.hash !== input.expectedHash) return { status: "conflict", doc: current.doc };
    if (current.doc.text === input.text) return { status: "saved", doc: current.doc };
    if (!current.metadata && /^---(?:\r?\n|$)/.test(input.text)) return { status: "unavailable" };
    const separator = current.metadata.endsWith("---") && input.text ? "\n" : "";
    const text = current.metadata + separator + input.text;
    const bytes = Buffer.from(text);
    if (bytes.length > LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES || bytes.toString("utf8") !== text || text.includes("\0")) return { status: "unavailable" };
    temporary = mkdtempSync(join(realpathSync(source.roles), ".agent-md-"));
    const replacement = join(temporary, "role.md");
    writeFileSync(replacement, bytes, { flag: "wx", mode: current.mode });
    chmodSync(replacement, current.mode);
    const latest = read(source);
    if (!latest) return { status: "unavailable" };
    if (latest.doc.hash !== input.expectedHash) return { status: "conflict", doc: latest.doc };
    const draft = read(source, replacement);
    if (!draft) return { status: "unavailable" };
    removeStaging = false;
    try { exchange(current.doc.sourcePath, replacement); }
    catch { /* Inspect both paths in case the exchange completed before the subprocess exited. */ }
    const installed = read(source);
    const previous = read(source, replacement);
    if (previous?.doc.hash === draft.doc.hash && installed?.doc.hash === input.expectedHash) {
      removeStaging = true;
      return { status: "unavailable" };
    }
    if (previous?.doc.hash === input.expectedHash) {
      removeStaging = true;
      if (installed?.doc.hash === draft.doc.hash) return { status: "saved", doc: installed.doc };
    } else if (installed?.doc.hash === draft.doc.hash) {
      try { exchange(current.doc.sourcePath, replacement); }
      catch { /* Read back the source and keep the displaced bytes if restoration is incomplete. */ }
      removeStaging = read(source, replacement)?.doc.hash === draft.doc.hash;
    }
    const conflict = getLocalAgentRoleDocument(source);
    return conflict ? { status: "conflict", doc: conflict } : { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
  finally {
    try { if (temporary && removeStaging) rmSync(temporary, { recursive: true, force: true }); }
    catch { /* A temporary cleanup failure must not change the result of a committed save. */ }
  }
}
