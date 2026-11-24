import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function read(source: LocalAgentRoleSource) {
  const { root, roles, file, agentName, memberNames, runtime } = source;
  if (!inside(root, roles) || dirname(file) !== roles || !/^[a-z][a-z0-9-]*\.md$/.test(basename(file))) return null;
  const canonicalRoot = realpathSync(root);
  if (realpathSync(roles) !== join(canonicalRoot, relative(root, roles))) return null;
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.nlink !== 1 || entry.size > LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES) return null;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
    const prefix = /^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m.exec(full)?.[0] ?? "";
    const startsWithMetadata = /^---(?:\r?\n|$)/.test(full);
    if (startsWithMetadata && (!prefix || !full.startsWith(prefix))) return null;
    const metadata = startsWithMetadata ? prefix : "";
    const sourcePath = realpathSync(file);
    if (sourcePath !== join(canonicalRoot, relative(root, file))) return null;
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

export function saveLocalAgentRoleDocument(source: LocalAgentRoleSource, input: LocalAgentRoleDocumentWrite): LocalAgentRoleSaveResult {
  let temporary: string | undefined;
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
    renameSync(replacement, source.file);
    const saved = read(source);
    return saved ? { status: "saved", doc: saved.doc } : { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
  finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}
