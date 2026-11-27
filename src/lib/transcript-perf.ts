import type { CSSProperties } from "react";
import type { Message } from "@/state/store";

export const TRANSCRIPT_EAGER_TAIL_COUNT = 8;

export interface RowPaintDeferInput {
  index: number;
  total: number;
  messageId: string;
  focusedId?: string | null;
  editingId?: string | null;
  emergingId?: string | null;
  live?: boolean;
}

/**
 * Only older offscreen history rows above the live tail receive `content-visibility: auto`,
 * keeping bottom scroll-pinning, streaming replies, focused jumps, and active editors completely jitter-free.
 */
export function shouldDeferRowPaint(input: RowPaintDeferInput): boolean {
  if (input.total <= TRANSCRIPT_EAGER_TAIL_COUNT) return false;
  if (input.index >= input.total - TRANSCRIPT_EAGER_TAIL_COUNT) return false;
  if (input.live) return false;
  if (input.focusedId && input.focusedId === input.messageId) return false;
  if (input.editingId && input.editingId === input.messageId) return false;
  if (input.emergingId && input.emergingId === input.messageId) return false;
  return true;
}

export function estimateRowIntrinsicBlockSize(message: Pick<Message, "kind" | "text" | "attachments">): number {
  if (message.attachments && message.attachments.length > 0) return 220;
  const text = message.text ?? "";
  if (text.includes("```")) return 240;
  if (/^\s*\|.+\|\s*$/m.test(text)) return 260;
  if (text.length > 500) return 180;
  return 88;
}

export function transcriptRowPerfStyle(
  message: Pick<Message, "kind" | "text" | "attachments">,
  defer: boolean,
): CSSProperties | undefined {
  if (!defer) return undefined;
  return {
    containIntrinsicSize: `auto ${estimateRowIntrinsicBlockSize(message)}px`,
  };
}
