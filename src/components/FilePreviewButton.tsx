import { useRef, useState } from "react";
import { filePreviewKind, useFilePanelOpener } from "@/lib/file-preview";
import { t } from "@/lib/i18n";
import type { MessageAttachmentContext, useLocalFileSave } from "./AttachmentPreview";
import { isHtmlFile, useHtmlPreview } from "./HtmlFilePreview";
import { MessageFilePreview } from "./MessageFilePreview";
import { TableDialog } from "./RichTable";

export function useFilePreview(path: string, name: string, message?: MessageAttachmentContext) {
  const inline = useHtmlPreview(path, name, message);
  const openPanel = useFilePanelOpener();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement | null>(null);
  const kind = filePreviewKind(name, path);
  const available = inline.opens || Boolean(message && kind);
  const label = inline.opens ? inline.label : t(kind === "table" ? "table.preview" : "file.preview", { name });
  return {
    available,
    label,
    show: (event: { currentTarget: HTMLElement }) => {
      if (isHtmlFile(name) || isHtmlFile(path)) { inline.show(event); return; }
      if (!message || !kind) return;
      trigger.current = event.currentTarget;
      if (openPanel({ path, name, message }, event.currentTarget)) return;
      if (inline.opens) { inline.show(event); return; }
      setOpen(true);
    },
    dialog: inline.dialog ?? (open && message && kind
      ? <TableDialog title={name} returnFocus={trigger.current} onClose={() => setOpen(false)}>
        <MessageFilePreview key={`${message.threadId}:${message.messageId}:${path}`} file={{ path, name, message }} />
      </TableDialog> : null),
  };
}

export function chipNameAction(preview: ReturnType<typeof useFilePreview>, save: ReturnType<typeof useLocalFileSave>, name: string, retryable: boolean) {
  if (preview.available) return { onClick: preview.show, disabled: false, "aria-label": preview.label };
  return { onClick: () => void save.save(), disabled: save.state === "saving", "aria-label": t(retryable ? "attach.retrySaveAria" : "attach.saveAria", { name }) };
}
