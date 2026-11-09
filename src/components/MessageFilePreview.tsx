import { useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { filePreviewKind, type MessageFilePreview as PreviewFile } from "@/lib/file-preview";
import { tableDelimiter } from "@/lib/table-data";
import { t } from "@/lib/i18n";
import { requestMessageFile, saveFailureText, useLocalFileSave } from "./AttachmentPreview";
import { ChatMarkdown } from "./ChatMarkdown";
import { SaveIconButton } from "./HtmlFilePreview";
import { readTableResponse, TableFileContent } from "./TableFilePreview";

export const MARKDOWN_PREVIEW_MAX_BYTES = 1024 * 1024;

export function MessageFilePreview({ file, onBack }: { file: PreviewFile; onBack?: () => void }) {
  const back = useRef<HTMLButtonElement>(null);
  const save = useLocalFileSave(file.path, file.name, file.message);
  useEffect(() => { back.current?.focus(); }, []);
  const delimiter = tableDelimiter(file.name) ?? tableDelimiter(file.path);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={t("file.preview", { name: file.name })}
      onKeyDown={(event) => {
        if (event.key === "Escape" && onBack && !event.defaultPrevented) {
          event.preventDefault(); event.stopPropagation(); onBack();
        }
      }}>
      <header className="flex min-w-0 items-center gap-2 border-b border-hairline/40 px-4 py-2">
        {onBack && <button ref={back} type="button" className="table-action shrink-0" onClick={onBack}
          title={t("file.back")} aria-label={t("file.back")}><ArrowLeft size={16} aria-hidden="true" /></button>}
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={file.name}>{file.name}</h2>
        <SaveIconButton name={file.name} save={save} retryable={save.state === "failed" && !save.outsideWorkspace} />
      </header>
      {save.state === "failed" && <p role="alert" className="px-4 pt-2 text-[12px] text-danger">{saveFailureText(save)}</p>}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
        {filePreviewKind(file.name, file.path) === "markdown"
          ? <MarkdownFileContent file={file} />
          : delimiter && <TableFileContent {...file} delimiter={delimiter} />}
      </div>
    </section>
  );
}

function MarkdownFileContent({ file }: { file: PreviewFile }) {
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<"size" | "format" | "load" | "outside_workspace" | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setSource(null);
    setError(null);
    void (async () => {
      try {
        const response = await requestMessageFile(file.path, file.message, controller.signal);
        const text = await readTableResponse(response, controller.signal, MARKDOWN_PREVIEW_MAX_BYTES);
        if (text.includes("\0")) throw new Error("format");
        if (!controller.signal.aborted) setSource(text);
      } catch (reason) {
        if (controller.signal.aborted) return;
        const code = (reason as { code?: unknown } | null)?.code;
        setError(code === "outside_workspace" ? code
          : reason instanceof Error && (reason.message === "size" || reason.message === "format") ? reason.message : "load");
      }
    })();
    return () => controller.abort();
  }, [file.path, file.message.threadId, file.message.messageId, attempt]);
  if (error) return <div className="py-6 text-[13px] text-ink-secondary">
    <p role="alert">{t(error === "size" ? "file.tooLarge" : error === "format" ? "file.invalid"
      : error === "outside_workspace" ? "attach.outsideWorkspace" : "file.loadFailed")}</p>
    {error === "load" && <button type="button" className="ui-button ui-button-sm mt-3" onClick={() => setAttempt((value) => value + 1)}>{t("chat.retry")}</button>}
  </div>;
  if (source === null) return <div role="status" className="flex items-center gap-2 py-6 text-[13px] text-ink-secondary">
    <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />{t("file.loading")}
  </div>;
  if (!source.trim()) return <p className="py-6 text-[13px] text-ink-secondary">{t("file.empty")}</p>;
  return <article className="min-w-0 max-w-[75ch] text-[14px] leading-relaxed break-words"><ChatMarkdown text={source} /></article>;
}
