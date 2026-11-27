import { z } from "zod";
import { MINI_APP_ICON_PRESETS, MINI_APP_SHIPPED_TEMPLATE_KINDS, type MiniAppCustomIcon, type MiniAppDashboardRead, type MiniAppIconPreset, type MiniAppPublish, type MiniAppQuery, type MiniAppQueryBatchRequest, type MiniAppUpdateApply } from "../../shared/mini-apps.ts";
import { LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR } from "../../shared/local-dashboard.ts";

export const bindingNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const name = bindingNameSchema;
export const sourceNameSchema = z.string().min(1).max(200).refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32));
const sourceName = sourceNameSchema;
const source = { column: sourceName, sourceType: z.string().min(1).max(100) };
export const bindingFieldSchema = z.discriminatedUnion("as", [
  z.object({ ...source, as: z.literal("text") }).strict(),
  z.object({ ...source, as: z.literal("date") }).strict(),
  z.object({ ...source, as: z.literal("decimal"), scale: z.number().int().min(0).max(18) }).strict(),
]);
const field = bindingFieldSchema;
const operation = z.enum(["eq", "lt", "lte", "gt", "gte"]);
const filter = z.union([
  z.object({ field: name, op: operation, literal: z.string().max(500) }).strict(),
  z.object({ field: name, op: z.enum(["eq", "in", "lt", "lte", "gt", "gte"]), parameter: name }).strict(),
]);
const measure = z.union([
  z.object({ name, op: z.literal("count"), field: name.optional() }).strict(),
  z.object({ name, op: z.enum(["sum", "min", "max"]), field: name }).strict(),
]);
const plan = {
  parameters: z.record(name, z.object({ type: z.enum(["text", "decimal", "date"]), list: z.boolean().optional(), optional: z.boolean().optional() }).strict()),
  filters: z.array(filter).max(12),
  orderBy: z.array(z.object({ field: name, direction: z.enum(["asc", "desc"]) }).strict()).max(4),
  pageSize: z.number().int().min(1).max(100),
};
export const namedQuerySchema = z.discriminatedUnion("kind", [
  z.object({ ...plan, kind: z.literal("rows"), columns: z.array(name).min(1).max(32) }).strict(),
  z.object({ ...plan, kind: z.literal("aggregate"), groupBy: z.array(name).max(4), measures: z.array(measure).min(1).max(12),
    timeBucket: z.object({ field: name, unit: z.enum(["day", "week", "month", "year"]), name }).strict().optional() }).strict(),
]);
const query = namedQuerySchema;
const binding = z.object({
  id: name, datasetId: z.uuid(), source: z.object({ schema: sourceName, table: sourceName }).strict(),
  fields: z.record(name, field), queries: z.record(name, query),
}).strict();
export const mutationKey = {
  requestKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
};
const PRESET_SET = new Set<string>(MINI_APP_ICON_PRESETS);
const HEX_TONE_RE = /^#[0-9a-fA-F]{6}$/;
const EMOJI_GRAPH_RE = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|(?:\p{Regional_Indicator}{2})|(?:[0-9#*]\ufe0f?\u20e3)/u;
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const iconToneSchema = z.string().regex(HEX_TONE_RE).transform((value) => value.toLowerCase());
const isValidIconEmoji = (value: string): boolean => {
  if (value.length < 1 || value.length > 16) return false;
  if ([...value].some((char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || code === 127 || char === "<" || char === ">" || char === "&" || char === '"' || char === "'" || /\s/.test(char);
  })) return false;
  if (!EMOJI_GRAPH_RE.test(value)) return false;
  return [...graphemeSegmenter.segment(value)].length === 1;
};
const emojiValueSchema = z.string().trim().min(1).max(16).refine(isValidIconEmoji);
export const miniAppIconSchema = z.union([
  z.object({
    kind: z.literal("preset"),
    name: z.enum(MINI_APP_ICON_PRESETS),
    tone: iconToneSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("emoji"),
    value: emojiValueSchema,
    tone: iconToneSchema.optional(),
  }).strict(),
  z.string().trim().min(1).max(32).transform((value, ctx): MiniAppCustomIcon => {
    const lower = value.toLowerCase();
    if (PRESET_SET.has(lower)) return { kind: "preset", name: lower as MiniAppIconPreset };
    if (isValidIconEmoji(value)) return { kind: "emoji", value };
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid Mini App icon shorthand." });
    return z.NEVER;
  }),
]).transform((value): MiniAppCustomIcon => {
  if (value.kind === "preset") return value.tone ? { kind: "preset", name: value.name, tone: value.tone } : { kind: "preset", name: value.name };
  return value.tone ? { kind: "emoji", value: value.value, tone: value.tone } : { kind: "emoji", value: value.value };
});

export const publishSchema = z.object({
  ...mutationKey, slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  title: z.string().trim().min(1).max(120), description: z.string().trim().max(1000),
  html: z.string().min(1).max(512 * 1024), bindings: z.array(binding).max(16),
  publisherBotIds: z.array(z.string().regex(/^[\w-]{1,128}$/)).max(32).optional(),
  responsibleBotId: z.string().regex(/^[\w-]{1,128}$/).nullable().optional(),
  capabilities: z.array(z.string().trim().min(8).max(160)).max(8).optional(),
  dashboardKind: z.enum(["agent-team", "usage"]).nullable().optional(),
  nativeKind: z.literal("hongguo").nullable().optional(),
  shippedTemplateKind: z.enum(MINI_APP_SHIPPED_TEMPLATE_KINDS).optional(),
  icon: miniAppIconSchema.nullable().optional(),
}).strict();
export const rollbackSchema = z.object({ ...mutationKey, templateVersion: z.number().int().positive() }).strict();
export const archiveSchema = z.object(mutationKey).strict();
export const queryItemSchema = z.object({
  queryId: name,
  parameters: z.record(name, z.union([z.string().max(500), z.array(z.string().max(500)).min(1).max(50)])),
  expectedDataRevision: z.number().int().nonnegative().optional(),
  cursor: z.string().max(4096).optional(),
}).strict();
export const querySchema = queryItemSchema.extend({
  expectedRevision: z.number().int().positive(),
}).strict();
export const queryBatchSchema = z.object({
  expectedRevision: z.number().int().positive(),
  queries: z.array(queryItemSchema).min(1).max(16),
}).strict();
const dashboardRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const occupantId = z.string().regex(/^o[0-9a-f]{16}$/);
const agentId = z.string().regex(/^w\d+:p[0-9A-Za-z]+$/);
export const dashboardReadSchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("teams"), expectedRevision: dashboardRevision }).strict(),
  z.object({ resource: z.literal("activity"), expectedRevision: dashboardRevision,
    agentId, occupantId, history: z.literal(1).optional(), before: z.string().regex(LOCAL_AGENT_ACTIVITY_HISTORY_CURSOR).optional() }).strict(),
  z.object({ resource: z.literal("configuration"), expectedRevision: dashboardRevision, agentId, occupantId }).strict(),
  z.object({ resource: z.literal("team-rules"), expectedRevision: dashboardRevision,
    teamId: z.string().regex(/^w\d+$/) }).strict(),
  z.object({ resource: z.literal("skill"), expectedRevision: dashboardRevision, agentId, occupantId,
    skillId: z.string().regex(/^s[0-9a-f]{16}$/) }).strict(),
  z.object({ resource: z.literal("usage"), expectedRevision: dashboardRevision }).strict(),
]);

