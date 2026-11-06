import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import type { DataPage } from "../../../shared/data-surface";
import type { MiniAppSourceTable } from "../../../shared/mini-apps";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

const PAGE_SIZE = 20;

export function SourceTablePreview({ datasetId, table }: { datasetId: string; table: MiniAppSourceTable }) {
  const nativeGuard = miniAppNativeFrameGuard();
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<DataPage | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!nativeGuard || !open) return;
    const controller = new AbortController();
    setPage(null);
    setError("");
    void api<DataPage>(`/api/mini-apps/sources/${encodeURIComponent(datasetId)}/page`, {
      method: "POST", body: JSON.stringify({ schema: table.schema, table: table.name, offset, limit: PAGE_SIZE }),
      signal: controller.signal, timeoutMs: 10_000,
    }).then((result) => { if (!controller.signal.aborted) setPage(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("computer.miniApps.preview.failed")); });
    return () => controller.abort();
  }, [datasetId, table.schema, table.name, nativeGuard, open, offset, retry]);

  if (!nativeGuard) return <p role="status" className="text-[12px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>;
  return <section className="min-w-0" aria-label={t("computer.miniApps.preview.heading")}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)} className="rounded-lg bg-control px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent">
      {open ? t("computer.miniApps.preview.hide") : t("computer.miniApps.preview.show")}
    </button>
    {open && <div className="mt-2 min-w-0 rounded-xl border border-hairline/60 bg-card p-2.5">
      <p className="mb-2 text-[12px] text-ink-secondary">{t("computer.miniApps.preview.readOnly")}</p>
      {!page && !error && <p role="status" className="flex items-center gap-2 py-4 text-[12px] text-ink-secondary"><Loader2 size={13} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.preview.loading")}</p>}
      {error && <p role="alert" className="rounded-lg bg-danger/10 px-2.5 py-2 text-[12px] text-danger">{error} <button type="button" className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent" onClick={() => setRetry((current) => current + 1)}>{t("computer.miniApps.preview.retry")}</button></p>}
      {page && <>
        {page.rows.length === 0 ? <p className="py-3 text-[12px] text-ink-secondary">{t("computer.miniApps.preview.empty")}</p> : <div className="max-h-60 min-w-0 overflow-auto">
          <table className="min-w-full border-collapse text-left text-[12px] text-ink">
            <thead className="sticky top-0 bg-card"><tr>{page.columns.map((column, index) => <th key={`${column.name}:${index}`} scope="col" className="whitespace-nowrap border-b border-hairline px-2 py-1.5 font-semibold">{column.name}</th>)}</tr></thead>
            <tbody>{page.rows.map((row, rowIndex) => <tr key={offset + rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-48 truncate border-b border-hairline/40 px-2 py-1.5" title={cell === null ? undefined : String(cell)}>{cell === null ? "—" : String(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>}
        <div className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-secondary">
          <span className="tabular-nums">{t("computer.miniApps.preview.range", { from: page.rowCount === 0 ? 0 : offset + 1, through: offset + page.rows.length, count: page.rowCount })}</span>
          <div className="flex items-center gap-1">
            <button type="button" disabled={offset === 0} aria-label={t("computer.miniApps.preview.previous")} onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))} className="rounded-md p-1 text-ink hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"><ChevronLeft size={15} aria-hidden="true" /></button>
            <button type="button" disabled={offset + page.rows.length >= page.rowCount || offset + PAGE_SIZE > 10_000} aria-label={t("computer.miniApps.preview.next")} onClick={() => setOffset((current) => current + PAGE_SIZE)} className="rounded-md p-1 text-ink hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"><ChevronRight size={15} aria-hidden="true" /></button>
          </div>
        </div>
      </>}
    </div>}
  </section>;
}
