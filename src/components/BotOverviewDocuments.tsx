import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";

import { t } from "@/lib/i18n";
import { readBotDocument, writeBotDocument, type BotDocument, type BotDocumentKind } from "@/lib/bot-documents";
import { MEMORY_INDEX, SOUL_PATH, fetchMemoryDoc, type MemoryDoc } from "@/lib/memory";
import { useStore, type Bot } from "@/state/store";
import { SoulDocumentField } from "./SoulField";
import { MarkdownTextEditor, MemoryTextEditor } from "./bot-panel/MemoryTextEditor";
import { buttonCls, Card, NavRow, PageHeader } from "./bot-panel/rows";

const documents = [
  { id: "soul", label: "botSettings.sections.soul", file: SOUL_PATH },
  { id: "memory", label: "botSettings.sections.memory", file: MEMORY_INDEX },
  { id: "agents", label: "botDocuments.agents", file: "AGENTS.md" },
] as const;
type Document = typeof documents[number];

export function BotOverviewDocuments({ bot, intro, children }: { bot: Bot; intro: ReactNode; children: ReactNode }) {
  const mine = Boolean(useStore().state.config?.team);
  const [selected, setSelected] = useState<Document | null>(null);
  const overview = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const opener = useRef<Document["id"] | null>(null);

  useEffect(() => {
    if (selected) page.current?.querySelector<HTMLButtonElement>("[data-panel-back]")?.focus();
    else if (opener.current) {
      overview.current?.querySelector<HTMLButtonElement>(`[data-panel-page="${opener.current}"]`)?.focus();
      opener.current = null;
    }
  }, [selected]);

  const back = () => setSelected(null);
  return <>
    <div ref={overview} hidden={selected !== null}>
      {intro}
      <Card anchor="documents">
        {documents.map((entry) => <NavRow
          key={entry.id}
          data-panel-page={entry.id}
          title={t(entry.label)}
          icon={FileText}
          onClick={() => { opener.current = entry.id; setSelected(entry); }}
        />)}
      </Card>
      {children}
    </div>
    {selected && <div ref={page} className="space-y-3 pt-2" data-bot-document={selected.id}>
      <PageHeader back={t("rail.back")} title={selected.file} onBack={back} />
      {selected.id === "memory"
        ? bot.memoryEnabled === false
          ? <p className="text-[13px] text-ink-secondary">{t("botPanel.library.memoryOff", { name: bot.name })}</p>
          : <MemoryDocument key={String(mine)} bot={bot} mine={mine} onSaved={back} />
        : <StandingDocument botId={bot.id} kind={selected.id} file={selected.file} onSaved={back} />}
    </div>}
  </>;
}

function StandingDocument({ botId, kind, file, onSaved }: { botId: string; kind: BotDocumentKind; file: string; onSaved: () => void }) {
  const { flushBotPatches } = useStore();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<BotDocument | string | null>(null);
  useEffect(() => {
    const request = new AbortController();
    const load = async () => {
      try {
        if (kind === "soul") await flushBotPatches(botId);
        if (request.signal.aborted) return;
        const doc = await readBotDocument(botId, kind, request.signal);
        if (!request.signal.aborted) setResult(doc);
      } catch (error) {
        if (!request.signal.aborted) setResult(error instanceof Error && error.message ? error.message : t("botDocuments.loadFailed"));
      }
    };
    void load();
    return () => request.abort();
  }, [attempt, botId, kind, flushBotPatches]);

  if (result === null) return <p role="status" className="text-[13px] text-ink-secondary">{t("memory.loading")}</p>;
  if (typeof result === "string") return <DocumentLoadError message={result} onRetry={() => { setResult(null); setAttempt((value) => value + 1); }} />;
  const save = (text: string, expectedHash: string) => writeBotDocument(botId, kind, text, expectedHash);
  if (kind === "soul") return <SoulDocumentField document={result} save={save} onSaved={onSaved} />;
  return <MarkdownTextEditor file={file} doc={result} document showConflictCurrent save={save} onDone={(saved) => { if (saved) onSaved(); }} />;
}

function MemoryDocument({ bot, mine, onSaved }: { bot: Bot; mine: boolean; onSaved: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<MemoryDoc | "error" | null>(null);
  useEffect(() => {
    let active = true;
    void fetchMemoryDoc(bot.id, MEMORY_INDEX, mine).then(
      (doc) => { if (active) setResult(doc); },
      () => { if (active) setResult("error"); },
    );
    return () => { active = false; };
  }, [attempt, bot.id, mine]);

  if (result === null) return <p role="status" className="text-[13px] text-ink-secondary">{t("memory.loading")}</p>;
  if (result === "error") return <DocumentLoadError message={t("botPanel.library.memoryError")} onRetry={() => { setResult(null); setAttempt((value) => value + 1); }} />;
  return <MemoryTextEditor bot={bot} doc={result} mine={mine} document onDone={(saved) => { if (saved) onSaved(); }} />;
}

function DocumentLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="space-y-2">
    <p role="alert" className="text-[13px] text-danger">{message}</p>
    <button type="button" className={buttonCls} onClick={onRetry}>{t("app.strip.retry")}</button>
  </div>;
}
