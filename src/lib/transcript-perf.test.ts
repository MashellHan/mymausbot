import { describe, expect, it } from "vitest";
import { imageGalleryLayout } from "@/components/AttachmentPreview";
import {
  estimateRowIntrinsicBlockSize,
  shouldDeferRowPaint,
  TRANSCRIPT_EAGER_TAIL_COUNT,
  transcriptRowPerfStyle,
} from "./transcript-perf";

describe("transcript-perf content-visibility & mobile media sizing", () => {
  it("never defers the tail 8 rows, focused targets, active edits, emerging or live rows", () => {
    expect(TRANSCRIPT_EAGER_TAIL_COUNT).toBe(8);
    expect(shouldDeferRowPaint({ index: 0, total: 6, messageId: "m0" })).toBe(false);
    expect(shouldDeferRowPaint({ index: 12, total: 20, messageId: "m12" })).toBe(false);
    expect(shouldDeferRowPaint({ index: 11, total: 20, messageId: "m11" })).toBe(true);
    expect(shouldDeferRowPaint({ index: 2, total: 20, messageId: "m2", focusedId: "m2" })).toBe(false);
    expect(shouldDeferRowPaint({ index: 2, total: 20, messageId: "m2", editingId: "m2" })).toBe(false);
    expect(shouldDeferRowPaint({ index: 2, total: 20, messageId: "m2", emergingId: "m2" })).toBe(false);
    expect(shouldDeferRowPaint({ index: 2, total: 20, messageId: "m2", live: true })).toBe(false);
  });

  it("estimates intrinsic block sizes for plain text, code fences, tables, and image attachments", () => {
    expect(estimateRowIntrinsicBlockSize({ kind: "text", text: "Hi" })).toBe(88);
    expect(estimateRowIntrinsicBlockSize({ kind: "text", text: "a".repeat(600) })).toBe(180);
    expect(estimateRowIntrinsicBlockSize({ kind: "text", text: "```ts\nconst x = 1;\n```" })).toBe(240);
    expect(estimateRowIntrinsicBlockSize({ kind: "text", text: "| A | B |\n|---|---|\n| 1 | 2 |" })).toBe(260);
    expect(estimateRowIntrinsicBlockSize({ kind: "text", text: "Look", attachments: [{ path: "/a.png", kind: "image", mime: "image/png" }] })).toBe(220);
    expect(transcriptRowPerfStyle({ kind: "text", text: "Hi" }, false)).toBeUndefined();
    expect(transcriptRowPerfStyle({ kind: "text", text: "Hi" }, true)).toEqual({ containIntrinsicSize: "auto 88px" });
  });

  it("uses responsive full-width mobile gallery layouts for 1, 2, and 3+ thumbnails", () => {
    expect(imageGalleryLayout(1)).toContain("grid-cols-1");
    expect(imageGalleryLayout(1)).toContain("max-md:w-full");
    expect(imageGalleryLayout(2)).toContain("grid-cols-2");
    expect(imageGalleryLayout(4)).toContain("sm:grid-cols-3");
  });
});
