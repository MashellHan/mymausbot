import {
  composeMessage,
  handoffAttachmentImagePreview,
  type ImageAttachment,
  type TranscriptAttachments,
  type TranscriptImageAttachment,
} from "@/lib/composer-attachments";
import {
  OUTBOX_ATTACHMENT_UPLOAD_TIMEOUT_MS,
  type OutboxImageAttachment,
  type OutboxRecord,
} from "./pwa-outbox-types";

const previewUrlsByUploadId = new Map<string, { blob: Blob; url: string }>();

function revokeUrl(url: string | undefined): void {
  if (!url?.startsWith("blob:") || typeof URL?.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

export function getOutboxAttachmentPreviewUrl(attachment: OutboxImageAttachment): string | undefined {
  if (typeof URL?.createObjectURL !== "function") return undefined;
  const cached = previewUrlsByUploadId.get(attachment.uploadId);
  if (cached && cached.blob === attachment.compressedBlob) {
    if (attachment.uploadedPath) handoffAttachmentImagePreview(attachment.uploadedPath, cached.url);
    return cached.url;
  }
  if (cached) revokeUrl(cached.url);
  const url = URL.createObjectURL(attachment.compressedBlob);
  previewUrlsByUploadId.set(attachment.uploadId, { blob: attachment.compressedBlob, url });
  if (attachment.uploadedPath) handoffAttachmentImagePreview(attachment.uploadedPath, url);
  return url;
}

export function releaseOutboxAttachmentPreviews(record: OutboxRecord | undefined): void {
  if (!record?.attachments?.length) return;
  for (const att of record.attachments) {
    const cached = previewUrlsByUploadId.get(att.uploadId);
    if (!cached) continue;
    previewUrlsByUploadId.delete(att.uploadId);
    if (att.uploadedPath) {
      handoffAttachmentImagePreview(att.uploadedPath, cached.url);
    } else {
      revokeUrl(cached.url);
    }
  }
}

export function clearOutboxPreviewCacheForTests(): void {
  for (const entry of previewUrlsByUploadId.values()) revokeUrl(entry.url);
  previewUrlsByUploadId.clear();
}

export async function uploadPendingOutboxAttachments(params: {
  record: OutboxRecord;
  request: <T = any>(path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
  now: () => number;
  persistRecord: (next: OutboxRecord) => Promise<void>;
}): Promise<OutboxRecord> {
  let current = params.record;
  let currentAttachments = current.attachments ?? [];
  if (!currentAttachments.length) return current;
  if (current.composedText && currentAttachments.every((att) => Boolean(att.uploadedPath))) {
    return current;
  }

  for (let i = 0; i < currentAttachments.length; i += 1) {
    const att = currentAttachments[i]!;
    if (att.uploadedPath) continue;
    const body =
      typeof att.compressedBlob.arrayBuffer === "function"
        ? new Uint8Array(await att.compressedBlob.arrayBuffer())
        : att.compressedBlob;
    const saved = await params.request<{ path?: string }>(
      `/api/attachments?uploadId=${encodeURIComponent(att.uploadId)}`,
      {
        method: "POST",
        timeoutMs: OUTBOX_ATTACHMENT_UPLOAD_TIMEOUT_MS,
        headers: { "content-type": att.mime || att.compressedBlob.type || "image/webp" },
        body,
      },
    );
    if (!saved?.path || typeof saved.path !== "string") {
      throw new Error("upload returned an invalid response");
    }
    currentAttachments = currentAttachments.map((item, idx) =>
      idx === i ? { ...item, uploadedPath: saved.path } : item,
    );
    current = {
      ...current,
      attachments: currentAttachments,
      updatedAt: params.now(),
    };
    const cached = previewUrlsByUploadId.get(att.uploadId);
    if (cached) handoffAttachmentImagePreview(saved.path, cached.url);
    await params.persistRecord(current);
  }

  if (!current.composedText) {
    const raw = current.rawText ?? current.text;
    const readyImages: ImageAttachment[] = currentAttachments.map((att) => ({
      kind: "image",
      id: att.uploadId,
      path: att.uploadedPath!,
      name: att.name,
      size: att.compressedBlob.size,
      mime: att.mime,
    }));
    const frozenComposed = composeMessage(raw, readyImages);
    current = {
      ...current,
      composedText: frozenComposed,
      text: frozenComposed,
      updatedAt: params.now(),
    };
    await params.persistRecord(current);
  }

  return current;
}

export function mergeOutboxUserAttachments(
  base: TranscriptAttachments,
  record: OutboxRecord | undefined,
): TranscriptAttachments {
  if (!record?.attachments?.length) return base;
  const previewByPath = new Map<string, string>();
  const extraImages: TranscriptImageAttachment[] = [];
  const existingPaths = new Set(base.images.map((image) => image.path));

  for (const att of record.attachments) {
    const previewUrl = getOutboxAttachmentPreviewUrl(att);
    if (att.uploadedPath && existingPaths.has(att.uploadedPath)) {
      if (previewUrl) previewByPath.set(att.uploadedPath, previewUrl);
      continue;
    }
    const path = att.uploadedPath ?? previewUrl ?? att.uploadId;
    if (existingPaths.has(path)) continue;
    existingPaths.add(path);
    extraImages.push({
      path,
      name: att.name,
      private: true,
      ...(previewUrl ? { previewUrl } : {}),
    });
  }

  const enrichedBase = base.images.map((image) => {
    const previewUrl = previewByPath.get(image.path);
    return previewUrl && !image.previewUrl ? { ...image, previewUrl } : image;
  });

  return {
    ...base,
    images: [...enrichedBase, ...extraImages],
  };
}
