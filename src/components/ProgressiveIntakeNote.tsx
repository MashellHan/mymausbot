import { use } from "react";

import { PeerMessagesContext } from "./PeerExchange";
import { ChatBusyContext } from "./MessageActions";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";
import {
  deriveMessageIntake,
  hasConcurrentWorkerReplyFor,
  intakeStatusView,
  type ConcurrentWorkerMeta,
} from "@/lib/progressive-intake-ui";

/** Subtle inline delivery/intake state shown under a user's message while or after the bot acts on it. */
export function UserIntakeNote({ message }: { message: Message }) {
  const transcript = use(PeerMessagesContext);
  const busy = use(ChatBusyContext);
  const intake = deriveMessageIntake(message, transcript, { busy });
  if (!intake) return null;
  const view = intakeStatusView(intake, {
    hasConcurrentWorkerReply: hasConcurrentWorkerReplyFor(message.id, transcript),
  });
  return (
    <span
      dir="auto"
      data-intake-state={view.state}
      data-intake-mode={view.mode}
      className="mt-1 inline-block text-[11px] text-ink-tertiary"
    >
      {t(view.labelKey)}
    </span>
  );
}

/** Calm caption above a concurrent read-only reply so parallel answers stay distinct from the main turn. */
export function ConcurrentWorkerNote({ worker }: { worker: ConcurrentWorkerMeta }) {
  return (
    <div
      dir="auto"
      data-concurrent-worker={worker.workerId}
      className="mb-1 px-1 text-[11px] font-medium text-ink-tertiary"
      title={t("chat.concurrent.workerHint")}
    >
      {t("chat.concurrent.worker")}
    </div>
  );
}
