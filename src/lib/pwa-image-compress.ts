import { AttachError, IMAGE_MAX_BYTES, canonicalImageNameForMime, isImageFile } from "./composer-attachments.ts";

export const PWA_IMAGE_MAX_EDGE = 1280;
export const PWA_IMAGE_QUALITY = 0.82;

export interface CompressedOutboxImage {
  blob: Blob;
  mime: string;
  name: string;
  size: number;
}

export interface CompressImageCanvas {
  width: number;
  height: number;
  draw: (source: unknown, width: number, height: number) => void;
  toBlob: (mime: string, quality: number) => Promise<Blob | null>;
}

export interface CompressImageOptions {
  maxEdge?: number;
  quality?: number;
  decode?: (blob: Blob) => Promise<{ width: number; height: number; source: unknown; close?: () => void }>;
  createCanvas?: (width: number, height: number) => CompressImageCanvas | null;
}

function fitWithinMaxEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: maxEdge, height: maxEdge };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function defaultDecode(
  blob: Blob,
): Promise<{ width: number; height: number; source: unknown; close?: () => void } | null> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close?.(),
    };
  }
  if (typeof Image === "function" && typeof URL?.createObjectURL === "function") {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("image decode failed"));
        el.src = url;
      });
      return {
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        source: img,
      };
    } finally {
      URL.revokeObjectURL?.(url);
    }
  }
  return null;
}

function defaultCreateCanvas(width: number, height: number): CompressImageCanvas | null {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return {
      width,
      height,
      draw: (source, w, h) => ctx.drawImage(source as CanvasImageSource, 0, 0, w, h),
      toBlob: (mime, quality) => canvas.convertToBlob({ type: mime, quality }),
    };
  }
  if (typeof document !== "undefined" && typeof document.createElement === "function") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    return {
      width,
      height,
      draw: (source, w, h) => ctx.drawImage(source as CanvasImageSource, 0, 0, w, h),
      toBlob: (mime, quality) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality)),
    };
  }
  return null;
}

async function encodeCandidate(canvas: CompressImageCanvas, quality: number, sourceMime: string): Promise<Blob | null> {
  const webp = await canvas.toBlob("image/webp", quality).catch(() => null);
  if (webp && webp.type === "image/webp" && webp.size > 0) return webp;
  if (sourceMime === "image/png") {
    const png = await canvas.toBlob("image/png", quality).catch(() => null);
    if (png && png.type === "image/png" && png.size > 0) return png;
  }
  const jpeg = await canvas.toBlob("image/jpeg", quality).catch(() => null);
  if (jpeg && jpeg.type === "image/jpeg" && jpeg.size > 0) return jpeg;
  return webp && webp.size > 0 ? webp : null;
}

export async function compressImageForOutbox(
  file: Blob & { name?: string },
  options: CompressImageOptions = {},
): Promise<CompressedOutboxImage> {
  const originalName = (typeof file.name === "string" && file.name.trim()) ? file.name : "image";
  const originalMime = (file.type || "").split(";", 1)[0]!.trim().toLowerCase();
  if (!isImageFile({ type: originalMime, size: file.size })) {
    throw new Error(`Unsupported image type: ${originalMime || "unknown"}`);
  }

  // Keep GIFs untouched to preserve animations; enforce the server's 10 MiB cap.
  if (originalMime === "image/gif") {
    if (file.size > IMAGE_MAX_BYTES) throw new AttachError(originalName, IMAGE_MAX_BYTES);
    return {
      blob: file,
      mime: originalMime,
      name: canonicalImageNameForMime(originalName, originalMime),
      size: file.size,
    };
  }

  const maxEdge = options.maxEdge ?? PWA_IMAGE_MAX_EDGE;
  const quality = options.quality ?? PWA_IMAGE_QUALITY;

  let decoded: { width: number; height: number; source: unknown; close?: () => void } | null = null;
  try {
    decoded = options.decode ? await options.decode(file) : await defaultDecode(file);
  } catch {
    decoded = null;
  }

  if (!decoded) {
    if (file.size > IMAGE_MAX_BYTES) throw new AttachError(originalName, IMAGE_MAX_BYTES);
    return {
      blob: file,
      mime: originalMime,
      name: canonicalImageNameForMime(originalName, originalMime),
      size: file.size,
    };
  }

  try {
    const needsResize = Math.max(decoded.width, decoded.height) > maxEdge;
    const target = fitWithinMaxEdge(decoded.width, decoded.height, maxEdge);
    const canvas = options.createCanvas
      ? options.createCanvas(target.width, target.height)
      : defaultCreateCanvas(target.width, target.height);

    if (!canvas) {
      if (file.size > IMAGE_MAX_BYTES) throw new AttachError(originalName, IMAGE_MAX_BYTES);
      return {
        blob: file,
        mime: originalMime,
        name: canonicalImageNameForMime(originalName, originalMime),
        size: file.size,
      };
    }

    canvas.draw(decoded.source, target.width, target.height);
    const encoded = await encodeCandidate(canvas, quality, originalMime);

    // Keep the original when dimensions already fit and compression did not reduce size.
    if (!needsResize && file.size <= IMAGE_MAX_BYTES && (!encoded || encoded.size >= file.size)) {
      return {
        blob: file,
        mime: originalMime,
        name: canonicalImageNameForMime(originalName, originalMime),
        size: file.size,
      };
    }

    const chosen = encoded && (needsResize || encoded.size < file.size) ? encoded : file;
    const chosenMime = (chosen.type || originalMime).split(";", 1)[0]!.trim().toLowerCase() || originalMime;
    if (chosen.size > IMAGE_MAX_BYTES) {
      throw new AttachError(originalName, IMAGE_MAX_BYTES);
    }

    return {
      blob: chosen,
      mime: chosenMime,
      name: canonicalImageNameForMime(originalName, chosenMime),
      size: chosen.size,
    };
  } finally {
    decoded.close?.();
  }
}
