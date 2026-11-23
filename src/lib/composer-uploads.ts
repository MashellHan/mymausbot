import { appendDraftAttachments, replaceDraftAttachment } from "./drafts";
import {
  AttachError,
  handoffAttachmentImagePreview,
  imageAttachmentFromFile,
  optimisticImageAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
  type ImageAttachment,
} from "./composer-attachments";
import { compressImageForOutbox } from "./pwa-image-compress";
import { isMacOffline, isRemotePwaMode } from "./pwa-transport";
import { randomUuid } from "./random-uuid";

function shouldFallbackToOfflineQueue(error: unknown): boolean {
  if (error instanceof AttachError) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (isMacOffline()) return true;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  return error instanceof Error;
}

async function queueCompressedDraftImage(
  draftId: string,
  file: File,
  optimistic: ImageAttachment,
): Promise<null> {
  const compressed = await compressImageForOutbox(file);
  const previewUrl =
    typeof URL?.createObjectURL === "function"
      ? URL.createObjectURL(compressed.blob)
      : optimistic.previewUrl;
  if (previewUrl && optimistic.previewUrl && previewUrl !== optimistic.previewUrl) {
    releaseAttachmentImagePreview(optimistic);
  }
  const queued: ImageAttachment = {
    kind: "image",
    id: optimistic.id,
    path: "",
    name: compressed.name,
    size: compressed.size,
    mime: compressed.mime,
    uploadId: randomUuid(),
    compressedBlob: compressed.blob,
    ...(previewUrl ? { previewUrl } : {}),
  };
  if (!replaceDraftAttachment(draftId, optimistic.id, queued)) {
    releaseAttachmentImagePreview(queued);
  }
  return null;
}

export async function uploadDraftImage(
  draftId: string,
  file: File,
  options?: { offline?: boolean },
): Promise<Attachment | null> {
  const remotePwa = isRemotePwaMode();
  const optimistic = optimisticImageAttachment(file, { allowOversize: remotePwa });
  if (!optimistic) return null;
  appendDraftAttachments(draftId, [optimistic]);
  const offline =
    remotePwa &&
    (Boolean(options?.offline) || isMacOffline() || (typeof navigator !== "undefined" && navigator.onLine === false));
  try {
    if (offline) {
      return await queueCompressedDraftImage(draftId, file, optimistic);
    }
    try {
      const completed = await imageAttachmentFromFile(file, optimistic);
      if (!completed) {
        replaceDraftAttachment(draftId, optimistic.id, null);
        releaseAttachmentImagePreview(optimistic);
        return null;
      }
      handoffAttachmentImagePreview(completed.path, completed.previewUrl);
      if (!replaceDraftAttachment(draftId, optimistic.id, completed)) {
        releaseAttachmentImagePreview(completed);
      }
      return null;
    } catch (error) {
      if (remotePwa && shouldFallbackToOfflineQueue(error)) {
        return await queueCompressedDraftImage(draftId, file, optimistic);
      }
      throw error;
    }
  } catch (error) {
    replaceDraftAttachment(draftId, optimistic.id, null);
    releaseAttachmentImagePreview(optimistic);
    throw error;
  }
}
