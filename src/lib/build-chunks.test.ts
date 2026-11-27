import { describe, expect, it } from "vitest";
import { resolveManualChunk } from "./build-chunks";

describe("resolveManualChunk", () => {
  it("groups stable React, Lucide icons, Markdown pipeline, and Shiki core into dedicated vendor chunks", () => {
    expect(resolveManualChunk("/repo/node_modules/react/index.js")).toBe("vendor-react");
    expect(resolveManualChunk("/repo/node_modules/react-dom/client.js")).toBe("vendor-react");
    expect(resolveManualChunk("/repo/node_modules/scheduler/cjs/scheduler.production.js")).toBe("vendor-react");
    expect(resolveManualChunk("/repo/node_modules/lucide-react/dist/esm/icons/menu.js")).toBe("vendor-icons");
    expect(resolveManualChunk("/repo/node_modules/react-markdown/lib/index.js")).toBe("vendor-markdown");
    expect(resolveManualChunk("/repo/node_modules/remark-gfm/index.js")).toBe("vendor-markdown");
    expect(resolveManualChunk("/repo/node_modules/micromark-core-commonmark/lib/initialize.js")).toBe("vendor-markdown");
    expect(resolveManualChunk("/repo/node_modules/@shikijs/core/dist/index.mjs")).toBe("vendor-shiki-core");
  });

  it("handles Windows paths identically to POSIX paths", () => {
    expect(resolveManualChunk("C:\\repo\\node_modules\\react\\index.js")).toBe("vendor-react");
    expect(resolveManualChunk("C:\\repo\\node_modules\\lucide-react\\index.js")).toBe("vendor-icons");
  });

  it("leaves app code and heavy async chunks (shiki langs, mermaid, elk, livekit, katex) unmerged", () => {
    expect(resolveManualChunk("/repo/src/components/ComputerPanel.tsx")).toBeUndefined();
    expect(resolveManualChunk("/repo/node_modules/shiki/langs/typescript.mjs")).toBeUndefined();
    expect(resolveManualChunk("/repo/node_modules/@shikijs/langs/dist/python.mjs")).toBeUndefined();
    expect(resolveManualChunk("/repo/node_modules/mermaid/dist/mermaid.core.mjs")).toBeUndefined();
    expect(resolveManualChunk("/repo/node_modules/elkjs/lib/elk.bundled.js")).toBeUndefined();
    expect(resolveManualChunk("/repo/node_modules/livekit-client/dist/livekit-client.esm.mjs")).toBeUndefined();
    expect(resolveManualChunk("/repo/node_modules/katex/dist/katex.mjs")).toBeUndefined();
  });
});
