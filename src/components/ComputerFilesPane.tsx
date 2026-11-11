import { FileText, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, visibleMessages, type Bot } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { collectMessageFiles, fileIdentity, splitMessageAttachments, type GalleryFile } from "./AttachmentGallery";
import { AttachedFileChip, type MessageAttachmentContext } from "./AttachmentPreview";
import { shortPath } from "@/lib/short-path";
import { intlLocale, t } from "@/lib/i18n";
import { localDay } from "@/lib/transcript-derivations";
import { openBotSettings } from "./bot-panel/panel-link";
import type { PanelFilePreview } from "@/lib/file-preview";
import { MessageFilePreview } from "./MessageFilePreview";

const MAX_FILES = 20;

function changedFileEntries(bot: Bot, limit = MAX_FILES): Array<{ path: string; at: number }> {
  const seen = new Set<string>();
  const files: Array<{ path: string; at: number }> = [];
  const messages = visibleMessages(bot);
  for (let index = messages.length - 1; index >= 0 && files.length < limit; index -= 1) {
    const digestFiles = messages[index]!.digest?.files;
    if (!digestFiles) continue;
    for (const path of digestFiles.deleted) seen.add(path);
    for (const path of [...digestFiles.added, ...digestFiles.changed]) {
      if (seen.has(path)) continue;
      seen.add(path);
      files.push({ path, at: messages[index]!.at });
      if (files.length >= limit) break;
    }
  }
  return files;
}

export function recentChangedFiles(bot: Bot, limit = MAX_FILES): string[] {
  return changedFileEntries(bot, limit).map(({ path }) => path);
}

interface SharedFile {
  file: GalleryFile;
  message: MessageAttachmentContext;
  source: string;
  at: number;
  referenceAt: number;
  keys: Set<string>;
}

/**
 * Security: a digest records changes, not permission to read; reuse only a visible reply's existing file grant, with
 * its URL spelling and message id for the server to validate.
 */
export function sharedFileEntries(bot: Bot): SharedFile[] {
  const references = new Map<string, SharedFile>();
  const messages = visibleMessages(bot);
  const originals = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "bot" || message.kind !== "text") continue;
    for (const [copy, source] of Object.entries(splitMessageAttachments(message.attachments).originals)) originals.set(copy, source);
  }
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  const cwd = task?.cwd === undefined ? bot.cwd : task.cwd;
  const windows = cwd && (/^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\"));
  const spelling = (path: string) => windows ? path.replace(/\\/g, "/") : path;
  const prefix = typeof cwd === "string" ? `${spelling(cwd).replace(/\/+$/, "")}/` : undefined;
  for (const message of messages) {
    if (message.role !== "bot" || message.kind !== "text") continue;
    const attached = splitMessageAttachments(message.attachments);
    const files = [
      ...attached.files,
      ...collectMessageFiles(message.text ?? "", [...attached.images, ...attached.files.map((file) => file.path)]),
    ];
    for (const file of files) {
      const path = file.private ? file.path : fileIdentity(file.path);
      const source = attached.originals[file.path] ?? originals.get(path) ?? path;
      const canonical = windows ? spelling(source).toLowerCase() : source;
      const keys = new Set<string>();
      for (const identity of [source, path]) {
        keys.add(identity);
        // Security: a digest path gains a relative alias only beneath this chat's exact folder.
        const spelled = spelling(identity);
        const inFolder = prefix && (windows
          ? spelled.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
          : spelled.startsWith(prefix));
        if (inFolder) keys.add(spelled.slice(prefix.length));
        if (identity.startsWith("./")) keys.add(identity.replace(/^(\.\/)+/, ""));
      }
      const held = references.get(canonical);
      if (!held) {
        references.set(canonical, {
          file, message: { threadId: bot.threadId, messageId: message.id }, source,
          at: message.at, referenceAt: message.at, keys,
        });
        continue;
      }
      held.at = Math.max(held.at, message.at);
      for (const key of keys) held.keys.add(key);
      if ((Boolean(file.private) && !held.file.private)
        || (Boolean(file.private) === Boolean(held.file.private) && message.at >= held.referenceAt)) {
        held.file = file;
        held.message = { threadId: bot.threadId, messageId: message.id };
        held.referenceAt = message.at;
      }
    }
  }
  return [...references.values()].sort((a, b) => b.at - a.at);
}

function referenceMap(entries: readonly SharedFile[]): Map<string, SharedFile> {
  const references = new Map<string, SharedFile>();
  for (const entry of entries) for (const key of entry.keys) if (!references.has(key)) references.set(key, entry);
  return references;
}

export function sharedFileReferences(bot: Bot): Map<string, SharedFile> {
  return referenceMap(sharedFileEntries(bot));
}

function splitPath(path: string): { name: string; folder: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? { name: path, folder: "" } : { name: path.slice(cut + 1), folder: path.slice(0, cut) };
}

