/** The native Hongguo app uses only these bounded host operations. */
export type HongguoCatalogMode = "popular" | "new" | "search" | "categories" | "category" | "metrics";

export interface HongguoCatalogRequest {
  expectedRevision: number;
  mode: HongguoCatalogMode;
  query?: string;
  categoryId?: string;
  cursor?: string;
  /** Cache-only readback for a bounded set of cards already in the current catalog. */
  seriesIds?: string[];
}

export interface HongguoCategory { id: string; title: string }

export interface HongguoSeriesCard {
  id: string;
  title: string;
  coverUrl: string | null;
  summary: string | null;
  episodeCount: number | null;
  /** Sourced numeric metrics; absent or null means unknown, not zero. */
  heat?: number | null;
  playCount?: number | null;
}

export function hongguoMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

export interface HongguoMetricUpdate { id: string; heat: number | null; playCount: number | null }

export interface HongguoCatalogResponse {
  appId: string;
  revision: number;
  items: HongguoSeriesCard[];
  categories: HongguoCategory[];
  nextCursor: string | null;
  /** IDs of existing finite enrichment jobs; completion readback never starts or renews provider work. */
  pendingMetricIds?: string[];
  metricUpdates?: HongguoMetricUpdate[];
}

export interface HongguoSeriesRequest { expectedRevision: number; seriesId: string }

export interface HongguoEpisode {
  id: string;
  number: number;
  title: string;
  availability: "available" | "unavailable" | "unknown";
  imageUrl: string | null;
}

export interface HongguoSeries extends HongguoSeriesCard {
  episodes: HongguoEpisode[];
}
export interface HongguoSeriesResponse { appId: string; revision: number; series: HongguoSeries }
export interface HongguoPlaybackRequest { expectedRevision: number; seriesId: string; episodeId: string; qualityId?: string }

/** An unavailable result has no media URL; the native player must not invent one. */
export type HongguoPlaybackResponse =
  | { appId: string; revision: number; status: "ready"; mediaUrl: string; durationSeconds: number | null;
      selectedQualityId: string | null; availableQualityIds: string[] }
  | { appId: string; revision: number; status: "unavailable";
      reason: "anonymous-limited" | "episode-unavailable" | "provider-unavailable" | "quality-unavailable" };

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
