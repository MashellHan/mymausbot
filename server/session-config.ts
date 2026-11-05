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

