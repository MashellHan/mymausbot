import { parse, type CallExpression, type Expression, type Literal, type ObjectExpression, type Statement } from "acorn";
import type { LocalAgentActivityEvent, LocalAgentToolDetailStatus } from "../shared/local-dashboard.ts";
import { mask, redactSecretsInText } from "../shared/redact.ts";
import { escapeNotes } from "./peer-provenance.ts";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const VISIBLE_PHASES = new Set(["commentary", "final_answer", "final"]);
const INTERNAL_ENVELOPE = /<\/?(?:SYSTEM_(?:MESSAGE|NOTIFICATION)|(?:teammate|agent|task|coordinator)[_-](?:message|notification|envelope)|system[_-]reminder)\b/i;
const TOOL_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const PRIVATE_TOOL_KEY = /(?:auth(?!or)|base64|binary|body|cookie|credential|data|env|header|image|key|passwd|password|private|secret|session|token)|^sid$/i;
const TOOL_ASSIGNMENT = /"([^"\n]{1,128})"\s*[:=]|\b([A-Za-z][A-Za-z0-9_.-]*(?:[ \t]+(?:id|key|token|data|value))?)['"]?\s*[:=]/gi;
const TOOL_FIELD_VALUE = /^\s*(?:"([^"]{1,256})"|'([^']{1,256})'|([A-Za-z0-9_-]+))/;
const EXEC_COMPOUND_ASSIGNMENT = /(?:\?\?|\|\||&&|>>>?|<<|\*\*|[-+*/%&|^])=/;
const EXEC_COMMENT_BEFORE_ASSIGNMENT = /(?:\*\/|\/\/[^\r\n\u2028\u2029]*[\r\n\u2028\u2029])\s*[:=]/;
const EXEC_DECLARATION_LITERAL = /^\s*(["'`])([A-Za-z0-9 ._-]{1,128})\1\s*(?=$|[,;}\])])/;
const PRIVATE_HEADER_NAME = /^(?:(?:set-)?cookie|(?:proxy-)?authorization|x-(?:api-key|auth-token|access-token|session-id))$/i;
const BASE64_ENCODING = /^base64(?:-?url)?$/i;
const ENCODED_TOOL_TEXT = /data:[^\s,]{0,100};base64,|[A-Za-z0-9+/_-]{64,}={0,2}/i;
const MAX_TOOL_SOURCE = 16 * 1024;
const MAX_TOOL_FIELDS = 8;
const MAX_STATIC_EXEC_WORK = 128;
const STATIC_WRAPPER_NAMES = new Set(["tools", "text", "Promise"]);
const TOOL_RESULT_UNAVAILABLE = "[Result details unavailable]";
const EXEC_RUN_STATUS = /^Script (?:completed|failed)\r?\nWall time:? \d{1,5}(?:\.\d{1,12})? seconds\r?\nOutput:\r?\n?$/;
const EXEC_COMMAND_FIELDS = new Set(["chunk_id", "wall_time_seconds", "exit_code", "session_id", "original_token_count", "output"]);
const SHELL_COMMAND_TOOLS = new Map<string, string>([
  ["codex:exec_command", "cmd"],
  ["codex:functions.exec_command", "cmd"],
  ["pi:bash", "command"],
]);
const EXEC_COMMAND_OPTIONS: ReadonlyMap<string, string> = new Map([
  ["cmd", "string"], ["workdir", "string"], ["shell", "string"], ["yield_time_ms", "number"],
  ["max_output_tokens", "number"], ["tty", "boolean"], ["login", "boolean"],
]);
const SHELL_COMMAND_LIMIT = 600;
const SHELL_HEADER_PREFIX = /(^|[\s"'`=])((?:authorization|proxy-authorization|(?:set-)?cookie|x-(?:api-key|auth-token|access-token|session-id))[ \t]*:[ \t]*)/gi;
const SHELL_CREDENTIAL_PREFIX = /\b(?:[A-Za-z0-9_.-]*_)?(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key|cookie|session(?:_?id)?|credential)s?[ \t]*=[ \t]*|(?<![A-Za-z0-9_-])--(?:token|password|passwd|api-key|apikey|secret|access-key|auth-token)["']?(?:=[ \t]*|[ \t]+)/gi;
const SHELL_WORD_END = /[\s;&|<>()]/;
const SHELL_MASK_PREFIX = "\0";
const MASKED_SHELL_FIELD = /^\s*\0«redacted \d+ chars»(?=$|[\s"';&|<>()])/;
const SHELL_LONG_BEARER = /(\bBearer\s+)([^\s"'`;&|]+)/gi;

function maskLinksAndPaths(value: string): string {
  return value
    .replace(/\b(?:https?|file):\/\/[^\s"'`<>]+/gi, "[link]")
    .replace(/(^|[\s"'`=:(])\/[^\s"'`<>]+/gm, (_match, lead: string) => `${lead}[path]`)
    .replace(/(^|[\s"'`=:(])(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])[^\s"'`<>]+/gm, (_match, lead: string) => `${lead}[path]`)
    .replace(/\b[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)+\b/g, "[path]");
}

function hasEncodedToolPayload(value: string): boolean {
  if (/data:[^\s,]{0,100};base64,/i.test(value)) return true;
  // Mask filesystem paths and URLs first so long absolute workspace paths do not trip the 64-char base64 heuristic.
  return ENCODED_TOOL_TEXT.test(maskLinksAndPaths(value));
}

export function redactedAgentText(value: unknown, limit = 600): { text: string | null; clipped: boolean } {
  if (typeof value !== "string") return { text: null, clipped: false };
  const clean = maskLinksAndPaths(redactSecretsInText(value))
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return { text: chars.length ? chars.slice(0, limit).join("") : null, clipped: chars.length > limit };
}

function privateToolDeclaration(key: string, value: string): boolean {
  if (key === "encoding") return BASE64_ENCODING.test(value.trim());
  return key === "name" && PRIVATE_HEADER_NAME.test(value.trim());
}

function normalizedToolLabels(value: string): string {
  return value.replace(/\\x([\da-f]{2})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u\{([\da-f]{1,6})\}/gi, (_escape, hex: string) => String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)))
    .replace(/\\u([\da-f]{4})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\+(?=["'])/g, "");
}

function hasPrivateToolFields(labels: string, shell?: "source" | "redacted", customExec = false): boolean {
  if (customExec) {
    const commentedDeclaration = /\/[/*]/.test(labels) && (/\b(?:encoding|name)\b/i.test(labels) || /\]\s*\/[/*]/.test(labels));
    if (commentedDeclaration || EXEC_COMMENT_BEFORE_ASSIGNMENT.test(labels) || EXEC_COMPOUND_ASSIGNMENT.test(labels)) {
      return true;
    }
  }
  const normalized = customExec ? labels.replace(/\[\s*(["'`])([A-Za-z][\w-]{0,127})\1\s*\](?=\s*[:=])/g, ".$2") : labels;
  if (customExec && /\]\s*(?::|=(?![=>]))/.test(normalized)) return true;
  for (const match of normalized.matchAll(TOOL_ASSIGNMENT)) {
    const key = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    const tail = normalized.slice(match.index! + match[0].length);
    const quoted = match[1] !== undefined || /['"]\s*[:=]$/.test(match[0]);
    const bareShellField = !quoted && (shell === "source" || shell === "redacted" && MASKED_SHELL_FIELD.test(tail));
    if (PRIVATE_TOOL_KEY.test(key) && !bareShellField) {
      const option = customExec && key === "max_output_tokens"
        ? /^[ \t]*(0|[1-9]\d{0,15})(?=\s*(?:[,}\];]|$))/.exec(tail)
        : null;
      if (!option || !Number.isSafeInteger(Number(option[1]))) return true;
    }
    const declarationKey = customExec ? key.slice(key.lastIndexOf(".") + 1) : key;
    if (declarationKey !== "encoding" && declarationKey !== "name") continue;
    if (customExec) {
      const literal = EXEC_DECLARATION_LITERAL.exec(tail);
      if (!literal || privateToolDeclaration(declarationKey, literal[2])) return true;
      continue;
    }
    const field = TOOL_FIELD_VALUE.exec(tail);
    if (privateToolDeclaration(declarationKey, field?.[1] ?? field?.[2] ?? field?.[3] ?? "")) return true;
  }
  return false;
}

function safeToolText(value: unknown, customExec = false): { text: string | null; clipped: boolean } {
  if (typeof value !== "string") return { text: null, clipped: false };
  if (value.length > MAX_TOOL_SOURCE) return { text: null, clipped: true };
  if (hasEncodedToolPayload(value)) return { text: null, clipped: true };
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) return { text: null, clipped: true };
  }
  const labels = normalizedToolLabels(value);
  if (hasPrivateToolFields(labels, undefined, customExec) || /\bBearer\s+\S+/i.test(labels)) return { text: null, clipped: false };
  return redactedAgentText(value);
}

export function trackAgentToolCalls() {
  // Keep IDs for the entire bounded scan so a consumed or rejected ID cannot be registered again.
  const calls = new Map<string, { tool: string | null; family?: "function" | "custom"; result?: LocalAgentActivityEvent }>();
  const hide = (event: LocalAgentActivityEvent) => {
    event.tool = null;
    event.text = TOOL_RESULT_UNAVAILABLE;
    event.detailStatus = "withheld";
  };
  return {
    callFor(id: string) {
      const entry = calls.get(id);
      return entry?.tool ? { tool: entry.tool, family: entry.family } : null;
    },
    toolFor(id: string) { return calls.get(id)?.tool ?? null; },
    record(id: string, tool: string | null, family?: "function" | "custom") {
      const previous = calls.get(id);
      if (previous?.result) hide(previous.result);
      calls.set(id, { tool: previous ? null : tool, family: previous ? undefined : family });
    },
    associate(id: string, result: LocalAgentActivityEvent, family?: "function" | "custom") {
      const call = calls.get(id);
      const familyMismatch = family !== undefined && call?.family !== undefined && call.family !== family;
      if (!call?.tool || call.result || familyMismatch) {
        hide(result);
        if (!call) calls.set(id, { tool: null });
        else if (familyMismatch) call.tool = null;
        return;
      }
      result.tool = call.tool;
      call.result = result;
    },
  };
}

function rejectToolArgumentContext(args: object): { text: null; clipped: boolean } | null {
  let fields = 0;
  let sourceLength = 0;
  function inspect(value: object): { text: null; clipped: boolean } | null {
    const node = value as Record<string, unknown>;
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      if (++fields > MAX_TOOL_FIELDS) return { text: null, clipped: true };
      const field = node[key];
      sourceLength += key.length + (typeof field === "string" ? field.length : 0);
      if (sourceLength > MAX_TOOL_SOURCE) return { text: null, clipped: true };
      if (typeof field === "string" && privateToolDeclaration(key.trim().toLowerCase(), field)) {
        return { text: null, clipped: false };
      }
      if (field && typeof field === "object") {
        const rejected = inspect(field);
        if (rejected) return rejected;
      }
    }
    return null;
  }
  return inspect(args);
}

export function redactedAgentToolArguments(value: unknown, customExec = false): { text: string | null; clipped: boolean } {
  if (customExec && typeof value === "string") return safeToolText(value, true);
  if (typeof value === "string" && (value.trimStart().startsWith("{") || value.trimStart().startsWith("["))) {
    if (value.length > MAX_TOOL_SOURCE) return { text: null, clipped: true };
    try { value = JSON.parse(value); } catch { return { text: null, clipped: false }; }
  }
  if (typeof value === "string") return safeToolText(value, customExec);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { text: null, clipped: false };
  const rejected = rejectToolArgumentContext(value);
  if (rejected) return rejected;
  const fields: string[] = [];
  let clipped = false;
  for (const [key, raw] of Object.entries(value)) {
    const outputLimit = key === "max_output_tokens" && typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
    if (!TOOL_KEY.test(key) || (!outputLimit && PRIVATE_TOOL_KEY.test(key)) || redactedAgentText(key).text !== key) continue;
    const scalar = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
    const safe = safeToolText(scalar);
    if (safe.text) fields.push(`${key}: ${safe.text}`);
    if (safe.clipped || scalar === null) clipped = true;
  }
  const result = redactedAgentText(fields.join("; "));
  return { text: result.text, clipped: clipped || result.clipped };
}

export function redactedAgentToolResult(value: unknown, runtime?: "codex"): { text: string | null; clipped: boolean } {
  if (typeof value === "string") return safeToolText(value);
  if (!Array.isArray(value)) return { text: null, clipped: false };
  if (value.length > MAX_TOOL_FIELDS) return { text: null, clipped: true };
  const parts: string[] = [];
  let clipped = false;
  let sourceLength = 0;
  for (const item of value) {
    const block = record(item);
    if (typeof block.text !== "string") { clipped = true; continue; }
    if (block.type !== "text" && block.type !== "output_text" && !(runtime === "codex" && block.type === "input_text")) {
      return { text: null, clipped: true };
    }
    // Text blocks with metadata can declare privacy or encoding outside the scalar.
    for (const key in block) {
      if (key !== "type" && key !== "text" && Object.hasOwn(block, key)) return { text: null, clipped: true };
    }
    sourceLength += block.text.length + (parts.length ? 1 : 0);
    if (sourceLength > MAX_TOOL_SOURCE) return { text: null, clipped: true };
    parts.push(block.text);
  }
  const safe = safeToolText(parts.join(" "));
  return { text: safe.text, clipped: clipped || safe.clipped };
}

function advanceShellQuote(value: string, from: number, to: number, quote: string): string | null {
  for (let index = from; index < to; index++) {
    const char = value[index]!;
    if (quote !== "'" && char === "\\") {
      if (++index >= to) return null;
      if (value[index] === "\r" && value[index + 1] === "\n" && index + 1 < to) index++;
      continue;
    }
    if (quote === char) quote = "";
    else if (!quote && char === "$" && value[index + 1] === "'") return null;
    else if (!quote && (char === '"' || char === "'")) quote = char;
  }
  return quote;
}

function shellCredentialEnd(value: string, start: number, initialQuote = ""): { end: number; preserveQuote: boolean } | null {
  let quote = initialQuote;
  let closedInitial = false;
  let index = start;
  for (; index < value.length; index++) {
    const char = value[index]!;
    if (quote !== "'" && char === "\\") {
      if (++index >= value.length) return null;
      if (value[index] === "\r" && value[index + 1] === "\n") index++;
      continue;
    }
    const next = value[index + 1];
    if (quote !== "'" && (char === "`" || char === "$" && (next === "(" || next === "{" || next === "'"))) return null;
    if (!quote && (char === "<" || char === ">") && next === "(") return null;
    if (quote === char) {
      if (initialQuote && !closedInitial) closedInitial = true;
      quote = "";
    } else if (!quote && (char === '"' || char === "'")) quote = char;
    else if (!quote && SHELL_WORD_END.test(char)) break;
  }
  if (quote || index === start) return null;
  const preserveQuote = Boolean(initialQuote && closedInitial && index > start && value[index - 1] === initialQuote);
  return { end: preserveQuote ? index - 1 : index, preserveQuote };
}

function nextShellSecretMatch(value: string, from: number): { valStart: number } | null {
  SHELL_CREDENTIAL_PREFIX.lastIndex = from;
  SHELL_HEADER_PREFIX.lastIndex = from;
  const credential = SHELL_CREDENTIAL_PREFIX.exec(value);
  const header = SHELL_HEADER_PREFIX.exec(value);
  if (!credential && !header) return null;
  if (!header || (credential && credential.index <= header.index + header[1]!.length)) {
    return { valStart: credential!.index + credential![0].length };
  }
  return { valStart: header.index + header[0].length };
}

function redactShellCredentials(value: string): string | null {
  let cursor = 0;
  let quote = "";
  let redacted = "";
  while (true) {
    const match = nextShellSecretMatch(value, cursor);
    if (!match) break;
    const nextQuote = advanceShellQuote(value, cursor, match.valStart, quote);
    if (nextQuote === null) return null;
    const resolved = shellCredentialEnd(value, match.valStart, nextQuote);
    if (resolved === null) return null;
    redacted += value.slice(cursor, match.valStart) + SHELL_MASK_PREFIX + mask(value.slice(match.valStart, resolved.end));
    cursor = resolved.end;
    quote = resolved.preserveQuote ? nextQuote : "";
  }
  return redacted + value.slice(cursor);
}

function safeShellCommandText(value: string): { text: string | null; clipped: boolean } {
  if (value.length > MAX_TOOL_SOURCE) return { text: null, clipped: true };
  if (hasEncodedToolPayload(value) || INTERNAL_ENVELOPE.test(value.replace(/[\p{Cc}\p{Cf}]/gu, ""))) {
    return { text: null, clipped: true };
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) return { text: null, clipped: true };
  }
  const labels = normalizedToolLabels(value);
  if (labels.includes(SHELL_MASK_PREFIX) || hasEncodedToolPayload(labels)) return { text: null, clipped: true };
  if (hasPrivateToolFields(labels, "source")) return { text: null, clipped: false };

  const credentials = redactShellCredentials(value);
  if (credentials === null) return { text: null, clipped: false };
  const redacted = credentials
    .replace(SHELL_LONG_BEARER, (_m, lead: string, token: string) => `${lead}${mask(token)}`);
  if (hasPrivateToolFields(normalizedToolLabels(redacted), "redacted")) return { text: null, clipped: false };
  return redactedAgentText(redacted.replaceAll(SHELL_MASK_PREFIX, ""), SHELL_COMMAND_LIMIT);
}

type StaticExecCommand = { start: number; end: number; value: string };
type StaticExecEnvironment = ReadonlyMap<string, Expression>;
type StaticExecScan = { commands: StaticExecCommand[]; parsedTexts: { start: number; end: number; value: string }[];
  calls: number; work: number; failed: boolean; clipped: boolean };

function spendExecWork(scan: StaticExecScan): boolean {
  if (scan.failed || scan.work <= 0) { scan.failed = true; return false; }
  scan.work--;
  return true;
}

function staticIdentifier(node: Expression): string | null {
  return node.type === "Identifier" ? node.name : null;
}

function staticLiteral(node: Expression, env: StaticExecEnvironment, scan: StaticExecScan,
  seen = new Set<string>()): Literal | null {
  if (!spendExecWork(scan)) return null;
  if (node.type === "Literal") return node;
  const name = staticIdentifier(node);
  if (!name || seen.has(name)) return null;
  const value = env.get(name);
  return value ? staticLiteral(value, env, scan, new Set([...seen, name])) : null;
}

function staticObject(node: Expression, env: StaticExecEnvironment, scan: StaticExecScan,
  seen = new Set<string>()): ObjectExpression | null {
  if (!spendExecWork(scan)) return null;
  if (node.type === "ObjectExpression") return node;
  const name = staticIdentifier(node);
  if (!name || seen.has(name)) return null;
  const value = env.get(name);
  return value ? staticObject(value, env, scan, new Set([...seen, name])) : null;
}

function inertStaticValue(node: Expression, env: StaticExecEnvironment, scan: StaticExecScan,
  seen = new Set<string>()): boolean {
  if (!spendExecWork(scan)) return false;
  if (node.type === "Literal") return true;
  if (node.type === "Identifier") {
    if (seen.has(node.name)) return false;
    const value = env.get(node.name);
    return Boolean(value && inertStaticValue(value, env, scan, new Set([...seen, node.name])));
  }
  if (node.type === "ArrayExpression") {
    return node.elements.length <= MAX_TOOL_FIELDS && node.elements.every(element =>
      element !== null && element.type !== "SpreadElement" && inertStaticValue(element, env, scan, seen));
  }
  if (node.type === "ObjectExpression") {
    return node.properties.length <= MAX_TOOL_FIELDS && node.properties.every(property =>
      property.type === "Property" && !property.computed && !property.method && property.kind === "init" &&
      inertStaticValue(property.value, env, scan, seen));
  }
  return false;
}

function recordStaticTextNodes(node: Expression, scan: StaticExecScan): boolean {
  if (!spendExecWork(scan)) return false;
  if (node.type === "Literal") {
    if (typeof node.value === "string") scan.parsedTexts.push({ start: node.start, end: node.end, value: node.value });
    return true;
  }
  if (node.type === "Identifier") return true;
  if (node.type === "ArrayExpression") {
    return node.elements.every(element => element !== null && element.type !== "SpreadElement" &&
      recordStaticTextNodes(element, scan));
  }
  if (node.type === "ObjectExpression") {
    return node.properties.every(property => {
      if (property.type !== "Property" || property.computed || property.method || property.kind !== "init") return false;
      const key = property.key.type === "Literal" && typeof property.key.value === "string"
        ? property.key.value : null;
      if (key !== null) scan.parsedTexts.push({ start: property.key.start, end: property.key.end, value: key });
      return recordStaticTextNodes(property.value, scan);
    });
  }
  return false;
}

function literalExecCommand(call: CallExpression, env: StaticExecEnvironment,
  scan: StaticExecScan): StaticExecCommand | null {
  if (!spendExecWork(scan)) return null;
  const { callee } = call;
  if (call.optional || callee.type !== "MemberExpression" || callee.computed || callee.optional ||
      callee.object.type !== "Identifier" || callee.object.name !== "tools" || env.has("tools") ||
      callee.property.type !== "Identifier" || callee.property.name !== "exec_command") return null;
  const [argument] = call.arguments;
  if (call.arguments.length !== 1 || !argument || argument.type === "SpreadElement") return null;
  const object = staticObject(argument, env, scan);
  if (!object || !inertStaticValue(object, env, scan)) return null;
  const seen = new Set<string>();
  let command: StaticExecCommand | null = null;
  for (const property of object.properties) {
    if (!spendExecWork(scan) || property.type !== "Property" || property.computed || property.kind !== "init" || property.method) return null;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? property.key.value : null;
    if (typeof key !== "string" || seen.has(key) || !EXEC_COMMAND_OPTIONS.has(key) ||
        (property.value.type !== "Literal" && property.value.type !== "Identifier")) return null;
    seen.add(key);
    const input = staticLiteral(property.value, env, scan);
    if (!input || EXEC_COMMAND_OPTIONS.get(key) !== typeof input.value) return null;
    if (typeof input.value !== "string") continue;
    if (key === "cmd") command = { start: input.start, end: input.end, value: input.value };
    else if (input.value.trim() && (!safeToolText(input.value, true).text ||
        INTERNAL_ENVELOPE.test(normalizedToolLabels(input.value).replace(/[\p{Cc}\p{Cf}]/gu, "")))) return null;
  }
  return command;
}

function isExecCall(node: CallExpression): boolean {
  const { callee } = node;
  return !node.optional && callee.type === "MemberExpression" && !callee.computed && !callee.optional &&
    callee.object.type === "Identifier" && callee.object.name === "tools" &&
    callee.property.type === "Identifier" && callee.property.name === "exec_command";
}

function exactExecExpression(node: Expression): CallExpression | null {
  if (node.type === "AwaitExpression" && node.argument.type === "CallExpression" && isExecCall(node.argument)) return node.argument;
  if (node.type === "MemberExpression" && !node.computed && !node.optional &&
      node.property.type === "Identifier" && node.property.name === "output" &&
      node.object.type === "AwaitExpression" && node.object.argument.type === "CallExpression" &&
      isExecCall(node.object.argument)) return node.object.argument;
  if (node.type === "CallExpression" && isExecCall(node)) return node;
  return null;
}

function execCallsInExpression(node: Expression, env: StaticExecEnvironment,
  scan: StaticExecScan): CallExpression[] | null {
  if (!spendExecWork(scan)) return null;
  const exact = exactExecExpression(node);
  if (exact) return env.has("tools") ? null : [exact];
  if (node.type === "AwaitExpression") return execCallsInExpression(node.argument, env, scan);
  if (node.type === "CallExpression" && !node.optional) {
    const { callee } = node;
    const isText = callee.type === "Identifier" && callee.name === "text" && !env.has("text");
    const isPromiseAll = callee.type === "MemberExpression" && !callee.computed && !callee.optional &&
      callee.object.type === "Identifier" && callee.object.name === "Promise" && !env.has("Promise") &&
      (callee.property.type === "Identifier" && (callee.property.name === "all" || callee.property.name === "allSettled"));
    if (isText && node.arguments.length === 1) {
      const argument = node.arguments[0];
      return argument && argument.type !== "SpreadElement" ? execCallsInExpression(argument, env, scan) : null;
    }
    if (isPromiseAll && node.arguments.length === 1 && node.arguments[0]?.type === "ArrayExpression") {
      const calls: CallExpression[] = [];
      for (const element of node.arguments[0].elements) {
        if (!spendExecWork(scan) || !element || element.type === "SpreadElement") return null;
        const found = execCallsInExpression(element, env, scan);
        if (!found) return null;
        calls.push(...found);
      }
      return calls;
    }
  }
  return null;
}
function recordExecCalls(calls: CallExpression[], env: StaticExecEnvironment, scan: StaticExecScan): boolean {
  scan.calls += calls.length;
  if (scan.calls > MAX_TOOL_FIELDS || scan.failed) { scan.failed = true; return false; }
  for (const call of calls) {
    const command = literalExecCommand(call, env, scan);
    if (!command) { scan.failed = true; return false; }
    scan.commands.push(command);
  }
  return !scan.failed;
}

function arrayValues(node: Expression, env: StaticExecEnvironment, scan: StaticExecScan): Expression[] | null {
  if (!spendExecWork(scan)) return null;
  if (node.type === "Identifier") {
    const binding = env.get(node.name);
    if (binding?.type !== "ArrayExpression") return null;
    node = binding;
  }
  if (node.type !== "ArrayExpression" || node.elements.length > MAX_TOOL_FIELDS ||
      !inertStaticValue(node, env, scan)) return null;
  return node.elements.flatMap(element => element && element.type !== "SpreadElement" ? [element] : []);
}

function scanExecStatement(statement: Statement, source: string, env: StaticExecEnvironment, names: Set<string>, scan: StaticExecScan): boolean {
  if (!spendExecWork(scan)) return false;
  if (statement.type === "BlockStatement") {
    for (const child of statement.body) if (!scanExecStatement(child, source, env, names, scan)) return false;
    return true;
  }
  if (statement.type === "EmptyStatement") return true;
  if (statement.type === "ExpressionStatement") {
    if (statement.expression.type === "AssignmentExpression" || statement.expression.type === "UpdateExpression") return false;
    const calls = execCallsInExpression(statement.expression, env, scan);
    if (calls) return recordExecCalls(calls, env, scan);
    const { expression } = statement;
    if (expression.type !== "CallExpression" || expression.optional ||
        expression.callee.type !== "Identifier" || expression.callee.name !== "text" || env.has("text") ||
        expression.arguments.length !== 1 || expression.arguments[0]?.type !== "Literal" ||
        typeof expression.arguments[0].value !== "string") return false;
    const decoded = expression.arguments[0].value;
    const normalized = normalizedToolLabels(decoded).replace(/[\p{Cc}\p{Cf}]/gu, "");
    return Boolean(safeToolText(decoded, true).text) && Boolean(safeToolText(normalized, true).text) &&
      !INTERNAL_ENVELOPE.test(decoded) && !INTERNAL_ENVELOPE.test(normalized) &&
      !/\bexec_command\b/.test(source.slice(statement.start, statement.end));
  }
  if (statement.type === "VariableDeclaration") {
    if (statement.kind !== "const") return false;
    for (const declaration of statement.declarations) {
      if (declaration.id.type !== "Identifier" || STATIC_WRAPPER_NAMES.has(declaration.id.name) || names.has(declaration.id.name) || !declaration.init) return false;
      names.add(declaration.id.name);
      const calls = execCallsInExpression(declaration.init, env, scan);
      if (calls) {
        if (!recordExecCalls(calls, env, scan)) return false;
        continue;
      }
      const init = declaration.init;
      if (!inertStaticValue(init, env, scan) || !recordStaticTextNodes(init, scan)) return false;
      env = new Map([...env, [declaration.id.name, init]]);
    }
    return true;
  }
  if (statement.type === "ForOfStatement" && statement.await === false && statement.left.type === "VariableDeclaration" &&
      statement.left.kind === "const" && statement.left.declarations.length === 1) {
    const declaration = statement.left.declarations[0]!;
    if (declaration.id.type !== "Identifier" || STATIC_WRAPPER_NAMES.has(declaration.id.name) || declaration.init || names.has(declaration.id.name)) return false;
    const values = arrayValues(statement.right, env, scan);
    if (!values?.length) return false;
    for (const value of values) {
      if (!spendExecWork(scan)) return false;
      const local = new Map([...env, [declaration.id.name, value]]);
      if (!scanExecStatement(statement.body, source, local, new Set([...names, declaration.id.name]), scan)) return false;
    }
    return true;
  }
  return false;
}

function staticExecCommandDetail(source: string): { text: string; clipped: boolean } | null {
  if (source.length > MAX_TOOL_SOURCE) return null;
  let program;
  try {
    program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    return null;
  }
  const scan: StaticExecScan = { commands: [], parsedTexts: [], calls: 0, work: MAX_STATIC_EXEC_WORK, failed: false, clipped: false };
  let env: StaticExecEnvironment = new Map();
  for (const declaration of program.body) {
    if (declaration.type === "ImportDeclaration" || declaration.type.startsWith("Export") ||
        !spendExecWork(scan)) return null;
    const statement = declaration as Statement;
    if (!scanExecStatement(statement, source, env, new Set(env.keys()), scan)) return null;
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        if (declaration.id.type === "Identifier" && declaration.init) env = new Map([...env, [declaration.id.name, declaration.init]]);
      }
    }
  }
  if (scan.failed || !scan.commands.length) return null;
  const unique = new Map(scan.commands.map(command => [`${command.start}:${command.end}`, command]));
  const replacements = new Map([...unique.values()].map(command =>
    [`${command.start}:${command.end}`, { ...command, value: '""' }]));
  for (const literal of scan.parsedTexts) {
    const key = `${literal.start}:${literal.end}`;
    if (!replacements.has(key)) replacements.set(key, { ...literal, value: JSON.stringify(literal.value) });
  }
  const decodedContext = [...replacements.values()].sort((left, right) => right.start - left.start)
    .reduce((value, replacement) => value.slice(0, replacement.start) + replacement.value +
      value.slice(replacement.end), source);
  const context = [...unique.values()].sort((left, right) => right.start - left.start)
    .reduce((value, command) => value.slice(0, command.start) + '""' + value.slice(command.end), source);
  const normalizedContext = normalizedToolLabels(context).replace(/[\p{Cc}\p{Cf}]/gu, "");
  const normalizedDecodedContext = normalizedToolLabels(decodedContext).replace(/[\p{Cc}\p{Cf}]/gu, "");
  if (!safeToolText(context, true).text || !safeToolText(normalizedContext, true).text ||
      !safeToolText(decodedContext, true).text || !safeToolText(normalizedDecodedContext, true).text ||
      INTERNAL_ENVELOPE.test(context) || INTERNAL_ENVELOPE.test(normalizedContext) ||
      INTERNAL_ENVELOPE.test(decodedContext) || INTERNAL_ENVELOPE.test(normalizedDecodedContext)) return null;
  const details: string[] = [];
  let clipped = scan.clipped;
  for (const command of scan.commands) {
    const safe = safeShellCommandText(command.value);
    if (safe.text) details.push(`cmd: ${safe.text}`);
    else clipped = true;
  }
  if (!details.length) return null;
  const chars = Array.from(details.join("; "));
  return { text: chars.slice(0, SHELL_COMMAND_LIMIT).join(""), clipped: clipped || chars.length > SHELL_COMMAND_LIMIT };
}

function shellCommandDetail(value: unknown, runtime: "codex" | "pi", tool: string): { text: string | null; clipped: boolean } | null {
  const field = SHELL_COMMAND_TOOLS.get(`${runtime}:${tool}`);
  if (!field) return null;
  let parsed = value;
  if (typeof parsed === "string") {
    const trimmed = parsed.trimStart();
    if (!trimmed.startsWith("{")) return null;
    if (parsed.length > MAX_TOOL_SOURCE) return { text: null, clipped: true };
    try { parsed = JSON.parse(parsed); } catch { return { text: null, clipped: false }; }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rejected = rejectToolArgumentContext(parsed);
  if (rejected) return rejected;
  const obj = parsed as Record<string, unknown>;
  const command = obj[field];
  if (typeof command !== "string") return null;
  const safeCommand = safeShellCommandText(command);
  if (safeCommand.text === null) return { text: null, clipped: safeCommand.clipped };
  const extras: string[] = [];
  let clipped = safeCommand.clipped;
  for (const [key, raw] of Object.entries(obj)) {
    if (key === field) continue;
    const outputLimit = key === "max_output_tokens" && typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
    if (!TOOL_KEY.test(key) || (!outputLimit && PRIVATE_TOOL_KEY.test(key)) || redactedAgentText(key).text !== key) continue;
    const scalar = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
    const safe = safeToolText(scalar);
    if (safe.text) extras.push(`${key}: ${safe.text}`);
    if (safe.clipped || scalar === null) clipped = true;
  }
  const combined = extras.length ? `${field}: ${safeCommand.text}; ${extras.join("; ")}` : `${field}: ${safeCommand.text}`;
  const chars = Array.from(combined);
  return { text: chars.slice(0, SHELL_COMMAND_LIMIT).join(""), clipped: clipped || chars.length > SHELL_COMMAND_LIMIT };
}

function execCommandOutput(text: string): { output: string; exitCode?: number } | null {
  if (text.length > MAX_TOOL_SOURCE) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const command = parsed as Record<string, unknown>;
  if (!Object.keys(command).every(key => EXEC_COMMAND_FIELDS.has(key)) ||
      typeof command.wall_time_seconds !== "number" || !Number.isFinite(command.wall_time_seconds) || command.wall_time_seconds < 0 ||
      typeof command.output !== "string" ||
      (command.chunk_id !== undefined && (typeof command.chunk_id !== "string" || !/^[a-f\d]{1,32}$/i.test(command.chunk_id))) ||
      (command.exit_code !== undefined && !Number.isSafeInteger(command.exit_code)) ||
      (command.session_id !== undefined && !Number.isSafeInteger(command.session_id)) ||
      (command.original_token_count !== undefined && !Number.isSafeInteger(command.original_token_count))) return null;
  return { output: command.output, exitCode: command.exit_code as number | undefined };
}

function codexExecResult(value: unknown): { text: string | null; clipped: boolean } | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TOOL_FIELDS) return null;
  const header = record(value[0]);
  if (typeof header.text !== "string" || !EXEC_RUN_STATUS.test(header.text)) return null;
  const blocks = value.map(record);
  if (header.type !== "input_text" || blocks.some(block => Object.keys(block).some(key => key !== "type" && key !== "text"))) {
    return { text: null, clipped: true };
  }
  const status = header.text.slice(0, header.text.indexOf("Output:")).trim();
  const commands = blocks.slice(1).map(block =>
    block.type === "input_text" && typeof block.text === "string" ? execCommandOutput(block.text) : null);
  if (!commands.length || !commands.every(command => command !== null)) {
    return { text: redactedAgentText(status + " · Output excerpt unavailable").text, clipped: true };
  }
  const stdout = commands.map(command => command.output).join(" ");
  const whole = safeToolText(stdout);
  const exitCodes = commands.flatMap(command => command.exitCode === undefined ? [] : [`Exit code: ${command.exitCode}`]);
  const omitted = stdout.trim() !== "" && whole.text === null;
  const detail = redactedAgentText([status, ...exitCodes, whole.text, omitted ? "· Output excerpt unavailable" : ""]
    .filter(Boolean).join(" "));
  return { text: detail.text, clipped: detail.clipped || whole.clipped || omitted };
}

export function visibleToolDetail(kind: "tool-call" | "tool-result", value: unknown, runtime?: "codex" | "pi", tool?: string | null, family?: "function" | "custom"): {
  text: string; clipped: boolean; detailStatus: LocalAgentToolDetailStatus;
} {
  const result = kind === "tool-result";
  const codexExec = runtime === "codex" && (tool === "exec" || tool === "functions.exec");
  const isCustomExecCall = codexExec && !result && (family === "custom" || (family === undefined && typeof value === "string" && !/^\s*\{(?:\s*"|\s*\})/.test(value)));
  const execEnvelope = result && codexExec ? codexExecResult(value) : null;
  const shellDetail = !result && runtime && tool ? shellCommandDetail(value, runtime, tool) : null;
  const recorded = execEnvelope ?? shellDetail ?? (result
    ? redactedAgentToolResult(value, runtime === "codex" ? "codex" : undefined)
    : redactedAgentToolArguments(value, isCustomExecCall));
  const projection = isCustomExecCall && family === "custom" && typeof value === "string"
    ? staticExecCommandDetail(value) : null;
  const detail = projection ?? (isCustomExecCall && family === "custom" && typeof value === "string"
    ? { text: null, clipped: false } : recorded);
  const emptyText = typeof value === "string" && (!value.trim() || (!result && /^\s*\{\s*\}\s*$/.test(value)));
  const emptyArguments = !result && value !== null && typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length;
  const emptyBlocks = Array.isArray(value) && (value.length === 0 || result && !detail.clipped &&
    value.every((block) => {
      const { text } = record(block);
      return typeof text === "string" && !text.trim();
    }));
  const absent = value == null || emptyText || emptyArguments || emptyBlocks;
  return { text: detail.text ?? (result ? TOOL_RESULT_UNAVAILABLE : "[Arguments unavailable]"),
    clipped: detail.clipped, detailStatus: detail.text ? "available" : absent ? "absent" : "withheld" };
}

export function visibleAgentMessage(row: Record<string, unknown>): { kind: "user" | "assistant"; raw: string; format: "legacy" | "canonical" } | null {
  const payload = record(row.payload);
  if (row.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
    return { kind: payload.type === "user_message" ? "user" : "assistant",
      raw: typeof payload.message === "string" ? payload.message : "", format: "legacy" };
  }
  if (row.type !== "response_item" || payload.type !== "message" || payload.channel === "analysis") return null;
  let kind: "user" | "assistant";
  if (payload.role === "user" && payload.phase !== "analysis") kind = "user";
  else if (payload.role === "assistant" && VISIBLE_PHASES.has(String(payload.phase))) kind = "assistant";
  else return null;
  const partType = kind === "user" ? "input_text" : "output_text";
  const raw = Array.isArray(payload.content) ? payload.content.flatMap((part) => {
    const content = record(part);
    return content.type === partType && typeof content.text === "string" ? [content.text] : [];
  }).join(" ") : "";
  return { kind, raw, format: "canonical" };
}

export function assistantMessagePreview(row: Record<string, unknown>): string | null {
  const payload = record(row.payload);
  for (const phase of [payload.phase, payload.channel, row.channel]) {
    if (phase != null && !VISIBLE_PHASES.has(String(phase))) return null;
  }
  if ([payload.recipient, payload.recipient_name].some((value) => value != null && value !== "all")) return null;
  const message = visibleAgentMessage(row);
  return message?.kind === "assistant" ? redactedAssistantPreview(message.raw) : null;
}

export function redactedAssistantPreview(raw: unknown): string | null {
  return redactedVisibleText(raw).text;
}

export function redactedVisibleText(raw: unknown, limit = 400): { text: string | null; clipped: boolean } {
  if (typeof raw !== "string" || escapeNotes(raw) !== raw ||
      INTERNAL_ENVELOPE.test(raw.replace(/[\p{Cc}\p{Cf}]/gu, ""))) return { text: null, clipped: false };
  return redactedAgentText(raw, limit);
}

export function piVisibleMessageText(row: Record<string, unknown>, role: "user" | "assistant"): { text: string | null; clipped: boolean } | null {
  if (row.type !== "message") return null;
  const message = record(row.message);
  if (message.role !== role) return null;
  const content = typeof message.content === "string" && role === "user" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(content)) return null;
  const text = content.flatMap((part) => {
    const block = record(part);
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join(" ");
  return redactedVisibleText(text);
}