export function appFailure(status: number, message: string, code?: string): Error & { status: number; code?: string } {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
}

export function parsePublish(raw: unknown): MiniAppPublish {
  const parsed = publishSchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Invalid Mini App publication. Use the documented title, HTML, bindings and version fields.");
  if (Buffer.byteLength(parsed.data.html) > 512 * 1024) throw appFailure(413, "Mini App HTML exceeds 512 KiB.");
  const queries = parsed.data.bindings.flatMap((item) => Object.keys(item.queries));
  if (new Set(parsed.data.bindings.map((item) => item.id)).size !== parsed.data.bindings.length || new Set(queries).size !== queries.length || queries.length > 64) {
    throw appFailure(400, "Mini App binding and query names must be unique; at most 64 queries are allowed.");
  }
  return parsed.data;
}

export function parseQuery(raw: unknown): MiniAppQuery {
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Invalid Mini App named query.");
  return parsed.data;
}

export function parseQueryBatch(raw: unknown): MiniAppQueryBatchRequest {
  const parsed = queryBatchSchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Invalid Mini App batch query request.");
  return parsed.data;
}

export const SEMVER_3_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export const releaseUpdateApplySchema = z.object({
  ...mutationKey,
  appVersion: z.string().regex(SEMVER_3_RE),
  sourceCommit: z.string().regex(COMMIT_SHA_RE),
}).strict();

export function parseReleaseUpdateApply(raw: unknown): MiniAppUpdateApply {
  const parsed = releaseUpdateApplySchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Invalid Mini App release update request.");
  return parsed.data;
}

export function parseDashboardRead(raw: unknown): MiniAppDashboardRead {
  const parsed = dashboardReadSchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Invalid Mini App dashboard read.");
  if (parsed.data.resource !== "activity") return parsed.data;
  const { history, before, ...selection } = parsed.data;
  if (history === 1) return before === undefined ? { ...selection, history } : { ...selection, history, before };
  if (before !== undefined) throw appFailure(400, "Invalid Mini App dashboard read.");
  return selection;
}
