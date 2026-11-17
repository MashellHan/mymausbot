import { z } from "zod";
import type { HongguoCatalogRequest, HongguoHistoryRequest, HongguoPlaybackRequest,
  HongguoPreferencesRequest, HongguoSeriesRequest } from "../../shared/hongguo-mini-app.ts";
import { hongguoUrl } from "../hongguo/network.ts";
import { appFailure } from "./validation.ts";

const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const id = z.string().trim().min(1).max(256).refine((value) => !/\p{Cc}/u.test(value));
const label = z.string().trim().min(1).max(300);
const httpsUrl = z.url().max(2048).refine((value) => Boolean(hongguoUrl(value, "image")));
const optionalUrl = httpsUrl.nullable();
const seconds = z.number().finite().nonnegative().max(1_000_000_000);

const catalog = z.object({ expectedRevision: revision, mode: z.enum(["popular", "new", "search", "categories", "category", "metrics"]),
  query: z.string().trim().min(1).max(200).optional(), categoryId: id.optional(), cursor: z.string().max(4096).optional(),
  seriesIds: z.array(id).min(1).max(100).refine((ids) => new Set(ids).size === ids.length).optional() }).strict()
  .refine((value) => value.mode !== "search" || value.query !== undefined)
  .refine((value) => value.mode !== "category" || value.categoryId !== undefined)
  .refine((value) => value.mode === "metrics" ? value.seriesIds !== undefined && value.query === undefined
    && value.categoryId === undefined && value.cursor === undefined : value.seriesIds === undefined);
const series = z.object({ expectedRevision: revision, seriesId: id }).strict();
const qualityId = z.string().regex(/^[1-9]\d{2,3}p$/);
const playback = series.extend({ episodeId: id, qualityId: qualityId.optional() });
const historyEntry = z.object({ seriesId: id, seriesTitle: label, coverUrl: optionalUrl,
  episodeId: id, episodeNumber: z.number().int().nonnegative().max(1_000_000).nullable(), episodeTitle: label,
  positionSeconds: seconds, durationSeconds: seconds.nullable() }).strict();
const history = z.discriminatedUnion("action", [
  z.object({ expectedRevision: revision, action: z.literal("list") }).strict(),
  z.object({ expectedRevision: revision, action: z.literal("save"), entry: historyEntry }).strict(),
  z.object({ expectedRevision: revision, action: z.literal("delete"), seriesId: id }).strict(),
  z.object({ expectedRevision: revision, action: z.literal("clear") }).strict(),
]);
const preferences = z.object({ expectedRevision: revision, autoplayNext: z.boolean() }).strict();

const metricValue = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const metric = metricValue.optional();
const card = z.object({ id, title: label, coverUrl: optionalUrl, summary: z.string().max(2000).nullable(),
  episodeCount: z.number().int().nonnegative().max(1_000_000).nullable(), heat: metric, playCount: metric }).strict();
const catalogResult = z.object({ items: z.array(card).max(100),
  categories: z.array(z.object({ id, title: label }).strict()).max(100), nextCursor: z.string().max(4096).nullable(),
  pendingMetricIds: z.array(id).max(100).optional(),
  metricUpdates: z.array(z.object({ id, heat: metricValue, playCount: metricValue }).strict()).max(100).optional() }).strict();
const episode = z.object({ id, number: z.number().int().nonnegative().max(1_000_000), title: label,
  availability: z.enum(["available", "unavailable", "unknown"]), imageUrl: optionalUrl }).strict();
const seriesResult = card.extend({ episodes: z.array(episode).max(10_000) });
const preparedPlayback = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), token: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
    durationSeconds: seconds.nullable(), selectedQualityId: qualityId.nullable(),
    availableQualityIds: z.array(qualityId).max(12) }).strict().refine((value) =>
    value.selectedQualityId === null ? value.availableQualityIds.length === 0
      : value.availableQualityIds.includes(value.selectedQualityId)
        && new Set(value.availableQualityIds).size === value.availableQualityIds.length),
  z.object({ status: z.literal("unavailable"), reason: z.enum(["anonymous-limited", "episode-unavailable", "provider-unavailable", "quality-unavailable"]) }).strict(),
]);

function parse<T>(schema: z.ZodType<T>, raw: unknown, message: string, status = 400): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw appFailure(status, message);
  return parsed.data;
}

export const parseHongguoCatalog = (raw: unknown): HongguoCatalogRequest => parse(catalog, raw, "Invalid Hongguo catalog request.");
export const parseHongguoSeries = (raw: unknown): HongguoSeriesRequest => parse(series, raw, "Invalid Hongguo series request.");
export const parseHongguoPlayback = (raw: unknown): HongguoPlaybackRequest => parse(playback, raw, "Invalid Hongguo playback request.");
export const parseHongguoHistory = (raw: unknown): HongguoHistoryRequest => parse(history, raw, "Invalid Hongguo history request.");
export const parseHongguoPreferences = (raw: unknown): HongguoPreferencesRequest => parse(preferences, raw, "Invalid Hongguo preferences request.");
export const parseHongguoCatalogResult = (raw: unknown) => parse(catalogResult, raw, "Hongguo catalog is unavailable.", 503);
export const parseHongguoSeriesResult = (raw: unknown) => parse(seriesResult, raw, "Hongguo series is unavailable.", 503);
export const parseHongguoPreparedPlayback = (raw: unknown) => parse(preparedPlayback, raw, "Hongguo playback is unavailable.", 503);
