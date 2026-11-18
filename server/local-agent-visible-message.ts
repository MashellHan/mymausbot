import type { LocalAgentActivityEvent } from "../shared/local-dashboard.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { escapeNotes } from "./peer-provenance.ts";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const VISIBLE_PHASES = new Set(["commentary", "final_answer", "final"]);
const INTERNAL_ENVELOPE = /<\/?(?:SYSTEM_(?:MESSAGE|NOTIFICATION)|(?:teammate|agent|task|coordinator)[_-](?:message|notification|envelope)|system[_-]reminder)\b/i;
const TOOL_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const PRIVATE_TOOL_KEY = /(?:auth|base64|binary|body|cookie|credential|data|env|header|image|key|passwd|password|private|secret|session|token)|^sid$/i;
const TOOL_ASSIGNMENT = /"([^"\n]{1,128})"\s*[:=]|\b([A-Za-z][A-Za-z0-9_.-]*(?:[ \t]+(?:id|key|token|data|value))?)['"]?\s*[:=]/gi;
const TOOL_FIELD_VALUE = /^\s*(?:"([^"\n]{1,128})"|'([^'\n]{1,128})'|([A-Za-z0-9_-]+))/;
const PRIVATE_HEADER_NAME = /^(?:(?:set-)?cookie|(?:proxy-)?authorization|x-(?:api-key|auth-token|access-token|session-id))$/i;
const BASE64_ENCODING = /^base64(?:-?url)?$/i;
const ENCODED_TOOL_TEXT = /data:[^\s,]{0,100};base64,|[A-Za-z0-9+/_-]{64,}={0,2}/i;
const MAX_TOOL_SOURCE = 16 * 1024;
const MAX_TOOL_FIELDS = 8;
const TOOL_RESULT_UNAVAILABLE = "[Result details unavailable]";

export function redactedAgentText(value: unknown, limit = 600): { text: string | null; clipped: boolean } {
  if (typeof value !== "string") return { text: null, clipped: false };
  const clean = redactSecretsInText(value)
    .replace(/\b(?:https?|file):\/\/[^\s"'`<>]+/gi, "[link]")
    .replace(/(^|[\s"'`=:(])\/[^\s"'`<>]+/gm, (_match, lead: string) => `${lead}[path]`)
    .replace(/(^|[\s"'`=:(])(?:~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])[^\s"'`<>]+/gm, (_match, lead: string) => `${lead}[path]`)
    .replace(/\b[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)+\b/g, "[path]")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return { text: chars.length ? chars.slice(0, limit).join("") : null, clipped: chars.length > limit };
}

function privateToolDeclaration(key: string, value: string): boolean {
  if (key === "encoding") return BASE64_ENCODING.test(value.trim());
  return key === "name" && PRIVATE_HEADER_NAME.test(value.trim());
}

function safeToolText(value: unknown): { text: string | null; clipped: boolean } {
  if (typeof value !== "string") return { text: null, clipped: false };
  if (value.length > MAX_TOOL_SOURCE) return { text: null, clipped: true };
  if (ENCODED_TOOL_TEXT.test(value)) return { text: null, clipped: true };
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) return { text: null, clipped: true };
  }
  const labels = value.replace(/\\u([\da-f]{4})/gi, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\+(?=["'])/g, "");
  for (const match of labels.matchAll(TOOL_ASSIGNMENT)) {
    const key = (match[1] ?? match[2] ?? "").trim().toLowerCase();
    if (PRIVATE_TOOL_KEY.test(key)) return { text: null, clipped: false };
    if (key !== "encoding" && key !== "name") continue;
    const field = TOOL_FIELD_VALUE.exec(labels.slice(match.index! + match[0].length));
    if (privateToolDeclaration(key, field?.[1] ?? field?.[2] ?? field?.[3] ?? "")) {
      return { text: null, clipped: false };
    }
  }
  if (/\bBearer\s+\S+/i.test(labels)) return { text: null, clipped: false };
  return redactedAgentText(value);
}

export function trackAgentToolCalls() {
  // Keep IDs for the entire bounded scan so a consumed or rejected ID cannot be registered again.
  const calls = new Map<string, { tool: string | null; result?: LocalAgentActivityEvent }>();
  const hide = (event: LocalAgentActivityEvent) => {
    event.tool = null;
    event.text = TOOL_RESULT_UNAVAILABLE;
  };
  return {
    record(id: string, tool: string | null) {
      const previous = calls.get(id);
      if (previous?.result) hide(previous.result);
      calls.set(id, { tool: previous ? null : tool });
    },
    associate(id: string, result: LocalAgentActivityEvent) {
      const call = calls.get(id);
      if (!call?.tool || call.result) {
        hide(result);
        if (!call) calls.set(id, { tool: null });
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

export function redactedAgentToolArguments(value: unknown): { text: string | null; clipped: boolean } {
  if (typeof value === "string" && (value.trimStart().startsWith("{") || value.trimStart().startsWith("["))) {
    if (value.length > MAX_TOOL_SOURCE) return { text: null, clipped: true };
    try { value = JSON.parse(value); } catch { return { text: null, clipped: false }; }
  }
  if (typeof value === "string") return safeToolText(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { text: null, clipped: false };
  const rejected = rejectToolArgumentContext(value);
  if (rejected) return rejected;
  const fields: string[] = [];
  let clipped = false;
  for (const [key, raw] of Object.entries(value)) {
    if (!TOOL_KEY.test(key) || PRIVATE_TOOL_KEY.test(key) || redactedAgentText(key).text !== key) continue;
    const scalar = typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : null;
    const safe = safeToolText(scalar);
    if (safe.text) fields.push(`${key}: ${safe.text}`);
    if (safe.clipped || scalar === null) clipped = true;
  }
  const result = redactedAgentText(fields.join("; "));
  return { text: result.text, clipped: clipped || result.clipped };
}

export function redactedAgentToolResult(value: unknown): { text: string | null; clipped: boolean } {
  if (typeof value === "string") return safeToolText(value);
  if (!Array.isArray(value)) return { text: null, clipped: false };
  if (value.length > MAX_TOOL_FIELDS) return { text: null, clipped: true };
  const parts: string[] = [];
  let clipped = false;
  let sourceLength = 0;
  for (const item of value) {
    const block = record(item);
    if (typeof block.text !== "string") { clipped = true; continue; }
    if (block.type !== "text" && block.type !== "output_text") return { text: null, clipped: true };
    sourceLength += block.text.length + (parts.length ? 1 : 0);
    if (sourceLength > MAX_TOOL_SOURCE) return { text: null, clipped: true };
    parts.push(block.text);
  }
  const safe = safeToolText(parts.join(" "));
  return { text: safe.text, clipped: clipped || safe.clipped };
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

function redactedVisibleText(raw: unknown): { text: string | null; clipped: boolean } {
  if (typeof raw !== "string" || escapeNotes(raw) !== raw ||
      INTERNAL_ENVELOPE.test(raw.replace(/[\p{Cc}\p{Cf}]/gu, ""))) return { text: null, clipped: false };
  return redactedAgentText(raw, 400);
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
