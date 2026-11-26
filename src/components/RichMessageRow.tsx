import { AppWindow, Crosshair, Loader2, RotateCw } from "lucide-react";
import { discardOutboxSend, retryOutboxSend, useOutboxRecord } from "@/state/pwa-outbox";
import type { Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { AppMessage } from "./app/AppMessage";
import { BugReportNote } from "./BugReportNote";
import { BurstCard } from "./BurstCard";
import { GoalRunRow } from "./GoalRunCard";
import { HelperKeySuggestion } from "./HelperKeySuggestion";
import { MessageBoundary } from "./MessageBoundary";
import { SettingsCard } from "./SettingsCard";
import { UserIntakeNote } from "./ProgressiveIntakeNote";
import { WidgetMessage } from "./widget/WidgetMessage";

export function richRowKind(message: Message): Message["kind"] {
  // MausBot's follow-up is text the model reads, drawn under its intro's card row (OptionsCardRow).
  if (message.helperFollowup) return "options";
  if (message.setupSuggestion || message.settingsCard || (message.kind === "goal.run" && message.goalRun) || (message.kind === "burst" && message.burst)) return "widget";
  if (message.kind === "widget" && !message.widget) return "text";
  if (message.kind === "app" && !message.app) return "text";
  return message.kind;
}

/** `room`: shown to everyone in a room, view-only. */
export function RichMessageRow({ botId, botName, threadId, message, room }: { botId: string; botName: string; threadId?: string; message: Message; room?: boolean }) {
  return (
    <MessageBoundary fallbackText={message.text ?? ""}>
      {message.settingsCard
        ? <SettingsCard message={message} />
        : message.setupSuggestion
        ? <HelperKeySuggestion threadId={threadId} message={message} />
        : message.kind === "burst" && message.burst
          ? <div className="flex justify-start"><BurstCard card={message.burst} /></div>
        : message.kind === "goal.run"
          ? <GoalRunRow botId={botId} threadId={threadId} message={message} />
          : message.kind === "app"
            ? <AppMessage botId={botId} botName={botName} threadId={threadId} message={message} room={room} />
            : <WidgetMessage botId={botId} threadId={threadId} message={message} viewOnly={room} />}
    </MessageBoundary>
  );
}

/** A page, an app or a widget a room member showed: the same row as in its own chat, view-only. */
export function RoomRichRow({ message, from, threadId }: { message: Message; from: NonNullable<Message["from"]>; threadId: string }) {
  return (
    <div className="flex justify-start">
      <RichMessageRow botId={from.botId} botName={from.name} threadId={threadId} message={message} room />
    </div>
  );
}

function OutboxStatusNote({ sendId }: { sendId: string | undefined }) {
  const record = useOutboxRecord(sendId);
  if (!record) return null;
  if (record.status === "queued") {
    return (
      <span data-outbox-status="queued" className="mt-1 inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
        {t("chat.outbox.queued")}
      </span>
    );
  }
  if (record.status === "sending" || record.status === "resending") {
    return (
      <span data-outbox-status={record.status} className="mt-1 inline-flex items-center gap-1 text-[11px] text-ink-tertiary">
        <Loader2 aria-hidden="true" size={10} className="animate-spin" />
        <span>{t(record.status === "sending" ? "chat.outbox.sending" : "chat.outbox.resending")}</span>
      </span>
    );
  }
  if (record.status === "failed") {
    return (
      <span data-outbox-status="failed" className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-danger" title={record.lastError}>
        <button
          type="button"
          data-outbox-retry={record.sendId}
          onClick={() => void retryOutboxSend(record.sendId)}
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:opacity-80"
        >
          <RotateCw aria-hidden="true" size={10} />
          <span>{t("chat.outbox.failedRetry")}</span>
        </button>
        <button
          type="button"
          data-outbox-discard={record.sendId}
          onClick={() => void discardOutboxSend(record.sendId)}
          className="text-ink-tertiary underline underline-offset-2 hover:text-ink"
        >
          {t("chat.outbox.discard")}
        </button>
      </span>
    );
  }
  return (
    <span data-outbox-status="rejected" className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-danger">
      <span>{record.lastError ? t("chat.outbox.rejectedWithError", { error: record.lastError }) : t("chat.outbox.rejected")}</span>
      <button
        type="button"
        data-outbox-discard={record.sendId}
        onClick={() => void discardOutboxSend(record.sendId)}
        className="text-ink-tertiary underline underline-offset-2 hover:text-ink"
      >
        {t("chat.outbox.discard")}
      </button>
    </span>
  );
}

export function UserLineNote({ message }: { message: Message }) {
  const outboxSendId = message.id.startsWith("optimistic-") ? message.sendId : undefined;
  const outboxNote = outboxSendId ? <OutboxStatusNote sendId={outboxSendId} /> : null;
  const intakeNote = <UserIntakeNote message={message} />;
  // A @devs message: its report's status ("Got it, we're looking", then "Fixed in 0.1.x").
  if (message.bugReport) return <>{outboxNote}{intakeNote}<BugReportNote report={message.bugReport} /></>;
  if (message.pointed?.length) {
    const label = t("chat.preview.pointedAt", { parts: message.pointed.map((part) => part.label).join(", ") });
    return (
      <>
        {outboxNote}
        {intakeNote}
        <span data-pointed-note className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-ink-tertiary" title={label}>
          <Crosshair aria-hidden="true" size={11} className="shrink-0" />
          <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
        </span>
      </>
    );
  }
  if (message.fromApp?.title) {
    const label = t("app.sentFrom", { title: message.fromApp.title });
    return (
      <>
        {outboxNote}
        {intakeNote}
        <span data-sent-from-app={message.fromApp.messageId} className="mt-1 flex items-center gap-1 text-[11px] text-ink-tertiary" title={label}>
          <AppWindow aria-hidden="true" size={11} className="shrink-0" />
          <bdi dir="auto" className="min-w-0 truncate">{label}</bdi>
        </span>
      </>
    );
  }
  if (message.via === "api") return <>{outboxNote}{intakeNote}<span data-via-bot-api className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.viaBotApi")}>{t("chat.viaBotApi")}</span></>;
  if (message.via === "call") return <>{outboxNote}{intakeNote}<span className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.viaCall")}>{t("chat.viaCall")}</span></>;
  return <>{outboxNote}{intakeNote}</>;
}
