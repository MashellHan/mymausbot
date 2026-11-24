import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { copyText } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { api, ApiError } from "@/state/store";
import { LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES, type LocalAgentRoleDocument,
  type LocalAgentRoleDocumentTarget } from "../../../shared/local-dashboard";
import { AgentDocumentMarkdown } from "../AgentDocumentMarkdown";
import { MarkdownTextEditor } from "../bot-panel/MemoryTextEditor";

export type AgentRoleEditorSelection = LocalAgentRoleDocumentTarget & { appId: string; revision: number };

export function AgentRoleEditor({ selection, onClose, onSaved }: {
  selection: AgentRoleEditorSelection;
  onClose(): void;
  onSaved(): void;
}) {
  const { agentId, occupantId, appId, revision } = selection;
  const endpoint = `/api/mini-apps/${encodeURIComponent(appId)}/agent-md`;
  const target = { agentId, occupantId, expectedRevision: revision };
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [attempt, setAttempt] = useState(0);
  const [doc, setDoc] = useState<LocalAgentRoleDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "empty" | "failed">();

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); };
  }, []);
  useEffect(() => {
    const request = new AbortController();
    void api<LocalAgentRoleDocument>(endpoint, {
      method: "POST", body: JSON.stringify({ agentId, occupantId, expectedRevision: revision }), signal: request.signal,
    }).then((result) => {
      if (!request.signal.aborted) setDoc(result);
    }, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
  }, [agentId, occupantId, revision, endpoint, attempt]);

  const close = () => { if (!saving) onClose(); };
  const save = async (text: string, expectedHash: string) => {
    if (!doc) throw new Error(t("agentRoleEditor.loadFailed"));
    setSaving(true);
    try {
      const next = await api<LocalAgentRoleDocument>(endpoint, {
        method: "PUT", body: JSON.stringify({ ...target, documentId: doc.documentId, expectedHash, text }),
      });
      return { ok: true as const, doc: next };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body?.code === "conflict"
          && typeof error.body.current === "string" && typeof error.body.currentHash === "string") {
        return { ok: false as const, current: error.body.current, currentHash: error.body.currentHash };
      }
      throw new Error(t("agentRoleEditor.saveFailed"));
    } finally { setSaving(false); }
  };

  return createPortal(<dialog ref={dialog} aria-labelledby={title} data-agent-role-editor
    onCancel={(event) => { event.preventDefault(); close(); }}
    className="m-auto max-h-[90dvh] w-[min(48rem,calc(100vw-2rem))] overflow-auto rounded-xl border border-hairline bg-panel p-4 text-ink shadow-xl backdrop:bg-black/50">
    <header className="mb-4 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id={title} className="text-[15px] font-semibold">{t("agentRoleEditor.title")}</h2>
        {doc && <p className="break-words text-[13px] text-ink-secondary" dir="auto">{doc.agentName} · {doc.file}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className="ui-button" disabled={!doc || failed || saving} onClick={() => setPreview(!preview)}>
          {t(preview ? "agentRoleEditor.edit" : "agentRoleEditor.preview")}
        </button>
        <button type="button" className="ui-button" onClick={close} disabled={saving}>{t("common.close")}</button>
      </div>
    </header>
    {failed ? <div className="space-y-2">
      <p role="alert" className="text-[13px] text-danger">{t("agentRoleEditor.loadFailed")}</p>
      <button type="button" className="ui-button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>{t("app.strip.retry")}</button>
    </div> : doc ? <div className="space-y-3">
      {doc.memberNames.length > 1 && <p className="break-words text-[13px] text-ink-secondary" dir="auto">
        {t("agentRoleEditor.shared", { names: doc.memberNames.join(", ") })}
      </p>}
      <MarkdownTextEditor key={doc.hash} file={doc.file} doc={doc} document showConflictCurrent maxBytes={LOCAL_AGENT_ROLE_DOCUMENT_MAX_BYTES}
        renderPreview={preview ? (draft, region) => <section ref={region} aria-label={t("agentRoleEditor.preview")} tabIndex={0}
          className="min-h-[280px] max-h-[50dvh] overflow-auto rounded-lg border border-hairline bg-inset p-3 focus-visible:outline-2 focus-visible:outline-accent
            [&_th]:text-start [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1 [&_tr]:border-b [&_tr]:border-hairline">
          <AgentDocumentMarkdown markdown={draft} />
        </section> : undefined}
        save={save} onDone={(result) => {
          if (!result) return;
          setDoc(result);
          setSaved(true);
          setCopyStatus(undefined);
          onSaved();
        }} />
      {saved && <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
        <p role="status" className="text-ink-secondary">{t(doc.runtime === "pi" ? "agentRoleEditor.savedPi" : "agentRoleEditor.saved")}</p>
        <button type="button" className="ui-button" onClick={() => {
          void copyText(t("agentRoleEditor.reloadRequest", { path: JSON.stringify(doc.sourcePath) })).then(setCopyStatus);
        }}>{t("agentRoleEditor.copyReload")}</button>
        {copyStatus === "copied" && <span role="status">{t("table.copied")}</span>}
        {copyStatus === "failed" && <span role="alert">{t("common.copyFailed")}</span>}
      </div>}
    </div> : <p role="status" className="text-[13px] text-ink-secondary">{t("memory.loading")}</p>}
  </dialog>, document.body);
}
