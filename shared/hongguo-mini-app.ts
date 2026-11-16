/** The native Hongguo app uses only these bounded host operations. */
export type HongguoCatalogMode = "popular" | "new" | "search" | "categories" | "category";

export interface HongguoCatalogRequest {
  expectedRevision: number;
  mode: HongguoCatalogMode;
  query?: string;
  categoryId?: string;
  cursor?: string;
}

export interface HongguoCategory { id: string; title: string }

export interface HongguoSeriesCard {
  id: string;
  title: string;
  coverUrl: string | null;
  summary: string | null;
  episodeCount: number | null;
}

export interface HongguoCatalogResponse {
  appId: string;
  revision: number;
  items: HongguoSeriesCard[];
  categories: HongguoCategory[];
  nextCursor: string | null;
}

export interface HongguoSeriesRequest { expectedRevision: number; seriesId: string }

export interface HongguoEpisode {
  id: string;
  number: number;
  title: string;
  availability: "available" | "unavailable" | "unknown";
  imageUrl: string | null;
}

export interface HongguoSeries extends HongguoSeriesCard { episodes: HongguoEpisode[] }
export interface HongguoSeriesResponse { appId: string; revision: number; series: HongguoSeries }
export interface HongguoPlaybackRequest { expectedRevision: number; seriesId: string; episodeId: string }

/** An unavailable result has no media URL; the native player must not invent one. */
export type HongguoPlaybackResponse =
  | { appId: string; revision: number; status: "ready"; mediaUrl: string; durationSeconds: number | null }
  | { appId: string; revision: number; status: "unavailable";
      reason: "anonymous-limited" | "episode-unavailable" | "provider-unavailable" };

export interface HongguoHistoryEntry {
  seriesId: string;
  seriesTitle: string;
  coverUrl: string | null;
  episodeId: string;
  episodeNumber: number | null;
  episodeTitle: string;
  positionSeconds: number;
  durationSeconds: number | null;
  updatedAt: number;
}

export type HongguoHistoryRequest =
  | { expectedRevision: number; action: "list" }
  | { expectedRevision: number; action: "save"; entry: Omit<HongguoHistoryEntry, "updatedAt"> }
  | { expectedRevision: number; action: "delete"; seriesId: string }
  | { expectedRevision: number; action: "clear" };

export interface HongguoHistoryResponse {
  appId: string;
  revision: number;
  entries: HongguoHistoryEntry[];
  autoplayNext: boolean;
}

export interface HongguoPreferencesRequest { expectedRevision: number; autoplayNext: boolean }
export interface HongguoPreferencesResponse { appId: string; revision: number; autoplayNext: boolean }
