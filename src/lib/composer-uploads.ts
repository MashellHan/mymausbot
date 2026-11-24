import { appendDraftAttachments, replaceDraftAttachment } from "./drafts";
import {
  AttachError,
  IMAGE_MAX_BYTES,
  handoffAttachmentImagePreview,
  imageAttachmentFromFile,
  isHeicImageFile,
  optimisticImageAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
  type ImageAttachment,
} from "./composer-attachments";
import { compressImageForOutbox, type CompressedOutboxImage } from "./pwa-image-compress";
import { isMacOffline, isRemotePwaMode } from "./pwa-transport";
import { randomUuid } from "./random-uuid";

export const PWA_ONLINE_COMPRESS_THRESHOLD_BYTES = 2 * 1024 * 1024;

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

function toUploadFile(original: File, compressed: CompressedOutboxImage): File {
  if (compressed.blob === original) return original;
  if (
    compressed.blob instanceof File &&
    compressed.blob.name === compressed.name &&
    compressed.blob.type === compressed.mime
  ) {
    return compressed.blob;
  }
  return new File([compressed.blob], compressed.name, { type: compressed.mime });
}

function previewUrlForBlob(blob: Blob, fallback?: string): string | undefined {
  if (typeof URL?.createObjectURL !== "function") return fallback;
  return URL.createObjectURL(blob);
}

async function queueCompressedDraftImage(
  draftId: string,
  file: File,
  optimistic: ImageAttachment,
  precompressed?: CompressedOutboxImage,
): Promise<null> {
  const compressed = precompressed ?? (await compressImageForOutbox(file));
  const previewUrl =
    precompressed && compressed.blob !== file && optimistic.previewUrl
      ? optimistic.previewUrl
      : compressed.blob === file && optimistic.previewUrl
        ? optimistic.previewUrl
        : previewUrlForBlob(compressed.blob, optimistic.previewUrl);
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
  let activeOptimistic = optimistic;
  let compressed: CompressedOutboxImage | undefined;
  try {
    if (offline) {
      return await queueCompressedDraftImage(draftId, file, activeOptimistic);
    }
    const needsCompress =
      isHeicImageFile(file) ||
      (remotePwa && (file.size > IMAGE_MAX_BYTES || file.size > PWA_ONLINE_COMPRESS_THRESHOLD_BYTES));
    let uploadFile = file;
    if (needsCompress) {
      compressed = await compressImageForOutbox(file);
      uploadFile = toUploadFile(file, compressed);
      if (compressed.blob !== file) {
        const nextPreview = previewUrlForBlob(compressed.blob, activeOptimistic.previewUrl);
        if (nextPreview && activeOptimistic.previewUrl && nextPreview !== activeOptimistic.previewUrl) {
          releaseAttachmentImagePreview(activeOptimistic);
        }
        const updatedOptimistic: ImageAttachment = {
          ...activeOptimistic,
          name: compressed.name,
          size: compressed.size,
          mime: compressed.mime,
          ...(nextPreview ? { previewUrl: nextPreview } : {}),
        };
        if (replaceDraftAttachment(draftId, activeOptimistic.id, updatedOptimistic)) {
          activeOptimistic = updatedOptimistic;
        } else {
          if (nextPreview && nextPreview !== activeOptimistic.previewUrl) {
            releaseAttachmentImagePreview(updatedOptimistic);
          }
          return null;
        }
      }
    }
    try {
      const completed = await imageAttachmentFromFile(uploadFile, activeOptimistic);
      if (!completed) {
        replaceDraftAttachment(draftId, activeOptimistic.id, null);
        releaseAttachmentImagePreview(activeOptimistic);
        return null;
      }
      handoffAttachmentImagePreview(completed.path, completed.previewUrl);
      if (!replaceDraftAttachment(draftId, activeOptimistic.id, completed)) {
        releaseAttachmentImagePreview(completed);
      }
      return null;
    } catch (error) {
      if (remotePwa && shouldFallbackToOfflineQueue(error)) {
        return await queueCompressedDraftImage(draftId, file, activeOptimistic, compressed);
      }
      throw error;
    }
  } catch (error) {
    replaceDraftAttachment(draftId, activeOptimistic.id, null);
    releaseAttachmentImagePreview(activeOptimistic);
    throw error;
  }
}