export function ComputerFilesPane({ bot, filePreview, onPreviewClose }: {
  bot: Bot; filePreview?: PanelFilePreview | null; onPreviewClose?: () => void;
}) {
  const { dispatch, state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  const pinned = task?.cwd;
  const cwd = pinned === undefined ? bot.cwd : pinned;
  const locale = intlLocale();
  const groups = useMemo(() => {
    const shared = sharedFileEntries(bot);
    const references = referenceMap(shared);
    const rows = [
      ...shared.map((entry) => ({ path: entry.source, at: entry.at, reference: entry })),
      ...changedFileEntries(bot, Number.POSITIVE_INFINITY)
        .filter(({ path }) => !references.has(path))
        .map(({ path, at }) => ({ path, at, reference: undefined })),
    ].sort((a, b) => b.at - a.at);
    const dated: Array<{ day: number; label: string; rows: typeof rows }> = [];
    for (const row of rows) {
      const day = localDay(row.at);
      const last = dated.at(-1);
      if (last?.day === day) last.rows.push(row);
      else dated.push({ day, label: new Date(row.at).toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" }), rows: [row] });
    }
    return dated;
  }, [bot.messages, bot.activeLeafId, bot.threadId, bot.tasks, bot.cwd, locale]);
  const scope = `${bot.id}\0${bot.threadId}\0${bot.activeLeafId ?? ""}`;
  const [historyError, setHistoryError] = useState<{ scope: string; message: string } | null>(null);
  const loading = Boolean(state.loadingOlder?.[bot.threadId]);
  const list = useRef<HTMLDivElement>(null);
  const ours = filePreview?.botId === bot.id && filePreview.message.threadId === bot.threadId ? filePreview : null;
  const preview = ours && visibleMessages(bot).some((message) => message.id === ours.message.messageId) ? ours : null;
  useEffect(() => {
    if (filePreview && !preview) onPreviewClose?.();
  }, [filePreview, preview, onPreviewClose]);
  return (
    <>
    <div ref={list} hidden={Boolean(preview)} tabIndex={-1} className="flex-1 overflow-y-auto px-5 pb-5 [color-scheme:var(--code-color-scheme)]" data-testid="computer-files">
      <div className="mt-2 rounded-xl bg-card p-4">
        <div className="text-[14px] font-semibold text-ink">{t("computer.files.folder")}</div>
        <div className="mt-2 flex items-center gap-2">
          <FolderOpen size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" title={cwd ?? undefined}>
            {cwd ? shortPath(cwd, home) : cwd === null ? t("computer.files.homeFolder") : t("computer.files.privateFolder", { name: bot.name })}
          </span>
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "toggleComputer", open: false });
              openBotSettings(dispatch, "access", { page: "folder" });
            }}
            className="shrink-0 rounded-lg bg-control px-2.5 py-1 text-[12px] text-ink hover:bg-raised-hover"
          >
            {t(pinned === undefined ? "computer.files.changeFolder" : "computer.files.changeDefaultFolder")}
          </button>
        </div>
        {pinned !== undefined && <p className="mt-2 text-[12px] leading-5 text-ink-secondary">{t("computer.files.pinnedFolderHint")}</p>}
      </div>
      <div className="mt-3 rounded-xl bg-card p-4">
        <h2 className="text-[16px] font-semibold text-ink">{t("computer.files.title")}</h2>
        {groups.length === 0 ? (
          <p className="mt-2 text-[12px] leading-5 text-ink-secondary">{t("computer.files.emptyShared", { name: bot.name })}</p>
        ) : (
          <div className="mt-4 space-y-5">
          {groups.map((group) => <section key={group.day}>
            <h3 className="mb-2 border-b border-hairline pb-2 text-[13px] font-semibold text-ink">{group.label}</h3>
            <ul className="flex flex-col gap-2">
            {group.rows.map(({ path, reference }) => {
              const { name, folder } = splitPath(path);
              return (
                <li key={path} className="min-w-0 rounded-lg py-1" title={path}>
                  {reference ? (
                    <AttachedFileChip
                      key={`${reference.message.threadId}:${reference.message.messageId}:${reference.file.path}`}
                      file={reference.file}
                      message={reference.message}
                      linked={reference.file.linked}
                      className="w-full max-w-none border-hairline bg-panel text-[13px] [&_.truncate]:font-medium [&_.truncate]:text-[light-dark(#1d4ed8,#7fc0ff)] [&_.lucide-file-text]:text-[light-dark(#1d4ed8,#7fc0ff)]"
                    />
                  ) : (
                    <div className="flex min-w-0 items-center gap-2 px-2.5 py-2" title={t("computer.files.notSharedHint")}>
                      <FileText size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
                      <span className="shrink-0 text-[11px] text-ink-tertiary">{t("computer.files.notShared")}</span>
                    </div>
                  )}
                  {folder && <div className="mt-1 truncate px-2.5 text-[11px] text-ink-tertiary">{shortPath(folder, home)}</div>}
                </li>
              );
            })}
            </ul>
          </section>)}
          </div>
        )}
        {bot.hasMore && <button type="button" disabled={loading} onClick={() => {
          setHistoryError(null);
          dispatch({ type: "loadOlderMessages", threadId: bot.threadId, onError: () => setHistoryError({ scope, message: t("computer.files.olderError") }) });
        }} className="mt-3 rounded-lg bg-control px-2.5 py-1.5 text-[12px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-wait disabled:opacity-60">
          {loading ? t("computer.files.loadingOlder") : historyError?.scope === scope ? t("chat.retry") : t("computer.files.loadOlder")}
        </button>}
        {historyError?.scope === scope && <p role="alert" className="mt-2 text-[12px] text-danger">{historyError.message}</p>}
        {bot.hasMore === false && groups.length > 0 && <p className="mt-3 text-[11px] text-ink-tertiary">{t("computer.files.end")}</p>}
      </div>
    </div>
    {preview && <MessageFilePreview key={preview.nonce} file={preview} onBack={() => {
      onPreviewClose?.();
      requestAnimationFrame(() => { (list.current?.contains(preview.returnFocus) ? preview.returnFocus : list.current)?.focus(); });
    }} />}
    </>
  );
}
