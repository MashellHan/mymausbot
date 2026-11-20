import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2 } from "lucide-react";

import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { BotDocumentConflict } from "@/lib/bot-documents";
import { cn } from "@/lib/cn";
import { intlLocale, t } from "@/lib/i18n";
import { saveMemoryDoc, type MemoryDoc } from "@/lib/memory";
import { utf8Bytes } from "@/lib/soul";
import type { Bot } from "@/state/store";
import { ConflictNotice } from "../bot-settings/MemorySection";
import { inputCls } from "../bot-settings/field";
import { buttonCls, Card, ColRow } from "./rows";

export function MemoryTextEditor({ bot, doc, mine, document = false, onDone }: {
  bot: Bot;
  doc: MemoryDoc;
  mine: boolean;
  document?: boolean;
  onDone: (saved: MemoryDoc | null) => void;
}) {
  return <MarkdownTextEditor
    botName={bot.name}
    file={doc.path}
    doc={doc}
    document={document}
    save={(text, expectedHash) => saveMemoryDoc(bot.id, doc.path, text, expectedHash, mine)}
    onDone={onDone}
  />;
}

type VersionedText = { text: string; hash: string };
type WriteResult<T> = { ok: true; doc: T } | ({ ok: false } & BotDocumentConflict);

export function MarkdownTextEditor<T extends VersionedText>({ botName, file, doc, document = false, maxBytes, showConflictCurrent, save, onDone }: {
  botName?: string;
  file: string;
  doc: T;
  document?: boolean;
  maxBytes?: number;
  showConflictCurrent?: boolean;
  save: (text: string, expectedHash: string) => Promise<WriteResult<T>>;
  onDone: (saved: T | null) => void;
}) {
  // A file not written yet has the empty file's hash, so the bot creating it meanwhile is a conflict too.
  const [base, setBase] = useState({ text: doc.text, hash: doc.hash });
  const [text, setText] = useState(doc.text);
  const [conflict, setConflict] = useState<BotDocumentConflict | null>(null);
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Full window shows the same text over the whole app; going in or out keeps what was typed.
  const [wide, setWide] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (document) return;
    if (firstRender.current) firstRender.current = false;
    else field.current?.focus();
  }, [wide, document]);
  // The file is saved either way; a save that lands after the person moved to another bot must not show in that bot's list.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const bytes = maxBytes === undefined ? 0 : utf8Bytes(text);
  const over = maxBytes !== undefined && bytes > maxBytes;
  const write = async (expectedHash: string) => {
    if (saving || over || conflict?.mirrorDrift) return;
    setSaving(true);
    setError(null);
    try {
      const result = await save(text, expectedHash);
      if (!mounted.current) return;
      if (result.ok) onDone(result.doc);
      else setConflict(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.message ? cause.message : t(document ? "botDocuments.saveFailed" : "botPanel.library.memoryError"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const reload = () => {
    if (!conflict) return;
    // A second Reload keeps the first kept draft too.
    setSavedDraft((kept) => (kept === null || kept === text ? text : `${kept}\n\n${text}`));
    setBase({ text: conflict.current, hash: conflict.currentHash });
    setText(conflict.current);
    setConflict(null);
    field.current?.focus();
  };

  const label = document ? file : t("memory.botMemory");
  const body = (
    <>
        {conflict && (conflict.mirrorDrift
          ? <p role="alert" className="text-[13px] text-danger">{conflict.reason ?? t("botDocuments.soulMirrorDrift")}</p>
          : <ConflictNotice botName={botName} reason={conflict.reason} current={showConflictCurrent ? conflict.current : undefined}
              busy={saving} overwriteDisabled={over} onReload={reload} onOverwrite={() => void write(conflict.currentHash)} />)}
        <textarea
          ref={field}
          data-memory-text=""
          className={cn(inputCls, wide ? "min-h-0 flex-1 resize-none" : "min-h-[280px] resize-y", "font-mono text-[13px] leading-relaxed", document && "focus-visible:ring-2 focus-visible:ring-focus")}
          value={text}
          placeholder={document ? undefined : t("memory.indexPlaceholder")}
          aria-label={label}
          aria-invalid={over || undefined}
          dir="auto"
          readOnly={saving}
          onChange={(event) => setText(event.target.value)}
        />
        {over && <p role="status" className="text-[12px] text-danger">
          {t("botIdentity.soul.bytesOver", { bytes: bytes.toLocaleString(intlLocale()), limit: maxBytes.toLocaleString(intlLocale()) })}
        </p>}
        {error && <div role="alert" className="text-[13px] text-danger">{error}</div>}
        {savedDraft !== null && <UnsavedDraft text={savedDraft} onDismiss={() => { setSavedDraft(null); field.current?.focus(); }} />}
        <div className="flex justify-end gap-2">
          {!document && <button type="button" data-memory-wide="" className={cn(buttonCls, "mr-auto inline-flex items-center gap-1.5")} onClick={() => setWide(!wide)}>
            {wide ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
            {t(wide ? "botPanel.memory.exitFullWindow" : "botPanel.memory.fullWindow")}
          </button>}
          {!document && <button type="button" className={buttonCls} disabled={saving} onClick={() => onDone(null)}>{t("common.cancel")}</button>}
          <button
            type="button"
            data-panel-done="memory-text"
            className={document ? "ui-button ui-button-primary" : buttonCls}
            disabled={saving || over || (document && conflict !== null) || text === base.text}
            onClick={() => void write(base.hash)}
          >
            {saving ? t("memory.saving") : t("memory.save")}
          </button>
        </div>
    </>
  );

  if (document) return <div className="space-y-3">{body}</div>;
  if (wide) return <MemoryFullWindow label={label} onClose={() => setWide(false)}>{body}</MemoryFullWindow>;
  return (
    <Card>
      <ColRow data-panel-row="memory-text">{body}</ColRow>
    </Card>
  );
}

function UnsavedDraft({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return <div data-memory-draft="">
    <div className="mb-1 text-[12px] text-ink-secondary">{t("memory.unsavedDraft")}</div>
    <pre dir="auto" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12px] leading-relaxed text-ink">
      {text}
    </pre>
    <button type="button" className={cn(buttonCls, "mt-1")} onClick={onDismiss}>{t("memory.dismissDraft")}</button>
  </div>;
}

function MemoryFullWindow({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-memory-full-window=""
      className="fixed inset-0 z-[65] flex flex-col gap-3 bg-app p-4 outline-none"
    >
      {children}
    </div>,
    document.body,
  );
}
