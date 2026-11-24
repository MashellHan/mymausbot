import { composeMessage, type Attachment } from "./composer-attachments";
import { isRemotePwaMode } from "./pwa-transport";
import type { OutboxImageAttachment } from "@/state/pwa-outbox-types";

export function isComposerLocked(input: {
  setupLocked: boolean;
  awaitingThreadSnapshot?: boolean;
  cachedHydrated?: boolean;
}): boolean {
  if (input.setupLocked) return true;
  if (!input.awaitingThreadSnapshot) return false;
  return !(isRemotePwaMode() || Boolean(input.cachedHydrated));
}

export function isPwaOfflineDraftBlocked(input: {
  connected: boolean;
  cachedHydrated?: boolean;
  hasAttachments?: boolean;
  attachments?: readonly Attachment[];
}): boolean {
  if (!(isRemotePwaMode() || Boolean(input.cachedHydrated))) return false;
  const navigatorOffline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (!(!input.connected || navigatorOffline)) return false;
  if (input.attachments) {
    return input.attachments.some(
      (attachment) =>
        attachment.kind === "file" ||
        (attachment.kind === "image" && !attachment.path && !(attachment.compressedBlob && attachment.uploadId)),
    );
  }
  return Boolean(input.hasAttachments);
}

export function botSupportsImagesInComposer(
  state: {
    connected: boolean;
    cachedHydrated?: boolean;
    instances: ReadonlyArray<{ instanceId: string; capabilities?: { images?: boolean } }>;
  },
  candidate?: { modelSelection: { instanceId: string } },
): boolean {
  if (!candidate) return false;
  const inst = state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId);
  if (inst) return Boolean(inst.capabilities?.images);
  if (isRemotePwaMode()) return true;
  return Boolean(state.cachedHydrated) && !state.connected;
}

export function prepareComposerSendPayload(
  text: string,
  attachments: readonly Attachment[],
): { rawText: string; outboxAttachments: OutboxImageAttachment[] } | null {
  const outboxAttachments: OutboxImageAttachment[] = [];
  const readyAttachments: Attachment[] = [];

  for (const attachment of attachments) {
    if (attachment.kind === "image" && !attachment.path && attachment.compressedBlob && attachment.uploadId) {
      outboxAttachments.push({
        uploadId: attachment.uploadId,
        name: attachment.name,
        mime: attachment.mime,
        compressedBlob: attachment.compressedBlob,
      });
    } else {
      readyAttachments.push(attachment);
    }
  }

  const rawText = composeMessage(text, readyAttachments);
  if (!rawText && outboxAttachments.length === 0) return null;
  return { rawText, outboxAttachments };
}
