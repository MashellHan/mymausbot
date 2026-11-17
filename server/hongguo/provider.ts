import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client, SeriesSummary, Transport } from "openhongguo";
import type { HongguoCatalogRequest, HongguoCatalogResponse, HongguoCategory, HongguoEpisode, HongguoSeries,
  HongguoSeriesCard } from "../../shared/hongguo-mini-app.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { availableQualityIds, HongguoMedia, type HongguoMediaScope } from "./media.ts";
import { hongguoRequest, hongguoUrl } from "./network.ts";
import { safeHttpFacts, safeSdkError, type PlaybackReason, type PlaybackStage } from "./playback-diagnostic.ts";

export type { HongguoMediaScope } from "./media.ts";
type PreparedPlayback = { status: "ready"; token: string; durationSeconds: number | null;
  selectedQualityId: string | null; availableQualityIds: string[] }
  | { status: "unavailable"; reason: "anonymous-limited" | "episode-unavailable" | "provider-unavailable" | "quality-unavailable" };
export interface HongguoProvider {
  catalog(input: HongguoCatalogRequest): Promise<Omit<HongguoCatalogResponse, "appId" | "revision">>;
  series(id: string): Promise<HongguoSeries>;
  preparePlayback(seriesId: string, episodeId: string, scope: HongguoMediaScope, qualityId?: string): Promise<PreparedPlayback>;
  serveMedia(token: string, range: string | undefined, signal: AbortSignal, scope: HongguoMediaScope): Promise<Response>;
}

type CatalogClient = Pick<Client, "search" | "shortRank" | "shortFilterPanel" | "shortFilter" | "newReleases"
  | "getSeriesBatch" | "resolvePlayback">;
const providerId = (id: string) => /^\d{1,32}$/.test(id);
const label = (value: string | undefined, max = 300) => (value ?? "").replace(/\p{Cc}/gu, " ").trim().slice(0, max);
const number = (value: number | undefined) => Number.isFinite(value) && value! >= 0 && value! <= 1_000_000 ? value! : null;
const imageUrl = (value: string | undefined) => value && value.length <= 2048 ? hongguoUrl(value, "image")?.href ?? null : null;

function card(value: SeriesSummary): HongguoSeriesCard | null {
  if (!providerId(value.id) || !label(value.title)) return null;
  return { id: value.id, title: label(value.title), coverUrl: imageUrl(value.cover_url),
    summary: label(value.description, 2000) || null, episodeCount: number(value.episode_count) };
}

export const hongguoTransport: Transport = async (input) => {
  const result = await hongguoRequest(input.url, "api", input);
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.headers)) {
    if (name !== "set-cookie" && name !== "cookie" && value !== undefined) headers[name] = Array.isArray(value) ? value[0]! : value;
  }
  for (const line of result.headers["set-cookie"] ?? []) {
    const pair = line.split(";", 1)[0]!;
    const equal = pair.indexOf("=");
    if (equal > 0) cookies[pair.slice(0, equal).trim()] = pair.slice(equal + 1).trim();
  }
  return { status: result.status, headers, cookies, body: result.body };
};

async function loadClient(dataDir: string, transport: Transport): Promise<Client> {
  const shipped = join(SERVER_ROOT, "hongguo-sdk", "index.js");
  const sdk: typeof import("openhongguo") = existsSync(shipped) ? await import(pathToFileURL(shipped).href) : await import("openhongguo");
  return sdk.createClient({ profile: join(dataDir, "providers", "hongguo", "anonymous.json"), transport,
    retryAttempts: 1, deviceResets: 0 });
}

type PlaybackTrace = { stage: PlaybackStage; ambiguous: boolean; truncated: boolean;
  responses: ReturnType<typeof safeHttpFacts>[] };
type ActiveSdkCall = { trace: PlaybackTrace | null; stage: PlaybackStage | null };

