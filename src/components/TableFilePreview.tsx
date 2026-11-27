import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { requestMessageFile, type MessageAttachmentContext } from "./AttachmentPreview";
import { OutsideWorkspacePreview, canOpenOutsideWorkspace, refusedAsOutsideWorkspace } from "./OutsideWorkspacePreview";
import { RichTable } from "./RichTable";
import { TABLE_FILE_MAX_BYTES, type TextTable } from "@/lib/table-data";
import { t } from "@/lib/i18n";

/** A preview limit, not a download limit: chunked responses are bounded too. Text that is not UTF-8 is refused, unless
 * `fallback` names a single-byte encoding to read it in instead; a NUL byte (UTF-16, binary) is refused even
 * then, since such an encoding would only show it as garbage. */
export async function readTableResponse(response: Response, signal: AbortSignal, maxBytes = TABLE_FILE_MAX_BYTES, fallback?: string): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel().catch(() => {}); throw new Error("size"); // A body that already errored must not hide "size".
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (value?: Uint8Array, stream = false) => {
    try { return decoder.decode(value, { stream }); }
    catch { throw new Error("format"); }
  };
  const parts: Uint8Array[] = [];
  let size = 0, text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error("size");
      if (fallback) parts.push(part.value); else text += decode(part.value, true);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!fallback) return text + decode();
  const bytes = new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
  // NUL is valid UTF-8, so UTF-16 without a byte order mark would pass the UTF-8 check: look for it first.
  if (fallback && bytes.includes(0)) throw new Error("encoding");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    return new TextDecoder(fallback).decode(bytes);
  }
}

export function TableFileContent({ path, name, message, delimiter }: {
  path: string; name: string; message: MessageAttachmentContext; delimiter: "," | "\t";
}) {
  const fileKey = `${message.threadId}:${message.messageId}:${path}`;
  const [attempt, setAttempt] = useState(0);
  const [table, setTable] = useState<TextTable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canOpenOutside, setCanOpenOutside] = useState(false);
  const [allowOutsideFor, setAllowOutsideFor] = useState<string | null>(null);
  const allowOutside = allowOutsideFor === fileKey;
  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | undefined;
    setError(null);
    setCanOpenOutside(false);
    setTable(null);
    const fail = (reason: string) => {
      if (!controller.signal.aborted) setError(reason);
      worker?.terminate();
    };
    void (async () => {
      try {
        const response = await requestMessageFile(path, message, controller.signal, allowOutside ? { allowOutsideWorkspace: true } : undefined);
        const text = await readTableResponse(response, controller.signal);
        controller.signal.throwIfAborted();
        worker = new Worker(new URL("../lib/table-file.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<{ table?: TextTable; error?: string }>) => {
          if (event.data.error) fail(event.data.error);
          else if (!controller.signal.aborted && event.data.table) setTable(event.data.table);
          worker?.terminate();
        };
        worker.onerror = () => fail("format");
        worker.postMessage({ text, delimiter });
      } catch (reason) {
        if (!controller.signal.aborted && refusedAsOutsideWorkspace(reason)) setCanOpenOutside(canOpenOutsideWorkspace(reason));
        fail(refusedAsOutsideWorkspace(reason) ? "outside" : reason instanceof Error && (reason.message === "size" || reason.message === "format") ? reason.message : "load");
      }
    })();
    return () => { controller.abort(); worker?.terminate(); };
  }, [path, message.threadId, message.messageId, delimiter, attempt, allowOutside]);
  const data = useMemo(() => table && ({ columns: table.headers.map((text) => ({ text })), rows: table.rows.map((row) => row.map((text) => ({ text }))) }), [table]);
  if (error === "outside") return <OutsideWorkspacePreview filePath={path} onOpenOutside={canOpenOutside ? () => setAllowOutsideFor(fileKey) : undefined} />;
  if (error) return <div className="py-6 text-sm"><p role="alert" className="mb-3 text-ink-secondary">{t(error === "size" ? "table.tooLarge" : error === "columns" || error === "format" ? "table.invalid" : "table.loadFailed")}</p>{error === "load" && <button type="button" className="ui-button ui-button-sm" onClick={() => setAttempt(attempt + 1)}>{t("chat.retry")}</button>}</div>;
  if (!data) return <div role="status" className="flex items-center justify-center gap-2 p-12 text-sm text-ink-secondary"><LoaderCircle size={16} className="animate-spin" />{t("table.loading")}</div>;
  return <RichTable {...data} name={name} expanded />;
}
