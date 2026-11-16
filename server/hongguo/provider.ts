import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client, SeriesSummary, Transport } from "openhongguo";
import type { HongguoCatalogRequest, HongguoCatalogResponse, HongguoCategory, HongguoEpisode, HongguoSeries,
  HongguoSeriesCard } from "../../shared/hongguo-mini-app.ts";
import { SERVER_ROOT } from "../proxy-paths.ts";
import { HongguoMedia, type HongguoMediaScope } from "./media.ts";
import { hongguoRequest, hongguoUrl } from "./network.ts";

export type { HongguoMediaScope } from "./media.ts";
type PreparedPlayback = { status: "ready"; token: string; durationSeconds: number | null }
  | { status: "unavailable"; reason: "anonymous-limited" | "episode-unavailable" | "provider-unavailable" };
export interface HongguoProvider {
  catalog(input: HongguoCatalogRequest): Promise<Omit<HongguoCatalogResponse, "appId" | "revision">>;
  series(id: string): Promise<HongguoSeries>;
  preparePlayback(seriesId: string, episodeId: string, scope: HongguoMediaScope): Promise<PreparedPlayback>;
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

async function loadClient(dataDir: string): Promise<Client> {
  const shipped = join(SERVER_ROOT, "hongguo-sdk", "index.js");
  const sdk: typeof import("openhongguo") = existsSync(shipped) ? await import(pathToFileURL(shipped).href) : await import("openhongguo");
  return sdk.createClient({ profile: join(dataDir, "hongguo", "anonymous.json"), transport: hongguoTransport,
    retryAttempts: 1, deviceResets: 0 });
}

export function createHongguoProvider(options: { dataDir: string; client?: () => Promise<CatalogClient>;
  media?: Pick<HongguoMedia, "prepare" | "serve"> }): HongguoProvider {
  let client: Promise<CatalogClient> | undefined;
  const getClient = () => client ??= (options.client?.() ?? loadClient(options.dataDir)).catch((error: unknown) => {
    client = undefined;
    throw error;
  });
  const media = options.media ?? new HongguoMedia(join(options.dataDir, "hongguo", "media"));
  const seriesCache = new Map<string, { series: HongguoSeries; expiresAt: number }>();
  let categoryCache: { items: HongguoCategory[]; expiresAt: number } | undefined;

  async function categories(): Promise<HongguoCategory[]> {
    if (categoryCache && categoryCache.expiresAt > Date.now()) return categoryCache.items;
    const rows = await (await getClient()).shortFilterPanel();
    const items = (rows.find((row) => row.key === "category_dim_theme")?.options ?? [])
      .filter((option) => /^cate_\d+$/.test(option.value) && label(option.name))
      .slice(0, 100).map((option) => ({ id: option.value, title: label(option.name) }));
    categoryCache = { items, expiresAt: Date.now() + 5 * 60_000 };
    return items;
  }

  async function series(id: string): Promise<HongguoSeries> {
    if (!providerId(id)) throw new Error("Invalid series identifier.");
    const cached = seriesCache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.series;
    const details = await (await getClient()).getSeriesBatch([id]);
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
      const sdk = await getClient();
      let page: { items: SeriesSummary[]; has_more: boolean; cursor?: string };
      if (input.mode === "search") page = await sdk.search(input.query!, { cursor: input.cursor, pageSize: 24 });
      else if (input.mode === "new") {
        const result = await sdk.newReleases({ cursor: input.cursor });
        page = { ...result, items: result.items.filter((item) => item.online).map((item) => ({ ...item, id: item.series_id })) };
      } else if (input.mode === "category") {
        if (!(await categories()).some((item) => item.id === input.categoryId)) throw new Error("This category is unavailable.");
        page = await sdk.shortFilter({ selections: { category_dim_theme: [input.categoryId!] }, cursor: input.cursor });
      } else {
        const result = await sdk.shortRank({ cursor: input.cursor });
        page = { ...result, items: result.items.map((item) => ({ ...item, id: item.series_id ?? "", title: item.title ?? "" })) };
      }
      return { items: page.items.slice(0, 100).map(card).filter((item): item is HongguoSeriesCard => item !== null), categories: [],
        nextCursor: page.has_more && page.cursor && page.cursor.length <= 4096 ? page.cursor : null };
    },
    series,
    async preparePlayback(seriesId, episodeId, scope) {
      try {
        const detail = await series(seriesId);
        const episode = detail.episodes.find((item) => item.id === episodeId);
        if (!episode || episode.availability === "unavailable") return { status: "unavailable", reason: "episode-unavailable" };
        const resolved = await (await getClient()).resolvePlayback(episodeId);
        if (resolved.playback.episode_id !== episodeId) return { status: "unavailable", reason: "provider-unavailable" };
        const token = await media.prepare(resolved.playback, resolved.contentKey?.key, scope);
        return token ? { status: "ready", token, durationSeconds: number(resolved.playback.duration_seconds) }
          : { status: "unavailable", reason: "provider-unavailable" };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        return { status: "unavailable", reason: code === "ANONYMOUS_LIMITED" ? "anonymous-limited"
          : code === "CONTENT_UNAVAILABLE" ? "episode-unavailable" : "provider-unavailable" };
      }
    },
    serveMedia: (token, range, signal, scope) => media.serve(token, range, signal, scope),
  };
}
