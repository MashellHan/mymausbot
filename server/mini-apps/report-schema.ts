import { isIP } from "node:net";
import { z } from "zod";
import type { ReportKind } from "../../shared/report-mini-app.ts";
import { appFailure } from "./validation.ts";

export const reportKindSchema = z.enum(["x_ai_digest", "github_activity"]);
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const maybeInstant = instant.nullable();
const maybeText = (max: number) => z.string().trim().min(1).max(max).nullable().default(null);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().default(null);

function publicHttpUrl(value: string): boolean {
  try {
    if ([...value].some((character) => character.charCodeAt(0) < 32)) return false;
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port
      && host.includes(".") && !host.startsWith("[") && !isIP(host)
      && !/\.(?:local|localhost|internal|invalid|test)$/u.test(host)
      && ![...url.searchParams.keys()].some((key) => /token|auth|secret|password|signature|credential|api.?key|code/iu.test(key));
  } catch { return false; }
}

const sourceUrl = z.string().trim().min(1).max(1500).refine(publicHttpUrl, "Use a public HTTP(S) source URL without credentials.")
  .transform((value) => new URL(value).toString());
const itemSchema = z.object({
  category: maybeText(80),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(500),
  whyItMatters: maybeText(300),
  verificationNote: maybeText(300),
  sourceLabel: z.string().trim().min(1).max(80),
  sourceUrl,
  sourcePublishedAt: maybeInstant,
  attribution: z.enum(["primary", "vendor", "secondary", "curated"]),
  repoFullName: maybeText(200),
  repoStars: count,
  repoForks: count,
  repoPushedAt: maybeInstant.default(null),
  weeklyStarIncrease: count,
  signalSourceUrl: sourceUrl.nullable().default(null),
  publicAdvisoryCount: count,
  publicAdvisoryAsOfAt: maybeInstant.default(null),
  selectionBasis: maybeText(200),
}).strict();

const editionSchema = z.object({
  editionKey: z.iso.date().optional(),
  reportSummary: maybeText(600),
  windowStartAt: maybeInstant,
  windowEndAt: maybeInstant,
  sourceAsOfAt: maybeInstant,
  coverageStatus: z.enum(["complete", "partial", "unknown"]),
  coverageNote: maybeText(500),
  items: z.array(itemSchema).max(30),
}).strict();

export const reportToolSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare"), kind: reportKindSchema }).strict(),
  z.object({ action: z.literal("publish"), kind: reportKindSchema, edition: editionSchema }).strict(),
]);

export type ParsedReportEdition = z.output<typeof editionSchema>;

export function parseReportEdition(kind: ReportKind, raw: unknown): ParsedReportEdition {
  const parsed = editionSchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Invalid report edition or source metadata.");
  const edition = parsed.data;
  if (Buffer.byteLength(JSON.stringify(edition)) > 64 * 1024) throw appFailure(413, "Report edition exceeds 64 KiB.");
  if (edition.coverageStatus !== "complete" && !edition.coverageNote) throw appFailure(400, "Partial or unknown coverage needs a limitation note.");
  if (Boolean(edition.windowStartAt) !== Boolean(edition.windowEndAt) ||
      edition.windowStartAt && edition.windowEndAt && edition.windowStartAt >= edition.windowEndAt ||
      edition.coverageStatus === "complete" && !edition.windowStartAt) throw appFailure(400, "Report coverage window is incomplete or invalid.");
  const urls = new Set<string>();
  for (const item of edition.items) {
    if (urls.has(item.sourceUrl)) throw appFailure(409, "A report edition repeats a source URL.");
    urls.add(item.sourceUrl);
    if (item.publicAdvisoryCount !== null && !item.publicAdvisoryAsOfAt) throw appFailure(400, "Observed public advisories need their check time.");
    if (kind === "github_activity") {
      const url = new URL(item.sourceUrl);
      if (!item.repoFullName || !item.selectionBasis || url.protocol !== "https:" || url.hostname !== "github.com" ||
          url.search || url.hash || url.pathname.replace(/\/$/u, "").toLowerCase() !== `/${item.repoFullName.toLowerCase()}` ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item.repoFullName)) throw appFailure(400, "GitHub items need a matching public repository URL and selection basis.");
    }
  }
  return edition;
}

export function parseReportTool(raw: unknown): z.output<typeof reportToolSchema> {
  const parsed = reportToolSchema.safeParse(raw);
  if (!parsed.success) throw appFailure(400, "Use mini_app_report prepare or publish with a valid report kind and edition.");
  return parsed.data;
}
