import { useState } from "react";
import { Clapperboard } from "lucide-react";
import { hongguoMetric, type HongguoSeriesCard } from "../../../shared/hongguo-mini-app";
import { HONGGUO_LOCALE, hongguoText as t } from "./hongguo-copy";

export function Poster({ card, appId, revision, priority = false, className = "" }: {
  card: HongguoSeriesCard; appId: string; revision: number; priority?: boolean; className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = card.coverUrl && `/api/mini-apps/${encodeURIComponent(appId)}/hongguo/cover?expectedRevision=${revision}&url=${encodeURIComponent(card.coverUrl)}`;
  return <div className={`relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl bg-inset text-ink-secondary ${className}`}>
    <Clapperboard size={25} aria-hidden="true" />
    {url && failedUrl !== card.coverUrl && <img src={url} alt="" loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"} decoding="async" onError={() => setFailedUrl(card.coverUrl)}
      className="absolute inset-0 h-full w-full object-cover" />}
  </div>;
}

export function hongguoTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

const format = new Intl.NumberFormat(HONGGUO_LOCALE, { notation: "compact", maximumFractionDigits: 1 });

export function SeriesMetrics({ card, className = "" }: { card: Pick<HongguoSeriesCard, "heat" | "playCount">; className?: string }) {
  const metrics = [
    { key: "heat", value: hongguoMetric(card.heat), label: t("computer.miniApps.hongguo.heatLabel") },
    { key: "playCount", value: hongguoMetric(card.playCount), label: t("computer.miniApps.hongguo.playCountLabel") },
  ].filter((metric) => metric.value !== null);
  if (!metrics.length) return null;
  return <dl className={`flex flex-wrap gap-x-3 gap-y-1 ${className}`} data-hongguo-metrics>
    {metrics.map((metric) => <div key={metric.key} className="inline-flex items-baseline gap-1">
      <dt className="text-[11px] text-ink-secondary">{metric.label}</dt>
      <dd className="text-[12px] font-semibold tabular-nums text-ink" data-hongguo-metric={metric.key}>{format.format(metric.value!)}</dd>
    </div>)}
  </dl>;
}
