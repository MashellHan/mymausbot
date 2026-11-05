import { readFileSync, rmSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { parseJson } from "./schema.ts";
import type { JsonObject } from "./schema.ts";

const SECRET_FIELDS: Record<string, readonly string[]> = {
  xai: ["key"], anthropic: ["key"], mistral: ["key"], cerebras: ["key"],
  groq: ["key"], greenference: ["key"], meta: ["key"], deepseek: ["key"],
  openai: ["key"], openrouter: ["key"], openaiCompat: ["key"],
  treg: ["key"], postiz: ["key"], composio: ["apiKey", "userId", "sessionId"],
  box: ["token"], opencodeGo: ["apiKey", "providerKeys"],
  tts: ["key", "fishKey", "geminiKey"], decider: ["key", "openrouterKey", "workersAiToken"],
  imageGen: ["key", "customApiKey"], live: ["key", "keyFor"],
};
const OPAQUE_SECTIONS = ["instances", "mcpServers"] as const;
const object = (value: unknown): JsonObject | null => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;

/** Preserve every pre-existing disk secret, including fields a newer provider may understand only at runtime. */
export function persistedSessionConfig(effective: JsonObject, previous: JsonObject): JsonObject {
  const persisted = structuredClone(effective);
  for (const [section, fields] of Object.entries(SECRET_FIELDS)) {
    const next = object(persisted[section]);
    if (!next) continue;
    const prior = object(previous[section]);
    for (const field of fields) {
      if (prior && Object.hasOwn(prior, field)) next[field] = structuredClone(prior[field]!);
      else delete next[field];
    }
  }
  for (const section of OPAQUE_SECTIONS) {
    if (Object.hasOwn(previous, section)) persisted[section] = structuredClone(previous[section]!);
    else delete persisted[section];
  }
  return persisted;
}

export function hasSessionSecretPatch(patch: JsonObject): boolean {
  if (OPAQUE_SECTIONS.some((section) => Object.hasOwn(patch, section))) return true;
  return Object.entries(SECRET_FIELDS).some(([section, fields]) => {
    const value = object(patch[section]);
    return value !== null && fields.some((field) => Object.hasOwn(value, field));
  });
}

/** Session values win over an inherited provider env after a desktop credential changes during this run. */
export function withSessionSecrets<T extends JsonObject>(config: T, session: JsonObject): T {
  const result: JsonObject = structuredClone(config);
  for (const [section, fields] of Object.entries(SECRET_FIELDS)) {
    const saved = object(session[section]);
    if (!saved) continue;
    const next = object(result[section]) ?? {};
    for (const field of fields) if (Object.hasOwn(saved, field)) next[field] = structuredClone(saved[field]!);
    result[section] = next;
  }
  for (const section of OPAQUE_SECTIONS) {
    if (Object.hasOwn(session, section)) result[section] = structuredClone(session[section]!);
  }
  return result as T;
}

const SESSION_CONFIG_LIMIT = 128 * 1024;
const SESSION_CREDENTIALS = process.env.OMB_DESKTOP_PARENT === "1" && process.env.OMB_CREDENTIAL_MODE === "session";
const sessionConfigSeed = process.env.OMB_SESSION_CONFIG_JSON;
delete process.env.OMB_SESSION_CONFIG_JSON;
let sessionConfig: JsonObject | null = null;
let publisher: ((snapshot: JsonObject) => Promise<void> | void) | null = null;
let confirmation: Promise<void> | null = null;
let pending = false;

export function sessionCredentialsEnabled(): boolean { return SESSION_CREDENTIALS; }
export function readSessionConfigDisk(file: string): { previousDisk: JsonObject; previousBytes: string | null } {
  let previousDisk: JsonObject = {};
  let previousBytes: string | null = null;
  try {
    previousBytes = readFileSync(file, "utf8");
    const parsed = z.record(z.string(), z.json()).safeParse(parseJson(previousBytes));
    if (parsed.success) previousDisk = parsed.data;
  } catch {}
  return { previousDisk, previousBytes };
}
export function activeSessionConfig(): JsonObject | null {
  if (!SESSION_CREDENTIALS) return null;
  if (sessionConfig !== null || !sessionConfigSeed) return sessionConfig;
  if (Buffer.byteLength(sessionConfigSeed) > SESSION_CONFIG_LIMIT) throw new Error("Session configuration exceeds the desktop handoff limit");
  const parsed = z.record(z.string(), z.json()).safeParse(parseJson(sessionConfigSeed));
  if (!parsed.success) throw new Error("Invalid desktop session configuration");
  return sessionConfig = parsed.data;
}
export function assertSessionConfigWritable(): void {
  if (SESSION_CREDENTIALS && pending) throw Object.assign(new Error("A session credential save is still being confirmed. Try again."), { status: 409 });
}
export function setSessionConfigPublisher(send: (snapshot: JsonObject) => Promise<void> | void): void { publisher = send; }
export async function confirmSessionConfig(): Promise<void> { await confirmation; }

export function writeSessionConfig(input: {
  file: string;
  effective: JsonObject;
  previousDisk: JsonObject;
  previousSession: JsonObject | null;
  previousBytes: string | null;
  patch: JsonObject;
  forget(): void;
}): JsonObject {
  const { file, effective, previousDisk, previousSession, previousBytes, patch, forget } = input;
  const persisted = SESSION_CREDENTIALS ? persistedSessionConfig(effective, previousDisk) : effective;
  if (SESSION_CREDENTIALS && Buffer.byteLength(JSON.stringify(effective)) > SESSION_CONFIG_LIMIT) throw new Error("Session configuration exceeds the desktop handoff limit");
  if (SESSION_CREDENTIALS && hasSessionSecretPatch(patch) && !publisher) throw new Error("The desktop session credential owner is unavailable");
  writeFileAtomic(file, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  if (SESSION_CREDENTIALS) {
    sessionConfig = effective;
    if (publisher) {
      pending = true;
      let sent: Promise<void> | void;
      try { sent = publisher(structuredClone(effective)); }
      catch (error) { sent = Promise.reject(error); }
      confirmation = Promise.resolve(sent).then(() => { pending = false; }, (error: unknown) => {
        try {
          sessionConfig = previousSession;
          if (previousBytes === null) rmSync(file, { force: true });
          else writeFileAtomic(file, previousBytes, { mode: 0o600 });
          forget();
        } finally { pending = false; }
        throw error;
      });
      void confirmation.catch(() => {});
    }
  }
  return persisted;
}

