import { useEffect, useRef, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { randomUuid } from "@/lib/random-uuid";
import { api } from "@/state/store";
import type { MiniAppDataset, MiniAppMutationResult, MiniAppSources } from "../../../shared/mini-apps";
import { BOOKKEEPING_FIELDS, createBookkeepingPublish, suggestedBookkeepingColumns, type BookkeepingColumns } from "../../../shared/bookkeeping-mini-app";
import bookkeepingHtml from "../../../examples/mini-apps/bookkeeping/index.html?raw";
import { SourceTablePreview } from "./SourceTablePreview";
import { miniAppNativeFrameGuard } from "./native-frame-guard";

const emptyColumns = Object.fromEntries(BOOKKEEPING_FIELDS.map((field) => [field, ""])) as BookkeepingColumns;

function sourceLabel(dataset: MiniAppDataset, index: number): string {
  const first = dataset.tables[0]?.name;
  return first ? t("computer.miniApps.source.dataset", { number: index + 1, table: first })
    : t("computer.miniApps.source.datasetEmpty", { number: index + 1 });
}

export function BookkeepingInstall({ onCancel, onInstalled }: { onCancel(): void; onInstalled(appId: string): void }) {
  const nativeGuard = miniAppNativeFrameGuard();
  const [sources, setSources] = useState<MiniAppSources | null>(null);
  const [selectedSource, setSelectedSource] = useState("");
  const [publisherBotId, setPublisherBotId] = useState("");
  const publisherByDataset = useRef(new Map<string, string>());
  const [tableIndex, setTableIndex] = useState(0);
  const [columns, setColumns] = useState<BookkeepingColumns>(emptyColumns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestKey = useRef<string | null>(null);
  const dataset = selectedSource.startsWith("dataset:") ? sources?.datasets.find((entry) => entry.datasetId === selectedSource.slice(8)) : undefined;
  const table = dataset?.tables[tableIndex];
  const selectedBotId = selectedSource.startsWith("bot:") ? selectedSource.slice(4) : undefined;
  const ready = Boolean(dataset && table && BOOKKEEPING_FIELDS.every((field) => columns[field] && table.columns.some((column) => column.name === columns[field]))
    && new Set(BOOKKEEPING_FIELDS.map((field) => columns[field])).size === BOOKKEEPING_FIELDS.length);

  useEffect(() => {
    if (!nativeGuard) return;
    const controller = new AbortController();
    void api<MiniAppSources>("/api/mini-apps/sources", { signal: controller.signal, timeoutMs: 10_000 }).then((result) => {
      setSources(result);
      if (result.datasets.length) {
        setSelectedSource(`dataset:${result.datasets[0]!.datasetId}`);
        setColumns(result.datasets[0]!.tables[0] ? suggestedBookkeepingColumns(result.datasets[0]!.tables[0]!) : emptyColumns);
      } else if (result.bots.length) setSelectedSource(`bot:${result.bots[0]!.id}`);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("computer.miniApps.source.failed")); });
    return () => controller.abort();
  }, [nativeGuard]);

  const changeSource = (value: string) => {
    setSelectedSource(value);
    setPublisherBotId(value.startsWith("dataset:") ? publisherByDataset.current.get(value.slice(8)) ?? "" : "");
    setTableIndex(0);
    setError("");
    requestKey.current = null;
    const selected = value.startsWith("dataset:") ? sources?.datasets.find((entry) => entry.datasetId === value.slice(8)) : undefined;
    setColumns(selected?.tables[0] ? suggestedBookkeepingColumns(selected.tables[0]) : emptyColumns);
  };

  const changeTable = (index: number) => {
    setTableIndex(index);
    setColumns(dataset?.tables[index] ? suggestedBookkeepingColumns(dataset.tables[index]) : emptyColumns);
    setError("");
    requestKey.current = null;
  };

  const changeColumn = (field: keyof BookkeepingColumns, value: string) => {
    setColumns((current) => ({ ...current, [field]: value }));
    setError("");
    requestKey.current = null;
  };

  const connectBot = async () => {
    if (!nativeGuard || !selectedBotId || busy) return;
    setBusy(true);
    setError("");
    try {
      const { dataset: connected } = await api<{ dataset: MiniAppDataset }>("/api/mini-apps/sources", {
        method: "POST", body: JSON.stringify({ botId: selectedBotId }), timeoutMs: 20_000,
      });
      setSources((current) => current ? { ...current, datasets: [...current.datasets.filter((entry) => entry.datasetId !== connected.datasetId), connected] } : current);
      setSelectedSource(`dataset:${connected.datasetId}`);
      setPublisherBotId(selectedBotId);
      publisherByDataset.current.set(connected.datasetId, selectedBotId);
      setTableIndex(0);
      setColumns(connected.tables[0] ? suggestedBookkeepingColumns(connected.tables[0]) : emptyColumns);
      requestKey.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("computer.miniApps.source.connectFailed"));
    } finally { setBusy(false); }
  };

  const install = async () => {
    if (!nativeGuard || !ready || !dataset || !table || busy) return;
    setBusy(true);
    setError("");
    try {
      const publish = { ...createBookkeepingPublish({ dataset, table, columns, html: bookkeepingHtml,
        ...(publisherBotId ? { publisherBotId } : {}), requestKey: requestKey.current ??= randomUuid(),
        title: t("computer.miniApps.bookkeepingTitle") }),
      description: t("computer.miniApps.bookkeepingDescription") };
      const result = await api<MiniAppMutationResult>("/api/mini-apps", { method: "POST", body: JSON.stringify(publish), timeoutMs: 20_000 });
      onInstalled(result.app.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("computer.miniApps.install.failed"));
    } finally { setBusy(false); }
  };

  if (!nativeGuard) return <p role="status" className="mx-4 mt-4 rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.desktopRequired")}</p>;

  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 pb-6" data-testid="bookkeeping-install" aria-labelledby="mini-app-install-title">
      <header className="flex items-start justify-between gap-3 pt-3">
        <div>
          <h2 id="mini-app-install-title" className="text-[16px] font-semibold text-ink">{t("computer.miniApps.install.title")}</h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-secondary">{t("computer.miniApps.install.description")}</p>
        </div>
        <button type="button" className="rounded-lg px-2.5 py-1.5 text-[12px] text-ink-secondary hover:bg-inset hover:text-ink focus-visible:outline-2 focus-visible:outline-accent" onClick={onCancel}>{t("computer.miniApps.cancel")}</button>
      </header>
      {error && <p role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
      {!sources && !error && <p role="status" className="mt-5 flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t("computer.miniApps.source.loading")}</p>}
      {sources && <div className="mt-5 space-y-4">
        <label className="block text-[12px] font-medium text-ink-secondary">
          {t("computer.miniApps.source.choose")}
          <select value={selectedSource} disabled={busy} onChange={(event) => changeSource(event.target.value)} className="mt-1 block w-full min-w-0 rounded-lg border border-hairline bg-card px-2.5 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-accent">
            {sources.datasets.map((entry, index) => <option key={entry.datasetId} value={`dataset:${entry.datasetId}`}>{sourceLabel(entry, index)}</option>)}
            {sources.bots.map((bot) => <option key={bot.id} value={`bot:${bot.id}`}>{t("computer.miniApps.source.bot", { name: bot.name })}</option>)}
          </select>
        </label>
        {selectedBotId && <div className="rounded-xl bg-inset p-3">
          <p className="text-[13px] text-ink-secondary">{t("computer.miniApps.source.connectDescription")}</p>
          <button type="button" disabled={busy} onClick={() => void connectBot()} className="mt-2 rounded-lg bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">{busy ? t("computer.miniApps.source.connecting") : t("computer.miniApps.source.connect")}</button>
        </div>}
        {dataset && dataset.tables.length === 0 && <p className="rounded-lg bg-inset px-3 py-3 text-[13px] text-ink-secondary">{t("computer.miniApps.source.noTables")}</p>}
        {dataset && dataset.tables.length > 0 && <>
          <label className="block text-[12px] font-medium text-ink-secondary">
            {t("computer.miniApps.source.table")}
            <select value={tableIndex} disabled={busy} onChange={(event) => changeTable(Number(event.target.value))} className="mt-1 block w-full min-w-0 rounded-lg border border-hairline bg-card px-2.5 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-accent">
              {dataset.tables.map((entry, index) => <option key={`${entry.schema}.${entry.name}`} value={index}>{entry.name} · {t("computer.miniApps.source.rows", { count: entry.rowCount.toLocaleString() })}</option>)}
            </select>
          </label>
          {table && <SourceTablePreview key={`${dataset.datasetId}:${table.schema}:${table.name}`} datasetId={dataset.datasetId} table={table} />}
          <label className="block text-[12px] font-medium text-ink-secondary">
            {t("computer.miniApps.publisher.label")}
            <select value={publisherBotId} disabled={busy} onChange={(event) => {
              setPublisherBotId(event.target.value);
              publisherByDataset.current.set(dataset.datasetId, event.target.value);
              requestKey.current = null;
            }} className="mt-1 block w-full min-w-0 rounded-lg border border-hairline bg-card px-2.5 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-accent">
              <option value="">{t("computer.miniApps.publisher.ownerOnly")}</option>
              {sources.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
            <span className="mt-1 block text-[12px] font-normal leading-5 text-ink-secondary">{t("computer.miniApps.publisher.help")}</span>
          </label>
          {table && <fieldset className="min-w-0 rounded-xl border border-hairline/60 p-3">
            <legend className="px-1 text-[13px] font-semibold text-ink">{t("computer.miniApps.source.mapping")}</legend>
            <p className="mb-3 text-[12px] leading-5 text-ink-secondary">{t("computer.miniApps.source.mappingHelp")}</p>
            <div className="grid grid-cols-1 gap-3 @min-[29rem]/mini-apps:grid-cols-2">
              {BOOKKEEPING_FIELDS.map((field) => <label key={field} className="min-w-0 text-[12px] font-medium text-ink-secondary">
                {t(`computer.miniApps.field.${field}`)}
                <select value={columns[field]} disabled={busy} onChange={(event) => changeColumn(field, event.target.value)} className="mt-1 block w-full min-w-0 rounded-lg border border-hairline bg-card px-2.5 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-accent">
                  <option value="">{t("computer.miniApps.source.chooseColumn")}</option>
                  {table.columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}
                </select>
              </label>)}
            </div>
          </fieldset>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={!ready || busy} onClick={() => void install()} className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-ink hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">{busy ? t("computer.miniApps.install.working") : t("computer.miniApps.install.action")}</button>
            {!ready && <span className="text-[12px] text-ink-secondary">{t("computer.miniApps.source.completeMapping")}</span>}
          </div>
        </>}
        {sources.datasets.length === 0 && sources.bots.length === 0 && <div className="flex items-start gap-2 rounded-xl bg-inset p-3 text-[13px] text-ink-secondary"><Database size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{t("computer.miniApps.source.empty")}</div>}
      </div>}
    </section>
  );
}
