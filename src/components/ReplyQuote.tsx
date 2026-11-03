import { Reply, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { peerLine } from "@/lib/peer-message";
import { replyAuthor, replySnippet } from "@/lib/replies";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export function ReplyQuote({
  message,
  fallbackName,
  onJump,
  onClear,
  compact = false,
}: {
  message: Message | null;
  fallbackName?: string;
  onJump?: () => void;
  onClear?: () => void;
  compact?: boolean;
}) {
  const name = message ? replyAuthor(message, fallbackName) : t("chat.reply.sourceUnavailable");
  const excerpt = message ? replySnippet(peerLine(message)?.body ?? message.text ?? "") : null;
  const screenReaderLabel = message ? t("chat.reply.replyingTo", { name }) : name;
  const body = (
    <>
      <Reply size={compact ? 14 : 15} strokeWidth={1.5} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
      <span className="sr-only">{screenReaderLabel}: </span>
      <span aria-hidden="true" className="shrink-0 font-medium text-ink">{name}</span>
      {excerpt && <span dir="auto" className="min-w-0 flex-1 truncate">{excerpt}</span>}
    </>
  );
  return (
    <div data-reply-quote className={cn(
      "flex min-w-0 items-center gap-2 rounded-2xl bg-ink/[0.06] text-ink-secondary",
      compact ? "py-1 ps-2.5 pe-2 text-[13px] leading-5" : "py-1.5 ps-3 pe-1.5 text-[13px] leading-5",
    )}>
      {onJump && message ? (
        <button type="button" onClick={onJump} className="flex min-w-0 flex-1 items-center gap-2 rounded-xl text-start hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" title={t("chat.reply.jump")}>
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">{body}</div>
      )}
      {onClear && (
        <button type="button" onClick={onClear} aria-label={t("chat.reply.cancel")} className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function ComposerReplyStrip({
  message,
  fallbackName,
  onClear,
}: {
  message: Message | null;
  fallbackName?: string;
  onClear?: () => void;
}) {
  const name = message ? replyAuthor(message, fallbackName) : t("chat.reply.sourceUnavailable");
  const who = message ? t("chat.reply.replyingTo", { name }) : name;
  const excerpt = message ? replySnippet(peerLine(message)?.body ?? message.text ?? "") : null;
  const guidance = message ? null : t("chat.reply.cancelToSend");
  return (
    <div
      role="group"
      aria-label={guidance ? `${who}. ${guidance}` : who}
      title={guidance ?? who}
      data-composer-reply=""
      className="mb-1 flex min-w-0 items-center gap-2 rounded-2xl bg-ink/[0.06] py-1.5 ps-3 pe-1.5 text-[13px] leading-5 text-ink-secondary"
    >
      <Reply size={15} strokeWidth={1.5} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />
      <span className="sr-only">{who}: </span>
      {message ? <>
        <span aria-hidden="true" dir="auto" className="max-w-[35%] shrink-0 truncate font-medium text-ink">{name}</span>
        <span dir="auto" className="min-w-0 flex-1 truncate">{excerpt}</span>
      </> : <span className="min-w-0 flex-1">
        <span aria-hidden="true" className="block font-medium text-ink">{name}</span>
        <span className="block text-[11px] leading-4">{guidance}</span>
      </span>}
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label={t("chat.reply.cancel")}
          title={t("chat.reply.cancel")}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
