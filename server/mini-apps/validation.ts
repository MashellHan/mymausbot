import { z } from "zod";
import type { MiniAppDashboardRead, MiniAppPublish, MiniAppQuery } from "../../shared/mini-apps.ts";

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const sourceName = z.string().min(1).max(200).refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32));
const source = { column: sourceName, sourceType: z.string().min(1).max(100) };
const field = z.discriminatedUnion("as", [
  z.object({ ...source, as: z.literal("text") }).strict(),
  z.object({ ...source, as: z.literal("date") }).strict(),
  z.object({ ...source, as: z.literal("decimal"), scale: z.number().int().min(0).max(18) }).strict(),
]);
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
const query = z.discriminatedUnion("kind", [
  z.object({ ...plan, kind: z.literal("rows"), columns: z.array(name).min(1).max(32) }).strict(),
  z.object({ ...plan, kind: z.literal("aggregate"), groupBy: z.array(name).max(4), measures: z.array(measure).min(1).max(12),
    timeBucket: z.object({ field: name, unit: z.enum(["day", "week", "month", "year"]), name }).strict().optional() }).strict(),
]);
const binding = z.object({
  id: name, datasetId: z.uuid(), source: z.object({ schema: sourceName, table: sourceName }).strict(),
  fields: z.record(name, field), queries: z.record(name, query),
}).strict();
export const mutationKey = {
  requestKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
};
export const publishSchema = z.object({
  ...mutationKey, slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  title: z.string().trim().min(1).max(120), description: z.string().trim().max(1000),
  html: z.string().min(1).max(512 * 1024), bindings: z.array(binding).max(16),
  publisherBotIds: z.array(z.string().regex(/^[\w-]{1,128}$/)).max(32).optional(),
  dashboardKind: z.enum(["agent-team", "usage"]).nullable().optional(),
  shippedTemplateKind: z.enum(["bookkeeping", "x_ai_digest", "github_activity"]).optional(),
}).strict();
export const rollbackSchema = z.object({ ...mutationKey, templateVersion: z.number().int().positive() }).strict();
export const archiveSchema = z.object(mutationKey).strict();
export const querySchema = z.object({
  queryId: name, parameters: z.record(name, z.union([z.string().max(500), z.array(z.string().max(500)).min(1).max(50)])),
  expectedRevision: z.number().int().positive(), expectedDataRevision: z.number().int().nonnegative().optional(), cursor: z.string().max(4096).optional(),
}).strict();
const dashboardRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
export const dashboardReadSchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("teams"), expectedRevision: dashboardRevision }).strict(),
  z.object({ resource: z.literal("activity"), expectedRevision: dashboardRevision,
    agentId: z.string().regex(/^w\d+:p\d+$/) }).strict(),
  z.object({ resource: z.literal("usage"), expectedRevision: dashboardRevision }).strict(),
]);

export function appFailure(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
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

export function parseDashboardRead(raw: unknown): MiniAppDashboardRead {
  const parsed = dashboardReadSchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Invalid Mini App dashboard read.");
  return parsed.data;
}