export function createHongguoProvider(options: { dataDir: string; client?: (transport: Transport) => Promise<CatalogClient>;
  transport?: Transport; log?: (line: string) => void; media?: Pick<HongguoMedia, "prepare" | "serve"> }): HongguoProvider {
  const traces = new Set<PlaybackTrace>();
  const sdkCalls = new Set<ActiveSdkCall>();
  const transport: Transport = async (input) => {
    const call = sdkCalls.size === 1 ? sdkCalls.values().next().value! : null;
    const trace = call?.trace && traces.size === 1 && traces.has(call.trace) ? call.trace : null;
    const stage = call?.stage;
    const result = await (options.transport ?? hongguoTransport)(input);
    if (trace && stage && !trace.ambiguous && sdkCalls.size === 1 && sdkCalls.has(call!)) {
      try {
        if (trace.responses.length === 4) { trace.responses.shift(); trace.truncated = true; }
        trace.responses.push(safeHttpFacts(result, stage));
      } catch { trace.truncated = true; }
    }
    return result;
  };
  const sdkCall = async <T>(trace: PlaybackTrace | null, stage: PlaybackStage | null, action: () => Promise<T>): Promise<T> => {
    const call = { trace, stage };
    sdkCalls.add(call);
    if (sdkCalls.size > 1) for (const active of traces) active.ambiguous = true;
    if (trace && stage) trace.stage = stage;
    try { return await action(); }
    finally { sdkCalls.delete(call); }
  };
  const unavailable = (trace: PlaybackTrace, reason: PlaybackReason, error?: unknown): PreparedPlayback => {
    const sdk = safeSdkError(error);
    // SDK log lines and error text are untrusted and must never reach this local diagnostic.
    const line = JSON.stringify({ kind: "hongguo-playback", stage: trace.stage, reason,
      errorCode: sdk.code, retryable: sdk.retryable, correlation: trace.ambiguous ? "ambiguous" : "isolated",
      responses: trace.ambiguous ? [] : trace.responses, truncated: trace.truncated });
    try { (options.log ?? console.warn)(line); } catch {}
    return { status: "unavailable", reason };
  };
  let client: Promise<CatalogClient> | undefined;
  const getClient = () => client ??= (options.client?.(transport) ?? loadClient(options.dataDir, transport)).catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  const media = options.media ?? new HongguoMedia(join(options.dataDir, "cache", "hongguo"));
  const seriesCache = new Map<string, { series: HongguoSeries; expiresAt: number }>();
  let categoryCache: { items: HongguoCategory[]; expiresAt: number } | undefined;

  async function categories(): Promise<HongguoCategory[]> {
    if (categoryCache && categoryCache.expiresAt > Date.now()) return categoryCache.items;
    const rows = await sdkCall(null, null, async () => (await getClient()).shortFilterPanel());
    const items = (rows.find((row) => row.key === "category_dim_theme")?.options ?? [])
      .filter((option) => /^cate_\d+$/.test(option.value) && label(option.name))
      .slice(0, 100).map((option) => ({ id: option.value, title: label(option.name) }));
    categoryCache = { items, expiresAt: Date.now() + 5 * 60_000 };
    return items;
  }

  async function series(id: string, trace: PlaybackTrace | null = null): Promise<HongguoSeries> {
    if (trace) trace.stage = "series";
    if (!providerId(id)) throw new Error("Invalid series identifier.");
    const cached = seriesCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.series;
    const details = await sdkCall(trace, "series", async () => (await getClient()).getSeriesBatch([id]));
    const detail = details.find((entry) => entry.series.id === id);
    const summary = detail && card(detail.series);
    if (!summary || !detail) throw new Error("This series is unavailable.");
    const result: HongguoSeries = { ...summary, episodes: detail.episodes
      .filter((episode) => episode.series_id === id && providerId(episode.id) && Number.isInteger(episode.number) && number(episode.number) !== null)
      .slice(0, 10_000).map((episode): HongguoEpisode => ({ id: episode.id, number: episode.number,
        title: label(episode.title) || String(episode.number), imageUrl: imageUrl(episode.cover_url),
        availability: episode.playable === true ? "available" : episode.playable === false ? "unavailable" : "unknown" }))
      .sort((a, b) => a.number - b.number) };
    seriesCache.set(id, { series: result, expiresAt: Date.now() + 5 * 60_000 });
    while (seriesCache.size > 32) seriesCache.delete(seriesCache.keys().next().value!);
    return result;
  }

  return {
    async catalog(input) {
      if (input.mode === "categories") return { items: [], categories: await categories(), nextCursor: null };
      let page: { items: SeriesSummary[]; has_more: boolean; cursor?: string };
      if (input.mode === "search") page = await sdkCall(null, null, async () =>
        (await getClient()).search(input.query!, { cursor: input.cursor, pageSize: 24 }));
      else if (input.mode === "new") {
        const result = await sdkCall(null, null, async () => (await getClient()).newReleases({ cursor: input.cursor }));
        page = { ...result, items: result.items.filter((item) => item.online).map((item) => ({ ...item, id: item.series_id })) };
      } else if (input.mode === "category") {
        if (!(await categories()).some((item) => item.id === input.categoryId)) throw new Error("This category is unavailable.");
        page = await sdkCall(null, null, async () => (await getClient()).shortFilter({
          selections: { category_dim_theme: [input.categoryId!] }, cursor: input.cursor }));
      } else {
        const result = await sdkCall(null, null, async () => (await getClient()).shortRank({ cursor: input.cursor }));
        page = { ...result, items: result.items.map((item) => ({ ...item, id: item.series_id ?? "", title: item.title ?? "" })) };
      }
      return { items: page.items.slice(0, 100).map(card).filter((item): item is HongguoSeriesCard => item !== null), categories: [],
        nextCursor: page.has_more && page.cursor && page.cursor.length <= 4096 ? page.cursor : null };
    },
    series: (id) => series(id),
    async preparePlayback(seriesId, episodeId, scope, requestedQualityId) {
      const trace: PlaybackTrace = { stage: "series", ambiguous: false, truncated: false, responses: [] };
      traces.add(trace);
      if (traces.size > 1) for (const active of traces) active.ambiguous = true;
      try {
        const detail = await series(seriesId, trace);
        trace.stage = "selection";
        const episode = detail.episodes.find((item) => item.id === episodeId);
        if (!episode || episode.availability === "unavailable") return unavailable(trace, "episode-unavailable");
        const resolved = await sdkCall(trace, "resolve", async () => (await getClient()).resolvePlayback(episodeId));
        if (resolved.playback.episode_id !== episodeId) return unavailable(trace, "provider-unavailable");
        trace.stage = "media";
        const available = availableQualityIds(resolved.playback, resolved.contentKey?.key);
        if (requestedQualityId !== undefined && !available.includes(requestedQualityId)) {
          return unavailable(trace, "quality-unavailable");
        }
        const selectedQualityId = requestedQualityId ?? available[0] ?? null;
        const token = await media.prepare(resolved.playback, resolved.contentKey?.key, scope, selectedQualityId ?? undefined);
        return token ? { status: "ready", token, durationSeconds: number(resolved.playback.duration_seconds),
          selectedQualityId, availableQualityIds: available }
          : unavailable(trace, "provider-unavailable");
      } catch (error) {
        const code = safeSdkError(error).code;
        return unavailable(trace, code === "ANONYMOUS_LIMITED" ? "anonymous-limited"
          : code === "CONTENT_UNAVAILABLE" ? "episode-unavailable" : "provider-unavailable", error);
      } finally { traces.delete(trace); }
    },
    serveMedia: (token, range, signal, scope) => media.serve(token, range, signal, scope),
  };
}
